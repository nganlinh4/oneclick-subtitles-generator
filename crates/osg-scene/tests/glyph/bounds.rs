//! The bounds, the wire shape, and the reads that stop at a limit rather than after it.

use osg_scene::glyph::{
    AtlasGlyph, CellAdvanceLayout, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor,
    GlyphAtlasError, MAX_ATLAS_DIMENSION_PX, MAX_BYTES_PER_ROW, MAX_CLUSTER_CODE_POINTS,
    MAX_ATLAS_PAGES, MAX_FAMILY_CHARACTERS, MAX_FONT_SIZE_PX, MAX_GLYPH_COUNT, MAX_LAYOUT_CELLS,
    MAX_LAYOUT_COORDINATE_PX, MAX_LAYOUT_LINES, MAX_LAYOUT_WIDTH_PX, MAX_LETTER_SPACING_PX,
    MAX_PADDING_PX, MAX_PIXEL_BYTES, MAX_TEXT_CODE_POINTS, MIN_FONT_SIZE_PX, MIN_LETTER_SPACING_PX,
    UncheckedGlyphAtlas,
};

use super::support::{
    BAKER, STAGING, accept, baker_count, baker_limit, baker_number, distinct, empty, glyph,
    inkless, refuse, valid, with_cells,
};

#[test]
fn the_mirrored_limits_match_the_baker() {
    let version = {
        let needle = "GLYPH_ATLAS_VERSION = ";
        let start = BAKER.find(needle).expect("the baker's version") + needle.len();
        let rest = &BAKER[start..];
        rest[..rest.find(';').expect("the version's terminator")]
            .trim()
            .parse::<u32>()
            .expect("a whole-number version")
    };
    assert_eq!(version, GLYPH_ATLAS_VERSION);
    assert_eq!(
        baker_count("maxTextCodePoints"),
        u64::try_from(MAX_TEXT_CODE_POINTS).expect("bound")
    );
    assert_eq!(
        baker_count("maxGlyphCount"),
        u64::try_from(MAX_GLYPH_COUNT).expect("bound")
    );
    // How many pages a document may need. Together with `maxGlyphCount` above this is what decides
    // whether a large-character-set document exports at all, and a document past it is refused
    // rather than drawn with glyphs missing — so the two sides disagreeing would mean the WebView
    // bakes a page count this side will not accept, which the user would meet as a failed export.
    // The companion BYTE budget lives in the desktop crate, which owns the registry that holds the
    // pages, and is pinned there.
    assert_eq!(
        baker_count("maxAtlasPages"),
        u64::try_from(MAX_ATLAS_PAGES).expect("bound")
    );
    assert_eq!(
        baker_count("maxClusterCodePoints"),
        u64::try_from(MAX_CLUSTER_CODE_POINTS).expect("bound")
    );
    assert_eq!(
        baker_count("maxAtlasDimensionPx"),
        u64::from(MAX_ATLAS_DIMENSION_PX)
    );
    assert_eq!(
        baker_count("maxFamilyCharacters"),
        u64::try_from(MAX_FAMILY_CHARACTERS).expect("bound")
    );
    assert_eq!(baker_count("maxPaddingPx"), u64::from(MAX_PADDING_PX));
    // The derived bounds are only honest while they stay the derivation they claim to be.
    assert_eq!(MAX_BYTES_PER_ROW, MAX_ATLAS_DIMENSION_PX * 4);
    assert_eq!(
        u64::try_from(MAX_PIXEL_BYTES).expect("bound"),
        u64::from(MAX_ATLAS_DIMENSION_PX) * u64::from(MAX_BYTES_PER_ROW)
    );
    // Compared as bits: a mirrored bound has to be the same number, not a number that rounds to it.
    assert_eq!(
        baker_limit("minFontSizePx")
            .parse::<f64>()
            .expect("size")
            .to_bits(),
        MIN_FONT_SIZE_PX.to_bits()
    );
    assert_eq!(
        baker_limit("maxFontSizePx")
            .parse::<f64>()
            .expect("size")
            .to_bits(),
        MAX_FONT_SIZE_PX.to_bits()
    );
}

/// The layout's own bounds, mirrored from the same source as the rest.
#[test]
fn the_mirrored_layout_limits_match_the_baker() {
    assert_eq!(
        baker_count("maxLayoutLines"),
        u64::try_from(MAX_LAYOUT_LINES).expect("bound")
    );
    assert_eq!(
        baker_count("maxLayoutCells"),
        u64::try_from(MAX_LAYOUT_CELLS).expect("bound")
    );
    assert_eq!(
        baker_number("maxLayoutWidthPx").to_bits(),
        MAX_LAYOUT_WIDTH_PX.to_bits()
    );
    assert_eq!(
        baker_number("minLetterSpacingPx").to_bits(),
        MIN_LETTER_SPACING_PX.to_bits()
    );
    assert_eq!(
        baker_number("maxLetterSpacingPx").to_bits(),
        MAX_LETTER_SPACING_PX.to_bits()
    );
    // The coordinate bound is the same number on both sides *and* derived the same way, so the two
    // validators refuse the same magnitudes rather than agreeing by comment.
    assert_eq!(
        MAX_LAYOUT_COORDINATE_PX.to_bits(),
        MAX_LAYOUT_WIDTH_PX.to_bits()
    );
    assert!(
        STAGING.contains("const LAYOUT_COORDINATE_LIMIT = GLYPH_ATLAS_LIMITS.maxLayoutWidthPx;"),
        "the staging validator must still bound layout coordinates by maxLayoutWidthPx",
    );
}

#[test]
fn a_valid_descriptor_round_trips_as_the_camel_case_shape_the_baker_emits() {
    let descriptor = accept(|_| {});
    let json = serde_json::to_string(&descriptor).expect("serialized descriptor");
    for key in [
        "\"requestedFamily\"",
        "\"fontSizePx\"",
        "\"cssFont\"",
        "\"probeFamily\"",
        "\"sans-serif\"",
        "\"shapingResidualPx\"",
        "\"baseDirection\"",
        "\"letterSpacingPx\"",
        "\"bytesPerRow\"",
        "\"pixelFormat\":\"rgba8\"",
        "\"codePoints\"",
        "\"advanceWidthPx\"",
        "\"originXPx\"",
        "\"contentHash\"",
        // The layout, field for field: a rename on either side has to fail here.
        "\"layout\"",
        "\"textTransform\":\"none\"",
        "\"maxWidthPx\":null",
        "\"wordWrap\":true",
        "\"textAlign\":\"left\"",
        "\"lineCount\"",
        "\"widthPx\"",
        "\"heightPx\"",
        "\"cellAdvanceLayout\":\"reproduces\"",
        "\"shapingCrossesClusters\"",
        "\"directionNeedsBidi\"",
        "\"penXPx\"",
        "\"measuredWidthPx\"",
        "\"baselineYPx\"",
        "\"justificationPx\"",
        "\"endsParagraph\"",
    ] {
        assert!(json.contains(key), "{key} is missing from {json}");
    }

    let parsed: GlyphAtlasDescriptor = serde_json::from_str(&json).expect("parsed descriptor");
    assert_eq!(parsed, descriptor);
    assert_eq!(parsed.version(), GLYPH_ATLAS_VERSION);
    assert_eq!(parsed.face().requested_family, "Inter");
    assert_eq!(parsed.glyphs().len(), 2);
    assert_eq!(parsed.atlas().bytes_per_row, 64);
    assert_eq!(parsed.content_hash(), "0a1b2c3d");
    assert_eq!(parsed.pixels().len(), 16 * 64);
    assert_eq!(parsed.layout().placed_cells(), 2);
}

#[test]
fn a_descriptor_written_the_way_the_baker_writes_one_is_read() {
    // Written by hand rather than by this crate: the baker emits whole numbers without a decimal
    // point and quotes its enumerations, and a round trip through Rust alone would never prove that
    // shape is accepted.
    let json = r#"{
      "version": 1,
      "face": {
        "requestedFamily": "Noto Sans KR",
        "weight": 700,
        "style": "italic",
        "fontSizePx": 24,
        "cssFont": "italic 700 24px \"Noto Sans KR\"",
        "substituted": false,
        "probes": [
          {"probeFamily":"monospace","aloneWidthPx":90,"chainedWidthPx":78,"participated":true},
          {"probeFamily":"serif","aloneWidthPx":82.5,"chainedWidthPx":78,"participated":true},
          {"probeFamily":"sans-serif","aloneWidthPx":78,"chainedWidthPx":78,"participated":false}
        ]
      },
      "metrics": {
        "ascentPx": 19.2, "descentPx": 4.8, "lineHeightPx": 24, "baselinePx": 19.2,
        "runAdvanceWidthPx": 13.2, "shapingResidualPx": 0, "baseDirection": "ltr",
        "letterSpacingPx": 1.5
      },
      "atlas": {
        "widthPx": 2, "heightPx": 2, "paddingPx": 1, "glyphCount": 1,
        "pixelFormat": "rgba8", "bytesPerRow": 8
      },
      "layout": {
        "textTransform": "uppercase", "letterSpacingPx": 1.5, "maxWidthPx": 320,
        "wordWrap": true, "textAlign": "center", "lineCount": 2,
        "widthPx": 14.7, "heightPx": 48,
        "cellAdvanceLayout": "reproduces",
        "refusal": {"shapingCrossesClusters": false, "directionNeedsBidi": false},
        "lines": [
          {"glyphs":[0],"penXPx":[0],"advanceWidthPx":14.7,"measuredWidthPx":14.7,
           "shapingResidualPx":0,"baselineYPx":19.2,"justificationPx":0,"endsParagraph":false},
          {"glyphs":[0],"penXPx":[0],"advanceWidthPx":14.7,"measuredWidthPx":14.7,
           "shapingResidualPx":0,"baselineYPx":43.2,"justificationPx":0,"endsParagraph":true}
        ]
      },
      "glyphs": [{
        "cluster": "가", "codePoints": [44032], "direction": "ltr", "advanceWidthPx": 13.2,
        "xPx": 0, "yPx": 0, "widthPx": 2, "heightPx": 2,
        "originXPx": -1, "originYPx": 1, "substituted": false
      }],
      "contentHash": "1a2b3c4d",
      "pixels": [0,0,0,0, 0,0,0,255, 0,0,0,0, 0,0,0,255]
    }"#;

    let descriptor: GlyphAtlasDescriptor = serde_json::from_str(json).expect("the baker's shape");
    assert_eq!(descriptor.face().style, FaceStyle::Italic);
    assert_eq!(descriptor.face().weight, 700);
    assert_eq!(descriptor.glyphs()[0].code_points, vec![44_032]);
    // Signed, because ink may begin to the right of the pen.
    assert_eq!(descriptor.glyphs()[0].origin_x_px, -1);
    assert_eq!(descriptor.pixels().len(), 16);
    assert_eq!(
        descriptor.cell_advance_layout(),
        CellAdvanceLayout::Reproduces
    );
    // The second line's baseline is one line box below the first, and the consumer reads it rather
    // than deriving it.
    assert_eq!(
        descriptor.layout().lines[1].baseline_y_px.to_bits(),
        43.2_f64.to_bits()
    );
    assert_eq!(descriptor.layout().line_count, 2);
    assert_eq!(
        descriptor.metrics().letter_spacing_px.to_bits(),
        1.5_f64.to_bits()
    );
}

#[test]
fn an_unknown_version_is_refused_rather_than_partially_read() {
    for version in [0, GLYPH_ATLAS_VERSION + 1, u32::MAX] {
        assert_eq!(
            refuse(|atlas| atlas.version = version),
            GlyphAtlasError::UnsupportedVersion,
            "version {version}"
        );
    }
    // A future descriptor may carry fields this build cannot even name, and the version gate must
    // be what refuses it rather than the field list happening to disagree first.
    let mut future = serde_json::to_value(valid()).expect("wire value");
    future["version"] = serde_json::json!(GLYPH_ATLAS_VERSION + 1);
    assert!(serde_json::from_value::<GlyphAtlasDescriptor>(future).is_err());
}

#[test]
fn an_unknown_field_is_refused_instead_of_ignored() {
    let mut extended = serde_json::to_value(valid()).expect("wire value");
    extended["subpixelPositions"] = serde_json::json!(true);
    let error =
        serde_json::from_value::<GlyphAtlasDescriptor>(extended).expect_err("unknown field");
    assert!(error.to_string().contains("subpixelPositions"), "{error}");

    // The layout is `deny_unknown_fields` too, so a field added to `buildTextLayout` without being
    // mirrored here is refused rather than dropped on the floor.
    let mut extended = serde_json::to_value(valid()).expect("wire value");
    extended["layout"]["hyphenationPoints"] = serde_json::json!([1, 2]);
    let error =
        serde_json::from_value::<GlyphAtlasDescriptor>(extended).expect_err("unknown field");
    assert!(error.to_string().contains("hyphenationPoints"), "{error}");
}

#[test]
fn the_glyph_count_limit_is_enforced_while_the_descriptor_is_read() {
    let mut atlas = valid();
    with_cells(
        &mut atlas,
        (0..=MAX_GLYPH_COUNT).map(|_| glyph("A", 0)).collect(),
    );

    // Read first: an oversize list stops at the bound instead of allocating what it declared.
    let json = serde_json::to_string(&atlas).expect("oversize wire value");
    let error = serde_json::from_str::<GlyphAtlasDescriptor>(&json).expect_err("oversize list");
    assert!(error.to_string().contains("more than 1024"), "{error}");

    assert_eq!(
        GlyphAtlasDescriptor::try_from(atlas),
        Err(GlyphAtlasError::UnsupportedGlyphCount)
    );
    let full = accept(|atlas| {
        with_cells(
            atlas,
            (0..MAX_GLYPH_COUNT)
                .map(|index| inkless(&distinct(index)))
                .collect(),
        );
    });
    assert_eq!(full.glyphs().len(), MAX_GLYPH_COUNT);
}

#[test]
fn the_cluster_code_point_limit_is_enforced() {
    let long: String = core::iter::repeat_n('\u{0301}', MAX_CLUSTER_CODE_POINTS)
        .chain(core::iter::once('e'))
        .collect();
    assert_eq!(
        refuse(|atlas| atlas.glyphs = vec![AtlasGlyph { ..inkless(&long) }, glyph("b", 8)]),
        GlyphAtlasError::UnsupportedCluster
    );

    let mut atlas = valid();
    atlas.glyphs = vec![inkless(&long), glyph("b", 8)];
    let json = serde_json::to_string(&atlas).expect("oversize wire value");
    let error = serde_json::from_str::<GlyphAtlasDescriptor>(&json).expect_err("oversize cluster");
    assert!(error.to_string().contains("more than 32"), "{error}");
}

#[test]
fn the_text_code_point_limit_is_enforced_across_every_cluster() {
    // The descriptor carries the run's distinct clusters rather than its text, and their code
    // points cannot outnumber the run's own, so the run's bound applies to their total.
    let run = |clusters: usize| {
        move |atlas: &mut UncheckedGlyphAtlas| {
            with_cells(
                atlas,
                (0..clusters)
                    .map(|index| inkless(&distinct(index).repeat(MAX_CLUSTER_CODE_POINTS)))
                    .collect(),
            );
        }
    };
    let exactly = MAX_TEXT_CODE_POINTS / MAX_CLUSTER_CODE_POINTS;
    assert_eq!(accept(run(exactly)).glyphs().len(), exactly);
    assert_eq!(
        refuse(run(exactly + 1)),
        GlyphAtlasError::UnsupportedTextLength
    );
}

#[test]
fn the_atlas_dimension_limit_is_enforced() {
    for (width, height) in [
        (MAX_ATLAS_DIMENSION_PX + 2, 16),
        (16, MAX_ATLAS_DIMENSION_PX + 2),
    ] {
        assert_eq!(
            refuse(|atlas| {
                atlas.atlas.width_px = width;
                atlas.atlas.height_px = height;
            }),
            GlyphAtlasError::UnsupportedAtlasSize,
            "{width}x{height}"
        );
    }
    // The largest in-bounds row is exactly the largest atlas edge in RGBA8.
    assert_eq!(
        accept(|atlas| {
            *atlas = empty();
            atlas.atlas.width_px = MAX_ATLAS_DIMENSION_PX;
            atlas.atlas.bytes_per_row = MAX_BYTES_PER_ROW;
        })
        .atlas()
        .width_px,
        MAX_ATLAS_DIMENSION_PX
    );
}

#[test]
fn the_font_size_limits_are_enforced() {
    for size in [
        MIN_FONT_SIZE_PX - 0.1,
        MAX_FONT_SIZE_PX + 0.1,
        0.0,
        f64::NAN,
        f64::INFINITY,
    ] {
        assert_eq!(
            refuse(|atlas| atlas.face.font_size_px = size),
            GlyphAtlasError::UnsupportedFontSize,
            "{size}"
        );
    }
    for size in [MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX] {
        assert_eq!(
            accept(|atlas| atlas.face.font_size_px = size)
                .face()
                .font_size_px
                .to_bits(),
            size.to_bits()
        );
    }
}

#[test]
fn the_family_character_limit_is_enforced() {
    let family = |characters: usize| {
        move |atlas: &mut UncheckedGlyphAtlas| {
            atlas.face.requested_family = "a".repeat(characters);
            atlas.face.css_font = format!("normal 400 24px \"{}\"", "a".repeat(characters));
        }
    };
    assert_eq!(
        accept(family(MAX_FAMILY_CHARACTERS))
            .face()
            .requested_family
            .len(),
        MAX_FAMILY_CHARACTERS
    );
    assert_eq!(
        refuse(family(MAX_FAMILY_CHARACTERS + 1)),
        GlyphAtlasError::UnsupportedFace
    );
    // A family the baker would refuse to interpolate is refused here too, so nothing that could
    // terminate a declaration or a log line survives the boundary.
    for family in ["", " Inter", "Inter</style>", "Inter\nBold", "Inter\u{0}"] {
        assert_eq!(
            refuse(|atlas| {
                atlas.face.css_font = format!("normal 400 24px \"{family}\"");
                atlas.face.requested_family = family.to_owned();
            }),
            GlyphAtlasError::UnsupportedFace,
            "{family:?}"
        );
    }
}

#[test]
fn the_padding_limit_is_enforced() {
    assert_eq!(
        accept(|atlas| atlas.atlas.padding_px = MAX_PADDING_PX)
            .atlas()
            .padding_px,
        MAX_PADDING_PX
    );
    assert_eq!(
        refuse(|atlas| atlas.atlas.padding_px = MAX_PADDING_PX + 1),
        GlyphAtlasError::UnsupportedPadding
    );
}

#[test]
fn the_row_stride_must_address_a_whole_row_of_pixels() {
    // Narrower than the pixels it claims to carry, wider than any atlas needs, and not a whole
    // number of pixels: each one would make the compositor read the wrong bytes.
    for stride in [60, MAX_BYTES_PER_ROW + 4, 66] {
        assert_eq!(
            refuse(|atlas| {
                atlas.atlas.bytes_per_row = stride;
                atlas.pixels = vec![0; 16 * stride as usize];
            }),
            GlyphAtlasError::UnsupportedRowStride,
            "{stride}"
        );
    }
    // A padded stride is legitimate: a GPU upload wants its rows aligned.
    assert_eq!(
        accept(|atlas| {
            atlas.atlas.bytes_per_row = 256;
            atlas.pixels = vec![0; 16 * 256];
        })
        .pixels()
        .len(),
        16 * 256
    );
}

#[test]
fn the_pixel_buffer_must_match_the_declared_geometry() {
    for length in [0, 16 * 64 - 1, 16 * 64 + 1] {
        assert_eq!(
            refuse(|atlas| atlas.pixels = vec![0; length]),
            GlyphAtlasError::PixelBufferMismatch,
            "{length}"
        );
    }
    assert!(GlyphAtlasDescriptor::try_from(empty()).is_ok());
}
