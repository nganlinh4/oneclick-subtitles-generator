//! Everything one render needs, checked once: the scene, the atlas pages, the style and the runs.
//!
//! The atlases arrive as [`osg_scene::glyph::GlyphAtlasDescriptor`], which is the Rust mirror of what
//! `src/platform/glyphAtlas.js` bakes. That type already enforces every bound the baker enforces and
//! every agreement only the receiving side can re-derive, so nothing is re-checked here. What is
//! checked here is what only the compositor knows: that the atlases belong to *this* scene's face,
//! that their metrics can place a line, that no descriptor itself refuses per-cell layout, and that
//! the staged runs index cells the page they belong to actually has.
//!
//! **Why there are pages at all.** One atlas holds a bounded number of distinct cells, and a CJK,
//! Korean or emoji-heavy document has more distinct clusters than that. So a document is baked into
//! [`AtlasPages`]: several atlases from the same face at the same size, plus the page each cue was
//! baked into. Every check below therefore runs over *every* page — the pages are bakes of one face,
//! so a page whose face, layout verdict or metrics disagree with the scene is a fault rather than a
//! variation, and it is refused before a frame exists rather than at the frame that would draw it.
//!
//! **Why runs are staged rather than derived.** The architecture forbids a Rust text stack: the
//! `WebView` shapes the text and lays it out, and Rust draws what it laid out. Segmenting, wrapping
//! or measuring a cue's text in Rust would be a second layout model, and a host whose
//! `Intl.Segmenter` clusters an emoji sequence differently would then export something the preview
//! never showed. So the layout is data: a [`CueRun`] carries the cells the `WebView` placed, their
//! pen positions and their baselines, and the compositor scales and draws them.

use osg_scene::cues::CueTiming;
use osg_scene::glyph::GlyphAtlasDescriptor;
use osg_scene::scene::Scene;

use crate::error::{CompositorError, Rejection};
use crate::pages::AtlasPages;
use crate::run::CueRun;
use crate::size::FrameSize;
use crate::style::SubtitleStyle;

/// A scene that is ready to draw: validated, self-consistent, and renderable at any frame index in
/// its own timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleScene {
    scene: Scene,
    atlases: AtlasPages,
    style: SubtitleStyle,
    runs: Vec<CueRun>,
    timings: Vec<CueTiming>,
    size: FrameSize,
}

impl SubtitleScene {
    /// Check a scene, its atlas pages, its style and its staged runs against each other.
    ///
    /// # Errors
    /// Returns [`CompositorError::UnsupportedSceneInput`] when the page assignment does not cover
    /// exactly this scene's cues, when a page was baked from a different face than the scene
    /// resolved, when a page refuses layout from per-cell advances, when a page's metrics cannot
    /// place a line, when the run count does not match the cue count, or when a run is empty, too
    /// long, or points at a cell its own page does not have. Returns a dimension error when the
    /// composition is larger than the compositor will allocate.
    pub fn new(
        scene: Scene,
        atlases: AtlasPages,
        style: SubtitleStyle,
        runs: Vec<CueRun>,
    ) -> Result<Self, CompositorError> {
        if atlases.cue_count() != scene.cues().len() {
            return Err(Rejection::AtlasPageCueCount.into());
        }
        for atlas in atlases.pages() {
            // The whole point of `ResolvedFace` is that a preview and an export can be *proven* to
            // have used the same glyphs. An atlas baked from another face is the one failure this
            // contract exists to catch, so it is refused before anything is allocated.
            if atlas.face().requested_family != scene.face().family
                || atlas.face().weight != scene.face().weight
            {
                return Err(Rejection::AtlasFaceMismatch.into());
            }
            // A `#[must_use]` verdict from the descriptor, honoured rather than logged. It is the
            // baker's own: a right-to-left run it resolved into visual order says `reproduces` and
            // is drawn in the order given, and one it could not resolve still says `refused` and is
            // still refused here rather than drawn backwards.
            if !atlas.cell_advance_layout().reproduces() {
                return Err(Rejection::AtlasLayoutRefused.into());
            }
            if atlas.metrics().line_height_px <= 0.0 || atlas.face().font_size_px <= 0.0 {
                return Err(Rejection::AtlasMetrics.into());
            }
        }
        if runs.len() != scene.cues().len() {
            return Err(Rejection::RunCount.into());
        }
        for (cue, run) in runs.iter().enumerate() {
            // Against its OWN page's cell table. Checking every run against page zero would accept a
            // cue whose cells only exist on a later, larger page and reject one whose page is
            // smaller — both of which draw the wrong glyphs rather than failing.
            let atlas = atlases
                .atlas_for(cue)
                .ok_or(Rejection::AtlasPageIndex)
                .map_err(CompositorError::from)?;
            run.validate(atlas.glyphs().len())?;
        }

        let size = FrameSize::new(scene.width(), scene.height())?;
        let timings = scene
            .cues()
            .iter()
            .map(|cue| CueTiming {
                start: cue.start,
                end: cue.end,
            })
            .collect();

        Ok(Self {
            scene,
            atlases,
            style,
            runs,
            timings,
            size,
        })
    }

    /// The validated scene contract.
    #[must_use]
    pub const fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Every glyph atlas page this scene draws from.
    #[must_use]
    pub fn pages(&self) -> &[GlyphAtlasDescriptor] {
        self.atlases.pages()
    }

    /// The page a cue draws from, or `None` when this scene has no such cue.
    #[must_use]
    pub fn page_of_cue(&self, cue: usize) -> Option<usize> {
        self.atlases.page_of_cue(cue)
    }

    /// The atlas a cue's run indexes into, or `None` when this scene has no such cue.
    #[must_use]
    pub fn atlas_for(&self, cue: usize) -> Option<&GlyphAtlasDescriptor> {
        self.atlases.atlas_for(cue)
    }

    /// The page a frame plan resolved, or the first page when it resolved none.
    pub(crate) fn bound_page(&self, page: Option<usize>) -> Option<&GlyphAtlasDescriptor> {
        self.atlases.bound(page)
    }

    /// Refuses every page this device cannot allocate as a texture.
    pub(crate) fn check_pages_on_device(&self, max_edge: u32) -> Result<(), CompositorError> {
        self.atlases.check_device(max_edge)
    }

    /// The resolved style.
    #[must_use]
    pub const fn style(&self) -> &SubtitleStyle {
        &self.style
    }

    /// The staged runs, one per cue.
    #[must_use]
    pub fn runs(&self) -> &[CueRun] {
        &self.runs
    }

    /// The cue windows, in the order `osg-scene` selects from.
    #[must_use]
    pub fn timings(&self) -> &[CueTiming] {
        &self.timings
    }

    /// The frame size every frame of this scene composes at.
    #[must_use]
    pub const fn size(&self) -> FrameSize {
        self.size
    }

    /// How many frames this scene's timeline produces.
    #[must_use]
    pub const fn frame_count(&self) -> u32 {
        self.scene.timeline().frame_count()
    }
}
