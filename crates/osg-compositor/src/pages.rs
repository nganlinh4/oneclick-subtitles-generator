//! The atlas pages one scene draws from, and which page each cue belongs to.
//!
//! One atlas holds at most [`MAX_GLYPH_COUNT`](osg_scene::glyph::MAX_GLYPH_COUNT) distinct cells,
//! which a Latin document never approaches and a CJK, Korean or emoji-heavy one exhausts in a few
//! lines. The baker therefore bakes a document into as many pages as its distinct clusters need and
//! records, per cue, which page that cue's cells were baked into.
//!
//! **A frame needs exactly one page.** [`osg_scene::cues::active_cue_at`] selects at most one cue per
//! frame, first match wins, and the frame plan emits quads for that one run. So the page a frame
//! samples is the page of its own cue: there is no per-quad page attribute, no texture array and no
//! splitting of a run across pages. Everything this type owes the compositor is the mapping from a
//! cue to its page, checked once so no frame can resolve one that was never staged.

use osg_scene::glyph::{GlyphAtlasDescriptor, MAX_ATLAS_PAGES};

use crate::error::{CompositorError, Rejection, TextureTarget};
use crate::size::check_device_texture;

/// The baked pages of one document, plus the page each cue draws from.
#[derive(Debug, Clone, PartialEq)]
pub struct AtlasPages {
    pages: Vec<GlyphAtlasDescriptor>,
    page_of_cue: Vec<u32>,
}

impl AtlasPages {
    /// Every cue drawn from one atlas. The preview's shape, and a single-page export's.
    ///
    /// The overwhelmingly common case, and deliberately infallible: one page is never an empty page
    /// list, never past [`MAX_ATLAS_PAGES`], and every cue names index zero, so there is nothing for
    /// a caller to handle.
    #[must_use]
    pub fn single(atlas: GlyphAtlasDescriptor, cue_count: usize) -> Self {
        Self {
            pages: vec![atlas],
            page_of_cue: vec![0; cue_count],
        }
    }

    /// N pages with an explicit page per cue.
    ///
    /// # Errors
    /// Returns [`CompositorError::UnsupportedSceneInput`] when there are no pages at all, when there
    /// are more than [`MAX_ATLAS_PAGES`], or when a cue names a page that was not staged. All three
    /// are refused here rather than at the frame that would have drawn them, because a document that
    /// cannot be drawn must fail before an export begins encoding it.
    pub fn new(
        pages: Vec<GlyphAtlasDescriptor>,
        page_of_cue: Vec<u32>,
    ) -> Result<Self, CompositorError> {
        if pages.is_empty() {
            return Err(Rejection::AtlasPagesEmpty.into());
        }
        if pages.len() > MAX_ATLAS_PAGES {
            return Err(Rejection::AtlasPageCount.into());
        }
        for page in &page_of_cue {
            if usize::try_from(*page).is_ok_and(|page| page < pages.len()) {
                continue;
            }
            return Err(Rejection::AtlasPageIndex.into());
        }
        Ok(Self { pages, page_of_cue })
    }

    /// The staged pages, in the order the baker emitted them.
    #[must_use]
    pub fn pages(&self) -> &[GlyphAtlasDescriptor] {
        &self.pages
    }

    /// Which page a cue draws from, or `None` when this scene has no such cue.
    #[must_use]
    pub fn page_of_cue(&self, cue: usize) -> Option<usize> {
        self.page_of_cue
            .get(cue)
            .and_then(|page| usize::try_from(*page).ok())
    }

    /// The atlas a cue draws from, or `None` when this scene has no such cue.
    #[must_use]
    pub fn atlas_for(&self, cue: usize) -> Option<&GlyphAtlasDescriptor> {
        self.pages.get(self.page_of_cue(cue)?)
    }

    /// Refuses every page this device cannot allocate as a texture.
    ///
    /// Public, and called before any page is uploaded, because `wgpu` validates a texture dimension
    /// inside `Device::create_texture` by panicking and the release profile aborts. A document whose
    /// twentieth page is past the device's limit has to be refused up front rather than at the frame
    /// that first draws from it — which, in a long export, is minutes of encoding later.
    ///
    /// # Errors
    /// Returns [`CompositorError::DeviceTextureLimit`] naming [`TextureTarget::Atlas`] for the first
    /// page that is too large.
    pub fn check_device(&self, max_edge: u32) -> Result<(), CompositorError> {
        for page in &self.pages {
            let geometry = page.atlas();
            check_device_texture(
                TextureTarget::Atlas,
                geometry.width_px,
                geometry.height_px,
                max_edge,
            )?;
        }
        Ok(())
    }

    /// How many cues this mapping covers, which the scene checks against its own cue count.
    pub(crate) fn cue_count(&self) -> usize {
        self.page_of_cue.len()
    }

    /// The page a frame plan resolved, or the first page when it resolved none.
    ///
    /// A plan that draws nothing resolves no page, and binding page zero for it is harmless: it
    /// emits no atlas segment for that binding to be sampled by. Both constructors guarantee at
    /// least one page, so this is total in practice; it stays an `Option` rather than indexing,
    /// because a panic is not an outcome this crate has.
    pub(crate) fn bound(&self, page: Option<usize>) -> Option<&GlyphAtlasDescriptor> {
        page.and_then(|page| self.pages.get(page))
            .or_else(|| self.pages.first())
    }
}
