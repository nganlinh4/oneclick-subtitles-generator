// One axis of a separable Gaussian, shared by the canvas backfill and the subtitle decorations.
//
// Two draws with perpendicular strides cost 2r taps per pixel instead of the r^2 an isotropic
// kernel would, and r is bounded by the caller before it ever reaches here. There is exactly one
// copy of this loop in the crate: a second one would be a second blur to keep in agreement.
//
// The blur reads with `textureLoad` at clamped integer coordinates. That makes each tap an exact
// texel with no sampler state in the result, and edge clamping means a source does not darken
// towards its own border the way a transparent-edged CSS blur does.

struct Blur {
    // stride x, stride y, kernel half-width, standard deviation.
    params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> settings: Blur;
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
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
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
