//! Judging the layout.
//!
//! The layout is the one thing the compositor does not re-derive, so it is the one thing that has
//! to be checked hardest: every number a consumer will place a glyph from is bounded here, every
//! index is proven to address a cell that exists, and every field the baker derived from another is
//! re-derived and compared.
//!
//! What is deliberately **not** re-derived is [`LayoutRefusal::direction_needs_bidi`]. The baker
//! clearing it is the claim that it emitted visual order, and this side has no font stack with
//! which to second-guess that claim. Re-deriving it from cell directions would refuse exactly the
//! runs the baker learned to reorder.

use super::error::GlyphAtlasError;
use super::layout::{AtlasLayout, CellAdvanceVerdict, LayoutTextAlign};
use super::limits::{
    LAYOUT_TOLERANCE_PX, MAX_LAYOUT_CELLS, MAX_LAYOUT_LINES, MAX_LAYOUT_WIDTH_PX,
    MAX_LETTER_SPACING_PX, MIN_LETTER_SPACING_PX,
};
use super::wire::AtlasMetrics;

/// Whether a value this side recomputed agrees with the four-decimal one the baker emitted.
fn agrees(derived: f64, declared: f64) -> bool {
    (derived - declared).abs() <= LAYOUT_TOLERANCE_PX
}

pub(super) fn validate_layout(
    layout: &AtlasLayout,
    metrics: &AtlasMetrics,
    cell_count: usize,
) -> Result<(), GlyphAtlasError> {
    validate_layout_numbers(layout)?;
    validate_lines(layout, metrics, cell_count)?;
    validate_layout_agreements(layout, metrics)
}

fn validate_layout_numbers(layout: &AtlasLayout) -> Result<(), GlyphAtlasError> {
    if !layout.letter_spacing_px.is_finite()
        || !(MIN_LETTER_SPACING_PX..=MAX_LETTER_SPACING_PX).contains(&layout.letter_spacing_px)
    {
        return Err(GlyphAtlasError::UnsupportedLetterSpacing);
    }
    if let Some(max_width_px) = layout.max_width_px
        && (!max_width_px.is_finite() || max_width_px <= 0.0 || max_width_px > MAX_LAYOUT_WIDTH_PX)
    {
        return Err(GlyphAtlasError::UnsupportedLayoutWidth);
    }
    // The run box a consumer sizes from: neither edge may be non-finite or negative, whatever the
    // lines below turn out to say.
    if !layout.width_px.is_finite()
        || layout.width_px < 0.0
        || !layout.height_px.is_finite()
        || layout.height_px < 0.0
    {
        return Err(GlyphAtlasError::UnsupportedLayout);
    }
    if layout.lines.len() > MAX_LAYOUT_LINES {
        return Err(GlyphAtlasError::UnsupportedLayoutSize);
    }
    Ok(())
}

fn validate_lines(
    layout: &AtlasLayout,
    metrics: &AtlasMetrics,
    cell_count: usize,
) -> Result<(), GlyphAtlasError> {
    let mut placed = 0_usize;
    let mut previous_baseline: Option<f64> = None;
    for line in &layout.lines {
        // A pen per cell, or the consumer would have to invent one — which is the whole thing this
        // contract removes.
        if line.pen_x_px.len() != line.glyphs.len() {
            return Err(GlyphAtlasError::UnsupportedLayout);
        }
        placed = placed
            .checked_add(line.glyphs.len())
            .ok_or(GlyphAtlasError::UnsupportedLayoutSize)?;
        if placed > MAX_LAYOUT_CELLS {
            return Err(GlyphAtlasError::UnsupportedLayoutSize);
        }
        for index in &line.glyphs {
            if usize::try_from(*index).is_ok_and(|index| index < cell_count) {
                continue;
            }
            return Err(GlyphAtlasError::LayoutCellIndex);
        }
        if line.pen_x_px.iter().any(|pen| !pen.is_finite()) {
            return Err(GlyphAtlasError::UnsupportedLayout);
        }
        // The advance is signed — tight letter spacing can pull a line narrower than nothing — so
        // only a non-finite one is meaningless. The measured width and the justification are
        // widths, and cannot be negative.
        if !line.advance_width_px.is_finite()
            || !line.shaping_residual_px.is_finite()
            || !line.measured_width_px.is_finite()
            || line.measured_width_px < 0.0
            || !line.justification_px.is_finite()
            || line.justification_px < 0.0
            || !line.baseline_y_px.is_finite()
        {
            return Err(GlyphAtlasError::UnsupportedLayout);
        }
        // Only `justify` grows a gap, so a justification on any other alignment is a layout whose
        // pen positions do not follow from what it says it did.
        if layout.text_align != LayoutTextAlign::Justify && line.justification_px != 0.0 {
            return Err(GlyphAtlasError::DerivedFieldMismatch);
        }
        // Baselines are what a consumer stacks lines from, and it adds nothing of its own, so they
        // must both advance and advance by the line box the metrics declare.
        if let Some(previous) = previous_baseline {
            if line.baseline_y_px <= previous {
                return Err(GlyphAtlasError::UnorderedLayoutBaselines);
            }
            if !agrees(line.baseline_y_px - previous, metrics.line_height_px) {
                return Err(GlyphAtlasError::DerivedFieldMismatch);
            }
        } else if !agrees(line.baseline_y_px, metrics.baseline_px) {
            return Err(GlyphAtlasError::DerivedFieldMismatch);
        }
        previous_baseline = Some(line.baseline_y_px);
    }
    Ok(())
}

fn validate_layout_agreements(
    layout: &AtlasLayout,
    metrics: &AtlasMetrics,
) -> Result<(), GlyphAtlasError> {
    if usize::try_from(layout.line_count).unwrap_or(usize::MAX) != layout.lines.len() {
        return Err(GlyphAtlasError::LayoutLineCountMismatch);
    }
    #[expect(
        clippy::float_cmp,
        reason = "re-derives the baker's own selection of one emitted value, not an arithmetic"
    )]
    let widest_agrees = layout.width_px
        == layout
            .lines
            .iter()
            .fold(0.0_f64, |widest, line| widest.max(line.advance_width_px));
    if !widest_agrees {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    let lines = u32::try_from(layout.lines.len()).unwrap_or(u32::MAX);
    if !agrees(f64::from(lines) * metrics.line_height_px, layout.height_px) {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    // The baker rounds every residual to four decimals and normalises negative zero, so any value
    // that is not zero is one it measured.
    let shaping_crosses_clusters = metrics.shaping_residual_px != 0.0
        || layout
            .lines
            .iter()
            .any(|line| line.shaping_residual_px != 0.0);
    if shaping_crosses_clusters != layout.refusal.shaping_crosses_clusters {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    // The verdict is the disjunction of its own reasons. Nothing else may make it either way: a
    // layout that refuses without a reason, or gives a reason and calls itself usable, did not come
    // from the baker.
    let refused = layout.refusal.shaping_crosses_clusters || layout.refusal.direction_needs_bidi;
    if refused != (layout.cell_advance_layout == CellAdvanceVerdict::Refused) {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    #[expect(
        clippy::float_cmp,
        reason = "both fields carry the same four-decimal rounding of the same input"
    )]
    let spacing_agrees = layout.letter_spacing_px == metrics.letter_spacing_px;
    if spacing_agrees {
        Ok(())
    } else {
        Err(GlyphAtlasError::DerivedFieldMismatch)
    }
}
