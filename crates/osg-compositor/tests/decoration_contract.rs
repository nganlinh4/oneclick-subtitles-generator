//! What the decoration contract accepts and what it refuses, without touching a GPU.
//!
//! The eighteen decoration fields all arrive as editor strings and reference-pixel numbers, and the
//! stored ranges are wider than anything a frame can show. Every bound is therefore asserted here,
//! separately from `decoration_render.rs`, which asserts what reaches the pixels: a value that is
//! refused never gets as far as a shader, and a value that is clamped has to be provably the same
//! frame as the value it clamps to.

use osg_compositor::{
    BorderStyle, CompositorError, MAX_DECORATION_BLUR_RADIUS, MAX_DECORATION_BLUR_SIGMA, Rejection,
    SubtitleDecoration, SubtitleDecorationSpec, decoration_blur_radius_px,
    decoration_blur_sigma_px,
};

fn refusal(spec: &SubtitleDecorationSpec, gradient: bool) -> Rejection {
    match SubtitleDecoration::resolve(spec, gradient).expect_err("the spec must be refused") {
        CompositorError::UnsupportedSceneInput { reason } => reason,
        other => panic!("unexpected error: {other}"),
    }
}

fn resolved(spec: &SubtitleDecorationSpec, gradient: bool) -> SubtitleDecoration {
    SubtitleDecoration::resolve(spec, gradient).expect("the spec resolves")
}

#[test]
fn the_default_decoration_draws_nothing() {
    let decoration = resolved(&SubtitleDecorationSpec::default(), false);
    assert_eq!(decoration, SubtitleDecoration::default());
    assert!(decoration.stroke_effect().is_none());
    assert!(decoration.text_shadow_effect().is_none());
    assert!(decoration.glow_effect().is_none());
    assert!(decoration.border_effect().is_none());
    assert!(decoration.gradient_effect().is_none());
}

#[test]
fn a_switch_without_a_size_draws_nothing() {
    let spec = SubtitleDecorationSpec {
        stroke_enabled: true,
        stroke_width: 0.0,
        glow_enabled: true,
        glow_intensity: 0.0,
        border_width: 0.0,
        border_style: "solid".to_owned(),
        ..SubtitleDecorationSpec::default()
    };
    let decoration = resolved(&spec, false);
    assert!(decoration.stroke_effect().is_none());
    assert!(decoration.glow_effect().is_none());
    assert!(decoration.border_effect().is_none());
}

#[test]
fn a_border_needs_both_a_width_and_a_style() {
    let width_only = SubtitleDecorationSpec {
        border_width: 4.0,
        ..SubtitleDecorationSpec::default()
    };
    assert!(resolved(&width_only, false).border_effect().is_none());

    let both = SubtitleDecorationSpec {
        border_style: "dashed".to_owned(),
        ..width_only
    };
    let border = resolved(&both, false)
        .border_effect()
        .expect("a width and a style draw a border");
    assert_eq!(border.style, BorderStyle::Dashed);
    assert!((border.width - 4.0).abs() < f64::EPSILON);
}

#[test]
fn the_border_style_vocabulary_is_closed() {
    assert_eq!(
        refusal(
            &SubtitleDecorationSpec {
                border_width: 2.0,
                border_style: "groove".to_owned(),
                ..SubtitleDecorationSpec::default()
            },
            false
        ),
        Rejection::DecorationBorderStyle
    );
}

#[test]
fn out_of_range_sizes_are_refused_field_by_field() {
    let cases = [
        (
            SubtitleDecorationSpec {
                stroke_width: 101.0,
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationStroke,
        ),
        (
            SubtitleDecorationSpec {
                text_shadow_blur: f64::INFINITY,
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationShadow,
        ),
        (
            SubtitleDecorationSpec {
                text_shadow_offset_x: -2_001.0,
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationShadow,
        ),
        (
            SubtitleDecorationSpec {
                glow_intensity: 1_001.0,
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationGlow,
        ),
        (
            SubtitleDecorationSpec {
                border_width: f64::NAN,
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationBorder,
        ),
    ];
    for (spec, expected) in cases {
        assert_eq!(refusal(&spec, false), expected);
    }
}

#[test]
fn every_colour_must_be_a_supported_hex_colour() {
    let cases = [
        (
            SubtitleDecorationSpec {
                stroke_color: "red".to_owned(),
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationStroke,
        ),
        (
            SubtitleDecorationSpec {
                text_shadow_color: "rgb(0,0,0)".to_owned(),
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationShadow,
        ),
        (
            SubtitleDecorationSpec {
                glow_color: "#ggg".to_owned(),
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationGlow,
        ),
        (
            SubtitleDecorationSpec {
                border_color: "#12345".to_owned(),
                ..SubtitleDecorationSpec::default()
            },
            Rejection::DecorationBorder,
        ),
    ];
    for (spec, expected) in cases {
        assert_eq!(refusal(&spec, false), expected);
    }
}

#[test]
fn a_gradient_resolves_only_when_it_is_enabled() {
    let spec = SubtitleDecorationSpec {
        gradient_color_start: "#ff0000".to_owned(),
        gradient_color_end: "#0000ff".to_owned(),
        gradient_direction: "90deg".to_owned(),
        ..SubtitleDecorationSpec::default()
    };
    assert!(resolved(&spec, false).gradient_effect().is_none());

    let gradient = resolved(&spec, true)
        .gradient_effect()
        .expect("an enabled gradient resolves");
    assert_eq!(gradient.start.red, 255);
    assert_eq!(gradient.end.blue, 255);
    assert!((gradient.degrees - 90.0).abs() < f64::EPSILON);
}

#[test]
fn the_gradient_direction_vocabulary_is_the_stored_one() {
    for direction in ["45", "45degrees", "-45deg", "361deg", "deg", "1e2deg"] {
        assert_eq!(
            refusal(
                &SubtitleDecorationSpec {
                    gradient_direction: direction.to_owned(),
                    ..SubtitleDecorationSpec::default()
                },
                true
            ),
            Rejection::DecorationGradient,
            "{direction} must be refused"
        );
    }
    for direction in ["0deg", "360deg"] {
        let spec = SubtitleDecorationSpec {
            gradient_direction: direction.to_owned(),
            ..SubtitleDecorationSpec::default()
        };
        assert!(resolved(&spec, true).gradient_effect().is_some());
    }
}

#[test]
fn a_css_blur_radius_is_two_deviations_and_the_deviation_is_capped() {
    assert!((decoration_blur_sigma_px(4.0) - 2.0).abs() < f64::EPSILON);
    assert!((decoration_blur_sigma_px(0.0)).abs() < f64::EPSILON);
    assert!(
        (decoration_blur_sigma_px(100.0) - 50.0).abs() < f64::EPSILON,
        "the widest glow the editor offers must not be clamped at 1080p"
    );
    assert!(
        (decoration_blur_sigma_px(1_000.0) - MAX_DECORATION_BLUR_SIGMA).abs() < f64::EPSILON,
        "the widest stored value clamps rather than being refused"
    );
    assert_eq!(
        decoration_blur_radius_px(MAX_DECORATION_BLUR_SIGMA),
        MAX_DECORATION_BLUR_RADIUS
    );
    assert_eq!(decoration_blur_radius_px(0.0), 0);
}
