//! The GPU resources and uniform packing one underlay frame allocates.
//!
//! Split out of [`crate::underlay_pipeline`] so that module holds only the pipelines and how a
//! frame is bound: what follows is the per-frame side — textures created and dropped inside one
//! render, and the `f64` crop maths narrowed to `f32` in exactly one place.

use wgpu::{
    BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingType, BlendState, Buffer,
    BufferDescriptor, BufferUsages, ColorTargetState, ColorWrites, CommandEncoder, Device,
    Extent3d, FragmentState, LoadOp, MultisampleState, Operations, Origin3d,
    PipelineLayoutDescriptor, PrimitiveState, Queue, RenderPassColorAttachment,
    RenderPassDescriptor, RenderPipeline, RenderPipelineDescriptor, SamplerBindingType,
    ShaderModule, ShaderStages, StoreOp, TexelCopyBufferLayout, TexelCopyTextureInfo, Texture,
    TextureAspect, TextureDescriptor, TextureDimension, TextureFormat, TextureSampleType,
    TextureUsages, TextureView, TextureViewDimension, VertexState,
};

use crate::crop::{CANVAS_BACKFILL_BRIGHTNESS, CANVAS_BACKFILL_ZOOM, CanvasBackground, Crop};
use crate::size::FrameSize;
use crate::underlay::SourceFrame;

/// The backfill mode as the shader reads it.
const MODE_TRANSPARENT: f64 = 0.0;
const MODE_SOLID: f64 = 1.0;
const MODE_BLUR: f64 = 2.0;

/// The source and intermediate backfill format. Unorm for the same reason the frame target is:
/// nothing between the shader and the readback re-encodes the channels.
pub(crate) const BACKFILL_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;

pub(crate) const fn uniform_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

pub(crate) const fn texture_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: BindingType::Texture {
            sample_type: TextureSampleType::Float { filterable: true },
            view_dimension: TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

pub(crate) const fn sampler_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: BindingType::Sampler(SamplerBindingType::Filtering),
        count: None,
    }
}

/// A pipeline that draws one oversized triangle over the whole target, with no vertex buffer.
pub(crate) fn fullscreen_pipeline(
    device: &Device,
    shader: &ShaderModule,
    entry_point: &str,
    layout: &BindGroupLayout,
    format: TextureFormat,
    label: &str,
) -> RenderPipeline {
    let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[Some(layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        vertex: VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        fragment: Some(FragmentState {
            module: shader,
            entry_point: Some(entry_point),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(ColorTargetState {
                format,
                // The underlay is the ground: it replaces whatever the pass cleared to, and the
                // subtitle layer above it is the only thing that blends.
                blend: Some(BlendState::REPLACE),
                write_mask: ColorWrites::ALL,
            })],
        }),
        primitive: PrimitiveState::default(),
        depth_stencil: None,
        multisample: MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

/// Records one fullscreen draw into its own render pass.
pub(crate) fn fullscreen_draw(
    encoder: &mut CommandEncoder,
    pipeline: &RenderPipeline,
    bind_group: &BindGroup,
    target: &TextureView,
) {
    let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
        label: Some("osg-compositor backfill pass"),
        color_attachments: &[Some(RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: Operations {
                load: LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1);
}

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
        format: BACKFILL_FORMAT,
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

pub(crate) fn backfill_texture(device: &Device, size: FrameSize) -> Texture {
    device.create_texture(&TextureDescriptor {
        label: Some("osg-compositor backfill"),
        size: Extent3d {
            width: size.width(),
            height: size.height(),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: BACKFILL_FORMAT,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
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
        format: BACKFILL_FORMAT,
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

pub(crate) fn uniform_buffer(
    device: &Device,
    queue: &Queue,
    label: &str,
    values: &[f32],
) -> Buffer {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let buffer = device.create_buffer(&BufferDescriptor {
        label: Some(label),
        size: bytes.len() as u64,
        usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, &bytes);
    buffer
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

pub(crate) fn blur_uniforms(across: f64, down: f64, radius: u32, sigma_px: f64) -> [f32; 8] {
    [
        across,
        down,
        f64::from(radius),
        sigma_px,
        0.0,
        0.0,
        0.0,
        0.0,
    ]
    .map(narrow)
}

const fn flag(set: bool) -> f64 {
    if set { 1.0 } else { 0.0 }
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "uniforms are f32; the maths is done in f64 and narrowed once, here"
)]
fn narrow(value: f64) -> f32 {
    value as f32
}
