//! Quad primitives: the vertex layout, the cue transform and the one place a rectangle becomes
//! six vertices.
//!
//! This module derives nothing it could ask `osg-scene` for. Cue selection, fade progress, easing,
//! the cue transform, the two scaling rules, the box anchor and every colour come from that crate;
//! what is added here is strictly the placement of corners and the packing of attributes.
//!
//! Determinism: a quad is a pure function of its inputs, the corner order is fixed, and the emitted
//! vertex list has a fixed order, so the blend order of two overlapping quads is the order they
//! were planned in rather than whatever the driver chose.

use osg_scene::animation::CueTransform;
use osg_scene::color::Rgba;
use osg_scene::glyph::GlyphAtlasDescriptor;
use osg_scene::scale::scale_subtitle_style_value;

use crate::pass::narrow;
use crate::style::SubtitleStyle;

/// How many `f32` one vertex carries: position, uv, colour, shape, parameters, atlas cell.
pub(crate) const VERTEX_FLOATS: usize = 20;

/// The byte stride of one vertex.
pub(crate) const VERTEX_STRIDE: u64 = (VERTEX_FLOATS * 4) as u64;

/// A solid rounded box: the subtitle background, and the shape the glow is cast from.
pub(crate) const KIND_BOX: f64 = 0.0;
/// A textured cell, sampled straight: an atlas glyph, or a blurred mask laid over the frame.
pub(crate) const KIND_GLYPH: f64 = 1.0;
/// A glyph dilated by the stroke radius.
pub(crate) const KIND_STROKE: f64 = 2.0;
/// The ring between the border box and the padding box, patterned by its style.
pub(crate) const KIND_BORDER: f64 = 3.0;
/// A blurred box mask with the box itself cut back out of it, which is a CSS outer box shadow.
pub(crate) const KIND_GLOW: f64 = 4.0;

/// An axis-aligned rectangle before the cue transform is applied.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl Rect {
    /// The rectangle grown by `margin` on every side.
    pub(crate) fn grown(self, margin: f64) -> Self {
        Self {
            left: self.left - margin,
            top: self.top - margin,
            width: margin.mul_add(2.0, self.width),
            height: margin.mul_add(2.0, self.height),
        }
    }

    pub(crate) fn centre(self) -> (f64, f64) {
        (self.left + self.width / 2.0, self.top + self.height / 2.0)
    }

    pub(crate) fn half(self) -> (f64, f64) {
        (self.width / 2.0, self.height / 2.0)
    }

    /// The four corners in the fixed order the vertex emitter uses.
    fn corners(self) -> [(f64, f64); 4] {
        let right = self.left + self.width;
        let bottom = self.top + self.height;
        [
            (self.left, self.top),
            (right, self.top),
            (right, bottom),
            (self.left, bottom),
        ]
    }
}

/// The cue transform as an affine map on composition pixels.
///
/// `flip` is the horizontal foreshortening of `rotate_y_degrees`. It is the orthographic projection
/// of the rotation, with no perspective: the shipped renderer's `rotateY` reads as a horizontal
/// squeeze at these angles, and inventing a projection matrix here would be a maths the scene
/// contract does not define.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Placement {
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
    pub(crate) fn new(
        transform: CueTransform,
        centre: (f64, f64),
        composition_height: f64,
    ) -> Self {
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

    /// The transform that moves nothing, for a quad already expressed in composition pixels.
    pub(crate) const fn identity() -> Self {
        Self {
            centre_x: 0.0,
            centre_y: 0.0,
            scale: 1.0,
            flip: 1.0,
            cosine: 1.0,
            sine: 0.0,
            offset_x: 0.0,
            offset_y: 0.0,
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
pub(crate) struct Metrics {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) glyph_scale: f64,
    pub(crate) line_height: f64,
    pub(crate) padding_x: f64,
    pub(crate) padding_y: f64,
    pub(crate) radius: f64,
    pub(crate) border_width: f64,
}

impl Metrics {
    pub(crate) fn resolve(
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
            // The atlas line box, scaled and nothing else. The baker owns line height: it derives
            // every baseline from it, so multiplying by the style's own line spacing here would
            // apply it twice and put every line after the first in the wrong place. The style
            // value is what the staging boundary bakes with, not what this crate re-applies.
            line_height: atlas.metrics().line_height_px * glyph_scale,
            padding_x: scale_subtitle_style_value(style.background_padding_x(), height),
            padding_y: scale_subtitle_style_value(style.background_padding_y(), height),
            radius: scale_subtitle_style_value(style.border_radius(), height),
            border_width: style.decoration().border_effect().map_or(0.0, |border| {
                scale_subtitle_style_value(border.width, height)
            }),
        }
    }

    /// Scale a reference-pixel style value for this composition.
    pub(crate) fn scaled(self, value: f64) -> f64 {
        scale_subtitle_style_value(value, self.height)
    }
}

/// The rounded box a fragment measures itself against, independent of the quad that carries it.
///
/// The two are separate because a glow quad is much larger than the box it is the shadow of: it has
/// to reach three deviations past the border box, while still reporting the border box's own
/// corners so the shader can cut the box back out of the blur.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Shape {
    pub(crate) centre: (f64, f64),
    pub(crate) half: (f64, f64),
    pub(crate) radius: f64,
}

impl Shape {
    pub(crate) const NONE: Self = Self {
        centre: (0.0, 0.0),
        half: (0.0, 0.0),
        radius: 0.0,
    };

    /// The rectangle's own shape, with a corner radius.
    pub(crate) fn of(rect: Rect, radius: f64) -> Self {
        Self {
            centre: rect.centre(),
            half: rect.half(),
            radius,
        }
    }
}

/// Where a fragment's texture coordinates come from.
#[derive(Debug, Clone, Copy)]
pub(crate) enum UvSource {
    /// A rectangle in the bound texture's own space.
    Rect(Rect),
    /// The fragment's own position in the frame, for a full-frame mask.
    Screen,
    /// Nothing is sampled.
    None,
}

/// One quad's complete description.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Quad {
    pub(crate) rect: Rect,
    pub(crate) uv: UvSource,
    pub(crate) shape: Shape,
    /// Straight RGBA per corner, in the corner order [`Rect::corners`] produces. Four different
    /// colours is what makes a linear gradient exact: the ramp is affine over the quad, so
    /// interpolating the corners reproduces it without a second colour attribute.
    pub(crate) colours: [[f64; 4]; 4],
    pub(crate) kind: f64,
    /// Kind-specific parameters: the stroke's ring radius in texture units, or the border's width
    /// and style code.
    pub(crate) aux: (f64, f64),
    /// The bound cell's texture bounds, so a dilating sample cannot reach its neighbour.
    pub(crate) cell: [f64; 4],
}

impl Quad {
    /// A quad of one flat colour that samples nothing.
    pub(crate) fn solid(rect: Rect, shape: Shape, kind: f64, colour: [f64; 4]) -> Self {
        Self {
            rect,
            uv: UvSource::None,
            shape,
            colours: [colour; 4],
            kind,
            aux: (0.0, 0.0),
            cell: [0.0; 4],
        }
    }
}

/// Two triangles in a fixed corner order, so the primitive order — and therefore the blend order —
/// is the same on every run.
pub(crate) fn emit(vertices: &mut Vec<f32>, placement: Placement, metrics: Metrics, quad: &Quad) {
    const ORDER: [usize; 6] = [0, 1, 2, 0, 2, 3];
    let points = quad.rect.corners();
    let corners = points.map(|(x, y)| placement.apply(x, y));
    let uvs = match quad.uv {
        UvSource::Rect(uv) => uv.corners(),
        UvSource::Screen => corners.map(|(x, y)| (x / metrics.width, y / metrics.height)),
        UvSource::None => [(0.0, 0.0); 4],
    };
    let locals = points.map(|(x, y)| (x - quad.shape.centre.0, y - quad.shape.centre.1));
    let radius = quad
        .shape
        .radius
        .min(quad.shape.half.0)
        .min(quad.shape.half.1)
        .max(0.0);

    for index in ORDER {
        let (x, y) = corners[index];
        let (u, v) = uvs[index];
        let (local_x, local_y) = locals[index];
        let colour = quad.colours[index];
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
            quad.shape.half.0,
            quad.shape.half.1,
            radius,
            quad.kind,
            quad.aux.0,
            quad.aux.1,
            quad.cell[0],
            quad.cell[1],
            quad.cell[2],
            quad.cell[3],
        ];
        vertices.extend(fields.into_iter().map(narrow));
    }
}

/// A colour with the cue's own fade and opacity folded in.
pub(crate) fn tint(colour: Rgba, alpha: f64) -> [f64; 4] {
    [
        f64::from(colour.red) / 255.0,
        f64::from(colour.green) / 255.0,
        f64::from(colour.blue) / 255.0,
        (f64::from(colour.alpha) / 255.0) * alpha,
    ]
}

/// Opaque white: what a mask is drawn in, before anything tints it.
pub(crate) const MASK_INK: [f64; 4] = [1.0, 1.0, 1.0, 1.0];
