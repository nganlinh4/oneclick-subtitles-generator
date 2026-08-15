//! Validation
//!
//! Mirrors `osg_scene::glyph`'s own checks for the fields the staged frame carries. The baker
//! enforces these on the way out, but nothing guarantees the bytes arriving here came from the
//! baker, so every bound is enforced again on this side.

use std::cmp::Ordering;

use osg_scene::glyph::{
    AtlasGeometry, AtlasMetrics, CONTENT_HASH_DIGITS, Direction, GLYPH_ATLAS_VERSION,
    GlyphAtlasError, MAX_ATLAS_DIMENSION_PX, MAX_CLUSTER_CODE_POINTS, MAX_FAMILY_CHARACTERS,
    MAX_FONT_SIZE_PX, MAX_GLYPH_COUNT, MAX_PADDING_PX, MAX_TEXT_CODE_POINTS, MIN_FONT_SIZE_PX,
};

use super::{StagedFace, StagedGlyph, UncheckedStagedAtlas};

pub(super) fn validate(atlas: &UncheckedStagedAtlas) -> Result<(), GlyphAtlasError> {
    // First and alone: a field's meaning is defined by the descriptor version, so an unknown one is
    // refused before anything else is looked at.
    if atlas.atlas_version != GLYPH_ATLAS_VERSION {
        return Err(GlyphAtlasError::UnsupportedVersion);
    }
    validate_face(&atlas.face)?;
    validate_metrics(&atlas.metrics)?;
    validate_geometry(&atlas.atlas)?;
    validate_glyphs(&atlas.glyphs, &atlas.atlas)?;
    validate_agreements(atlas)
}

/// The family shape the baker accepts: alphanumeric first, then alphanumerics, space, dot,
/// underscore or hyphen. Mirrors `osg_scene::glyph`'s own predicate, which is a superset of the
/// baker's `\p{L}\p{N}`, so nothing the baker emits is refused here.
fn is_supported_family(family: &str) -> bool {
    let mut characters = family.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_alphanumeric()
        && family.encode_utf16().count() <= MAX_FAMILY_CHARACTERS
        && family.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, ' ' | '.' | '_' | '-')
        })
}

fn validate_face(face: &StagedFace) -> Result<(), GlyphAtlasError> {
    if !is_supported_family(&face.requested_family) || !matches!(face.weight, 1..=1_000) {
        return Err(GlyphAtlasError::UnsupportedFace);
    }
    if !face.font_size_px.is_finite()
        || !(MIN_FONT_SIZE_PX..=MAX_FONT_SIZE_PX).contains(&face.font_size_px)
    {
        return Err(GlyphAtlasError::UnsupportedFontSize);
    }
    Ok(())
}

fn validate_metrics(metrics: &AtlasMetrics) -> Result<(), GlyphAtlasError> {
    let non_negative = [
        metrics.ascent_px,
        metrics.descent_px,
        metrics.line_height_px,
        metrics.baseline_px,
        metrics.run_advance_width_px,
    ];
    if non_negative
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
        || !metrics.shaping_residual_px.is_finite()
    {
        return Err(GlyphAtlasError::UnsupportedMetrics);
    }
    // The baker resolves a run with no strong character to left-to-right, so a neutral base
    // direction is not something it can emit.
    if metrics.base_direction == Direction::Neutral {
        return Err(GlyphAtlasError::UnsupportedDirection);
    }
    Ok(())
}

fn validate_geometry(geometry: &AtlasGeometry) -> Result<(), GlyphAtlasError> {
    if geometry.width_px > MAX_ATLAS_DIMENSION_PX
        || geometry.height_px > MAX_ATLAS_DIMENSION_PX
        // An inkless run packs to 0x0. Half a dimension is never a valid atlas.
        || (geometry.width_px == 0) != (geometry.height_px == 0)
    {
        return Err(GlyphAtlasError::UnsupportedAtlasSize);
    }
    if geometry.padding_px > MAX_PADDING_PX {
        return Err(GlyphAtlasError::UnsupportedPadding);
    }
    // The staged frame is tightly packed by construction, so the stride is not merely bounded here
    // as it is in the descriptor: it is pinned to one row. That is what lets the body length be
    // cross-checked against the declared atlas alone.
    if geometry.bytes_per_row != geometry.width_px.saturating_mul(4) {
        return Err(GlyphAtlasError::UnsupportedRowStride);
    }
    if usize::try_from(geometry.glyph_count).unwrap_or(usize::MAX) > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    Ok(())
}

fn validate_glyphs(
    glyphs: &[StagedGlyph],
    geometry: &AtlasGeometry,
) -> Result<(), GlyphAtlasError> {
    if glyphs.len() > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    let mut total_code_points = 0_usize;
    let mut previous: Option<&str> = None;
    for glyph in glyphs {
        // The wire omits `codePoints` and this is where they come back: derived from the cluster
        // itself, so the two identities cannot come apart the way a second encoding could.
        let code_points = glyph.cluster.chars().count();
        if code_points == 0
            || code_points > MAX_CLUSTER_CODE_POINTS
            || !glyph.advance_width_px.is_finite()
            || glyph.advance_width_px < 0.0
            || glyph.origin_x_px.unsigned_abs() > MAX_ATLAS_DIMENSION_PX
            || glyph.origin_y_px.unsigned_abs() > MAX_ATLAS_DIMENSION_PX
        {
            return Err(GlyphAtlasError::UnsupportedCluster);
        }
        // Widened before adding: a cell that would wrap around the addressable range must fail as
        // an out-of-atlas cell, not as an in-range sum.
        if u64::from(glyph.x_px) + u64::from(glyph.width_px) > u64::from(geometry.width_px)
            || u64::from(glyph.y_px) + u64::from(glyph.height_px) > u64::from(geometry.height_px)
        {
            return Err(GlyphAtlasError::GlyphOutsideAtlas);
        }
        // The baker sorts distinct clusters by UTF-16 code unit, which is what makes the same glyph
        // set pack to the same atlas. Comparing the same way keeps astral clusters in the order the
        // baker put them, and strictness rejects a duplicated cell.
        if let Some(previous) = previous
            && previous.encode_utf16().cmp(glyph.cluster.encode_utf16()) != Ordering::Less
        {
            return Err(GlyphAtlasError::UnorderedGlyphs);
        }
        previous = Some(&glyph.cluster);
        total_code_points += code_points;
    }
    // The clusters are the run's distinct graphemes, so their code points cannot outnumber the
    // run's own — which is the bound the baker enforces on the text.
    if total_code_points > MAX_TEXT_CODE_POINTS {
        return Err(GlyphAtlasError::UnsupportedTextLength);
    }
    Ok(())
}

fn validate_agreements(atlas: &UncheckedStagedAtlas) -> Result<(), GlyphAtlasError> {
    if usize::try_from(atlas.atlas.glyph_count).unwrap_or(usize::MAX) != atlas.glyphs.len() {
        return Err(GlyphAtlasError::GlyphCountMismatch);
    }
    if atlas.face.substituted != atlas.glyphs.iter().any(|glyph| glyph.substituted) {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    // A right-to-left base direction is the first strong cluster in the run, and every cluster in
    // the run has a cell, so at least one cell must be right-to-left too.
    if atlas.metrics.base_direction == Direction::Rtl
        && !atlas
            .glyphs
            .iter()
            .any(|glyph| glyph.direction == Direction::Rtl)
    {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    if atlas.content_hash.len() != CONTENT_HASH_DIGITS
        || !atlas
            .content_hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(GlyphAtlasError::UnsupportedContentHash);
    }
    Ok(())
}
