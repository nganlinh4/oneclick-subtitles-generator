// The video underlay: crop, flip and canvas backfill in one sampling decision.
//
// This runs once per frame, before the subtitle quads, into the same render target. Crop is a
// source rectangle, flip is that rectangle read backwards, and the backfill is whatever shows
// where the rectangle falls outside the source. Doing all three here is what keeps the export on
// one pixel pipeline instead of a crop pass, a flip pass and a composite pass.
//
// Alpha: the source arrives straight and leaves premultiplied, because the subtitle layer that
// draws over it blends premultiplied (src + dst * (1 - src.a)). The video is composited over the
// backfill by the same rule inside this shader, so a source with its own transparency behaves the
// way the layer above it does rather than by a second convention.
//
// `textureSampleLevel` rather than `textureSample` throughout: the crop test is per-fragment and
// therefore non-uniform control flow, where an implicit-derivative sample is not allowed. Explicit
// level 0 is also one fewer thing that could differ between adapters.

struct Underlay {
    // Source rectangle as fractions of the source: left, top, width, height. Values outside 0..1
    // are legal and are exactly what the backfill exists for.
    region: vec4<f32>,
    // flipX (0 or 1), flipY (0 or 1), backfill mode, unused.
    flags: vec4<f32>,
    // Straight-alpha solid backfill colour.
    solid: vec4<f32>,
};

const MODE_SOLID: f32 = 1.0;
const MODE_BLUR: f32 = 2.0;

@group(0) @binding(0) var<uniform> underlay: Underlay;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;
@group(0) @binding(3) var backfill_texture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// One oversized triangle rather than two, so there is no diagonal seam and no vertex buffer.
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
    // Flip is a sampling transform on the cropped region, not a post-process on the frame: the
    // rectangle is chosen in source coordinates and then read backwards.
    var read = input.uv;
    if (underlay.flags.x > 0.5) {
        read.x = 1.0 - read.x;
    }
    if (underlay.flags.y > 0.5) {
        read.y = 1.0 - read.y;
    }
    let source_uv = underlay.region.xy + read * underlay.region.zw;

    var video = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    let inside = all(source_uv >= vec2<f32>(0.0, 0.0)) && all(source_uv <= vec2<f32>(1.0, 1.0));
    if (inside) {
        let straight = textureSampleLevel(source_texture, source_sampler, source_uv, 0.0);
        video = vec4<f32>(straight.rgb * straight.a, straight.a);
    }

    var backfill = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    if (underlay.flags.z >= MODE_BLUR) {
        // Already premultiplied and already darkened by the backfill pass.
        backfill = textureSampleLevel(backfill_texture, source_sampler, input.uv, 0.0);
    } else if (underlay.flags.z >= MODE_SOLID) {
        backfill = vec4<f32>(underlay.solid.rgb * underlay.solid.a, underlay.solid.a);
    }

    return video + backfill * (1.0 - video.a);
}
