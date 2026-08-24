//! The Media Foundation backend: an `IMFSourceReader` driven to frame-exact answers.
//!
//! The reader itself only knows how to go to a keyframe and hand out whatever comes next. Turning
//! that into "the source frame output frame 417 shows" is this file's whole job, and it is done the
//! only way that is actually correct: resolve the request to an exact instant, get to a decode
//! position at or before it, then **walk forward until the sample that covers the instant is the
//! one in hand**. Nothing here trusts the seek to have landed anywhere in particular, because it
//! does not.
//!
//! The codecs are the operating system's own, licensed by Microsoft to the person running the
//! machine. Nothing is redistributed, so there is no notice to write and no runtime package to
//! verify — the same reason the encoder takes this path.

use core::fmt;
use std::path::Path;

use osg_scene::ExactTime;
use windows::Win32::Media::MediaFoundation::{
    IMFSample, IMFSourceReader, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR, MFCreateSourceReaderFromURL,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::core::{GUID, PCWSTR};

use crate::cancel::CancelToken;
use crate::colorimetry::SourceColorimetry;
use crate::decoder::{DecodeStats, DecoderConfig, VideoDecoder};
use crate::error::{DecodeError, MfStage, SourceRejection};
use crate::frame::DecodedFrame;
use crate::input::check_source_path;
use crate::limits::HUNDRED_NANOS_PER_SECOND;
use crate::mf::platform::{ensure_media_foundation, platform_error, wide_path};
use crate::mf::sample::SourceSample;
use crate::mf::{format, media_type};
use crate::planes::FrameGeometry;
use crate::presentation::SourcePresentation;
use crate::sampling::{OutputSampler, SourceGrid, exact_time_to_100ns};
use crate::source::SourceInfo;

/// How many samples the reader may hand back without one before the source is called broken.
///
/// A stream tick or a gap legitimately produces no sample; an endless run of them does not, and a
/// file that produces one is hostile rather than merely damaged.
const MAX_EMPTY_READS: u32 = 64;

/// How far before a target the decoder will re-seek when the first attempt lands past it.
///
/// A seek is supposed to go to the keyframe at or before the requested instant. Some sources snap
/// the other way, and a decoder that accepts that silently returns a later frame than it was asked
/// for. Backing off in widening steps finds a keyframe that really is earlier; reaching zero means
/// the source's first frame is the honest answer and there is nowhere earlier to look.
const SEEK_BACKOFFS_100NS: [i64; 4] = [
    0,
    HUNDRED_NANOS_PER_SECOND,
    5 * HUNDRED_NANOS_PER_SECOND,
    30 * HUNDRED_NANOS_PER_SECOND,
];

/// A frame-exact decode over Media Foundation.
pub(crate) struct MediaFoundationDecoder {
    reader: Option<IMFSourceReader>,
    stream: u32,
    info: SourceInfo,
    config: DecoderConfig,
    sampler: OutputSampler,
    fallback_stride: usize,
    /// The sample that covers the instant most recently asked for.
    current: Option<SourceSample>,
    /// One sample of lookahead. Deciding whether `current` covers an instant needs to know where
    /// the *next* frame starts, so the reader is always one sample ahead of the answer.
    pending: Option<SourceSample>,
    at_end: bool,
    stats: DecodeStats,
    cancel: CancelToken,
}

impl fmt::Debug for MediaFoundationDecoder {
    /// Redacted on purpose. The decoder never stores the path it was opened with, and its debug
    /// view carries no pixels, so `{:?}` is as safe to log as an error is.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaFoundationDecoder")
            .field("open", &self.reader.is_some())
            .field("width", &self.info.decoded_width())
            .field("height", &self.info.decoded_height())
            .field("at_end", &self.at_end)
            .field("stats", &self.stats)
            .finish_non_exhaustive()
    }
}

impl MediaFoundationDecoder {
    /// Opens `source` and negotiates an NV12 decode of its first video stream.
    pub(crate) fn open(source: &Path, config: DecoderConfig) -> Result<Self, DecodeError> {
        check_source_path(source)?;
        if !source.is_file() {
            return Err(DecodeError::SourceUnusable {
                reason: SourceRejection::NotAFile,
            });
        }

        ensure_media_foundation()?;
        let attributes = media_type::reader_attributes()?;
        let path_units = wide_path(source)?;

        // SAFETY: `path_units` is a NUL-terminated wide string that outlives the call, and the
        // attribute store is borrowed for the duration of the call only. The reader takes its own
        // reference to it.
        let reader =
            unsafe { MFCreateSourceReaderFromURL(PCWSTR(path_units.as_ptr()), &attributes) }
                .map_err(|error| platform_error(MfStage::CreateSourceReader, &error))?;

        let stream = media_type::first_video_stream();
        // Read before anything is negotiated: this is the call that says whether there is a video
        // stream at all, and it describes the file rather than the decode.
        let native = media_type::native_type(&reader, stream)?;
        media_type::select_video_only(&reader, stream)?;
        media_type::request_nv12_output(&reader, stream)?;

        let output = media_type::current_output_type(&reader, stream)?;
        let (width, height) = media_type::frame_size(&output)?;
        config.limits().check_geometry(width, height)?;
        let coded = FrameGeometry::new(width, height)?;
        let presentation = format::presentation(&output, &native, coded)?;

        let duration_100ns = media_type::duration_100ns(&reader)?;
        config.limits().check_duration(duration_100ns)?;

        // The native type describes the file's frame grid. The negotiated output type may instead
        // expose Media Foundation's 100ns approximation of one frame duration: a real 24000/1001
        // AV1 file arrived as 10000000/417083, an equivalent-looking decimal but neither the exact
        // grid nor a ratio within the shared timeline's bounds. Prefer the authored ratio and use
        // the output only for sources whose native type omitted it.
        let (numerator, denominator) = preferred_frame_rate(
            media_type::frame_rate(&native),
            media_type::frame_rate(&output),
        )?;
        let grid = SourceGrid::new(numerator, denominator)?;

        let colorimetry = match config.colorimetry() {
            Some(override_value) => override_value,
            None => format::colorimetry(&output, &native, height)?,
        };
        let fallback_stride = format::stride(&output, coded);

        Ok(Self {
            reader: Some(reader),
            stream,
            info: SourceInfo::new(presentation, grid, duration_100ns, colorimetry),
            config,
            sampler: config.sampler(),
            fallback_stride,
            current: None,
            pending: None,
            at_end: false,
            stats: DecodeStats::default(),
            cancel: CancelToken::new(),
        })
    }

    fn reader(&self) -> Result<&IMFSourceReader, DecodeError> {
        self.reader.as_ref().ok_or(DecodeError::Closed)
    }

    /// Refuses a request the decoder's lifecycle no longer permits.
    ///
    /// Checked at the entry of every request rather than only where the reader is touched, so a
    /// closed decoder says so instead of reporting whatever its emptied state happens to look like.
    fn check_usable(&self) -> Result<(), DecodeError> {
        if self.reader.is_none() {
            return Err(DecodeError::Closed);
        }
        self.check_cancelled()
    }

    fn check_cancelled(&self) -> Result<(), DecodeError> {
        if self.cancel.is_cancelled() {
            return Err(DecodeError::Cancelled);
        }
        Ok(())
    }

    /// Pulls one decoded sample, or `None` at the end of the stream.
    fn read_sample(&mut self) -> Result<Option<SourceSample>, DecodeError> {
        if self.at_end {
            return Ok(None);
        }
        let reader = self.reader()?.clone();
        let stream = self.stream;

        for _ in 0..MAX_EMPTY_READS {
            let mut flags: u32 = 0;
            let mut timestamp: i64 = 0;
            let mut sample: Option<IMFSample> = None;

            // SAFETY: the reader is live for the duration of the call and every out-parameter is a
            // live local. `None` for the actual-stream-index parameter declares that the caller
            // already knows which stream it asked for.
            unsafe {
                reader.ReadSample(
                    stream,
                    0,
                    None,
                    Some(&raw mut flags),
                    Some(&raw mut timestamp),
                    Some(&raw mut sample),
                )
            }
            .map_err(|error| platform_error(MfStage::ReadSample, &error))?;

            if flags & flag(MF_SOURCE_READERF_ERROR) != 0 {
                // The flag word is the platform's own status for the read, not caller data.
                return Err(DecodeError::MediaFoundation {
                    stage: MfStage::ReadSample,
                    code: flags,
                });
            }
            if flags & flag(MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) != 0 {
                self.refresh_output_format()?;
            }
            if flags & flag(MF_SOURCE_READERF_ENDOFSTREAM) != 0 {
                self.at_end = true;
                return Ok(None);
            }
            let Some(sample) = sample else {
                // A stream tick or a gap: no frame, but not the end either.
                continue;
            };

            // SAFETY: the sample is live for the duration of the call and returns a copy.
            let presentation = unsafe { sample.GetSampleTime() }.unwrap_or(timestamp);
            // SAFETY: as above. A source that declares no per-sample duration gets the one its
            // frame rate implies, so a frame's interval is never zero-length.
            let duration = unsafe { sample.GetSampleDuration() }
                .ok()
                .filter(|value| *value > 0)
                .unwrap_or_else(|| self.info.grid().frame_duration_100ns());

            self.stats.record_sample();
            return Ok(Some(SourceSample::new(sample, presentation, duration)));
        }
        Err(DecodeError::MediaFoundation {
            stage: MfStage::ReadSample,
            code: 0,
        })
    }

    /// Re-reads the negotiated format after the reader says it changed.
    ///
    /// A decoder announces its real output type when decoding begins, and that type is routinely a
    /// larger surface than the one advertised before any sample was produced: 640x360 becomes
    /// 640x368, 1920x1080 becomes 1920x1088. Treating that as a source changing size mid-stream is
    /// what made ordinary video undecodable — every frame was refused before the first one arrived.
    ///
    /// So the two are separated. Before any sample has been decoded, a new surface is the decoder
    /// settling on its output, and it is adopted along with the picture rectangle inside it. Once
    /// frames have been produced, a change of the VISIBLE picture is still refused: the export's
    /// output size and the crop both derive from it, and a source that really changes shape has
    /// invalidated a decision already made. A surface that grows around an unchanged picture is
    /// adopted at any time, because nothing a customer sees depends on the padding.
    fn refresh_output_format(&mut self) -> Result<(), DecodeError> {
        let reader = self.reader()?.clone();
        let output = media_type::current_output_type(&reader, self.stream)?;
        let native = media_type::native_type(&reader, self.stream)?;
        let (width, height) = media_type::frame_size(&output)?;
        self.config.limits().check_geometry(width, height)?;
        let coded = FrameGeometry::new(width, height)?;
        let refreshed = format::presentation(&output, &native, coded)?;

        let established = self.info.presentation();
        let decoded_any = self.stats.samples_decoded() > 0;
        let picture_changed = refreshed.visible().size() != established.visible().size();
        if picture_changed && decoded_any {
            return Err(DecodeError::SourceGeometryChanged {
                opened: established.visible().size(),
                current: refreshed.visible().size(),
            });
        }

        self.info = self.info.with_presentation(refreshed);
        self.fallback_stride = format::stride(&output, coded);
        Ok(())
    }

    fn ensure_current(&mut self) -> Result<(), DecodeError> {
        if self.current.is_some() {
            return Ok(());
        }
        if let Some(pending) = self.pending.take() {
            self.current = Some(pending);
            return Ok(());
        }
        self.current = self.read_sample()?;
        Ok(())
    }

    fn fill_pending(&mut self) -> Result<(), DecodeError> {
        if self.pending.is_some() {
            return Ok(());
        }
        self.pending = self.read_sample()?;
        Ok(())
    }

    /// Repositions the reader. The decoded state is discarded, because none of it is valid any
    /// more and keeping a stale frame is how a decoder returns the wrong one.
    ///
    /// The position is clamped inside the source. Media Foundation refuses a seek past the end with
    /// a platform error, and reporting that as a platform failure would hide the thing the caller
    /// actually needs to know, which is that the file is shorter than the timeline.
    fn seek_to(&mut self, position_100ns: i64) -> Result<(), DecodeError> {
        let reader = self.reader()?.clone();
        let time_format = GUID::zeroed();
        let position = PROPVARIANT::from(self.clamp_into_source(position_100ns));

        // SAFETY: both arguments are live locals for the duration of the call. The zero GUID is the
        // platform's "100-nanosecond units" time format, and the reader copies the position rather
        // than retaining the pointer.
        unsafe { reader.SetCurrentPosition(&raw const time_format, &raw const position) }
            .map_err(|error| platform_error(MfStage::Seek, &error))?;

        self.current = None;
        self.pending = None;
        self.at_end = false;
        self.stats.record_seek();
        Ok(())
    }

    /// Brings a seek position inside the source's declared span.
    ///
    /// A declared duration of zero means the container did not say, in which case there is nothing
    /// to clamp against and the position is passed through.
    fn clamp_into_source(&self, position_100ns: i64) -> i64 {
        let duration = self.info.duration_100ns();
        if duration <= 0 {
            return position_100ns.max(0);
        }
        position_100ns.clamp(0, duration - 1)
    }

    /// How far forward walking is preferred over seeking, in 100ns units.
    fn walk_budget_100ns(&self) -> i64 {
        let frames = i64::from(self.config.limits().forward_scan_frames());
        frames.saturating_mul(self.info.grid().frame_duration_100ns())
    }

    fn should_seek(&self, target_100ns: i64) -> bool {
        match &self.current {
            // Nothing decoded yet: the start of the file is already where a target of zero wants to
            // be, so only a real offset is worth a seek.
            None => target_100ns > 0,
            Some(current) => {
                let position = current.presentation_100ns();
                target_100ns < position
                    || target_100ns.saturating_sub(position) > self.walk_budget_100ns()
            }
        }
    }

    /// Gets the reader to a decode position at or before `target_100ns`.
    fn seek_before(&mut self, target_100ns: i64) -> Result<(), DecodeError> {
        for backoff in SEEK_BACKOFFS_100NS {
            self.check_cancelled()?;
            let position = target_100ns.saturating_sub(backoff);
            self.seek_to(position)?;
            self.ensure_current()?;
            match &self.current {
                // Nothing after this position at all; the walk will report the truncation.
                None => return Ok(()),
                Some(current) if current.presentation_100ns() <= target_100ns => return Ok(()),
                Some(_) => {}
            }
            if position <= 0 {
                // Already at the start of the source. Its first frame is the honest answer for an
                // instant that precedes it.
                return Ok(());
            }
        }
        Ok(())
    }

    /// Walks forward until `current` is the sample covering `target_100ns`.
    fn walk_to(&mut self, target_100ns: i64) -> Result<(), DecodeError> {
        let budget = self.config.limits().max_decode_walk();
        let mut walked = 0_u32;

        self.ensure_current()?;
        if self.current.is_none() {
            return Err(DecodeError::TruncatedStream {
                decoded: self.stats.samples_decoded(),
            });
        }
        loop {
            self.check_cancelled()?;
            self.fill_pending()?;
            let advance = self
                .pending
                .as_ref()
                .is_some_and(|next| next.presentation_100ns() <= target_100ns);
            if !advance {
                return Ok(());
            }
            self.current = self.pending.take();
            walked += 1;
            if walked > budget {
                return Err(DecodeError::FrameNotFound { target_100ns });
            }
        }
    }

    /// Resolves one instant into the source frame that covers it.
    fn frame_at_100ns(&mut self, target_100ns: i64) -> Result<DecodedFrame, DecodeError> {
        self.check_usable()?;
        // An instant past the source's declared span is answered without touching the platform. The
        // caller's timeline is longer than the file, which is a fact about the file and not a
        // platform failure, and reporting it as one would send someone looking at Media Foundation.
        let duration = self.info.duration_100ns();
        if duration > 0 && target_100ns >= duration {
            return Err(DecodeError::TruncatedStream {
                decoded: self.stats.samples_decoded(),
            });
        }
        if self.should_seek(target_100ns) {
            self.seek_before(target_100ns)?;
        }
        self.walk_to(target_100ns)?;

        let presentation = self.info.presentation();
        let colorimetry = self.info.colorimetry();
        let grid = self.info.grid();
        let stride = self.fallback_stride;
        let decoded = self.stats.samples_decoded();

        let current = self
            .current
            .as_ref()
            .ok_or(DecodeError::TruncatedStream { decoded })?;
        // A container presentation may legitimately outlive its selected video stream because an
        // audio track has a small encoder-delay tail. Browsers keep the last picture visible for
        // that tail, and the shared presentation duration above says the source is still live, so
        // do the same. A source with no declared duration gets no such authority: once its final
        // sample interval ends, holding it would turn an unknown/truncated stream into a complete
        // one. Targets at or beyond a positive declared duration were already refused above.
        if self.at_end
            && duration <= 0
            && target_100ns
                >= current
                    .presentation_100ns()
                    .saturating_add(current.duration_100ns())
        {
            return Err(DecodeError::TruncatedStream { decoded });
        }
        convert(current, presentation, colorimetry, stride, grid)
    }
}

fn preferred_frame_rate(
    native: Option<(u32, u32)>,
    output: Option<(u32, u32)>,
) -> Result<(u32, u32), DecodeError> {
    native.or(output).ok_or(DecodeError::UnsupportedFrameRate)
}

impl VideoDecoder for MediaFoundationDecoder {
    fn source(&self) -> SourceInfo {
        self.info
    }

    fn config(&self) -> DecoderConfig {
        self.config
    }

    fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }

    fn stats(&self) -> DecodeStats {
        self.stats
    }

    fn frame_for_output(&mut self, index: u32) -> Result<DecodedFrame, DecodeError> {
        let target = self.sampler.sample_100ns(index)?;
        self.frame_at_100ns(target)
    }

    fn frame_at_time(&mut self, time: ExactTime) -> Result<DecodedFrame, DecodeError> {
        let target =
            exact_time_to_100ns(time).ok_or(DecodeError::TimestampOutOfRange { index: 0 })?;
        self.frame_at_100ns(target)
    }

    fn source_frame(&mut self, index: u64) -> Result<DecodedFrame, DecodeError> {
        let bounded = u32::try_from(index)
            .map_err(|_| DecodeError::TimestampOutOfRange { index: u32::MAX })?;
        let target = self.info.grid().frame_midpoint_100ns(bounded)?;
        self.frame_at_100ns(target)
    }

    fn next_frame(&mut self) -> Result<Option<DecodedFrame>, DecodeError> {
        self.check_usable()?;
        if self.current.is_some() {
            self.fill_pending()?;
            let Some(next) = self.pending.take() else {
                self.current = None;
                return Ok(None);
            };
            self.current = Some(next);
        } else {
            self.ensure_current()?;
            if self.current.is_none() {
                return Ok(None);
            }
        }

        let presentation = self.info.presentation();
        let colorimetry = self.info.colorimetry();
        let grid = self.info.grid();
        let stride = self.fallback_stride;
        let current = self.current.as_ref().ok_or(DecodeError::TruncatedStream {
            decoded: self.stats.samples_decoded(),
        })?;
        convert(current, presentation, colorimetry, stride, grid).map(Some)
    }

    fn close(&mut self) {
        self.current = None;
        self.pending = None;
        self.reader = None;
        self.at_end = true;
    }
}

/// Reads one decoded sample into the compositor's representation.
///
/// A free function on purpose: the lock borrows the sample, so nothing else about the decoder may
/// be borrowed at the same time, and taking the few values it needs by copy makes that structural
/// rather than a fight with the borrow checker at each call site.
fn convert(
    sample: &SourceSample,
    presentation: SourcePresentation,
    colorimetry: SourceColorimetry,
    fallback_stride: usize,
    grid: SourceGrid,
) -> Result<DecodedFrame, DecodeError> {
    let lock = sample.lock(fallback_stride)?;
    // The planes are read at the **coded** grid, because that is the buffer the platform filled; only
    // the **visible** rectangle inside it is converted, because the rest is macroblock padding; and
    // the frame is handed out at the **decoded** grid, because the turn has been applied to it.
    let planes = lock.planes(presentation.coded())?;
    let pixels = planes.region_to_rgba8_rotated(
        colorimetry,
        presentation.rotation(),
        presentation.visible(),
    );
    Ok(DecodedFrame::new(
        presentation.decoded(),
        pixels,
        sample.presentation_100ns(),
        sample.duration_100ns(),
        grid.nearest_frame_index_100ns(sample.presentation_100ns()),
    ))
}

/// A source-reader flag as the bit it occupies in the flag word.
fn flag(value: windows::Win32::Media::MediaFoundation::MF_SOURCE_READER_FLAG) -> u32 {
    value.0.cast_unsigned()
}

#[cfg(test)]
mod frame_rate_tests {
    use super::preferred_frame_rate;
    use crate::DecodeError;

    #[test]
    fn the_authored_source_grid_wins_over_the_negotiated_timebase_approximation() {
        assert_eq!(
            preferred_frame_rate(Some((24_000, 1_001)), Some((10_000_000, 417_083))),
            Ok((24_000, 1_001))
        );
        assert_eq!(preferred_frame_rate(None, Some((30, 1))), Ok((30, 1)));
        assert_eq!(
            preferred_frame_rate(None, None),
            Err(DecodeError::UnsupportedFrameRate)
        );
    }
}
