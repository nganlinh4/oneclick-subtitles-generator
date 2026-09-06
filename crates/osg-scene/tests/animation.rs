//! Animation transforms are pinned to the shipped renderer, asymmetries included.
#![expect(
    clippy::float_cmp,
    reason = "expected values are exactly representable; a parity test must match exactly"
)]

use osg_scene::animation::{AnimationType, CueTransform, cue_transform, typewriter_utf16_length};
use osg_scene::cues::CuePhase;

const LINEAR: &str = "linear";

fn transform(animation: AnimationType, phase: CuePhase, progress: f64) -> CueTransform {
    cue_transform(animation, phase, progress, LINEAR)
}

#[test]
fn holding_is_always_the_identity_transform() {
    for animation in [
        AnimationType::None,
        AnimationType::SlideUp,
        AnimationType::SlideDown,
        AnimationType::SlideLeft,
        AnimationType::SlideRight,
        AnimationType::Scale,
        AnimationType::Bounce,
        AnimationType::Flip,
        AnimationType::Rotate,
        AnimationType::Typewriter,
        AnimationType::WordReveal,
        AnimationType::WordHighlight,
    ] {
        assert_eq!(
            transform(animation, CuePhase::Holding, 1.0),
            CueTransform::IDENTITY,
            "{animation:?} must not transform while holding"
        );
    }
}

#[test]
fn slides_travel_the_shipped_distances_in_the_shipped_directions() {
    // Vertical slides travel 50 reference pixels, horizontal ones travel 100.
    assert_eq!(
        transform(AnimationType::SlideUp, CuePhase::FadingIn, 0.0).translate_y,
        50.0
    );
    assert_eq!(
        transform(AnimationType::SlideUp, CuePhase::FadingOut, 0.0).translate_y,
        -50.0
    );
    assert_eq!(
        transform(AnimationType::SlideDown, CuePhase::FadingIn, 0.0).translate_y,
        -50.0
    );
    assert_eq!(
        transform(AnimationType::SlideLeft, CuePhase::FadingIn, 0.0).translate_x,
        100.0
    );
    assert_eq!(
        transform(AnimationType::SlideRight, CuePhase::FadingIn, 0.0).translate_x,
        -100.0
    );
}

#[test]
fn a_slide_arrives_exactly_at_the_origin_when_fully_progressed() {
    for animation in [
        AnimationType::SlideUp,
        AnimationType::SlideDown,
        AnimationType::SlideLeft,
        AnimationType::SlideRight,
    ] {
        let arrived = transform(animation, CuePhase::FadingIn, 1.0);
        assert_eq!(arrived.translate_x, 0.0, "{animation:?}");
        assert_eq!(arrived.translate_y, 0.0, "{animation:?}");
    }
}

#[test]
fn scale_animates_on_both_edges_but_bounce_only_on_entry() {
    // Pinned deliberately: this asymmetry is shipped behaviour, not an oversight to tidy up.
    assert_eq!(
        transform(AnimationType::Scale, CuePhase::FadingIn, 0.0).scale,
        0.5
    );
    assert_eq!(
        transform(AnimationType::Scale, CuePhase::FadingOut, 0.0).scale,
        0.5
    );

    assert_ne!(
        transform(AnimationType::Bounce, CuePhase::FadingIn, 0.25).scale,
        1.0,
        "bounce must animate on entry"
    );
    assert_eq!(
        transform(AnimationType::Bounce, CuePhase::FadingOut, 0.25),
        CueTransform::IDENTITY,
        "bounce must not animate on exit"
    );
}

#[test]
fn bounce_overshoots_and_settles_exactly_at_one() {
    let settled = transform(AnimationType::Bounce, CuePhase::FadingIn, 1.0);
    assert_eq!(settled.scale, 1.0);
    let start = transform(AnimationType::Bounce, CuePhase::FadingIn, 0.0);
    assert_eq!(start.scale, 1.0, "the curve begins at unit scale");

    let overshoots = (1..20)
        .map(|step| {
            transform(
                AnimationType::Bounce,
                CuePhase::FadingIn,
                f64::from(step) / 20.0,
            )
            .scale
        })
        .any(|scale| scale > 1.0);
    assert!(overshoots, "bounce must exceed unit scale somewhere");
}

#[test]
fn flip_and_rotate_use_their_own_axes_and_do_not_disturb_the_other() {
    let flip = transform(AnimationType::Flip, CuePhase::FadingIn, 0.0);
    assert_eq!(flip.rotate_y_degrees, 90.0);
    assert_eq!(flip.rotate_degrees, 0.0);

    let rotate = transform(AnimationType::Rotate, CuePhase::FadingIn, 0.0);
    assert_eq!(rotate.rotate_degrees, 180.0);
    assert_eq!(rotate.rotate_y_degrees, 0.0);
    assert_eq!(
        transform(AnimationType::Rotate, CuePhase::FadingOut, 0.0).rotate_degrees,
        -180.0
    );
}

#[test]
fn the_easing_choice_changes_the_motion_not_only_the_opacity() {
    let linear = cue_transform(AnimationType::SlideUp, CuePhase::FadingIn, 0.25, "linear");
    let eased = cue_transform(AnimationType::SlideUp, CuePhase::FadingIn, 0.25, "ease-in");
    assert_ne!(linear.translate_y, eased.translate_y);
    // ease-in is slower at the start, so more distance remains.
    assert!(eased.translate_y > linear.translate_y);
}

#[test]
fn an_unknown_easing_moves_like_linear() {
    let linear = cue_transform(AnimationType::SlideUp, CuePhase::FadingIn, 0.3, "linear");
    let unknown = cue_transform(AnimationType::SlideUp, CuePhase::FadingIn, 0.3, "not-real");
    assert_eq!(linear, unknown);
}

#[test]
fn animation_names_round_trip_and_unknown_names_are_refused() {
    for (wire, expected) in [
        ("none", AnimationType::None),
        ("slide-up", AnimationType::SlideUp),
        ("slide-down", AnimationType::SlideDown),
        ("slide-left", AnimationType::SlideLeft),
        ("slide-right", AnimationType::SlideRight),
        ("scale", AnimationType::Scale),
        ("bounce", AnimationType::Bounce),
        ("flip", AnimationType::Flip),
        ("rotate", AnimationType::Rotate),
        ("typewriter", AnimationType::Typewriter),
        ("word-reveal", AnimationType::WordReveal),
        ("word-highlight", AnimationType::WordHighlight),
    ] {
        assert_eq!(AnimationType::from_wire(wire), Some(expected));
    }
    for unknown in ["", "Slide-Up", "spin", "slide_up", "  none  "] {
        assert_eq!(AnimationType::from_wire(unknown), None, "{unknown:?}");
    }
}

#[test]
fn typewriter_reveals_by_utf16_code_unit_and_never_overruns() {
    assert_eq!(typewriter_utf16_length(10, 0.0), 0);
    assert_eq!(typewriter_utf16_length(10, 0.5), 5);
    assert_eq!(typewriter_utf16_length(10, 0.99), 9);
    assert_eq!(typewriter_utf16_length(10, 1.0), 10);
    assert_eq!(typewriter_utf16_length(0, 0.5), 0);

    // Any non-finite progress reveals nothing. A NaN or an infinity means the caller's timing math
    // broke, and revealing part or all of the text would hide that instead of showing it.
    for hostile in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(typewriter_utf16_length(10, hostile), 0, "{hostile}");
    }
    // A merely out-of-range finite value clamps, matching the caller's own clamping.
    assert_eq!(typewriter_utf16_length(10, -1.0), 0);
    assert_eq!(typewriter_utf16_length(10, 2.0), 10);
}

#[test]
fn typewriter_can_land_inside_a_surrogate_pair() {
    // Pinned deliberately: an emoji is two UTF-16 code units, so half progress lands between them.
    // The renderer must not slice there; this records that the boundary is reachable.
    let emoji_pair_len = "\u{1F600}".encode_utf16().count();
    assert_eq!(emoji_pair_len, 2);
    assert_eq!(typewriter_utf16_length(emoji_pair_len, 0.5), 1);
}

#[test]
fn transforms_are_repeatable_for_the_same_inputs() {
    for step in 0..100 {
        let progress = f64::from(step) / 100.0;
        for animation in [
            AnimationType::Bounce,
            AnimationType::Scale,
            AnimationType::Rotate,
        ] {
            let first = transform(animation, CuePhase::FadingIn, progress);
            let again = transform(animation, CuePhase::FadingIn, progress);
            assert_eq!(first, again);
        }
    }
}
