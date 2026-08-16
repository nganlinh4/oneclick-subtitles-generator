//! The staged run: one cue's laid-out lines, exactly as the `WebView` laid them out.
//!
//! **This crate derives no layout.** A [`CueLine`] carries the cells to draw, the pen position of
//! each one and the line's own baseline, all in atlas pixel space, and the compositor scales them
//! and places them. It never accumulates a pen from advances, never re-wraps, never re-aligns and
//! never reorders — every one of those questions was answered by
//! [`osg_scene::glyph::AtlasLayout`], on the only side with a font stack.
//!
//! [`CueRun::from_layout`] is the ordinary way to build one, and it is a copy rather than a
//! computation. The explicit constructor exists for the staging boundary, which owns one atlas and
//! one run per cue; every number it passes must still come from a layout the baker emitted.

use osg_scene::glyph::AtlasLayout;

use crate::error::{CompositorError, Rejection};

/// The most lines one cue may occupy. Mirrors the baker's `maxLayoutLines`.
pub const MAX_RUN_LINES: usize = 64;

/// The most glyph cells one cue may place. Mirrors the baker's `maxLayoutCells`.
pub const MAX_RUN_GLYPHS: usize = 4_096;

/// One laid-out line of a cue.
///
/// Everything is in **atlas pixel space** — the space the atlas was baked in — because that is the
/// space the baker measured in. The compositor multiplies by `fontSize / atlasFontSize`, which is
/// what lets one atlas serve the preview and the export at different resolutions.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CueLine {
    glyphs: Vec<u32>,
    pen_x_px: Vec<f64>,
    advance_width_px: f64,
    baseline_y_px: f64,
}

impl CueLine {
    /// Stage one line from the positions the baker emitted for it.
    ///
    /// `glyphs` index [`osg_scene::glyph::GlyphAtlasDescriptor::glyphs`] **in visual order**, and
    /// `pen_x_px` gives each one's line-relative pen. The two must be the same length; a run whose
    /// line is not is refused when the scene is staged, not silently half-drawn.
    #[must_use]
    pub const fn new(
        glyphs: Vec<u32>,
        pen_x_px: Vec<f64>,
        advance_width_px: f64,
        baseline_y_px: f64,
    ) -> Self {
        Self {
            glyphs,
            pen_x_px,
            advance_width_px,
            baseline_y_px,
        }
    }

    /// The cells this line draws, in visual order.
    #[must_use]
    pub fn glyphs(&self) -> &[u32] {
        &self.glyphs
    }

    /// Each cell's line-relative pen position, in atlas pixels.
    #[must_use]
    pub fn pen_x_px(&self) -> &[f64] {
        &self.pen_x_px
    }

    /// What alignment measures: the line box's width in atlas pixels, trailing spaces hanging.
    #[must_use]
    pub const fn advance_width_px(&self) -> f64 {
        self.advance_width_px
    }

    /// This line's baseline, in atlas pixels from the top of the run box.
    #[must_use]
    pub const fn baseline_y_px(&self) -> f64 {
        self.baseline_y_px
    }

    fn validate(&self, cell_count: usize) -> Result<(), CompositorError> {
        if self.pen_x_px.len() != self.glyphs.len() {
            return Err(Rejection::RunGeometry.into());
        }
        if !self.advance_width_px.is_finite()
            || !self.baseline_y_px.is_finite()
            || self.pen_x_px.iter().any(|pen| !pen.is_finite())
        {
            return Err(Rejection::RunGeometry.into());
        }
        for index in &self.glyphs {
            if usize::try_from(*index).is_ok_and(|index| index < cell_count) {
                continue;
            }
            return Err(Rejection::RunGlyphIndex.into());
        }
        Ok(())
    }
}

/// One cue's glyphs in visual order, split into laid-out lines.
///
/// An empty line is legitimate — it is a blank line in the cue's text — but a run with no cells at
/// all is not.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CueRun {
    lines: Vec<CueLine>,
}

impl CueRun {
    /// Stage a run from its laid-out lines.
    #[must_use]
    pub const fn new(lines: Vec<CueLine>) -> Self {
        Self { lines }
    }

    /// A single-line run.
    #[must_use]
    pub fn single_line(line: CueLine) -> Self {
        Self::new(vec![line])
    }

    /// Stage the run the baker laid out, copying its positions rather than deriving any.
    ///
    /// This is the whole of the compositor's layout input. Nothing is recomputed here, including
    /// the parts that would be easy to recompute: the pen positions already carry letter spacing
    /// and justification, and the baselines already carry the line height.
    #[must_use]
    pub fn from_layout(layout: &AtlasLayout) -> Self {
        Self::new(
            layout
                .lines
                .iter()
                .map(|line| {
                    CueLine::new(
                        line.glyphs.clone(),
                        line.pen_x_px.clone(),
                        line.advance_width_px,
                        line.baseline_y_px,
                    )
                })
                .collect(),
        )
    }

    /// The lines, in top-to-bottom order.
    #[must_use]
    pub fn lines(&self) -> &[CueLine] {
        &self.lines
    }

    /// How many cells the run places, across every line.
    #[must_use]
    pub fn placed_cells(&self) -> usize {
        self.lines.iter().map(|line| line.glyphs.len()).sum()
    }

    pub(crate) fn validate(&self, cell_count: usize) -> Result<(), CompositorError> {
        if self.lines.is_empty() || self.lines.len() > MAX_RUN_LINES {
            return Err(Rejection::RunLength.into());
        }
        let mut glyphs = 0_usize;
        let mut previous_baseline: Option<f64> = None;
        for line in &self.lines {
            glyphs = glyphs
                .checked_add(line.glyphs.len())
                .ok_or(Rejection::RunLength)?;
            if glyphs > MAX_RUN_GLYPHS {
                return Err(Rejection::RunLength.into());
            }
            line.validate(cell_count)?;
            // Lines descend, as the layout that produced them guarantees. A run that does not is
            // one nothing on this side could have drawn in a sensible order.
            if previous_baseline.is_some_and(|previous| line.baseline_y_px <= previous) {
                return Err(Rejection::RunGeometry.into());
            }
            previous_baseline = Some(line.baseline_y_px);
        }
        if glyphs == 0 {
            return Err(Rejection::RunLength.into());
        }
        Ok(())
    }
}
