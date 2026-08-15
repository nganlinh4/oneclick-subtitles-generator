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
//!
//! Those responsibilities are private modules, re-exported here so the descriptor keeps one flat
//! public surface: `limits` mirrors the bounds, `wire` mirrors the shape, `bounded` stops a hostile
//! sequence mid-read, `validate` judges a descriptor, `error` names why one was refused, and
//! `descriptor` is the checked type that judgement produces.

mod bounded;
mod descriptor;
mod error;
mod limits;
mod validate;
mod wire;

pub use self::descriptor::{CellAdvanceLayout, GlyphAtlasDescriptor, LayoutRefusal};
pub use self::error::GlyphAtlasError;
pub use self::limits::{
    CONTENT_HASH_DIGITS, GLYPH_ATLAS_VERSION, MAX_ATLAS_DIMENSION_PX, MAX_BYTES_PER_ROW,
    MAX_CLUSTER_CODE_POINTS, MAX_CSS_FONT_BYTES, MAX_FACE_PROBES, MAX_FAMILY_CHARACTERS,
    MAX_FONT_SIZE_PX, MAX_GLYPH_COUNT, MAX_PADDING_PX, MAX_PIXEL_BYTES, MAX_TEXT_CODE_POINTS,
    MIN_FONT_SIZE_PX,
};
pub use self::wire::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasMetrics, Direction, FaceProbe, FaceStyle,
    PixelFormat, ProbeFamily, UncheckedGlyphAtlas,
};
