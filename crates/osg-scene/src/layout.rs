//! Where the subtitle box sits in the composition.
//!
//! This is where the renderer's two different scaling rules meet, and getting it wrong is the
//! easiest way to make an export disagree with a preview:
//!
//! * Sizes — font size, letter spacing, radii, shadow offsets — scale with the composition height
//!   through [`crate::scale::scale_subtitle_style_value`], so they grow with the output.
//! * Margins do not. They are converted to a percentage of a fixed 1920x1080 reference and applied
//!   as a percentage of the actual composition, so the same margin lands at the same *relative*
//!   place at every resolution while the text around it changes size.
//!
//! Both are shipped behaviour. Unifying them would move every existing project's subtitles, so the
//! difference is reproduced and pinned rather than tidied away.

use crate::scale::scale_subtitle_style_value;

/// The reference the margin percentages are computed against, independent of the real output.
const REFERENCE_WIDTH: f64 = 1_920.0;
const REFERENCE_HEIGHT: f64 = 1_080.0;

/// Where the subtitle box is anchored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitlePosition {
    /// Offset up from the bottom edge by the bottom margin.
    Bottom,
    /// Offset down from the top edge by the top margin.
    Top,
    /// Vertically centred, ignoring both vertical margins.
    Center,
    /// Placed at an explicit percentage of the composition, ignoring every margin.
    Custom,
}

impl SubtitlePosition {
    /// Parse the wire name, refusing anything unrecognised.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "bottom" => Self::Bottom,
            "top" => Self::Top,
            "center" => Self::Center,
            "custom" => Self::Custom,
            _ => return None,
        })
    }
}

/// How the text sits inside the box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAlign {
    /// Against the leading edge.
    Left,
    /// Centred.
    Center,
    /// Against the trailing edge.
    Right,
    /// Justified. Renders today but has no editor control.
    Justify,
}

impl TextAlign {
    /// Parse the wire name, refusing anything unrecognised.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "left" => Self::Left,
            "center" => Self::Center,
            "right" => Self::Right,
            "justify" => Self::Justify,
            _ => return None,
        })
    }
}

/// The margins in reference pixels, exactly as the editor stores them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margins {
    /// Distance from the bottom edge when anchored to the bottom.
    pub bottom: f64,
    /// Distance from the top edge when anchored to the top.
    pub top: f64,
    /// Distance from the leading edge, applied unless positioned custom.
    pub left: f64,
    /// Distance from the trailing edge, applied unless positioned custom.
    pub right: f64,
}

/// The resolved box, in composition pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SubtitleBox {
    /// Leading edge, in composition pixels from the left.
    pub left: f64,
    /// Trailing edge, in composition pixels from the left.
    pub right: f64,
    /// The vertical anchor, in composition pixels from the top.
    pub anchor_y: f64,
    /// How the anchor relates to the box: 0.0 is its top edge, 0.5 its centre, 1.0 its bottom.
    pub anchor_bias: f64,
    /// How the text aligns inside the box.
    pub align: TextAlign,
}

/// Convert a reference-pixel margin to a fraction of the composition.
///
/// The percentage is computed against the fixed reference and then applied to the real size, and it
/// is rounded to two decimals first because the shipped renderer emits a two-decimal CSS
/// percentage. Reproducing that rounding matters: at 4K a hundredth of a percent is half a pixel.
#[must_use]
pub fn margin_fraction(margin: f64, reference: f64) -> f64 {
    let percentage = (margin / reference) * 100.0;
    round_two_decimals(percentage) / 100.0
}

fn round_two_decimals(value: f64) -> f64 {
    // The same two-decimal rounding the size path uses, so the two agree on ties.
    scale_subtitle_style_value(value, REFERENCE_HEIGHT)
}

/// Resolve the subtitle box for a composition.
///
/// `custom_x` and `custom_y` are percentages of the composition and are only consulted when the
/// position is [`SubtitlePosition::Custom`], which also discards every margin — shipped behaviour
/// that surprises users who set both.
#[must_use]
pub fn resolve_subtitle_box(
    position: SubtitlePosition,
    margins: Margins,
    custom_x: f64,
    custom_y: f64,
    align: TextAlign,
    composition_width: f64,
    composition_height: f64,
) -> SubtitleBox {
    if position == SubtitlePosition::Custom {
        let centre_x = composition_width * (custom_x / 100.0);
        return SubtitleBox {
            left: centre_x,
            right: centre_x,
            anchor_y: composition_height * (custom_y / 100.0),
            anchor_bias: 0.5,
            align,
        };
    }

    let left = composition_width * margin_fraction(margins.left, REFERENCE_WIDTH);
    let right = composition_width * (1.0 - margin_fraction(margins.right, REFERENCE_WIDTH));

    let (anchor_y, anchor_bias) = match position {
        SubtitlePosition::Bottom => (
            composition_height * (1.0 - margin_fraction(margins.bottom, REFERENCE_HEIGHT)),
            1.0,
        ),
        SubtitlePosition::Top => (
            composition_height * margin_fraction(margins.top, REFERENCE_HEIGHT),
            0.0,
        ),
        // Centring ignores both vertical margins, which is why a user's bottom margin appears to do
        // nothing once they switch to centre.
        SubtitlePosition::Center | SubtitlePosition::Custom => (composition_height * 0.5, 0.5),
    };

    SubtitleBox {
        left,
        right,
        anchor_y,
        anchor_bias,
        align,
    }
}
