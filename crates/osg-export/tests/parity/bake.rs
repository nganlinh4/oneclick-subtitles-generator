//! A stand-in for the `WebView` baker, so the matrix can be rendered without a browser.
//!
//! # What this is, and what it is not
//!
//! The architecture forbids a Rust text stack: `src/platform/glyphAtlas*.js` shapes, rasterizes,
//! wraps and reorders, and Rust draws what it staged. A gate that has to render 30 presets against
//! 9 scripts therefore needs staged text for each of them, and there is no browser in `cargo test`.
//!
//! So this module produces a descriptor the baker *could* have produced: it obeys every bound and
//! every derived-field agreement `osg_scene::glyph` enforces, and it consumes the same
//! customization fields the real baker consumes — the transform, the spacing, the line box, the
//! wrap width, the alignment and the direction — so a field the staging boundary owns changes the
//! staged text here exactly as it would change it there.
//!
//! It is **not** a shaper. Advances come from a fixed function of the cluster rather than from a
//! font, cluster boundaries are a bounded approximation of UAX #29 covering the fixture's nine
//! texts, and right-to-left order is a reversal rather than UAX #9. Those are the browser's job and
//! the browser's suites test them. What this module makes testable is everything downstream: that
//! the conversion, the scene, the compositor and the encoder carry what was staged, for every
//! preset, every field value and every script in the matrix.

use osg_compositor::CueRun;
use osg_export::{StagedText, primary_font_family};
use osg_render::{SubtitleCustomization, TextAlign, TextTransform};
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, LayoutRefusal,
    LayoutTextAlign, PixelFormat, ProbeFamily, UncheckedGlyphAtlas,
};
use osg_scene::scene::ResolvedFace;

mod text;

use text::{advance_of, clusters, direction_of, ink_width, round4, transform, utf16_order};

/// The size the stand-in bakes at. One size for every case, because the compositor scales the atlas
/// by `fontSize / atlasFontSize`, so a second bake size would only move the same ratio around.
const ATLAS_FONT_SIZE_PX: f64 = 24.0;
/// Face ascent at that size.
const ASCENT_PX: f64 = 19.0;
/// Face descent at that size.
const DESCENT_PX: f64 = 5.0;
/// The square each cell occupies in the atlas, in pixels.
const CELL_PX: u32 = 16;
/// How many cells one atlas row carries.
const CELL_COLUMNS: u32 = 8;
/// The wrap width `maxWidth: 100` means, in atlas pixels.
///
/// The real wrap width is a percentage of the composition, resolved in
/// `src/components/previews/native/nativePreviewGeometry.js` and baked into the atlas. The stand-in
/// resolves the same percentage against a fixed reference instead, which keeps `maxWidth`
/// observable — a narrower value wraps into more lines — without inventing a second geometry model.
const WRAP_REFERENCE_PX: f64 = 400.0;
/// The narrowest cluster advance, before letter spacing.
const MIN_ADVANCE_PX: f64 = 6.0;
/// How much the cluster's first code point may widen it.
const ADVANCE_SPREAD: u32 = 9;

/// The face, atlas and runs one case stages, plus the resolved face the conversion checks against.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Staged {
    face: ResolvedFace,
    atlas: GlyphAtlasDescriptor,
    run: CueRun,
}

impl Staged {
    /// The face the conversion is given, which is the one the atlas was baked from.
    pub(crate) const fn face(&self) -> &ResolvedFace {
        &self.face
    }

    /// The staged text for a scene carrying `cues` cues, all drawing this run.
    pub(crate) fn text(&self, cues: usize) -> StagedText {
        StagedText::single(
            self.face.clone(),
            self.atlas.clone(),
            (0..cues).map(|_| self.run.clone()).collect(),
        )
    }

    /// How many cells the run places, for the diagnostics a failing case prints.
    pub(crate) fn placed_cells(&self) -> usize {
        self.run.placed_cells()
    }

    /// How many lines the run occupies.
    pub(crate) fn line_count(&self) -> usize {
        self.run.lines().len()
    }

    /// Whether two stagings give the compositor the same thing to draw.
    ///
    /// Not the same as `self == other`. A descriptor carries provenance the compositor never reads
    /// — the wrap width the baker measured against, the alignment it justified for, the content
    /// hash — and a setting that changes only those has changed the staged text without changing a
    /// pixel. `maxWidth` on a line that already fits, `wordWrap` on a text with one line and
    /// `rtlSupport` on a text with no right-to-left cluster are all exactly that.
    ///
    /// This compares what is actually drawn: the face size the cells are scaled by, the metrics the
    /// lines are stacked with, the atlas geometry and its pixels, the cells, and the run's own
    /// positions. The sweep uses it to turn "this value did not change the picture" from an
    /// exception somebody has to maintain into a claim it can check — and, because the claim is
    /// then asserted, a comparison that is too narrow fails loudly rather than passing quietly.
    pub(crate) fn draws_the_same_as(&self, other: &Self) -> bool {
        let (mine, theirs) = (&self.atlas, &other.atlas);
        mine.face().font_size_px.to_bits() == theirs.face().font_size_px.to_bits()
            && mine.face().requested_family == theirs.face().requested_family
            && mine.face().weight == theirs.face().weight
            && mine.metrics() == theirs.metrics()
            && mine.atlas() == theirs.atlas()
            && mine.glyphs() == theirs.glyphs()
            && mine.pixels() == theirs.pixels()
            && self.run == other.run
    }
}

/// Bakes `text` the way `customization` asks for it.
///
/// # Panics
/// Panics when the customization names no usable family, or when the descriptor it produces is one
/// the baker could not have produced. Both are bugs in this module rather than findings about the
/// pipeline, so they fail loudly here instead of being reported as a parity failure.
pub(crate) fn bake(text: &str, customization: &SubtitleCustomization) -> Staged {
    let family = primary_font_family(&customization.font_family)
        .expect("every preset names a real family")
        .to_owned();
    let weight = customization.font_weight;

    let transformed = transform(text, customization.text_transform);
    let clusters = clusters(&transformed);
    let cells = distinct_cells(&clusters, customization.letter_spacing, weight);
    let lines = wrap(&clusters, &cells, customization);
    let layout = layout(&lines, &cells, customization);
    let metrics = metrics(&cells, &clusters, customization);

    let unchecked = UncheckedGlyphAtlas {
        version: GLYPH_ATLAS_VERSION,
        face: AtlasFace {
            requested_family: family.clone(),
            weight,
            style: FaceStyle::Normal,
            font_size_px: ATLAS_FONT_SIZE_PX,
            css_font: format!("normal {weight} {ATLAS_FONT_SIZE_PX}px \"{family}\""),
            substituted: false,
            probes: probes(),
        },
        metrics,
        atlas: geometry(cells.len()),
        layout,
        glyphs: cells.iter().map(Cell::to_glyph).collect(),
        content_hash: content_hash(&transformed, customization),
        pixels: pixels(&cells, weight),
    };
    let atlas = GlyphAtlasDescriptor::try_from(unchecked)
        .expect("the stand-in bakes a descriptor the baker could have produced");
    let run = CueRun::from_layout(atlas.layout());
    Staged {
        face: ResolvedFace {
            family,
            source: "sha256:0101010101010101010101010101010101010101010101010101010101010101"
                .to_owned(),
            weight,
        },
        atlas,
        run,
    }
}

/// One distinct cluster and the cell baked for it.
#[derive(Debug, Clone, PartialEq)]
struct Cell {
    cluster: String,
    advance_px: f64,
    direction: Direction,
    x_px: u32,
    y_px: u32,
    ink_px: u32,
}

impl Cell {
    fn to_glyph(&self) -> AtlasGlyph {
        let inked = self.ink_px > 0;
        AtlasGlyph {
            cluster: self.cluster.clone(),
            code_points: self.cluster.chars().map(u32::from).collect(),
            direction: self.direction,
            advance_width_px: self.advance_px,
            x_px: self.x_px,
            y_px: self.y_px,
            width_px: if inked { self.ink_px } else { 0 },
            height_px: if inked { CELL_PX } else { 0 },
            origin_x_px: 0,
            // The ink sits entirely above the baseline, so the cell's top is `baseline - height`.
            origin_y_px: if inked {
                i32::try_from(CELL_PX).unwrap_or(0)
            } else {
                0
            },
            substituted: false,
        }
    }
}

/// The distinct cells the run needs, in the baker's packing order.
fn distinct_cells(clusters: &[String], letter_spacing: f64, weight: u16) -> Vec<Cell> {
    let mut distinct: Vec<&str> = Vec::new();
    for cluster in clusters {
        if !distinct.contains(&cluster.as_str()) {
            distinct.push(cluster);
        }
    }
    distinct.sort_unstable_by(|left, right| utf16_order(left, right));
    distinct
        .into_iter()
        .enumerate()
        .map(|(index, cluster)| {
            let slot = u32::try_from(index).expect("a bounded cell count");
            let blank = cluster.chars().all(char::is_whitespace);
            Cell {
                cluster: cluster.to_owned(),
                advance_px: advance_of(cluster, letter_spacing),
                direction: direction_of(cluster),
                x_px: (slot % CELL_COLUMNS) * CELL_PX,
                y_px: (slot / CELL_COLUMNS) * CELL_PX,
                ink_px: if blank { 0 } else { ink_width(cluster, weight) },
            }
        })
        .collect()
}

/// One laid-out line, as cluster indices into the run's cluster list.
#[derive(Debug)]
struct Line {
    cells: Vec<usize>,
    justification_px: f64,
}

/// The wrap width one customization asks for, in atlas pixels.
fn wrap_width(customization: &SubtitleCustomization) -> Option<f64> {
    customization
        .word_wrap
        .then(|| round4((customization.max_width / 100.0) * WRAP_REFERENCE_PX).max(1.0))
}

/// Greedy line breaking at spaces, with trailing spaces trimmed off each line.
///
/// A word wider than the wrap width overflows onto its own line rather than being broken, which is
/// CSS `overflow-wrap: normal` and is what makes the matrix's long-word text a distinct case.
fn wrap(clusters: &[String], cells: &[Cell], customization: &SubtitleCustomization) -> Vec<Line> {
    let index_of = |cluster: &str| {
        cells
            .binary_search_by(|cell| utf16_order(&cell.cluster, cluster))
            .expect("every cluster has a cell")
    };
    let all: Vec<usize> = clusters.iter().map(|cluster| index_of(cluster)).collect();
    let Some(max_width) = wrap_width(customization) else {
        return vec![Line {
            cells: all,
            justification_px: 0.0,
        }];
    };

    let mut lines: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut width = 0.0_f64;
    for word in words(&all, cells) {
        let word_width: f64 = word.iter().map(|index| cells[*index].advance_px).sum();
        if !current.is_empty() && width + word_width > max_width {
            lines.push(std::mem::take(&mut current));
            width = 0.0;
        }
        current.extend_from_slice(&word);
        width += word_width;
    }
    if !current.is_empty() || lines.is_empty() {
        lines.push(current);
    }

    let justify = customization.text_align == TextAlign::Justify;
    let last = lines.len().saturating_sub(1);
    lines
        .into_iter()
        .enumerate()
        .map(|(index, mut cells_of_line)| {
            trim_trailing_blanks(&mut cells_of_line, cells);
            let placed = cells_of_line.len();
            let sum: f64 = cells_of_line
                .iter()
                .map(|slot| cells[*slot].advance_px)
                .sum();
            let justification_px = if justify && index != last && placed > 1 && sum < max_width {
                round4((max_width - sum) / (placed_gaps(placed)))
            } else {
                0.0
            };
            Line {
                cells: cells_of_line,
                justification_px,
            }
        })
        .collect()
}

/// How many interior gaps a line of `placed` cells has, as a divisor that is never zero.
fn placed_gaps(placed: usize) -> f64 {
    let gaps = u32::try_from(placed.saturating_sub(1)).unwrap_or(1).max(1);
    f64::from(gaps)
}

/// Splits a cluster list into words, each carrying its own trailing blanks.
fn words(all: &[usize], cells: &[Cell]) -> Vec<Vec<usize>> {
    let blank = |slot: &usize| cells[*slot].ink_px == 0;
    let mut words: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut in_blanks = false;
    for slot in all {
        if blank(slot) {
            in_blanks = true;
        } else if in_blanks {
            words.push(std::mem::take(&mut current));
            in_blanks = false;
        }
        current.push(*slot);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn trim_trailing_blanks(line: &mut Vec<usize>, cells: &[Cell]) {
    while line.last().is_some_and(|slot| cells[*slot].ink_px == 0) {
        line.pop();
    }
}

/// The line box and where the baseline sits in it, from the persisted line height.
fn line_box(customization: &SubtitleCustomization) -> (f64, f64) {
    let line_height_px = round4(ATLAS_FONT_SIZE_PX * customization.line_height);
    let half_leading = round4((line_height_px - ATLAS_FONT_SIZE_PX) / 2.0);
    (line_height_px, round4(ASCENT_PX + half_leading))
}

fn align_of(align: TextAlign) -> LayoutTextAlign {
    match align {
        TextAlign::Left => LayoutTextAlign::Left,
        TextAlign::Center => LayoutTextAlign::Center,
        TextAlign::Right => LayoutTextAlign::Right,
        TextAlign::Justify => LayoutTextAlign::Justify,
    }
}

/// The base direction the run is laid out in.
///
/// `rtlSupport` forces right-to-left whenever the text carries a right-to-left cluster, which is
/// the switch `src/platform/glyphAtlasBidi.js` owns; otherwise it is the run's first strong
/// cluster. A run with no strong cluster at all resolves left-to-right, as the baker's does.
fn base_direction(cells: &[Cell], customization: &SubtitleCustomization) -> Direction {
    let has_rtl = cells.iter().any(|cell| cell.direction == Direction::Rtl);
    if customization.rtl_support && has_rtl {
        return Direction::Rtl;
    }
    cells
        .iter()
        .find(|cell| cell.direction != Direction::Neutral)
        .map_or(Direction::Ltr, |cell| cell.direction)
}

fn layout(lines: &[Line], cells: &[Cell], customization: &SubtitleCustomization) -> AtlasLayout {
    let (line_height_px, baseline_px) = line_box(customization);
    let rtl = base_direction(cells, customization) == Direction::Rtl;
    let mut emitted: Vec<AtlasLine> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let mut slots = line.cells.clone();
        if rtl {
            // The stand-in for UAX #9: the baker's claim is that it emitted visual order, and this
            // reverses logical order to make that claim observable downstream.
            slots.reverse();
        }
        let mut pen = 0.0_f64;
        let mut pen_x_px = Vec::with_capacity(slots.len());
        for (position, slot) in slots.iter().enumerate() {
            let gaps = u32::try_from(position).unwrap_or(0);
            pen_x_px.push(round4(f64::from(gaps).mul_add(line.justification_px, pen)));
            pen += cells[*slot].advance_px;
        }
        let advance = round4(
            f64::from(u32::try_from(slots.len().saturating_sub(1)).unwrap_or(0))
                .mul_add(line.justification_px, pen),
        );
        let steps = u32::try_from(index).unwrap_or(0);
        emitted.push(AtlasLine {
            glyphs: slots
                .iter()
                .map(|slot| u32::try_from(*slot).expect("a bounded cell index"))
                .collect(),
            pen_x_px,
            advance_width_px: advance,
            measured_width_px: round4(pen),
            shaping_residual_px: 0.0,
            baseline_y_px: round4(f64::from(steps).mul_add(line_height_px, baseline_px)),
            justification_px: line.justification_px,
            ends_paragraph: index + 1 == lines.len(),
        });
    }
    let width_px = emitted
        .iter()
        .fold(0.0_f64, |widest, line| widest.max(line.advance_width_px));
    AtlasLayout {
        text_transform: transform_of(customization.text_transform),
        letter_spacing_px: customization.letter_spacing,
        max_width_px: wrap_width(customization),
        word_wrap: customization.word_wrap,
        text_align: align_of(customization.text_align),
        line_count: u32::try_from(emitted.len()).expect("a bounded line count"),
        width_px,
        height_px: round4(f64::from(u32::try_from(emitted.len()).unwrap_or(1)) * line_height_px),
        cell_advance_layout: CellAdvanceVerdict::Reproduces,
        refusal: LayoutRefusal {
            shaping_crosses_clusters: false,
            direction_needs_bidi: false,
        },
        lines: emitted,
    }
}

const fn transform_of(transform: TextTransform) -> osg_scene::glyph::TextTransform {
    match transform {
        TextTransform::None => osg_scene::glyph::TextTransform::None,
        TextTransform::Uppercase => osg_scene::glyph::TextTransform::Uppercase,
        TextTransform::Lowercase => osg_scene::glyph::TextTransform::Lowercase,
        TextTransform::Capitalize => osg_scene::glyph::TextTransform::Capitalize,
    }
}

fn metrics(
    cells: &[Cell],
    clusters: &[String],
    customization: &SubtitleCustomization,
) -> AtlasMetrics {
    let (line_height_px, baseline_px) = line_box(customization);
    let run_advance_width_px: f64 = clusters
        .iter()
        .map(|cluster| advance_of(cluster, customization.letter_spacing))
        .sum();
    AtlasMetrics {
        ascent_px: ASCENT_PX,
        descent_px: DESCENT_PX,
        line_height_px,
        baseline_px,
        run_advance_width_px: round4(run_advance_width_px),
        shaping_residual_px: 0.0,
        base_direction: base_direction(cells, customization),
        letter_spacing_px: customization.letter_spacing,
    }
}

fn probes() -> Vec<FaceProbe> {
    [
        (ProbeFamily::Monospace, 100.0, 120.0),
        (ProbeFamily::Serif, 90.0, 90.0),
        (ProbeFamily::SansSerif, 95.0, 110.0),
    ]
    .into_iter()
    .map(
        |(probe_family, alone_width_px, chained_width_px)| FaceProbe {
            probe_family,
            alone_width_px,
            chained_width_px,
            participated: alone_width_px.to_bits() != chained_width_px.to_bits(),
        },
    )
    .collect()
}

fn rows(cell_count: usize) -> u32 {
    let cells = u32::try_from(cell_count).expect("a bounded cell count");
    cells.div_ceil(CELL_COLUMNS).max(1)
}

fn geometry(cell_count: usize) -> AtlasGeometry {
    AtlasGeometry {
        width_px: CELL_COLUMNS * CELL_PX,
        height_px: rows(cell_count) * CELL_PX,
        padding_px: 0,
        glyph_count: u32::try_from(cell_count).expect("a bounded cell count"),
        pixel_format: PixelFormat::Rgba8,
        bytes_per_row: CELL_COLUMNS * CELL_PX * 4,
    }
}

/// Coverage for every cell: a per-cluster pattern, so two clusters never rasterize alike.
fn pixels(cells: &[Cell], weight: u16) -> Vec<u8> {
    let width = CELL_COLUMNS * CELL_PX;
    let height = rows(cells.len()) * CELL_PX;
    let stride = width * 4;
    let mut buffer = vec![0_u8; (height * stride) as usize];
    for cell in cells {
        if cell.ink_px == 0 {
            continue;
        }
        let seed = cell.cluster.chars().next().map_or(0, u32::from) + u32::from(weight);
        for row in 0..CELL_PX {
            for column in 0..cell.ink_px {
                // Deterministic, cluster-dependent and never fully transparent, so a cell that is
                // drawn always reaches the frame.
                let coverage =
                    u8::try_from(128 + ((seed + row * 7 + column * 13) % 128)).unwrap_or(u8::MAX);
                let x = cell.x_px + column;
                let y = cell.y_px + row;
                let start = (y * stride + x * 4) as usize;
                buffer[start..start + 4].copy_from_slice(&[coverage; 4]);
            }
        }
    }
    buffer
}

/// The baker's cache key: eight lower-case hexadecimal digits over everything that was baked.
fn content_hash(text: &str, customization: &SubtitleCustomization) -> String {
    let mut hash = 0x811c_9dc5_u32;
    let mut absorb = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
    };
    absorb(text.as_bytes());
    absorb(customization.font_family.as_bytes());
    absorb(&customization.font_weight.to_le_bytes());
    absorb(&customization.letter_spacing.to_le_bytes());
    absorb(&customization.line_height.to_le_bytes());
    absorb(&customization.max_width.to_le_bytes());
    format!("{hash:08x}")
}
