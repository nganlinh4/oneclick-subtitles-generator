//! The GPU resources one underlay needs: the composite pipeline and the backfill builder.
//!
//! Like [`crate::quad_pipeline`], everything except the pipelines and the sampler is created,
//! written and dropped inside a single render. A frame must not depend on what was drawn before it,
//! and a backfill texture left over from the previous frame is the obvious way that would stop
//! being true.
//!
//! The blurred backfill is built into its own textures ahead of the frame's render pass, because a
//! separable blur is two passes by definition and a render pass cannot read the target it writes.
//! The composite itself is a single draw at the head of the frame's own pass, so the video and the
//! subtitle layer still land in one pass over one target.

use wgpu::{
    AddressMode, BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout,
    BindGroupLayoutDescriptor, BindingResource, Buffer, CommandEncoderDescriptor, Device,
    FilterMode, MipmapFilterMode, Queue, RenderPipeline, Sampler, SamplerDescriptor,
    ShaderModuleDescriptor, ShaderSource, Texture, TextureFormat, TextureView,
    TextureViewDescriptor,
};

use crate::crop::CanvasBackground;
use crate::size::FrameSize;
use crate::underlay::VideoUnderlay;
use crate::underlay_resources::{
    BACKFILL_FORMAT, backfill_texture, blur_uniforms, composite_uniforms, cover_uniforms,
    fullscreen_draw, fullscreen_pipeline, placeholder_texture, sampler_entry, texture_entry,
    uniform_buffer, uniform_entry, upload_source,
};

/// The pipelines, their bind group layouts and the sampler, built once per device.
#[derive(Debug)]
pub(crate) struct UnderlayPipeline {
    composite: RenderPipeline,
    composite_layout: BindGroupLayout,
    cover: RenderPipeline,
    blur: RenderPipeline,
    backfill_layout: BindGroupLayout,
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
        let backfill_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
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
        // The backfill is built into an Rgba8Unorm texture of its own, not into the frame target,
        // so its format is fixed here rather than following the frame.
        let cover = fullscreen_pipeline(
            device,
            &backfill_shader,
            "fs_cover",
            &backfill_layout,
            BACKFILL_FORMAT,
            "osg-compositor backfill cover pipeline",
        );
        let blur = fullscreen_pipeline(
            device,
            &backfill_shader,
            "fs_blur",
            &backfill_layout,
            BACKFILL_FORMAT,
            "osg-compositor backfill blur pipeline",
        );

        // Linear and clamped: the source is scaled to an arbitrary output size, and clamping keeps
        // a sample that lands on the very edge from wrapping to the far side of the frame.
        let sampler = device.create_sampler(&SamplerDescriptor {
            label: Some("osg-compositor underlay sampler"),
            address_mode_u: AddressMode::ClampToEdge,
            address_mode_v: AddressMode::ClampToEdge,
            address_mode_w: AddressMode::ClampToEdge,
            mag_filter: FilterMode::Linear,
            min_filter: FilterMode::Linear,
            mipmap_filter: MipmapFilterMode::Nearest,
            ..SamplerDescriptor::default()
        });

        Self {
            composite,
            composite_layout,
            cover,
            blur,
            backfill_layout,
            sampler,
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
        underlay: &VideoUnderlay,
        size: FrameSize,
    ) -> BindGroup {
        let source = upload_source(device, queue, underlay.source());
        let source_view = source.create_view(&TextureViewDescriptor::default());

        let backfill = match underlay.crop().background() {
            CanvasBackground::Blur { sigma_px } => {
                self.build_backfill(device, queue, &source_view, underlay, size, sigma_px)
            }
            CanvasBackground::Transparent | CanvasBackground::Solid(_) => {
                placeholder_texture(device, queue)
            }
        };
        let backfill_view = backfill.create_view(&TextureViewDescriptor::default());

        let uniforms = uniform_buffer(
            device,
            queue,
            "osg-compositor underlay uniforms",
            &composite_uniforms(underlay.crop()),
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
                    resource: BindingResource::TextureView(&source_view),
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
        device: &Device,
        queue: &Queue,
        source_view: &TextureView,
        underlay: &VideoUnderlay,
        size: FrameSize,
        sigma_px: f64,
    ) -> Texture {
        let cover_target = backfill_texture(device, size);
        let cover_view = cover_target.create_view(&TextureViewDescriptor::default());
        let cover_uniforms = uniform_buffer(
            device,
            queue,
            "osg-compositor backfill cover uniforms",
            &cover_uniforms(underlay.source(), underlay.crop(), size),
        );
        let cover_bind = self.bind_backfill(device, &cover_uniforms, source_view);

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("osg-compositor backfill encoder"),
        });
        fullscreen_draw(&mut encoder, &self.cover, &cover_bind, &cover_view);

        let radius = underlay.crop().blur_radius_px();
        if radius == 0 {
            queue.submit(Some(encoder.finish()));
            return cover_target;
        }

        let horizontal = backfill_texture(device, size);
        let horizontal_view = horizontal.create_view(&TextureViewDescriptor::default());
        let vertical = backfill_texture(device, size);
        let vertical_view = vertical.create_view(&TextureViewDescriptor::default());

        let across = uniform_buffer(
            device,
            queue,
            "osg-compositor backfill blur x",
            &blur_uniforms(1.0, 0.0, radius, sigma_px),
        );
        let down = uniform_buffer(
            device,
            queue,
            "osg-compositor backfill blur y",
            &blur_uniforms(0.0, 1.0, radius, sigma_px),
        );
        let across_bind = self.bind_backfill(device, &across, &cover_view);
        let down_bind = self.bind_backfill(device, &down, &horizontal_view);

        fullscreen_draw(&mut encoder, &self.blur, &across_bind, &horizontal_view);
        fullscreen_draw(&mut encoder, &self.blur, &down_bind, &vertical_view);
        queue.submit(Some(encoder.finish()));
        vertical
    }

    fn bind_backfill(&self, device: &Device, uniforms: &Buffer, source: &TextureView) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor backfill bind group"),
            layout: &self.backfill_layout,
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
