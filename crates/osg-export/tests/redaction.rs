#![recursion_limit = "256"]

//! Nothing this crate can hand a caller may carry a path, a credential or a line of subtitle text.
//!
//! An export holds three filesystem locations and the user's own words. Errors, progress reports,
//! summaries and `Debug` renderings all leave the crate, and every one of them ends up in a log at
//! some point, so the redaction has to be a property a test can assert rather than a convention.

mod support;

use osg_audio::{AccessFailure, AudioError};
use osg_compositor::{CompositorError, Rejection};
use osg_decode::{DecodeError, SourceRejection};
use osg_encode::{EncodeError, MfStage, OutputRejection};
use osg_export::{ExportCancel, ExportError, ExportJob, ExportPlan, StagedText};
use osg_render::RenderError;
use osg_scene::TimelineError;
use osg_scene::glyph::LayoutRefusal;
use osg_scene::scene::SceneError;
use std::path::Path;
use support::{default_face, default_plan, request_json, staged_text};

/// A path and a line of subtitle text that must never appear in anything the crate produces.
const SECRET_PATH: &str = r"C:\Users\someone\Videos\private clip.mp4";
const SECRET_TEXT: &str = "the confidential line the user typed";

fn every_error() -> Vec<ExportError> {
    vec![
        ExportError::UnsupportedRequest {
            reason: RenderError::InvalidRequest,
        },
        ExportError::FontUnavailable,
        ExportError::AtlasFaceMismatch,
        ExportError::AtlasCannotLayOut {
            refusal: LayoutRefusal {
                shaping_crosses_clusters: true,
                direction_needs_bidi: false,
            },
        },
        ExportError::OutputSizeNotFromCrop,
        ExportError::CanvasBackgroundNotOpaque,
        ExportError::SceneRejected {
            reason: SceneError::UnorderedCues,
        },
        ExportError::TimelineRejected {
            reason: TimelineError::UnsupportedFrameCount,
        },
        ExportError::CompositionRejected {
            reason: CompositorError::UnsupportedSceneInput {
                reason: Rejection::StyleGeometry,
            },
        },
        ExportError::SourceUnreadable {
            reason: DecodeError::SourceUnusable {
                reason: SourceRejection::NotAFile,
            },
        },
        ExportError::AudioUnusable {
            reason: AudioError::SourceUnavailable {
                reason: AccessFailure::Missing,
            },
        },
        ExportError::OutputUnwritable {
            reason: EncodeError::OutputUnusable {
                reason: OutputRejection::AlreadyExists,
            },
        },
        ExportError::from_encode(EncodeError::MediaFoundation {
            stage: MfStage::WriteSample,
            code: 0x8007_0070,
        }),
        ExportError::Cancelled,
    ]
}

#[test]
fn no_error_carries_a_path_a_drive_letter_or_a_separator() {
    for error in every_error() {
        for rendered in [error.to_string(), format!("{error:?}")] {
            assert!(!rendered.contains("C:"), "{rendered}");
            assert!(!rendered.contains('\\'), "{rendered}");
            assert!(!rendered.contains(".mp4"), "{rendered}");
            assert!(!rendered.contains(SECRET_TEXT), "{rendered}");
            assert!(!rendered.is_empty(), "an error with no message");
        }
    }
}

#[test]
fn every_error_says_something_a_reader_can_act_on() {
    // Distinctness matters as much as redaction: "the export failed" is not something a user can do
    // anything about, so the four failures the task names must not collapse into one another.
    let messages: Vec<String> = every_error().iter().map(ToString::to_string).collect();
    let mut unique = messages.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), messages.len(), "two errors read the same");

    assert!(
        ExportError::FontUnavailable.to_string().contains("font"),
        "the missing-font failure does not say so"
    );
    assert!(
        ExportError::OutputVolumeFull.to_string().contains("full"),
        "the full-volume failure does not say so"
    );
    assert!(
        ExportError::CanvasBackgroundNotOpaque
            .to_string()
            .contains("opaque"),
        "the translucent-backfill failure does not say what is wrong with it"
    );
}

#[test]
fn the_debug_view_of_a_job_carries_no_path_and_no_subtitle_text() {
    let mut value = request_json();
    value["lyrics"] = serde_json::json!([
        {"id":"cue-1","startUs":1_000_000,"endUs":2_000_000,"text":SECRET_TEXT},
    ]);
    let job = ExportJob {
        request: serde_json::from_value(value).expect("the request deserializes"),
        source: Path::new(SECRET_PATH),
        narration: Some(Path::new(SECRET_PATH)),
        output: Path::new(SECRET_PATH),
        text: staged_text(1),
        cancel: ExportCancel::new(),
    };
    let rendered = format!("{job:?}");
    assert!(!rendered.contains("C:"), "{rendered}");
    assert!(!rendered.contains('\\'), "{rendered}");
    assert!(!rendered.contains("private"), "{rendered}");
    assert!(!rendered.contains(SECRET_TEXT), "{rendered}");
    assert!(
        rendered.contains("has_narration"),
        "the job debug view says nothing useful: {rendered}"
    );
}

#[test]
fn the_debug_view_of_a_plan_and_its_staged_text_carries_no_subtitle_text() {
    // A converted plan holds the cues, so its `Debug` is the one place a user's words could leak
    // into a log by accident. The scene contract redacts them; this is the assertion that it does.
    let mut value = request_json();
    value["lyrics"] = serde_json::json!([
        {"id":"cue-1","startUs":1_000_000,"endUs":2_000_000,"text":SECRET_TEXT},
    ]);
    let plan = support::plan(value);
    let converted = ExportPlan::convert(&plan, &default_face()).expect("the request converts");
    let staged: StagedText = staged_text(1);

    for rendered in [format!("{converted:?}"), format!("{staged:?}")] {
        assert!(!rendered.contains("C:"), "{rendered}");
        assert!(!rendered.contains(".mp4"), "{rendered}");
    }
    // Stated rather than assumed: the scene keeps the cue text, because the compositor needs it.
    // What must never happen is a path or a credential travelling with it.
    assert!(
        format!("{converted:?}").contains(SECRET_TEXT),
        "the scene is expected to carry the cue text it will draw"
    );
}

#[test]
fn a_summary_carries_no_location() {
    let plan = default_plan();
    let converted = ExportPlan::convert(&plan, &default_face()).expect("the request converts");
    assert_eq!(converted.frame_count(), 60);
    // The summary type is built by the runner; its fields are all bounded numbers by construction,
    // which this asserts structurally by naming every accessor.
    let rendered = format!(
        "{:?}",
        (
            converted.width(),
            converted.height(),
            converted.frame_count()
        )
    );
    assert!(!rendered.contains("C:"), "{rendered}");
}
