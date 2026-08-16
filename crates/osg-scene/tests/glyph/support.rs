//! One valid descriptor, built by construction, and the two ways a test bends it.
//!
//! Everything here produces a descriptor the baker could really have emitted — layout included —
//! so a test that wants a refusal says exactly which field it broke and nothing else can be the
//! reason.

use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, GlyphAtlasError,
    LayoutRefusal, LayoutTextAlign, PixelFormat, ProbeFamily, TextTransform, UncheckedGlyphAtlas,
};

/// The baker itself, so the mirrored limits are asserted against their source rather than against a
/// copy of it. Moving the file breaks this test loudly, which is the intent.
pub(crate) const BAKER: &str = include_str!("../../../../src/platform/glyphAtlas.js");

/// The advance every fixture cell carries, and therefore the pen step of the fixture line.
pub(crate) const ADVANCE_PX: f64 = 13.2;
/// The fixture face's ascent, which is also its first baseline.
pub(crate) const BASELINE_PX: f64 = 19.2;
/// The fixture face's line box.
pub(crate) const LINE_HEIGHT_PX: f64 = 24.0;

pub(crate) fn glyph(cluster: &str, x_px: u32) -> AtlasGlyph {
    AtlasGlyph {
        cluster: cluster.to_owned(),
        code_points: cluster.chars().map(u32::from).collect(),
        direction: Direction::Ltr,
        advance_width_px: ADVANCE_PX,
        x_px,
        y_px: 0,
        width_px: 8,
        height_px: 12,
        origin_x_px: 1,
        origin_y_px: 11,
        substituted: false,
    }
}

/// An inkless cell: whitespace and format characters bake to nothing and are placed at the origin.
pub(crate) fn inkless(cluster: &str) -> AtlasGlyph {
    AtlasGlyph {
        code_points: cluster.chars().map(u32::from).collect(),
        cluster: cluster.to_owned(),
        advance_width_px: 0.0,
        x_px: 0,
        width_px: 0,
        height_px: 0,
        origin_x_px: 0,
        origin_y_px: 0,
        ..glyph("x", 0)
    }
}

/// Distinct single-character clusters in the baker's increasing UTF-16 order, so a count bound can
/// be tested without also tripping the ordering rule.
pub(crate) fn distinct(index: usize) -> String {
    let code_point = 0x4e00 + u32::try_from(index).expect("a cluster index");
    char::from_u32(code_point)
        .expect("a basic multilingual code point")
        .to_string()
}

pub(crate) fn probes() -> Vec<FaceProbe> {
    vec![
        FaceProbe {
            probe_family: ProbeFamily::Monospace,
            alone_width_px: 90.0,
            chained_width_px: 78.0,
            participated: true,
        },
        FaceProbe {
            probe_family: ProbeFamily::Serif,
            alone_width_px: 82.5,
            chained_width_px: 78.0,
            participated: true,
        },
        FaceProbe {
            probe_family: ProbeFamily::SansSerif,
            alone_width_px: 78.0,
            chained_width_px: 78.0,
            participated: false,
        },
    ]
}

/// One line drawing `cells` at the pen positions given, on the baseline of line `number`.
pub(crate) fn line(number: u32, cells: &[u32], pens: &[f64]) -> AtlasLine {
    let advance_width_px = pens.last().copied().unwrap_or(0.0) + ADVANCE_PX;
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

/// The layout wrapped around a set of lines, with every derived field re-derived from them.
pub(crate) fn layout_of(lines: Vec<AtlasLine>) -> AtlasLayout {
    let width_px = lines
        .iter()
        .fold(0.0_f64, |widest, line| widest.max(line.advance_width_px));
    AtlasLayout {
        text_transform: TextTransform::None,
        letter_spacing_px: 0.0,
        max_width_px: None,
        word_wrap: true,
        text_align: LayoutTextAlign::Left,
        line_count: u32::try_from(lines.len()).expect("a line count"),
        width_px,
        height_px: f64::from(u32::try_from(lines.len()).expect("a line count")) * LINE_HEIGHT_PX,
        cell_advance_layout: CellAdvanceVerdict::Reproduces,
        refusal: LayoutRefusal {
            shaping_crosses_clusters: false,
            direction_needs_bidi: false,
        },
        lines,
    }
}

/// The fixture layout: both cells on one line, the second one advance to the right of the first.
pub(crate) fn layout() -> AtlasLayout {
    layout_of(vec![line(0, &[0, 1], &[0.0, ADVANCE_PX])])
}

pub(crate) fn valid() -> UncheckedGlyphAtlas {
    UncheckedGlyphAtlas {
        version: GLYPH_ATLAS_VERSION,
        face: AtlasFace {
            requested_family: "Inter".to_owned(),
            weight: 400,
            style: FaceStyle::Normal,
            font_size_px: 24.0,
            css_font: "normal 400 24px \"Inter\"".to_owned(),
            substituted: false,
            probes: probes(),
        },
        metrics: AtlasMetrics {
            ascent_px: BASELINE_PX,
            descent_px: 4.8,
            line_height_px: LINE_HEIGHT_PX,
            baseline_px: BASELINE_PX,
            run_advance_width_px: ADVANCE_PX * 2.0,
            shaping_residual_px: 0.0,
            base_direction: Direction::Ltr,
            letter_spacing_px: 0.0,
        },
        atlas: AtlasGeometry {
            width_px: 16,
            height_px: 16,
            padding_px: 1,
            glyph_count: 2,
            pixel_format: PixelFormat::Rgba8,
            bytes_per_row: 64,
        },
        layout: layout(),
        glyphs: vec![glyph("A", 0), glyph("b", 8)],
        content_hash: "0a1b2c3d".to_owned(),
        pixels: vec![0; 16 * 64],
    }
}

/// An atlas with no ink at all: the baker emits this for text that is entirely whitespace.
pub(crate) fn empty() -> UncheckedGlyphAtlas {
    UncheckedGlyphAtlas {
        atlas: AtlasGeometry {
            width_px: 0,
            height_px: 0,
            glyph_count: 0,
            bytes_per_row: 0,
            ..valid().atlas
        },
        layout: layout_of(Vec::new()),
        glyphs: vec![],
        pixels: vec![],
        ..valid()
    }
}

/// Replace the cells and the layout together, because a layout indexes the cells beside it.
pub(crate) fn with_cells(atlas: &mut UncheckedGlyphAtlas, glyphs: Vec<AtlasGlyph>) {
    let cells: Vec<u32> = (0..u32::try_from(glyphs.len()).expect("a cell count")).collect();
    let pens: Vec<f64> = cells
        .iter()
        .map(|index| ADVANCE_PX * f64::from(*index))
        .collect();
    atlas.atlas.glyph_count = u32::try_from(glyphs.len()).expect("a cell count");
    atlas.layout = if glyphs.is_empty() {
        layout_of(Vec::new())
    } else {
        layout_of(vec![line(0, &cells, &pens)])
    };
    atlas.glyphs = glyphs;
}

pub(crate) fn refuse(mutate: impl FnOnce(&mut UncheckedGlyphAtlas)) -> GlyphAtlasError {
    let mut atlas = valid();
    mutate(&mut atlas);
    GlyphAtlasDescriptor::try_from(atlas).expect_err("the descriptor must be refused")
}

pub(crate) fn accept(mutate: impl FnOnce(&mut UncheckedGlyphAtlas)) -> GlyphAtlasDescriptor {
    let mut atlas = valid();
    mutate(&mut atlas);
    GlyphAtlasDescriptor::try_from(atlas).expect("the descriptor must be accepted")
}

/// Read one `GLYPH_ATLAS_LIMITS` entry out of the baker's source, numeric separators and all.
pub(crate) fn baker_limit(name: &str) -> String {
    let needle = format!("{name}:");
    let start = BAKER
        .find(&needle)
        .unwrap_or_else(|| panic!("{name} must exist in the baker"))
        + needle.len();
    let rest = &BAKER[start..];
    let end = rest.find(',').expect("the limit must be terminated");
    rest[..end].replace('_', "").trim().to_owned()
}

pub(crate) fn baker_count(name: &str) -> u64 {
    baker_limit(name).parse().expect("a whole-number limit")
}

pub(crate) fn baker_number(name: &str) -> f64 {
    baker_limit(name).parse().expect("a numeric limit")
}
