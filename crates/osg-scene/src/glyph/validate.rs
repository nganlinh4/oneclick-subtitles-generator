//! Validation
//!
//! Every bound the baker enforces on the way out is enforced again here, and every field the baker
//! derived from another field is re-derived and compared. This is the only place a descriptor is
//! judged; [`super::wire`] carries shape alone.

use core::cmp::Ordering;

use super::error::GlyphAtlasError;
use super::limits::{
    CONTENT_HASH_DIGITS, GLYPH_ATLAS_VERSION, MAX_ATLAS_CODE_POINTS, MAX_ATLAS_DIMENSION_PX,
    MAX_BYTES_PER_ROW, MAX_CELL_CODE_POINTS, MAX_CSS_FONT_BYTES, MAX_FACE_PROBES,
    MAX_FAMILY_CHARACTERS, MAX_FONT_SIZE_PX, MAX_GLYPH_COUNT, MAX_PADDING_PX, MIN_FONT_SIZE_PX,
};
use super::validate_layout::validate_layout;
use super::wire::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasMetrics, Direction, FaceProbe, UncheckedGlyphAtlas,
};

pub(super) fn validate(atlas: &UncheckedGlyphAtlas) -> Result<(), GlyphAtlasError> {
    // First and alone: a field's meaning is defined by the version, so an unknown one is refused
    // before anything else is looked at rather than read as far as it happens to parse.
    if atlas.version != GLYPH_ATLAS_VERSION {
        return Err(GlyphAtlasError::UnsupportedVersion);
    }
    validate_face(&atlas.face)?;
    validate_metrics(&atlas.metrics)?;
    validate_geometry(&atlas.atlas)?;
    validate_glyphs(&atlas.glyphs, &atlas.atlas)?;
    // After the cells, because the layout's indices are only meaningful once the cells they index
    // are known to be a list this build accepts.
    validate_layout(&atlas.layout, &atlas.metrics, atlas.glyphs.len())?;
    validate_agreements(atlas)
}

/// The family shape the baker accepts: alphanumeric first, then alphanumerics, space, dot,
/// underscore or hyphen. Rust's `is_alphanumeric` is a superset of the baker's `\p{L}\p{N}`, so
/// nothing the baker emits is refused here.
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

fn validate_face(face: &AtlasFace) -> Result<(), GlyphAtlasError> {
    if !is_supported_family(&face.requested_family) || !matches!(face.weight, 1..=1_000) {
        return Err(GlyphAtlasError::UnsupportedFace);
    }
    // The shorthand is never parsed here, only bounded and kept loggable, and it must still name
    // the family it claims to have measured.
    if face.css_font.is_empty()
        || face.css_font.len() > MAX_CSS_FONT_BYTES
        || face.css_font.chars().any(char::is_control)
        || !face
            .css_font
            .contains(&format!("\"{}\"", face.requested_family))
    {
        return Err(GlyphAtlasError::UnsupportedFace);
    }
    if !face.font_size_px.is_finite()
        || !(MIN_FONT_SIZE_PX..=MAX_FONT_SIZE_PX).contains(&face.font_size_px)
    {
        return Err(GlyphAtlasError::UnsupportedFontSize);
    }
    validate_probes(&face.probes)
}

fn validate_probes(probes: &[FaceProbe]) -> Result<(), GlyphAtlasError> {
    // Substitution is only detectable when all three independent generics were measured; fewer
    // probes would make the descriptor's own claim weaker than it looks.
    if probes.len() != MAX_FACE_PROBES {
        return Err(GlyphAtlasError::UnsupportedProbes);
    }
    for (index, probe) in probes.iter().enumerate() {
        if probes[..index]
            .iter()
            .any(|earlier| earlier.probe_family == probe.probe_family)
        {
            return Err(GlyphAtlasError::UnsupportedProbes);
        }
        if !probe.alone_width_px.is_finite()
            || probe.alone_width_px < 0.0
            || !probe.chained_width_px.is_finite()
            || probe.chained_width_px < 0.0
        {
            return Err(GlyphAtlasError::UnsupportedProbes);
        }
        #[expect(
            clippy::float_cmp,
            reason = "re-derives the baker's own exact comparison of two 4dp-rounded widths"
        )]
        let differs = probe.alone_width_px != probe.chained_width_px;
        if differs != probe.participated {
            return Err(GlyphAtlasError::DerivedFieldMismatch);
        }
    }
    // Every chain matching its generic is exactly how the baker detects an absent face, and it
    // refuses to bake one. A descriptor claiming otherwise did not come from a bake.
    if !probes.iter().any(|probe| probe.participated) {
        return Err(GlyphAtlasError::UnsupportedProbes);
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
    // The residual and the letter spacing are the two signed metrics: one is a difference, the
    // other tightens as well as loosens, so both are checked for finiteness rather than for sign.
    // The letter spacing's own range is checked with the rest of the layout it belongs to.
    if non_negative
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
        || !metrics.shaping_residual_px.is_finite()
        || !metrics.letter_spacing_px.is_finite()
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
    if geometry.width_px > MAX_ATLAS_DIMENSION_PX || geometry.height_px > MAX_ATLAS_DIMENSION_PX {
        return Err(GlyphAtlasError::UnsupportedAtlasSize);
    }
    if geometry.padding_px > MAX_PADDING_PX {
        return Err(GlyphAtlasError::UnsupportedPadding);
    }
    // Bounding the stride is what keeps the pixel buffer bounded: its length is checked against
    // height times stride, so an unbounded stride would licence an unbounded buffer.
    if u64::from(geometry.bytes_per_row) < u64::from(geometry.width_px) * 4
        || geometry.bytes_per_row > MAX_BYTES_PER_ROW
        || !geometry.bytes_per_row.is_multiple_of(4)
    {
        return Err(GlyphAtlasError::UnsupportedRowStride);
    }
    if usize::try_from(geometry.glyph_count).unwrap_or(usize::MAX) > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    Ok(())
}

fn validate_glyphs(glyphs: &[AtlasGlyph], geometry: &AtlasGeometry) -> Result<(), GlyphAtlasError> {
    if glyphs.len() > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    let mut total_code_points = 0_usize;
    let mut previous: Option<&AtlasGlyph> = None;
    for glyph in glyphs {
        if glyph.cluster.is_empty()
            || glyph.code_points.is_empty()
            || glyph.code_points.len() > MAX_CELL_CODE_POINTS
            || !glyph
                .cluster
                .chars()
                .map(u32::from)
                .eq(glyph.code_points.iter().copied())
            || !glyph.advance_width_px.is_finite()
            || glyph.advance_width_px < 0.0
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
        // The baker sorts distinct cells by UTF-16 code unit, then by direction, then by advance,
        // which is what makes the same cell set pack to the same atlas. Comparing the same way keeps
        // astral text in the order the baker put it, and strictness rejects a cell that duplicates
        // another in all three.
        //
        // WHY THE KEY IS A TRIPLE AND NOT THE TEXT ALONE. A cell is a whole shaped line, and one
        // line's text can legitimately appear twice in a document with a different picture each
        // time: once in a right-to-left paragraph and once in a left-to-right one, or once
        // justified to fill the wrap width and once as the last line of its block. Those are
        // different rasters with different advances, so keying on the text alone would force the
        // atlas to describe one of them as the other — which is exactly the "two measurements of
        // one line" failure the line mask exists to remove.
        if let Some(previous) = previous
            && previous
                .cluster
                .encode_utf16()
                .cmp(glyph.cluster.encode_utf16())
                .then_with(|| previous.direction.cmp(&glyph.direction))
                .then_with(|| {
                    previous
                        .advance_width_px
                        .to_bits()
                        .cmp(&glyph.advance_width_px.to_bits())
                })
                != Ordering::Less
        {
            return Err(GlyphAtlasError::UnorderedGlyphs);
        }
        previous = Some(glyph);
        total_code_points += glyph.code_points.len();
    }
    // A page carries the distinct lines of many cues, so this is a bound of its own rather than one
    // the run's length gives for free.
    if total_code_points > MAX_ATLAS_CODE_POINTS {
        return Err(GlyphAtlasError::UnsupportedTextLength);
    }
    Ok(())
}

fn validate_agreements(atlas: &UncheckedGlyphAtlas) -> Result<(), GlyphAtlasError> {
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
    let declared = u64::from(atlas.atlas.height_px) * u64::from(atlas.atlas.bytes_per_row);
    if declared != u64::try_from(atlas.pixels.len()).unwrap_or(u64::MAX) {
        return Err(GlyphAtlasError::PixelBufferMismatch);
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
