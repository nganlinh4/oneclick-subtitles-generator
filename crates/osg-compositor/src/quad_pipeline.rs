//! The textured-quad pipeline and the GPU resources one subtitle frame needs.
//!
//! Everything here is rebuilt per frame except the pipeline and the sampler: the atlas texture, the
//! bind group and the vertex buffer are created, written and dropped inside a single render. That is
//! deliberate. A frame must not depend on what was drawn before it on the same device, and reusing a
//! resized or partially written buffer is the usual way that guarantee quietly stops holding.

use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingResource, BindingType, BlendState, Buffer, BufferDescriptor,
    BufferUsages, ColorTargetState, ColorWrites, Device, Extent3d, FragmentState, MultisampleState,
    Origin3d, PipelineLayoutDescriptor, PrimitiveState, Queue, RenderPipeline,
    RenderPipelineDescriptor, Sampler, SamplerBindingType, ShaderModuleDescriptor, ShaderSource,
    ShaderStages, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect, TextureDescriptor,
    TextureDimension, TextureFormat, TextureSampleType, TextureUsages, TextureViewDescriptor,
    TextureViewDimension, VertexAttribute, VertexBufferLayout, VertexFormat, VertexState,
    VertexStepMode,
};

use osg_scene::glyph::GlyphAtlasDescriptor;

use crate::geometry::VERTEX_STRIDE;
use crate::glyphs::STROKE_TAPS;
use crate::pass::linear_clamp_sampler;

/// The subtitle shader with its Rust-owned constants substituted in.
///
/// WGSL cannot read a Rust `const`, and a stroke tap count that disagreed between the two languages
/// would be a silent quality change rather than a build error, so the one value is injected here.
fn subtitle_shader() -> String {
    include_str!("shaders/subtitle.wgsl").replace("$STROKE_TAPS", &STROKE_TAPS.to_string())
}

/// The atlas texture format. The baker stages straight RGBA8 and only the alpha channel is read.
const ATLAS_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;

const ATTRIBUTES: [VertexAttribute; 6] = [
    VertexAttribute {
        format: VertexFormat::Float32x2,
        offset: 0,
        shader_location: 0,
    },
    VertexAttribute {
        format: VertexFormat::Float32x2,
        offset: 8,
        shader_location: 1,
    },
    VertexAttribute {
        format: VertexFormat::Float32x4,
        offset: 16,
        shader_location: 2,
    },
    VertexAttribute {
        format: VertexFormat::Float32x4,
        offset: 32,
        shader_location: 3,
    },
    VertexAttribute {
        format: VertexFormat::Float32x4,
        offset: 48,
        shader_location: 4,
    },
    VertexAttribute {
        format: VertexFormat::Float32x4,
        offset: 64,
        shader_location: 5,
    },
];

/// The pipeline, its bind group layout and the sampler, built once per device.
#[derive(Debug)]
pub(crate) struct QuadPipeline {
    pipeline: RenderPipeline,
    layout: BindGroupLayout,
    sampler: Sampler,
}

impl QuadPipeline {
    pub(crate) fn build(device: &Device, target_format: TextureFormat) -> Self {
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("osg-compositor subtitle quads"),
            source: ShaderSource::Wgsl(subtitle_shader().into()),
        });

        let layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("osg-compositor atlas layout"),
            entries: &[
                BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        sample_type: TextureSampleType::Float { filterable: true },
                        view_dimension: TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 1,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("osg-compositor subtitle pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });

        let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("osg-compositor subtitle pipeline"),
            layout: Some(&pipeline_layout),
            vertex: VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[Some(VertexBufferLayout {
                    array_stride: VERTEX_STRIDE,
                    step_mode: VertexStepMode::Vertex,
                    attributes: &ATTRIBUTES,
                })],
            },
            fragment: Some(FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(ColorTargetState {
                    format: target_format,
                    // The shader emits premultiplied colour, so an overlay frame composites over
                    // video correctly without a second pass.
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

        // Linear filtering, because the atlas is baked once and scaled to whatever resolution the
        // composition asks for. Clamped addressing keeps a cell from bleeding into its neighbour on
        // the shelf when that scale lands between texels; a dilating stroke is additionally held to
        // its own cell rectangle in the shader, where clamping alone would not be enough.
        let sampler = linear_clamp_sampler(device, "osg-compositor atlas sampler");

        Self {
            pipeline,
            layout,
            sampler,
        }
    }

    pub(crate) const fn pipeline(&self) -> &RenderPipeline {
        &self.pipeline
    }

    /// Uploads the atlas and binds it.
    ///
    /// An atlas with no inked cluster has no texture at all. Rather than branch the pipeline, a
    /// 1x1 fully transparent texel stands in: nothing samples it, because a run of blank cells emits
    /// no glyph quad.
    pub(crate) fn bind_atlas(
        &self,
        device: &Device,
        queue: &Queue,
        atlas: &GlyphAtlasDescriptor,
    ) -> BindGroup {
        let geometry = atlas.atlas();
        let empty = geometry.width_px == 0 || geometry.height_px == 0;
        let (width, height) = if empty {
            (1, 1)
        } else {
            (geometry.width_px, geometry.height_px)
        };
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("osg-compositor glyph atlas"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: ATLAS_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let blank = [0_u8; 4];
        let (pixels, bytes_per_row) = if empty {
            (blank.as_slice(), 4)
        } else {
            // The descriptor carries its own row stride and guarantees it covers a row of pixels, so
            // a padded upload survives without the compositor repacking anything.
            (atlas.pixels(), geometry.bytes_per_row)
        };
        queue.write_texture(
            TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            pixels,
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(height),
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        let view = texture.create_view(&TextureViewDescriptor::default());
        self.bind_texture(device, &view)
    }

    /// Binds any texture in the atlas slot.
    ///
    /// A blurred decoration mask is drawn by the same pipeline as a glyph — it is a coverage
    /// texture laid over the frame — so it goes in the same binding rather than growing the layout
    /// with a slot every other draw would have to fill with a placeholder.
    pub(crate) fn bind_texture(&self, device: &Device, view: &wgpu::TextureView) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("osg-compositor atlas bind group"),
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

/// Uploads a plan's vertices, or `None` when the frame draws nothing.
pub(crate) fn vertex_buffer(device: &Device, queue: &Queue, vertices: &[f32]) -> Option<Buffer> {
    if vertices.is_empty() {
        return None;
    }
    let mut bytes = Vec::with_capacity(vertices.len() * 4);
    for value in vertices {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let buffer = device.create_buffer(&BufferDescriptor {
        label: Some("osg-compositor subtitle vertices"),
        size: u64::try_from(bytes.len()).ok()?,
        usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, &bytes);
    Some(buffer)
}
