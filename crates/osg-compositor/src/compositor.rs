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

use crate::blur::SeparableBlur;
use crate::device::{AdapterProfile, AdapterSelection, GpuContext};
use crate::error::CompositorError;
use crate::frame::Frame;
use crate::masks;
use crate::plan::{BindSource, build_frame_plan};
use crate::quad_pipeline::{QuadPipeline, vertex_buffer};
use crate::readback;
use crate::scene::{TestScene, UNIFORM_LEN};
use crate::size::FrameSize;
use crate::subtitle::SubtitleScene;
use crate::underlay::VideoUnderlay;
use crate::underlay_pipeline::UnderlayPipeline;

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
    quads: QuadPipeline,
    underlay: UnderlayPipeline,
    blur: SeparableBlur,
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
        let quads = QuadPipeline::build(gpu.device(), TARGET_FORMAT);
        let underlay = UnderlayPipeline::build(gpu.device(), TARGET_FORMAT);
        let blur = SeparableBlur::build(gpu.device());
        Ok(Self {
            gpu,
            pipeline,
            uniform_layout,
            quads,
            underlay,
            blur,
        })
    }

    /// What the compositor acquired.
    #[must_use]
    pub const fn adapter(&self) -> &AdapterProfile {
        self.gpu.profile()
    }

    /// Composes the reference [`TestScene`] at `size` and reads it back as tightly packed RGBA8.
    ///
    /// This is the pipeline probe, not the renderer: it draws a fixed image that exercises device
    /// acquisition, the render pass and the row-unpadded readback without needing an atlas or a
    /// scene contract. [`Compositor::render_scene`] is the path that draws subtitles.
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

        self.compose(size, Color::BLACK, |pass| {
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        })
    }

    /// Composes one frame of a subtitle scene and reads it back as tightly packed RGBA8 bytes.
    ///
    /// This is the compositor's primary path: the scene contract in, the frame the editor and the
    /// export both show out. The result is a pure function of `scene` and `frame_index` — the same
    /// pair always produces the same bytes on a given adapter, whatever was rendered before it, so
    /// seeking to a frame and playing up to it cannot disagree.
    ///
    /// Pixels are premultiplied and the ground is fully transparent, because the subtitle layer is
    /// an overlay: an area no cue covers is `0,0,0,0` rather than an opaque colour the caller would
    /// have to key out.
    ///
    /// # Errors
    /// Returns [`CompositorError::FrameOutOfRange`] when the index is not in the scene's timeline,
    /// and a readback error when the composed frame cannot be copied back.
    pub fn render_scene(
        &self,
        scene: &SubtitleScene,
        frame_index: u32,
    ) -> Result<Frame, CompositorError> {
        self.compose_scene(scene, None, frame_index)
    }

    /// Composes one frame of a subtitle scene over a decoded video frame.
    ///
    /// This is the export path and the paused-preview path: crop, flip and the canvas backfill are
    /// applied to the underlay, and the subtitle layer is blended over the result in the same render
    /// pass. Doing it in one pass is the point — a separate overlay composite would put a second
    /// blend, with a second alpha convention, between the preview and the export.
    ///
    /// The subtitle layer blends premultiplied (`src + dst * (1 - src.a)`), because that is what
    /// [`Compositor::render_scene`] emits. A straight-alpha lerp here would fringe every
    /// antialiased glyph edge against the video behind it.
    ///
    /// Determinism is unchanged: the result is a pure function of `scene`, `underlay` and
    /// `frame_index`, so seeking to a frame and playing up to it still produce the same bytes.
    ///
    /// # Errors
    /// Returns [`CompositorError::FrameOutOfRange`] when the index is not in the scene's timeline,
    /// and a readback error when the composed frame cannot be copied back.
    pub fn render_scene_over(
        &self,
        scene: &SubtitleScene,
        underlay: &VideoUnderlay,
        frame_index: u32,
    ) -> Result<Frame, CompositorError> {
        self.compose_scene(scene, Some(underlay), frame_index)
    }

    /// The one subtitle path, with or without a video ground beneath it.
    ///
    /// The decoration masks are rendered and blurred before the frame's own pass opens, because a
    /// render pass cannot read the target it writes. Everything the user then sees — video, box,
    /// border, shadow, stroke and fill — still lands in that one pass over one target, in the order
    /// [`crate::plan`] fixed, so nothing between them can reinterpret an alpha channel.
    fn compose_scene(
        &self,
        scene: &SubtitleScene,
        underlay: Option<&VideoUnderlay>,
        frame_index: u32,
    ) -> Result<Frame, CompositorError> {
        let device = self.gpu.device();
        let queue = self.gpu.queue();
        // Before any allocation, so an out-of-range index costs nothing.
        let plan = build_frame_plan(scene, frame_index)?;

        let ground = underlay.map(|video| {
            self.underlay
                .prepare(device, queue, &self.blur, video, scene.size())
        });
        let atlas = self.quads.bind_atlas(device, queue, scene.atlas());
        let masks = masks::build(
            device,
            queue,
            (&self.quads, &self.blur),
            &atlas,
            plan.masks(),
            scene.size(),
        );
        let buffer = vertex_buffer(device, queue, plan.vertices());

        self.compose(scene.size(), Color::TRANSPARENT, |pass| {
            if let Some(ground) = ground.as_ref() {
                pass.set_pipeline(self.underlay.pipeline());
                pass.set_bind_group(0, ground, &[]);
                pass.draw(0..3, 0..1);
            }
            let Some(buffer) = buffer.as_ref() else {
                return;
            };
            pass.set_pipeline(self.quads.pipeline());
            pass.set_vertex_buffer(0, buffer.slice(..));
            for segment in plan.segments() {
                let bound = match segment.source {
                    BindSource::Atlas => Some(&atlas),
                    BindSource::Mask(index) => masks.get(index),
                };
                let Some(bound) = bound else {
                    continue;
                };
                pass.set_bind_group(0, bound, &[]);
                pass.draw(segment.first..segment.first + segment.count, 0..1);
            }
        })
    }

    /// Allocates the offscreen target, runs one render pass and reads the result back.
    fn compose<Draw>(
        &self,
        size: FrameSize,
        clear: Color,
        draw: Draw,
    ) -> Result<Frame, CompositorError>
    where
        Draw: FnOnce(&mut RenderPass<'_>),
    {
        let device = self.gpu.device();
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
                        load: LoadOp::Clear(clear),
                        store: StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            draw(&mut pass);
        }
        readback::record_copy(&mut encoder, &target, &staging, size);
        self.gpu.queue().submit(Some(encoder.finish()));

        let pixels = readback::read_packed(device, &staging, size)?;
        Ok(Frame::new(size, pixels))
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
