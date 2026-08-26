#![recursion_limit = "256"]

//! The style, crop, font and staged-text half of the conversion.
//!
//! Split from `conversion.rs` at a real seam rather than for length: that file pins the shape of
//! the export — resolution, frame rate, the `trimStart` rebase, `DURATION_SOURCE` and the audio
//! plan — while this one pins the vocabulary the subtitles are drawn with and the agreement between
//! the request, the resolved face and what the `WebView` staged.
//!
//! None of it needs a GPU, a media file or a platform codec: the conversion is pure.

mod support;

use osg_compositor::{CanvasBackground, MAX_RUN_GLYPHS};
use osg_encode::{EncodeError, MfStage};
use osg_export::{EXPORT_CANVAS_GROUND, ExportError, ExportPlan, StagedText, primary_font_family};
use osg_scene::glyph::{CellAdvanceVerdict, Direction, GlyphAtlasDescriptor, MAX_ATLAS_PAGES};
use serde_json::json;
use support::{
    FAMILY, INK_CELL, SOURCE_DURATION_US, SOURCE_HEIGHT, SOURCE_WIDTH, WEIGHT, atlas, default_face,
    default_plan, face, ink_run, plan, request_json, run_of, staged_text, unchecked_atlas,
};

fn converted(value: serde_json::Value) -> ExportPlan {
    ExportPlan::convert(&plan(value), &default_face()).expect("the fixture request converts")
}

fn refusal(value: serde_json::Value) -> ExportError {
    ExportPlan::convert(&plan(value), &default_face()).expect_err("the request must be refused")
}

// ---- Style and crop -----------------------------------------------------------------------

#[test]
fn every_animation_easing_position_and_alignment_converts() {
    for animation in [
        "fade",
        "slide-up",
        "slide-down",
        "slide-left",
        "slide-right",
        "scale",
        "bounce",
        "flip",
        "rotate",
        "typewriter",
    ] {
        let mut value = request_json();
        value["customization"]["animationType"] = json!(animation);
        converted(value);
    }
    for easing in [
        "linear",
        "ease",
        "ease-in",
        "ease-out",
        "ease-in-out",
        "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
    ] {
        let mut value = request_json();
        value["customization"]["animationEasing"] = json!(easing);
        let plan = converted(value);
        assert_eq!(plan.style().easing(), easing);
    }
    for position in ["bottom", "top", "center", "custom"] {
        let mut value = request_json();
        value["customization"]["position"] = json!(position);
        converted(value);
    }
    for align in ["left", "center", "right", "justify"] {
        let mut value = request_json();
        value["customization"]["textAlign"] = json!(align);
        converted(value);
    }
}

#[test]
fn every_border_style_gradient_type_and_text_transform_survives_the_conversion() {
    for border in ["none", "solid", "dashed", "dotted", "double"] {
        let mut value = request_json();
        value["customization"]["borderStyle"] = json!(border);
        converted(value);
    }
    for gradient in ["linear", "radial"] {
        let mut value = request_json();
        value["customization"]["gradientType"] = json!(gradient);
        converted(value);
    }
    for transform in ["none", "uppercase", "lowercase", "capitalize"] {
        let mut value = request_json();
        value["customization"]["textTransform"] = json!(transform);
        converted(value);
    }
    for behavior in ["auto", "manual"] {
        let mut value = request_json();
        value["customization"]["lineBreakBehavior"] = json!(behavior);
        converted(value);
    }
}

#[test]
fn both_canvas_modes_and_both_flips_convert() {
    for mode in ["solid", "blur"] {
        let mut value = request_json();
        value["crop"]["canvasBgMode"] = json!(mode);
        value["crop"]["canvasBgColor"] = json!("#102030");
        value["crop"]["canvasBgBlur"] = json!(12);
        converted(value);
    }
    let mut value = request_json();
    value["crop"]["flipX"] = json!(true);
    value["crop"]["flipY"] = json!(true);
    let crop = converted(value).crop();
    assert!(crop.flip_x() && crop.flip_y());
}

#[test]
fn the_canvas_backfill_an_export_composes_onto_is_always_opaque() {
    // The ledger's open question on `canvasBgColor`, closed in the conversion rather than left to
    // the encoder. An export carries no alpha, so the backfill is decided here: an unset one gets
    // the explicit ground, an opaque one is untouched, and a translucent one is refused.
    let unset = converted(request_json()).crop();
    let CanvasBackground::Solid(ground) = unset.background() else {
        panic!("an unset backfill must resolve to the explicit ground");
    };
    assert_eq!(
        (ground.red, ground.green, ground.blue, ground.alpha),
        (0, 0, 0, 255)
    );
    assert_eq!(EXPORT_CANVAS_GROUND, "#000000");

    let mut chosen = request_json();
    chosen["crop"]["canvasBgMode"] = json!("solid");
    chosen["crop"]["canvasBgColor"] = json!("#102030");
    let CanvasBackground::Solid(colour) = converted(chosen).crop().background() else {
        panic!("a chosen colour stays solid");
    };
    assert_eq!(
        (colour.red, colour.green, colour.blue, colour.alpha),
        (0x10, 0x20, 0x30, 255),
        "an opaque colour is carried across untouched"
    );
}

#[test]
fn a_translucent_canvas_colour_is_refused_rather_than_encoded_over_black() {
    // The colour control the editor offers is `<input type="color">`, which cannot produce alpha at
    // all, so this can only arrive from a hand-edited or third-party project. Exporting it would
    // encode the premultiplied colour over black — visibly darker than it previewed — and say
    // nothing, which is the failure mode this migration exists to remove.
    for colour in ["#10203040", "#1234", "#00000000"] {
        let mut value = request_json();
        value["crop"]["canvasBgMode"] = json!("solid");
        value["crop"]["canvasBgColor"] = json!(colour);
        assert!(
            matches!(refusal(value), ExportError::CanvasBackgroundNotOpaque),
            "{colour} was not refused"
        );
    }

    // A blurred backfill has no colour to be translucent, and is a copy of an opaque source, so it
    // is unaffected even when a stale colour is still stored beside it.
    let mut blurred = request_json();
    blurred["crop"]["canvasBgMode"] = json!("blur");
    blurred["crop"]["canvasBgColor"] = json!("#10203040");
    converted(blurred);
}

#[test]
fn a_style_value_outside_what_the_compositor_draws_is_refused_by_name() {
    // This test used to assert that a margin of -10 and a custom position of -5 were REFUSED. They
    // are not, and should never have been: the persisted schema accepts margins from -10000 and
    // placements from -1000, and the shipped renderer draws them — it emits `left: -5%` and puts the
    // box there. The compositor's own bounds were narrower than the contract it serves, so a project
    // a user could create and see could not be exported at all. The parity gate found it by
    // rendering; the bounds now match the contract, and both values convert.
    let mut negative_margin = request_json();
    negative_margin["customization"]["marginBottom"] = json!(-10.0);
    converted(negative_margin);

    let mut placement = request_json();
    placement["customization"]["position"] = json!("custom");
    placement["customization"]["customPositionX"] = json!(-5.0);
    converted(placement);

    // There is now no placement or margin the contract accepts that the compositor refuses, and that
    // is the point: the extremes of the persisted range convert. Anything past them is stopped by
    // the request validator before conversion is even reached, so a second refusal here would be
    // unreachable code pretending to be a guard.
    for extreme in [-1_000.0, 1_000.0] {
        let mut placement = request_json();
        placement["customization"]["position"] = json!("custom");
        placement["customization"]["customPositionX"] = json!(extreme);
        placement["customization"]["customPositionY"] = json!(extreme);
        converted(placement);
    }
    for extreme in [-10_000.0, 10_000.0] {
        let mut margins = request_json();
        margins["customization"]["marginBottom"] = json!(extreme);
        margins["customization"]["marginTop"] = json!(extreme);
        converted(margins);
    }
}

#[test]
fn an_alpha_bearing_subtitle_background_crosses_export_conversion() {
    for colour in ["#11223344", "#1234"] {
        let mut request = request_json();
        request["customization"]["backgroundColor"] = json!(colour);
        converted(request);
    }
}

// ---- The font -----------------------------------------------------------------------------

#[test]
fn the_staged_face_must_be_the_face_the_request_named() {
    assert_eq!(primary_font_family("'Inter', sans-serif"), Some(FAMILY));

    let other = ExportPlan::convert(&default_plan(), &face("Georgia", WEIGHT))
        .expect_err("a different family must be refused");
    assert!(matches!(other, ExportError::FontUnavailable));

    let mut generic = request_json();
    generic["customization"]["fontFamily"] = json!("sans-serif");
    assert!(matches!(refusal(generic), ExportError::FontUnavailable));
}

#[test]
fn a_resolved_weight_that_differs_from_the_request_is_carried_rather_than_refused() {
    // `fontWeight` is resolved by `fontIdentity`, which may legitimately land on another weight when
    // the face has no instance for the one that was asked for. The scene carries what was resolved.
    let plan = ExportPlan::convert(&default_plan(), &face(FAMILY, 400))
        .expect("a resolved weight travels in the scene face");
    assert_eq!(plan.scene().face().weight, 400);
}

// ---- Staging ------------------------------------------------------------------------------

#[test]
fn the_staged_atlas_must_belong_to_the_scene_and_support_cell_advance_layout() {
    let plan = converted(request_json());

    let mismatched = StagedText::single(default_face(), atlas("Georgia", WEIGHT), vec![ink_run()]);
    assert!(matches!(
        plan.compose(mismatched)
            .expect_err("a foreign atlas is refused"),
        ExportError::AtlasFaceMismatch
    ));

    // The verdict travels on the wire now, and the descriptor refuses one whose evidence and
    // conclusion disagree, so a measured residual has to arrive with the refusal it implies.
    let mut residual = unchecked_atlas(FAMILY, WEIGHT);
    residual.metrics.shaping_residual_px = 0.5;
    residual.layout.refusal.shaping_crosses_clusters = true;
    residual.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    let refused = StagedText::single(
        default_face(),
        GlyphAtlasDescriptor::try_from(residual)
            .expect("a measured residual is a legal descriptor"),
        vec![ink_run()],
    );
    match plan
        .compose(refused)
        .expect_err("an atlas whose advances do not sum to the run is refused")
    {
        ExportError::AtlasCannotLayOut { refusal } => {
            assert!(refusal.shaping_crosses_clusters);
            assert!(!refusal.direction_needs_bidi);
        }
        other => panic!("unexpected error: {other}"),
    }

    // Bidi is the baker's word rather than something this side re-derives from cell directions, so
    // the refusal is carried explicitly: a right-to-left run whose baker cleared the flag is one it
    // already reordered into visual order.
    let mut rtl = unchecked_atlas(FAMILY, WEIGHT);
    rtl.metrics.base_direction = Direction::Rtl;
    rtl.glyphs[1].direction = Direction::Rtl;
    rtl.layout.refusal.direction_needs_bidi = true;
    rtl.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    let refused = StagedText::single(
        default_face(),
        GlyphAtlasDescriptor::try_from(rtl).expect("a right-to-left run is a legal descriptor"),
        vec![ink_run()],
    );
    match plan
        .compose(refused)
        .expect_err("a right-to-left run needs bidi the compositor does not do")
    {
        ExportError::AtlasCannotLayOut { refusal } => assert!(refusal.direction_needs_bidi),
        other => panic!("unexpected error: {other}"),
    }
}

#[test]
fn the_staged_runs_must_match_the_cues_and_the_atlas() {
    let plan = converted(request_json());
    plan.compose(staged_text(1)).expect("one run for one cue");

    assert!(matches!(
        plan.compose(staged_text(2))
            .expect_err("two runs for one cue is refused"),
        ExportError::CompositionRejected { .. }
    ));
    assert!(matches!(
        plan.compose(staged_text(0))
            .expect_err("no runs for one cue is refused"),
        ExportError::CompositionRejected { .. }
    ));

    let outside = StagedText::single(
        default_face(),
        atlas(FAMILY, WEIGHT),
        vec![run_of(vec![99])],
    );
    assert!(matches!(
        plan.compose(outside)
            .expect_err("a run pointing outside the atlas is refused"),
        ExportError::CompositionRejected { .. }
    ));

    let too_long = StagedText::single(
        default_face(),
        atlas(FAMILY, WEIGHT),
        vec![run_of(vec![INK_CELL; MAX_RUN_GLYPHS + 1])],
    );
    assert!(matches!(
        plan.compose(too_long)
            .expect_err("a run longer than the renderer accepts is refused"),
        ExportError::CompositionRejected { .. }
    ));
}

/// A document whose distinct clusters do not fit one atlas is staged as several pages, and the page
/// each cue was baked into travels with it.
#[test]
fn a_document_staged_as_several_pages_composes_with_each_cue_on_its_own_page() {
    let plan = converted(request_json());

    let scene = plan
        .compose(StagedText::new(
            default_face(),
            vec![atlas(FAMILY, WEIGHT), atlas(FAMILY, WEIGHT)],
            vec![1],
            vec![ink_run()],
        ))
        .expect("two pages with the one cue on the second is a document that composes");
    assert_eq!(scene.pages().len(), 2);
    assert_eq!(scene.page_of_cue(0), Some(1));

    // And the page lists no document can be: none at all, one cue naming a page that was not
    // staged, and more pages than the renderer draws from.
    let refusals = [
        (Vec::new(), vec![0]),
        (vec![atlas(FAMILY, WEIGHT)], vec![1]),
        (
            (0..=MAX_ATLAS_PAGES)
                .map(|_| atlas(FAMILY, WEIGHT))
                .collect(),
            vec![0],
        ),
    ];
    for (pages, page_of_cue) in refusals {
        let staged = StagedText::new(default_face(), pages, page_of_cue, vec![ink_run()]);
        assert!(
            matches!(
                plan.compose(staged).expect_err("the page list is refused"),
                ExportError::CompositionRejected { .. }
            ),
            "a page list no cue could draw from is not a document"
        );
    }
}

// ---- Refusals the request itself carries --------------------------------------------------

#[test]
fn a_request_the_contract_refuses_never_reaches_the_conversion() {
    let request = support::request(request_json());
    assert!(
        request.validate(SOURCE_WIDTH, SOURCE_HEIGHT, 0).is_err(),
        "a zero-length source has nothing to export"
    );

    let mut inverted = request_json();
    inverted["settings"]["trimStartUs"] = json!(5_000_000);
    inverted["settings"]["trimEndUs"] = json!(4_000_000);
    assert!(
        support::request(inverted)
            .validate(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_DURATION_US)
            .is_err(),
        "an inverted trim is refused"
    );
}

#[test]
fn a_full_volume_is_reported_as_a_full_volume_rather_than_a_platform_status_code() {
    for code in [0x8007_0070_u32, 0x8007_0027, 0x8003_0070] {
        let error = ExportError::from_encode(EncodeError::MediaFoundation {
            stage: MfStage::WriteSample,
            code,
        });
        assert!(
            matches!(error, ExportError::OutputVolumeFull),
            "0x{code:08x} was reported as {error}"
        );
    }
    let other = ExportError::from_encode(EncodeError::MediaFoundation {
        stage: MfStage::WriteSample,
        code: 0x8000_4005,
    });
    assert!(matches!(other, ExportError::OutputUnwritable { .. }));
}

#[test]
fn every_shipped_preset_identity_crosses_the_conversion() {
    const PRESETS: [&str; 30] = [
        "default",
        "modern",
        "classic",
        "neon",
        "minimal",
        "gaming",
        "cinematic",
        "gradient",
        "retro",
        "elegant",
        "cyberpunk",
        "vintage",
        "comic",
        "horror",
        "luxury",
        "kawaii",
        "grunge",
        "corporate",
        "anime",
        "vaporwave",
        "steampunk",
        "noir",
        "pastel",
        "bold",
        "sketch",
        "glitch",
        "royal",
        "sunset",
        "ocean",
        "forest",
    ];
    for preset in PRESETS.into_iter().chain(["custom_1750000000000"]) {
        let mut value = request_json();
        value["customization"]["preset"] = json!(preset);
        converted(value);
    }
}
