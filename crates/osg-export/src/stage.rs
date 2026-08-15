//! What the `WebView` staged: the resolved face, the glyph atlas baked from it, and the runs.
//!
//! The architecture forbids a Rust text stack. The `WebView` shapes and rasterizes the selected face
//! once and stages the result; Rust re-derives layout from that metadata and places cells. So an
//! export cannot be built from a request alone — the text has to arrive already shaped, and this is
//! the type that carries it.
//!
//! The atlas's own verdict on cell-advance layout is checked here rather than left to the
//! compositor, because the descriptor knows *why* it refuses and the compositor's rejection does
//! not carry that detail. A caller who gets [`ExportError::AtlasCannotLayOut`] can tell a shaping
//! residual from a right-to-left run without re-reading the descriptor.

use osg_compositor::{CueRun, SubtitleScene};
use osg_scene::glyph::{CellAdvanceLayout, GlyphAtlasDescriptor};
use osg_scene::scene::ResolvedFace;

use crate::convert::ExportPlan;
use crate::error::ExportError;

/// The face, atlas and glyph runs the `WebView` staged for one export.
#[derive(Debug, Clone, PartialEq)]
pub struct StagedText {
    face: ResolvedFace,
    atlas: GlyphAtlasDescriptor,
    runs: Vec<CueRun>,
}

impl StagedText {
    /// Carries a staged face, its atlas and one run per cue.
    ///
    /// Nothing is checked here: the atlas descriptor is already checked by construction, and
    /// whether the three agree with each other and with a request is decided against a plan, in
    /// [`ExportPlan::compose`].
    #[must_use]
    pub const fn new(face: ResolvedFace, atlas: GlyphAtlasDescriptor, runs: Vec<CueRun>) -> Self {
        Self { face, atlas, runs }
    }

    /// The face the `WebView` resolved and baked from.
    #[must_use]
    pub const fn face(&self) -> &ResolvedFace {
        &self.face
    }

    /// The atlas baked from that face.
    #[must_use]
    pub const fn atlas(&self) -> &GlyphAtlasDescriptor {
        &self.atlas
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
    /// Returns [`ExportError::AtlasCannotLayOut`] when the atlas refuses cell-advance layout,
    /// [`ExportError::AtlasFaceMismatch`] when it was baked from another face, and
    /// [`ExportError::CompositionRejected`] when the run count does not match the cue count, a run
    /// is empty or too long, a run points at a cell the atlas does not have, the atlas metrics
    /// cannot place a line, or the composition is larger than the compositor will allocate.
    pub fn compose(&self, text: StagedText) -> Result<SubtitleScene, ExportError> {
        if let CellAdvanceLayout::Refused(refusal) = text.atlas.cell_advance_layout() {
            return Err(ExportError::AtlasCannotLayOut { refusal });
        }
        let StagedText { atlas, runs, .. } = text;
        Ok(SubtitleScene::new(
            self.scene().clone(),
            atlas,
            self.style().clone(),
            runs,
        )?)
    }
}
