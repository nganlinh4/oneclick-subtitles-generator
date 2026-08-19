//! The descriptor as it appears on the wire, mirrored field for field from the baker.
//!
//! Nothing here decides whether a descriptor is usable: these types carry only the shape, the names
//! and the bounded reads. The rules live in [`super::validate`] and the checked type in
//! [`super::descriptor`].

use serde::{Deserialize, Serialize};

use super::bounded::{
    deserialize_code_points, deserialize_glyphs, deserialize_pixels, deserialize_probes,
};
use super::layout::AtlasLayout;

/// The generic family one substitution probe was measured against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeFamily {
    /// The engine's generic monospace face.
    Monospace,
    /// The engine's generic serif face.
    Serif,
    /// The engine's generic sans-serif face.
    SansSerif,
}

/// The style the face was requested in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaceStyle {
    /// Upright.
    Normal,
    /// The face's own italic.
    Italic,
    /// A slanted upright, when the face has no italic.
    Oblique,
}

/// A first-strong direction classification, per cell and per run.
///
/// Not a bidi resolution, and not the draw order either: the order cells are drawn in is
/// [`AtlasLine::glyphs`], which the baker emits in visual order.
///
/// [`AtlasLine::glyphs`]: super::layout::AtlasLine::glyphs
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Left to right.
    Ltr,
    /// Right to left.
    Rtl,
    /// No strong character, so the surrounding run decides.
    Neutral,
}

/// The pixel layout of the atlas. Coverage lives in the alpha channel; colour never bakes in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PixelFormat {
    /// Eight bits per channel, red first, tightly packed within a row.
    Rgba8,
}

/// One generic-family probe, and whether the requested face changed its measurement.
///
/// `participated` is derived: the baker sets it exactly when the two widths differ. It is kept as
/// data so this side can re-derive it and refuse a descriptor whose evidence and conclusion have
/// come apart.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FaceProbe {
    /// The generic family measured alone and chained after the requested family.
    pub probe_family: ProbeFamily,
    /// The probe string's width in the generic family alone.
    pub alone_width_px: f64,
    /// The probe string's width with the requested family in front of the generic one.
    pub chained_width_px: f64,
    /// Whether the requested family changed the measurement, and so took part in it.
    pub participated: bool,
}

/// The face the atlas was baked from, and the evidence that it was really that face.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasFace {
    /// The family the editor asked for.
    pub requested_family: String,
    /// The weight the shorthand asked for.
    pub weight: u16,
    /// The style the shorthand asked for.
    pub style: FaceStyle,
    /// The size the atlas was baked at, in pixels.
    pub font_size_px: f64,
    /// The CSS shorthand the baker measured and drew with. Carried for provenance; this side never
    /// interprets it.
    pub css_font: String,
    /// Whether any cell fell back to another face. Derived from the cells.
    pub substituted: bool,
    /// The generic-family probes that prove the face participated in the measurement.
    #[serde(deserialize_with = "deserialize_probes")]
    pub probes: Vec<FaceProbe>,
}

/// The run's vertical metrics and the two honest limits the compositor must respect.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasMetrics {
    /// Face ascent above the baseline, in pixels.
    pub ascent_px: f64,
    /// Face descent below the baseline, in pixels.
    pub descent_px: f64,
    /// The line box the run occupies, in pixels.
    pub line_height_px: f64,
    /// Where the baseline sits inside the line box, in pixels from its top.
    pub baseline_px: f64,
    /// The width the engine measured for the whole run, in pixels.
    pub run_advance_width_px: f64,
    /// The run advance minus the sum of the per-cluster advances.
    ///
    /// Non-zero means shaping crossed cluster boundaries, so laying the run out by accumulating
    /// cell advances would not reproduce it. See
    /// [`GlyphAtlasDescriptor::cell_advance_layout`].
    ///
    /// [`GlyphAtlasDescriptor::cell_advance_layout`]:
    ///     super::GlyphAtlasDescriptor::cell_advance_layout
    pub shaping_residual_px: f64,
    /// The run's first-strong direction — a classification, not a bidi resolution.
    pub base_direction: Direction,
    /// The spacing the layout added to every cluster advance, in pixels.
    ///
    /// **Signed.** Letter spacing tightens as well as loosens, so this is validated as finite and
    /// in range like [`Self::shaping_residual_px`], never as non-negative like [`Self::ascent_px`].
    /// It is carried in the metrics so a consumer positions from the spacing the `WebView` applied
    /// rather than re-deriving it from a style field that was scaled somewhere else.
    pub letter_spacing_px: f64,
}

/// The atlas geometry the pixel buffer is addressed with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasGeometry {
    /// Atlas width in pixels. Zero when the run has no ink.
    pub width_px: u32,
    /// Atlas height in pixels. Zero when the run has no ink.
    pub height_px: u32,
    /// The transparent margin baked around each cell, in pixels.
    pub padding_px: u32,
    /// How many cells the atlas carries. Derived from the cell list.
    pub glyph_count: u32,
    /// The pixel layout.
    pub pixel_format: PixelFormat,
    /// The byte stride of one pixel row, at least four bytes per pixel.
    pub bytes_per_row: u32,
}

/// One rasterized grapheme cluster and where its ink sits in the atlas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtlasGlyph {
    /// The grapheme cluster this cell was rasterized from.
    pub cluster: String,
    /// The cluster's code points, in order. Derived from the cluster.
    #[serde(deserialize_with = "deserialize_code_points")]
    pub code_points: Vec<u32>,
    /// The cluster's first-strong direction.
    pub direction: Direction,
    /// How far the pen moves after this cluster, in pixels.
    pub advance_width_px: f64,
    /// The cell's left edge in the atlas, in pixels.
    pub x_px: u32,
    /// The cell's top edge in the atlas, in pixels.
    pub y_px: u32,
    /// The cell's width in the atlas, in pixels. Zero when the cluster has no ink.
    pub width_px: u32,
    /// The cell's height in the atlas, in pixels. Zero when the cluster has no ink.
    pub height_px: u32,
    /// Where the pen sits inside the cell horizontally. Signed: ink may start right of the pen.
    pub origin_x_px: i32,
    /// Where the baseline sits inside the cell vertically. Signed for the same reason.
    pub origin_y_px: i32,
    /// Whether the engine drew this cluster with another face.
    pub substituted: bool,
}

/// The descriptor as it arrives: shape-checked and length-bounded, but not yet consistent.
///
/// This is the only way to build a [`GlyphAtlasDescriptor`], in Rust or over the wire, and the
/// conversion is where every bound and every agreement is checked.
///
/// [`GlyphAtlasDescriptor`]: super::GlyphAtlasDescriptor
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UncheckedGlyphAtlas {
    /// The descriptor schema version.
    pub version: u32,
    /// The face the atlas was baked from.
    pub face: AtlasFace,
    /// The run's metrics.
    pub metrics: AtlasMetrics,
    /// The atlas geometry.
    pub atlas: AtlasGeometry,
    /// The authoritative layout: where every cell is drawn, and on which baseline.
    ///
    /// A consumer places cells from this and nothing else. See [`super::layout`].
    pub layout: AtlasLayout,
    /// The rasterized cells, in the baker's strictly increasing cluster order.
    #[serde(deserialize_with = "deserialize_glyphs")]
    pub glyphs: Vec<AtlasGlyph>,
    /// The baker's non-cryptographic identity for this atlas. Cache key only, never a boundary.
    pub content_hash: String,
    /// Tightly packed coverage pixels. Empty when the run has no ink.
    ///
    /// Self-describing formats encode this as bytes; JSON encodes it as an array of numbers. Either
    /// way the read stops at [`MAX_PIXEL_BYTES`] rather than allocating whatever was offered.
    ///
    /// [`MAX_PIXEL_BYTES`]: super::MAX_PIXEL_BYTES
    #[serde(deserialize_with = "deserialize_pixels")]
    pub pixels: Vec<u8>,
}
