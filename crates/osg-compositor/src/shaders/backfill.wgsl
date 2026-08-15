// Building the canvas backfill: the cover fit the blur is then applied to.
//
// `fs_cover` scales the source to cover the output, over-scales and darkens it the way the shipped
// renderer's backdrop element does, and premultiplies it. Blurring it is not done here — that is
// shaders/blur.wgsl, the one separable Gaussian the crate has, shared with the subtitle
// decorations so there is never a second kernel to keep in agreement with this one.

struct Backfill {
    // Cover scale x, cover scale y, flipX, flipY.
    params: vec4<f32>,
    // Brightness multiplier in x.
    tint: vec4<f32>,
};

@group(0) @binding(0) var<uniform> settings: Backfill;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    var output: VertexOutput;
    output.clip = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    output.uv = vec2<f32>(x, y);
    return output;
}

@fragment
fn fs_cover(input: VertexOutput) -> @location(0) vec4<f32> {
    var read = input.uv;
    if (settings.params.z > 0.5) {
        read.x = 1.0 - read.x;
    }
    if (settings.params.w > 0.5) {
        read.y = 1.0 - read.y;
    }
    let centred = (read - vec2<f32>(0.5, 0.5)) * settings.params.xy + vec2<f32>(0.5, 0.5);
    let straight = textureSampleLevel(source_texture, source_sampler, centred, 0.0);
    return vec4<f32>(straight.rgb * straight.a * settings.tint.x, straight.a);
}
