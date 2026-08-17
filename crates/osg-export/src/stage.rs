//! What the `WebView` staged: the resolved face, the atlas pages baked from it, and the runs.
//!
//! The architecture forbids a Rust text stack. The `WebView` shapes and rasterizes the selected face
//! once and stages the result; Rust re-derives layout from that metadata and places cells. So an
//! export cannot be built from a request alone — the text has to arrive already shaped, and this is
//! the type that carries it.
//!
//! One atlas holds a bounded number of distinct cells, which a CJK, Korean or emoji-heavy document
//! exhausts, so the baker bakes a document into as many pages as it needs and says which page each
//! cue was baked into. A single-page document is the common case and has [`StagedText::single`]; the
//! two shapes differ only in how many descriptors travel.
//!
//! Each page's own verdict on cell-advance layout is checked here rather than left to the
//! compositor, because the descriptor knows *why* it refuses and the compositor's rejection does
//! not carry that detail. A caller who gets [`ExportError::AtlasCannotLayOut`] can tell a shaping
//! residual from a right-to-left run without re-reading the descriptor.

use osg_compositor::{AtlasPages, CueRun, SubtitleScene};
use osg_scene::glyph::{CellAdvanceLayout, GlyphAtlasDescriptor};
use osg_scene::scene::ResolvedFace;

use crate::convert::ExportPlan;
use crate::error::ExportError;

/// The face, atlas pages and glyph runs the `WebView` staged for one export.
#[derive(Debug, Clone, PartialEq)]
pub struct StagedText {
    face: ResolvedFace,
    pages: Vec<GlyphAtlasDescriptor>,
    page_of_cue: Vec<u32>,
    runs: Vec<CueRun>,
}

impl StagedText {
    /// Carries a staged face, its atlas pages, the page each cue was baked into and one run per cue.
    ///
    /// Nothing is checked here: each descriptor is already checked by construction, and whether the
    /// four agree with each other and with a request is decided against a plan, in
    /// [`ExportPlan::compose`].
    #[must_use]
    pub const fn new(
        face: ResolvedFace,
        pages: Vec<GlyphAtlasDescriptor>,
        page_of_cue: Vec<u32>,
        runs: Vec<CueRun>,
    ) -> Self {
        Self {
            face,
            pages,
            page_of_cue,
            runs,
        }
    }

    /// The single-page case: every cue drawn from one atlas.
    ///
    /// What the preview always stages — it draws one cue — and what a document whose distinct
    /// clusters fit one page stages too.
    #[must_use]
    pub fn single(face: ResolvedFace, atlas: GlyphAtlasDescriptor, runs: Vec<CueRun>) -> Self {
        Self::new(face, vec![atlas], vec![0; runs.len()], runs)
    }

    /// The face the `WebView` resolved and baked from.
    #[must_use]
    pub const fn face(&self) -> &ResolvedFace {
        &self.face
    }

    /// The atlas pages baked from that face.
    #[must_use]
    pub fn pages(&self) -> &[GlyphAtlasDescriptor] {
        &self.pages
    }

    /// The page each cue was baked into, in the same order as [`Self::runs`].
    #[must_use]
    pub fn page_of_cue(&self) -> &[u32] {
        &self.page_of_cue
    }

    /// The staged runs, one per cue, in visual order.
    #[must_use]
    pub fn runs(&self) -> &[CueRun] {
        &self.runs
    }
}

impl ExportPlan {
    /// Checks the staged text against this plan and produces the scene the compositor draws.
    ///
    /// # Errors
    /// Returns [`ExportError::AtlasCannotLayOut`] when a page refuses cell-advance layout,
    /// [`ExportError::AtlasFaceMismatch`] when a page was baked from another face, and
    /// [`ExportError::CompositionRejected`] when the page list is empty or longer than the renderer
    /// accepts, a cue names a page that was not staged, the page assignment or the run count does
    /// not match the cue count, a run is empty or too long, a run points at a cell its page does not
    /// have, a page's metrics cannot place a line, or the composition is larger than the compositor
    /// will allocate.
    pub fn compose(&self, text: StagedText) -> Result<SubtitleScene, ExportError> {
        for page in &text.pages {
            if let CellAdvanceLayout::Refused(refusal) = page.cell_advance_layout() {
                return Err(ExportError::AtlasCannotLayOut { refusal });
            }
        }
        let StagedText {
            pages,
            page_of_cue,
            runs,
            ..
        } = text;
        let atlases = AtlasPages::new(pages, page_of_cue)?;
        Ok(SubtitleScene::new(
            self.scene().clone(),
            atlases,
            self.style().clone(),
            runs,
        )?)
    }
}
