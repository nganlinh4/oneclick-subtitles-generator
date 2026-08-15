//! Everything one render needs, checked once: the scene, the atlas, the style and the staged runs.
//!
//! The atlas arrives as [`osg_scene::glyph::GlyphAtlasDescriptor`], which is the Rust mirror of what
//! `src/platform/glyphAtlas.js` bakes. That type already enforces every bound the baker enforces and
//! every agreement only the receiving side can re-derive, so nothing is re-checked here. What is
//! checked here is what only the compositor knows: that the atlas belongs to *this* scene's face,
//! that its metrics can place a line, that the descriptor does not itself refuse per-cell layout,
//! and that the staged runs index cells the atlas actually has.
//!
//! **Why runs are staged rather than derived.** The architecture forbids a Rust text stack: the
//! `WebView` shapes the text and Rust re-derives layout from that metadata. Segmenting a cue's text
//! into clusters in Rust would be a second segmenter, and a host whose `Intl.Segmenter` clusters an
//! emoji sequence differently would then export something the preview never showed. So visual order
//! is data: a [`CueRun`] is the sequence of atlas cells the `WebView` produced, per line, and the
//! compositor only places them.
//!
//! Not yet wired: [`osg_scene::animation::typewriter_utf16_length`]. The reveal counts UTF-16 code
//! units of the cue's text, and a staged run carries cell indices rather than code-unit lengths, so
//! `typewriter` currently renders as the transform-free animation `osg-scene` already says it is.
//! Adding it needs a per-glyph code-unit count on the run, which is a contract change.

use osg_scene::cues::CueTiming;
use osg_scene::glyph::GlyphAtlasDescriptor;
use osg_scene::scene::Scene;

use crate::error::{CompositorError, Rejection};
use crate::size::FrameSize;
use crate::style::SubtitleStyle;

/// The most lines one cue may occupy.
pub const MAX_RUN_LINES: usize = 64;

/// The most glyph cells one cue may place. Mirrors the baker's `maxTextCodePoints`.
pub const MAX_RUN_GLYPHS: usize = 4_096;

/// One cue's glyphs in visual order, split into lines.
///
/// Each entry indexes [`GlyphAtlasDescriptor::glyphs`]. An empty line is legitimate — it is a blank
/// line in the cue's text — but a run with no glyphs at all is not.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CueRun {
    lines: Vec<Vec<u32>>,
}

impl CueRun {
    /// Stage a run from its lines of atlas cell indices.
    #[must_use]
    pub const fn new(lines: Vec<Vec<u32>>) -> Self {
        Self { lines }
    }

    /// A single-line run.
    #[must_use]
    pub fn single_line(glyphs: Vec<u32>) -> Self {
        Self::new(vec![glyphs])
    }

    /// The lines, in top-to-bottom order.
    #[must_use]
    pub fn lines(&self) -> &[Vec<u32>] {
        &self.lines
    }

    fn validate(&self, cell_count: usize) -> Result<(), CompositorError> {
        if self.lines.is_empty() || self.lines.len() > MAX_RUN_LINES {
            return Err(Rejection::RunLength.into());
        }
        let mut glyphs = 0_usize;
        for line in &self.lines {
            glyphs = glyphs.checked_add(line.len()).ok_or(Rejection::RunLength)?;
            if glyphs > MAX_RUN_GLYPHS {
                return Err(Rejection::RunLength.into());
            }
            for index in line {
                if usize::try_from(*index).is_ok_and(|index| index < cell_count) {
                    continue;
                }
                return Err(Rejection::RunGlyphIndex.into());
            }
        }
        if glyphs == 0 {
            return Err(Rejection::RunLength.into());
        }
        Ok(())
    }
}

/// A scene that is ready to draw: validated, self-consistent, and renderable at any frame index in
/// its own timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleScene {
    scene: Scene,
    atlas: GlyphAtlasDescriptor,
    style: SubtitleStyle,
    runs: Vec<CueRun>,
    timings: Vec<CueTiming>,
    size: FrameSize,
}

impl SubtitleScene {
    /// Check a scene, its atlas, its style and its staged runs against each other.
    ///
    /// # Errors
    /// Returns [`CompositorError::UnsupportedSceneInput`] when the atlas was baked from a different
    /// face than the scene resolved, when the atlas refuses layout from per-cell advances, when its
    /// metrics cannot place a line, when the run count does not match the cue count, or when a run
    /// is empty, too long, or points at a cell the atlas does not have. Returns a dimension error
    /// when the composition is larger than the compositor will allocate.
    pub fn new(
        scene: Scene,
        atlas: GlyphAtlasDescriptor,
        style: SubtitleStyle,
        runs: Vec<CueRun>,
    ) -> Result<Self, CompositorError> {
        // The whole point of `ResolvedFace` is that a preview and an export can be *proven* to have
        // used the same glyphs. An atlas baked from another face is the one failure this contract
        // exists to catch, so it is refused before anything is allocated.
        if atlas.face().requested_family != scene.face().family
            || atlas.face().weight != scene.face().weight
        {
            return Err(Rejection::AtlasFaceMismatch.into());
        }
        // A `#[must_use]` verdict from the descriptor, honoured rather than logged: the compositor
        // places cells by accumulating their advances, which is exactly what this refuses.
        if !atlas.cell_advance_layout().reproduces() {
            return Err(Rejection::AtlasLayoutRefused.into());
        }
        if atlas.metrics().line_height_px <= 0.0 || atlas.face().font_size_px <= 0.0 {
            return Err(Rejection::AtlasMetrics.into());
        }
        if runs.len() != scene.cues().len() {
            return Err(Rejection::RunCount.into());
        }
        for run in &runs {
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
            atlas,
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

    /// The glyph atlas the runs index into.
    #[must_use]
    pub const fn atlas(&self) -> &GlyphAtlasDescriptor {
        &self.atlas
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
