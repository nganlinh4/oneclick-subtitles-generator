//! What the export boundary promises, asserted against the boundary rather than a description of it.
//!
//! The suite is in two halves. The first needs no platform at all: it is the wire payload, the
//! refusals and the status shape, and it runs everywhere. The second drives a real graphics adapter
//! and real Media Foundation codecs, and is Windows-only because that is where they are — it encodes
//! a source clip, exports it through the same function the command calls, and reads the result back
//! through the platform decoder, so every stage is proven against the others rather than against a
//! file somebody generated once.
//!
//! The staged atlas is built the way `crates/osg-export/tests` builds one, through
//! `UncheckedGlyphAtlas`: the `WebView` is the only thing that can bake one for real, and a fixture
//! that skipped the descriptor's own validation would be a weaker input than the product's.

use serde_json::{Value, json};

use super::fixtures;
use super::refusal;
use super::text::{EXPORT_TEXT_SCHEMA_VERSION, ExportTextRequest};

#[test]
fn the_staged_payload_becomes_one_atlas_and_one_run_per_cue() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());
    let text: ExportTextRequest = serde_json::from_value(fixtures::export_text_json(atlas_id, 3))
        .expect("the payload the WebView writes must deserialize whole");

    let staged = text
        .resolve(&atlases, 3)
        .expect("three staged runs describe three cues");

    assert_eq!(staged.face().family, fixtures::FAMILY);
    assert_eq!(staged.atlas().content_hash(), fixtures::ATLAS_CONTENT_HASH);
    assert_eq!(staged.runs().len(), 3);
    // Copied, not derived: the cell and the pen are the ones the baker emitted.
    let line = &staged.runs()[0].lines()[0];
    assert_eq!(line.glyphs(), [fixtures::INK_CELL]);
    assert_eq!(line.pen_x_px(), [0.0]);
}

#[test]
fn a_payload_missing_or_gaining_one_field_is_refused_whole() {
    let atlas_id = fixtures::StubAtlases::default().stage(fixtures::default_atlas());
    let complete = fixtures::export_text_json(atlas_id, 1);
    // The discriminating half: the assertions below are worth nothing unless this payload is really
    // accepted, and it is — the same payload, bent once each way.
    serde_json::from_value::<ExportTextRequest>(complete.clone()).expect("the whole payload");

    for field in [
        "schemaVersion",
        "atlasId",
        "atlasContentHash",
        "face",
        "cues",
    ] {
        let mut value = complete.clone();
        value
            .as_object_mut()
            .expect("an object")
            .remove(field)
            .expect("the field was present");
        assert!(
            serde_json::from_value::<ExportTextRequest>(value).is_err(),
            "`{field}` must be required",
        );
    }

    let mut extra = complete;
    extra
        .as_object_mut()
        .expect("an object")
        .insert("sceneRevision".to_owned(), json!("3f2a91cc-812"));
    assert!(
        serde_json::from_value::<ExportTextRequest>(extra).is_err(),
        "an unknown field must fail deserialization rather than be ignored",
    );
}

#[test]
fn a_payload_this_build_does_not_read_is_refused_before_the_registry_is_touched() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());

    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["schemaVersion"] = json!(EXPORT_TEXT_SCHEMA_VERSION + 1);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("a version");
    assert_eq!(refused.code(), "renderTextMismatched");

    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["atlasContentHash"] = json!("../../etc/passwd");
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("an identity");
    assert_eq!(refused.code(), "renderTextMismatched");
}

#[test]
fn a_payload_that_describes_other_cues_is_refused() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());

    for (staged, cues) in [(2_usize, 1_usize), (1, 2), (0, 1)] {
        let text = fixtures::export_text(atlas_id, staged);
        let refused = text
            .resolve(&atlases, cues)
            .expect_err("a run count that is not the cue count");
        assert_eq!(refused.code(), "renderTextMismatched", "{staged} vs {cues}");
    }
}

#[test]
fn a_run_outside_the_compositors_bounds_is_refused_before_it_is_allocated() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());
    let line = json!({
        "glyphs": [fixtures::INK_CELL],
        "penXPx": [0.0],
        "advanceWidthPx": 10.0,
        "baselineYPx": 8.0,
    });

    // One more line than one cue may occupy.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["cues"][0]["lines"] = json!(vec![line.clone(); osg_compositor::MAX_RUN_LINES + 1]);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("too many lines");
    assert_eq!(refused.code(), "renderTextMismatched");

    // A line whose pens do not match its cells, which would be half-drawn rather than refused.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["cues"][0]["lines"][0]["penXPx"] = json!([0.0, 10.0]);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("a mismatched line");
    assert_eq!(refused.code(), "renderTextMismatched");

    // No lines at all is not an empty cue; it is a run nothing could draw.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["cues"][0]["lines"] = json!([]);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("an empty run");
    assert_eq!(refused.code(), "renderTextMismatched");
}

#[test]
fn an_atlas_that_is_not_the_one_the_caller_staged_is_refused_rather_than_drawn() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());

    // A handle nothing answers to: an evicted atlas, or a recycled identifier.
    let evicted = fixtures::export_text(osg_domain::AssetId::new(), 1);
    assert_eq!(
        evicted
            .resolve(&atlases, 1)
            .expect_err("an unknown handle")
            .code(),
        "renderAtlasUnknown",
    );

    // The right handle, the wrong content: exactly the stale-cache case a handle alone would draw.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["atlasContentHash"] = json!("deadbeef");
    assert_eq!(
        deserialize(&value)
            .resolve(&atlases, 1)
            .expect_err("a stale identity")
            .code(),
        "renderAtlasUnknown",
    );

    // And a registry that holds nothing at all.
    assert_eq!(
        fixtures::export_text(atlas_id, 1)
            .resolve(&fixtures::EmptyAtlases, 1)
            .expect_err("an empty registry")
            .code(),
        "renderAtlasUnknown",
    );
}

#[test]
fn a_staged_payload_never_renders_its_own_contents_into_a_debug() {
    let atlas_id = fixtures::StubAtlases::default().stage(fixtures::default_atlas());
    let text = fixtures::export_text(atlas_id, 2);

    let rendered = format!("{text:?}");
    assert!(!rendered.contains(fixtures::FAMILY), "{rendered}");
    assert!(rendered.contains("cues: 2"), "{rendered}");
}

#[test]
fn every_refusal_is_typed_and_carries_no_path() {
    let refusals = [
        refusal::text_not_staged(),
        refusal::atlas_unknown(),
        refusal::text_mismatched(),
        refusal::cancelled(),
        refusal::timed_out(),
        refusal::staging_unavailable(),
        refusal::output_invalid(),
    ];
    for error in &refusals {
        let value = serde_json::to_value(error).expect("a refusal serializes");
        let code = value["code"].as_str().expect("a code");
        let message = value["message"].as_str().expect("a message");
        assert!(
            code.chars().all(|c| c.is_ascii_alphanumeric()),
            "a code is a fixed token: {code}",
        );
        assert!(!message.is_empty(), "{code} must say something");
        for fragment in ["\\", "/", ":\\", "C:", ".mp4", "sha256"] {
            assert!(
                !message.contains(fragment),
                "{code} leaked `{fragment}`: {message}",
            );
        }
    }
    // The five outcomes a user can act on differently keep five different codes.
    let mut codes: Vec<&str> = refusals
        .iter()
        .map(crate::error::CommandError::code)
        .collect();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), refusals.len());
}

#[test]
fn the_status_is_the_shape_the_webview_freezes() {
    let status = super::command::render_runtime_status();
    let value = serde_json::to_value(&status).expect("the status serializes");
    let object = value.as_object().expect("an object");

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "available",
            "maxConcurrentRenders",
            "reason",
            "remotionVersion"
        ],
    );
    assert_eq!(object["maxConcurrentRenders"], json!(1));
    assert_eq!(
        object["remotionVersion"],
        json!(osg_render::REMOTION_VERSION)
    );
    // `renderService.js` refuses a status that says both, or neither.
    let available = object["available"].as_bool().expect("a flag");
    assert_eq!(available, object["reason"].is_null());
    assert_eq!(available, cfg!(windows));
    if !available {
        assert_eq!(object["reason"], json!("runtimePayloadUnavailable"));
    }
}

fn deserialize(value: &Value) -> ExportTextRequest {
    serde_json::from_value(value.clone()).expect("the fixture payload deserializes")
}

// The half that needs the platform: a real adapter, real Media Foundation, and the same function
// the command calls.

#[cfg(windows)]
mod platform {
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
        let mut decoder = open_decoder(exported.path(), DecoderConfig::new(timeline))
            .expect("a decodable export");
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
}
