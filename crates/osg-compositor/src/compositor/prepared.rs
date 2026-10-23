//! Scene- and export-lifetime GPU resources, and the resident render path that reuses them.

use wgpu::{
    BufferDescriptor, BufferUsages, Color, CommandEncoderDescriptor, TextureDescriptor,
    TextureDimension, TextureUsages, TextureViewDescriptor,
};

use crate::error::{CompositorError, Rejection, TextureTarget};
use crate::masks;
use crate::plan::{BindSource, build_frame_plan};
use crate::size::FrameSize;
use crate::subtitle::SubtitleScene;

use super::{Compositor, begin_frame_pass, planned_vertex_count};

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
}
