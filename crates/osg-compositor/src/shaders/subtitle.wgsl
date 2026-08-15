// Textured-quad composition for the OSG native subtitle renderer.
//
// The CPU plan (src/plan.rs) has already applied the cue transform, so vertices arrive in clip
// space and this shader only resolves coverage. Five kinds share the one pipeline:
//
//   0 box     a solid rounded rectangle: the subtitle background, and the shape a glow is cast from
//   1 glyph   a sampled cell: an atlas glyph, or a blurred mask laid over the whole frame
//   2 stroke  a glyph dilated by the stroke radius, taken as the largest coverage on a ring
//   3 border  the ring between the border box and the padding box, patterned by its style
//   4 glow    a blurred box mask with the box itself cut back out of it, i.e. a CSS outer shadow
//
// Colour never lives in the atlas, so a scene can restyle without re-baking, and a linear gradient
// arrives as four corner colours rather than as a second uniform: the ramp is affine over the quad,
// so interpolation reproduces it exactly.
//
// Output is premultiplied so the target can be composited over video without a second pass, and it
// carries no time source and no randomness: every fragment is a function of its vertex attributes.
// Every sample takes an explicit mip level, so no branch here depends on an implicit derivative.

const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

// How many ring samples a stroke fragment takes. Fixed, so the cost of a stroke does not grow with
// its width. The count is owned by `STROKE_TAPS` in src/glyphs.rs and substituted into this source
// at pipeline build, which is why the placeholder below is not itself valid WGSL: two hand-kept
// copies of the number would differ quietly rather than fail to compile.
const STROKE_TAPS: i32 = $STROKE_TAPS;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) colour: vec4<f32>,
    @location(3) shape: vec4<f32>,
    @location(4) params: vec4<f32>,
    @location(5) cell: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) colour: vec4<f32>,
    @location(2) shape: vec4<f32>,
    @location(3) params: vec4<f32>,
    @location(4) cell: vec4<f32>,
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
    output.cell = input.cell;
    return output;
}

// Signed distance to a rounded box centred on the origin, in the quad's own pixel space. The cue
// transform is affine, so interpolating that space across the quad stays exact.
fn rounded_box(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> f32 {
    let q = abs(point) - half_extent + vec2<f32>(radius, radius);
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// A fixed one-pixel band rather than a derivative: fwidth would make the edge depend on how the
// driver groups quads, and this frame has to be byte-identical every time.
fn coverage_of(distance: f32) -> f32 {
    return clamp(0.5 - distance, 0.0, 1.0);
}

// The band between two concentric rounded boxes: the outer one inset by `inset`, the inner one by
// `inset + width`.
fn ring_coverage(
    point: vec2<f32>,
    half_extent: vec2<f32>,
    radius: f32,
    inset: f32,
    width: f32,
) -> f32 {
    let outer = rounded_box(
        point,
        max(half_extent - vec2<f32>(inset, inset), vec2<f32>(0.0, 0.0)),
        max(radius - inset, 0.0),
    );
    let inner = rounded_box(
        point,
        max(half_extent - vec2<f32>(inset + width, inset + width), vec2<f32>(0.0, 0.0)),
        max(radius - inset - width, 0.0),
    );
    return coverage_of(max(outer, -inner));
}

// Arc length of the nearest point on a rounded rectangle, and that rectangle's whole perimeter.
//
// Measured clockwise from the middle of the top edge, through four straight runs and four quarter
// arcs. A dash pattern needs real arc length rather than an angle, or the dashes would bunch up in
// the corners of every non-square box.
fn perimeter_arc(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> vec2<f32> {
    let a = max(half_extent.x - radius, 0.0);
    let b = max(half_extent.y - radius, 0.0);
    let quarter = 0.5 * PI * radius;
    let total = 4.0 * (a + b + quarter);
    let across = abs(point.x);
    let down = abs(point.y);
    var arc = 0.0;
    if (across <= a) {
        if (point.y < 0.0) {
            arc = select(total + point.x, point.x, point.x >= 0.0);
        } else {
            arc = a + 2.0 * quarter + 2.0 * b + (a - point.x);
        }
    } else if (down <= b) {
        if (point.x > 0.0) {
            arc = a + quarter + (point.y + b);
        } else {
            arc = 3.0 * a + 3.0 * quarter + 2.0 * b + (b - point.y);
        }
    } else {
        let u = across - a;
        let v = down - b;
        if (point.x > 0.0 && point.y < 0.0) {
            arc = a + radius * atan2(u, v);
        } else if (point.x > 0.0) {
            arc = a + quarter + 2.0 * b + radius * atan2(v, u);
        } else if (point.y > 0.0) {
            arc = 3.0 * a + 2.0 * quarter + 2.0 * b + radius * atan2(u, v);
        } else {
            arc = 3.0 * a + 3.0 * quarter + 4.0 * b + radius * atan2(v, u);
        }
    }
    return vec2<f32>(arc, total);
}

// Two lines of a third of the width each, separated by a third, which is what `double` means.
fn double_border(point: vec2<f32>, half_extent: vec2<f32>, radius: f32, width: f32) -> f32 {
    let third = width / 3.0;
    return max(
        ring_coverage(point, half_extent, radius, 0.0, third),
        ring_coverage(point, half_extent, radius, 2.0 * third, third),
    );
}

// `dashed` and `dotted`. The period is nudged so a whole number of them fits the perimeter, which
// is what keeps the pattern from meeting itself with a stub at the top of the box.
fn patterned_border(
    point: vec2<f32>,
    half_extent: vec2<f32>,
    radius: f32,
    width: f32,
    dotted: bool,
) -> f32 {
    let inset = 0.5 * width;
    let centre_half = max(half_extent - vec2<f32>(inset, inset), vec2<f32>(0.0, 0.0));
    let centre_radius = max(radius - inset, 0.0);
    let arc = perimeter_arc(point, centre_half, centre_radius);
    if (arc.y <= 0.0) {
        return ring_coverage(point, half_extent, radius, 0.0, width);
    }

    let nominal = select(6.0 * width, 2.0 * width, dotted);
    let period = arc.y / max(1.0, round(arc.y / nominal));
    let centre = period * (floor(arc.x / period) + 0.5);
    let along = abs(arc.x - centre);

    if (dotted) {
        let across = abs(rounded_box(point, centre_half, centre_radius));
        return coverage_of(length(vec2<f32>(along, across)) - 0.5 * width);
    }
    return min(
        ring_coverage(point, half_extent, radius, 0.0, width),
        coverage_of(along - 0.25 * period),
    );
}

fn border_coverage(
    point: vec2<f32>,
    half_extent: vec2<f32>,
    radius: f32,
    width: f32,
    style: f32,
) -> f32 {
    if (style < 0.5) {
        return ring_coverage(point, half_extent, radius, 0.0, width);
    }
    if (style < 1.5) {
        return double_border(point, half_extent, radius, width);
    }
    return patterned_border(point, half_extent, radius, width, style > 2.5);
}

// A cell's coverage, and nothing outside it. Clamping to the cell rather than to the texture is
// what keeps a dilating sample from reaching the neighbouring glyph on the same atlas shelf.
fn cell_alpha(uv: vec2<f32>, cell: vec4<f32>) -> f32 {
    if (uv.x < cell.x || uv.x > cell.z || uv.y < cell.y || uv.y > cell.w) {
        return 0.0;
    }
    return textureSampleLevel(atlas_texture, atlas_sampler, uv, 0.0).a;
}

// Dilation by a disc, approximated by the largest coverage on a ring of that radius.
fn stroke_alpha(uv: vec2<f32>, cell: vec4<f32>, ring: vec2<f32>) -> f32 {
    var coverage = cell_alpha(uv, cell);
    for (var tap = 0; tap < STROKE_TAPS; tap = tap + 1) {
        let angle = f32(tap) * (TAU / f32(STROKE_TAPS));
        coverage = max(coverage, cell_alpha(uv + vec2<f32>(cos(angle), sin(angle)) * ring, cell));
    }
    return coverage;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let kind = input.params.y;
    var coverage: f32;
    if (kind < 0.5) {
        coverage = coverage_of(rounded_box(input.shape.xy, input.shape.zw, input.params.x));
    } else if (kind < 1.5) {
        coverage = textureSampleLevel(atlas_texture, atlas_sampler, input.uv, 0.0).a;
    } else if (kind < 2.5) {
        coverage = stroke_alpha(input.uv, input.cell, input.params.zw);
    } else if (kind < 3.5) {
        coverage = border_coverage(
            input.shape.xy,
            input.shape.zw,
            input.params.x,
            input.params.z,
            input.params.w,
        );
    } else {
        let mask = textureSampleLevel(atlas_texture, atlas_sampler, input.uv, 0.0).a;
        let box = coverage_of(rounded_box(input.shape.xy, input.shape.zw, input.params.x));
        coverage = mask * (1.0 - box);
    }
    let alpha = input.colour.a * coverage;
    return vec4<f32>(input.colour.rgb * alpha, alpha);
}
