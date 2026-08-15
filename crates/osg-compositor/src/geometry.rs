//! The per-frame plan: scene plus frame index, out come textured quads.
//!
//! This is the only place the compositor turns a contract into geometry, and it derives nothing it
//! could ask `osg-scene` for. Cue selection, fade progress, easing, the cue transform, the two
//! scaling rules, the box anchor and every colour come from that crate; what is added here is
//! strictly the placement of atlas cells and the corners of the quads.
//!
//! Determinism: the plan is a pure function of the scene and the frame index. Frame times come from
//! the exact rational timeline rather than an accumulated float, so frame `n` is the same geometry
//! whether it was reached by seeking or by playing, and the emitted vertex list has a fixed order.

use osg_scene::animation::{CueTransform, cue_transform};
use osg_scene::color::Rgba;
use osg_scene::cues::active_cue_at;
use osg_scene::easing::apply_subtitle_animation_easing;
use osg_scene::glyph::{AtlasGlyph, GlyphAtlasDescriptor};
use osg_scene::layout::{SubtitleBox, SubtitlePosition, TextAlign, resolve_subtitle_box};
use osg_scene::scale::scale_subtitle_style_value;

use crate::error::CompositorError;
use crate::style::SubtitleStyle;
use crate::subtitle::{CueRun, SubtitleScene};

/// How many `f32` one vertex carries: position, uv, colour, rounded-box shape, shape parameters.
pub(crate) const VERTEX_FLOATS: usize = 14;

/// The byte stride of one vertex.
pub(crate) const VERTEX_STRIDE: u64 = (VERTEX_FLOATS * 4) as u64;

/// A solid rounded box.
const KIND_BOX: f64 = 0.0;
/// A textured atlas cell.
const KIND_GLYPH: f64 = 1.0;

/// An axis-aligned rectangle before the cue transform is applied.
#[derive(Debug, Clone, Copy)]
struct Rect {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

impl Rect {
    const ZERO: Self = Self {
        left: 0.0,
        top: 0.0,
        width: 0.0,
        height: 0.0,
    };
}

/// The cue transform as an affine map on composition pixels.
///
/// `flip` is the horizontal foreshortening of `rotate_y_degrees`. It is the orthographic projection
/// of the rotation, with no perspective: the shipped renderer's `rotateY` reads as a horizontal
/// squeeze at these angles, and inventing a projection matrix here would be a maths the scene
/// contract does not define.
#[derive(Debug, Clone, Copy)]
struct Placement {
    centre_x: f64,
    centre_y: f64,
    scale: f64,
    flip: f64,
    cosine: f64,
    sine: f64,
    offset_x: f64,
    offset_y: f64,
}

impl Placement {
    fn new(transform: CueTransform, centre: (f64, f64), composition_height: f64) -> Self {
        let radians = transform.rotate_degrees.to_radians();
        Self {
            centre_x: centre.0,
            centre_y: centre.1,
            scale: transform.scale,
            flip: transform.rotate_y_degrees.to_radians().cos(),
            cosine: radians.cos(),
            sine: radians.sin(),
            // Transform offsets are authored against the 1080-high reference, like every other size.
            offset_x: scale_subtitle_style_value(transform.translate_x, composition_height),
            offset_y: scale_subtitle_style_value(transform.translate_y, composition_height),
        }
    }

    fn apply(self, x: f64, y: f64) -> (f64, f64) {
        let local_x = (x - self.centre_x) * self.scale * self.flip;
        let local_y = (y - self.centre_y) * self.scale;
        (
            self.offset_x + self.centre_x + local_x.mul_add(self.cosine, -(local_y * self.sine)),
            self.offset_y + self.centre_y + local_x.mul_add(self.sine, local_y * self.cosine),
        )
    }
}

/// The composition-wide values one frame's geometry is measured in.
#[derive(Debug, Clone, Copy)]
struct Metrics {
    width: f64,
    height: f64,
    glyph_scale: f64,
    line_height: f64,
    baseline: f64,
    padding_x: f64,
    padding_y: f64,
    radius: f64,
}

impl Metrics {
    fn resolve(
        atlas: &GlyphAtlasDescriptor,
        style: &SubtitleStyle,
        width: f64,
        height: f64,
    ) -> Self {
        // Sizes scale with composition height; the atlas is baked once at its own size, so the cells
        // are scaled by the ratio between the two rather than re-baked per resolution. That is what
        // lets the preview and the export consume the same atlas bytes at different resolutions.
        let font_size = scale_subtitle_style_value(style.font_size(), height);
        let glyph_scale = font_size / atlas.face().font_size_px;
        Self {
            width,
            height,
            glyph_scale,
            line_height: atlas.metrics().line_height_px * glyph_scale * style.line_spacing(),
            baseline: atlas.metrics().baseline_px * glyph_scale,
            padding_x: scale_subtitle_style_value(style.background_padding_x(), height),
            padding_y: scale_subtitle_style_value(style.background_padding_y(), height),
            radius: scale_subtitle_style_value(style.border_radius(), height),
        }
    }
}

/// Build the vertex list for one frame, or an empty list when nothing is visible.
///
/// # Errors
/// Returns [`CompositorError::FrameOutOfRange`] when the index is not in the scene's timeline.
pub(crate) fn build_frame_vertices(
    scene: &SubtitleScene,
    frame_index: u32,
) -> Result<Vec<f32>, CompositorError> {
    let timeline = scene.scene().timeline();
    let time = timeline
        .frame_time(frame_index)
        .map_err(|_| CompositorError::FrameOutOfRange {
            index: frame_index,
            frame_count: timeline.frame_count(),
        })?;

    let style = scene.style();
    let Some(active) = active_cue_at(scene.timings(), time, style.fade_in(), style.fade_out())
    else {
        return Ok(Vec::new());
    };

    // The fade curve is the easing applied to the selection's own progress, so the easing choice
    // drives opacity and motion together exactly as the shipped renderer does.
    let alpha = style.opacity() * apply_subtitle_animation_easing(active.progress, style.easing());
    let Some(run) = scene.runs().get(active.index) else {
        return Ok(Vec::new());
    };
    if alpha <= 0.0 {
        // An invisible cue emits nothing at all, so a zero-opacity frame is byte-identical to a
        // frame with no cue rather than merely close to it.
        return Ok(Vec::new());
    }

    let atlas = scene.atlas();
    let width = f64::from(scene.scene().width());
    let height = f64::from(scene.scene().height());
    let metrics = Metrics::resolve(atlas, style, width, height);

    let line_widths = line_widths(atlas, run, metrics.glyph_scale);
    let text_width = line_widths.iter().copied().fold(0.0_f64, f64::max);
    let text_height = line_count(run) * metrics.line_height;

    let boxed = resolve_subtitle_box(
        style.position(),
        style.margins(),
        style.custom_x(),
        style.custom_y(),
        style.align(),
        width,
        height,
    );
    let block_left = block_left(&boxed, style.position(), text_width);
    let box_height = text_height + metrics.padding_y * 2.0;
    let block_top = boxed.anchor_bias.mul_add(-box_height, boxed.anchor_y);

    let placement = Placement::new(
        cue_transform(
            style.animation(),
            active.phase,
            active.progress,
            style.easing(),
        ),
        (block_left + text_width / 2.0, block_top + box_height / 2.0),
        height,
    );

    let mut vertices = Vec::new();
    if style.background_visible() {
        emit(
            &mut vertices,
            placement,
            metrics,
            Rect {
                left: block_left - metrics.padding_x,
                top: block_top,
                width: text_width + metrics.padding_x * 2.0,
                height: box_height,
            },
            Rect::ZERO,
            (metrics.radius, KIND_BOX, tint(style.background(), alpha)),
        );
    }
    emit_glyphs(
        &mut vertices,
        &GlyphPass {
            atlas,
            run,
            placement,
            metrics,
            align: style.align(),
            colour: tint(style.text_color(), alpha),
            block_left,
            block_top,
        },
        &line_widths,
        text_width,
    );
    Ok(vertices)
}

/// Everything the glyph loop needs, bundled so the loop keeps one argument list.
struct GlyphPass<'scene> {
    atlas: &'scene GlyphAtlasDescriptor,
    run: &'scene CueRun,
    placement: Placement,
    metrics: Metrics,
    align: TextAlign,
    colour: [f64; 4],
    block_left: f64,
    block_top: f64,
}

fn emit_glyphs(
    vertices: &mut Vec<f32>,
    pass: &GlyphPass<'_>,
    line_widths: &[f64],
    text_width: f64,
) {
    let atlas_width = f64::from(pass.atlas.atlas().width_px);
    let atlas_height = f64::from(pass.atlas.atlas().height_px);
    // Two ways a run draws nothing at all, and neither is an error: the gradient fill makes the text
    // colour transparent, and a run of nothing but blanks inks no pixel so the atlas has no texture.
    // Walking the pen would produce no quad either way, so it is not walked.
    if pass.colour[3] <= 0.0 || atlas_width <= 0.0 || atlas_height <= 0.0 {
        return;
    }

    let mut baseline = pass.block_top + pass.metrics.padding_y + pass.metrics.baseline;
    for (line, line_width) in pass.run.lines().iter().zip(line_widths) {
        let mut pen = line_left(pass.align, pass.block_left, text_width, *line_width);
        for index in line {
            let Some(cell) = cell_at(pass.atlas, *index) else {
                continue;
            };
            if is_inked(cell) {
                let scale = pass.metrics.glyph_scale;
                emit(
                    vertices,
                    pass.placement,
                    pass.metrics,
                    Rect {
                        left: f64::from(cell.origin_x_px).mul_add(-scale, pen),
                        top: f64::from(cell.origin_y_px).mul_add(-scale, baseline),
                        width: f64::from(cell.width_px) * scale,
                        height: f64::from(cell.height_px) * scale,
                    },
                    Rect {
                        left: f64::from(cell.x_px) / atlas_width,
                        top: f64::from(cell.y_px) / atlas_height,
                        width: f64::from(cell.width_px) / atlas_width,
                        height: f64::from(cell.height_px) / atlas_height,
                    },
                    (0.0, KIND_GLYPH, pass.colour),
                );
            }
            pen += cell.advance_width_px * pass.metrics.glyph_scale;
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

/// Two triangles in a fixed corner order, so the primitive order — and therefore the blend order —
/// is the same on every run.
fn emit(
    vertices: &mut Vec<f32>,
    placement: Placement,
    metrics: Metrics,
    rect: Rect,
    uv: Rect,
    shape: (f64, f64, [f64; 4]),
) {
    const ORDER: [usize; 6] = [0, 1, 2, 0, 2, 3];
    let (radius, kind, colour) = shape;
    let right = rect.left + rect.width;
    let bottom = rect.top + rect.height;
    let corners = [
        placement.apply(rect.left, rect.top),
        placement.apply(right, rect.top),
        placement.apply(right, bottom),
        placement.apply(rect.left, bottom),
    ];
    let uvs = [
        (uv.left, uv.top),
        (uv.left + uv.width, uv.top),
        (uv.left + uv.width, uv.top + uv.height),
        (uv.left, uv.top + uv.height),
    ];
    let half_width = rect.width / 2.0;
    let half_height = rect.height / 2.0;
    let locals = [
        (-half_width, -half_height),
        (half_width, -half_height),
        (half_width, half_height),
        (-half_width, half_height),
    ];
    let radius = radius.min(half_width).min(half_height).max(0.0);

    for index in ORDER {
        let (x, y) = corners[index];
        let (u, v) = uvs[index];
        let (local_x, local_y) = locals[index];
        let fields = [
            (x / metrics.width).mul_add(2.0, -1.0),
            (y / metrics.height).mul_add(-2.0, 1.0),
            u,
            v,
            colour[0],
            colour[1],
            colour[2],
            colour[3],
            local_x,
            local_y,
            half_width,
            half_height,
            radius,
            kind,
        ];
        vertices.extend(fields.into_iter().map(narrow));
    }
}

fn line_widths(atlas: &GlyphAtlasDescriptor, run: &CueRun, glyph_scale: f64) -> Vec<f64> {
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

fn line_count(run: &CueRun) -> f64 {
    u32::try_from(run.lines().len()).map_or(0.0, f64::from)
}

/// Where the text block starts horizontally.
///
/// A custom position collapses the box to a point, so the block is centred on it; otherwise the
/// block is placed inside the resolved box according to the alignment. `Justify` places like `Left`:
/// the shipped renderer accepts it but has no control for it, and stretching a run whose shaping
/// this crate does not own would be inventing layout.
fn block_left(boxed: &SubtitleBox, position: SubtitlePosition, text_width: f64) -> f64 {
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

fn tint(colour: Rgba, alpha: f64) -> [f64; 4] {
    [
        f64::from(colour.red) / 255.0,
        f64::from(colour.green) / 255.0,
        f64::from(colour.blue) / 255.0,
        (f64::from(colour.alpha) / 255.0) * alpha,
    ]
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "vertex attributes are f32; the plan is computed in f64 and narrowed once, here"
)]
fn narrow(value: f64) -> f32 {
    value as f32
}
