//! The headless compositor: one device, one pipeline, one deterministic frame at a time.

use wgpu::{
    BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingType, BlendState, BufferBindingType, BufferDescriptor,
    BufferUsages, Color, ColorTargetState, ColorWrites, CommandEncoderDescriptor, FragmentState,
    LoadOp, MultisampleState, Operations, PipelineLayoutDescriptor, PrimitiveState, RenderPass,
    RenderPassColorAttachment, RenderPassDescriptor, RenderPipeline, RenderPipelineDescriptor,
    ShaderModuleDescriptor, ShaderSource, ShaderStages, StoreOp, TextureDescriptor,
    TextureDimension, TextureFormat, TextureUsages, TextureView, TextureViewDescriptor,
    VertexState,
};

use crate::blur::SeparableBlur;
use crate::device::{AdapterProfile, AdapterSelection, GpuContext};
use crate::error::{CompositorError, Rejection, TextureTarget};
use crate::frame::Frame;
use crate::masks;
use crate::overlay_pipeline::OverlayPipeline;
use crate::plan::{BindSource, FramePlan, build_frame_plan};
use crate::quad_pipeline::{QuadPipeline, vertex_buffer};
use crate::readback;
use crate::scene::{TestScene, UNIFORM_LEN};
use crate::size::FrameSize;
use crate::subtitle::SubtitleScene;
use crate::underlay::VideoUnderlay;
use crate::underlay_pipeline::UnderlayPipeline;

/// Pixel storage used by an externally consumed composition target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositorTargetFormat {
    /// Host readback and deterministic frame fixtures.
    Rgba8,
    /// Windows Media Foundation's `ARGB32` input surface (BGRA bytes in memory).
    Bgra8,
}

impl CompositorTargetFormat {
    const fn wgpu(self) -> TextureFormat {
        match self {
            Self::Rgba8 => TextureFormat::Rgba8Unorm,
            Self::Bgra8 => TextureFormat::Bgra8Unorm,
        }
    }
}

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
    mask_quads: QuadPipeline,
    underlay: UnderlayPipeline,
    blur: SeparableBlur,
    overlays: OverlayPipeline,
    target_format: TextureFormat,
}

/// GPU resources whose lifetime is the subtitle scene rather than one video frame.
///
/// Atlas pages are immutable, so uploading them again for every frame is pure waste. Geometry is
/// dynamic, but its maximum size is a property of the validated runs; one buffer is therefore
/// allocated to that bound and completely overwritten for every plan. Keeping this object separate
/// from [`SubtitleScene`] also preserves the scene's device-independent, cloneable contract.
#[derive(Debug)]
pub struct PreparedSubtitleScene {
    scene: SubtitleScene,
    atlases: Vec<wgpu::BindGroup>,
    vertices: wgpu::Buffer,
    vertex_capacity: usize,
    vertex_bytes: Vec<u8>,
    held_overlay: Option<HeldOverlay>,
}

#[derive(Debug)]
struct HeldOverlay {
    cue: usize,
    /// Held explicitly so the sampled texture lifetime is obvious at the ownership boundary.
    _texture: wgpu::Texture,
    binding: wgpu::BindGroup,
}

/// A video-underlay binding that is invariant for an export.
#[derive(Debug)]
pub struct PreparedTextureUnderlay {
    binding: wgpu::BindGroup,
}

impl PreparedSubtitleScene {
    /// The validated scene these resources render.
    #[must_use]
    pub const fn scene(&self) -> &SubtitleScene {
        &self.scene
    }

    fn atlas(&self, page: Option<usize>) -> Option<&wgpu::BindGroup> {
        page.and_then(|index| self.atlases.get(index))
            .or_else(|| self.atlases.first())
    }

    fn write_vertices(&mut self, queue: &wgpu::Queue, values: &[f32]) -> Option<u32> {
        if values.is_empty() {
            return None;
        }
        self.vertex_bytes.clear();
        self.vertex_bytes.reserve(values.len().saturating_mul(4));
        self.vertex_bytes
            .extend(values.iter().flat_map(|value| value.to_le_bytes()));
        debug_assert!(self.vertex_bytes.len() <= self.vertex_capacity);
        queue.write_buffer(&self.vertices, 0, &self.vertex_bytes);
        u32::try_from(values.len() / crate::geometry::VERTEX_FLOATS).ok()
    }
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
        Self::with_target_format(selection, CompositorTargetFormat::Rgba8)
    }

    /// Acquires a compositor whose frame target uses `format`.
    ///
    /// The BGRA form exists for the native zero-copy encoder path. All internal masks and atlas
    /// textures remain unchanged; only the final render target storage follows the consumer.
    pub fn with_target_format(
        selection: AdapterSelection,
        format: CompositorTargetFormat,
    ) -> Result<Self, CompositorError> {
        let gpu = GpuContext::acquire(selection)?;
        let target_format = format.wgpu();
        let (pipeline, uniform_layout) = build_pipeline(gpu.device(), target_format);
        let quads = QuadPipeline::build(gpu.device(), target_format);
        let mask_quads = QuadPipeline::build(gpu.device(), TextureFormat::Rgba8Unorm);
        let underlay = UnderlayPipeline::build(gpu.device(), target_format);
        let blur = SeparableBlur::build(gpu.device());
        let overlays = OverlayPipeline::build(gpu.device(), target_format);
        Ok(Self {
            gpu,
            pipeline,
            uniform_layout,
            quads,
            mask_quads,
            underlay,
            blur,
            overlays,
            target_format,
        })
    }

    /// The device that owns every compositor resource.
    ///
    /// Exposed for the audited D3D11/D3D12 interop crate. Ordinary callers should use the safe
    /// frame APIs and never need the raw device.
    #[must_use]
    pub const fn device(&self) -> &wgpu::Device {
        self.gpu.device()
    }

    /// The queue paired with [`Self::device`].
    #[must_use]
    pub const fn queue(&self) -> &wgpu::Queue {
        self.gpu.queue()
    }

    /// What the compositor acquired.
    #[must_use]
    pub const fn adapter(&self) -> &AdapterProfile {
        self.gpu.profile()
    }

    /// The longest 2D texture edge this compositor's device will allocate.
    const fn max_texture_dimension_2d(&self) -> u32 {
        self.gpu.profile().max_texture_dimension_2d()
    }

    /// Uploads immutable atlas pages and allocates the scene's bounded dynamic geometry once.
    ///
    /// This is the production/export contract. The older one-shot methods remain useful for tiny
    /// deterministic tests, but a video pipeline must not turn an immutable text document into
    /// hundreds of identical texture uploads and buffer allocations.
    pub fn prepare_subtitle_scene(
        &self,
        scene: SubtitleScene,
    ) -> Result<PreparedSubtitleScene, CompositorError> {
        self.check_device(&scene, None)?;
        let atlases = scene
            .pages()
            .iter()
            .map(|page| self.quads.bind_atlas(self.device(), self.queue(), page))
            .collect::<Vec<_>>();

        // One cell can appear in the stroke, fill and shadow-mask walks. The remaining fixed quads
        // (glow, box, border and final shadow) are small beside that bound. This intentionally uses
        // the staged run bound rather than observing a convenient current frame.
        let cells = scene
            .runs()
            .iter()
            .map(|run| {
                run.lines()
                    .iter()
                    .map(|line| line.glyphs().len())
                    .sum::<usize>()
            })
            .max()
            .unwrap_or(0);
        let vertices = cells.saturating_mul(18).saturating_add(48);
        let vertex_stride = crate::geometry::VERTEX_FLOATS * core::mem::size_of::<f32>();
        let vertex_capacity = vertices.saturating_mul(vertex_stride).max(vertex_stride);
        let buffer = self.device().create_buffer(&BufferDescriptor {
            label: Some("osg-compositor prepared subtitle vertices"),
            size: u64::try_from(vertex_capacity).unwrap_or(u64::MAX),
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Ok(PreparedSubtitleScene {
            scene,
            atlases,
            vertices: buffer,
            vertex_capacity,
            vertex_bytes: Vec::with_capacity(vertex_capacity),
            held_overlay: None,
        })
    }

    /// Prepares crop/source bindings that do not depend on the current frame's pixels.
    ///
    /// Returns `None` only for a blurred canvas backfill, whose source really is different on every
    /// frame. The ordinary full-frame and solid-background paths allocate their uniforms, bind
    /// group and placeholder exactly once.
    pub fn prepare_texture_underlay(
        &self,
        source: &wgpu::Texture,
        source_size: FrameSize,
        crop: crate::Crop,
        output_size: FrameSize,
    ) -> Result<Option<PreparedTextureUnderlay>, CompositorError> {
        source_size.check_device(TextureTarget::Source, self.max_texture_dimension_2d())?;
        output_size.check_device(TextureTarget::Frame, self.max_texture_dimension_2d())?;
        if source.size().width != source_size.width()
            || source.size().height != source_size.height()
        {
            return Err(Rejection::ExternalSource.into());
        }
        let view = source.create_view(&TextureViewDescriptor::default());
        Ok(self
            .underlay
            .prepare_static_texture(
                self.device(),
                self.queue(),
                &self.blur,
                &view,
                source_size,
                crop,
                output_size,
            )
            .map(|binding| PreparedTextureUnderlay { binding }))
    }

    /// Refuses every texture a frame is about to create that this device cannot allocate.
    ///
    /// Called before the first allocation, because `wgpu` validates a texture dimension inside
    /// `Device::create_texture` by panicking and the release profile aborts. Three sizes reach that
    /// call: the composition — which also covers every intermediate, since the decoration masks and
    /// both blur passes are allocated at the composition size — the uploaded source frame, and the
    /// glyph atlas, whose 4096-pixel ceiling is itself past a downlevel device's 2048.
    ///
    /// **Every** atlas page is checked, not the one this frame happens to sample. A document whose
    /// twentieth page is past the device's limit must be refused before the export starts encoding,
    /// not at frame 5000 when a cue on that page first becomes visible.
    fn check_device(
        &self,
        scene: &SubtitleScene,
        underlay: Option<&VideoUnderlay>,
    ) -> Result<(), CompositorError> {
        let max_edge = self.max_texture_dimension_2d();
        scene.size().check_device(TextureTarget::Frame, max_edge)?;
        scene.check_pages_on_device(max_edge)?;
        if let Some(underlay) = underlay {
            underlay
                .source()
                .size()
                .check_device(TextureTarget::Source, max_edge)?;
        }
        Ok(())
    }

    /// Composes the reference [`TestScene`] at `size` and reads it back as tightly packed RGBA8.
    ///
    /// This is the pipeline probe, not the renderer: it draws a fixed image that exercises device
    /// acquisition, the render pass and the row-unpadded readback without needing an atlas or a
    /// scene contract. [`Compositor::render_scene`] is the path that draws subtitles.
    ///
    /// The result is a pure function of `scene` and `size` on a given adapter: the same arguments
    /// always produce the same bytes.
    ///
    /// # Errors
    /// Returns [`CompositorError::DeviceTextureLimit`] when the size is past what this device can
    /// allocate, and a readback error when the composed frame cannot be copied back.
    pub fn render(&self, scene: TestScene, size: FrameSize) -> Result<Frame, CompositorError> {
        size.check_device(TextureTarget::Frame, self.max_texture_dimension_2d())?;
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
    /// [`CompositorError::DeviceTextureLimit`] when the composition or its atlas is past what this
    /// device can allocate, and a readback error when the composed frame cannot be copied back.
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
    /// [`CompositorError::DeviceTextureLimit`] when the composition, its atlas or the source frame
    /// is past what this device can allocate, and a readback error when the composed frame cannot
    /// be copied back.
    pub fn render_scene_over(
        &self,
        scene: &SubtitleScene,
        underlay: &VideoUnderlay,
        frame_index: u32,
    ) -> Result<Frame, CompositorError> {
        self.compose_scene(scene, Some(underlay), frame_index)
    }

    /// Composes a GPU-resident source into a caller-owned GPU target without host readback.
    ///
    /// `source` and `target` must belong to [`Self::device`]. The source must be filterable and the
    /// target must carry `RENDER_ATTACHMENT`; wgpu validates those capabilities when the resources
    /// are created. This method validates the dimensions and final format before recording work.
    /// Synchronization with an external producer or consumer remains the interop owner's job.
    pub fn render_scene_texture_over_into(
        &self,
        scene: &SubtitleScene,
        source: &wgpu::Texture,
        source_size: FrameSize,
        crop: crate::Crop,
        frame_index: u32,
        target: &wgpu::Texture,
    ) -> Result<wgpu::SubmissionIndex, CompositorError> {
        let plan = build_frame_plan(scene, frame_index)?;
        self.check_source_size(scene, source_size)?;
        let target_size = target.size();
        if target_size.width != scene.size().width()
            || target_size.height != scene.size().height()
            || target.format() != self.target_format
        {
            return Err(Rejection::ExternalTarget.into());
        }
        if source.size().width != source_size.width()
            || source.size().height != source_size.height()
        {
            return Err(Rejection::ExternalSource.into());
        }

        let device = self.gpu.device();
        let queue = self.gpu.queue();
        let source_view = source.create_view(&TextureViewDescriptor::default());
        let ground = self.underlay.prepare_texture(
            device,
            queue,
            &self.blur,
            &source_view,
            source_size,
            crop,
            scene.size(),
        );
        let Some(page) = scene.bound_page(plan.atlas_page()) else {
            return Err(Rejection::AtlasPagesEmpty.into());
        };
        let atlas = self.quads.bind_atlas(device, queue, page);
        let masks = masks::build(
            device,
            queue,
            (&self.mask_quads, &self.quads, &self.blur),
            page,
            plan.masks(),
            scene.size(),
        );
        let buffer = vertex_buffer(device, queue, plan.vertices());
        let target_view = target.create_view(&TextureViewDescriptor::default());
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("osg-compositor GPU frame encoder"),
        });
        {
            let mut pass = begin_frame_pass(&mut encoder, &target_view, Color::TRANSPARENT);
            pass.set_pipeline(self.underlay.pipeline());
            pass.set_bind_group(0, &ground, &[]);
            pass.draw(0..3, 0..1);
            if let Some(buffer) = buffer.as_ref() {
                pass.set_pipeline(self.quads.pipeline());
                pass.set_vertex_buffer(0, buffer.slice(..));
                for segment in plan.segments() {
                    let bound = match segment.source {
                        BindSource::Atlas => Some(&atlas),
                        BindSource::Mask(index) => masks.get(index),
                    };
                    if let Some(bound) = bound {
                        pass.set_bind_group(0, bound, &[]);
                        pass.draw(segment.first..segment.first + segment.count, 0..1);
                    }
                }
            }
        }
        Ok(queue.submit(Some(encoder.finish())))
    }

    /// Composes a frame through scene-owned GPU resources.
    ///
    /// Unlike [`Self::render_scene_texture_over_into`], this path performs no atlas upload and no
    /// frame vertex-buffer allocation. It is the only path the video export pipeline uses.
    #[expect(
        clippy::too_many_arguments,
        clippy::too_many_lines,
        reason = "the resident video seam carries explicit source, crop and destination contracts in one transactional render"
    )]
    pub fn render_prepared_scene_texture_over_into(
        &self,
        prepared: &mut PreparedSubtitleScene,
        prepared_underlay: Option<&PreparedTextureUnderlay>,
        source: &wgpu::Texture,
        source_size: FrameSize,
        crop: crate::Crop,
        frame_index: u32,
        target: &wgpu::Texture,
    ) -> Result<wgpu::SubmissionIndex, CompositorError> {
        let plan = build_frame_plan(prepared.scene(), frame_index)?;
        self.check_source_size(prepared.scene(), source_size)?;
        let target_size = target.size();
        if target_size.width != prepared.scene().size().width()
            || target_size.height != prepared.scene().size().height()
            || target.format() != self.target_format
        {
            return Err(Rejection::ExternalTarget.into());
        }
        if source.size().width != source_size.width()
            || source.size().height != source_size.height()
        {
            return Err(Rejection::ExternalSource.into());
        }

        let device = self.gpu.device();
        let queue = self.gpu.queue();
        let dynamic_ground;
        let ground = if let Some(prepared) = prepared_underlay {
            &prepared.binding
        } else {
            let source_view = source.create_view(&TextureViewDescriptor::default());
            dynamic_ground = self.underlay.prepare_texture(
                device,
                queue,
                &self.blur,
                &source_view,
                source_size,
                crop,
                prepared.scene().size(),
            );
            &dynamic_ground
        };
        if let Some(cue) = plan.held_cue()
            && prepared.held_overlay.as_ref().map(|overlay| overlay.cue) != Some(cue)
        {
            let vertex_count = prepared.write_vertices(queue, plan.vertices());
            let overlay = {
                let Some(atlas) = prepared.atlas(plan.atlas_page()) else {
                    return Err(Rejection::AtlasPagesEmpty.into());
                };
                let masks = masks::build_bound(
                    device,
                    queue,
                    (&self.mask_quads, &self.quads, &self.blur),
                    atlas,
                    plan.masks(),
                    prepared.scene().size(),
                );
                let texture = device.create_texture(&TextureDescriptor {
                    label: Some("osg-compositor held cue overlay"),
                    size: wgpu::Extent3d {
                        width: prepared.scene().size().width(),
                        height: prepared.scene().size().height(),
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: TextureDimension::D2,
                    // The subtitle pipeline is compiled for the final compositor target. Keeping
                    // its prepared overlay in that same format avoids a conversion pass and makes
                    // wgpu validate the preparation pass against the exact production pipeline.
                    format: self.target_format,
                    usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                });
                let view = texture.create_view(&TextureViewDescriptor::default());
                let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
                    label: Some("osg-compositor held cue encoder"),
                });
                {
                    let mut pass = begin_frame_pass(&mut encoder, &view, Color::TRANSPARENT);
                    if let Some(vertex_count) = vertex_count {
                        pass.set_pipeline(self.quads.pipeline());
                        pass.set_vertex_buffer(0, prepared.vertices.slice(..));
                        for segment in plan.segments() {
                            let bound = match segment.source {
                                BindSource::Atlas => Some(atlas),
                                BindSource::Mask(index) => masks.get(index),
                            };
                            if let Some(bound) = bound {
                                pass.set_bind_group(0, bound, &[]);
                                pass.draw(segment.first..segment.first + segment.count, 0..1);
                            }
                        }
                        debug_assert_eq!(vertex_count, planned_vertex_count(&plan));
                    }
                }
                queue.submit(Some(encoder.finish()));
                HeldOverlay {
                    cue,
                    binding: self.overlays.bind(device, &view),
                    _texture: texture,
                }
            };
            prepared.held_overlay = Some(overlay);
        }

        let target_view = target.create_view(&TextureViewDescriptor::default());
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("osg-compositor prepared GPU frame encoder"),
        });
        {
            let mut pass = begin_frame_pass(&mut encoder, &target_view, Color::TRANSPARENT);
            pass.set_pipeline(self.underlay.pipeline());
            pass.set_bind_group(0, ground, &[]);
            pass.draw(0..3, 0..1);
            if plan.held_cue().is_some() {
                if let Some(overlay) = prepared.held_overlay.as_ref() {
                    pass.set_pipeline(self.overlays.pipeline());
                    pass.set_bind_group(0, &overlay.binding, &[]);
                    pass.draw(0..3, 0..1);
                }
            } else {
                let vertex_count = prepared.write_vertices(queue, plan.vertices());
                let Some(atlas) = prepared.atlas(plan.atlas_page()) else {
                    return Err(Rejection::AtlasPagesEmpty.into());
                };
                let masks = masks::build_bound(
                    device,
                    queue,
                    (&self.mask_quads, &self.quads, &self.blur),
                    atlas,
                    plan.masks(),
                    prepared.scene().size(),
                );
                if let Some(vertex_count) = vertex_count {
                    pass.set_pipeline(self.quads.pipeline());
                    pass.set_vertex_buffer(0, prepared.vertices.slice(..));
                    for segment in plan.segments() {
                        let bound = match segment.source {
                            BindSource::Atlas => Some(atlas),
                            BindSource::Mask(index) => masks.get(index),
                        };
                        if let Some(bound) = bound {
                            pass.set_bind_group(0, bound, &[]);
                            pass.draw(segment.first..segment.first + segment.count, 0..1);
                        }
                    }
                    debug_assert_eq!(vertex_count, planned_vertex_count(&plan));
                }
            }
        }
        Ok(queue.submit(Some(encoder.finish())))
    }

    fn check_source_size(
        &self,
        scene: &SubtitleScene,
        source_size: FrameSize,
    ) -> Result<(), CompositorError> {
        let max_edge = self.max_texture_dimension_2d();
        scene.size().check_device(TextureTarget::Frame, max_edge)?;
        scene.check_pages_on_device(max_edge)?;
        source_size.check_device(TextureTarget::Source, max_edge)
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
        // Both before any allocation, so an out-of-range index and a size this GPU cannot take
        // cost nothing and, in the second case, abort nothing.
        let plan = build_frame_plan(scene, frame_index)?;
        self.check_device(scene, underlay)?;

        let ground = underlay.map(|video| {
            self.underlay
                .prepare(device, queue, &self.blur, video, scene.size())
        });
        // One page per frame, so one bind: the page the plan resolved, or the first page when the
        // plan draws nothing and therefore emits no atlas segment for the binding to be sampled by.
        // `AtlasPages` refuses an empty page list, so the fallback is total.
        let Some(page) = scene.bound_page(plan.atlas_page()) else {
            return Err(Rejection::AtlasPagesEmpty.into());
        };
        let atlas = self.quads.bind_atlas(device, queue, page);
        let masks = masks::build(
            device,
            queue,
            (&self.mask_quads, &self.quads, &self.blur),
            page,
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
            format: self.target_format,
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

fn begin_frame_pass<'encoder>(
    encoder: &'encoder mut wgpu::CommandEncoder,
    view: &'encoder TextureView,
    clear: Color,
) -> RenderPass<'encoder> {
    encoder.begin_render_pass(&RenderPassDescriptor {
        label: Some("osg-compositor scene pass"),
        color_attachments: &[Some(RenderPassColorAttachment {
            view,
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
    })
}

fn planned_vertex_count(plan: &FramePlan) -> u32 {
    u32::try_from(plan.vertices().len() / crate::geometry::VERTEX_FLOATS).unwrap_or(u32::MAX)
}

fn build_pipeline(
    device: &wgpu::Device,
    target_format: TextureFormat,
) -> (RenderPipeline, BindGroupLayout) {
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
                format: target_format,
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
