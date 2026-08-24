//! Presentation of a prepared, premultiplied subtitle overlay.
//!
//! A held cue is visually invariant across every video frame beneath it. The expensive compositor
//! paints that complete overlay once; this pipeline then samples it with one fullscreen triangle
//! and premultiplied blending. It deliberately has no time, style or text inputs.

use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindingResource, BlendState, ColorTargetState, ColorWrites, Device, FragmentState,
    MultisampleState, PipelineLayoutDescriptor, PrimitiveState, RenderPipeline,
    RenderPipelineDescriptor, Sampler, ShaderModuleDescriptor, ShaderSource, TextureFormat,
    TextureView, VertexState,
};

use crate::pass::{linear_clamp_sampler, sampler_entry, texture_entry};

#[derive(Debug)]
pub(crate) struct OverlayPipeline {
    pipeline: RenderPipeline,
    layout: BindGroupLayout,
    sampler: Sampler,
}

impl OverlayPipeline {
    pub(crate) fn build(device: &Device, target_format: TextureFormat) -> Self {
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("osg-compositor prepared overlay shader"),
            source: ShaderSource::Wgsl(include_str!("shaders/overlay.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("osg-compositor prepared overlay layout"),
            entries: &[texture_entry(0), sampler_entry(1)],
        });
        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("osg-compositor prepared overlay pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("osg-compositor prepared overlay pipeline"),
            layout: Some(&pipeline_layout),
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
                    blend: Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: ColorWrites::ALL,
                })],
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Self {
            pipeline,
            layout,
            sampler: linear_clamp_sampler(device, "osg-compositor prepared overlay sampler"),
        }
    }

    pub(crate) const fn pipeline(&self) -> &RenderPipeline {
        &self.pipeline
    }

    pub(crate) fn bind(&self, device: &Device, view: &TextureView) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor prepared overlay bind group"),
            layout: &self.layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }
}
