//! Generic offscreen-pass plumbing, shared by the underlay, the blur and the decorations.
//!
//! Nothing here knows what is being drawn. It exists so the crate has exactly one definition of a
//! fullscreen pipeline, an offscreen render target, a clamped linear sampler and the single place
//! `f64` composition maths is narrowed to the `f32` a uniform or a vertex carries. Three call sites
//! grew their own copies of these before the decoration pass arrived, which is how two separable
//! Gaussians would have ended up in the crate.

use wgpu::{
    AddressMode, BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingType, BlendState, Buffer,
    BufferDescriptor, BufferUsages, ColorTargetState, ColorWrites, CommandEncoder, Device,
    Extent3d, FilterMode, FragmentState, LoadOp, MipmapFilterMode, MultisampleState, Operations,
    PipelineLayoutDescriptor, PrimitiveState, RenderPass, RenderPassColorAttachment,
    RenderPassDescriptor, RenderPipeline, RenderPipelineDescriptor, Sampler, SamplerBindingType,
    SamplerDescriptor, ShaderModule, ShaderStages, StoreOp, TextureDescriptor, TextureDimension,
    TextureFormat, TextureSampleType, TextureUsages, TextureViewDimension, VertexState,
};

use crate::size::FrameSize;

/// The format every offscreen intermediate uses.
///
/// Unorm rather than sRGB, for the same reason the frame target is: nothing between a shader and
/// the readback may re-encode the channels, or two adapters would disagree in the last bit.
pub(crate) const RENDER_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;

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
                // A fullscreen stage is the ground of whatever it draws into: it replaces the clear
                // rather than blending with it.
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

/// Begins a pass that clears `target` to transparent and stores the result.
pub(crate) fn clearing_pass<'encoder>(
    encoder: &'encoder mut CommandEncoder,
    target: &wgpu::TextureView,
    label: &str,
) -> RenderPass<'encoder> {
    encoder.begin_render_pass(&RenderPassDescriptor {
        label: Some(label),
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
    })
}

/// Records one fullscreen draw into its own render pass.
pub(crate) fn fullscreen_draw(
    encoder: &mut CommandEncoder,
    pipeline: &RenderPipeline,
    bind_group: &BindGroup,
    target: &wgpu::TextureView,
) {
    let mut pass = clearing_pass(encoder, target, "osg-compositor fullscreen pass");
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1);
}

pub(crate) fn uniform_buffer(
    device: &Device,
    queue: &wgpu::Queue,
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

/// An offscreen colour target at the composition size, drawable into and samplable afterwards.
pub(crate) fn render_target(device: &Device, size: FrameSize, label: &str) -> wgpu::Texture {
    device.create_texture(&TextureDescriptor {
        label: Some(label),
        size: Extent3d {
            width: size.width(),
            height: size.height(),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: RENDER_FORMAT,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// Linear filtering with clamped addressing.
///
/// Linear because every source here is scaled to a composition size it was not authored at;
/// clamped because a sample that lands on the very edge must not wrap to the far side of the
/// texture, which would put one frame's opposite corner into the other's border.
pub(crate) fn linear_clamp_sampler(device: &Device, label: &str) -> Sampler {
    device.create_sampler(&SamplerDescriptor {
        label: Some(label),
        address_mode_u: AddressMode::ClampToEdge,
        address_mode_v: AddressMode::ClampToEdge,
        address_mode_w: AddressMode::ClampToEdge,
        mag_filter: FilterMode::Linear,
        min_filter: FilterMode::Linear,
        mipmap_filter: MipmapFilterMode::Nearest,
        ..SamplerDescriptor::default()
    })
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "uniforms and vertex attributes are f32; the maths is done in f64 and narrowed here"
)]
pub(crate) fn narrow(value: f64) -> f32 {
    value as f32
}
