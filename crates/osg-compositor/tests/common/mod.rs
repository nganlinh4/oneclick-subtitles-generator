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
    AtlasPages, Crop, CropSpec, CueLine, CueRun, SourceFrame, SubtitleDecorationSpec,
    SubtitleScene, SubtitleStyle, SubtitleStyleSpec, VideoUnderlay,
};
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, LayoutRefusal,
    LayoutTextAlign, PixelFormat, ProbeFamily, TextTransform, UncheckedGlyphAtlas,
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

/// Each fixture cell's advance in atlas pixels, indexed by cell.
pub(crate) const CELL_ADVANCE_PX: [f64; 2] = [4.0, 10.0];
/// The fixture face's ascent, and therefore its first baseline, in atlas pixels.
pub(crate) const BASELINE_PX: f64 = 8.0;
/// The fixture face's line box in atlas pixels.
pub(crate) const LINE_HEIGHT_PX: f64 = 12.0;

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
/// The frame at 2.5s, in the middle of the second cue of [`two_cue_scene`].
pub(crate) const SECOND_CUE_FRAME: u32 = 75;

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
            ascent_px: BASELINE_PX,
            descent_px: 2.0,
            line_height_px: LINE_HEIGHT_PX,
            baseline_px: BASELINE_PX,
            run_advance_width_px: 10.0,
            shaping_residual_px: 0.0,
            base_direction: Direction::Ltr,
            letter_spacing_px: 0.0,
        },
        atlas: AtlasGeometry {
            width_px: ATLAS_WIDTH,
            height_px: ATLAS_HEIGHT,
            padding_px: 0,
            glyph_count: 2,
            pixel_format: PixelFormat::Rgba8,
            bytes_per_row: BYTES_PER_ROW,
        },
        // The cue's own text, "A", laid out: one line, one cell, at the pen the baker emitted.
        layout: atlas_layout(vec![atlas_line(0, &[INK_CELL], &[0.0])]),
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

/// One fixture cell's advance in atlas pixels.
fn advance_of(cell: u32) -> f64 {
    usize::try_from(cell)
        .ok()
        .and_then(|cell| CELL_ADVANCE_PX.get(cell))
        .copied()
        .unwrap_or(0.0)
}

/// One laid-out line at the pen positions given, on the baseline of line `number`.
///
/// The pens are the caller's, never derived from the advances, because the whole point of the
/// contract is that a pen need not be the accumulation of anything.
pub(crate) fn atlas_line(number: u32, cells: &[u32], pens: &[f64]) -> AtlasLine {
    let advance_width_px = cells
        .iter()
        .zip(pens)
        .map(|(cell, pen)| pen + advance_of(*cell))
        .fold(0.0_f64, f64::max);
    AtlasLine {
        glyphs: cells.to_vec(),
        pen_x_px: pens.to_vec(),
        advance_width_px,
        measured_width_px: advance_width_px,
        shaping_residual_px: 0.0,
        baseline_y_px: f64::from(number).mul_add(LINE_HEIGHT_PX, BASELINE_PX),
        justification_px: 0.0,
        ends_paragraph: true,
    }
}

/// The layout around a set of lines, with every derived field re-derived from them.
pub(crate) fn atlas_layout(lines: Vec<AtlasLine>) -> AtlasLayout {
    let count = u32::try_from(lines.len()).expect("a line count");
    AtlasLayout {
        text_transform: TextTransform::None,
        letter_spacing_px: 0.0,
        max_width_px: None,
        word_wrap: true,
        text_align: LayoutTextAlign::Left,
        line_count: count,
        width_px: lines
            .iter()
            .fold(0.0_f64, |widest, line| widest.max(line.advance_width_px)),
        height_px: f64::from(count) * LINE_HEIGHT_PX,
        cell_advance_layout: CellAdvanceVerdict::Reproduces,
        refusal: LayoutRefusal {
            shaping_crosses_clusters: false,
            direction_needs_bidi: false,
        },
        lines,
    }
}

/// The run the baker would emit for these cells at the fixture's own advances.
///
/// This accumulation lives in the fixture, standing in for the baker, and nowhere in the crate: the
/// compositor reads the pens it is given.
pub(crate) fn baked_line(number: u32, cells: &[u32]) -> CueLine {
    let mut pens = Vec::with_capacity(cells.len());
    let mut pen = 0.0_f64;
    for cell in cells {
        pens.push(pen);
        // A cell the atlas does not have advances nothing, so a test can stage an out-of-range
        // index and get the refusal it is asking about rather than a panic in the fixture.
        pen += advance_of(*cell);
    }
    CueLine::new(
        cells.to_vec(),
        pens,
        pen,
        f64::from(number).mul_add(LINE_HEIGHT_PX, BASELINE_PX),
    )
}

/// A run of baked lines, top to bottom.
pub(crate) fn baked_run(lines: &[&[u32]]) -> CueRun {
    CueRun::new(
        lines
            .iter()
            .enumerate()
            .map(|(number, cells)| baked_line(u32::try_from(number).expect("a line number"), cells))
            .collect(),
    )
}

/// A single-line baked run.
pub(crate) fn baked(cells: &[u32]) -> CueRun {
    baked_run(&[cells])
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

/// The fixture atlas laid out for one alignment.
///
/// The compositor places a run by the **layout's** alignment, so a fixture that staged every style
/// against a layout baked for `left` would be a fixture the pipeline cannot produce: the editor
/// sends one `textAlign` and it reaches both sides. [`layout_align`] reproduces that, and a test
/// that wants the two to disagree — the right-to-left `start` resolution — builds its atlas here by
/// hand instead.
pub(crate) fn aligned_atlas(
    family: &str,
    weight: u16,
    align: LayoutTextAlign,
) -> GlyphAtlasDescriptor {
    let mut unchecked = unchecked_atlas(family, weight);
    unchecked.layout.text_align = align;
    GlyphAtlasDescriptor::try_from(unchecked)
        .expect("the fixture atlas is a descriptor the baker could have produced")
}

/// A *second* atlas page, with a deliberately different cell table from page zero's.
///
/// Page zero is a 16x8 texture whose only inked cell is an 8x8 block in the **right** half. This one
/// is an 8x8 texture whose only inked cell is a 4x4 block in the **top left**. Both differences earn
/// their place:
///
/// * the cell rectangle differs, so a cue drawn from the wrong page draws a different amount of ink;
/// * the coverage sits where the other page has none, so a frame that binds one page's texture while
///   placing the other page's cells samples nothing at all.
///
/// Either mistake changes the picture, which is what makes a two-page render test evidence rather
/// than a shape check. The cell's *advance* is page zero's, so [`baked`] stages the same run for
/// either page and a difference in the frame can only have come from the cells.
pub(crate) fn second_page(
    family: &str,
    weight: u16,
    align: LayoutTextAlign,
) -> GlyphAtlasDescriptor {
    const EDGE: u32 = 8;
    const INK: u32 = 4;

    let mut unchecked = unchecked_atlas(family, weight);
    unchecked.layout.text_align = align;
    unchecked.atlas = AtlasGeometry {
        width_px: EDGE,
        height_px: EDGE,
        padding_px: 0,
        glyph_count: 2,
        pixel_format: PixelFormat::Rgba8,
        bytes_per_row: EDGE * 4,
    };
    let cell = &mut unchecked.glyphs[INK_CELL as usize];
    cell.x_px = 0;
    cell.y_px = 0;
    cell.width_px = INK;
    cell.height_px = INK;
    cell.origin_y_px = i32::try_from(INK).expect("a four-pixel origin");
    let mut pixels = vec![0_u8; (EDGE * EDGE * 4) as usize];
    for y in 0..INK {
        for x in 0..INK {
            let start = ((y * EDGE + x) * 4) as usize;
            pixels[start..start + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    unchecked.pixels = pixels;
    GlyphAtlasDescriptor::try_from(unchecked)
        .expect("the second fixture page is a descriptor the baker could have produced")
}

/// The layout alignment the baker would emit for a style spec, on left-to-right text.
pub(crate) fn layout_align(spec: &SubtitleStyleSpec) -> LayoutTextAlign {
    match spec.text_align.as_str() {
        "center" => LayoutTextAlign::Center,
        "right" => LayoutTextAlign::Right,
        "justify" => LayoutTextAlign::Justify,
        _ => LayoutTextAlign::Left,
    }
}

/// A scene with one cue, "A", from 1.0s to 2.0s.
pub(crate) fn scene(family: &str, weight: u16) -> Scene {
    scene_at(family, weight, WIDTH, HEIGHT)
}

/// A scene whose cues occupy the given whole-second windows, one "A" each.
///
/// The windows are the caller's so a test can put a cue where it wants one; everything else is the
/// fixture's, so a test about which page a cue draws from is not also a test about anything else.
pub(crate) fn scene_with_cues(family: &str, weight: u16, windows: &[(i64, i64)]) -> Scene {
    let timeline = FrameTimeline::new(30, 1, FRAME_COUNT, ExactTime::ZERO)
        .expect("30fps for three seconds is a supported timeline");
    Scene::new(
        1,
        WIDTH,
        HEIGHT,
        timeline,
        resolved_face(family, weight),
        windows
            .iter()
            .map(|(start, end)| SceneCue {
                text: "A".to_owned(),
                start: seconds(*start),
                end: seconds(*end),
            })
            .collect(),
    )
    .expect("the fixture windows are within every bound")
}

/// Two cues back to back: 1.0s to 2.0s, then 2.0s to 3.0s.
///
/// Adjacent rather than overlapping, because [`osg_scene::cues::active_cue_at`] takes the first
/// match: overlapping windows would make which cue is drawn a property of the cue order rather than
/// of the frame, and this fixture exists to make the frame decide.
pub(crate) fn two_cue_scene(family: &str, weight: u16) -> Scene {
    scene_with_cues(family, weight, &[(1, 2), (2, 3)])
}

/// The same scene at a caller-chosen composition size.
///
/// Only the size varies: the cue, the timeline and the face are the fixture's, so a test about
/// resolution is not also a test about anything else.
pub(crate) fn scene_at(family: &str, weight: u16, width: u32, height: u32) -> Scene {
    let timeline = FrameTimeline::new(30, 1, FRAME_COUNT, ExactTime::ZERO)
        .expect("30fps for three seconds is a supported timeline");
    Scene::new(
        1,
        width,
        height,
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
    staged_with_run(spec, baked(&[SPACE_CELL]))
}

/// A half-opaque black box pixel, as the compositor writes it: the background colour at 50%, which
/// `opacity_to_alpha_byte` rounds *down* to 127.
pub(crate) const HALF_BLACK: [u8; 4] = [0, 0, 0, 127];

/// A fully opaque black box pixel.
pub(crate) const OPAQUE_BLACK: [u8; 4] = [0, 0, 0, 255];

/// The whole fixture, staged and checked, with the run the atlas's own layout emitted.
pub(crate) fn staged(spec: &SubtitleStyleSpec) -> SubtitleScene {
    staged_with_run(spec, CueRun::from_layout(atlas(FAMILY, WEIGHT).layout()))
}

/// The fixture with a caller-chosen run, for the layout paths one glyph cannot reach.
pub(crate) fn staged_with_run(spec: &SubtitleStyleSpec, run: CueRun) -> SubtitleScene {
    staged_with_atlas(spec, aligned_atlas(FAMILY, WEIGHT, layout_align(spec)), run)
}

/// The fixture with a caller-chosen atlas as well, for the tests about the atlas itself.
pub(crate) fn staged_with_atlas(
    spec: &SubtitleStyleSpec,
    atlas: GlyphAtlasDescriptor,
    run: CueRun,
) -> SubtitleScene {
    SubtitleScene::new(
        scene(FAMILY, WEIGHT),
        AtlasPages::single(atlas, 1),
        style(spec),
        vec![run],
    )
    .expect("the fixture scene, atlas, style and run agree")
}

/// The whole fixture, staged at a caller-chosen composition size.
pub(crate) fn staged_at(spec: &SubtitleStyleSpec, width: u32, height: u32) -> SubtitleScene {
    let atlas = aligned_atlas(FAMILY, WEIGHT, layout_align(spec));
    let run = CueRun::from_layout(atlas.layout());
    SubtitleScene::new(
        scene_at(FAMILY, WEIGHT, width, height),
        AtlasPages::single(atlas, 1),
        style(spec),
        vec![run],
    )
    .expect("the fixture scene, atlas, style and run agree at any supported size")
}

/// One cue, on its own page, in the window `(start, end)`.
///
/// The reference a two-page scene's frames are compared against: what a cue draws when its page is
/// the only page there is.
pub(crate) fn staged_one_page(
    spec: &SubtitleStyleSpec,
    atlas: GlyphAtlasDescriptor,
    window: (i64, i64),
) -> SubtitleScene {
    SubtitleScene::new(
        scene_with_cues(FAMILY, WEIGHT, &[window]),
        AtlasPages::single(atlas, 1),
        style(spec),
        vec![baked(&[INK_CELL])],
    )
    .expect("the fixture scene, page, style and run agree")
}

/// Two cues, each on its own page: cue zero on page zero, cue one on page one.
pub(crate) fn staged_two_pages(spec: &SubtitleStyleSpec) -> SubtitleScene {
    let align = layout_align(spec);
    let pages = AtlasPages::new(
        vec![
            aligned_atlas(FAMILY, WEIGHT, align),
            second_page(FAMILY, WEIGHT, align),
        ],
        vec![0, 1],
    )
    .expect("two pages with one cue each is a page list the compositor accepts");
    SubtitleScene::new(
        two_cue_scene(FAMILY, WEIGHT),
        pages,
        style(spec),
        vec![baked(&[INK_CELL]), baked(&[INK_CELL])],
    )
    .expect("the two-page fixture scene, pages, style and runs agree")
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
