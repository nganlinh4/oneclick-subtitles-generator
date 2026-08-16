//! The export itself: request in, finished `MP4` out.
//!
//! The loop is deliberately small, because everything it drives already exists. It probes the
//! source, validates the request against what the file really is, converts it once, then walks the
//! timeline: decode the source frame this output frame shows, composite the underlay and the
//! subtitle layer, hand the pixels to the encoder, and pump the audio mix up to the next frame
//! boundary.
//!
//! Two properties are structural rather than incidental:
//!
//! * **The length comes from the timeline.** Every frame index the loop visits comes from
//!   [`ExportPlan::frame_count`], so a decode that runs short is a truncation the caller is told
//!   about rather than a quietly shorter file.
//! * **Nothing half-written survives.** The encoder refuses to open over an existing file and
//!   removes its own partial output when it is cancelled or dropped without finalizing, so every
//!   error path — including cancellation — leaves no container that could be mistaken for a
//!   finished export.

use std::fmt;
use std::path::Path;

use osg_audio::MixStats;
use osg_decode::{DecodeError, DecoderConfig, SourceBound, SourceInfo, open_decoder};
use osg_encode::{FrameBuffer, PixelLayout, VideoEncoder, open_encoder};
use osg_render::RenderRequest;
use osg_scene::scene::ResolvedFace;
use osg_scene::{ExactTime, FrameTimeline};

use crate::cancel::ExportCancel;
use crate::convert::{ExportPlan, check_canvas_background};
use crate::error::ExportError;
use crate::frames::FrameRenderer;
use crate::media::AudioRuntime;
use crate::progress::{ProgressReporter, ProgressSink};
use crate::stage::StagedText;

/// 100-nanosecond units in one microsecond.
const HUNDRED_NANOS_PER_MICRO: i64 = 10;

/// Everything one export needs.
///
/// The three paths are trusted, resolved locations that never cross the `WebView` boundary. They
/// are consumed by the pipeline and never appear in an error, a progress report or the `Debug`
/// rendering of this type.
pub struct ExportJob<'paths> {
    /// The request the `WebView` sent, before validation against the source.
    pub request: RenderRequest,
    /// The source video, which is also the original-audio source.
    pub source: &'paths Path,
    /// The narration track, when the project has one.
    pub narration: Option<&'paths Path>,
    /// Where the finished `MP4` is written. Must not already exist.
    pub output: &'paths Path,
    /// The face, atlas and runs the `WebView` staged.
    pub text: StagedText,
    /// The signal that stops this export.
    pub cancel: ExportCancel,
}

impl fmt::Debug for ExportJob<'_> {
    /// Redacted on purpose: an export job holds three filesystem paths, and a `{:?}` of one must be
    /// as safe to log as the crate's errors are.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExportJob")
            .field("lyrics", &self.request.lyrics.len())
            .field("has_narration", &self.narration.is_some())
            .field("face", self.text.face())
            .field("cancelled", &self.cancel.is_cancelled())
            .finish_non_exhaustive()
    }
}

/// What a finished export produced.
///
/// Carries no path: the caller supplied the location and does not need it echoed back, so a summary
/// is safe to log.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExportSummary {
    frames: u32,
    width: u32,
    height: u32,
    audio_samples: u64,
    clipped_samples: u64,
    audio_peak: f32,
    file_bytes: u64,
    duration_100ns: i64,
}

impl ExportSummary {
    /// How many video frames were written. Always the timeline's frame count.
    #[must_use]
    pub const fn frames(self) -> u32 {
        self.frames
    }

    /// The composition width in pixels.
    #[must_use]
    pub const fn width(self) -> u32 {
        self.width
    }

    /// The composition height in pixels.
    #[must_use]
    pub const fn height(self) -> u32 {
        self.height
    }

    /// How many interleaved audio sample frames were written. Zero for a silent export.
    #[must_use]
    pub const fn audio_samples(self) -> u64 {
        self.audio_samples
    }

    /// How many mixed samples were limited to full scale.
    #[must_use]
    pub const fn clipped_samples(self) -> u64 {
        self.clipped_samples
    }

    /// The largest audio magnitude seen before limiting. Above 1.0 means the mix clipped.
    #[must_use]
    pub const fn audio_peak(self) -> f32 {
        self.audio_peak
    }

    /// The size of the finished file in bytes.
    #[must_use]
    pub const fn file_bytes(self) -> u64 {
        self.file_bytes
    }

    /// The exact end of the video timeline, in 100ns units.
    #[must_use]
    pub const fn duration_100ns(self) -> i64 {
        self.duration_100ns
    }
}

/// Reads what a source really is, before anything is planned against it.
///
/// The decoder is opened against a one-frame placeholder grid purely to read the file's own
/// dimensions, rate and duration: the real grid cannot be built until the request has been
/// validated against exactly those numbers.
///
/// # Errors
/// Returns [`ExportError::SourceUnreadable`] when the file cannot be opened or is outside the
/// decoder's bounds.
pub fn probe_source(source: &Path) -> Result<SourceInfo, ExportError> {
    let probe = FrameTimeline::new(30, 1, 1, ExactTime::ZERO)?;
    let decoder = open_decoder(source, DecoderConfig::new(probe))?;
    Ok(decoder.source())
}

/// Runs one export to completion.
///
/// # Errors
/// Returns [`ExportError::CanvasBackgroundNotOpaque`] before anything is opened,
/// [`ExportError::Cancelled`] when the job's signal is raised, and otherwise the first source,
/// request, font, atlas, scene, composition, audio or output refusal. Every one of those leaves no
/// output file behind.
pub fn run_export(
    job: ExportJob<'_>,
    progress: &mut dyn ProgressSink,
) -> Result<ExportSummary, ExportError> {
    let ExportJob {
        request,
        source,
        narration,
        output,
        text,
        cancel,
    } = job;

    // Before anything is opened: a backfill an exported video cannot carry is refused here rather
    // than after a source probe, so a request that can never succeed costs no file handle.
    check_canvas_background(&request.crop)?;

    let plan = plan_against_source(request, source, text.face())?;
    let subtitles = plan.compose(text)?;
    let mut renderer = FrameRenderer::open(&plan, subtitles, source)?;
    let mut audio = AudioRuntime::open(&plan, source, narration)?;

    let mut encoder = open_encoder(output, plan.encoder_config(audio.is_some()))?;
    let frame_count = plan.frame_count();
    let mut reporter = ProgressReporter::new(progress, frame_count);

    for index in 0..frame_count {
        if cancel.is_cancelled() {
            return abandon(&mut renderer, encoder.as_mut());
        }
        let frame = renderer.frame(index)?;
        if cancel.is_cancelled() {
            return abandon(&mut renderer, encoder.as_mut());
        }
        let buffer = FrameBuffer::new(
            frame.pixels(),
            plan.width(),
            plan.height(),
            PixelLayout::Rgba8,
        )?;
        encoder.write_frame(index, &buffer)?;
        if let Some(audio) = audio.as_mut() {
            audio.pump(encoder.as_mut(), audio_boundary(&plan, index + 1)?)?;
        }
        reporter.frames(index + 1);
    }

    if let Some(audio) = audio.as_mut() {
        audio.pump(encoder.as_mut(), u64::MAX)?;
    }
    reporter.finalizing();
    renderer.close();

    let outcome = encoder.finalize()?;
    let stats = audio.as_ref().map(AudioRuntime::stats);
    Ok(ExportSummary {
        frames: outcome.frames_written(),
        width: plan.width(),
        height: plan.height(),
        audio_samples: audio.as_ref().map_or(0, AudioRuntime::written),
        clipped_samples: stats.map_or(0, MixStats::clipped_samples),
        audio_peak: stats.map_or(0.0, MixStats::peak),
        file_bytes: outcome.file_bytes(),
        duration_100ns: outcome.duration_100ns(),
    })
}

/// Validates a request against what the source file really is, then converts it.
fn plan_against_source(
    request: RenderRequest,
    source: &Path,
    face: &ResolvedFace,
) -> Result<ExportPlan, ExportError> {
    let info = probe_source(source)?;
    let width = u32::try_from(info.width()).map_err(|_| out_of_bounds(SourceBound::Width))?;
    let height = u32::try_from(info.height()).map_err(|_| out_of_bounds(SourceBound::Height))?;
    let duration_us = u64::try_from(info.duration_100ns() / HUNDRED_NANOS_PER_MICRO)
        .map_err(|_| out_of_bounds(SourceBound::Duration))?;
    let plan = request.validate(width, height, duration_us)?;
    ExportPlan::convert(&plan, face)
}

const fn out_of_bounds(bound: SourceBound) -> ExportError {
    ExportError::SourceUnreadable {
        reason: DecodeError::SourceOutOfBounds { bound },
    }
}

/// The first audio sample frame that belongs to output frame `index`, or the end of the mix.
fn audio_boundary(plan: &ExportPlan, index: u32) -> Result<u64, ExportError> {
    if index >= plan.frame_count() {
        return Ok(u64::MAX);
    }
    plan.audio_frame_at(index)
}

/// Stops the export, releases the source and removes the partial container.
fn abandon(
    renderer: &mut FrameRenderer,
    encoder: &mut dyn VideoEncoder,
) -> Result<ExportSummary, ExportError> {
    renderer.close();
    encoder.cancel()?;
    Err(ExportError::Cancelled)
}
