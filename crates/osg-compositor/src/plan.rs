//! The per-frame plan: scene plus frame index, out come the masks to build and the quads to draw.
//!
//! # Paint order
//!
//! Order is the whole difference between a shadow and a smudge, so it is chosen here once and
//! stated rather than emerging from the order the code happened to be written in. The shipped
//! renderer is a single CSS box, and CSS fixes the order of everything on it:
//!
//! 1. **the glow**, because an outer `box-shadow` is painted *behind* the element's background;
//! 2. **the background box**, which fills the border box, under the border;
//! 3. **the border**, over the background it encloses;
//! 4. **the text shadow**, which belongs to the inline content and is therefore painted *above*
//!    the element's own background and border, not below them;
//! 5. **the stroke**, then
//! 6. **the fill**.
//!
//! Two of those deserve their reason spelled out, because the obvious order is different:
//!
//! - **The glow comes before the shadow, not after.** Putting the text shadow first would let the
//!   background box — 70% opaque black in the shipped defaults — paint over it, so a coloured
//!   shadow on a dark box would vanish. In the shipped renderer it does not: the shadow sits on top
//!   of the box. `a_text_shadow_is_painted_over_the_background_box` is the test that catches the
//!   swap.
//! - **The stroke comes before the fill, not after.** CSS paints `-webkit-text-stroke` over the
//!   fill because the stroke is *centred* on the contour, so its inner half is meant to cover the
//!   letter. This draws the outer half underneath instead, for the reason `crate::glyphs` records:
//!   with coverage and no contours, the outward dilation is the half that can be reproduced. Fill
//!   over stroke is what makes that half read as an outline rather than as a fattened glyph.
//!
//! Determinism is unchanged by any of it: the plan is a pure function of the scene and the frame
//! index, frame times come from the exact rational timeline rather than an accumulated float, and
//! the emitted vertex list has a fixed order, so seeking to a frame and playing up to it produce
//! the same bytes.

use osg_scene::animation::{AnimationType, cue_transform};
use osg_scene::cues::{CuePhase, active_cue_at};
use osg_scene::easing::apply_subtitle_animation_easing;
use osg_scene::layout::resolve_subtitle_box;

use crate::decoration::{FillPaint, decoration_blur_radius_px, decoration_blur_sigma_px};
use crate::error::CompositorError;
use crate::geometry::{
    KIND_BORDER, KIND_BOX, KIND_GLOW, KIND_GLYPH, MASK_INK, Metrics, Placement, Quad, Rect, Shape,
    UvSource, VERTEX_FLOATS, emit, tint,
};
use crate::glyphs::{
    GlyphDraw, GlyphPaint, GlyphPass, GradientLine, block_left, emit_glyphs, line_count,
    line_widths, run_align,
};
use crate::style::SubtitleStyle;
use crate::subtitle::SubtitleScene;
use crate::typewriter::revealed_cells;

/// A pixel of slack, so an edge that lands on the quad's own boundary has room to antialias.
const EDGE_SLACK: f64 = 1.0;

/// Which texture a run of quads samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BindSource {
    /// The glyph atlas page the frame resolved, from [`FramePlan::atlas_page`].
    ///
    /// One variant rather than one per page, because a frame draws exactly one cue and therefore
    /// samples exactly one page. Carrying the page here instead would split the frame's quads into
    /// segments that can never differ.
    Atlas,
    /// A blurred mask this frame built, by index into [`FramePlan::masks`].
    Mask(usize),
}

/// One contiguous run of quads that share a bound texture.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Segment {
    pub(crate) source: BindSource,
    pub(crate) first: u32,
    pub(crate) count: u32,
}

/// A mask to render and blur before the frame's own pass begins.
#[derive(Debug, Clone)]
pub(crate) struct MaskJob {
    pub(crate) vertices: Vec<f32>,
    pub(crate) sigma_px: f64,
    pub(crate) radius: u32,
}

/// Everything one frame draws.
#[derive(Debug, Clone, Default)]
pub(crate) struct FramePlan {
    vertices: Vec<f32>,
    segments: Vec<Segment>,
    masks: Vec<MaskJob>,
    atlas_page: Option<usize>,
}

impl FramePlan {
    pub(crate) fn vertices(&self) -> &[f32] {
        &self.vertices
    }

    pub(crate) fn segments(&self) -> &[Segment] {
        &self.segments
    }

    pub(crate) fn masks(&self) -> &[MaskJob] {
        &self.masks
    }

    /// The atlas page every [`BindSource::Atlas`] segment of this frame samples.
    ///
    /// `None` when the plan draws nothing: no cue is visible, its opacity is zero, or its run is
    /// missing. Such a plan emits no atlas segment either, so there is no page to resolve.
    pub(crate) const fn atlas_page(&self) -> Option<usize> {
        self.atlas_page
    }

    fn vertex_count(&self) -> u32 {
        u32::try_from(self.vertices.len() / VERTEX_FLOATS).unwrap_or(0)
    }

    /// Append quads bound to one source, merging with the previous run when it matches.
    fn stage(&mut self, source: BindSource, fill: impl FnOnce(&mut Vec<f32>)) {
        let first = self.vertex_count();
        fill(&mut self.vertices);
        let count = self.vertex_count().saturating_sub(first);
        if count == 0 {
            return;
        }
        match self.segments.last_mut() {
            Some(last) if last.source == source && last.first + last.count == first => {
                last.count += count;
            }
            _ => self.segments.push(Segment {
                source,
                first,
                count,
            }),
        }
    }

    fn add_mask(&mut self, vertices: Vec<f32>, sigma_px: f64) -> usize {
        self.masks.push(MaskJob {
            radius: decoration_blur_radius_px(sigma_px),
            vertices,
            sigma_px,
        });
        self.masks.len() - 1
    }
}

/// The boxes one cue occupies, in composition pixels before the cue transform.
#[derive(Debug, Clone, Copy)]
struct Boxes {
    /// The outer edge: what the background fills, the border rings and the glow is cast from.
    border: Rect,
    /// Inside the border: what the gradient ramp is measured over.
    padding: Rect,
    /// The top of the text block itself.
    text_top: f64,
}

/// One visible cue, resolved: everything the six painting steps below read.
struct Cue<'scene> {
    style: &'scene SubtitleStyle,
    pass: GlyphPass<'scene>,
    boxes: Boxes,
    /// The dilation radius of the stroke, in output pixels. Zero when nothing is stroked.
    outline_px: f64,
    /// The cue's fade and flat opacity, already combined.
    alpha: f64,
}

/// Build the plan for one frame, or an empty plan when nothing is visible.
///
/// # Errors
/// Returns [`CompositorError::FrameOutOfRange`] when the index is not in the scene's timeline.
pub(crate) fn build_frame_plan(
    scene: &SubtitleScene,
    frame_index: u32,
) -> Result<FramePlan, CompositorError> {
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
        return Ok(FramePlan::default());
    };

    // The fade curve is the easing applied to the selection's own progress, so the easing choice
    // drives opacity and motion together exactly as the shipped renderer does.
    let alpha = style.opacity() * apply_subtitle_animation_easing(active.progress, style.easing());
    let Some(run) = scene.runs().get(active.index) else {
        return Ok(FramePlan::default());
    };
    if alpha <= 0.0 {
        // An invisible cue emits nothing at all, so a zero-opacity frame is byte-identical to a
        // frame with no cue rather than merely close to it.
        return Ok(FramePlan::default());
    }

    // The page this cue was baked into, and the only one this frame samples. A cue whose page the
    // scene does not know is unreachable — `SubtitleScene::new` refuses one — so it draws nothing
    // rather than being drawn from a page that is not its own.
    let (Some(page), Some(atlas)) = (
        scene.page_of_cue(active.index),
        scene.atlas_for(active.index),
    ) else {
        return Ok(FramePlan::default());
    };
    let width = f64::from(scene.scene().width());
    let height = f64::from(scene.scene().height());
    let metrics = Metrics::resolve(atlas, style, width, height);

    let widths = line_widths(run, metrics.glyph_scale);
    let text_width = widths.iter().copied().fold(0.0_f64, f64::max);
    // The same height the layout emits — its line count times its line box — rather than a second
    // opinion about how tall a line is.
    let text_height = line_count(run) * metrics.line_height;

    // Alignment comes from the layout and not from the style, for the reason `run_align` records:
    // the baker resolved CSS `start` against the paragraph direction, and it is the only side that
    // knows what that direction was.
    let align = run_align(atlas);
    let boxed = resolve_subtitle_box(
        style.position(),
        style.margins(),
        style.custom_x(),
        style.custom_y(),
        align,
        width,
        height,
    );
    let block_left = block_left(&boxed, style.position(), text_width);
    let layout = resolve_boxes(
        &metrics,
        (boxed.anchor_y, boxed.anchor_bias),
        block_left,
        (text_width, text_height),
    );

    let placement = Placement::new(
        cue_transform(
            style.animation(),
            active.phase,
            active.progress,
            style.easing(),
        ),
        layout.border.centre(),
        height,
    );
    let cue = Cue {
        style,
        pass: GlyphPass {
            atlas,
            run,
            placement,
            metrics,
            align,
            block_left,
            text_top: layout.text_top,
            text_width,
            line_widths: &widths,
            // The shipped renderer types only on the way in, and takes the raw progress rather than
            // the eased one. Both are reproduced: with no fade-in window there is no fading-in
            // phase, so typewriter is the no-op it has always been at `fadeInDuration: 0`.
            revealed: (style.animation() == AnimationType::Typewriter
                && active.phase == CuePhase::FadingIn)
                .then(|| revealed_cells(atlas, run, active.progress)),
        },
        boxes: layout,
        outline_px: style
            .decoration()
            .stroke_effect()
            // A centred CSS stroke reaches half its width outside the contour, and that outer half
            // is what a dilation can reproduce, so the radius is half the stored width.
            .map_or(0.0, |stroke| metrics.scaled(stroke.width) / 2.0),
        alpha,
    };

    let mut plan = FramePlan {
        atlas_page: Some(page),
        ..FramePlan::default()
    };
    glow(&mut plan, &cue);
    background(&mut plan, &cue);
    border(&mut plan, &cue);
    text_shadow(&mut plan, &cue);
    text(&mut plan, &cue);
    Ok(plan)
}

/// The border box, the padding box inside it, and where the text block starts.
///
/// A border grows the box outward and the anchor holds the *outer* edge, which is what CSS does:
/// the element's border box is what the container places, so switching a border on moves the text
/// inward rather than leaving the outer edge where it was. With no border the three collapse to
/// exactly the geometry the crate had before borders existed.
fn resolve_boxes(
    metrics: &Metrics,
    anchor: (f64, f64),
    block_left: f64,
    text: (f64, f64),
) -> Boxes {
    let (anchor_y, anchor_bias) = anchor;
    let (text_width, text_height) = text;
    let padding_height = metrics.padding_y.mul_add(2.0, text_height);
    let border = Rect {
        left: block_left - metrics.padding_x - metrics.border_width,
        top: anchor_bias.mul_add(-metrics.border_width.mul_add(2.0, padding_height), anchor_y),
        width: (metrics.padding_x + metrics.border_width).mul_add(2.0, text_width),
        height: metrics.border_width.mul_add(2.0, padding_height),
    };
    let padding = border.grown(-metrics.border_width);
    Boxes {
        text_top: padding.top + metrics.padding_y,
        border,
        padding,
    }
}

/// The glow: a blurred copy of the border box with the box cut back out of it.
///
/// Cutting the box out is not decoration, it is what makes this a CSS *outer* shadow. Without it a
/// translucent background — the shipped default is 70% — would have the glow shining through from
/// underneath and read as a lighter box.
fn glow(plan: &mut FramePlan, cue: &Cue<'_>) {
    let Some(glow) = cue.style.decoration().glow_effect() else {
        return;
    };
    let metrics = cue.pass.metrics;
    let sigma_px = decoration_blur_sigma_px(metrics.scaled(glow.intensity));
    let radius = f64::from(decoration_blur_radius_px(sigma_px));
    let shape = Shape::of(cue.boxes.border, metrics.radius);

    let mut mask = Vec::new();
    emit(
        &mut mask,
        cue.pass.placement,
        metrics,
        &Quad::solid(cue.boxes.border, shape, KIND_BOX, MASK_INK),
    );
    let index = plan.add_mask(mask, sigma_px);

    let colour = tint(glow.color, cue.alpha);
    plan.stage(BindSource::Mask(index), |vertices| {
        emit(
            vertices,
            cue.pass.placement,
            metrics,
            &Quad {
                rect: cue.boxes.border.grown(radius + EDGE_SLACK),
                uv: UvSource::Screen,
                shape,
                colours: [colour; 4],
                kind: KIND_GLOW,
                aux: (0.0, 0.0),
                cell: [0.0; 4],
            },
        );
    });
}

/// The background box, which fills the border box and sits under the border.
fn background(plan: &mut FramePlan, cue: &Cue<'_>) {
    if !cue.style.background_visible() {
        return;
    }
    let metrics = cue.pass.metrics;
    let colour = tint(cue.style.background(), cue.alpha);
    plan.stage(BindSource::Atlas, |vertices| {
        emit(
            vertices,
            cue.pass.placement,
            metrics,
            &Quad::solid(
                cue.boxes.border,
                Shape::of(cue.boxes.border, metrics.radius),
                KIND_BOX,
                colour,
            ),
        );
    });
}

/// The border ring, patterned by its style.
fn border(plan: &mut FramePlan, cue: &Cue<'_>) {
    let Some(border) = cue.style.decoration().border_effect() else {
        return;
    };
    let metrics = cue.pass.metrics;
    let colour = tint(border.color, cue.alpha);
    let aux = (metrics.border_width, border.style.shader_code());
    plan.stage(BindSource::Atlas, |vertices| {
        emit(
            vertices,
            cue.pass.placement,
            metrics,
            &Quad {
                rect: cue.boxes.border.grown(EDGE_SLACK),
                uv: UvSource::None,
                shape: Shape::of(cue.boxes.border, metrics.radius),
                colours: [colour; 4],
                kind: KIND_BORDER,
                aux,
                cell: [0.0; 4],
            },
        );
    });
}

/// The drop shadow: the same shapes the text draws, offset, blurred and tinted.
///
/// The mask carries the stroke as well as the fill, because the shipped renderer shadows the text
/// as it is painted rather than the fill alone, and a stroked letter's shadow is the stroked
/// silhouette.
fn text_shadow(plan: &mut FramePlan, cue: &Cue<'_>) {
    let Some(shadow) = cue.style.decoration().text_shadow_effect() else {
        return;
    };
    let metrics = cue.pass.metrics;
    let offset = (
        metrics.scaled(shadow.offset_x),
        metrics.scaled(shadow.offset_y),
    );
    let sigma_px = decoration_blur_sigma_px(metrics.scaled(shadow.blur));

    let mut mask = Vec::new();
    if cue.outline_px > 0.0 {
        emit_glyphs(
            &mut mask,
            &cue.pass,
            &GlyphDraw {
                paint: GlyphPaint::Flat(MASK_INK),
                offset,
                outline_px: cue.outline_px,
            },
        );
    }
    emit_glyphs(
        &mut mask,
        &cue.pass,
        &GlyphDraw {
            paint: GlyphPaint::Flat(MASK_INK),
            offset,
            outline_px: 0.0,
        },
    );
    if mask.is_empty() {
        return;
    }
    let index = plan.add_mask(mask, sigma_px);

    let colour = tint(shadow.color, cue.alpha);
    let frame = Rect {
        left: 0.0,
        top: 0.0,
        width: metrics.width,
        height: metrics.height,
    };
    let unit = Rect {
        left: 0.0,
        top: 0.0,
        width: 1.0,
        height: 1.0,
    };
    plan.stage(BindSource::Mask(index), |vertices| {
        emit(
            vertices,
            // The mask is already in screen space, transform and all, so the quad that lays it
            // down must not be transformed a second time.
            Placement::identity(),
            metrics,
            &Quad {
                rect: frame,
                uv: UvSource::Rect(unit),
                shape: Shape::NONE,
                colours: [colour; 4],
                kind: KIND_GLYPH,
                aux: (0.0, 0.0),
                cell: [0.0; 4],
            },
        );
    });
}

/// The stroke and then the fill, in that order and for the reason this module's header gives.
fn text(plan: &mut FramePlan, cue: &Cue<'_>) {
    let stroke = cue
        .style
        .decoration()
        .stroke_effect()
        .map(|stroke| GlyphPaint::Flat(tint(stroke.color, cue.alpha)));
    let fill = match cue.style.fill() {
        FillPaint::Solid(colour) => GlyphPaint::Flat(tint(colour, cue.alpha)),
        FillPaint::Gradient(gradient) => GlyphPaint::Gradient {
            start: tint(gradient.start, cue.alpha),
            end: tint(gradient.end, cue.alpha),
            line: GradientLine::new(cue.boxes.padding, gradient.degrees),
        },
    };

    plan.stage(BindSource::Atlas, |vertices| {
        if let Some(paint) = stroke {
            emit_glyphs(
                vertices,
                &cue.pass,
                &GlyphDraw {
                    paint,
                    offset: (0.0, 0.0),
                    outline_px: cue.outline_px,
                },
            );
        }
        emit_glyphs(
            vertices,
            &cue.pass,
            &GlyphDraw {
                paint: fill,
                offset: (0.0, 0.0),
                outline_px: 0.0,
            },
        );
    });
}
