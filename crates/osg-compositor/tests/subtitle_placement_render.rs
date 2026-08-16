//! Placing a cue where the persisted percentage says, including outside the composition.
//!
//! `customPositionX`, `customPositionY` and the four margins are all *offsets*, and the schema the
//! editor writes and the render contract validates accept them well outside the composition:
//! `-1000..=1000` for the placements, `-10000..=10000` for the margins. The shipped renderer emits
//! them verbatim as `left: ${customPositionX}%`, so a project carrying `-100` has already been on a
//! user's screen. A compositor that refused them would make that project unexportable, which is a
//! worse failure than drawing it off-screen.
//!
//! Every assertion here is **differential**: a reference render places the box inside the frame, and
//! an out-of-range render must place the same box exactly the distance the percentage difference
//! says. That is what distinguishes "the value reached the layout" from "the value was clamped back
//! into 0..=100", which would move the box somewhere else entirely and still draw something.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.

mod common;

use common::frames::compositor;
use common::ink::{inked, top_inked_row};
use common::{HEIGHT, HOLD_FRAME, WIDTH, staged, style_spec};
use osg_compositor::{Compositor, Frame, SubtitleStyleSpec};
use osg_scene::layout::Margins;

/// Horizontal padding, in reference pixels, that makes the background box about 620 output pixels
/// wide at this composition — wide enough to stay visible when its centre is pushed off the frame,
/// and still narrow enough to sit inside the frame in the reference render.
const WIDE_PADDING_X: f64 = 900.0;

/// Vertical padding that makes the box about 340 output pixels tall, for the same reason.
const TALL_PADDING_Y: f64 = 474.0;

/// Vertical padding for the margin tests, where the box must stay inside a frame whose anchor is
/// only a tenth of the height from the bottom edge.
const MARGIN_PADDING_Y: f64 = 264.0;

/// One output pixel of slack.
///
/// The placements chosen below are exact in binary floating point, so the box translates by a whole
/// number of pixels and the rasterised edge should land exactly; a single pixel of slack absorbs the
/// last-bit difference the margin percentages carry through `round_two_decimals` without coming
/// anywhere near the hundreds of pixels a clamped value would be out by.
const SLACK: i64 = 1;

/// An opaque box, no rounding, no decoration: the ink extents *are* the box.
fn boxed(padding_x: f64, padding_y: f64) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        background_opacity: 100.0,
        background_color: "#000000".to_owned(),
        background_padding_x: padding_x,
        background_padding_y: padding_y,
        // A rounded corner would pull the extreme row and column inward by the radius, which is
        // measurement noise this test has no use for.
        border_radius: 0.0,
        ..style_spec()
    }
}

fn custom(custom_x: f64, custom_y: f64) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        position: "custom".to_owned(),
        custom_x,
        custom_y,
        ..boxed(WIDE_PADDING_X, TALL_PADDING_Y)
    }
}

fn from_bottom(margin_bottom: f64) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        position: "bottom".to_owned(),
        margins: Margins {
            bottom: margin_bottom,
            top: 80.0,
            left: 100.0,
            right: 100.0,
        },
        ..boxed(0.0, MARGIN_PADDING_Y)
    }
}

fn render(compositor: &Compositor, spec: &SubtitleStyleSpec) -> Frame {
    compositor
        .render_scene(&staged(spec), HOLD_FRAME)
        .expect("a placement the render contract accepts must compose")
}

fn inked_at(frame: &Frame, x: u32, y: u32) -> bool {
    frame.pixel(x, y).is_some_and(|pixel| pixel[3] > 0)
}

fn left_inked_column(frame: &Frame) -> Option<u32> {
    (0..frame.width()).find(|x| (0..frame.height()).any(|y| inked_at(frame, *x, y)))
}

fn right_inked_column(frame: &Frame) -> Option<u32> {
    (0..frame.width())
        .rev()
        .find(|x| (0..frame.height()).any(|y| inked_at(frame, *x, y)))
}

fn bottom_inked_row(frame: &Frame) -> Option<u32> {
    (0..frame.height())
        .rev()
        .find(|y| (0..frame.width()).any(|x| inked_at(frame, x, *y)))
}

fn column(frame: &Frame, edge: fn(&Frame) -> Option<u32>, what: &str) -> i64 {
    i64::from(edge(frame).unwrap_or_else(|| panic!("{what}: the frame carries no ink at all")))
}

/// Assert an edge moved exactly as far as the percentage difference says it should.
fn moved_by(reference: i64, observed: i64, expected: i64, what: &str) {
    let moved = observed - reference;
    assert!(
        (moved - expected).abs() <= SLACK,
        "{what}: the edge moved {moved}px, but the percentage says {expected}px \
         (reference {reference}, observed {observed})"
    );
}

/// The reference box sits well inside the frame, so every edge measured from it is the box's own
/// and not the frame's.
fn assert_reference_is_unclipped(frame: &Frame) {
    let (left, right) = (
        column(frame, left_inked_column, "reference left"),
        column(frame, right_inked_column, "reference right"),
    );
    let (top, bottom) = (
        column(frame, top_inked_row, "reference top"),
        column(frame, bottom_inked_row, "reference bottom"),
    );
    assert!(
        left > 0 && right < i64::from(WIDTH) - 1,
        "the reference box must not touch a vertical frame edge: {left}..={right}"
    );
    assert!(
        top > 0 && bottom < i64::from(HEIGHT) - 1,
        "the reference box must not touch a horizontal frame edge: {top}..={bottom}"
    );
}

/// A negative `customPositionX` and `customPositionY` place the box off the top-left, and the part
/// still on screen lands exactly where -25% says.
///
/// -25% of a 640x360 composition is (-160, -90); the reference is 50%, or (320, 180). So the box
/// must move exactly -480 across and -270 down, which puts its right edge and its bottom edge —
/// and nothing else — inside the frame.
#[test]
fn a_negative_custom_position_places_the_box_off_the_top_left_corner() {
    let compositor = compositor!();
    let reference = render(&compositor, &custom(50.0, 50.0));
    assert_reference_is_unclipped(&reference);

    let negative = render(&compositor, &custom(-25.0, -25.0));
    assert!(
        inked(&negative) > 0,
        "a negative custom position must still draw the part of the box that is on screen"
    );
    moved_by(
        column(&reference, right_inked_column, "reference right"),
        column(&negative, right_inked_column, "negative right"),
        -480,
        "customPositionX -25 moves the box a quarter-width left of the origin",
    );
    moved_by(
        column(&reference, bottom_inked_row, "reference bottom"),
        column(&negative, bottom_inked_row, "negative bottom"),
        -270,
        "customPositionY -25 moves the box a quarter-height above the origin",
    );
}

/// A `customPosition` past 100 places the box off the bottom-right, and the part still on screen
/// lands exactly where 125% says.
#[test]
fn a_custom_position_past_one_hundred_places_the_box_off_the_bottom_right_corner() {
    let compositor = compositor!();
    let reference = render(&compositor, &custom(50.0, 50.0));
    assert_reference_is_unclipped(&reference);

    let over = render(&compositor, &custom(125.0, 125.0));
    assert!(
        inked(&over) > 0,
        "a custom position past 100 must still draw the part of the box that is on screen"
    );
    moved_by(
        column(&reference, left_inked_column, "reference left"),
        column(&over, left_inked_column, "over-100 left"),
        480,
        "customPositionX 125 moves the box a quarter-width past the far edge",
    );
    moved_by(
        column(&reference, top_inked_row, "reference top"),
        column(&over, top_inked_row, "over-100 top"),
        270,
        "customPositionY 125 moves the box a quarter-height past the bottom",
    );
}

/// A negative `marginBottom` pushes the box below the composition, by exactly the percentage the
/// shipped renderer would have emitted.
///
/// 108 reference pixels is 10.00% of the 1080-high reference, so `+108` anchors the box at 90% of
/// the height and `-108` anchors it at 110%: a difference of 20% of 360, or 72 pixels.
#[test]
fn a_negative_margin_composes_and_pushes_the_box_past_the_bottom_edge() {
    let compositor = compositor!();
    let reference = render(&compositor, &from_bottom(108.0));
    let bottom = column(&reference, bottom_inked_row, "reference bottom");
    assert!(
        bottom < i64::from(HEIGHT) - 1,
        "the reference box must sit clear of the bottom edge, not on it: {bottom}"
    );

    let negative = render(&compositor, &from_bottom(-108.0));
    assert!(
        inked(&negative) > 0,
        "a negative margin must still draw the part of the box that is on screen"
    );
    assert_eq!(
        bottom_inked_row(&negative),
        Some(HEIGHT - 1),
        "a box anchored at 110% of the height must run off the bottom of the frame"
    );
    moved_by(
        column(&reference, top_inked_row, "reference top"),
        column(&negative, top_inked_row, "negative top"),
        72,
        "marginBottom -108 anchors the box at 110% of the height instead of 90%",
    );
}

/// Every margin edge accepts a negative value and composes, not just the one the layout consults.
#[test]
fn a_negative_margin_on_every_edge_composes() {
    let compositor = compositor!();
    let spec = SubtitleStyleSpec {
        margins: Margins {
            bottom: -40.0,
            top: -40.0,
            left: -40.0,
            right: -40.0,
        },
        ..style_spec()
    };
    let frame = render(&compositor, &spec);
    assert!(
        inked(&frame) > 0,
        "negative margins on all four edges must still compose a visible cue"
    );
}
