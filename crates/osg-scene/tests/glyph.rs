//! The glyph atlas descriptor arrives from the `WebView`, so it is treated as input, not as data the
//! baker vouches for.
//!
//! Every limit the baker exports is asserted against the baker's own source here, so the mirror
//! cannot drift silently, and every bound and agreement is asserted from the refusal side: a
//! descriptor that exists must be one the compositor can address without checking anything again.

use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasMetrics, CONTENT_HASH_DIGITS, CellAdvanceLayout,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, GlyphAtlasError,
    LayoutRefusal, MAX_ATLAS_DIMENSION_PX, MAX_BYTES_PER_ROW, MAX_CLUSTER_CODE_POINTS,
    MAX_FAMILY_CHARACTERS, MAX_FONT_SIZE_PX, MAX_GLYPH_COUNT, MAX_PADDING_PX, MAX_PIXEL_BYTES,
    MAX_TEXT_CODE_POINTS, MIN_FONT_SIZE_PX, PixelFormat, ProbeFamily, UncheckedGlyphAtlas,
};

/// The baker itself, so the mirrored limits are asserted against their source rather than against a
/// copy of it. Moving the file breaks this test loudly, which is the intent.
const BAKER: &str = include_str!("../../../src/platform/glyphAtlas.js");

fn glyph(cluster: &str, x_px: u32) -> AtlasGlyph {
    AtlasGlyph {
        cluster: cluster.to_owned(),
        code_points: cluster.chars().map(u32::from).collect(),
        direction: Direction::Ltr,
        advance_width_px: 13.2,
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
fn inkless(cluster: &str) -> AtlasGlyph {
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
fn distinct(index: usize) -> String {
    let code_point = 0x4e00 + u32::try_from(index).expect("a cluster index");
    char::from_u32(code_point)
        .expect("a basic multilingual code point")
        .to_string()
}

fn probes() -> Vec<FaceProbe> {
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

fn valid() -> UncheckedGlyphAtlas {
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
            ascent_px: 19.2,
            descent_px: 4.8,
            line_height_px: 24.0,
            baseline_px: 19.2,
            run_advance_width_px: 26.4,
            shaping_residual_px: 0.0,
            base_direction: Direction::Ltr,
        },
        atlas: AtlasGeometry {
            width_px: 16,
            height_px: 16,
            padding_px: 1,
            glyph_count: 2,
            pixel_format: PixelFormat::Rgba8,
            bytes_per_row: 64,
        },
        glyphs: vec![glyph("A", 0), glyph("b", 8)],
        content_hash: "0a1b2c3d".to_owned(),
        pixels: vec![0; 16 * 64],
    }
}

/// An atlas with no ink at all: the baker emits this for text that is entirely whitespace.
fn empty() -> UncheckedGlyphAtlas {
    UncheckedGlyphAtlas {
        atlas: AtlasGeometry {
            width_px: 0,
            height_px: 0,
            glyph_count: 0,
            bytes_per_row: 0,
            ..valid().atlas
        },
        glyphs: vec![],
        pixels: vec![],
        ..valid()
    }
}

fn refuse(mutate: impl FnOnce(&mut UncheckedGlyphAtlas)) -> GlyphAtlasError {
    let mut atlas = valid();
    mutate(&mut atlas);
    GlyphAtlasDescriptor::try_from(atlas).expect_err("the descriptor must be refused")
}

fn accept(mutate: impl FnOnce(&mut UncheckedGlyphAtlas)) -> GlyphAtlasDescriptor {
    let mut atlas = valid();
    mutate(&mut atlas);
    GlyphAtlasDescriptor::try_from(atlas).expect("the descriptor must be accepted")
}

/// Read one `GLYPH_ATLAS_LIMITS` entry out of the baker's source, numeric separators and all.
fn baker_limit(name: &str) -> String {
    let needle = format!("{name}:");
    let start = BAKER
        .find(&needle)
        .unwrap_or_else(|| panic!("{name} must exist in the baker"))
        + needle.len();
    let rest = &BAKER[start..];
    let end = rest.find(',').expect("the limit must be terminated");
    rest[..end].replace('_', "").trim().to_owned()
}

fn baker_count(name: &str) -> u64 {
    baker_limit(name).parse().expect("a whole-number limit")
}

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
        "\"bytesPerRow\"",
        "\"pixelFormat\":\"rgba8\"",
        "\"codePoints\"",
        "\"advanceWidthPx\"",
        "\"originXPx\"",
        "\"contentHash\"",
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
        "runAdvanceWidthPx": 13.2, "shapingResidualPx": 0, "baseDirection": "ltr"
      },
      "atlas": {
        "widthPx": 2, "heightPx": 2, "paddingPx": 1, "glyphCount": 1,
        "pixelFormat": "rgba8", "bytesPerRow": 8
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
}

#[test]
fn the_glyph_count_limit_is_enforced_while_the_descriptor_is_read() {
    let mut atlas = valid();
    atlas.glyphs = (0..=MAX_GLYPH_COUNT).map(|_| glyph("A", 0)).collect();
    atlas.atlas.glyph_count = u32::try_from(atlas.glyphs.len()).expect("count");

    // Read first: an oversize list stops at the bound instead of allocating what it declared.
    let json = serde_json::to_string(&atlas).expect("oversize wire value");
    let error = serde_json::from_str::<GlyphAtlasDescriptor>(&json).expect_err("oversize list");
    assert!(error.to_string().contains("more than 1024"), "{error}");

    assert_eq!(
        GlyphAtlasDescriptor::try_from(atlas),
        Err(GlyphAtlasError::UnsupportedGlyphCount)
    );
    let full = accept(|atlas| {
        atlas.glyphs = (0..MAX_GLYPH_COUNT)
            .map(|index| inkless(&distinct(index)))
            .collect();
        atlas.atlas.glyph_count = u32::try_from(MAX_GLYPH_COUNT).expect("count");
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
            atlas.glyphs = (0..clusters)
                .map(|index| inkless(&distinct(index).repeat(MAX_CLUSTER_CODE_POINTS)))
                .collect();
            atlas.atlas.glyph_count = u32::try_from(clusters).expect("a cluster count");
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
        atlas.glyphs = vec![inkless("\u{1f600}"), inkless("\u{f8ff}")];
        atlas.atlas.glyph_count = 2;
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
    // The residual is a difference, so it is signed; only a non-finite one is meaningless.
    assert_eq!(
        refuse(|atlas| atlas.metrics.shaping_residual_px = f64::NAN),
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
fn cell_advance_layout_reproduces_only_a_clean_left_to_right_run() {
    let descriptor = accept(|_| {});
    assert_eq!(
        descriptor.cell_advance_layout(),
        CellAdvanceLayout::Reproduces
    );
    assert!(descriptor.cell_advance_layout().reproduces());
}

#[test]
fn cell_advance_layout_refuses_a_run_whose_shaping_crossed_clusters() {
    // A kerned pair measures narrower than the sum of its cells, which is exactly the case where
    // laying out from cell advances would silently drift.
    let descriptor = accept(|atlas| atlas.metrics.shaping_residual_px = -0.42);
    assert_eq!(
        descriptor.cell_advance_layout(),
        CellAdvanceLayout::Refused(LayoutRefusal {
            shaping_crosses_clusters: true,
            direction_needs_bidi: false,
        })
    );
    assert!(!descriptor.cell_advance_layout().reproduces());
}

#[test]
fn cell_advance_layout_refuses_a_run_the_descriptor_only_classified() {
    let rtl = |atlas: &mut UncheckedGlyphAtlas| {
        atlas.metrics.base_direction = Direction::Rtl;
        atlas.glyphs[0].direction = Direction::Rtl;
    };
    assert_eq!(
        accept(rtl).cell_advance_layout(),
        CellAdvanceLayout::Refused(LayoutRefusal {
            shaping_crosses_clusters: false,
            direction_needs_bidi: true,
        })
    );
    // A left-to-right run with a right-to-left cell still needs reordering, and first-strong
    // classification is not what does it.
    assert_eq!(
        accept(|atlas| atlas.glyphs[1].direction = Direction::Rtl).cell_advance_layout(),
        CellAdvanceLayout::Refused(LayoutRefusal {
            shaping_crosses_clusters: false,
            direction_needs_bidi: true,
        })
    );
    assert_eq!(
        accept(|atlas| {
            rtl(atlas);
            atlas.metrics.shaping_residual_px = 1.5;
        })
        .cell_advance_layout(),
        CellAdvanceLayout::Refused(LayoutRefusal {
            shaping_crosses_clusters: true,
            direction_needs_bidi: true,
        })
    );
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
    atlas.glyphs = vec![glyph("Confidential", 0)];
    atlas.atlas.glyph_count = 1;
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
