//! Layout is pinned because the renderer deliberately scales sizes and margins by different rules,
//! and because several positions discard settings the user can still see in the editor.
#![expect(
    clippy::float_cmp,
    reason = "expected values are exactly representable; a parity test must match exactly"
)]

use osg_scene::layout::{
    Margins, SubtitlePosition, TextAlign, margin_fraction, resolve_subtitle_box,
};
use osg_scene::scale::scale_subtitle_style_value;

const MARGINS: Margins = Margins {
    bottom: 96.0,
    top: 54.0,
    left: 192.0,
    right: 192.0,
};

fn resolve(position: SubtitlePosition, width: f64, height: f64) -> osg_scene::layout::SubtitleBox {
    resolve_subtitle_box(
        position,
        MARGINS,
        25.0,
        75.0,
        TextAlign::Center,
        width,
        height,
    )
}

#[test]
fn a_margin_lands_at_the_same_relative_place_at_every_resolution() {
    // The whole point of the fixed reference: the box occupies the same fraction of the frame
    // whether the output is 720p or 4K.
    // Compared against the fraction itself rather than by dividing the results back out: that
    // round trip loses a bit and would test floating point rather than the layout rule.
    let horizontal = margin_fraction(192.0, 1_920.0);
    let vertical = 1.0 - margin_fraction(96.0, 1_080.0);
    let small = resolve(SubtitlePosition::Bottom, 1_280.0, 720.0);
    let large = resolve(SubtitlePosition::Bottom, 3_840.0, 2_160.0);
    assert_eq!(small.left, 1_280.0 * horizontal);
    assert_eq!(large.left, 3_840.0 * horizontal);
    assert_eq!(small.anchor_y, 720.0 * vertical);
    assert_eq!(large.anchor_y, 2_160.0 * vertical);
}

#[test]
fn margins_and_sizes_scale_by_different_rules() {
    // Pinned deliberately. A font size doubles from 1080p to 2160p; a margin's fraction does not
    // change at all. Unifying them would move every existing project's subtitles.
    let font_at_1080 = scale_subtitle_style_value(28.0, 1_080.0);
    let font_at_2160 = scale_subtitle_style_value(28.0, 2_160.0);
    assert_eq!(font_at_2160, font_at_1080 * 2.0);

    // The margin's fraction is identical at both resolutions, so the anchor is the same relative
    // place while the text around it has doubled in size.
    let vertical = 1.0 - margin_fraction(96.0, 1_080.0);
    assert_eq!(
        resolve(SubtitlePosition::Bottom, 1_920.0, 1_080.0).anchor_y,
        1_080.0 * vertical
    );
    assert_eq!(
        resolve(SubtitlePosition::Bottom, 3_840.0, 2_160.0).anchor_y,
        2_160.0 * vertical
    );
}

#[test]
fn the_bottom_anchor_sits_its_margin_above_the_bottom_edge() {
    let resolved = resolve(SubtitlePosition::Bottom, 1_920.0, 1_080.0);
    // 96 of 1080 is 8.89% after the shipped two-decimal rounding.
    assert_eq!(resolved.anchor_y, 1_080.0 * (1.0 - 0.0889));
    assert_eq!(resolved.anchor_bias, 1.0);
}

#[test]
fn the_top_anchor_sits_its_margin_below_the_top_edge() {
    let resolved = resolve(SubtitlePosition::Top, 1_920.0, 1_080.0);
    assert_eq!(resolved.anchor_y, 1_080.0 * 0.05);
    assert_eq!(resolved.anchor_bias, 0.0);
}

#[test]
fn centring_discards_both_vertical_margins() {
    // Pinned deliberately: this is why a user's bottom margin appears to stop working the moment
    // they switch the position to centre.
    let centred = resolve(SubtitlePosition::Center, 1_920.0, 1_080.0);
    assert_eq!(centred.anchor_y, 540.0);
    assert_eq!(centred.anchor_bias, 0.5);

    let wider_margins = resolve_subtitle_box(
        SubtitlePosition::Center,
        Margins {
            bottom: 400.0,
            top: 400.0,
            left: 192.0,
            right: 192.0,
        },
        25.0,
        75.0,
        TextAlign::Center,
        1_920.0,
        1_080.0,
    );
    assert_eq!(wider_margins.anchor_y, centred.anchor_y);
}

#[test]
fn a_custom_position_discards_every_margin() {
    // Pinned deliberately: horizontal margins stop applying too, not only the vertical ones.
    let custom = resolve(SubtitlePosition::Custom, 1_920.0, 1_080.0);
    assert_eq!(custom.anchor_y, 810.0);
    assert_eq!(custom.left, 480.0);
    assert_eq!(custom.right, 480.0, "custom collapses the box to a point");
    assert_eq!(custom.anchor_bias, 0.5);
}

#[test]
fn horizontal_margins_inset_from_both_edges() {
    let resolved = resolve(SubtitlePosition::Bottom, 1_920.0, 1_080.0);
    assert_eq!(resolved.left, 1_920.0 * 0.1);
    assert_eq!(resolved.right, 1_920.0 * 0.9);
    assert!(resolved.right > resolved.left);
}

#[test]
fn margin_fractions_round_to_two_decimals_like_the_shipped_percentage() {
    // 1/1080 is 0.0925...%, which the renderer emits as 0.09%. At 4K that rounding is worth about
    // half a pixel, so it has to be reproduced rather than computed exactly.
    assert_eq!(margin_fraction(1.0, 1_080.0), 0.0009);
    assert_eq!(margin_fraction(0.0, 1_080.0), 0.0);
    assert_eq!(margin_fraction(1_080.0, 1_080.0), 1.0);
}

#[test]
fn a_margin_wider_than_the_frame_is_carried_through_rather_than_clamped() {
    // The shipped renderer does not clamp, and clamping here would silently change a project that
    // currently pushes its subtitles off screen.
    let resolved = resolve_subtitle_box(
        SubtitlePosition::Bottom,
        Margins {
            bottom: 5_000.0,
            top: 0.0,
            left: 0.0,
            right: 0.0,
        },
        0.0,
        0.0,
        TextAlign::Center,
        1_920.0,
        1_080.0,
    );
    assert!(
        resolved.anchor_y < 0.0,
        "the anchor leaves the frame, as it does today"
    );
}

#[test]
fn positions_and_alignments_round_trip_and_refuse_unknown_names() {
    for (wire, expected) in [
        ("bottom", SubtitlePosition::Bottom),
        ("top", SubtitlePosition::Top),
        ("center", SubtitlePosition::Center),
        ("custom", SubtitlePosition::Custom),
    ] {
        assert_eq!(SubtitlePosition::from_wire(wire), Some(expected));
    }
    for unknown in ["", "Bottom", "middle", "centre"] {
        assert_eq!(SubtitlePosition::from_wire(unknown), None, "{unknown:?}");
    }

    for (wire, expected) in [
        ("left", TextAlign::Left),
        ("center", TextAlign::Center),
        ("right", TextAlign::Right),
        ("justify", TextAlign::Justify),
    ] {
        assert_eq!(TextAlign::from_wire(wire), Some(expected));
    }
    for unknown in ["", "start", "Left"] {
        assert_eq!(TextAlign::from_wire(unknown), None, "{unknown:?}");
    }
}

#[test]
fn resolution_is_repeatable() {
    for width in [1_280.0_f64, 1_920.0, 3_840.0] {
        for position in [
            SubtitlePosition::Bottom,
            SubtitlePosition::Top,
            SubtitlePosition::Center,
            SubtitlePosition::Custom,
        ] {
            let height = width * 9.0 / 16.0;
            assert_eq!(
                resolve(position, width, height),
                resolve(position, width, height)
            );
        }
    }
}
