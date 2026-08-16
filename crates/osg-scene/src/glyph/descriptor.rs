//! The checked descriptor and the one verdict the compositor must not drop.
//!
//! Construction runs every rule in [`super::validate`], so the type itself is the proof: holding a
//! [`GlyphAtlasDescriptor`] means nothing needs checking again.

use serde::{Deserialize, Serialize, Serializer};

use super::error::GlyphAtlasError;
use super::layout::{AtlasLayout, CellAdvanceVerdict, LayoutRefusal};
use super::validate::validate;
use super::wire::{AtlasFace, AtlasGeometry, AtlasGlyph, AtlasMetrics, UncheckedGlyphAtlas};

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
    ///
    /// [`GLYPH_ATLAS_VERSION`]: super::GLYPH_ATLAS_VERSION
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

    /// The authoritative layout: which cells each line draws, where, and on which baseline.
    ///
    /// This is what a consumer places glyphs from. Every index in it addresses a cell this
    /// descriptor carries, every line has a pen position per cell, and the baselines descend by the
    /// line box the metrics declare — all checked before this type could exist.
    #[must_use]
    pub const fn layout(&self) -> &AtlasLayout {
        &self.inner.layout
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

    /// Whether the emitted layout reproduces what the `WebView` measured.
    ///
    /// The layout records two limits rather than results, and both are easy to walk past: a
    /// non-zero shaping residual means ink crossed a cluster boundary, and right-to-left text the
    /// baker could not resolve is not in visual order. The verdict is `#[must_use]` and is not a
    /// `bool`, so neither can be dropped or read with the sense inverted by accident.
    ///
    /// It is the **baker's** verdict, not one re-derived here. Validation has already re-derived
    /// the half that can be re-derived — the shaping residual — and proven the verdict is exactly
    /// the disjunction of its own two reasons. The other half cannot be re-derived: only the side
    /// that shaped the run knows whether the order it emitted is visual, so a right-to-left run
    /// that says [`CellAdvanceLayout::Reproduces`] is one this side draws in the order given.
    pub fn cell_advance_layout(&self) -> CellAdvanceLayout {
        match self.inner.layout.cell_advance_layout {
            CellAdvanceVerdict::Reproduces => CellAdvanceLayout::Reproduces,
            CellAdvanceVerdict::Refused => CellAdvanceLayout::Refused(self.inner.layout.refusal),
        }
    }
}

/// The verdict on drawing a run at the positions the layout emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use = "the descriptor records limits that layout must respect, not advice it may drop"]
pub enum CellAdvanceLayout {
    /// The emitted positions are in visual order and reproduce what the `WebView` measured, so a
    /// consumer draws each cell where the layout puts it and asks nothing further.
    Reproduces,
    /// They do not; [`LayoutRefusal`] says why.
    Refused(LayoutRefusal),
}

impl CellAdvanceLayout {
    /// Whether the emitted positions reproduce the run.
    #[must_use]
    pub const fn reproduces(self) -> bool {
        matches!(self, Self::Reproduces)
    }
}
