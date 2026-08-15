//! Colour resolution is pinned, including the case where the shipped renderer loses the background.

use osg_scene::color::{
    ColorError, Rgba, background_survives_gradient, opacity_to_alpha_byte, parse_hex_color,
    resolve_background, resolve_text_color,
};

#[test]
fn six_digit_colours_parse_as_opaque() {
    assert_eq!(
        parse_hex_color("#ff8000"),
        Ok(Rgba {
            red: 255,
            green: 128,
            blue: 0,
            alpha: 255
        })
    );
}

#[test]
fn the_three_digit_shorthand_repeats_each_digit() {
    assert_eq!(parse_hex_color("#abc"), parse_hex_color("#aabbcc"));
    assert_eq!(parse_hex_color("#000"), parse_hex_color("#000000"));
    assert_eq!(parse_hex_color("#fff"), parse_hex_color("#ffffff"));
}

#[test]
fn the_four_digit_shorthand_repeats_each_digit_including_alpha() {
    // Accepted because every validator in the persistence chain accepts it, so a hand-edited
    // project can carry one. Nothing in the application emits it.
    assert_eq!(parse_hex_color("#abcd"), parse_hex_color("#aabbccdd"));
    assert_eq!(parse_hex_color("#fff0"), parse_hex_color("#ffffff00"));
    assert_eq!(
        parse_hex_color("#0f08"),
        Ok(Rgba {
            red: 0,
            green: 255,
            blue: 0,
            alpha: 136
        })
    );
}

#[test]
fn a_four_digit_background_is_refused_rather_than_drawn_as_a_different_colour() {
    // The shipped renderer appends the opacity to the string, so "#abcd" becomes "#abcd80" — six
    // digits, perfectly valid, and a completely different colour drawn with no hint of a problem.
    // That is worse than the ten-digit case, which at least disappears visibly.
    assert_eq!(
        resolve_background("#abcd", 50.0),
        Err(ColorError::AlreadyHasAlpha)
    );
    // Still transparent rather than an error when the background is off entirely.
    assert_eq!(resolve_background("#abcd", 0.0), Ok(Rgba::TRANSPARENT));
}

#[test]
fn eight_digit_colours_carry_their_own_alpha() {
    assert_eq!(
        parse_hex_color("#ff800080"),
        Ok(Rgba {
            red: 255,
            green: 128,
            blue: 0,
            alpha: 128
        })
    );
}

#[test]
fn uppercase_digits_parse_the_same_as_lowercase() {
    assert_eq!(parse_hex_color("#FF8000"), parse_hex_color("#ff8000"));
}

#[test]
fn anything_that_is_not_a_hex_colour_is_refused() {
    for value in [
        "",
        "ff8000",
        "#",
        "#f",
        "#ff",
        "#fffff",
        "#fffffff",
        "#fffffffff",
        "#gggggg",
        "rgb(1,2,3)",
        "red",
        "#ff 800",
    ] {
        assert_eq!(
            parse_hex_color(value),
            Err(ColorError::Unrecognised),
            "{value:?}"
        );
    }
}

#[test]
fn opacity_maps_to_alpha_with_the_shipped_rounding() {
    // 2.55 is not exactly representable, so 50 * 2.55 is 127.49999999999999 and rounds DOWN to
    // 127 rather than up to 128. Half opacity is therefore a shade more transparent than half.
    // Computing this "correctly" would shift every existing project's background by one level.
    assert_eq!(opacity_to_alpha_byte(0.0), 0);
    assert_eq!(opacity_to_alpha_byte(50.0), 127);
    assert_eq!(opacity_to_alpha_byte(100.0), 255);
    assert_eq!(opacity_to_alpha_byte(1.0), 3);
}

#[test]
fn a_hostile_or_out_of_range_opacity_cannot_escape_the_byte() {
    // Non-finite opacity is fully transparent, the same fail-closed rule the typewriter uses: a
    // NaN means the caller's math broke, and painting anything would hide that.
    for hostile in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        assert_eq!(opacity_to_alpha_byte(hostile), 0, "{hostile}");
    }
    // A merely out-of-range finite value clamps to opaque.
    assert_eq!(opacity_to_alpha_byte(1_000.0), 255);
}

#[test]
fn a_background_takes_its_alpha_from_the_opacity_setting() {
    assert_eq!(
        resolve_background("#101820", 50.0),
        Ok(Rgba {
            red: 16,
            green: 24,
            blue: 32,
            alpha: 127
        })
    );
}

#[test]
fn zero_opacity_is_transparent_rather_than_an_error() {
    assert_eq!(resolve_background("#101820", 0.0), Ok(Rgba::TRANSPARENT));
    assert_eq!(resolve_background("#101820", -5.0), Ok(Rgba::TRANSPARENT));
    // A colour that would otherwise be refused is never even consulted at zero opacity, matching
    // the shipped renderer, which emits no background at all in that case.
    assert_eq!(
        resolve_background("not-a-colour", 0.0),
        Ok(Rgba::TRANSPARENT)
    );
}

#[test]
fn a_colour_that_already_has_alpha_is_reported_instead_of_silently_vanishing() {
    // The shipped renderer appends two more hex digits here, producing a ten-digit colour that no
    // renderer understands, so the background disappears with no message while every other style
    // still applies. The pixels are the same; the difference is that the cause is now findable.
    assert_eq!(
        resolve_background("#10182080", 50.0),
        Err(ColorError::AlreadyHasAlpha)
    );
    assert!(ColorError::AlreadyHasAlpha.to_string().contains("alpha"));
}

#[test]
fn an_unparseable_background_colour_is_refused_at_a_visible_opacity() {
    assert_eq!(
        resolve_background("chartreuse", 50.0),
        Err(ColorError::Unrecognised)
    );
}

#[test]
fn a_gradient_makes_the_text_itself_transparent() {
    assert_eq!(resolve_text_color("#ffffff", true), Ok(Rgba::TRANSPARENT));
    assert_eq!(
        resolve_text_color("#ffffff", false),
        Ok(Rgba {
            red: 255,
            green: 255,
            blue: 255,
            alpha: 255
        })
    );
}

#[test]
fn a_gradient_and_a_background_cannot_both_be_visible() {
    // Pinned deliberately: clipping the paint to the glyphs removes the box too, which is why
    // enabling a gradient appears to delete a user's subtitle background.
    assert!(background_survives_gradient(false));
    assert!(!background_survives_gradient(true));
}

#[test]
fn resolution_is_repeatable() {
    for opacity in [0.0, 1.0, 33.0, 50.0, 99.0, 100.0] {
        assert_eq!(
            resolve_background("#123456", opacity),
            resolve_background("#123456", opacity)
        );
    }
}
