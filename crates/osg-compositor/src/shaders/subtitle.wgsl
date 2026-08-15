// Textured-quad composition for the OSG native subtitle renderer.
//
// The CPU plan (src/geometry.rs) has already applied the cue transform, so vertices arrive in clip
// space and this shader only resolves coverage. Two kinds share the one pipeline: a solid rounded
// box for the subtitle background, and an atlas cell whose alpha channel is the glyph coverage the
// WebView baked. Colour never lives in the atlas, so a scene can restyle without re-baking.
//
// Output is premultiplied so the target can be composited over video without a second pass, and it
// carries no time source and no randomness: every fragment is a function of its vertex attributes.

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) colour: vec4<f32>,
    @location(3) shape: vec4<f32>,
    @location(4) params: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) colour: vec4<f32>,
    @location(2) shape: vec4<f32>,
    @location(3) params: vec2<f32>,
};

@group(0) @binding(0) var atlas_texture: texture_2d<f32>;
@group(0) @binding(1) var atlas_sampler: sampler;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clip = vec4<f32>(input.position, 0.0, 1.0);
    output.uv = input.uv;
    output.colour = input.colour;
    output.shape = input.shape;
    output.params = input.params;
    return output;
}

// Signed distance to a rounded box centred on the origin, in the quad's own pixel space. The cue
// transform is affine, so interpolating that space across the quad stays exact.
fn rounded_box(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> f32 {
    let q = abs(point) - half_extent + vec2<f32>(radius, radius);
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    var coverage: f32;
    if (input.params.y < 0.5) {
        // A fixed one-pixel band rather than a derivative: fwidth would make the edge depend on how
        // the driver groups quads, and this frame has to be byte-identical every time.
        let distance = rounded_box(input.shape.xy, input.shape.zw, input.params.x);
        coverage = clamp(0.5 - distance, 0.0, 1.0);
    } else {
        coverage = textureSample(atlas_texture, atlas_sampler, input.uv).a;
    }
    let alpha = input.colour.a * coverage;
    return vec4<f32>(input.colour.rgb * alpha, alpha);
}
