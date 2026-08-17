//! The composed frame against the same frame decoded back out of the finished `MP4`.
//!
//! This is the only comparison in the gate that cannot be exact, and the reason is not the
//! renderer. `H.264` is a lossy codec, its chroma is subsampled, and the encoder is the platform's
//! own — Media Foundation hands the work to whatever the installed GPU driver provides, so the same
//! frames encoded on two machines are not the same bytes. A gate that demanded byte equality here
//! would be a gate that fails on a different laptop.
//!
//! So the comparison is tolerant, and the tolerance is **measured**, not chosen:
//! [`measure`] prints the whole distribution — mean, the thousandth percentile and the maximum
//! per-channel difference — for every frame it compares, and `parity.rs` asserts two things about
//! it. First that a faithful round trip sits inside [`REVIEWED`]. Second, and this is the half that
//! makes the number mean anything, that a **deliberate one-pixel shift of the composed frame** sits
//! far outside it. A tolerance nobody has shown to reject a real regression is a number, not a
//! gate.
//!
//! What it would still miss, stated plainly: a change smaller than the codec's own noise floor
//! everywhere in the frame — a uniform shift of one or two levels, a sub-pixel repositioning that
//! moves no glyph edge past a sample, or a colour change confined to an area smaller than a
//! thousandth of the frame and gentler than the maximum. Those are caught by the exact half of the
//! gate instead, where the composed frame is compared against another composed frame with no
//! tolerance at all.

use std::path::{Path, PathBuf};

use osg_decode::{DecoderConfig, open_decoder};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
use osg_export::{
    ExportCancel, ExportError, ExportJob, ExportSummary, FrameRenderer, SilentProgress, StagedText,
    probe_source, run_export,
};
use osg_render::RenderRequest;
use osg_scene::{ExactTime, FrameTimeline};
use tempfile::TempDir;

use super::case::{self, Case, Prepared};
use super::compare::{self, FrameDiff, Tolerance};
use crate::support::media::{
    SOURCE_FPS, SOURCE_FRAMES, SOURCE_HEIGHT, SOURCE_WIDTH, source_clip, synthetic_frame,
};

/// The tolerance a faithful round trip is admitted by.
///
/// Every number is the measured distribution rounded up to the next whole level, so it is tight
/// enough that the one-pixel-shift check below fails it by more than an order of magnitude. See
/// the module docs for what it cannot see.
pub(crate) const REVIEWED: Tolerance = Tolerance {
    mean_channel: 0.5,
    p999_channel: 4,
    max_channel: 16,
};

/// Everything one round trip produced.
#[derive(Debug)]
pub(crate) struct RoundTrip {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) frames: u32,
    pub(crate) summary: ExportSummary,
    /// The composed frame and the decoded frame, per compared index.
    pub(crate) pairs: Vec<(u32, Vec<u8>, Vec<u8>)>,
}

impl RoundTrip {
    /// The measured difference at each compared frame.
    pub(crate) fn diffs(&self) -> Vec<(u32, FrameDiff)> {
        self.pairs
            .iter()
            .map(|(index, native, decoded)| (*index, compare::diff(native, decoded)))
            .collect()
    }
}

/// Exports a case for real, decodes it back, and pairs the frames.
///
/// # Panics
/// Panics when the case cannot be converted, when the export fails, or when the finished file
/// cannot be decoded. Every one of those is a finding rather than a harness problem.
pub(crate) fn measure(directory: &TempDir, case: &Case, compared: &[u32]) -> RoundTrip {
    let source = source_clip(directory, "parity-source.mp4");
    let prepared = prepare_against(&source, case);
    let text = prepared.staged.text(case.cue_count());
    measure_staged(directory, &source, case, &prepared, compared, &text)
}

/// The same, against text the caller staged rather than the one cue's bake this module would.
///
/// The multi-page shape has no other way through this gate: a document baked into several atlas
/// pages is staged by the caller, and every frame of it still has to survive the encoder and come
/// back inside the same measured tolerance a single-page export does.
///
/// One export per directory: the encoder refuses to open over an existing file, which is the
/// behaviour `hard.rs` relies on, so a caller that wants two round trips wants two directories.
///
/// # Panics
/// Panics when the export fails or the finished file cannot be decoded. Both are findings.
pub(crate) fn measure_staged(
    directory: &TempDir,
    source: &Path,
    case: &Case,
    prepared: &Prepared,
    compared: &[u32],
    text: &StagedText,
) -> RoundTrip {
    let output = directory.path().join("parity-export.mp4");
    let summary = export_text(source, &output, None, case, text.clone())
        .unwrap_or_else(|error| panic!("{}: the export failed: {error}", case.id));
    let frames = prepared.plan.frame_count();
    assert_eq!(summary.frames(), frames);

    let scene = prepared
        .plan
        .compose(text.clone())
        .expect("the staged text composes");
    let mut renderer = FrameRenderer::open(&prepared.plan, scene, source)
        .expect("a graphics adapter and a readable source");
    let mut pairs = Vec::with_capacity(compared.len());
    for index in compared {
        let native = renderer
            .frame(*index)
            .unwrap_or_else(|error| panic!("{}: frame {index} was refused: {error}", case.id))
            .into_pixels();
        let decoded = decoded_frame_at(&output, *index, frames, u32::from(case.frame_rate));
        assert_eq!(
            native.len(),
            decoded.len(),
            "{}: frame {index} came back at a different size than it was composed at",
            case.id
        );
        pairs.push((*index, native, decoded));
    }
    renderer.close();

    RoundTrip {
        width: prepared.plan.width(),
        height: prepared.plan.height(),
        frames,
        summary,
        pairs,
    }
}

/// One frame decoded back out of a finished export, for a caller that ran the export itself.
pub(crate) fn decoded(path: &Path, index: u32, frames: u32, fps: u32) -> Vec<u8> {
    decoded_frame_at(path, index, frames, fps)
}

/// One frame decoded back out of a finished export, at that export's own frame rate.
///
/// The shared fixture's reader is fixed at the source clip's rate; a case at another rate needs a
/// grid of its own, or the decoder is asked for instants the file does not have and reports a
/// truncation that is about the harness rather than the export.
fn decoded_frame_at(path: &Path, index: u32, frames: u32, fps: u32) -> Vec<u8> {
    let timeline =
        FrameTimeline::new(fps, 1, frames, ExactTime::ZERO).expect("a supported output grid");
    let mut decoder =
        open_decoder(path, DecoderConfig::new(timeline)).expect("the export is decodable");
    let frame = decoder
        .frame_for_output(index)
        .expect("the export carries the frame the timeline names");
    decoder.close();
    frame.into_pixels()
}

/// The conversion of a case against what the synthetic clip really is.
pub(crate) fn prepare_against(source: &Path, case: &Case) -> Prepared {
    let info = probe_source(source).expect("the synthetic clip is readable");
    let duration_us =
        u64::try_from(info.duration_100ns() / 10).expect("a positive duration in microseconds");
    case::try_prepare_against(
        case,
        info.display_width(),
        info.display_height(),
        duration_us,
    )
    .unwrap_or_else(|reason| panic!("{}: {reason}", case.id))
}

/// Runs one export of a case to completion, with the case's own staged text.
pub(crate) fn export(
    source: &Path,
    output: &Path,
    narration: Option<&Path>,
    case: &Case,
    prepared: &Prepared,
) -> Result<ExportSummary, ExportError> {
    export_with(source, output, narration, case, prepared, 1)
}

/// The same, for a case carrying more than one cue, all drawing the same run.
pub(crate) fn export_with(
    source: &Path,
    output: &Path,
    narration: Option<&Path>,
    case: &Case,
    prepared: &Prepared,
    cues: usize,
) -> Result<ExportSummary, ExportError> {
    export_text(source, output, narration, case, prepared.staged.text(cues))
}

/// The same, against text the caller staged: several pages, a run per cue, or a deliberate fault.
pub(crate) fn export_text(
    source: &Path,
    output: &Path,
    narration: Option<&Path>,
    case: &Case,
    text: StagedText,
) -> Result<ExportSummary, ExportError> {
    let request: RenderRequest =
        serde_json::from_value(case.request()).expect("the case request deserializes");
    run_export(
        ExportJob {
            request,
            source,
            narration,
            output,
            text,
            cancel: ExportCancel::new(),
        },
        &mut SilentProgress,
    )
}

/// A synthetic clip of `seconds` seconds, for the long-duration case.
///
/// The shared fixture encodes a fixed ninety frames; a long case needs a clip as long as it claims
/// to be, so it is encoded here through the same platform encoder with a ramp that repeats rather
/// than overflowing.
pub(crate) fn long_clip(directory: &TempDir, name: &str, seconds: u32) -> PathBuf {
    let output = directory.path().join(name);
    let frames = seconds * SOURCE_FPS;
    let video = VideoConfig::new(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS, 1, frames)
        .expect("a supported source configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(30)
        .expect("30 frames is in range");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder");
    for index in 0..frames {
        let pixels = synthetic_frame(index % SOURCE_FRAMES);
        let frame = FrameBuffer::new(&pixels, SOURCE_WIDTH, SOURCE_HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the source container is closed");
    output
}

/// Where a synthetic source clip for a hard case lands.
pub(crate) fn clip(directory: &TempDir, name: &str) -> PathBuf {
    source_clip(directory, name)
}

/// The same frame shifted one pixel to the left, for proving the tolerance is not a rubber stamp.
///
/// One pixel is the smallest positional regression a renderer can make and the one most likely to
/// be waved through: it is what an off-by-one in a pen position, a baseline or a box anchor looks
/// like. If the tolerance admits this, it admits a real bug.
pub(crate) fn shifted_left(pixels: &[u8], width: u32) -> Vec<u8> {
    let stride = usize::try_from(width).expect("a small width") * 4;
    let mut shifted = pixels.to_vec();
    for row in shifted.chunks_exact_mut(stride) {
        row.rotate_left(4);
    }
    shifted
}

#[cfg(windows)]
mod tests {
    use tempfile::TempDir;

    use super::{REVIEWED, measure, measure_staged, prepare_against, shifted_left};
    use crate::gate::case::Case;
    use crate::gate::compare::{self, Tolerance};
    use crate::gate::documents::{self, FRAMES_PER_CUE};
    use crate::gate::{exclusive, matrix, sweep};
    use crate::support::media::source_clip;

    /// The frames compared: one inside the fade-in, one holding, one inside the fade-out.
    const COMPARED: [u32; 3] = [7, 16, 25];

    /// Which cues of the multi-page document are decoded back, chosen to land on different pages.
    ///
    /// The first two are early enough to be on the first page and the last is past the point where
    /// it filled up, so the comparison covers a frame drawn from each page rather than three frames
    /// drawn from the same one. Which page each cue really landed on is asserted, not assumed.
    const PAGED_CUES: [usize; 3] = [0, 12, 24];

    #[test]
    fn a_document_that_needs_several_atlas_pages_survives_the_encoder_and_decodes_back() {
        // The single-page round trip above proves the codec path. This proves the *paged* path
        // through the same measured tolerance: a document whose alphabet outgrows one atlas is
        // exported for real, decoded back, and compared frame for frame against what the compositor
        // composed — with a frame taken from each page, so a page that was never bound, uploaded or
        // sampled would show up as a wrong picture rather than as a smaller file.
        let _lock = exclusive();
        let directory = TempDir::new().expect("a temporary directory");
        let loaded = matrix::load();
        let document = documents::all(&loaded)
            .into_iter()
            .find(|entry| entry.expected_pages > 1 && entry.id == "doc=korean-pages")
            .expect("the paging documents carry a multi-page Korean case");
        assert_eq!(
            document.document.page_count(),
            document.expected_pages,
            "the Korean document no longer needs more than one atlas page, so this case would be \
             exporting the single-page shape a second time"
        );

        let source = source_clip(&directory, "paged-source.mp4");
        let prepared = prepare_against(&source, &document.case);
        let text = document.document.staged_text();
        let compared: Vec<u32> = PAGED_CUES
            .iter()
            .map(|cue| document.middle_frame(*cue))
            .collect();
        let pages: Vec<usize> = PAGED_CUES
            .iter()
            .map(|cue| document.document.page_of(*cue))
            .collect();
        assert!(
            pages.iter().any(|page| *page != pages[0]),
            "every compared frame is drawn from page {}, so no second page is exercised",
            pages[0]
        );

        let round = measure_staged(
            &directory,
            &source,
            &document.case,
            &prepared,
            &compared,
            &text,
        );
        println!(
            "paged round trip: {}x{}, {} frames, {} cues over {} pages ({} cells), {} bytes",
            round.width,
            round.height,
            round.frames,
            document.document.cues(),
            document.document.page_count(),
            document
                .document
                .cells_per_page()
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join("+"),
            round.summary.file_bytes(),
        );
        assert_eq!(
            u64::from(round.frames),
            u64::try_from(document.document.cues()).expect("a bounded cue count") * FRAMES_PER_CUE,
            "the paged document did not write a frame for every cue slot"
        );

        for ((index, diff), (cue, page)) in
            round.diffs().into_iter().zip(PAGED_CUES.iter().zip(&pages))
        {
            println!(
                "  cue {cue} on page {page}, frame {index}: differing {} of {}, mean {:.4}, \
                 p999 {}, max {}, alpha {}",
                diff.differing_pixels,
                diff.total_pixels,
                diff.mean_channel,
                diff.p999_channel,
                diff.max_channel,
                diff.max_alpha
            );
            assert!(
                REVIEWED.admits(&diff),
                "{}",
                compare::report(&document.id, index, &diff, &[], &[])
            );
        }

        // The same half that makes the tolerance mean anything on the single-page case: a composed
        // frame moved one pixel must sit outside it, or the tolerance would admit an atlas page
        // whose cells were placed one pixel out by the repack.
        let (index, native, decoded) = round.pairs.first().expect("a compared frame");
        let shifted = shifted_left(native, round.width);
        let regression = compare::diff(&shifted, decoded);
        println!(
            "  one-pixel shift at frame {index}: mean {:.4}, p999 {}, max {}",
            regression.mean_channel, regression.p999_channel, regression.max_channel
        );
        assert!(
            !REVIEWED.admits(&regression),
            "a one-pixel shift of a paged frame is inside the tolerance: {regression:?}"
        );
    }

    #[test]
    fn a_composed_frame_and_the_same_frame_decoded_back_agree_inside_a_measured_tolerance() {
        let _lock = exclusive();
        let directory = TempDir::new().expect("a temporary directory");
        let loaded = matrix::load();
        let case = Case::new(
            "roundtrip preset=default text=vietnamese out=720p30",
            sweep::defaults(&loaded),
            loaded.text("vietnamese").text.clone(),
            "720p",
            30,
        );
        let round = measure(&directory, &case, &COMPARED);
        println!(
            "round trip: {}x{}, {} frames, {} bytes",
            round.width,
            round.height,
            round.frames,
            round.summary.file_bytes()
        );

        for (index, diff) in round.diffs() {
            println!(
                "  frame {index}: differing {} of {}, mean {:.4}, p999 {}, max {}, alpha {}",
                diff.differing_pixels,
                diff.total_pixels,
                diff.mean_channel,
                diff.p999_channel,
                diff.max_channel,
                diff.max_alpha
            );
        }
        for ((index, native, decoded), (_, diff)) in round.pairs.iter().zip(round.diffs()) {
            assert!(
                REVIEWED.admits(&diff),
                "the round trip is outside the reviewed tolerance\n{}",
                compare::report(&case.id, *index, &diff, native, decoded)
            );
        }

        // The half that makes the tolerance mean something: the same comparison against a composed
        // frame moved one pixel. If this were admitted, so would an off-by-one in any pen position,
        // baseline or box anchor — the most likely real regression there is.
        let (index, native, decoded) = round.pairs.first().expect("a compared frame");
        let shifted = shifted_left(native, round.width);
        let regression = compare::diff(&shifted, decoded);
        println!(
            "  one-pixel shift at frame {index}: mean {:.4}, p999 {}, max {}",
            regression.mean_channel, regression.p999_channel, regression.max_channel
        );
        assert!(
            !REVIEWED.admits(&regression),
            "a one-pixel shift of the composed frame is inside the tolerance, so the tolerance \
             cannot catch an off-by-one: {regression:?}"
        );

        // And a temporal regression: the right picture at the wrong instant.
        let (_, _, other) = round.pairs.last().expect("a second compared frame");
        let mismatched = compare::diff(native, other);
        println!(
            "  wrong-frame comparison: mean {:.4}, p999 {}, max {}",
            mismatched.mean_channel, mismatched.p999_channel, mismatched.max_channel
        );
        assert!(
            !REVIEWED.admits(&mismatched),
            "one frame compared against another is inside the tolerance, so the tolerance cannot \
             catch a timing regression: {mismatched:?}"
        );

        // And the tolerance is not vacuous in the other direction either: a tolerance of zero must
        // reject the faithful round trip, which is what proves the codec loss is real and measured
        // rather than a comparison that never looked.
        let exact = Tolerance {
            mean_channel: 0.0,
            p999_channel: 0,
            max_channel: 0,
        };
        let (_, faithful) = round.diffs().into_iter().next().expect("a measured frame");
        assert!(
            !exact.admits(&faithful),
            "the round trip was byte-exact, so the tolerance is measuring nothing"
        );
    }
}
