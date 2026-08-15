//! Building the blurred masks a frame's decorations are drawn from.
//!
//! A drop shadow and a glow are the same operation twice: take a shape the frame is about to draw,
//! render it as white coverage, blur it separably, and lay it back down in a colour. Doing it as a
//! mask rather than analytically is what keeps the blur separable — a text shadow is the blur of an
//! arbitrary glyph run, which has no closed form, and having two different blurs for two shadows
//! would be exactly the divergence this crate exists to prevent.
//!
//! The mask pass uses the frame's own quad pipeline, so a shape is masked by the same code that
//! draws it. Its premultiplied blend is what makes overlapping glyphs a union rather than an
//! accumulation, which is what a shadow of a word has to be.
//!
//! Everything here is created and dropped inside one frame, like every other GPU resource in the
//! crate. A mask left over from the previous frame is the obvious way "frame `n` does not depend on
//! frame `n - 1`" would quietly stop being true.

use wgpu::{
    BindGroup, Buffer, CommandEncoderDescriptor, Device, Queue, Texture, TextureViewDescriptor,
};

use crate::blur::{BlurRequest, SeparableBlur};
use crate::geometry::VERTEX_FLOATS;
use crate::pass::{clearing_pass, render_target};
use crate::plan::MaskJob;
use crate::quad_pipeline::{QuadPipeline, vertex_buffer};
use crate::size::FrameSize;

/// The bound masks, plus the resources they were built from.
///
/// The textures and vertex buffers are held rather than dropped at the end of the build: they are
/// referenced by commands that have only just been submitted, and by the bind groups the frame's
/// own pass is about to read.
pub(crate) struct Masks {
    bound: Vec<BindGroup>,
    /// Never read: held only so the mask targets outlive the pass that samples them.
    textures: Vec<Texture>,
    /// Never read: held only so the mask vertices outlive the commands that reference them.
    buffers: Vec<Buffer>,
}

impl Masks {
    pub(crate) const fn none() -> Self {
        Self {
            bound: Vec::new(),
            textures: Vec::new(),
            buffers: Vec::new(),
        }
    }

    pub(crate) fn get(&self, index: usize) -> Option<&BindGroup> {
        self.bound.get(index)
    }
}

/// Render and blur every mask the plan asked for, and bind each one for the frame's own pass.
pub(crate) fn build(
    device: &Device,
    queue: &Queue,
    pipelines: (&QuadPipeline, &SeparableBlur),
    atlas: &BindGroup,
    jobs: &[MaskJob],
    size: FrameSize,
) -> Masks {
    if jobs.is_empty() {
        return Masks::none();
    }
    let (quads, blur) = pipelines;
    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
        label: Some("osg-compositor decoration mask encoder"),
    });
    let mut masks = Masks {
        bound: Vec::with_capacity(jobs.len()),
        textures: Vec::with_capacity(jobs.len() * 3),
        buffers: Vec::with_capacity(jobs.len()),
    };

    for job in jobs {
        let shape = render_target(device, size, "osg-compositor decoration mask");
        let shape_view = shape.create_view(&TextureViewDescriptor::default());
        let buffer = vertex_buffer(device, queue, &job.vertices);
        {
            let mut pass = clearing_pass(
                &mut encoder,
                &shape_view,
                "osg-compositor decoration mask pass",
            );
            if let Some(buffer) = buffer.as_ref() {
                let count = u32::try_from(job.vertices.len() / VERTEX_FLOATS).unwrap_or(0);
                pass.set_pipeline(quads.pipeline());
                pass.set_bind_group(0, atlas, &[]);
                pass.set_vertex_buffer(0, buffer.slice(..));
                pass.draw(0..count, 0..1);
            }
        }
        masks.buffers.extend(buffer);

        // A zero radius is a legitimate setting — a shadow with no blur is a hard offset copy — so
        // the blur passes are skipped rather than run with a one-tap kernel.
        let view = if job.radius == 0 {
            shape_view
        } else {
            blur.apply(
                &BlurRequest {
                    device,
                    queue,
                    size,
                    radius: job.radius,
                    sigma_px: job.sigma_px,
                },
                &mut encoder,
                &shape_view,
                &mut masks.textures,
            )
        };
        masks.textures.push(shape);
        masks.bound.push(quads.bind_texture(device, &view));
    }

    queue.submit(Some(encoder.finish()));
    masks
}
