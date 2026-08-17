//! The text half of the stand-in bake: case mapping, cluster boundaries, direction and advances.
//!
//! Split from the descriptor assembly beside it because the two answer different questions. This
//! module answers "what are the cells and how wide are they" — the part a real font engine owns and
//! this one only stands in for. `super` answers "what does a descriptor carrying those cells look
//! like", which is the contract `osg_scene::glyph` validates and the part that has to be exact.
//!
//! None of this is a shaper. Advances are a fixed function of the cluster's first code point and
//! the face weight, and cluster boundaries are a bounded approximation of UAX #29 that covers the
//! nine texts the matrix carries. The browser owns the real answers and the browser's suites test
//! them; what this makes possible is rendering the whole matrix without one.

use osg_render::TextTransform;
use osg_scene::glyph::Direction;

use super::{ADVANCE_SPREAD, CELL_PX, MAX_INK_PX, MIN_ADVANCE_PX};

/// The case mapping, applied before segmentation because it decides the cluster count.
pub(super) fn transform(text: &str, transform: TextTransform) -> String {
    match transform {
        TextTransform::None => text.to_owned(),
        TextTransform::Uppercase => text.to_uppercase(),
        TextTransform::Lowercase => text.to_lowercase(),
        TextTransform::Capitalize => text
            .split_inclusive(' ')
            .map(|word| {
                let mut characters = word.chars();
                characters.next().map_or_else(String::new, |first| {
                    first.to_uppercase().collect::<String>() + characters.as_str()
                })
            })
            .collect(),
    }
}

/// Whether a character continues the cluster before it.
///
/// A bounded approximation of UAX #29's `Extend`, `ZWJ` and regional-indicator rules, covering the
/// combining marks, variation selectors, zero-width joiners and flag sequences the matrix's nine
/// texts carry. Anything outside these ranges starts its own cluster, which is the conservative
/// direction: it produces more cells, never fewer.
pub(super) fn is_extend(character: char) -> bool {
    matches!(
        u32::from(character),
        0x0300..=0x036F
            | 0x0483..=0x0489
            | 0x0591..=0x05BD
            | 0x05BF
            | 0x05C1..=0x05C2
            | 0x0610..=0x061A
            | 0x064B..=0x065F
            | 0x0670
            | 0x06D6..=0x06DC
            | 0x06DF..=0x06E4
            | 0x0E31
            | 0x0E34..=0x0E3A
            | 0x0E47..=0x0E4E
            | 0x1AB0..=0x1AFF
            | 0x20D0..=0x20F0
            | 0xFE00..=0xFE0F
            | 0x200D
    )
}

pub(super) fn is_regional_indicator(character: char) -> bool {
    matches!(u32::from(character), 0x1F1E6..=0x1F1FF)
}

/// Splits `text` into grapheme-ish clusters, in logical order.
pub(super) fn clusters(text: &str) -> Vec<String> {
    let mut clusters: Vec<String> = Vec::new();
    let mut joiner = false;
    for character in text.chars() {
        let continues = if joiner || is_extend(character) {
            true
        } else if is_regional_indicator(character) {
            clusters.last().is_some_and(|last| {
                last.chars().count() == 1 && last.chars().all(is_regional_indicator)
            })
        } else {
            false
        };
        joiner = u32::from(character) == 0x200D;
        if continues && let Some(last) = clusters.last_mut() {
            last.push(character);
        } else {
            clusters.push(character.to_string());
        }
    }
    clusters
}

/// A cluster's first-strong direction.
pub(super) fn direction_of(cluster: &str) -> Direction {
    for character in cluster.chars() {
        let code = u32::from(character);
        if matches!(
            code,
            0x0590..=0x05FF | 0x0600..=0x07BF | 0x0860..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF
        ) {
            return Direction::Rtl;
        }
        if character.is_alphabetic() {
            return Direction::Ltr;
        }
    }
    Direction::Neutral
}

/// Orders clusters the way the baker packs them: by UTF-16 code unit.
pub(super) fn utf16_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// How far the pen moves after a cluster, with letter spacing already in it.
///
/// Letter spacing is added to **every** advance including the last, which is what a browser does
/// and what `RENDER_PARITY_LEDGER.letterSpacing` records. A spacing tight enough to drive an
/// advance negative clamps at zero rather than producing a cell the descriptor would refuse.
pub(super) fn advance_of(cluster: &str, letter_spacing: f64) -> f64 {
    let seed = cluster.chars().next().map_or(0, u32::from);
    let base = MIN_ADVANCE_PX + f64::from(seed % ADVANCE_SPREAD);
    round4((base + letter_spacing).max(0.0))
}

/// How wide a cluster's ink is inside its cell.
///
/// Weight widens the ink, as a heavier face does. The persisted weight has to reach the *pixels*
/// somewhere or a gate could not tell a bold export from a light one, and in the real pipeline it
/// reaches them through the bake — `src/services/fontIdentity.js` resolves the face and the baker
/// rasterizes from it. This is the stand-in's version of that.
/// Bounded by [`MAX_INK_PX`] rather than by the cell square: the cell's box carries a transparent
/// ring around the ink, so ink as wide as the square would leave no ring to blend against.
pub(super) fn ink_width(cluster: &str, weight: u16) -> u32 {
    let seed = cluster.chars().next().map_or(0, u32::from);
    let stem = u32::from(weight) / 300;
    (2 + stem + (seed % (CELL_PX - 6))).min(MAX_INK_PX)
}

pub(super) fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}
