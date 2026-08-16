//! The bounds the baker enforces on the way out, mirrored so they can be enforced again on the way
//! in. Nothing here interprets a descriptor; these are the numbers every other glyph module quotes.

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

/// The most lines one laid-out run may carry, mirroring `maxLayoutLines`.
///
/// A structural bound on the payload, not the persisted `maxLines` setting — that one is inert on
/// both sides and stays inert.
pub const MAX_LAYOUT_LINES: usize = 64;
/// The most placed cells one laid-out run may carry, mirroring `maxLayoutCells`.
pub const MAX_LAYOUT_CELLS: usize = 4_096;
/// The widest wrap width the layout arithmetic accepts, mirroring `maxLayoutWidthPx`.
pub const MAX_LAYOUT_WIDTH_PX: f64 = 1_048_576.0;
/// The most negative letter spacing the baker accepts, mirroring `minLetterSpacingPx`.
///
/// Signed on purpose: letter spacing tightens as well as loosens, so it is bounded on both sides
/// rather than checked for non-negativity like a face metric.
pub const MIN_LETTER_SPACING_PX: f64 = -100.0;
/// The most positive letter spacing the baker accepts, mirroring `maxLetterSpacingPx`.
pub const MAX_LETTER_SPACING_PX: f64 = 1_000.0;

/// How far a re-derived layout quantity may sit from the baker's own, in pixels.
///
/// The baker rounds every emitted layout number to four decimals, so a value this side recomputes
/// from other emitted numbers cannot be compared bit for bit: two four-decimal roundings differ by
/// up to 1e-4 each. A thousandth of an atlas pixel is far below anything that could reach a
/// composed frame, and far above the rounding.
pub const LAYOUT_TOLERANCE_PX: f64 = 1e-3;

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
