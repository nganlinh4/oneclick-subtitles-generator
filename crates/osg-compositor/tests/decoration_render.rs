//! The glyph decorations against a real adapter: text shadow, glow and stroke.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.
//!
//! Each effect is asserted three ways, because a decoration that is merely *different* is not
//! evidence that it is *right*: it must appear when switched on, be wholly absent when switched
//! off, and carry the colour the user chose rather than some other colour that also happens to
//! change the frame. The box decorations and the paint order live in `decoration_box_render.rs`.

mod common;

use common::frames::compositor;
use common::ink::{count_where, exactly, greenish, ink_centre, inked, left_inked_column, reddish};
use common::{HOLD_FRAME, boxed_only, decorated, decorated_over_box, staged};
use osg_compositor::{MAX_DECORATION_BLUR_SIGMA, SubtitleDecorationSpec, decoration_blur_sigma_px};

/// Fully opaque white: what the fixture cue's glyph interior composes to when nothing covers it.
const OPAQUE_WHITE: [u8; 4] = [255, 255, 255, 255];

fn shadow(colour: &str, blur: f64, offset: (f64, f64)) -> SubtitleDecorationSpec {
    SubtitleDecorationSpec {
        text_shadow_enabled: true,
        text_shadow_color: colour.to_owned(),
        text_shadow_blur: blur,
        text_shadow_offset_x: offset.0,
        text_shadow_offset_y: offset.1,
        ..SubtitleDecorationSpec::default()
    }
}

fn stroke(colour: &str, width: f64) -> SubtitleDecorationSpec {
    SubtitleDecorationSpec {
        stroke_enabled: true,
        stroke_width: width,
        stroke_color: colour.to_owned(),
        ..SubtitleDecorationSpec::default()
    }
}

fn glow(colour: &str, intensity: f64) -> SubtitleDecorationSpec {
    SubtitleDecorationSpec {
        glow_enabled: true,
        glow_color: colour.to_owned(),
        glow_intensity: intensity,
        ..SubtitleDecorationSpec::default()
    }
}

#[test]
fn reports_the_adapter_the_decoration_path_used() {
    let compositor = compositor!();
    let profile = compositor.adapter();
    eprintln!(
        "DECORATION ADAPTER: name={:?} backend={} kind={:?} software={}",
        profile.name(),
        profile.backend(),
        profile.kind(),
        profile.kind().is_software()
    );
    assert!(!profile.backend().is_empty());
}

// ---- Text shadow -------------------------------------------------------------------------------

#[test]
fn a_text_shadow_is_drawn_only_when_it_is_enabled_and_in_its_own_colour() {
    let compositor = compositor!();
    let off = staged(&decorated(SubtitleDecorationSpec::default()));
    let on = staged(&decorated(shadow("#ff0000", 6.0, (0.0, 6.0))));

    let without = compositor
        .render_scene(&off, HOLD_FRAME)
        .expect("composition succeeds");
    let with = compositor
        .render_scene(&on, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        count_where(&without, reddish),
        0,
        "a disabled shadow must put nothing on the frame"
    );
    assert!(
        count_where(&with, reddish) > 0,
        "an enabled shadow must reach the pixels in its own colour"
    );
    assert!(
        inked(&with) > inked(&without),
        "the shadow must add coverage: {} vs {}",
        inked(&with),
        inked(&without)
    );
}

#[test]
fn the_shadow_colour_is_the_one_that_was_chosen() {
    let compositor = compositor!();
    let red = staged(&decorated(shadow("#ff0000", 6.0, (0.0, 6.0))));
    let green = staged(&decorated(shadow("#00ff00", 6.0, (0.0, 6.0))));

    let red_frame = compositor
        .render_scene(&red, HOLD_FRAME)
        .expect("composition succeeds");
    let green_frame = compositor
        .render_scene(&green, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(count_where(&red_frame, reddish) > 0);
    assert_eq!(count_where(&red_frame, greenish), 0);
    assert!(count_where(&green_frame, greenish) > 0);
    assert_eq!(count_where(&green_frame, reddish), 0);
}

/// `textShadowOffsetY` has an editor control and `textShadowOffsetX` does not, but both render in
/// the shipped renderer. Dropping the one without a control would be exactly the silent capability
/// loss the parity ledger exists to prevent, so both are asserted.
#[test]
fn both_shadow_offsets_move_the_shadow_including_the_one_with_no_control() {
    let compositor = compositor!();
    let centred = staged(&decorated(shadow("#ff0000", 0.0, (0.0, 0.0))));
    let sideways = staged(&decorated(shadow("#ff0000", 0.0, (60.0, 0.0))));
    let downwards = staged(&decorated(shadow("#ff0000", 0.0, (0.0, 60.0))));

    let centre = ink_centre(
        &compositor
            .render_scene(&centred, HOLD_FRAME)
            .expect("composition succeeds"),
    )
    .expect("the cue drew something");
    let right = ink_centre(
        &compositor
            .render_scene(&sideways, HOLD_FRAME)
            .expect("composition succeeds"),
    )
    .expect("the cue drew something");
    let down = ink_centre(
        &compositor
            .render_scene(&downwards, HOLD_FRAME)
            .expect("composition succeeds"),
    )
    .expect("the cue drew something");

    assert!(
        right.0 > centre.0 + 1.0,
        "textShadowOffsetX must move the shadow right: {} vs {}",
        right.0,
        centre.0
    );
    assert!(
        (right.1 - centre.1).abs() < 1.0,
        "textShadowOffsetX must not move it vertically"
    );
    assert!(
        down.1 > centre.1 + 1.0,
        "textShadowOffsetY must move the shadow down: {} vs {}",
        down.1,
        centre.1
    );
}

#[test]
fn a_shadow_blur_spreads_it_further_than_a_sharp_one() {
    let compositor = compositor!();
    let sharp = staged(&decorated(shadow("#ff0000", 0.0, (0.0, 0.0))));
    let soft = staged(&decorated(shadow("#ff0000", 40.0, (0.0, 0.0))));

    let sharp_frame = compositor
        .render_scene(&sharp, HOLD_FRAME)
        .expect("composition succeeds");
    let soft_frame = compositor
        .render_scene(&soft, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        inked(&soft_frame) > inked(&sharp_frame),
        "a blurred shadow must cover more than a sharp one: {} vs {}",
        inked(&soft_frame),
        inked(&sharp_frame)
    );
    let soft_edge = left_inked_column(&soft_frame).expect("the blurred cue drew something");
    let sharp_edge = left_inked_column(&sharp_frame).expect("the sharp cue drew something");
    assert!(
        soft_edge < sharp_edge,
        "the blur must reach outside the glyph on every side: {soft_edge} vs {sharp_edge}"
    );
}

/// The persisted range reaches 1000, which as a deviation would be a six-thousand-tap kernel. The
/// value is clamped rather than refused, so two stored blurs that both exceed the cap must render
/// identically — which is what proves the cap is doing the bounding rather than the arithmetic
/// merely getting large.
#[test]
fn an_extreme_stored_blur_is_clamped_rather_than_refused() {
    let compositor = compositor!();
    // At this composition height both scale past the cap; the smaller one does not.
    let capped = staged(&decorated(shadow("#ff0000", 900.0, (0.0, 0.0))));
    let more_capped = staged(&decorated(shadow("#ff0000", 1_000.0, (0.0, 0.0))));
    let under = staged(&decorated(shadow("#ff0000", 120.0, (0.0, 0.0))));

    let first = compositor
        .render_scene(&capped, HOLD_FRAME)
        .expect("the largest stored blur is accepted, not refused");
    let second = compositor
        .render_scene(&more_capped, HOLD_FRAME)
        .expect("the largest stored blur is accepted, not refused");
    let smaller = compositor
        .render_scene(&under, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        first.pixels(),
        second.pixels(),
        "two blurs that both clamp must produce the same frame"
    );
    assert_ne!(
        first.pixels(),
        smaller.pixels(),
        "a blur below the cap must still differ, or the cap is swallowing everything"
    );
    // 900 and 1000 reference pixels both scale past the cap at 360 high; 120 does not.
    assert!(
        (decoration_blur_sigma_px(900.0 * 360.0 / 1080.0) - MAX_DECORATION_BLUR_SIGMA).abs()
            < f64::EPSILON
    );
    assert!(decoration_blur_sigma_px(120.0 * 360.0 / 1080.0) < MAX_DECORATION_BLUR_SIGMA);
}

// ---- Glow --------------------------------------------------------------------------------------

#[test]
fn a_glow_is_drawn_only_when_it_is_enabled_and_in_its_own_colour() {
    let compositor = compositor!();
    let off = staged(&decorated(SubtitleDecorationSpec::default()));
    let red = staged(&decorated(glow("#ff0000", 60.0)));
    let green = staged(&decorated(glow("#00ff00", 60.0)));

    let without = compositor
        .render_scene(&off, HOLD_FRAME)
        .expect("composition succeeds");
    let red_frame = compositor
        .render_scene(&red, HOLD_FRAME)
        .expect("composition succeeds");
    let green_frame = compositor
        .render_scene(&green, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(count_where(&without, reddish), 0);
    assert!(count_where(&red_frame, reddish) > 0);
    assert!(count_where(&green_frame, greenish) > 0);
    assert_eq!(count_where(&green_frame, reddish), 0);
    assert!(
        inked(&red_frame) > inked(&without),
        "the glow must add coverage outside the box"
    );
}

/// The glow is the shipped `box-shadow`, so it is cast from the **box** and not from the glyphs.
/// Changing it to a real text glow would alter every project that switched it on, so the box shape
/// is what the test pins: a cue with no inked glyph at all still glows.
#[test]
fn the_glow_is_cast_from_the_box_and_not_from_the_glyphs() {
    let compositor = compositor!();
    let glowing = boxed_only(&decorated_over_box(glow("#ff0000", 60.0)));
    let plain = boxed_only(&decorated_over_box(SubtitleDecorationSpec::default()));

    let with = compositor
        .render_scene(&glowing, HOLD_FRAME)
        .expect("composition succeeds");
    let without = compositor
        .render_scene(&plain, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        count_where(&with, reddish) > 0,
        "a cue whose only shape is the box must still glow"
    );
    assert_eq!(count_where(&without, reddish), 0);
}

// ---- Stroke ------------------------------------------------------------------------------------

#[test]
fn a_stroke_is_drawn_only_when_it_is_enabled_and_in_its_own_colour() {
    let compositor = compositor!();
    let off = staged(&decorated(SubtitleDecorationSpec::default()));
    let red = staged(&decorated(stroke("#ff0000", 24.0)));
    let green = staged(&decorated(stroke("#00ff00", 24.0)));

    let without = compositor
        .render_scene(&off, HOLD_FRAME)
        .expect("composition succeeds");
    let red_frame = compositor
        .render_scene(&red, HOLD_FRAME)
        .expect("composition succeeds");
    let green_frame = compositor
        .render_scene(&green, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(count_where(&without, reddish), 0);
    assert!(count_where(&red_frame, reddish) > 0);
    assert!(count_where(&green_frame, greenish) > 0);
    assert!(
        inked(&red_frame) > inked(&without),
        "the stroke must widen the letter: {} vs {}",
        inked(&red_frame),
        inked(&without)
    );
}

/// A wider stroke must reach further, which is what proves the width is the dilation radius rather
/// than a switch that draws one fixed outline.
#[test]
fn a_wider_stroke_reaches_further() {
    let compositor = compositor!();
    let thin = staged(&decorated(stroke("#ff0000", 8.0)));
    let thick = staged(&decorated(stroke("#ff0000", 40.0)));

    let thin_frame = compositor
        .render_scene(&thin, HOLD_FRAME)
        .expect("composition succeeds");
    let thick_frame = compositor
        .render_scene(&thick, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        inked(&thick_frame) > inked(&thin_frame),
        "{} must exceed {}",
        inked(&thick_frame),
        inked(&thin_frame)
    );
    assert!(left_inked_column(&thick_frame) < left_inked_column(&thin_frame));
}

/// The order proof for the two effects that overlap on the same pixels.
///
/// The stroke is drawn **under** the fill, so the letter keeps its own colour in the middle and the
/// stroke reads as an outline. Drawing the dilation over the fill instead would swallow the letter
/// whole — the interior would become stroke-coloured — so the count of untouched fill pixels is
/// exactly the quantity that detects the swap.
#[test]
fn the_stroke_is_painted_under_the_fill() {
    let compositor = compositor!();
    let plain = staged(&decorated(SubtitleDecorationSpec::default()));
    let stroked = staged(&decorated(stroke("#ff0000", 24.0)));

    let plain_frame = compositor
        .render_scene(&plain, HOLD_FRAME)
        .expect("composition succeeds");
    let stroked_frame = compositor
        .render_scene(&stroked, HOLD_FRAME)
        .expect("composition succeeds");

    let bare = exactly(&plain_frame, OPAQUE_WHITE);
    let outlined = exactly(&stroked_frame, OPAQUE_WHITE);
    assert!(
        bare > 0,
        "the unstroked letter must have an opaque interior"
    );
    assert_eq!(
        outlined, bare,
        "the fill must survive the stroke intact: {outlined} white pixels against {bare}"
    );
    assert!(
        count_where(&stroked_frame, reddish) > 0,
        "and the stroke must still be visible around it"
    );
}

/// The stored contract accepts a stroke of 100 reference pixels. It has to render, and the ring
/// sample count is fixed, so it costs no more per fragment than a hairline does.
#[test]
fn the_widest_stored_stroke_still_renders() {
    let compositor = compositor!();
    let scene = staged(&decorated(stroke("#ff0000", 100.0)));

    let frame = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("the widest stored stroke is accepted, not refused");

    assert_eq!(
        u64::try_from(frame.pixels().len()).ok(),
        Some(scene.size().rgba8_len())
    );
    assert!(count_where(&frame, reddish) > 0);
}
