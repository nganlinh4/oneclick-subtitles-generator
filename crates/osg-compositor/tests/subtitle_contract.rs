//! What the compositor refuses before it allocates anything. No GPU is involved, so these run on
//! every machine.

mod common;

use common::{
    BASELINE_PX, FAMILY, INK_CELL, LINE_HEIGHT_PX, SPACE_CELL, WEIGHT, atlas, baked, baked_line,
    baked_run, scene, staged, style, style_spec,
};
use osg_compositor::{
    CompositorError, CueLine, CueRun, Rejection, SubtitleScene, SubtitleStyle, SubtitleStyleSpec,
};
use osg_scene::glyph::{CellAdvanceVerdict, Direction, GlyphAtlasDescriptor};

fn rejection(error: &CompositorError) -> Rejection {
    match error {
        CompositorError::UnsupportedSceneInput { reason } => *reason,
        other => panic!("expected a staged-input refusal, got: {other}"),
    }
}

fn stage(atlas: GlyphAtlasDescriptor, runs: Vec<CueRun>) -> Result<SubtitleScene, CompositorError> {
    SubtitleScene::new(scene(FAMILY, WEIGHT), atlas, style(&style_spec()), runs)
}

#[test]
fn the_fixture_scene_is_accepted() {
    let staged = staged(&style_spec());
    assert_eq!(staged.frame_count(), common::FRAME_COUNT);
    assert_eq!(staged.size().width(), common::WIDTH);
    assert_eq!(staged.size().height(), common::HEIGHT);
    assert_eq!(staged.runs().len(), staged.scene().cues().len());
}

/// The contract exists so preview and export can be *proven* to have drawn the same glyphs. An
/// atlas baked from another family is exactly what it has to catch.
#[test]
fn an_atlas_baked_from_another_family_is_refused() {
    let error = stage(atlas("Other Face", WEIGHT), vec![baked(&[INK_CELL])])
        .expect_err("an atlas from another family must not be staged");
    assert_eq!(rejection(&error), Rejection::AtlasFaceMismatch);
    assert!(
        error.to_string().contains("resolved face"),
        "the refusal must name what disagreed: {error}"
    );
}

#[test]
fn an_atlas_baked_at_another_weight_is_refused() {
    let error = stage(atlas(FAMILY, 700), vec![baked(&[INK_CELL])])
        .expect_err("an atlas at another weight must not be staged");
    assert_eq!(rejection(&error), Rejection::AtlasFaceMismatch);
}

/// The descriptor's `cell_advance_layout` is a `#[must_use]` verdict, not advice. A right-to-left
/// run the baker could **not** resolve into visual order would be drawn backwards if it were placed
/// in the order given, so the compositor refuses it.
#[test]
fn an_atlas_that_refuses_cell_advance_layout_is_refused() {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.base_direction = Direction::Rtl;
    unchecked.glyphs[1].direction = Direction::Rtl;
    unchecked.layout.refusal.direction_needs_bidi = true;
    unchecked.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("still a valid descriptor");
    assert!(!atlas.cell_advance_layout().reproduces());

    let error = stage(atlas, vec![baked(&[INK_CELL])])
        .expect_err("a right-to-left run the baker could not reorder must not be drawn");
    assert_eq!(rejection(&error), Rejection::AtlasLayoutRefused);
}

/// The same right-to-left run, resolved. The baker says the order it emitted is visual, and the
/// compositor's job is to draw that order rather than to second-guess it from cell directions —
/// which still classify every cell right-to-left.
#[test]
fn an_atlas_whose_right_to_left_run_the_baker_reordered_is_staged() {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.base_direction = Direction::Rtl;
    unchecked.glyphs[1].direction = Direction::Rtl;
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("still a valid descriptor");
    assert!(atlas.cell_advance_layout().reproduces());

    let staged = stage(atlas, vec![baked(&[INK_CELL])])
        .expect("a reordered right-to-left run is one the compositor can draw");
    assert_eq!(staged.runs().len(), 1);
}

/// Shaping that crossed cluster boundaries means the emitted positions do not reproduce the run.
#[test]
fn an_atlas_with_a_shaping_residual_is_refused() {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.shaping_residual_px = -1.5;
    unchecked.layout.refusal.shaping_crosses_clusters = true;
    unchecked.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("still a valid descriptor");

    let error = stage(atlas, vec![baked(&[INK_CELL])])
        .expect_err("a run whose ink crossed a cluster boundary must not be drawn from its cells");
    assert_eq!(rejection(&error), Rejection::AtlasLayoutRefused);
}

/// The run is the layout, so a run that could not have come from one is refused before a frame is
/// planned: a pen for every cell, finite positions, and baselines that descend.
#[test]
fn a_run_that_cannot_place_its_glyphs_is_refused() {
    let cases = [
        // A pen position missing, so the compositor would have to invent one.
        CueRun::single_line(CueLine::new(
            vec![INK_CELL, SPACE_CELL],
            vec![0.0],
            10.0,
            BASELINE_PX,
        )),
        // More pens than cells, which is the same disagreement the other way round.
        CueRun::single_line(CueLine::new(
            vec![INK_CELL],
            vec![0.0, 10.0],
            10.0,
            BASELINE_PX,
        )),
        CueRun::single_line(CueLine::new(
            vec![INK_CELL],
            vec![f64::NAN],
            10.0,
            BASELINE_PX,
        )),
        CueRun::single_line(CueLine::new(vec![INK_CELL], vec![0.0], 10.0, f64::INFINITY)),
        // Two lines sharing a baseline: nothing on this side could stack them.
        CueRun::new(vec![
            baked_line(0, &[INK_CELL]),
            CueLine::new(vec![INK_CELL], vec![0.0], 10.0, BASELINE_PX),
        ]),
    ];
    for run in cases {
        let error = stage(atlas(FAMILY, WEIGHT), vec![run])
            .expect_err("a run that cannot place its glyphs is not a staged run");
        assert_eq!(rejection(&error), Rejection::RunGeometry);
    }

    // The same run with its second baseline one line box down is accepted.
    let stacked = CueRun::new(vec![
        baked_line(0, &[INK_CELL]),
        CueLine::new(
            vec![INK_CELL],
            vec![0.0],
            10.0,
            BASELINE_PX + LINE_HEIGHT_PX,
        ),
    ]);
    assert!(stage(atlas(FAMILY, WEIGHT), vec![stacked]).is_ok());
}

#[test]
fn a_run_pointing_past_the_atlas_is_refused() {
    let error = stage(atlas(FAMILY, WEIGHT), vec![baked_run(&[&[INK_CELL, 99]])])
        .expect_err("a run must not index a cell the atlas does not have");
    assert_eq!(rejection(&error), Rejection::RunGlyphIndex);
}

#[test]
fn a_run_with_no_glyphs_is_refused() {
    for run in [CueRun::new(Vec::new()), baked(&[])] {
        let error = stage(atlas(FAMILY, WEIGHT), vec![run])
            .expect_err("a cue with nothing to draw is not a staged run");
        assert_eq!(rejection(&error), Rejection::RunLength);
    }
}

#[test]
fn one_run_per_cue_is_required() {
    for runs in [Vec::new(), vec![baked(&[INK_CELL]), baked(&[SPACE_CELL])]] {
        let error =
            stage(atlas(FAMILY, WEIGHT), runs).expect_err("the run list must match the cue list");
        assert_eq!(rejection(&error), Rejection::RunCount);
    }
}

/// The shipped renderer concatenates the opacity onto the colour as hex alpha, so an `#rrggbbaa`
/// background silently disappears. Here it is a refusal instead: same pixels, findable cause.
#[test]
fn a_background_that_already_carries_alpha_is_refused() {
    let spec = SubtitleStyleSpec {
        background_color: "#11223344".to_owned(),
        ..style_spec()
    };
    let error = SubtitleStyle::resolve(&spec).expect_err("an eight-digit background is refused");
    assert_eq!(rejection(&error), Rejection::StyleBackground);
}

#[test]
fn unreviewed_style_vocabulary_is_refused() {
    let cases: [(SubtitleStyleSpec, Rejection); 4] = [
        (
            SubtitleStyleSpec {
                position: "middle".to_owned(),
                ..style_spec()
            },
            Rejection::StylePosition,
        ),
        (
            SubtitleStyleSpec {
                text_align: "start".to_owned(),
                ..style_spec()
            },
            Rejection::StyleAlign,
        ),
        (
            SubtitleStyleSpec {
                animation: "explode".to_owned(),
                ..style_spec()
            },
            Rejection::StyleAnimation,
        ),
        (
            // The shipped renderer falls through to linear here. Refusing changes no recognised
            // curve's pixels; it only stops an unrecognised one from being invisible.
            SubtitleStyleSpec {
                easing: "cubic-bezier(0.1, 0.2, 0.3, 0.4)".to_owned(),
                ..style_spec()
            },
            Rejection::StyleEasing,
        ),
    ];
    for (spec, expected) in cases {
        let error = SubtitleStyle::resolve(&spec).expect_err("an unreviewed value is refused");
        assert_eq!(rejection(&error), expected);
    }
}

#[test]
fn out_of_range_style_numbers_are_refused() {
    let cases: [(SubtitleStyleSpec, Rejection); 5] = [
        (
            SubtitleStyleSpec {
                font_size: f64::NAN,
                ..style_spec()
            },
            Rejection::StyleFontSize,
        ),
        (
            SubtitleStyleSpec {
                line_spacing: 0.0,
                ..style_spec()
            },
            Rejection::StyleLineSpacing,
        ),
        (
            SubtitleStyleSpec {
                opacity: 1.5,
                ..style_spec()
            },
            Rejection::StyleOpacity,
        ),
        (
            SubtitleStyleSpec {
                fade_in: f64::INFINITY,
                ..style_spec()
            },
            Rejection::StyleTiming,
        ),
        (
            SubtitleStyleSpec {
                custom_y: 140.0,
                ..style_spec()
            },
            Rejection::StyleGeometry,
        ),
    ];
    for (spec, expected) in cases {
        let error = SubtitleStyle::resolve(&spec).expect_err("an out-of-range number is refused");
        assert_eq!(rejection(&error), expected);
    }
}

/// Every refusal must be loggable next to a user's project without leaking their subtitle text,
/// their font choice or their colours.
#[test]
fn refusals_name_the_field_and_never_the_value() {
    let secrets = ["Other Face", "#11223344", "explode", "middle"];
    let errors = [
        stage(atlas("Other Face", WEIGHT), vec![baked(&[INK_CELL])])
            .expect_err("a mismatched face is refused"),
        SubtitleStyle::resolve(&SubtitleStyleSpec {
            background_color: "#11223344".to_owned(),
            ..style_spec()
        })
        .expect_err("an eight-digit background is refused"),
        SubtitleStyle::resolve(&SubtitleStyleSpec {
            animation: "explode".to_owned(),
            ..style_spec()
        })
        .expect_err("an unknown animation is refused"),
        SubtitleStyle::resolve(&SubtitleStyleSpec {
            position: "middle".to_owned(),
            ..style_spec()
        })
        .expect_err("an unknown position is refused"),
    ];
    for error in &errors {
        let message = error.to_string();
        for secret in secrets {
            assert!(
                !message.contains(secret),
                "a refusal must not echo the value it refused: {message}"
            );
        }
    }
}
