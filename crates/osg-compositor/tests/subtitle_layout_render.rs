//! Composing the layout the baker emitted, against a real adapter.
//!
//! Every test here is written to fail if the compositor ever starts deriving layout again. The
//! fixtures deliberately carry pen positions that are **not** the accumulation of the cell
//! advances, baselines that a line-spacing multiplier would move, and lines whose order and widths
//! would place differently if alignment were recomputed — so "it still draws" is not enough to pass
//! any of them.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.

mod common;

use common::frames::compositor;
use common::ink::{inked, left_inked_column_in_rows, right_inked_column_in_rows, top_inked_row};
use common::{
    BASELINE_PX, FAMILY, HOLD_FRAME, INK_CELL, LINE_HEIGHT_PX, SPACE_CELL, WEIGHT, atlas,
    baked_line, baked_run, scene, staged_with_run, style, style_spec,
};
use osg_compositor::{Compositor, CueLine, CueRun, Frame, SubtitleScene, SubtitleStyleSpec};
use osg_scene::glyph::{Direction, GlyphAtlasDescriptor};

/// One atlas pixel is this many composition pixels: the fixture bakes at 24px and the style asks
/// for 144 reference pixels, which is 48 at this composition's height.
const SCALE: f64 = 2.0;

/// The style the layout tests use: left-aligned, no background, so every inked pixel is a glyph and
/// nothing re-centres a line whose width changed.
fn layout_spec() -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        text_align: "left".to_owned(),
        background_opacity: 0.0,
        ..style_spec()
    }
}

/// A line with pens the caller chose, which is the point: they are not derived from anything.
fn line_at(number: u32, cells: &[u32], pens: &[f64], advance_width_px: f64) -> CueLine {
    CueLine::new(
        cells.to_vec(),
        pens.to_vec(),
        advance_width_px,
        f64::from(number).mul_add(LINE_HEIGHT_PX, BASELINE_PX),
    )
}

fn render(scene: &SubtitleScene, compositor: &Compositor, frame_index: u32) -> Frame {
    compositor
        .render_scene(scene, frame_index)
        .expect("composition succeeds")
}

/// An atlas-pixel distance in composition pixels.
///
/// Every distance these fixtures use is an exact whole number of output pixels at this scale, which
/// is what lets the assertions be equalities rather than tolerances — the conversion asserts it
/// rather than assuming it.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "asserted to be an exact non-negative whole number on the line above"
)]
fn composition_px(atlas_px: f64) -> u32 {
    let scaled = atlas_px * SCALE;
    assert!(
        scaled >= 0.0 && scaled.fract() == 0.0,
        "a fixture distance must land on a whole output pixel, got {scaled}"
    );
    scaled as u32
}

/// The discriminating case for `letterSpacing`: a pen that is nothing like the accumulation.
///
/// Two runs draw the same two cells; only the second cell's pen differs. Accumulating advances
/// would put it at the same place in both — the atlas advance is 4 for the blank cell whatever the
/// layout says — so the two frames would be identical and this test would fail.
#[test]
fn a_glyph_lands_where_the_pen_says_and_not_where_accumulation_would_put_it() {
    let compositor = compositor!();
    let spec = layout_spec();
    // What accumulation would produce: the blank cell's own advance, 4 atlas pixels.
    let accumulated = staged_with_run(
        &spec,
        CueRun::single_line(line_at(0, &[SPACE_CELL, INK_CELL], &[0.0, 4.0], 14.0)),
    );
    // What a letter-spaced layout produces instead: the same cells, a pen the compositor could not
    // have derived.
    let spaced = staged_with_run(
        &spec,
        CueRun::single_line(line_at(0, &[SPACE_CELL, INK_CELL], &[0.0, 30.0], 40.0)),
    );

    let accumulated = render(&accumulated, &compositor, HOLD_FRAME);
    let spaced = render(&spaced, &compositor, HOLD_FRAME);

    let rows = 0..spaced.height();
    let from = left_inked_column_in_rows(&accumulated, rows.clone())
        .expect("the accumulated run drew its glyph");
    let to = left_inked_column_in_rows(&spaced, rows).expect("the spaced run drew its glyph");

    assert_eq!(
        to - from,
        composition_px(30.0 - 4.0),
        "the glyph must move by exactly the pen difference, not by the advance difference"
    );
    assert_eq!(
        inked(&accumulated),
        inked(&spaced),
        "the same cells are drawn either way, so only their position may differ"
    );
}

/// The discriminating case for `lineHeight`: the second line's baseline comes from the layout, and
/// nothing multiplies it again.
///
/// Before the compositor read baselines it multiplied the atlas line height by the style's line
/// spacing, so doubling the spacing doubled the gap. Now the spacing cannot reach the pixels at
/// all, and the gap is exactly the line box the baker declared.
#[test]
fn line_spacing_no_longer_reaches_the_pixels_and_baselines_come_from_the_layout() {
    let compositor = compositor!();
    let spaced = |line_spacing: f64| SubtitleStyleSpec {
        line_spacing,
        ..layout_spec()
    };
    let first_only =
        |spec: &SubtitleStyleSpec| staged_with_run(spec, baked_run(&[&[INK_CELL], &[SPACE_CELL]]));
    let second_only =
        |spec: &SubtitleStyleSpec| staged_with_run(spec, baked_run(&[&[SPACE_CELL], &[INK_CELL]]));

    let single = spaced(1.0);
    let double = spaced(2.0);
    let top_of = |scene: &SubtitleScene| {
        top_inked_row(&render(scene, &compositor, HOLD_FRAME)).expect("the line drew something")
    };

    let line_box = composition_px(LINE_HEIGHT_PX);
    assert_eq!(
        top_of(&second_only(&single)) - top_of(&first_only(&single)),
        line_box,
        "the second line must sit exactly one emitted line box below the first"
    );
    assert_eq!(
        top_of(&second_only(&double)) - top_of(&first_only(&double)),
        line_box,
        "doubling the style's line spacing must not move it: the baker owns line height"
    );

    // The vertical twin of the pen test: a baseline the compositor could not have derived — the
    // face's ascent is 8 — must place the glyph exactly where it says.
    // Both runs are one line tall, so the box is the same and only the baseline moves.
    let at_the_ascent = staged_with_run(&single, CueRun::single_line(baked_line(0, &[INK_CELL])));
    let moved = staged_with_run(
        &single,
        CueRun::single_line(CueLine::new(
            vec![INK_CELL],
            vec![0.0],
            10.0,
            BASELINE_PX + 12.0,
        )),
    );
    assert_eq!(
        top_of(&moved) - top_of(&at_the_ascent),
        composition_px(12.0),
        "the baseline is read, not derived from the line number"
    );

    // Stated as strongly as it can be: with the baker owning line height, the style value cannot
    // change a single byte of the frame.
    assert_eq!(
        render(
            &staged_with_run(&single, baked_run(&[&[INK_CELL], &[INK_CELL]])),
            &compositor,
            HOLD_FRAME
        )
        .pixels(),
        render(
            &staged_with_run(&double, baked_run(&[&[INK_CELL], &[INK_CELL]])),
            &compositor,
            HOLD_FRAME
        )
        .pixels(),
        "line spacing is the baker's input, not the compositor's multiplier"
    );
}

/// Alignment is where a line box sits inside the subtitle box, measured by the emitted advance.
#[test]
fn each_alignment_places_the_line_box_by_its_emitted_advance() {
    let compositor = compositor!();
    // A short line over a long one, so a line box that was measured wrongly lands visibly wrong.
    let run = || baked_run(&[&[INK_CELL], &[INK_CELL, INK_CELL]]);
    let rows = |frame: &Frame| {
        let split = top_inked_row(frame).expect("the first line drew something")
            + composition_px(LINE_HEIGHT_PX);
        (0..split, split..frame.height())
    };

    for (align, expected) in [
        ("left", core::cmp::Ordering::Equal),
        ("center", core::cmp::Ordering::Greater),
        ("right", core::cmp::Ordering::Greater),
    ] {
        let scene = staged_with_run(
            &SubtitleStyleSpec {
                text_align: align.to_owned(),
                ..layout_spec()
            },
            run(),
        );
        let frame = render(&scene, &compositor, HOLD_FRAME);
        let (top, bottom) = rows(&frame);
        let short = left_inked_column_in_rows(&frame, top).expect("the short line drew something");
        let long = left_inked_column_in_rows(&frame, bottom).expect("the long line drew something");
        assert_eq!(
            short.cmp(&long),
            expected,
            "{align}: the short line starts at {short} and the long line at {long}"
        );
    }

    // Right alignment also has to end them together, which centring would not.
    let scene = staged_with_run(
        &SubtitleStyleSpec {
            text_align: "right".to_owned(),
            ..layout_spec()
        },
        run(),
    );
    let frame = render(&scene, &compositor, HOLD_FRAME);
    let (top, bottom) = rows(&frame);
    assert_eq!(
        right_inked_column_in_rows(&frame, top),
        right_inked_column_in_rows(&frame, bottom),
        "right-aligned lines must share a trailing edge"
    );
}

/// Justification widens the gaps in the layout, and the compositor computes none of it: a justified
/// run and a left-aligned run with the same pens are the same picture.
#[test]
fn justification_arrives_in_the_pen_positions_rather_than_being_computed() {
    let compositor = compositor!();
    // The gap between the two cells is 30 atlas pixels where the advance alone would give 10 — a
    // line the baker stretched to its wrap width.
    let stretched = || CueRun::single_line(line_at(0, &[INK_CELL, INK_CELL], &[0.0, 30.0], 40.0));
    let natural = || CueRun::single_line(line_at(0, &[INK_CELL, INK_CELL], &[0.0, 10.0], 20.0));

    let justified = staged_with_run(
        &SubtitleStyleSpec {
            text_align: "justify".to_owned(),
            ..layout_spec()
        },
        stretched(),
    );
    let left = staged_with_run(&layout_spec(), stretched());
    let unjustified = staged_with_run(
        &SubtitleStyleSpec {
            text_align: "justify".to_owned(),
            ..layout_spec()
        },
        natural(),
    );

    assert_eq!(
        render(&justified, &compositor, HOLD_FRAME).pixels(),
        render(&left, &compositor, HOLD_FRAME).pixels(),
        "justify places the line box like left, because the stretch is already in the pens"
    );
    assert_ne!(
        render(&justified, &compositor, HOLD_FRAME).pixels(),
        render(&unjustified, &compositor, HOLD_FRAME).pixels(),
        "a stretched line must not draw like an unstretched one"
    );

    // The line CSS does not justify — the last of the paragraph — is narrower than the block, so a
    // compositor that placed a justified line box by anything but the leading edge would move it.
    let paragraph = || {
        CueRun::new(vec![
            line_at(0, &[INK_CELL, INK_CELL], &[0.0, 30.0], 40.0),
            line_at(1, &[INK_CELL], &[0.0], 10.0),
        ])
    };
    let aligned = |align: &str| {
        let scene = staged_with_run(
            &SubtitleStyleSpec {
                text_align: align.to_owned(),
                ..layout_spec()
            },
            paragraph(),
        );
        let frame = render(&scene, &compositor, HOLD_FRAME);
        let split = top_inked_row(&frame).expect("the first line drew something")
            + composition_px(LINE_HEIGHT_PX);
        (
            left_inked_column_in_rows(&frame, 0..split).expect("the stretched line"),
            left_inked_column_in_rows(&frame, split..frame.height()).expect("the last line"),
        )
    };
    let (stretched_left, last_left) = aligned("justify");
    assert_eq!(
        stretched_left, last_left,
        "an unjustified last line still starts at the leading edge, as CSS leaves it"
    );
    let (stretched_left, last_left) = aligned("center");
    assert_ne!(
        stretched_left, last_left,
        "centring the same run does move it, so the assertion above is not vacuous"
    );
}

/// Cells are drawn in the order given, each at its own pen — not accumulated in list order.
///
/// The two runs list the same cells in opposite orders and give each cell the same pen either way.
/// A compositor that accumulated advances would put the ink at 0 in one and at 4 in the other.
#[test]
fn a_run_draws_the_cells_in_the_order_given_at_the_positions_given() {
    let compositor = compositor!();
    let spec = layout_spec();
    let forwards = staged_with_run(
        &spec,
        CueRun::single_line(line_at(0, &[SPACE_CELL, INK_CELL], &[0.0, 4.0], 14.0)),
    );
    let reversed = staged_with_run(
        &spec,
        CueRun::single_line(line_at(0, &[INK_CELL, SPACE_CELL], &[4.0, 0.0], 14.0)),
    );

    assert_eq!(
        render(&forwards, &compositor, HOLD_FRAME).pixels(),
        render(&reversed, &compositor, HOLD_FRAME).pixels(),
        "each cell is drawn at its own pen, whatever its place in the list"
    );
}

/// Right-to-left text the baker resolved into visual order is drawn, and drawn as given.
///
/// This is the whole of the compositor's part in `rtlSupport`: the cells are still classified
/// right-to-left, and that classification no longer decides anything. Before this, the same
/// descriptor was refused outright and no frame existed at all.
#[test]
fn a_right_to_left_run_the_baker_reordered_composes_like_any_other() {
    let compositor = compositor!();
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.base_direction = Direction::Rtl;
    unchecked.glyphs[1].direction = Direction::Rtl;
    let rtl = GlyphAtlasDescriptor::try_from(unchecked).expect("a valid reordered descriptor");

    let run = || CueRun::single_line(baked_line(0, &[INK_CELL]));
    let right_to_left = SubtitleScene::new(
        scene(FAMILY, WEIGHT),
        rtl,
        style(&layout_spec()),
        vec![run()],
    )
    .expect("a reordered right-to-left run is stageable");
    let left_to_right = staged_with_run(&layout_spec(), run());

    assert!(inked(&render(&right_to_left, &compositor, HOLD_FRAME)) > 0);
    assert_eq!(
        render(&right_to_left, &compositor, HOLD_FRAME).pixels(),
        render(&left_to_right, &compositor, HOLD_FRAME).pixels(),
        "direction classifies; the layout places. The same positions must draw the same pixels"
    );
}

/// The staged run is not the atlas's own layout, but it can be: this is the path the preview and
/// the export both take, and it must place the same glyph the hand-staged fixture does.
#[test]
fn a_run_taken_straight_from_the_atlas_layout_draws_it() {
    let compositor = compositor!();
    let from_layout = staged_with_run(
        &layout_spec(),
        CueRun::from_layout(atlas(FAMILY, WEIGHT).layout()),
    );
    let by_hand = staged_with_run(
        &layout_spec(),
        CueRun::single_line(baked_line(0, &[INK_CELL])),
    );

    assert_eq!(
        render(&from_layout, &compositor, HOLD_FRAME).pixels(),
        render(&by_hand, &compositor, HOLD_FRAME).pixels(),
        "the layout the baker emitted and the run the fixture stages are the same placement"
    );
}
