// Deterministic reference scene for the OSG headless compositor.
//
// Every fragment is a pure function of the frame size and the caller-supplied phase. There is no
// randomness and no time source, so the same inputs always produce the same bytes, and the same
// scene at a different size is a genuinely different image rather than a rescaled one.

struct Uniforms {
    size: vec2<f32>,
    phase: f32,
    pad: f32,
};

@group(0) @binding(0) var<uniform> scene: Uniforms;

// One oversized triangle covers the target without a vertex buffer.
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = f32(index & 1u) * 4.0 - 1.0;
    let y = f32(index >> 1u) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// Signed distance to a rounded box centred on the origin.
fn rounded_box(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> f32 {
    let q = abs(point) - half_extent + vec2<f32>(radius, radius);
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let pixel = frag.xy;
    let uv = pixel / scene.size;

    // Backdrop: a vertical gradient in normalised space.
    var colour = mix(vec3<f32>(0.043, 0.055, 0.086), vec3<f32>(0.129, 0.157, 0.243), uv.y);

    // Rule lines every 16 device pixels. This is what makes the scene resolution-dependent: the
    // same normalised layout at a different size is not the same picture.
    let cell = 16.0;
    let grid = min(pixel.x % cell, pixel.y % cell);
    colour = mix(colour, colour + vec3<f32>(0.06), step(grid, 1.0));

    // Caption plate: a rounded box in normalised space, sized like the subtitle box the real
    // renderer composites.
    let aa = 1.5 / scene.size.y;
    let distance = rounded_box(uv - vec2<f32>(0.5, 0.72), vec2<f32>(0.36, 0.10), 0.03);
    let outer = 1.0 - smoothstep(-aa, aa, distance);
    let inner = 1.0 - smoothstep(-aa, aa, distance + 0.008);
    let border = outer - inner;

    // Plate fill plus a highlight whose position is a pure function of the phase input.
    let plate_u = clamp((uv.x - 0.14) / 0.72, 0.0, 1.0);
    let fill = mix(vec3<f32>(0.129, 0.212, 0.376), vec3<f32>(0.259, 0.157, 0.376), plate_u);
    let offset = (plate_u - scene.phase) / 0.12;
    let sweep = exp(-offset * offset * 4.0);
    colour = mix(colour, fill + vec3<f32>(0.35, 0.32, 0.22) * sweep, inner);
    colour = mix(colour, vec3<f32>(0.60, 0.76, 0.98), border);

    // Orientation anchor in the first 8x8 device pixels, so readbacks prove their own row order.
    let marker = step(pixel.x, 8.0) * step(pixel.y, 8.0);
    colour = mix(colour, vec3<f32>(1.0, 0.35, 0.20), marker);

    return vec4<f32>(clamp(colour, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
