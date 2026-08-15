//! The box decorations, the gradient fill, and the paint order that binds them all together.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.
//!
//! Two of these are ordering tests rather than feature tests, and they are the reason this file
//! exists separately: an effect that is drawn correctly but in the wrong place in the stack looks
//! fine in isolation and wrong in every real project. Each names the swap it detects.

mod common;

use common::frames::compositor;
use common::ink::{bluish, count_where, exactly, inked, reddish, top_inked_row};
use common::{
    HALF_BLACK, HOLD_FRAME, OPAQUE_BLACK, boxed_only, decorated, decorated_over_box,
    decorated_over_opaque_box, staged, style_spec,
};
use osg_compositor::{Compositor, SubtitleDecorationSpec, SubtitleStyleSpec};

fn border(style: &str, width: f64) -> SubtitleDecorationSpec {
    SubtitleDecorationSpec {
        border_width: width,
        border_color: "#ff0000".to_owned(),
        border_style: style.to_owned(),
        ..SubtitleDecorationSpec::default()
    }
}

fn gradient(start: &str, end: &str, direction: &str) -> SubtitleDecorationSpec {
    SubtitleDecorationSpec {
        gradient_color_start: start.to_owned(),
        gradient_color_end: end.to_owned(),
        gradient_direction: direction.to_owned(),
        ..SubtitleDecorationSpec::default()
    }
}

fn with_gradient(decoration: SubtitleDecorationSpec) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        gradient_enabled: true,
        decoration,
        ..style_spec()
    }
}

/// The colour at a point, as bytes.
fn at(frame: &osg_compositor::Frame, x: u32, y: u32) -> [u8; 4] {
    frame
        .pixel(x, y)
        .expect("the coordinate is inside the frame")
}

// ---- Border ------------------------------------------------------------------------------------

#[test]
fn a_border_is_drawn_only_when_a_width_and_a_style_are_both_set() {
    let compositor = compositor!();
    // No background and no inked glyph, so the border is the only thing that can reach a pixel.
    let none = boxed_only(&decorated(border("none", 20.0)));
    let no_width = boxed_only(&decorated(border("solid", 0.0)));
    let drawn = boxed_only(&decorated(border("solid", 20.0)));

    for (scene, what) in [(none, "style none"), (no_width, "zero width")] {
        let frame = compositor
            .render_scene(&scene, HOLD_FRAME)
            .expect("composition succeeds");
        assert_eq!(
            inked(&frame),
            0,
            "{what} must draw nothing at all, as the shipped renderer emits no border for it"
        );
    }

    let frame = compositor
        .render_scene(&drawn, HOLD_FRAME)
        .expect("composition succeeds");
    assert!(
        count_where(&frame, reddish) > 0,
        "a width and a style must put the border colour on the frame"
    );
}

/// The border grows the box outward and the anchor holds the outer edge, which is what CSS does to
/// an element whose container places its border box.
#[test]
fn a_border_grows_the_box_outward() {
    let compositor = compositor!();
    let plain = boxed_only(&decorated_over_box(SubtitleDecorationSpec::default()));
    let bordered = boxed_only(&decorated_over_box(border("solid", 20.0)));

    let plain_frame = compositor
        .render_scene(&plain, HOLD_FRAME)
        .expect("composition succeeds");
    let bordered_frame = compositor
        .render_scene(&bordered, HOLD_FRAME)
        .expect("composition succeeds");

    let plain_top = top_inked_row(&plain_frame).expect("the box drew something");
    let bordered_top = top_inked_row(&bordered_frame).expect("the bordered box drew something");

    // A stored 20 scales to 6.67 output pixels at this composition height, and the box grows by one
    // border on each side. Asserting the amount rather than the direction is what distinguishes
    // "the box grew" from "the ring's own antialiasing spilled a pixel".
    let expected = 2.0 * (20.0 * 360.0 / 1080.0);
    let grew = f64::from(plain_top) - f64::from(bordered_top);
    assert!(
        (grew - expected).abs() <= 1.5,
        "the bordered box must reach {expected:.2} rows higher, not {grew}: \
         row {bordered_top} against {plain_top}"
    );
}

/// `borderRadius` rounds the border box, and the border's inner edge follows it in: the padding
/// box's corner radius is the outer one less the border width, which is what stops a rounded box
/// from having square corners inside a round outline.
#[test]
fn a_border_radius_rounds_the_box_and_its_border() {
    let compositor = compositor!();
    let square = boxed_only(&decorated_over_opaque_box(border("solid", 20.0)));
    let rounded = boxed_only(&SubtitleStyleSpec {
        border_radius: 60.0,
        ..decorated_over_opaque_box(border("solid", 20.0))
    });

    let square_frame = compositor
        .render_scene(&square, HOLD_FRAME)
        .expect("composition succeeds");
    let rounded_frame = compositor
        .render_scene(&rounded, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        inked(&rounded_frame) < inked(&square_frame),
        "rounding must remove the corners: {} against {}",
        inked(&rounded_frame),
        inked(&square_frame)
    );
    let square_top = top_inked_row(&square_frame).expect("the box drew something");
    let rounded_top = top_inked_row(&rounded_frame).expect("the rounded box drew something");
    assert_eq!(
        rounded_top, square_top,
        "but it must not move the box, only shave it"
    );
}

/// `borderStyle` is the one field the ledger flagged as needing a shader pattern rather than a
/// colour. Each of the four drawn styles must therefore differ from the others in pixels, and the
/// three patterned ones must cover less of the ring than the solid one does.
#[test]
fn every_border_style_draws_a_different_pattern() {
    let compositor = compositor!();
    let coverage = |style: &str| {
        let scene = boxed_only(&decorated(border(style, 20.0)));
        let frame = compositor
            .render_scene(&scene, HOLD_FRAME)
            .expect("composition succeeds");
        (count_where(&frame, reddish), frame.pixels().to_vec())
    };

    let (solid, solid_pixels) = coverage("solid");
    let (double, double_pixels) = coverage("double");
    let (dashed, dashed_pixels) = coverage("dashed");
    let (dotted, dotted_pixels) = coverage("dotted");

    assert!(solid > 0, "a solid border must cover its ring");
    for (count, name) in [(double, "double"), (dashed, "dashed"), (dotted, "dotted")] {
        assert!(count > 0, "a {name} border must still be visible");
        assert!(
            count < solid,
            "a {name} border must leave gaps a solid one does not: {count} against {solid}"
        );
    }
    assert_ne!(solid_pixels, double_pixels);
    assert_ne!(double_pixels, dashed_pixels);
    assert_ne!(dashed_pixels, dotted_pixels);
    assert_ne!(solid_pixels, dotted_pixels);
}

#[test]
fn the_border_colour_is_the_one_that_was_chosen() {
    let compositor = compositor!();
    let red = boxed_only(&decorated(border("solid", 20.0)));
    let blue = boxed_only(&decorated(SubtitleDecorationSpec {
        border_color: "#0000ff".to_owned(),
        ..border("solid", 20.0)
    }));

    let red_frame = compositor
        .render_scene(&red, HOLD_FRAME)
        .expect("composition succeeds");
    let blue_frame = compositor
        .render_scene(&blue, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(count_where(&red_frame, reddish) > 0);
    assert_eq!(count_where(&red_frame, bluish), 0);
    assert!(count_where(&blue_frame, bluish) > 0);
    assert_eq!(count_where(&blue_frame, reddish), 0);
}

// ---- Gradient ----------------------------------------------------------------------------------

/// `gradientEnabled` already makes the text colour transparent and clips the background box away in
/// `osg-scene`. Without the fill below, switching it on would produce an empty frame — which is
/// precisely why the ledger said the two must land together, and precisely what this asserts.
#[test]
fn a_gradient_fills_the_glyphs_that_would_otherwise_be_invisible() {
    let compositor = compositor!();
    let scene = staged(&with_gradient(gradient("#ff0000", "#0000ff", "90deg")));

    let frame = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        inked(&frame) > 0,
        "an enabled gradient must draw the glyphs, not delete them"
    );
    assert!(
        count_where(&frame, reddish) > 0,
        "the start stop must appear"
    );
    assert!(count_where(&frame, bluish) > 0, "the end stop must appear");
    assert_eq!(
        exactly(&frame, HALF_BLACK),
        0,
        "the gradient clips the background box away, as the shipped renderer does"
    );
}

/// Zero degrees points at the top edge and the angle turns clockwise. Reading the angle the
/// mathematical way instead would rotate every existing gradient by ninety degrees.
#[test]
fn the_gradient_direction_orients_the_ramp() {
    let compositor = compositor!();
    let rightwards = staged(&with_gradient(gradient("#ff0000", "#0000ff", "90deg")));
    let leftwards = staged(&with_gradient(gradient("#ff0000", "#0000ff", "270deg")));

    let right_frame = compositor
        .render_scene(&rightwards, HOLD_FRAME)
        .expect("composition succeeds");
    let left_frame = compositor
        .render_scene(&leftwards, HOLD_FRAME)
        .expect("composition succeeds");

    // The fixture glyph spans roughly x 310..326 at y 309; a sample either side of its middle is
    // well clear of both edges.
    let (near, far) = ((312, 309), (324, 309));
    assert!(
        reddish(&at(&right_frame, near.0, near.1)),
        "at 90deg the start colour is on the left"
    );
    assert!(
        bluish(&at(&right_frame, far.0, far.1)),
        "and the end colour on the right"
    );
    assert!(
        bluish(&at(&left_frame, near.0, near.1)),
        "at 270deg the two swap"
    );
    assert!(reddish(&at(&left_frame, far.0, far.1)));
}

#[test]
fn both_gradient_stops_reach_the_pixels() {
    let compositor = compositor!();
    let blue_end = staged(&with_gradient(gradient("#ff0000", "#0000ff", "90deg")));
    let red_end = staged(&with_gradient(gradient("#ff0000", "#ff0000", "90deg")));

    let two_stops = compositor
        .render_scene(&blue_end, HOLD_FRAME)
        .expect("composition succeeds");
    let one_stop = compositor
        .render_scene(&red_end, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(count_where(&two_stops, bluish) > 0);
    assert_eq!(
        count_where(&one_stop, bluish),
        0,
        "changing the end stop must change the pixels, or only the start is being read"
    );
    assert_ne!(two_stops.pixels(), one_stop.pixels());
}

// ---- Paint order -------------------------------------------------------------------------------

/// The order proof for the shadow and the box.
///
/// CSS paints `text-shadow` with the inline content, which is **above** the element's own
/// background. Painting the shadow first instead — the intuitive order, since a shadow is "behind"
/// the text — would put it under the background box.
///
/// The box has to be **opaque** for the assertion to bite. A translucent one merely dims whatever
/// is beneath it, so a red shadow still shows through and the swap goes unnoticed; an opaque box
/// deletes it outright, which turns "the shadow is on screen" into "the shadow is above the box".
#[test]
fn a_text_shadow_is_painted_over_the_background_box() {
    let compositor = compositor!();
    let shadow = SubtitleDecorationSpec {
        text_shadow_enabled: true,
        text_shadow_color: "#ff0000".to_owned(),
        text_shadow_blur: 12.0,
        text_shadow_offset_x: 0.0,
        text_shadow_offset_y: 6.0,
        ..SubtitleDecorationSpec::default()
    };
    let with = staged(&decorated_over_opaque_box(shadow));
    let without = staged(&decorated_over_opaque_box(SubtitleDecorationSpec::default()));

    let with_frame = compositor
        .render_scene(&with, HOLD_FRAME)
        .expect("composition succeeds");
    let without_frame = compositor
        .render_scene(&without, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(count_where(&without_frame, reddish), 0);
    assert!(
        count_where(&with_frame, reddish) > 0,
        "the shadow must be visible over the background box, not buried under it"
    );
    assert!(
        exactly(&with_frame, OPAQUE_BLACK) < exactly(&without_frame, OPAQUE_BLACK),
        "and it must actually cover some of the box it is drawn over"
    );
}

/// The order proof for the glow and the box.
///
/// A CSS outer `box-shadow` is clipped to the outside of the border box, so it never shows through
/// a translucent background. Drawing the blurred mask without that cut — the obvious
/// implementation — would light the box interior up from underneath, which a half-opaque box makes
/// immediately visible: the count of untouched box pixels collapses.
#[test]
fn the_glow_never_shines_through_the_box_it_is_cast_from() {
    let compositor = compositor!();
    let glowing = boxed_only(&decorated_over_box(SubtitleDecorationSpec {
        glow_enabled: true,
        glow_color: "#ffffff".to_owned(),
        glow_intensity: 60.0,
        ..SubtitleDecorationSpec::default()
    }));
    let plain = boxed_only(&decorated_over_box(SubtitleDecorationSpec::default()));

    let with = compositor
        .render_scene(&glowing, HOLD_FRAME)
        .expect("composition succeeds");
    let without = compositor
        .render_scene(&plain, HOLD_FRAME)
        .expect("composition succeeds");

    let interior = exactly(&without, HALF_BLACK);
    assert!(interior > 0, "the half-opaque box must have an interior");
    assert_eq!(
        exactly(&with, HALF_BLACK),
        interior,
        "every interior pixel of the box must be untouched by its own glow"
    );
    assert!(
        inked(&with) > inked(&without),
        "while the glow still reaches outside it"
    );
}

// ---- Determinism -------------------------------------------------------------------------------

fn everything() -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        gradient_enabled: true,
        background_opacity: 50.0,
        background_color: "#000000".to_owned(),
        decoration: SubtitleDecorationSpec {
            stroke_enabled: true,
            stroke_width: 6.0,
            stroke_color: "#00ff00".to_owned(),
            text_shadow_enabled: true,
            text_shadow_color: "#ff0000".to_owned(),
            text_shadow_blur: 12.0,
            text_shadow_offset_x: 4.0,
            text_shadow_offset_y: 6.0,
            glow_enabled: true,
            glow_color: "#ffff00".to_owned(),
            glow_intensity: 40.0,
            border_width: 12.0,
            border_color: "#ff00ff".to_owned(),
            border_style: "dashed".to_owned(),
            gradient_color_start: "#ff0000".to_owned(),
            gradient_color_end: "#0000ff".to_owned(),
            gradient_direction: "90deg".to_owned(),
        },
        ..style_spec()
    }
}

/// Seek equals play, with every decoration switched on.
///
/// The masks add three render passes and two textures per effect, all created and destroyed inside
/// one frame. If any of that leaked across frames, this is where it would show.
#[test]
fn a_fully_decorated_frame_is_still_seek_equals_play() {
    let compositor = compositor!();
    let scene = staged(&everything());

    let mut played = None;
    for index in 0..=HOLD_FRAME {
        played = Some(
            compositor
                .render_scene(&scene, index)
                .expect("composition succeeds"),
        );
    }
    let played = played.expect("the loop rendered at least one frame");

    let fresh = Compositor::new().expect("a second device on a working adapter");
    let sought = fresh
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        played.pixels(),
        sought.pixels(),
        "a decorated frame reached by playing must equal the same frame reached by seeking"
    );
}

#[test]
fn a_fully_decorated_frame_renders_byte_identically_twice() {
    let compositor = compositor!();
    let scene = staged(&everything());

    let first = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");
    let second = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(first.pixels(), second.pixels());
    assert!(inked(&first) > 0);
}

/// The decorations must reach the export path as well as the overlay path, and the underlay must
/// still be the ground rather than something the masks overwrote.
#[test]
fn a_decorated_cue_still_composites_over_an_underlay() {
    let compositor = compositor!();
    let scene = staged(&everything());
    let underlay = osg_compositor::VideoUnderlay::whole(common::quadrant_source());

    let overlay = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");
    let composited = compositor
        .render_scene_over(&scene, &underlay, HOLD_FRAME)
        .expect("composition succeeds");

    assert_ne!(overlay.pixels(), composited.pixels());
    assert!(
        composited
            .pixels()
            .chunks_exact(4)
            .all(|pixel| pixel[3] == 255),
        "an opaque underlay must leave no transparent pixel behind the decorations"
    );
}
