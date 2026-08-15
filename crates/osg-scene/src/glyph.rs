//! The Rust mirror of the `WebView` glyph-atlas descriptor.
//!
//! `src/platform/glyphAtlas.js` is the single glyph source: the `WebView` shapes and rasterizes the
//! selected face once and hands native code a bounded, versioned, immutable descriptor. This module
//! is the receiving end of that hand-off. It mirrors the descriptor field for field so the
//! compositor can consume it without a Rust text stack, and it refuses anything the baker could not
//! have produced.
//!
//! Three things this side must do that the baker cannot do for us:
//!
//! * **Gate the version.** A descriptor whose version this build does not implement is refused
//!   whole. Nothing is read out of it, because a field's meaning is only defined by its version.
//! * **Bound the input.** The baker enforces `GLYPH_ATLAS_LIMITS` on the way out, but nothing
//!   guarantees that the bytes arriving here came from the baker. Every limit is mirrored as a
//!   constant and enforced again, and the two sequences that could grow without bound — the glyph
//!   list and the pixel buffer — stop growing mid-read rather than after the allocation.
//! * **Check what only this side can check.** Field agreement survives a boundary only if someone
//!   re-derives it: glyph rectangles must lie inside the atlas, the pixel buffer must match the
//!   declared geometry, and every field the baker computed from another field must still agree
//!   with it.
//!
//! Two descriptor fields record honest limits rather than results, and ignoring either silently
//! produces wrong pixels, so [`GlyphAtlasDescriptor::cell_advance_layout`] turns both into one
//! `#[must_use]` verdict:
//!
//! * a non-zero `shapingResidualPx` means kerning, a ligature or a contextual form crossed cluster
//!   boundaries, so the per-cell advances do not sum to the run;
//! * `direction` and `baseDirection` are first-strong classification only — the descriptor
//!   *reports* that a run is right-to-left, it does not reorder it.
//!
//! Errors name the field and never the value: a descriptor error may be logged, a user's subtitle
//! text and the atlas pixels may not.

use core::cmp::Ordering;
use core::marker::PhantomData;

use serde::de::{Error as _, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The only descriptor version this build understands, mirroring `GLYPH_ATLAS_VERSION`.
pub const GLYPH_ATLAS_VERSION: u32 = 1;

/// The most code points one baked text run may carry, mirroring `maxTextCodePoints`.
///
/// The descriptor does not carry the run's text, only its distinct clusters, so this is enforced
/// here against the total code points of those clusters — a quantity the run's own length bounds.
pub const MAX_TEXT_CODE_POINTS: usize = 4_096;
/// The most distinct glyph cells one atlas may carry, mirroring `maxGlyphCount`.
pub const MAX_GLYPH_COUNT: usize = 1_024;
/// The most code points one grapheme cluster may carry, mirroring `maxClusterCodePoints`.
pub const MAX_CLUSTER_CODE_POINTS: usize = 32;
/// The largest atlas edge in pixels, mirroring `maxAtlasDimensionPx`.
pub const MAX_ATLAS_DIMENSION_PX: u32 = 4_096;
/// The smallest bakeable font size in pixels, mirroring `minFontSizePx`.
pub const MIN_FONT_SIZE_PX: f64 = 4.0;
/// The largest bakeable font size in pixels, mirroring `maxFontSizePx`.
pub const MAX_FONT_SIZE_PX: f64 = 512.0;
/// The most UTF-16 code units a family name may carry, mirroring `maxFamilyCharacters`.
///
/// Measured in UTF-16 code units because the baker measures `String.prototype.length`; anything the
/// baker accepts therefore passes here too.
pub const MAX_FAMILY_CHARACTERS: usize = 64;
/// The most padding pixels around a glyph cell, mirroring `maxPaddingPx`.
pub const MAX_PADDING_PX: u32 = 8;

/// The widest row an in-bounds RGBA8 atlas can need, including alignment padding.
///
/// Derived from [`MAX_ATLAS_DIMENSION_PX`]: a 4096-pixel row is 16384 bytes, which is already a
/// multiple of the 256-byte copy alignment a GPU upload wants, so no legitimate row exceeds it.
pub const MAX_BYTES_PER_ROW: u32 = MAX_ATLAS_DIMENSION_PX * 4;
/// The largest pixel buffer an in-bounds atlas can need, derived from the two bounds above.
pub const MAX_PIXEL_BYTES: usize = 4_096 * 4_096 * 4;
/// The number of generic families the baker probes to detect face substitution.
pub const MAX_FACE_PROBES: usize = 3;
/// The most bytes a CSS font shorthand may carry. Derived: the shorthand is style, weight, size and
/// one quoted family, and the family is already bounded.
pub const MAX_CSS_FONT_BYTES: usize = 256;
/// The digit count of the baker's content hash, which is a zero-padded 32-bit value in lower-case
/// hexadecimal.
pub const CONTENT_HASH_DIGITS: usize = 8;

/// Why a glyph atlas descriptor was refused.
///
/// Deliberately coarse and value-free: every variant names the field that failed, never its
/// contents, so a refusal can be logged without leaking subtitle text, a family name or atlas
/// pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphAtlasError {
    /// The descriptor declared a version this build does not implement.
    UnsupportedVersion,
    /// The requested family, the weight or the CSS shorthand is not one the baker could emit.
    UnsupportedFace,
    /// The font size is outside the bakeable range.
    UnsupportedFontSize,
    /// The substitution probes are missing, duplicated, or show a face that never participated.
    UnsupportedProbes,
    /// A face metric is not a finite, non-negative number.
    UnsupportedMetrics,
    /// The run's base direction is not a first-strong classification the baker could emit.
    UnsupportedDirection,
    /// The atlas is larger than the supported dimension.
    UnsupportedAtlasSize,
    /// The cell padding is larger than the supported padding.
    UnsupportedPadding,
    /// The row stride is narrower than a row of pixels, wider than any atlas needs, or not a whole
    /// number of pixels.
    UnsupportedRowStride,
    /// There are more glyph cells than the supported count.
    UnsupportedGlyphCount,
    /// A cluster is empty, too long, or does not match the code points recorded beside it.
    UnsupportedCluster,
    /// The glyph cells are not in the baker's strictly increasing cluster order.
    UnorderedGlyphs,
    /// The clusters together carry more code points than a bakeable run.
    UnsupportedTextLength,
    /// A glyph's source rectangle is not wholly inside the atlas.
    GlyphOutsideAtlas,
    /// The declared glyph count disagrees with the glyph list.
    GlyphCountMismatch,
    /// The pixel buffer is not exactly the declared height times the declared row stride.
    PixelBufferMismatch,
    /// A field the baker derived from another field no longer agrees with it.
    DerivedFieldMismatch,
    /// The content hash is not eight lower-case hexadecimal digits.
    UnsupportedContentHash,
}

impl core::fmt::Display for GlyphAtlasError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let message = match self {
            Self::UnsupportedVersion => "the glyph atlas version is not supported",
            Self::UnsupportedFace => "the glyph atlas face identity is not supported",
            Self::UnsupportedFontSize => "the glyph atlas font size is not supported",
            Self::UnsupportedProbes => "the glyph atlas face probes are not supported",
            Self::UnsupportedMetrics => "the glyph atlas metrics are not supported",
            Self::UnsupportedDirection => "the glyph atlas base direction is not supported",
            Self::UnsupportedAtlasSize => "the glyph atlas is larger than is supported",
            Self::UnsupportedPadding => "the glyph atlas padding is not supported",
            Self::UnsupportedRowStride => "the glyph atlas row stride is not supported",
            Self::UnsupportedGlyphCount => "the glyph atlas carries more cells than is supported",
            Self::UnsupportedCluster => "a glyph atlas cluster is not supported",
            Self::UnorderedGlyphs => "the glyph atlas cells are not in cluster order",
            Self::UnsupportedTextLength => "the glyph atlas clusters are longer than is supported",
            Self::GlyphOutsideAtlas => "a glyph atlas cell lies outside the atlas",
            Self::GlyphCountMismatch => "the glyph atlas cell count disagrees with its cells",
            Self::PixelBufferMismatch => "the glyph atlas pixel buffer disagrees with its geometry",
            Self::DerivedFieldMismatch => "a derived glyph atlas field disagrees with its source",
            Self::UnsupportedContentHash => "the glyph atlas content hash is not supported",
        };
        formatter.write_str(message)
    }
}

impl core::error::Error for GlyphAtlasError {}

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

/// A first-strong direction classification. Not a bidi resolution: the compositor owns reordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    pub shaping_residual_px: f64,
    /// The run's first-strong direction — a classification, not a bidi resolution.
    pub base_direction: Direction,
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
    /// The rasterized cells, in the baker's strictly increasing cluster order.
    #[serde(deserialize_with = "deserialize_glyphs")]
    pub glyphs: Vec<AtlasGlyph>,
    /// The baker's non-cryptographic identity for this atlas. Cache key only, never a boundary.
    pub content_hash: String,
    /// Tightly packed coverage pixels. Empty when the run has no ink.
    ///
    /// Self-describing formats encode this as bytes; JSON encodes it as an array of numbers. Either
    /// way the read stops at [`MAX_PIXEL_BYTES`] rather than allocating whatever was offered.
    #[serde(deserialize_with = "deserialize_pixels")]
    pub pixels: Vec<u8>,
}

/// A checked glyph atlas descriptor.
///
/// Holding one means every bound in `GLYPH_ATLAS_LIMITS` holds, every glyph cell lies inside the
/// atlas, the pixel buffer matches the declared geometry, and every derived field still agrees with
/// what it was derived from.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "UncheckedGlyphAtlas")]
pub struct GlyphAtlasDescriptor {
    inner: UncheckedGlyphAtlas,
}

impl Serialize for GlyphAtlasDescriptor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Checking cannot change the wire shape, so a checked descriptor serializes as exactly the
        // descriptor it was built from and a round trip is lossless.
        self.inner.serialize(serializer)
    }
}

impl TryFrom<UncheckedGlyphAtlas> for GlyphAtlasDescriptor {
    type Error = GlyphAtlasError;

    fn try_from(unchecked: UncheckedGlyphAtlas) -> Result<Self, Self::Error> {
        validate(&unchecked)?;
        Ok(Self { inner: unchecked })
    }
}

impl GlyphAtlasDescriptor {
    /// The descriptor version, which is always [`GLYPH_ATLAS_VERSION`].
    #[must_use]
    pub const fn version(&self) -> u32 {
        self.inner.version
    }

    /// The face the atlas was baked from.
    #[must_use]
    pub const fn face(&self) -> &AtlasFace {
        &self.inner.face
    }

    /// The run's metrics.
    #[must_use]
    pub const fn metrics(&self) -> &AtlasMetrics {
        &self.inner.metrics
    }

    /// The atlas geometry.
    #[must_use]
    pub const fn atlas(&self) -> &AtlasGeometry {
        &self.inner.atlas
    }

    /// The rasterized cells, in cluster order.
    #[must_use]
    pub fn glyphs(&self) -> &[AtlasGlyph] {
        &self.inner.glyphs
    }

    /// The baker's identity for this atlas.
    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.inner.content_hash
    }

    /// The coverage pixels, exactly `height_px * bytes_per_row` bytes long.
    #[must_use]
    pub fn pixels(&self) -> &[u8] {
        &self.inner.pixels
    }

    /// Whether the compositor may place cells by accumulating per-cluster advances.
    ///
    /// The descriptor records two limits rather than results, and both are easy to walk past: a
    /// non-zero shaping residual means the advances do not sum to the run, and a right-to-left
    /// classification is not a reordering. The verdict is `#[must_use]` and is not a `bool`, so
    /// neither can be dropped or read with the sense inverted by accident.
    pub fn cell_advance_layout(&self) -> CellAdvanceLayout {
        // The baker rounds the residual to four decimals and normalises negative zero, so any
        // value that is not zero is one it measured.
        let shaping_crosses_clusters = self.inner.metrics.shaping_residual_px != 0.0;
        let direction_needs_bidi = self.inner.metrics.base_direction == Direction::Rtl
            || self
                .inner
                .glyphs
                .iter()
                .any(|glyph| glyph.direction == Direction::Rtl);
        if shaping_crosses_clusters || direction_needs_bidi {
            CellAdvanceLayout::Refused(LayoutRefusal {
                shaping_crosses_clusters,
                direction_needs_bidi,
            })
        } else {
            CellAdvanceLayout::Reproduces
        }
    }
}

/// The verdict on laying a run out from per-cell advances alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use = "the descriptor records limits that layout must respect, not advice it may drop"]
pub enum CellAdvanceLayout {
    /// The per-cluster advances sum to the measured run and no cell needs reordering, so
    /// accumulating advances reproduces what the `WebView` measured.
    Reproduces,
    /// Accumulating advances would not reproduce the run; [`LayoutRefusal`] says why.
    Refused(LayoutRefusal),
}

impl CellAdvanceLayout {
    /// Whether accumulating per-cluster advances reproduces the run.
    #[must_use]
    pub const fn reproduces(self) -> bool {
        matches!(self, Self::Reproduces)
    }
}

/// Why accumulating per-cell advances would be wrong. Both reasons can hold at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutRefusal {
    /// Kerning, a ligature or a contextual form moved ink across a cluster boundary, so the
    /// per-cell advances do not sum to the measured run.
    pub shaping_crosses_clusters: bool,
    /// The run carries right-to-left text. The descriptor classifies direction first-strong; it
    /// does not resolve bidi, so cell order is not visual order.
    pub direction_needs_bidi: bool,
}

// Validation

fn validate(atlas: &UncheckedGlyphAtlas) -> Result<(), GlyphAtlasError> {
    // First and alone: a field's meaning is defined by the version, so an unknown one is refused
    // before anything else is looked at rather than read as far as it happens to parse.
    if atlas.version != GLYPH_ATLAS_VERSION {
        return Err(GlyphAtlasError::UnsupportedVersion);
    }
    validate_face(&atlas.face)?;
    validate_metrics(&atlas.metrics)?;
    validate_geometry(&atlas.atlas)?;
    validate_glyphs(&atlas.glyphs, &atlas.atlas)?;
    validate_agreements(atlas)
}

/// The family shape the baker accepts: alphanumeric first, then alphanumerics, space, dot,
/// underscore or hyphen. Rust's `is_alphanumeric` is a superset of the baker's `\p{L}\p{N}`, so
/// nothing the baker emits is refused here.
fn is_supported_family(family: &str) -> bool {
    let mut characters = family.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_alphanumeric()
        && family.encode_utf16().count() <= MAX_FAMILY_CHARACTERS
        && family.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, ' ' | '.' | '_' | '-')
        })
}

fn validate_face(face: &AtlasFace) -> Result<(), GlyphAtlasError> {
    if !is_supported_family(&face.requested_family) || !matches!(face.weight, 1..=1_000) {
        return Err(GlyphAtlasError::UnsupportedFace);
    }
    // The shorthand is never parsed here, only bounded and kept loggable, and it must still name
    // the family it claims to have measured.
    if face.css_font.is_empty()
        || face.css_font.len() > MAX_CSS_FONT_BYTES
        || face.css_font.chars().any(char::is_control)
        || !face
            .css_font
            .contains(&format!("\"{}\"", face.requested_family))
    {
        return Err(GlyphAtlasError::UnsupportedFace);
    }
    if !face.font_size_px.is_finite()
        || !(MIN_FONT_SIZE_PX..=MAX_FONT_SIZE_PX).contains(&face.font_size_px)
    {
        return Err(GlyphAtlasError::UnsupportedFontSize);
    }
    validate_probes(&face.probes)
}

fn validate_probes(probes: &[FaceProbe]) -> Result<(), GlyphAtlasError> {
    // Substitution is only detectable when all three independent generics were measured; fewer
    // probes would make the descriptor's own claim weaker than it looks.
    if probes.len() != MAX_FACE_PROBES {
        return Err(GlyphAtlasError::UnsupportedProbes);
    }
    for (index, probe) in probes.iter().enumerate() {
        if probes[..index]
            .iter()
            .any(|earlier| earlier.probe_family == probe.probe_family)
        {
            return Err(GlyphAtlasError::UnsupportedProbes);
        }
        if !probe.alone_width_px.is_finite()
            || probe.alone_width_px < 0.0
            || !probe.chained_width_px.is_finite()
            || probe.chained_width_px < 0.0
        {
            return Err(GlyphAtlasError::UnsupportedProbes);
        }
        #[expect(
            clippy::float_cmp,
            reason = "re-derives the baker's own exact comparison of two 4dp-rounded widths"
        )]
        let differs = probe.alone_width_px != probe.chained_width_px;
        if differs != probe.participated {
            return Err(GlyphAtlasError::DerivedFieldMismatch);
        }
    }
    // Every chain matching its generic is exactly how the baker detects an absent face, and it
    // refuses to bake one. A descriptor claiming otherwise did not come from a bake.
    if !probes.iter().any(|probe| probe.participated) {
        return Err(GlyphAtlasError::UnsupportedProbes);
    }
    Ok(())
}

fn validate_metrics(metrics: &AtlasMetrics) -> Result<(), GlyphAtlasError> {
    let non_negative = [
        metrics.ascent_px,
        metrics.descent_px,
        metrics.line_height_px,
        metrics.baseline_px,
        metrics.run_advance_width_px,
    ];
    if non_negative
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
        || !metrics.shaping_residual_px.is_finite()
    {
        return Err(GlyphAtlasError::UnsupportedMetrics);
    }
    // The baker resolves a run with no strong character to left-to-right, so a neutral base
    // direction is not something it can emit.
    if metrics.base_direction == Direction::Neutral {
        return Err(GlyphAtlasError::UnsupportedDirection);
    }
    Ok(())
}

fn validate_geometry(geometry: &AtlasGeometry) -> Result<(), GlyphAtlasError> {
    if geometry.width_px > MAX_ATLAS_DIMENSION_PX || geometry.height_px > MAX_ATLAS_DIMENSION_PX {
        return Err(GlyphAtlasError::UnsupportedAtlasSize);
    }
    if geometry.padding_px > MAX_PADDING_PX {
        return Err(GlyphAtlasError::UnsupportedPadding);
    }
    // Bounding the stride is what keeps the pixel buffer bounded: its length is checked against
    // height times stride, so an unbounded stride would licence an unbounded buffer.
    if u64::from(geometry.bytes_per_row) < u64::from(geometry.width_px) * 4
        || geometry.bytes_per_row > MAX_BYTES_PER_ROW
        || !geometry.bytes_per_row.is_multiple_of(4)
    {
        return Err(GlyphAtlasError::UnsupportedRowStride);
    }
    if usize::try_from(geometry.glyph_count).unwrap_or(usize::MAX) > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    Ok(())
}

fn validate_glyphs(glyphs: &[AtlasGlyph], geometry: &AtlasGeometry) -> Result<(), GlyphAtlasError> {
    if glyphs.len() > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    let mut total_code_points = 0_usize;
    let mut previous: Option<&str> = None;
    for glyph in glyphs {
        if glyph.cluster.is_empty()
            || glyph.code_points.is_empty()
            || glyph.code_points.len() > MAX_CLUSTER_CODE_POINTS
            || !glyph
                .cluster
                .chars()
                .map(u32::from)
                .eq(glyph.code_points.iter().copied())
            || !glyph.advance_width_px.is_finite()
            || glyph.advance_width_px < 0.0
        {
            return Err(GlyphAtlasError::UnsupportedCluster);
        }
        // Widened before adding: a cell that would wrap around the addressable range must fail as
        // an out-of-atlas cell, not as an in-range sum.
        if u64::from(glyph.x_px) + u64::from(glyph.width_px) > u64::from(geometry.width_px)
            || u64::from(glyph.y_px) + u64::from(glyph.height_px) > u64::from(geometry.height_px)
        {
            return Err(GlyphAtlasError::GlyphOutsideAtlas);
        }
        // The baker sorts distinct clusters by UTF-16 code unit, which is what makes the same glyph
        // set pack to the same atlas. Comparing the same way keeps astral clusters in the order the
        // baker put them, and strictness rejects a duplicated cell.
        if let Some(previous) = previous
            && previous.encode_utf16().cmp(glyph.cluster.encode_utf16()) != Ordering::Less
        {
            return Err(GlyphAtlasError::UnorderedGlyphs);
        }
        previous = Some(&glyph.cluster);
        total_code_points += glyph.code_points.len();
    }
    // The clusters are the run's distinct graphemes, so their code points cannot outnumber the
    // run's own — which is the bound the baker enforces on the text.
    if total_code_points > MAX_TEXT_CODE_POINTS {
        return Err(GlyphAtlasError::UnsupportedTextLength);
    }
    Ok(())
}

fn validate_agreements(atlas: &UncheckedGlyphAtlas) -> Result<(), GlyphAtlasError> {
    if usize::try_from(atlas.atlas.glyph_count).unwrap_or(usize::MAX) != atlas.glyphs.len() {
        return Err(GlyphAtlasError::GlyphCountMismatch);
    }
    if atlas.face.substituted != atlas.glyphs.iter().any(|glyph| glyph.substituted) {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    // A right-to-left base direction is the first strong cluster in the run, and every cluster in
    // the run has a cell, so at least one cell must be right-to-left too.
    if atlas.metrics.base_direction == Direction::Rtl
        && !atlas
            .glyphs
            .iter()
            .any(|glyph| glyph.direction == Direction::Rtl)
    {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    let declared = u64::from(atlas.atlas.height_px) * u64::from(atlas.atlas.bytes_per_row);
    if declared != u64::try_from(atlas.pixels.len()).unwrap_or(u64::MAX) {
        return Err(GlyphAtlasError::PixelBufferMismatch);
    }
    if atlas.content_hash.len() != CONTENT_HASH_DIGITS
        || !atlas
            .content_hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(GlyphAtlasError::UnsupportedContentHash);
    }
    Ok(())
}

// Bounded reading
//
// Validation runs after a value exists, which is too late for a sequence: a hostile descriptor
// would have allocated whatever it declared before anything looked at it. These readers stop at the
// bound instead, so the largest allocation a refused descriptor can cause is the bound itself.
// Strings are bounded by validation rather than here, because a self-describing format hands them
// over borrowed from the input that already exists.

struct BoundedSeq<T> {
    limit: usize,
    what: &'static str,
    marker: PhantomData<T>,
}

impl<T> BoundedSeq<T> {
    const fn new(limit: usize, what: &'static str) -> Self {
        Self {
            limit,
            what,
            marker: PhantomData,
        }
    }
}

impl<'de, T: Deserialize<'de>> Visitor<'de> for BoundedSeq<T> {
    type Value = Vec<T>;

    fn expecting(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "at most {} {}", self.limit, self.what)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        // The hint comes from the input, so it may only ever shrink the reservation.
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.limit));
        while let Some(value) = sequence.next_element()? {
            if values.len() == self.limit {
                return Err(A::Error::custom(format_args!(
                    "more than {} {}",
                    self.limit, self.what
                )));
            }
            values.push(value);
        }
        Ok(values)
    }
}

struct BoundedBytes;

impl<'de> Visitor<'de> for BoundedBytes {
    type Value = Vec<u8>;

    fn expecting(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "at most {MAX_PIXEL_BYTES} atlas pixel bytes")
    }

    fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<Self::Value, E> {
        if bytes.len() > MAX_PIXEL_BYTES {
            return Err(E::custom(format_args!(
                "more than {MAX_PIXEL_BYTES} atlas pixel bytes"
            )));
        }
        Ok(bytes.to_vec())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, sequence: A) -> Result<Self::Value, A::Error> {
        BoundedSeq::new(MAX_PIXEL_BYTES, "atlas pixel bytes").visit_seq(sequence)
    }
}

fn deserialize_probes<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<FaceProbe>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq::new(MAX_FACE_PROBES, "face probes"))
}

fn deserialize_code_points<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u32>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq::new(
        MAX_CLUSTER_CODE_POINTS,
        "cluster code points",
    ))
}

fn deserialize_glyphs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<AtlasGlyph>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq::new(MAX_GLYPH_COUNT, "atlas glyphs"))
}

fn deserialize_pixels<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    deserializer.deserialize_byte_buf(BoundedBytes)
}
