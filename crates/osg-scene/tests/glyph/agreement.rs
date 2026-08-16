//! What only the receiving side can check: that the cells address the atlas, that they are in the
//! baker's order, and that every field derived from another still agrees with it.

use osg_scene::glyph::{
    AtlasGlyph, CONTENT_HASH_DIGITS, Direction, GlyphAtlasDescriptor, GlyphAtlasError, ProbeFamily,
};

use super::support::{accept, glyph, inkless, refuse, valid, with_cells};

#[test]
fn the_declared_cell_count_must_match_the_cells() {
    for count in [0, 1, 3] {
        assert_eq!(
            refuse(|atlas| atlas.atlas.glyph_count = count),
            GlyphAtlasError::GlyphCountMismatch,
            "{count}"
        );
    }
}

#[test]
fn a_cell_outside_the_atlas_is_refused() {
    for (x_px, y_px, width_px, height_px) in [
        (9, 0, 8, 12),
        (0, 5, 8, 12),
        (u32::MAX, 0, 8, 12),
        (0, 0, 17, 12),
        (0, u32::MAX, 8, 12),
    ] {
        assert_eq!(
            refuse(|atlas| {
                atlas.glyphs[1] = AtlasGlyph {
                    x_px,
                    y_px,
                    width_px,
                    height_px,
                    ..glyph("b", x_px)
                };
            }),
            GlyphAtlasError::GlyphOutsideAtlas,
            "{x_px},{y_px} {width_px}x{height_px}"
        );
    }
}

#[test]
fn code_points_must_still_match_their_cluster() {
    for code_points in [vec![], vec![0x41, 0x41], vec![0x42]] {
        assert_eq!(
            refuse(|atlas| atlas.glyphs[0].code_points = code_points),
            GlyphAtlasError::UnsupportedCluster
        );
    }
    assert_eq!(
        refuse(|atlas| atlas.glyphs[0].cluster = String::new()),
        GlyphAtlasError::UnsupportedCluster
    );
    for advance in [-0.1, f64::NAN, f64::INFINITY] {
        assert_eq!(
            refuse(|atlas| atlas.glyphs[0].advance_width_px = advance),
            GlyphAtlasError::UnsupportedCluster,
            "{advance}"
        );
    }
}

#[test]
fn cells_must_be_distinct_and_in_the_bakers_order() {
    assert_eq!(
        refuse(|atlas| atlas.glyphs = vec![glyph("b", 0), glyph("A", 8)]),
        GlyphAtlasError::UnorderedGlyphs
    );
    assert_eq!(
        refuse(|atlas| atlas.glyphs = vec![glyph("A", 0), glyph("A", 8)]),
        GlyphAtlasError::UnorderedGlyphs
    );
    // The baker sorts by UTF-16 code unit, so an astral cluster sorts below the private use area
    // rather than above it. Sorting by code point here would refuse a descriptor it emitted.
    let astral = accept(|atlas| {
        with_cells(atlas, vec![inkless("\u{1f600}"), inkless("\u{f8ff}")]);
    });
    assert_eq!(astral.glyphs().len(), 2);
}

#[test]
fn derived_fields_must_still_agree_with_what_they_were_derived_from() {
    assert_eq!(
        refuse(|atlas| atlas.face.substituted = true),
        GlyphAtlasError::DerivedFieldMismatch
    );
    assert_eq!(
        refuse(|atlas| atlas.glyphs[0].substituted = true),
        GlyphAtlasError::DerivedFieldMismatch
    );
    assert_eq!(
        refuse(|atlas| atlas.face.probes[0].participated = false),
        GlyphAtlasError::DerivedFieldMismatch
    );
    // A right-to-left run must have a right-to-left cell: the base direction is the first strong
    // cluster in the run and every cluster in the run has a cell.
    assert_eq!(
        refuse(|atlas| atlas.metrics.base_direction = Direction::Rtl),
        GlyphAtlasError::DerivedFieldMismatch
    );
}

#[test]
fn the_probes_must_show_a_face_that_took_part_in_its_own_measurement() {
    assert_eq!(
        refuse(|atlas| {
            atlas.face.probes.pop();
        }),
        GlyphAtlasError::UnsupportedProbes
    );
    assert_eq!(
        refuse(|atlas| atlas.face.probes[1].probe_family = ProbeFamily::Monospace),
        GlyphAtlasError::UnsupportedProbes
    );
    // Every chain agreeing with its generic is how the baker detects an absent face, and it
    // refuses to bake one, so a descriptor claiming it did not come from a bake.
    assert_eq!(
        refuse(|atlas| {
            for probe in &mut atlas.face.probes {
                probe.chained_width_px = probe.alone_width_px;
                probe.participated = false;
            }
        }),
        GlyphAtlasError::UnsupportedProbes
    );
    for width in [f64::NAN, -1.0, f64::INFINITY] {
        assert_eq!(
            refuse(|atlas| atlas.face.probes[0].alone_width_px = width),
            GlyphAtlasError::UnsupportedProbes,
            "{width}"
        );
    }
}

#[test]
fn metrics_that_cannot_place_a_baseline_are_refused() {
    for metric in [f64::NAN, f64::INFINITY, -1.0] {
        assert_eq!(
            refuse(|atlas| atlas.metrics.ascent_px = metric),
            GlyphAtlasError::UnsupportedMetrics,
            "{metric}"
        );
        assert_eq!(
            refuse(|atlas| atlas.metrics.line_height_px = metric),
            GlyphAtlasError::UnsupportedMetrics,
            "{metric}"
        );
    }
    // The residual is a difference and the letter spacing tightens as well as loosens, so both are
    // signed; only a non-finite one is meaningless.
    assert_eq!(
        refuse(|atlas| atlas.metrics.shaping_residual_px = f64::NAN),
        GlyphAtlasError::UnsupportedMetrics
    );
    assert_eq!(
        refuse(|atlas| atlas.metrics.letter_spacing_px = f64::NAN),
        GlyphAtlasError::UnsupportedMetrics
    );
    assert_eq!(
        refuse(|atlas| atlas.metrics.base_direction = Direction::Neutral),
        GlyphAtlasError::UnsupportedDirection
    );
}

#[test]
fn the_content_hash_must_be_the_bakers_shape() {
    for hash in [
        "",
        "0a1b2c3",
        "0a1b2c3d4",
        "0A1B2C3D",
        "0a1b2c3g",
        " a1b2c3d",
    ] {
        assert_eq!(
            refuse(|atlas| atlas.content_hash = hash.to_owned()),
            GlyphAtlasError::UnsupportedContentHash,
            "{hash:?}"
        );
    }
    assert_eq!(accept(|_| {}).content_hash().len(), CONTENT_HASH_DIGITS);
}

#[test]
fn a_refusal_never_carries_the_atlas_pixels_a_family_or_a_path() {
    // A refusal is logged; the atlas pixels, the user's text and the resolved face are not. Every
    // message is lower-case words, which leaves room for no byte value, quote, path or filename.
    for error in [
        GlyphAtlasError::UnsupportedVersion,
        GlyphAtlasError::UnsupportedFace,
        GlyphAtlasError::UnsupportedFontSize,
        GlyphAtlasError::UnsupportedProbes,
        GlyphAtlasError::UnsupportedMetrics,
        GlyphAtlasError::UnsupportedDirection,
        GlyphAtlasError::UnsupportedAtlasSize,
        GlyphAtlasError::UnsupportedPadding,
        GlyphAtlasError::UnsupportedRowStride,
        GlyphAtlasError::UnsupportedGlyphCount,
        GlyphAtlasError::UnsupportedCluster,
        GlyphAtlasError::UnorderedGlyphs,
        GlyphAtlasError::UnsupportedTextLength,
        GlyphAtlasError::GlyphOutsideAtlas,
        GlyphAtlasError::UnsupportedLayout,
        GlyphAtlasError::UnsupportedLayoutSize,
        GlyphAtlasError::UnsupportedLayoutWidth,
        GlyphAtlasError::UnsupportedLetterSpacing,
        GlyphAtlasError::LayoutCellIndex,
        GlyphAtlasError::UnorderedLayoutBaselines,
        GlyphAtlasError::LayoutLineCountMismatch,
        GlyphAtlasError::GlyphCountMismatch,
        GlyphAtlasError::PixelBufferMismatch,
        GlyphAtlasError::DerivedFieldMismatch,
        GlyphAtlasError::UnsupportedContentHash,
    ] {
        let message = error.to_string();
        assert!(
            message
                .chars()
                .all(|character| character.is_ascii_lowercase() || character == ' '),
            "{error:?} reported {message}"
        );
    }

    // The same holds through the wire, where the value that failed is right there to be quoted.
    let mut atlas = valid();
    atlas.face.requested_family = "Secretfamily".to_owned();
    atlas.face.css_font = "normal 400 24px \"Secretfamily\"".to_owned();
    with_cells(&mut atlas, vec![glyph("Confidential", 0)]);
    atlas.pixels = vec![0xab; 16 * 64];
    atlas.content_hash = "not a hash".to_owned();
    let error = serde_json::from_value::<GlyphAtlasDescriptor>(
        serde_json::to_value(&atlas).expect("wire value"),
    )
    .expect_err("a refused descriptor");
    let message = error.to_string();
    for secret in ["Secret", "Confidential", "171", "0xab", "/", "\\"] {
        assert!(!message.contains(secret), "{message} leaked {secret}");
    }
}
