//! The authoritative layout, mirrored field for field from `buildTextLayout`.
//!
//! **This is the only place any of these numbers are decided.** The `WebView` owns the font stack,
//! `Intl.Segmenter` and the browser's own text engine, so it is the only side that can answer where
//! a glyph goes. It answers once, here, and the compositor draws what it says: glyph positions,
//! baselines, line boxes, wrapping and visual run order all live in this structure and nowhere else.
//!
//! Two consequences the receiving side must honour rather than work around:
//!
//! * [`AtlasLine::glyphs`] is in **visual order** — left to right as drawn — and [`AtlasLine::pen_x_px`]
//!   gives each cell's exact line-relative position. A consumer that re-accumulates advances, re-wraps
//!   or re-orders is building a second layout model, which is exactly what this contract exists to
//!   prevent.
//! * [`AtlasLayout::refusal`] carries the baker's own verdict. `shaping_crosses_clusters` is
//!   re-derived on this side from the residuals, because it can be; `direction_needs_bidi` cannot be,
//!   because the baker clearing it is precisely the claim that it emitted visual order. It is taken
//!   as the baker's word and turned into a `#[must_use]` verdict rather than a boolean nobody reads.
//!
//! Every quantity here is in **atlas pixel space** — the space the atlas was baked in, where the
//! face is `fontSizePx` tall. A consumer scales the whole run by `fontSize / atlasFontSize`.

use serde::{Deserialize, Serialize};

use super::bounded::{deserialize_line_cells, deserialize_lines, deserialize_pen_positions};

/// The case mapping applied before segmentation, so it is already in the clusters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextTransform {
    /// The text as authored.
    None,
    /// Upper-cased.
    Uppercase,
    /// Lower-cased.
    Lowercase,
    /// Word-initial letters upper-cased.
    Capitalize,
}

/// How the run's lines align, in the baker's vocabulary.
///
/// Carried as provenance for what the baker justified against. Only `justify` changes what the
/// baker emits; where a line box sits inside the subtitle box is decided by the consumer's own box
/// anchor, which is where the shipped renderer decided it too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutTextAlign {
    /// Against the leading edge.
    Left,
    /// Centred.
    Center,
    /// Against the trailing edge.
    Right,
    /// Stretched to the wrap width by growing the gaps.
    Justify,
}

/// The baker's own verdict on whether these positions reproduce what it measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CellAdvanceVerdict {
    /// The emitted positions reproduce the measured run.
    Reproduces,
    /// They do not; [`AtlasLayout::refusal`] says why.
    Refused,
}

/// Why the baker refuses to vouch for its own cell positions. Both reasons can hold at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutRefusal {
    /// Kerning, a ligature or a contextual form moved ink across a cluster boundary, so the
    /// per-cell advances do not sum to the measured run.
    ///
    /// Re-derived on this side from the run and per-line residuals, so a descriptor whose evidence
    /// and conclusion have come apart is refused.
    pub shaping_crosses_clusters: bool,
    /// The run carries right-to-left text the baker could not resolve into visual order.
    ///
    /// Taken as the baker's word: it is the only side that can know whether the order it emitted is
    /// visual, so this side must not re-derive it from cell directions. A run whose cells are
    /// right-to-left and whose baker cleared this flag is a run the baker reordered.
    pub direction_needs_bidi: bool,
}

/// One laid-out line: the cells it draws, where each one sits, and where its baseline is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasLine {
    /// The atlas cells this line draws, **in visual order**.
    #[serde(deserialize_with = "deserialize_line_cells")]
    pub glyphs: Vec<u32>,
    /// Each cell's line-relative pen position, in atlas pixels. Same length as [`Self::glyphs`].
    ///
    /// Letter spacing and justification are already in these numbers. They are positions, not
    /// deltas: a consumer indexes them, it does not accumulate them.
    #[serde(deserialize_with = "deserialize_pen_positions")]
    pub pen_x_px: Vec<f64>,
    /// What alignment measures. Trailing spaces hang past it, as they do in CSS.
    pub advance_width_px: f64,
    /// What the engine measured for this line's text, for comparison with the placed advances.
    pub measured_width_px: f64,
    /// This line's measured width minus the sum of its cell advances.
    ///
    /// Non-zero means ink crossed a cluster boundary on this line, so these positions do not
    /// reproduce it. Signed, like the run-level residual.
    pub shaping_residual_px: f64,
    /// Where this line's baseline sits inside the run box, in atlas pixels from its top.
    pub baseline_y_px: f64,
    /// How much each interior gap on this line was widened to justify it. Zero when it was not.
    pub justification_px: f64,
    /// Whether this line ends its paragraph, which is what makes it exempt from justification.
    pub ends_paragraph: bool,
}

/// The whole run's layout: what was asked for, what came out, and whether it can be trusted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasLayout {
    /// The case mapping already applied to the clusters.
    pub text_transform: TextTransform,
    /// The spacing added to every cluster advance, in atlas pixels. Signed.
    pub letter_spacing_px: f64,
    /// The wrap width in atlas pixels, or `None` when the run was not wrapped.
    pub max_width_px: Option<f64>,
    /// Whether soft wrapping was on. False is CSS `white-space: nowrap`, not a different wrap rule.
    pub word_wrap: bool,
    /// The alignment the run was laid out for.
    pub text_align: LayoutTextAlign,
    /// How many lines the run occupies. Derived from [`Self::lines`].
    pub line_count: u32,
    /// The widest line's advance width, in atlas pixels. Derived from [`Self::lines`].
    pub width_px: f64,
    /// The run box's height, in atlas pixels: the line count times the line box.
    pub height_px: f64,
    /// The baker's verdict on its own positions.
    pub cell_advance_layout: CellAdvanceVerdict,
    /// Why, when the verdict is [`CellAdvanceVerdict::Refused`].
    pub refusal: LayoutRefusal,
    /// The lines, top to bottom.
    #[serde(deserialize_with = "deserialize_lines")]
    pub lines: Vec<AtlasLine>,
}

impl AtlasLayout {
    /// How many cells the whole run places, across every line.
    #[must_use]
    pub fn placed_cells(&self) -> usize {
        self.lines.iter().map(|line| line.glyphs.len()).sum()
    }
}
