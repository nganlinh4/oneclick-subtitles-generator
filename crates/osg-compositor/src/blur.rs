//! The one separable Gaussian in the crate.
//!
//! Both blurred things the renderer draws — the canvas backfill behind a crop, and the text shadow
//! and glow of a subtitle — go through here, so there is a single kernel, a single normalisation
//! and a single bound on how large a radius may become.
//!
//! **Why the bound exists.** Every blurred field the editor persists has a stored range far wider
//! than anything a pixel can show. `canvasBgBlur` reaches 1000, `textShadowBlur` reaches 1000 and
//! `glowIntensity` reaches 1000; as a standard deviation those would be six-thousand-tap kernels
//! per axis for a result that is an even wash long before that. The applied deviation is therefore
//! clamped rather than refused, because refusing would reject a setting the editor legitimately
//! stores and has already rendered once.

use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindingResource, Buffer, CommandEncoder, Device, Queue, RenderPipeline, Sampler,
    ShaderModuleDescriptor, ShaderSource, Texture, TextureView, TextureViewDescriptor,
};

use crate::pass::{
    RENDER_FORMAT, fullscreen_draw, fullscreen_pipeline, linear_clamp_sampler, narrow,
    render_target, sampler_entry, texture_entry, uniform_buffer, uniform_entry,
};
use crate::size::FrameSize;

/// How many standard deviations the kernel reaches.
///
/// Three is where a Gaussian has spent 99.7% of its weight; past that the extra taps change nothing
/// a pixel can hold.
const KERNEL_DEVIATIONS: f64 = 3.0;

/// The kernel half-width for a deviation, capped so the per-frame cost has a ceiling that does not
/// depend on what the editor stored.
pub(crate) fn gaussian_radius_px(sigma_px: f64, max_radius: u32) -> u32 {
    if !sigma_px.is_finite() || sigma_px <= 0.0 {
        return 0;
    }
    let radius = (sigma_px * KERNEL_DEVIATIONS).ceil();
    if radius <= 0.0 {
        return 0;
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "callers clamp sigma before this, so the radius is small and positive"
    )]
    let radius = radius as u32;
    radius.min(max_radius)
}

/// One blur: where it runs, how large it is, and at what size.
pub(crate) struct BlurRequest<'gpu> {
    pub(crate) device: &'gpu Device,
    pub(crate) queue: &'gpu Queue,
    pub(crate) size: FrameSize,
    /// The kernel half-width in pixels, already bounded by the caller.
    pub(crate) radius: u32,
    /// The Gaussian standard deviation in pixels, already clamped by the caller.
    pub(crate) sigma_px: f64,
}

/// The separable-Gaussian pipeline, built once per device.
#[derive(Debug)]
pub(crate) struct SeparableBlur {
    pipeline: RenderPipeline,
    layout: BindGroupLayout,
    sampler: Sampler,
}

impl SeparableBlur {
    pub(crate) fn build(device: &Device) -> Self {
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("osg-compositor separable blur"),
            source: ShaderSource::Wgsl(include_str!("shaders/blur.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("osg-compositor blur layout"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });
        let pipeline = fullscreen_pipeline(
            device,
            &shader,
            "fs_main",
            &layout,
            RENDER_FORMAT,
            "osg-compositor blur pipeline",
        );
        Self {
            pipeline,
            layout,
            sampler: linear_clamp_sampler(device, "osg-compositor blur sampler"),
        }
    }

    /// Records a horizontal then a vertical pass and returns a view of the blurred result.
    ///
    /// Two passes, never one: a render pass cannot read the target it writes, and a single
    /// isotropic pass would be the `O(r^2)` kernel this module exists to avoid.
    ///
    /// Both intermediates are pushed onto `keep`, because they are referenced by commands that
    /// have not been submitted yet and by the view this returns.
    pub(crate) fn apply(
        &self,
        request: &BlurRequest<'_>,
        encoder: &mut CommandEncoder,
        source: &TextureView,
        keep: &mut Vec<Texture>,
    ) -> TextureView {
        let device = request.device;
        let horizontal = render_target(device, request.size, "osg-compositor blur x");
        let horizontal_view = horizontal.create_view(&TextureViewDescriptor::default());
        let vertical = render_target(device, request.size, "osg-compositor blur y");
        let vertical_view = vertical.create_view(&TextureViewDescriptor::default());

        let across = uniform_buffer(
            device,
            request.queue,
            "osg-compositor blur x uniforms",
            &axis_uniforms(1.0, 0.0, request.radius, request.sigma_px),
        );
        let down = uniform_buffer(
            device,
            request.queue,
            "osg-compositor blur y uniforms",
            &axis_uniforms(0.0, 1.0, request.radius, request.sigma_px),
        );
        let across_bind = self.bind(device, &across, source);
        let down_bind = self.bind(device, &down, &horizontal_view);

        fullscreen_draw(encoder, &self.pipeline, &across_bind, &horizontal_view);
        fullscreen_draw(encoder, &self.pipeline, &down_bind, &vertical_view);
        keep.push(horizontal);
        keep.push(vertical);
        vertical_view
    }

    fn bind(&self, device: &Device, uniforms: &Buffer, source: &TextureView) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor blur bind group"),
            layout: &self.layout,
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

fn axis_uniforms(across: f64, down: f64, radius: u32, sigma_px: f64) -> [f32; 4] {
    [across, down, f64::from(radius), sigma_px].map(narrow)
}

#[cfg(test)]
mod tests {
    use super::gaussian_radius_px;

    #[test]
    fn a_radius_is_three_deviations_and_never_more_than_the_cap() {
        assert_eq!(gaussian_radius_px(0.0, 120), 0);
        assert_eq!(gaussian_radius_px(-1.0, 120), 0);
        assert_eq!(gaussian_radius_px(f64::NAN, 120), 0);
        assert_eq!(gaussian_radius_px(2.0, 120), 6);
        assert_eq!(gaussian_radius_px(2.5, 120), 8);
        assert_eq!(gaussian_radius_px(1_000.0, 120), 120);
    }
}
