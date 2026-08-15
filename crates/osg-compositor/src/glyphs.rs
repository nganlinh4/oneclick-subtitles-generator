//! Placing the atlas cells, and the three ways they can be painted.
//!
//! The same walk over the run produces the fill, the stroke that goes under it, and the white mask
//! the drop shadow is blurred from. Writing it once is the point: three walks would be three
//! chances for the shadow to land somewhere the glyph does not.
//!
//! **The stroke is a dilation, not an outline.** The compositor has coverage, not contours — the
//! `WebView` bakes rasterized cells and there is no Rust text stack to ask for a glyph path. So a
//! stroke quad is the cell grown by the stroke radius, and the fragment takes the largest coverage
//! it finds on a ring of that radius inside its own cell. That is `O(taps)` per fragment with a
//! fixed tap count, never `O(radius^2)`, and the ring lives in the cell's own space so the cue
//! transform turns it into the ellipse the transform implies rather than leaving it circular.
//!
//! One divergence from the shipped renderer is deliberate and recorded here rather than hidden:
//! `-webkit-text-stroke` is *centred* on the glyph contour and painted **over** the fill, so a wide
//! stroke eats inward and thins the letter. This paints the outer half **under** the fill, which
//! keeps the same outer silhouette and the same stroke colour band, but leaves the letter at its
//! full weight. Reproducing the inward half would need an erosion of the coverage, which needs a
//! distance field the atlas does not carry.

use osg_scene::glyph::{AtlasGlyph, GlyphAtlasDescriptor};
use osg_scene::layout::{SubtitleBox, SubtitlePosition, TextAlign};

use crate::geometry::{
    KIND_GLYPH, KIND_STROKE, Metrics, Placement, Quad, Rect, Shape, UvSource, emit,
};
use crate::subtitle::CueRun;

/// How many ring samples a stroke fragment takes.
///
/// Fixed rather than derived from the radius, so the per-fragment cost of a stroke does not depend
/// on how wide the user made it, and a persisted extreme cannot make a frame cost more than a
/// modest one. The worst-case gap between this many ring points and the disc they stand for is
/// `radius * (1 - cos(pi / taps))`, which at 24 is under one percent — a fifth of a pixel at the
/// widest stroke the editor offers.
///
/// The shader needs the same number, and WGSL cannot read a Rust constant, so
/// [`crate::quad_pipeline`] substitutes this one into the shader source rather than leaving two
/// values to drift apart silently.
pub(crate) const STROKE_TAPS: u32 = 24;

/// A linear gradient over an area, in the CSS vocabulary: zero degrees points at the top edge and
/// the angle turns clockwise.
#[derive(Debug, Clone, Copy)]
pub(crate) struct GradientLine {
    centre: (f64, f64),
    direction: (f64, f64),
    length: f64,
}

impl GradientLine {
    /// The gradient of `area`, which is the padding box: CSS resolves `background-origin` to the
    /// padding box, and `background-clip: text` changes only what the paint is clipped to, never
    /// what it is measured over. So the ramp spans the whole box and the glyphs sample it, rather
    /// than each letter carrying its own copy of the ramp.
    pub(crate) fn new(area: Rect, degrees: f64) -> Self {
        let (sin, cos) = degrees.to_radians().sin_cos();
        Self {
            centre: area.centre(),
            direction: (sin, -cos),
            length: (area.width * sin).abs() + (area.height * cos).abs(),
        }
    }

    /// Where a point falls on the gradient line, in `0.0..=1.0`.
    pub(crate) fn at(&self, x: f64, y: f64) -> f64 {
        if self.length <= 0.0 {
            return 0.0;
        }
        let along =
            (x - self.centre.0).mul_add(self.direction.0, (y - self.centre.1) * self.direction.1);
        (0.5 + along / self.length).clamp(0.0, 1.0)
    }
}

/// What a glyph pass paints with.
#[derive(Debug, Clone, Copy)]
pub(crate) enum GlyphPaint {
    /// One colour everywhere.
    Flat([f64; 4]),
    /// A linear ramp, sampled at each corner.
    Gradient {
        start: [f64; 4],
        end: [f64; 4],
        line: GradientLine,
    },
}

impl GlyphPaint {
    /// Whether the paint can reach a pixel at all.
    ///
    /// A fully transparent flat colour is the gradient case `osg-scene` produces on purpose, and a
    /// gradient whose stops are both transparent is the same thing said twice.
    fn is_invisible(&self) -> bool {
        match self {
            Self::Flat(colour) => colour[3] <= 0.0,
            Self::Gradient { start, end, .. } => start[3] <= 0.0 && end[3] <= 0.0,
        }
    }

    fn corners(&self, rect: Rect) -> [[f64; 4]; 4] {
        match self {
            Self::Flat(colour) => [*colour; 4],
            Self::Gradient { start, end, line } => {
                let right = rect.left + rect.width;
                let bottom = rect.top + rect.height;
                [
                    (rect.left, rect.top),
                    (right, rect.top),
                    (right, bottom),
                    (rect.left, bottom),
                ]
                .map(|(x, y)| mix(*start, *end, line.at(x, y)))
            }
        }
    }
}

fn mix(start: [f64; 4], end: [f64; 4], amount: f64) -> [f64; 4] {
    let mut out = [0.0; 4];
    for (slot, (from, to)) in out.iter_mut().zip(start.iter().zip(end.iter())) {
        *slot = (to - from).mul_add(amount, *from);
    }
    out
}

/// Everything one walk over the run needs, bundled so the walk keeps one argument list.
pub(crate) struct GlyphPass<'scene> {
    pub(crate) atlas: &'scene GlyphAtlasDescriptor,
    pub(crate) run: &'scene CueRun,
    pub(crate) placement: Placement,
    pub(crate) metrics: Metrics,
    pub(crate) align: TextAlign,
    pub(crate) block_left: f64,
    pub(crate) text_top: f64,
    pub(crate) text_width: f64,
    pub(crate) line_widths: &'scene [f64],
}

/// How one walk paints: the colour, an offset applied before the cue transform, and the radius the
/// cells are dilated by. A zero radius is the plain fill.
pub(crate) struct GlyphDraw {
    pub(crate) paint: GlyphPaint,
    pub(crate) offset: (f64, f64),
    pub(crate) outline_px: f64,
}

/// Walk the run and emit one quad per inked cell.
pub(crate) fn emit_glyphs(vertices: &mut Vec<f32>, pass: &GlyphPass<'_>, draw: &GlyphDraw) {
    let atlas_width = f64::from(pass.atlas.atlas().width_px);
    let atlas_height = f64::from(pass.atlas.atlas().height_px);
    // Three ways a run draws nothing at all, and none is an error: the paint is transparent, the
    // atlas has no texture because every cluster was blank, or the run is nothing but blanks.
    // Walking the pen would produce no quad either way, so it is not walked.
    if draw.paint.is_invisible() || atlas_width <= 0.0 || atlas_height <= 0.0 {
        return;
    }

    let scale = pass.metrics.glyph_scale;
    // The dilation is expressed in the cell's own pixels, so the cue transform turns the ring into
    // whatever ellipse it implies rather than leaving a rotated stroke circular.
    let outline_cells = if scale > 0.0 {
        draw.outline_px / scale
    } else {
        0.0
    };
    let (kind, ring) = if draw.outline_px > 0.0 {
        (
            KIND_STROKE,
            (outline_cells / atlas_width, outline_cells / atlas_height),
        )
    } else {
        (KIND_GLYPH, (0.0, 0.0))
    };

    let mut baseline = pass.text_top + pass.metrics.baseline + draw.offset.1;
    for (line, line_width) in pass.run.lines().iter().zip(pass.line_widths) {
        let mut pen =
            line_left(pass.align, pass.block_left, pass.text_width, *line_width) + draw.offset.0;
        for index in line {
            let Some(cell) = cell_at(pass.atlas, *index) else {
                continue;
            };
            if is_inked(cell) {
                let rect = Rect {
                    left: f64::from(cell.origin_x_px).mul_add(-scale, pen),
                    top: f64::from(cell.origin_y_px).mul_add(-scale, baseline),
                    width: f64::from(cell.width_px) * scale,
                    height: f64::from(cell.height_px) * scale,
                };
                let cell_uv = Rect {
                    left: f64::from(cell.x_px) / atlas_width,
                    top: f64::from(cell.y_px) / atlas_height,
                    width: f64::from(cell.width_px) / atlas_width,
                    height: f64::from(cell.height_px) / atlas_height,
                };
                emit(
                    vertices,
                    pass.placement,
                    pass.metrics,
                    &Quad {
                        rect: rect.grown(draw.outline_px),
                        uv: UvSource::Rect(Rect {
                            left: cell_uv.left - ring.0,
                            top: cell_uv.top - ring.1,
                            width: (ring.0 * 2.0) + cell_uv.width,
                            height: (ring.1 * 2.0) + cell_uv.height,
                        }),
                        shape: Shape::NONE,
                        colours: draw.paint.corners(rect),
                        kind,
                        aux: ring,
                        cell: [
                            cell_uv.left,
                            cell_uv.top,
                            cell_uv.left + cell_uv.width,
                            cell_uv.top + cell_uv.height,
                        ],
                    },
                );
            }
            pen += cell.advance_width_px * scale;
        }
        baseline += pass.metrics.line_height;
    }
}

fn cell_at(atlas: &GlyphAtlasDescriptor, index: u32) -> Option<&AtlasGlyph> {
    usize::try_from(index)
        .ok()
        .and_then(|index| atlas.glyphs().get(index))
}

const fn is_inked(cell: &AtlasGlyph) -> bool {
    cell.width_px > 0 && cell.height_px > 0
}

/// The advance width of every line, in composition pixels.
pub(crate) fn line_widths(
    atlas: &GlyphAtlasDescriptor,
    run: &CueRun,
    glyph_scale: f64,
) -> Vec<f64> {
    run.lines()
        .iter()
        .map(|line| {
            line.iter()
                .filter_map(|index| cell_at(atlas, *index))
                .map(|cell| cell.advance_width_px * glyph_scale)
                .sum()
        })
        .collect()
}

/// How many lines the run occupies.
pub(crate) fn line_count(run: &CueRun) -> f64 {
    u32::try_from(run.lines().len()).map_or(0.0, f64::from)
}

/// Where the text block starts horizontally.
///
/// A custom position collapses the box to a point, so the block is centred on it; otherwise the
/// block is placed inside the resolved box according to the alignment. `Justify` places like `Left`:
/// the shipped renderer accepts it but has no control for it, and stretching a run whose shaping
/// this crate does not own would be inventing layout.
pub(crate) fn block_left(boxed: &SubtitleBox, position: SubtitlePosition, text_width: f64) -> f64 {
    if position == SubtitlePosition::Custom {
        return boxed.left - text_width / 2.0;
    }
    match boxed.align {
        TextAlign::Left | TextAlign::Justify => boxed.left,
        TextAlign::Center => boxed.left + ((boxed.right - boxed.left) - text_width) / 2.0,
        TextAlign::Right => boxed.right - text_width,
    }
}

fn line_left(align: TextAlign, block_left: f64, text_width: f64, line_width: f64) -> f64 {
    match align {
        TextAlign::Left | TextAlign::Justify => block_left,
        TextAlign::Center => block_left + (text_width - line_width) / 2.0,
        TextAlign::Right => block_left + (text_width - line_width),
    }
}

#[cfg(test)]
mod tests {
    use super::GradientLine;
    use crate::geometry::Rect;

    fn unit_box() -> Rect {
        Rect {
            left: 0.0,
            top: 0.0,
            width: 100.0,
            height: 100.0,
        }
    }

    /// Zero degrees points at the top edge and the angle turns clockwise, which is the CSS rule and
    /// not the mathematical one. Getting it wrong flips or rotates every existing gradient.
    #[test]
    fn the_gradient_angle_follows_the_css_convention() {
        let upward = GradientLine::new(unit_box(), 0.0);
        assert!(
            upward.at(50.0, 100.0) < 0.5,
            "at zero degrees the start colour is at the bottom"
        );
        assert!(upward.at(50.0, 0.0) > 0.5, "and the end colour at the top");

        let rightward = GradientLine::new(unit_box(), 90.0);
        assert!((rightward.at(0.0, 50.0) - 0.0).abs() < 1e-9);
        assert!((rightward.at(100.0, 50.0) - 1.0).abs() < 1e-9);
        assert!((rightward.at(50.0, 50.0) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_gradient_is_clamped_to_its_own_line_and_survives_a_zero_sized_box() {
        let line = GradientLine::new(unit_box(), 90.0);
        assert!((line.at(-500.0, 50.0) - 0.0).abs() < f64::EPSILON);
        assert!((line.at(500.0, 50.0) - 1.0).abs() < f64::EPSILON);

        let degenerate = GradientLine::new(
            Rect {
                left: 10.0,
                top: 10.0,
                width: 0.0,
                height: 0.0,
            },
            45.0,
        );
        assert!(degenerate.at(10.0, 10.0).abs() < f64::EPSILON);
    }
}
