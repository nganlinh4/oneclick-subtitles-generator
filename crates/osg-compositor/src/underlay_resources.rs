//! The GPU resources and uniform packing one underlay frame allocates.
//!
//! Split out of [`crate::underlay_pipeline`] so that module holds only the pipelines and how a
//! frame is bound: what follows is the per-frame side — textures created and dropped inside one
//! render, and the crop maths packed for the shader. The generic half — fullscreen pipelines,
//! render targets, samplers, uniform buffers — lives in [`crate::pass`], shared with the blur and
//! the decoration masks rather than copied here.

use wgpu::{
    Device, Extent3d, Origin3d, Queue, TexelCopyBufferLayout, TexelCopyTextureInfo, Texture,
    TextureAspect, TextureDescriptor, TextureDimension, TextureUsages,
};

use crate::crop::{CANVAS_BACKFILL_BRIGHTNESS, CANVAS_BACKFILL_ZOOM, CanvasBackground, Crop};
use crate::pass::{RENDER_FORMAT, narrow};
use crate::size::FrameSize;
use crate::underlay::SourceFrame;

/// The backfill mode as the shader reads it.
const MODE_TRANSPARENT: f64 = 0.0;
const MODE_SOLID: f64 = 1.0;
const MODE_BLUR: f64 = 2.0;

pub(crate) fn upload_source(device: &Device, queue: &Queue, source: &SourceFrame) -> Texture {
    let extent = Extent3d {
        width: source.width(),
        height: source.height(),
        depth_or_array_layers: 1,
    };
    let texture = device.create_texture(&TextureDescriptor {
        label: Some("osg-compositor underlay source"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: RENDER_FORMAT,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        source.pixels(),
        TexelCopyBufferLayout {
            offset: 0,
            // Tightly packed by contract: `SourceFrame` refuses anything else.
            bytes_per_row: Some(source.width() * 4),
            rows_per_image: Some(source.height()),
        },
        extent,
    );
    texture
}

/// A 1x1 transparent texture for the modes that never sample the backfill binding.
///
/// The bind group layout is fixed, so something has to occupy the slot; a texel the shader is
/// branched away from is cheaper and clearer than a second pipeline.
pub(crate) fn placeholder_texture(device: &Device, queue: &Queue) -> Texture {
    let extent = Extent3d {
        width: 1,
        height: 1,
        depth_or_array_layers: 1,
    };
    let texture = device.create_texture(&TextureDescriptor {
        label: Some("osg-compositor backfill placeholder"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: RENDER_FORMAT,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        &[0_u8; 4],
        TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: Some(1),
        },
        extent,
    );
    texture
}

/// `region`, `flags`, `solid` — twelve floats, three `vec4`s, no padding needed.
pub(crate) fn composite_uniforms(crop: Crop) -> [f32; 12] {
    let (mode, colour) = match crop.background() {
        CanvasBackground::Transparent => (MODE_TRANSPARENT, [0.0; 4]),
        CanvasBackground::Solid(colour) => (
            MODE_SOLID,
            [
                f64::from(colour.red) / 255.0,
                f64::from(colour.green) / 255.0,
                f64::from(colour.blue) / 255.0,
                f64::from(colour.alpha) / 255.0,
            ],
        ),
        CanvasBackground::Blur { .. } => (MODE_BLUR, [0.0; 4]),
    };
    [
        crop.left(),
        crop.top(),
        crop.width(),
        crop.height(),
        flag(crop.flip_x()),
        flag(crop.flip_y()),
        mode,
        0.0,
        colour[0],
        colour[1],
        colour[2],
        colour[3],
    ]
    .map(narrow)
}

/// The cover fit: the source is scaled to fill the output without distorting, then over-scaled.
pub(crate) fn cover_uniforms(source: &SourceFrame, crop: Crop, size: FrameSize) -> [f32; 8] {
    let source_aspect = f64::from(source.width()) / f64::from(source.height());
    let output_aspect = f64::from(size.width()) / f64::from(size.height());
    let (mut across, mut down) = (1.0_f64, 1.0_f64);
    if source_aspect > output_aspect {
        across = output_aspect / source_aspect;
    } else {
        down = source_aspect / output_aspect;
    }
    [
        across / CANVAS_BACKFILL_ZOOM,
        down / CANVAS_BACKFILL_ZOOM,
        flag(crop.flip_x()),
        flag(crop.flip_y()),
        CANVAS_BACKFILL_BRIGHTNESS,
        0.0,
        0.0,
        0.0,
    ]
    .map(narrow)
}

const fn flag(set: bool) -> f64 {
    if set { 1.0 } else { 0.0 }
}
