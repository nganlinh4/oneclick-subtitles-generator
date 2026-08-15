// Building the blurred canvas backfill, in two entry points that share one bind group.
//
// `fs_cover` scales the source to cover the output, over-scales and darkens it the way the shipped
// renderer's backdrop element does, and premultiplies it. `fs_blur` is one axis of a separable
// Gaussian: two draws with perpendicular strides cost 2r taps per pixel instead of the r^2 an
// isotropic kernel would, and r is bounded by the crop contract before it ever reaches here.
//
// The blur reads with `textureLoad` at clamped integer coordinates. That makes each tap an exact
// texel with no sampler state in the result, and edge clamping means the backdrop does not darken
// towards its own border the way a transparent-edged CSS blur does.

struct Backfill {
    // fs_cover: cover scale x, cover scale y, flipX, flipY.
    // fs_blur:  stride x, stride y, kernel half-width, standard deviation.
    params: vec4<f32>,
    // fs_cover: brightness multiplier in x. Unused by fs_blur.
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

@fragment
fn fs_blur(input: VertexOutput) -> @location(0) vec4<f32> {
    let extent = vec2<i32>(textureDimensions(source_texture, 0));
    let centre = vec2<i32>(floor(input.clip.xy));
    let stride = vec2<i32>(i32(settings.params.x), i32(settings.params.y));
    let radius = i32(settings.params.z);
    let falloff = -0.5 / (settings.params.w * settings.params.w);

    var total = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    var weight_total = 0.0;
    for (var offset = -radius; offset <= radius; offset = offset + 1) {
        let weight = exp(f32(offset * offset) * falloff);
        let coord = clamp(centre + stride * offset, vec2<i32>(0, 0), extent - vec2<i32>(1, 1));
        total = total + textureLoad(source_texture, coord, 0) * weight;
        weight_total = weight_total + weight;
    }
    return total / weight_total;
}
