//! Staged inputs for the subtitle-composition tests.
//!
//! Everything here builds a *valid* descriptor by construction, so a test that wants an invalid one
//! says exactly which field it broke. The atlas deliberately puts its only inked cell in the right
//! half of the texture: a compositor that got its UVs wrong would sample the transparent left half
//! and draw nothing, so "ink appeared" is evidence the atlas was addressed correctly.

// Not every test target uses every builder, and a target that did would be a coincidence rather
// than a design.
#![allow(dead_code)]

// The `compositor!` re-export is unused in the targets that do not compose underlay frames, which
// is the same coincidence the allow above covers.
#[allow(unused_imports, unused_macros)]
pub(crate) mod frames;
pub(crate) mod ink;

use osg_compositor::{
    Crop, CropSpec, CueRun, SourceFrame, SubtitleDecorationSpec, SubtitleScene, SubtitleStyle,
    SubtitleStyleSpec, VideoUnderlay,
};
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasMetrics, Direction, FaceProbe, FaceStyle,
    GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, PixelFormat, ProbeFamily, UncheckedGlyphAtlas,
};
use osg_scene::scene::{ResolvedFace, Scene, SceneCue};
use osg_scene::timeline::{ExactTime, FrameTimeline};

/// The family every fixture resolves to unless a test asks for another.
pub(crate) const FAMILY: &str = "Test Face";
/// The weight every fixture resolves to unless a test asks for another.
pub(crate) const WEIGHT: u16 = 400;
/// The size the fixture atlas is baked at, in atlas pixels.
pub(crate) const BAKE_SIZE: f64 = 24.0;

/// The blank cell, which inks nothing.
pub(crate) const SPACE_CELL: u32 = 0;
/// The inked cell, an 8x8 opaque block.
pub(crate) const INK_CELL: u32 = 1;

const ATLAS_WIDTH: u32 = 16;
const ATLAS_HEIGHT: u32 = 8;
const BYTES_PER_ROW: u32 = ATLAS_WIDTH * 4;
const INK_LEFT: u32 = 8;

/// The composition the render tests use. Even edges, and large enough that a scaled 8x8 cell covers
/// a countable number of pixels.
pub(crate) const WIDTH: u32 = 640;
pub(crate) const HEIGHT: u32 = 360;
/// 30fps for three seconds.
pub(crate) const FRAME_COUNT: u32 = 90;
/// The frame at 1.5s, in the middle of the fixture cue's hold.
pub(crate) const HOLD_FRAME: u32 = 45;
/// The frame at 0.0s, before the cue's fade window opens.
pub(crate) const SILENT_FRAME: u32 = 0;
/// The frame at 0.8s, one third of the way into the fade-in.
pub(crate) const FADING_FRAME: u32 = 24;

pub(crate) fn resolved_face(family: &str, weight: u16) -> ResolvedFace {
    ResolvedFace {
        family: family.to_owned(),
        source: "sha256:0101010101010101010101010101010101010101010101010101010101010101"
            .to_owned(),
        weight,
    }
}

/// The atlas descriptor as it arrives from the baker, before checking, so a test can break one
/// field and prove the refusal.
pub(crate) fn unchecked_atlas(family: &str, weight: u16) -> UncheckedGlyphAtlas {
    UncheckedGlyphAtlas {
        version: GLYPH_ATLAS_VERSION,
        face: AtlasFace {
            requested_family: family.to_owned(),
            weight,
            style: FaceStyle::Normal,
            font_size_px: BAKE_SIZE,
            css_font: format!("normal {weight} 24px \"{family}\""),
            substituted: false,
            probes: vec![
                probe(ProbeFamily::Monospace, 100.0, 120.0),
                probe(ProbeFamily::Serif, 90.0, 90.0),
                probe(ProbeFamily::SansSerif, 95.0, 110.0),
            ],
        },
        metrics: AtlasMetrics {
            ascent_px: 8.0,
            descent_px: 2.0,
            line_height_px: 12.0,
            baseline_px: 8.0,
            run_advance_width_px: 10.0,
            shaping_residual_px: 0.0,
            base_direction: Direction::Ltr,
        },
        atlas: AtlasGeometry {
            width_px: ATLAS_WIDTH,
            height_px: ATLAS_HEIGHT,
            padding_px: 0,
            glyph_count: 2,
            pixel_format: PixelFormat::Rgba8,
            bytes_per_row: BYTES_PER_ROW,
        },
        // Cluster order is the baker's: strictly increasing by UTF-16 code unit.
        glyphs: vec![
            AtlasGlyph {
                cluster: " ".to_owned(),
                code_points: vec![0x20],
                direction: Direction::Neutral,
                advance_width_px: 4.0,
                x_px: 0,
                y_px: 0,
                width_px: 0,
                height_px: 0,
                origin_x_px: 0,
                origin_y_px: 0,
                substituted: false,
            },
            AtlasGlyph {
                cluster: "A".to_owned(),
                code_points: vec![0x41],
                direction: Direction::Ltr,
                advance_width_px: 10.0,
                x_px: INK_LEFT,
                y_px: 0,
                width_px: 8,
                height_px: 8,
                origin_x_px: 0,
                origin_y_px: 8,
                substituted: false,
            },
        ],
        content_hash: "0000abcd".to_owned(),
        pixels: ink_pixels(),
    }
}

fn probe(family: ProbeFamily, alone: f64, chained: f64) -> FaceProbe {
    FaceProbe {
        probe_family: family,
        alone_width_px: alone,
        chained_width_px: chained,
        participated: alone.to_bits() != chained.to_bits(),
    }
}

/// Opaque white coverage in the right half only; the left half stays fully transparent.
fn ink_pixels() -> Vec<u8> {
    let mut pixels = vec![0_u8; (ATLAS_HEIGHT * BYTES_PER_ROW) as usize];
    for y in 0..ATLAS_HEIGHT {
        for x in INK_LEFT..ATLAS_WIDTH {
            let start = (y * BYTES_PER_ROW + x * 4) as usize;
            pixels[start..start + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    pixels
}

pub(crate) fn atlas(family: &str, weight: u16) -> GlyphAtlasDescriptor {
    GlyphAtlasDescriptor::try_from(unchecked_atlas(family, weight))
        .expect("the fixture atlas is a descriptor the baker could have produced")
}

/// A scene with one cue, "A", from 1.0s to 2.0s.
pub(crate) fn scene(family: &str, weight: u16) -> Scene {
    let timeline = FrameTimeline::new(30, 1, FRAME_COUNT, ExactTime::ZERO)
        .expect("30fps for three seconds is a supported timeline");
    Scene::new(
        1,
        WIDTH,
        HEIGHT,
        timeline,
        resolved_face(family, weight),
        vec![SceneCue {
            text: "A".to_owned(),
            start: seconds(1),
            end: seconds(2),
        }],
    )
    .expect("the fixture scene is within every bound")
}

pub(crate) fn seconds(value: i64) -> ExactTime {
    ExactTime::new(value, 1).expect("a whole number of seconds is an exact time")
}

/// The style the render tests use: large enough that the scaled cell covers real pixels, and
/// otherwise the shipped defaults.
pub(crate) fn style_spec() -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        font_size: 144.0,
        ..SubtitleStyleSpec::default()
    }
}

pub(crate) fn style(spec: &SubtitleStyleSpec) -> SubtitleStyle {
    SubtitleStyle::resolve(spec).expect("the fixture style resolves")
}

/// The render style with a decoration and no background, so every inked pixel came from the glyph
/// or from the decoration under test.
pub(crate) fn decorated(decoration: SubtitleDecorationSpec) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        background_opacity: 0.0,
        decoration,
        ..style_spec()
    }
}

/// The render style with a decoration and a half-opaque background box.
///
/// Half-opaque rather than solid on purpose: an opaque box hides every ordering mistake underneath
/// it, so a test that wants to prove what is above the box needs one that can be seen through.
pub(crate) fn decorated_over_box(decoration: SubtitleDecorationSpec) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        background_opacity: 50.0,
        background_color: "#000000".to_owned(),
        decoration,
        ..style_spec()
    }
}

/// The render style with a decoration and a fully opaque background box.
///
/// The opaque box is what makes a paint-order mistake *detectable* rather than merely different:
/// anything drawn under it is gone, not dimmed, so "the effect is on screen" and "the effect is
/// above the box" become the same assertion.
pub(crate) fn decorated_over_opaque_box(decoration: SubtitleDecorationSpec) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        background_opacity: 100.0,
        background_color: "#000000".to_owned(),
        decoration,
        ..style_spec()
    }
}

/// The fixture with no inked glyph at all, so a box, a border or a glow is the only thing drawn.
pub(crate) fn boxed_only(spec: &SubtitleStyleSpec) -> SubtitleScene {
    staged_with_run(spec, CueRun::single_line(vec![SPACE_CELL]))
}

/// A half-opaque black box pixel, as the compositor writes it: the background colour at 50%, which
/// `opacity_to_alpha_byte` rounds *down* to 127.
pub(crate) const HALF_BLACK: [u8; 4] = [0, 0, 0, 127];

/// A fully opaque black box pixel.
pub(crate) const OPAQUE_BLACK: [u8; 4] = [0, 0, 0, 255];

/// The whole fixture, staged and checked.
pub(crate) fn staged(spec: &SubtitleStyleSpec) -> SubtitleScene {
    staged_with_run(spec, CueRun::single_line(vec![INK_CELL]))
}

/// The fixture with a caller-chosen run, for the layout paths one glyph cannot reach.
pub(crate) fn staged_with_run(spec: &SubtitleStyleSpec, run: CueRun) -> SubtitleScene {
    SubtitleScene::new(
        scene(FAMILY, WEIGHT),
        atlas(FAMILY, WEIGHT),
        style(spec),
        vec![run],
    )
    .expect("the fixture scene, atlas, style and run agree")
}

/// The edge of the fixture source frame, in source pixels.
pub(crate) const SOURCE_EDGE: u32 = 64;

/// The four quadrant colours of the fixture source, opaque and mutually unmistakable.
///
/// Four different colours rather than one mark, because they are simultaneously the crop target,
/// the flip witness and the proof that the source is not being sampled upside down: a wrong region
/// or a wrong sampling transform lands a *different named colour* in the corner under test, which
/// no rounding tolerance can excuse.
pub(crate) const SOURCE_TOP_LEFT: [u8; 4] = [255, 0, 0, 255];
pub(crate) const SOURCE_TOP_RIGHT: [u8; 4] = [0, 255, 0, 255];
pub(crate) const SOURCE_BOTTOM_LEFT: [u8; 4] = [0, 0, 255, 255];
pub(crate) const SOURCE_BOTTOM_RIGHT: [u8; 4] = [255, 255, 0, 255];

/// A colour no quadrant uses, so a backfill pixel can never be mistaken for a source pixel.
pub(crate) const BACKFILL_COLOR: &str = "#ff00ff";
/// [`BACKFILL_COLOR`] as the compositor writes it: opaque, so premultiplied equals straight.
pub(crate) const BACKFILL_PIXEL: [u8; 4] = [255, 0, 255, 255];

/// An opaque source frame with one flat colour per quadrant.
pub(crate) fn quadrant_source() -> SourceFrame {
    let half = SOURCE_EDGE / 2;
    let mut pixels = Vec::with_capacity((SOURCE_EDGE * SOURCE_EDGE * 4) as usize);
    for y in 0..SOURCE_EDGE {
        for x in 0..SOURCE_EDGE {
            let colour = match (x < half, y < half) {
                (true, true) => SOURCE_TOP_LEFT,
                (false, true) => SOURCE_TOP_RIGHT,
                (true, false) => SOURCE_BOTTOM_LEFT,
                (false, false) => SOURCE_BOTTOM_RIGHT,
            };
            pixels.extend_from_slice(&colour);
        }
    }
    SourceFrame::new(SOURCE_EDGE, SOURCE_EDGE, pixels).expect("the fixture source frame is valid")
}

/// The quadrant source under a caller-chosen crop.
pub(crate) fn underlay(spec: &CropSpec) -> VideoUnderlay {
    VideoUnderlay::new(
        quadrant_source(),
        Crop::resolve(spec).expect("the fixture crop resolves"),
    )
}
