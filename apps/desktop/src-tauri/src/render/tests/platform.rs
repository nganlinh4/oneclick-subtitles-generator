//! The half of the export boundary that needs the platform: a real graphics adapter, real Media
//! Foundation codecs, and the same function the command calls.
//!
//! Windows-only because that is where those are. Split from `render/tests.rs` at the seam that file
//! already describes: everything here encodes a source clip, exports it through the export runner,
//! and reads the result back through the platform decoder, so every stage is proven against the
//! others rather than against a file somebody generated once.

use std::sync::atomic::{AtomicU32, Ordering};

use osg_decode::{DecoderConfig, open_decoder};
use osg_export::{
    ExportPlan, ExportProgress, FrameRenderer, MAX_PROGRESS_REPORTS, ProgressSink, StagedText,
    probe_source,
};
use osg_render::RenderRequest;
use osg_scene::{ExactTime, FrameTimeline};
use serde_json::Value;
use tempfile::TempDir;

use super::super::events::RenderPhaseResponse;
use super::super::export::{self, ExportControl, NativeExportInputs};
use super::super::fixtures;
use super::super::progress::RenderProgressReport;

/// Records every report an export emits, so the stream can be asserted afterwards.
#[derive(Debug, Default)]
struct Recorder(Vec<ExportProgress>);

impl ProgressSink for Recorder {
    fn report(&mut self, progress: ExportProgress) {
        self.0.push(progress);
    }
}

/// Stops the export at the `after`th report, which lands mid-composition.
struct Stopper {
    control: ExportControl,
    after: u32,
    seen: AtomicU32,
}

impl ProgressSink for Stopper {
    fn report(&mut self, _progress: ExportProgress) {
        if self.seen.fetch_add(1, Ordering::AcqRel) + 1 >= self.after {
            self.control.cancel();
        }
    }
}

fn request(value: &Value) -> RenderRequest {
    serde_json::from_value(value.clone()).expect("the fixture request deserializes")
}

fn inputs(source: &std::path::Path, staging: &TempDir, value: &Value) -> NativeExportInputs {
    NativeExportInputs {
        request: request(value),
        source: source.to_owned(),
        narration: None,
        staging_root: staging.path().to_owned(),
        fps: 30,
        duration_in_frames: fixtures::EXPORT_FRAMES,
    }
}

/// The staged text the command would have resolved from the `WebView`'s payload.
fn staged_text() -> StagedText {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());
    fixtures::export_text(atlas_id, 1)
        .resolve(&atlases, 1)
        .expect("the fixture payload resolves")
}

#[test]
fn a_staged_request_exports_a_playable_file_of_the_length_the_timeline_names() {
    let _platform = fixtures::platform();
    let media = TempDir::new().expect("a media directory");
    let staging = TempDir::new().expect("a staging root");
    let source = fixtures::source_clip(&media, "export-source.mp4");
    let value = fixtures::request_json();
    let control = ExportControl::default();
    let mut recorder = Recorder::default();

    let exported = export::run(
        inputs(&source, &staging, &value),
        staged_text(),
        &control,
        &mut recorder,
    )
    .expect("a staged request exports");

    assert_eq!(exported.duration_in_frames(), fixtures::EXPORT_FRAMES);
    assert_eq!(exported.width(), fixtures::COMPOSITION_WIDTH);
    assert_eq!(exported.height(), fixtures::COMPOSITION_HEIGHT);
    assert_eq!(exported.fps(), 30);
    assert!(exported.size_bytes() > 0, "an empty file is not a render");
    assert!(exported.path().is_file());

    // Playable, and the length the timeline named: read back through the platform decoder the
    // exporter reads sources with, on the exported file's own grid.
    let timeline = FrameTimeline::new(30, 1, fixtures::EXPORT_FRAMES, ExactTime::ZERO)
        .expect("a supported grid");
    let mut decoder =
        open_decoder(exported.path(), DecoderConfig::new(timeline)).expect("a decodable export");
    let info = decoder.source();
    assert_eq!(info.display_width(), fixtures::COMPOSITION_WIDTH);
    assert_eq!(info.display_height(), fixtures::COMPOSITION_HEIGHT);
    // One second, to within a frame: the duration follows from the frame count and the rate.
    let one_second_100ns = 10_000_000_i64;
    let frame_100ns = one_second_100ns / i64::from(fixtures::EXPORT_FRAMES);
    assert!(
        (info.duration_100ns() - one_second_100ns).abs() <= frame_100ns,
        "{} is not one second",
        info.duration_100ns(),
    );
    let last = decoder
        .frame_for_output(fixtures::EXPORT_FRAMES - 1)
        .expect("the export carries the last frame the timeline names");
    assert_eq!(
        u32::try_from(last.width()).expect("a width"),
        fixtures::COMPOSITION_WIDTH
    );
    decoder.close();

    assert_progress_stream(&recorder.0);
}

/// Monotonic, bounded, and naming one duration — the three things `renderService.js` enforces.
fn assert_progress_stream(reports: &[ExportProgress]) {
    assert!(!reports.is_empty(), "an export must report progress");
    assert!(
        reports.len() <= usize::try_from(MAX_PROGRESS_REPORTS).expect("a small bound"),
        "{} reports is more than the bound of {MAX_PROGRESS_REPORTS}",
        reports.len(),
    );
    let mut last_fraction = 0_u32;
    let mut last_phase = RenderPhaseResponse::Staging.rank();
    let mut last_frames = 0_u32;
    for report in reports {
        let mapped = RenderProgressReport::from_export(*report);
        assert_eq!(mapped.duration_in_frames, fixtures::EXPORT_FRAMES);
        assert!(mapped.fraction_millionths <= 1_000_000);
        assert!(mapped.rendered_frames <= mapped.duration_in_frames);
        assert_eq!(mapped.rendered_frames, mapped.encoded_frames);
        assert!(mapped.fraction_millionths >= last_fraction, "{mapped:?}");
        let phase = mapped.phase.rank();
        assert!(phase >= last_phase, "{mapped:?}");
        if phase == last_phase {
            assert!(mapped.rendered_frames >= last_frames, "{mapped:?}");
        }
        last_fraction = mapped.fraction_millionths;
        last_phase = phase;
        last_frames = mapped.rendered_frames;
    }
    let last = RenderProgressReport::from_export(*reports.last().expect("a last report"));
    assert_eq!(last.phase, RenderPhaseResponse::Muxing);
    assert_eq!(last.fraction_millionths, 1_000_000);
    assert_eq!(last.rendered_frames, fixtures::EXPORT_FRAMES);
}

#[test]
fn a_cancelled_export_leaves_no_file_that_could_be_mistaken_for_a_finished_one() {
    let _platform = fixtures::platform();
    let media = TempDir::new().expect("a media directory");
    let staging = TempDir::new().expect("a staging root");
    let source = fixtures::source_clip(&media, "cancel-source.mp4");
    let value = fixtures::request_json();
    let control = ExportControl::default();
    let mut stopper = Stopper {
        control: control.clone(),
        after: 2,
        seen: AtomicU32::new(0),
    };

    let refused = export::run(
        inputs(&source, &staging, &value),
        staged_text(),
        &control,
        &mut stopper,
    )
    .expect_err("a cancelled export does not finish");

    assert_eq!(refused.code(), "renderCancelled");
    let left_behind: Vec<_> = std::fs::read_dir(staging.path())
        .expect("the staging root is readable")
        .filter_map(Result::ok)
        .collect();
    assert!(
        left_behind.is_empty(),
        "a cancelled export left {} entries behind",
        left_behind.len(),
    );
}

#[test]
fn the_same_staged_request_composes_identical_frames() {
    let _platform = fixtures::platform();
    let media = TempDir::new().expect("a media directory");
    let source = fixtures::source_clip(&media, "determinism-source.mp4");
    let value = fixtures::request_json();

    // Two independent renderers over the same staged payload. Encoded bytes are not
    // reproducible — hardware encoders differ between vendors and driver versions — so the
    // contract binds the composited frames, which is what reaches the encoder.
    let first = compose(&source, &value, 7);
    let second = compose(&source, &value, 7);
    assert_eq!(first, second, "the same request composed two pictures");
    assert!(
        first.iter().any(|byte| *byte != 0),
        "an empty frame proves nothing"
    );

    let elsewhere = compose(&source, &value, 20);
    assert_ne!(
        first, elsewhere,
        "two different instants of an animated cue composed the same picture",
    );
}

/// Composes one frame from the wire payload, through the export's own conversion.
fn compose(source: &std::path::Path, value: &Value, frame_index: u32) -> Vec<u8> {
    let info = probe_source(source).expect("the synthetic clip is readable");
    let plan = request(value)
        .validate(
            info.display_width(),
            info.display_height(),
            u64::try_from(info.duration_100ns() / 10).expect("a positive duration"),
        )
        .expect("the fixture request validates against the synthetic clip");
    let export = ExportPlan::convert(&plan, &fixtures::default_face()).expect("it converts");
    let scene = export
        .compose(staged_text())
        .expect("the staged text composes");
    let mut renderer =
        FrameRenderer::open(&export, scene, source).expect("an adapter and a readable source");
    let frame = renderer.frame(frame_index).expect("a composed frame");
    let pixels = frame.pixels().to_vec();
    renderer.close();
    pixels
}
