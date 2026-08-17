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
use support::{SOURCE_DURATION_US, default_face, default_plan, plan, request, request_json};

fn converted(value: serde_json::Value) -> ExportPlan {
    ExportPlan::convert(&plan(value), &default_face()).expect("the fixture request converts")
}

fn refusal(value: serde_json::Value) -> ExportError {
    ExportPlan::convert(&plan(value), &default_face()).expect_err("the request must be refused")
}

/// The same conversion against a source of some other shape, because the output frame is derived
/// from the source aspect and one 16:9 fixture cannot show that.
fn converted_against(value: serde_json::Value, width: u32, height: u32) -> ExportPlan {
    let plan = request(value)
        .validate(width, height, SOURCE_DURATION_US)
        .expect("the request validates against this source");
    ExportPlan::convert(&plan, &default_face()).expect("the request converts")
}

/// A request at `resolution` whose crop region is `crop_width` by `crop_height` percent.
fn cropped(resolution: &str, crop_width: f64, crop_height: f64) -> serde_json::Value {
    let mut value = request_json();
    value["settings"]["resolution"] = json!(resolution);
    value["crop"]["width"] = json!(crop_width);
    value["crop"]["height"] = json!(crop_height);
    value
}

/// The three ratios `PRESET_ASPECT_RATIOS` offers besides Free, in the editor's own order.
const PRESET_RATIOS: [f64; 3] = [16.0 / 9.0, 9.0 / 16.0, 1.0];

/// `calculateCropDimensions` from `src/components/VideoCropControls.js`, verbatim.
///
/// This is what an aspect-ratio button actually does: it solves for the largest centred rectangle of
/// the source whose own ratio is the selected one, and writes that rectangle — and only that
/// rectangle — into the crop.
fn crop_for_button(source_width: u32, source_height: u32, target: f64) -> (f64, f64) {
    let source_aspect = f64::from(source_width) / f64::from(source_height);
    if target > source_aspect {
        (100.0, (source_aspect / target) * 100.0)
    } else {
        ((target / source_aspect) * 100.0, 100.0)
    }
}

fn seconds(numerator: i64, denominator: i64) -> ExactTime {
    ExactTime::new(numerator, denominator).expect("an exact time")
}

// ---- Output format ------------------------------------------------------------------------

#[test]
fn the_crop_region_drives_the_output_width_across_the_whole_resolution_ladder() {
    // The ledger's `aspectRatio` entry, as a table. The heights are the ladder; every width is the
    // source aspect times the crop region's own ratio. The middle row is a crop that does not fill
    // the frame, and 480p is where each row lands on an odd number and is rounded up because the
    // encoder cannot take an odd edge.
    const LADDER: [&str; 7] = ["360p", "480p", "720p", "1080p", "1440p", "4K", "8K"];
    for (crop_width, crop_height, sizes) in [
        (
            100.0,
            100.0,
            [
                (640_u32, 360_u32),
                (854, 480),
                (1_280, 720),
                (1_920, 1_080),
                (2_560, 1_440),
                (3_840, 2_160),
                (7_680, 4_320),
            ],
        ),
        (
            50.0,
            100.0,
            [
                (320, 360),
                (428, 480),
                (640, 720),
                (960, 1_080),
                (1_280, 1_440),
                (1_920, 2_160),
                (3_840, 4_320),
            ],
        ),
        (
            120.0,
            80.0,
            [
                (960, 360),
                (1_280, 480),
                (1_920, 720),
                (2_880, 1_080),
                (3_840, 1_440),
                (5_760, 2_160),
                // 8K would be 11520 wide, past what the scene allocates, and is covered by
                // `a_composition_wider_than_the_compositor_allocates_is_refused_rather_than_clamped`.
                (0, 0),
            ],
        ),
    ] {
        for (resolution, (width, height)) in LADDER.into_iter().zip(sizes) {
            if width == 0 {
                continue;
            }
            let plan = converted(cropped(resolution, crop_width, crop_height));
            assert_eq!(
                (plan.width(), plan.height()),
                (width, height),
                "{resolution} at a {crop_width}x{crop_height} crop composed at {}x{}",
                plan.width(),
                plan.height()
            );
            // One derivation, everywhere: the scene, the encoder configuration and the plan agree,
            // so nothing downstream can compose or encode at a size of its own.
            assert_eq!(
                (plan.scene().width(), plan.scene().height()),
                (width, height)
            );
            assert_eq!(
                (plan.video().width(), plan.video().height()),
                (width, height)
            );
            assert_eq!(
                (
                    plan.encoder_config(true).video().width(),
                    plan.encoder_config(true).video().height()
                ),
                (width, height)
            );
        }
    }
}

#[test]
fn the_output_frame_follows_the_source_shape_as_well_as_the_crop() {
    // Portrait, square and non-square-pixel-shaped sources all reach the same derivation, so the
    // width is not quietly assuming a 16:9 fixture.
    for (source_width, source_height, width) in [
        (1_080_u32, 1_920_u32, 406_u32),
        (720, 720, 720),
        (3_840, 2_160, 1_280),
        (640, 480, 960),
        (854, 480, 1_282),
    ] {
        let plan = converted_against(request_json(), source_width, source_height);
        assert_eq!(
            (plan.width(), plan.height()),
            (width, 720),
            "a {source_width}x{source_height} source at 720p"
        );
    }
}

#[test]
fn the_source_shape_a_request_is_converted_against_is_the_shape_the_source_is_shown_at() {
    // The two files where the coded shape and the shown shape differ, at the sizes the review
    // measured them. `plan_against_source` and the preview's `plan_for_source` both validate
    // against `SourceInfo::display_width`/`display_height` — pixel aspect and rotation applied,
    // which is what the editor's `<video>` element reports — so the first width of each pair is
    // what the product now composes and the second is what it composed while it read the coded
    // size instead.
    let uncropped_1080p = || cropped("1080p", 100.0, 100.0);

    // An anamorphic clip: 720x480 stored, 854x480 shown.
    let shown = converted_against(uncropped_1080p(), 854, 480);
    assert_eq!((shown.width(), shown.height()), (1_922, 1_080));
    let coded = converted_against(uncropped_1080p(), 720, 480);
    assert_eq!((coded.width(), coded.height()), (1_620, 1_080));

    // A portrait phone clip: 1920x1080 stored with a quarter turn, 1080x1920 shown. Reading the
    // coded shape here does not round differently, it composes landscape for a portrait video.
    let shown = converted_against(uncropped_1080p(), 1_080, 1_920);
    assert_eq!((shown.width(), shown.height()), (608, 1_080));
    let coded = converted_against(uncropped_1080p(), 1_920, 1_080);
    assert_eq!((coded.width(), coded.height()), (1_920, 1_080));
}

#[test]
fn the_output_width_comes_from_one_derivation_where_the_shipped_preview_had_a_second() {
    // Not a rounding curiosity: the shipped preview sizes its composition from the same inputs but
    // associates them differently — `sourceAspect * ((cropWidth / 100) / (cropHeight / 100))` rather
    // than `sourceAspect * (cropWidth / cropHeight)` — and floating-point multiplication is not
    // associative. This crop is one where the two forms round apart: the shipped preview composes
    // 682 and the conversion composes 684, so preview and export already disagreed here. The fix is
    // one derivation, which is what this asserts; that second sizing function left the tree with
    // the browser preview it belonged to.
    let plan = converted(cropped("1080p", 10.01, 28.16));
    assert_eq!((plan.width(), plan.height()), (684, 1_080));

    let preview_form = {
        let source_aspect = 1_920.0_f64 / 1_080.0;
        let width = (1_080.0 * (source_aspect * ((10.01 / 100.0) / (28.16 / 100.0)))).round();
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small positive width computed from constants"
        )]
        let width = width as u32;
        if width.is_multiple_of(2) {
            width
        } else {
            width + 1
        }
    };
    assert_eq!(
        preview_form, 682,
        "the divergence this test exists for has changed shape"
    );
}

#[test]
fn an_aspect_ratio_button_is_reproduced_by_the_crop_rectangle_it_wrote() {
    // Why `crop.aspectRatio` is redundant, stated as an assertion rather than as prose. The control
    // never writes the field: it solves for a rectangle whose own ratio is the selected one and
    // writes that. So deriving the output from the rectangle already reproduces the button — and it
    // does so identically from every source shape, which is the whole point of the control.
    for (source_width, source_height) in [
        (1_920_u32, 1_080_u32),
        (1_080, 1_920),
        (720, 720),
        (640, 480),
    ] {
        for (target, expected) in
            PRESET_RATIOS
                .into_iter()
                .zip([(1_920_u32, 1_080_u32), (608, 1_080), (1_080, 1_080)])
        {
            let (crop_width, crop_height) = crop_for_button(source_width, source_height, target);
            let mut value = cropped("1080p", crop_width, crop_height);
            // The field the button is named after stays exactly what the editor leaves it: null.
            value["crop"]["aspectRatio"] = json!(null);
            let plan = converted_against(value, source_width, source_height);
            assert_eq!(
                (plan.width(), plan.height()),
                expected,
                "the {target} button on a {source_width}x{source_height} source"
            );
            // And the frame it produced really does carry the selected ratio, to within the even
            // edge the encoder requires.
            let produced = f64::from(plan.width()) / f64::from(plan.height());
            assert!(
                (produced - target).abs() <= 1.0 / f64::from(plan.height()),
                "the {target} button produced {produced}"
            );
        }
    }
}

#[test]
fn the_persisted_aspect_ratio_changes_no_output_dimension_at_all() {
    // The field is validated, persisted and discarded, and that is correct. Nothing in the editor
    // ever writes it: the aspect-ratio buttons hold their value in component state that is reset to
    // null on every entry into crop mode, and every other writer sets it to null. A value can only
    // arrive from a hand-edited project, where it contradicts the rectangle the user dragged and the
    // preview drew — this crop is half the frame's width, and consulting a stored 16:9 would compose
    // 1920x1080 instead of the 960x1080 the rectangle describes.
    let baseline = converted(cropped("1080p", 50.0, 100.0));
    assert_eq!((baseline.width(), baseline.height()), (960, 1_080));

    for stored in [16.0 / 9.0, 9.0 / 16.0, 1.0, 0.01, 100.0] {
        let mut value = cropped("1080p", 50.0, 100.0);
        value["crop"]["aspectRatio"] = json!(stored);
        let plan = converted_against(value, 1_920, 1_080);
        assert_eq!(
            (plan.width(), plan.height()),
            (960, 1_080),
            "a stored aspectRatio of {stored} moved the output frame"
        );
    }
}

#[test]
fn an_output_size_that_does_not_follow_from_the_crop_is_refused_rather_than_exported() {
    // The derivation is the conversion's, and the size the request was validated to has to agree
    // with it. Nothing produces a disagreement today — both sides run the same expression — so this
    // forges one, which is the only way to prove the guard is load-bearing rather than decorative.
    let mut wider = plan(request_json());
    wider.width += 2;
    assert!(
        matches!(
            ExportPlan::convert(&wider, &default_face()),
            Err(ExportError::OutputSizeNotFromCrop)
        ),
        "a width the crop does not imply must be refused"
    );

    let mut taller = plan(request_json());
    taller.height += 2;
    assert!(matches!(
        ExportPlan::convert(&taller, &default_face()),
        Err(ExportError::OutputSizeNotFromCrop)
    ));
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
