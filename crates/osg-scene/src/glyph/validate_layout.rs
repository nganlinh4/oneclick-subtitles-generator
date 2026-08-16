//! Judging the layout.
//!
//! The layout is the one thing the compositor does not re-derive, so it is the one thing that has
//! to be checked hardest: every number a consumer will place a glyph from is bounded here — by
//! **magnitude**, at [`MAX_LAYOUT_COORDINATE_PX`], which is the bound `glyphAtlasStaging.js`
//! applies to the very same fields — every index is proven to address a cell that exists, and every
//! field the baker derived from another is re-derived and compared.
//!
//! Finiteness alone was never the bound. A consumer scales these coordinates before it places
//! anything: `osg-compositor` multiplies each line's advance by the glyph scale, takes the widest
//! as the run's text width, and offsets a centred line by `text_width - line_width`. A finite
//! `f64::MAX` advance scaled by anything above one is infinity, that subtraction is then
//! `inf - inf`, and every vertex on the line comes out `NaN` — from a descriptor whose every number
//! passed `is_finite`. Bounding the magnitude closes that path here, where the descriptor is still
//! refusable, rather than in the consumer that can only draw what it was handed.
//!
//! The face metrics a consumer stacks lines by are bounded by the same numbers rather than
//! separately: a line box is only accepted if the baselines advance by it and the run box is that
//! many line boxes tall, and both of those are bounded above. A layout with no lines bounds neither,
//! and places nothing.
//!
//! What is deliberately **not** re-derived is [`LayoutRefusal::direction_needs_bidi`]. The baker
//! clearing it is the claim that it emitted visual order, and this side has no font stack with
//! which to second-guess that claim. Re-deriving it from cell directions would refuse exactly the
//! runs the baker learned to reorder.

use super::error::GlyphAtlasError;
use super::layout::{AtlasLayout, CellAdvanceVerdict, LayoutTextAlign};
use super::limits::{
    LAYOUT_TOLERANCE_PX, MAX_LAYOUT_CELLS, MAX_LAYOUT_COORDINATE_PX, MAX_LAYOUT_LINES,
    MAX_LAYOUT_WIDTH_PX, MAX_LETTER_SPACING_PX, MIN_LETTER_SPACING_PX,
};
use super::wire::AtlasMetrics;

/// Whether a value this side recomputed agrees with the four-decimal one the baker emitted.
fn agrees(derived: f64, declared: f64) -> bool {
    (derived - declared).abs() <= LAYOUT_TOLERANCE_PX
}

/// Whether a coordinate is one a consumer can place a glyph from: finite, and small enough that
/// scaling it cannot leave the finite numbers.
///
/// Signed on purpose. A pen sits left of its own line start whenever letter spacing tightens, and
/// an advance goes with it, so this is a magnitude and never a range.
fn places_a_glyph(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_LAYOUT_COORDINATE_PX
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
    // The run box a consumer sizes from: neither edge may be negative, and neither may be a
    // magnitude a consumer's own scaling would carry out of the finite numbers, whatever the lines
    // below turn out to say.
    if !places_a_glyph(layout.width_px)
        || layout.width_px < 0.0
        || !places_a_glyph(layout.height_px)
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
        if line.pen_x_px.iter().any(|pen| !places_a_glyph(*pen)) {
            return Err(GlyphAtlasError::UnsupportedLayout);
        }
        // Every number on this line is one the compositor scales and places from, so every one of
        // them is bounded by magnitude. The advance and the residual are signed — tight letter
        // spacing can pull a line narrower than nothing — while the measured width and the
        // justification are widths and cannot be negative on top of that.
        if !places_a_glyph(line.advance_width_px)
            || !places_a_glyph(line.shaping_residual_px)
            || !places_a_glyph(line.measured_width_px)
            || line.measured_width_px < 0.0
            || !places_a_glyph(line.justification_px)
            || line.justification_px < 0.0
            || !places_a_glyph(line.baseline_y_px)
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
