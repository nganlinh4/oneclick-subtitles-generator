//! The GPU resources one underlay needs: the composite pipeline and the backfill builder.
//!
//! Like [`crate::quad_pipeline`], everything except the pipelines and the sampler is created,
//! written and dropped inside a single render. A frame must not depend on what was drawn before it,
//! and a backfill texture left over from the previous frame is the obvious way that would stop
//! being true.
//!
//! The blurred backfill is built into its own textures ahead of the frame's render pass, because a
//! separable blur is two passes by definition and a render pass cannot read the target it writes.
//! That blur is [`crate::blur::SeparableBlur`], the same one the subtitle decorations use. The
//! composite itself is a single draw at the head of the frame's own pass, so the video and the
//! subtitle layer still land in one pass over one target.

use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindingResource, CommandEncoderDescriptor, Device, Queue, RenderPipeline, Sampler,
    ShaderModuleDescriptor, ShaderSource, Texture, TextureFormat, TextureView,
    TextureViewDescriptor,
};

use crate::blur::{BlurRequest, SeparableBlur};
use crate::crop::{CanvasBackground, Crop};
use crate::pass::{
    RENDER_FORMAT, fullscreen_draw, fullscreen_pipeline, linear_clamp_sampler, render_target,
    sampler_entry, texture_entry, uniform_buffer, uniform_entry,
};
use crate::size::FrameSize;
use crate::underlay::VideoUnderlay;
use crate::underlay_resources::{
    composite_uniforms, cover_uniforms, placeholder_texture, upload_source,
};

/// The pipelines, their bind group layouts and the sampler, built once per device.
#[derive(Debug)]
pub(crate) struct UnderlayPipeline {
    composite: RenderPipeline,
    composite_layout: BindGroupLayout,
    cover: RenderPipeline,
    cover_layout: BindGroupLayout,
    sampler: Sampler,
}

impl UnderlayPipeline {
    pub(crate) fn build(device: &Device, target_format: TextureFormat) -> Self {
        let composite_shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("osg-compositor underlay composite"),
            source: ShaderSource::Wgsl(include_str!("shaders/underlay.wgsl").into()),
        });
        let backfill_shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("osg-compositor underlay backfill"),
            source: ShaderSource::Wgsl(include_str!("shaders/backfill.wgsl").into()),
        });

        let composite_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("osg-compositor underlay layout"),
            entries: &[
                uniform_entry(0),
                texture_entry(1),
                sampler_entry(2),
                texture_entry(3),
            ],
        });
        let cover_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("osg-compositor backfill layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });

        let composite = fullscreen_pipeline(
            device,
            &composite_shader,
            "fs_main",
            &composite_layout,
            target_format,
            "osg-compositor underlay composite pipeline",
        );
        // The backfill is built into an offscreen texture of its own, not into the frame target,
        // so its format is fixed here rather than following the frame.
        let cover = fullscreen_pipeline(
            device,
            &backfill_shader,
            "fs_cover",
            &cover_layout,
            RENDER_FORMAT,
            "osg-compositor backfill cover pipeline",
        );

        Self {
            composite,
            composite_layout,
            cover,
            cover_layout,
            sampler: linear_clamp_sampler(device, "osg-compositor underlay sampler"),
        }
    }

    pub(crate) const fn pipeline(&self) -> &RenderPipeline {
        &self.composite
    }

    /// Uploads the source, builds the backfill if one is blurred, and binds the composite draw.
    ///
    /// The returned bind group owns every texture it references, so the caller only has to keep it
    /// alive for the render pass.
    pub(crate) fn prepare(
        &self,
        device: &Device,
        queue: &Queue,
        blur: &SeparableBlur,
        underlay: &VideoUnderlay,
        size: FrameSize,
    ) -> BindGroup {
        let source = upload_source(device, queue, underlay.source());
        let source_view = source.create_view(&TextureViewDescriptor::default());

        self.prepare_texture(
            device,
            queue,
            blur,
            &source_view,
            underlay.source().size(),
            underlay.crop(),
            size,
        )
    }

    /// Binds a source that is already resident on this wgpu device.
    ///
    /// This is the zero-copy compositor seam. The caller owns synchronization with whichever API
    /// produced the texture; from this point onward the exact same crop, backfill and subtitle
    /// passes used by the host-memory path are applied.
    #[expect(
        clippy::too_many_arguments,
        reason = "the resident texture seam mirrors the full underlay request without owning it"
    )]
    pub(crate) fn prepare_texture(
        &self,
        device: &Device,
        queue: &Queue,
        blur: &SeparableBlur,
        source_view: &TextureView,
        source_size: FrameSize,
        crop: Crop,
        size: FrameSize,
    ) -> BindGroup {
        let mut keep = Vec::new();
        let backfill_view = match crop.background() {
            CanvasBackground::Blur { sigma_px } => self.build_backfill(
                &BlurRequest {
                    device,
                    queue,
                    size,
                    radius: crop.blur_radius_px(),
                    sigma_px,
                },
                blur,
                source_view,
                source_size,
                crop,
                &mut keep,
            ),
            CanvasBackground::Transparent | CanvasBackground::Solid(_) => {
                let placeholder = placeholder_texture(device, queue);
                let view = placeholder.create_view(&TextureViewDescriptor::default());
                keep.push(placeholder);
                view
            }
        };

        let uniforms = uniform_buffer(
            device,
            queue,
            "osg-compositor underlay uniforms",
            &composite_uniforms(crop),
        );

        device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor underlay bind group"),
            layout: &self.composite_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(source_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::Sampler(&self.sampler),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: BindingResource::TextureView(&backfill_view),
                },
            ],
        })
    }

    /// Renders the cover-fitted backdrop and, when the radius is not zero, blurs it separably.
    fn build_backfill(
        &self,
        request: &BlurRequest<'_>,
        blur: &SeparableBlur,
        source_view: &TextureView,
        source_size: FrameSize,
        crop: Crop,
        keep: &mut Vec<Texture>,
    ) -> TextureView {
        let device = request.device;
        let cover_target = render_target(device, request.size, "osg-compositor backfill");
        let cover_view = cover_target.create_view(&TextureViewDescriptor::default());
        let cover_uniforms = uniform_buffer(
            device,
            request.queue,
            "osg-compositor backfill cover uniforms",
            &cover_uniforms(source_size, crop, request.size),
        );
        let cover_bind = self.bind_cover(device, &cover_uniforms, source_view);

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("osg-compositor backfill encoder"),
        });
        fullscreen_draw(&mut encoder, &self.cover, &cover_bind, &cover_view);

        let view = if request.radius == 0 {
            cover_view
        } else {
            blur.apply(request, &mut encoder, &cover_view, keep)
        };
        request.queue.submit(Some(encoder.finish()));
        keep.push(cover_target);
        view
    }

    fn bind_cover(
        &self,
        device: &Device,
        uniforms: &wgpu::Buffer,
        source: &TextureView,
    ) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor backfill bind group"),
            layout: &self.cover_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(source),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }
}
