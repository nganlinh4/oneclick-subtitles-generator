//! The checked descriptor and the one verdict the compositor must not drop.
//!
//! Construction runs every rule in [`super::validate`], so the type itself is the proof: holding a
//! [`GlyphAtlasDescriptor`] means nothing needs checking again.

use serde::{Deserialize, Serialize, Serializer};

use super::error::GlyphAtlasError;
use super::validate::validate;
use super::wire::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasMetrics, Direction, UncheckedGlyphAtlas,
};

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
