#![recursion_limit = "256"]

//! The shape of the export: resolution, frame rate, the trim rebase and the audio plan.
//!
//! This is the half of the conversion suite that guards the two parity decisions. Both deliberate
//! visible changes are pinned by an assertion that would fail if they regressed, and every refusal
//! names the field it refused rather than failing generically. The vocabulary the subtitles are
//! drawn with — style, crop, font and the staged text — is pinned in `staging.rs`.
//!
//! None of it needs a GPU, a media file or a platform codec: the conversion is pure.

mod support;

use osg_audio::Volume;
use osg_export::{AUDIO_CHANNELS, AUDIO_SAMPLE_RATE_HZ, ExportError, ExportPlan};
use osg_scene::ExactTime;
use osg_scene::scene::SceneError;
use serde_json::json;
use support::{default_face, default_plan, plan, request_json};

fn converted(value: serde_json::Value) -> ExportPlan {
    ExportPlan::convert(&plan(value), &default_face()).expect("the fixture request converts")
}

fn refusal(value: serde_json::Value) -> ExportError {
    ExportPlan::convert(&plan(value), &default_face()).expect_err("the request must be refused")
}

fn seconds(numerator: i64, denominator: i64) -> ExactTime {
    ExactTime::new(numerator, denominator).expect("an exact time")
}

// ---- Output format ------------------------------------------------------------------------

#[test]
fn every_resolution_drives_the_composition_size() {
    // The `resolution` field's whole job. The heights are the ladder; the widths come from the
    // source aspect times the crop ratio, and 480p is the one that lands on an odd number and has
    // to be rounded up because the encoder cannot take an odd edge.
    for (resolution, width, height) in [
        ("360p", 640_u32, 360_u32),
        ("480p", 854, 480),
        ("720p", 1_280, 720),
        ("1080p", 1_920, 1_080),
        ("1440p", 2_560, 1_440),
        ("4K", 3_840, 2_160),
        ("8K", 7_680, 4_320),
    ] {
        let mut value = request_json();
        value["settings"]["resolution"] = json!(resolution);
        let plan = converted(value);
        assert_eq!(
            (plan.width(), plan.height()),
            (width, height),
            "{resolution} composed at {}x{}",
            plan.width(),
            plan.height()
        );
        // One size, everywhere: the scene, the encoder configuration and the plan agree.
        assert_eq!(
            (plan.scene().width(), plan.scene().height()),
            (width, height)
        );
        assert_eq!(
            (plan.video().width(), plan.video().height()),
            (width, height)
        );
    }
}

#[test]
fn a_composition_wider_than_the_compositor_allocates_is_refused_rather_than_clamped() {
    // The contract accepts a width up to 15360; the scene stops at 7680. A crop twice as wide as it
    // is tall, at 8K, lands between the two, and the refusal has to come from the scene rather than
    // from a silent clamp that would export a differently framed file.
    let mut value = request_json();
    value["settings"]["resolution"] = json!("8K");
    value["crop"]["width"] = json!(200);
    assert!(
        matches!(
            refusal(value),
            ExportError::SceneRejected {
                reason: SceneError::UnsupportedDimensions
            }
        ),
        "an oversized composition must be refused by the scene contract"
    );
}

#[test]
fn every_frame_rate_becomes_an_exact_grid() {
    for (rate, frames) in [
        (24_u32, 48_u32),
        (25, 50),
        (30, 60),
        (50, 100),
        (60, 120),
        (120, 240),
    ] {
        let mut value = request_json();
        value["settings"]["frameRate"] = json!(rate);
        let plan = converted(value);
        assert_eq!(plan.frame_count(), frames, "{rate}fps");
        assert_eq!(plan.video().fps_numerator(), rate);
        assert_eq!(plan.video().fps_denominator(), 1);
        // Exact, not accumulated: the last frame is one frame short of the two-second end.
        let last = plan
            .scene()
            .timeline()
            .frame_time(frames - 1)
            .expect("the last frame");
        assert_eq!(last, seconds(i64::from(frames - 1), i64::from(rate)));
        assert_eq!(plan.duration().expect("a duration"), seconds(2, 1));
    }
}

// ---- trimStart: the rebase ----------------------------------------------------------------

#[test]
fn a_cue_at_absolute_t_lands_at_t_minus_trim_start() {
    // The parity ledger's `trimStart` decision, stated as an assertion. The shipped renderer leaves
    // this cue at 4.5s in a file whose first frame is absolute 3.0s, which puts it 3 seconds late.
    let mut value = request_json();
    value["settings"]["trimStartUs"] = json!(3_000_000);
    value["settings"]["trimEndUs"] = json!(8_000_000);
    value["lyrics"] = json!([{"id":"cue-1","startUs":4_500_000,"endUs":5_000_000,"text":"A"}]);
    let plan = converted(value);

    let cue = &plan.scene().cues()[0];
    assert_eq!(cue.start, seconds(3, 2), "4.5s minus 3.0s is 1.5s");
    assert_eq!(cue.end, seconds(2, 1), "5.0s minus 3.0s is 2.0s");

    // The scene grid starts at zero; the decoder's grid starts at the trim point. Both are the same
    // rate and the same length, so one frame index means one instant in each.
    assert_eq!(
        plan.scene()
            .timeline()
            .frame_time(0)
            .expect("the first scene frame"),
        ExactTime::ZERO
    );
    assert_eq!(
        plan.source_timeline()
            .frame_time(0)
            .expect("the first source frame"),
        seconds(3, 1)
    );
    assert_eq!(
        plan.source_timeline().frame_count(),
        plan.scene().timeline().frame_count()
    );
}

#[test]
fn a_cue_that_ends_before_the_trim_point_is_kept_at_a_negative_time() {
    // Dropping it would be the easy thing and the wrong thing: the fade-out window legitimately
    // lets a cue that ended just before the trim point linger into the first frames, which is what
    // the editor shows at that instant. Keeping it also keeps every cue's index stable.
    let mut value = request_json();
    value["settings"]["trimStartUs"] = json!(3_000_000);
    value["settings"]["trimEndUs"] = json!(8_000_000);
    value["lyrics"] = json!([
        {"id":"before","startUs":500_000,"endUs":1_000_000,"text":"before"},
        {"id":"inside","startUs":4_500_000,"endUs":5_000_000,"text":"inside"},
    ]);
    let plan = converted(value);
    let cues = plan.scene().cues();
    assert_eq!(cues.len(), 2, "no cue is dropped");
    assert_eq!(cues[0].start, seconds(-5, 2));
    assert_eq!(cues[0].end, seconds(-2, 1));
    assert_eq!(cues[1].start, seconds(3, 2));
}

#[test]
fn a_zero_trim_leaves_every_cue_where_it_was() {
    let plan = default_plan();
    let converted = ExportPlan::convert(&plan, &default_face()).expect("the fixture converts");
    let cue = &converted.scene().cues()[0];
    assert_eq!(cue.start, seconds(1, 1));
    assert_eq!(cue.end, seconds(2, 1));
    assert_eq!(
        converted
            .source_timeline()
            .frame_time(0)
            .expect("the first source frame"),
        ExactTime::ZERO
    );
}

#[test]
fn an_out_of_order_cue_list_is_refused_rather_than_sorted() {
    // Cue selection takes the first match, so sorting a list the editor sent unsorted would change
    // which cue is drawn. The refusal is the scene contract's, carried through unchanged.
    let mut value = request_json();
    value["lyrics"] = json!([
        {"id":"late","startUs":5_000_000,"endUs":6_000_000,"text":"late"},
        {"id":"early","startUs":1_000_000,"endUs":2_000_000,"text":"early"},
    ]);
    assert!(
        matches!(
            refusal(value),
            ExportError::SceneRejected {
                reason: SceneError::UnorderedCues
            }
        ),
        "an unsorted cue list must be refused"
    );
}

// ---- DURATION_SOURCE ----------------------------------------------------------------------

#[test]
fn the_duration_comes_from_the_timeline_and_not_from_a_frame_count() {
    // The parity ledger's `DURATION_SOURCE` decision. A trim that is not a whole number of frames
    // rounds up, so the last frame of the timeline is inside the trimmed span; nothing downstream
    // may shorten it, which is why the same number appears in all four places below.
    let mut value = request_json();
    value["settings"]["trimEndUs"] = json!(2_500_001);
    let plan = converted(value);

    assert_eq!(plan.frame_count(), 76, "ceil(2.500001s * 30fps) is 76");
    assert_eq!(plan.scene().timeline().frame_count(), 76);
    assert_eq!(plan.source_timeline().frame_count(), 76);
    assert_eq!(plan.video().frame_count(), 76);
    assert_eq!(plan.encoder_config(false).video().frame_count(), 76);
}

#[test]
fn trim_end_bounds_the_frame_range_without_a_rebase() {
    for (start_us, end_us, frames) in [
        (0_u64, 10_000_000_u64, 300_u32),
        (0, 1_000_000, 30),
        (2_000_000, 10_000_000, 240),
        (2_000_000, 4_000_000, 60),
    ] {
        let mut value = request_json();
        value["settings"]["trimStartUs"] = json!(start_us);
        value["settings"]["trimEndUs"] = json!(end_us);
        let plan = converted(value);
        assert_eq!(plan.frame_count(), frames, "{start_us}..{end_us}");
        // No rebase is needed at the end: the last frame is the one before the trim end.
        let last = plan
            .source_timeline()
            .frame_time(frames - 1)
            .expect("the last source frame");
        assert_eq!(
            last.cmp_exact(seconds(
                i64::try_from(end_us).expect("microseconds"),
                1_000_000
            )),
            core::cmp::Ordering::Less
        );
    }
}

#[test]
fn an_absent_trim_end_runs_to_the_end_of_the_source() {
    let mut value = request_json();
    value["settings"]["trimEndUs"] = json!(null);
    let plan = converted(value);
    assert_eq!(plan.frame_count(), 300, "ten seconds at 30fps");
}

// ---- Audio --------------------------------------------------------------------------------

#[test]
fn the_two_volumes_map_to_the_shipped_linear_gain() {
    for (original, narration) in [(100_u8, 100_u8), (50, 0), (0, 80), (0, 0), (1, 99)] {
        let mut value = request_json();
        value["settings"]["originalAudioVolume"] = json!(original);
        value["settings"]["narrationVolume"] = json!(narration);
        let plan = converted(value);
        let audio = plan.audio();
        assert_eq!(
            audio.original(),
            Volume::from_percent(u32::from(original)).expect("a percentage")
        );
        assert_eq!(
            audio.narration(),
            Volume::from_percent(u32::from(narration)).expect("a percentage")
        );
        assert_eq!(audio.original().is_muted(), original == 0);
        assert_eq!(audio.narration().is_muted(), narration == 0);
    }
}

#[test]
fn both_audio_sources_are_read_through_the_trim_window() {
    // The narration is generated from the same absolute cue times the subtitles carry, so it moves
    // with them. Leaving it alone would put a sentence's audio and its subtitle in different places.
    let mut value = request_json();
    value["settings"]["trimStartUs"] = json!(3_000_000);
    value["settings"]["trimEndUs"] = json!(8_000_000);
    let audio = converted(value).audio();
    assert_eq!(audio.window().start(), seconds(3, 1));
    assert_eq!(audio.window().end(), Some(seconds(8, 1)));
    assert_eq!(audio.format().sample_rate(), AUDIO_SAMPLE_RATE_HZ);
    assert_eq!(audio.format().channels(), AUDIO_CHANNELS);
}

#[test]
fn audio_sample_boundaries_agree_with_the_video_grid() {
    let plan = converted(request_json());
    for (index, sample) in [(0_u32, 0_u64), (1, 1_600), (30, 48_000), (59, 94_400)] {
        assert_eq!(
            plan.audio_frame_at(index).expect("a sample index"),
            sample,
            "output frame {index}"
        );
    }
    assert!(plan.audio_frame_at(plan.frame_count()).is_err());
}

#[test]
fn an_export_with_audio_declares_an_audio_stream_and_one_without_does_not() {
    let plan = converted(request_json());
    assert!(plan.encoder_config(true).audio().is_some());
    assert!(plan.encoder_config(false).audio().is_none());
}
