//! The headless compositor: one device, one pipeline, one deterministic frame at a time.

use wgpu::{
    BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingType, BlendState, BufferBindingType, BufferDescriptor,
    BufferUsages, Color, ColorTargetState, ColorWrites, CommandEncoderDescriptor, FragmentState,
    LoadOp, MultisampleState, Operations, PipelineLayoutDescriptor, PrimitiveState, RenderPass,
    RenderPassColorAttachment, RenderPassDescriptor, RenderPipeline, RenderPipelineDescriptor,
    ShaderModuleDescriptor, ShaderSource, ShaderStages, StoreOp, TextureDescriptor,
    TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor, VertexState,
};

use crate::device::{AdapterProfile, AdapterSelection, GpuContext};
use crate::error::CompositorError;
use crate::frame::Frame;
use crate::readback;
use crate::scene::{TestScene, UNIFORM_LEN};
use crate::size::FrameSize;

/// The offscreen colour format. Unorm rather than sRGB, so shader output reaches the readback
/// without an encode step that would vary between backends.
const TARGET_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;

/// A headless GPU compositor.
///
/// Construction acquires the adapter, device and pipeline once; [`Compositor::render`] then
/// composes any number of frames without a window or a surface.
#[derive(Debug)]
pub struct Compositor {
    gpu: GpuContext,
    pipeline: RenderPipeline,
    uniform_layout: BindGroupLayout,
}

impl Compositor {
    /// Acquires any usable adapter and builds the pipeline.
    pub fn new() -> Result<Self, CompositorError> {
        Self::with_adapters(AdapterSelection::Automatic)
    }

    /// Acquires an adapter from a restricted selection.
    ///
    /// [`AdapterSelection::None`] is how the no-GPU path is exercised deliberately; it returns
    /// [`CompositorError::NoAdapter`] rather than panicking, exactly as a machine without a usable
    /// adapter does.
    pub fn with_adapters(selection: AdapterSelection) -> Result<Self, CompositorError> {
        let gpu = GpuContext::acquire(selection)?;
        let (pipeline, uniform_layout) = build_pipeline(gpu.device());
        Ok(Self {
            gpu,
            pipeline,
            uniform_layout,
        })
    }

    /// What the compositor acquired.
    #[must_use]
    pub const fn adapter(&self) -> &AdapterProfile {
        self.gpu.profile()
    }

    /// Composes `scene` at `size` and reads the result back as tightly packed RGBA8 bytes.
    ///
    /// The result is a pure function of `scene` and `size` on a given adapter: the same arguments
    /// always produce the same bytes.
    pub fn render(&self, scene: TestScene, size: FrameSize) -> Result<Frame, CompositorError> {
        let device = self.gpu.device();

        let uniforms = device.create_buffer(&BufferDescriptor {
            label: Some("osg-compositor scene uniforms"),
            size: UNIFORM_LEN as u64,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.gpu
            .queue()
            .write_buffer(&uniforms, 0, &scene.uniform_bytes(size));

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor scene bind group"),
            layout: &self.uniform_layout,
            entries: &[BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
        });

        let target = device.create_texture(&TextureDescriptor {
            label: Some("osg-compositor frame"),
            size: readback::frame_extent(size),
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TARGET_FORMAT,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&TextureViewDescriptor::default());
        let staging = readback::staging_buffer(device, size);

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("osg-compositor frame encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("osg-compositor scene pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::BLACK),
                        store: StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            self.draw(&mut pass, &bind_group);
        }
        readback::record_copy(&mut encoder, &target, &staging, size);
        self.gpu.queue().submit(Some(encoder.finish()));

        let pixels = readback::read_packed(device, &staging, size)?;
        Ok(Frame::new(size, pixels))
    }

    fn draw(&self, pass: &mut RenderPass<'_>, bind_group: &wgpu::BindGroup) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

fn build_pipeline(device: &wgpu::Device) -> (RenderPipeline, BindGroupLayout) {
    let shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some("osg-compositor test scene"),
        source: ShaderSource::Wgsl(include_str!("shaders/test_scene.wgsl").into()),
    });

    let uniform_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
        label: Some("osg-compositor scene uniforms layout"),
        entries: &[BindGroupLayoutEntry {
            binding: 0,
            visibility: ShaderStages::VERTEX_FRAGMENT,
            ty: BindingType::Buffer {
                ty: BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });

    let layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
        label: Some("osg-compositor pipeline layout"),
        bind_group_layouts: &[Some(&uniform_layout)],
        immediate_size: 0,
    });

    let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
        label: Some("osg-compositor scene pipeline"),
        layout: Some(&layout),
        vertex: VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        fragment: Some(FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(ColorTargetState {
                format: TARGET_FORMAT,
                blend: Some(BlendState::REPLACE),
                write_mask: ColorWrites::ALL,
            })],
        }),
        primitive: PrimitiveState::default(),
        depth_stencil: None,
        multisample: MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });

    (pipeline, uniform_layout)
}
