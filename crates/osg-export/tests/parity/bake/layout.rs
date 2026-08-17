//! The layout half of the stand-in bake: wrapping, direction, alignment and the emitted lines.
//!
//! Split from the descriptor assembly beside it because the two answer different questions. This
//! module answers "where does each cell go" — the part `src/platform/glyphAtlasShaping.js` owns and
//! this one stands in for, including the two decisions that reach further than they look: the base
//! direction `rtlSupport` forces, and the alignment CSS resolves against it. `super` answers "what
//! does a descriptor carrying those positions look like", which is the contract
//! `osg_scene::glyph` validates.

use osg_render::{SubtitleCustomization, TextAlign, TextTransform};
use osg_scene::glyph::{
    AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict, Direction, LayoutRefusal,
    LayoutTextAlign,
};

use super::text::{advance_of, round4, utf16_order};
use super::{ASCENT_PX, ATLAS_FONT_SIZE_PX, Cell, DESCENT_PX, WRAP_REFERENCE_PX};

/// One laid-out line, as cluster indices into the run's cluster list.
#[derive(Debug)]
pub(super) struct Line {
    cells: Vec<usize>,
    justification_px: f64,
}

/// The wrap width one customization asks for, in atlas pixels.
pub(super) fn wrap_width(customization: &SubtitleCustomization) -> Option<f64> {
    customization
        .word_wrap
        .then(|| round4((customization.max_width / 100.0) * WRAP_REFERENCE_PX).max(1.0))
}

/// Greedy line breaking at spaces, with trailing spaces trimmed off each line.
///
/// A word wider than the wrap width overflows onto its own line rather than being broken, which is
/// CSS `overflow-wrap: normal` and is what makes the matrix's long-word text a distinct case.
pub(super) fn wrap(
    clusters: &[String],
    cells: &[Cell],
    customization: &SubtitleCustomization,
) -> Vec<Line> {
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

/// CSS `text-align` resolved against the paragraph's own direction.
///
/// `src/platform/glyphAtlasShaping.js` emits `textAlign: paragraphLevel === 1 && textAlign === 'left'
/// ? 'right' : textAlign`, because CSS resolves the *start* edge against the paragraph direction and
/// only the side that ran the bidi pass knows what that direction was. The compositor places by this
/// resolved value and never by the persisted one — see `run_align` in `osg-compositor` — and the
/// baker opens one atlas page per resolved alignment, so this is also what decides whether a
/// document mixing directions is one page or two.
const fn resolved_align(align: TextAlign, rtl: bool) -> LayoutTextAlign {
    match (align, rtl) {
        (TextAlign::Left, false) => LayoutTextAlign::Left,
        (TextAlign::Left | TextAlign::Right, true) | (TextAlign::Right, false) => {
            LayoutTextAlign::Right
        }
        (TextAlign::Center, _) => LayoutTextAlign::Center,
        (TextAlign::Justify, _) => LayoutTextAlign::Justify,
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

pub(super) fn layout(
    lines: &[Line],
    cells: &[Cell],
    customization: &SubtitleCustomization,
) -> AtlasLayout {
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
        text_align: resolved_align(customization.text_align, rtl),
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

pub(super) fn metrics(
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
