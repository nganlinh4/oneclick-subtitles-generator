//! What the boundary refuses, what it accepts, and what it never says out loud.

use osg_scene::glyph::GlyphAtlasError;

use super::decode::decode_frame;
use super::fixtures::{
    MARKER_CLUSTER_ONE, MARKER_CLUSTER_TWO, MARKER_FAMILY, frame, frame_parts, metadata,
    metadata_with, stage, valid_frame,
};
use super::refusal::StagingRefusal;
use super::registry::GlyphAtlasStore;
use super::{
    FRAME_HEADER_BYTES, GLYPH_ATLAS_STAGING_VERSION, MAX_FRAME_BYTES, MAX_METADATA_BYTES,
    MAX_STAGED_ATLASES, MAX_STAGED_BYTES,
};
use crate::error::CommandError;

#[test]
fn a_valid_frame_stages_and_returns_the_echoed_hash() {
    let atlas = stage(&valid_frame()).expect("valid frame");

    assert_eq!(atlas.content_hash(), "0a1b2c3d");
    assert_eq!(atlas.pixels.len(), 32);
    assert_eq!(atlas.metadata.atlas.width_px, 4);
    assert_eq!(atlas.metadata.atlas.height_px, 2);
    assert_eq!(atlas.metadata.glyphs.len(), 2);
    assert_eq!(atlas.metadata.glyphs[0].cluster, MARKER_CLUSTER_ONE);
    assert_eq!(atlas.metadata.face.requested_family, MARKER_FAMILY);

    let store = GlyphAtlasStore::with_limits(MAX_STAGED_ATLASES, MAX_STAGED_BYTES);
    let atlas_id = store.stage(atlas).expect("stage");
    let resolved = store.resolve(atlas_id).expect("resolve").expect("present");
    assert_eq!(resolved.content_hash(), "0a1b2c3d");
    // The handle is a fresh UUIDv7, which is what the WebView validates before trusting it.
    assert_eq!(atlas_id.as_uuid().get_version_num(), 7);
}

#[test]
fn a_shaped_line_longer_than_the_old_grapheme_bound_stages() {
    // Cells are whole shaped lines now. The first generated customer cue that exposed the stale
    // validator was 34 code points: valid as a line, invalid only under the deleted per-grapheme
    // model's 32-code-point ceiling.
    let line = "a".repeat(34);
    let glyph = format!(
        concat!(
            r#"{{"cluster":"{line}","direction":"ltr","advanceWidthPx":64,"#,
            r#""xPx":0,"yPx":0,"widthPx":2,"heightPx":2,"originXPx":0,"#,
            r#""originYPx":1,"substituted":false}}"#
        ),
        line = line,
    );
    let atlas = stage(&frame(&metadata_with(4, 2, 1, &glyph), &[0_u8; 32]))
        .expect("a valid shaped line stages");
    let descriptor = atlas
        .to_descriptor()
        .expect("the compositor accepts the same line");

    assert_eq!(descriptor.glyphs()[0].cluster, line);
}

#[test]
fn an_inkless_run_stages_as_a_zero_by_zero_atlas() {
    let atlas = stage(&frame(&metadata_with(0, 0, 0, ""), &[])).expect("inkless run");
    assert!(atlas.pixels.is_empty());
    assert!(atlas.metadata.glyphs.is_empty());

    // Half a dimension is never a valid atlas, whichever half it is.
    for metadata in [metadata_with(0, 4, 0, ""), metadata_with(4, 0, 0, "")] {
        assert_eq!(
            stage(&frame(&metadata, &[])),
            Err(StagingRefusal::Descriptor(
                GlyphAtlasError::UnsupportedAtlasSize
            ))
        );
    }
}

#[test]
fn the_shipped_bounds_are_the_ones_the_webview_stages_against() {
    assert_eq!(MAX_FRAME_BYTES, 33_554_432);
    assert_eq!(MAX_METADATA_BYTES, 1_048_576);
    // One export's whole page set has to stay resident at once, plus the preview's own headroom, so
    // the count is the page bound and then some. The byte budget is what actually decides whether a
    // large-character-set document exports.
    assert_eq!(MAX_STAGED_ATLASES, 40);
    assert_eq!(MAX_STAGED_BYTES, 268_435_456);
    assert_eq!(FRAME_HEADER_BYTES, 16);
    assert_eq!(GLYPH_ATLAS_STAGING_VERSION, 1);
}

#[test]
fn the_frame_media_type_is_required() {
    assert_eq!(
        decode_frame(None, &valid_frame()),
        Err(StagingRefusal::UnsupportedMediaType)
    );
    assert_eq!(
        decode_frame(Some("application/octet-stream"), &valid_frame()),
        Err(StagingRefusal::UnsupportedMediaType)
    );
    assert_eq!(
        decode_frame(Some("application/vnd.osg.glyph-atlas.v2"), &valid_frame()),
        Err(StagingRefusal::UnsupportedMediaType)
    );
}

#[test]
fn oversized_and_undersized_bodies_are_refused_before_the_frame_is_read() {
    // Both refusals are decided against the borrowed body, so neither copies it: the oversized
    // body carries no magic at all and is still refused as over budget rather than as garbage.
    let oversized = vec![0_u8; MAX_FRAME_BYTES + 1];
    assert_eq!(stage(&oversized), Err(StagingRefusal::FrameTooLarge));

    for length in 0..FRAME_HEADER_BYTES {
        assert_eq!(
            stage(&valid_frame()[..length]),
            Err(StagingRefusal::FrameTooShort),
            "a {length}-byte body is not a frame"
        );
    }
}

#[test]
fn a_frame_without_the_staging_magic_is_refused() {
    let metadata = metadata(4, 2);
    let frame = frame_parts(
        b"OSGATLA5",
        GLYPH_ATLAS_STAGING_VERSION,
        metadata.as_bytes(),
        u32::try_from(metadata.len()).expect("length"),
        &[0_u8; 32],
    );
    assert_eq!(stage(&frame), Err(StagingRefusal::UnsupportedMagic));
}

#[test]
fn an_unknown_frame_version_is_refused_rather_than_migrated() {
    let metadata = metadata(4, 2);
    for version in [0, 2, u32::MAX] {
        let frame = frame_parts(
            b"OSGATLAS",
            version,
            metadata.as_bytes(),
            u32::try_from(metadata.len()).expect("length"),
            &[0_u8; 32],
        );
        assert_eq!(stage(&frame), Err(StagingRefusal::UnsupportedFrameVersion));
    }
    // The header and the metadata both carry the frame version, and they must agree.
    let disagreeing = metadata.replace(r#""frameVersion":1"#, r#""frameVersion":2"#);
    assert_eq!(
        stage(&frame(&disagreeing, &[0_u8; 32])),
        Err(StagingRefusal::UnsupportedFrameVersion)
    );
}

#[test]
fn an_unknown_atlas_version_is_refused() {
    let metadata = metadata(4, 2).replace(r#""atlasVersion":1"#, r#""atlasVersion":2"#);
    assert_eq!(
        stage(&frame(&metadata, &[0_u8; 32])),
        Err(StagingRefusal::Descriptor(
            GlyphAtlasError::UnsupportedVersion
        ))
    );
}

#[test]
fn a_metadata_length_past_its_budget_or_past_the_frame_is_refused() {
    let metadata = metadata(4, 2);
    let honest = u32::try_from(metadata.len()).expect("length");

    // Past the metadata budget, and past the frame, without either quantity being allocated.
    for declared in [
        u32::try_from(MAX_METADATA_BYTES + 1).expect("budget"),
        u32::MAX,
        // Past the end of this frame: the honest metadata plus every pixel byte and one more.
        honest + 33,
    ] {
        let frame = frame_parts(
            b"OSGATLAS",
            GLYPH_ATLAS_STAGING_VERSION,
            metadata.as_bytes(),
            declared,
            &[0_u8; 32],
        );
        assert_eq!(
            stage(&frame),
            Err(StagingRefusal::UnsupportedMetadataLength),
            "a declared metadata length of {declared} is not readable"
        );
    }
}

#[test]
fn a_pixel_length_disagreeing_with_the_declared_atlas_is_refused_both_ways() {
    assert_eq!(
        stage(&frame(&metadata(4, 2), &[0_u8; 31])),
        Err(StagingRefusal::PixelLengthMismatch),
        "one byte short of the declared atlas"
    );
    assert_eq!(
        stage(&frame(&metadata(4, 2), &[0_u8; 33])),
        Err(StagingRefusal::PixelLengthMismatch),
        "one byte past the declared atlas"
    );
    assert_eq!(
        stage(&frame(&metadata(4, 2), &[])),
        Err(StagingRefusal::PixelLengthMismatch),
        "no pixels at all"
    );
}

#[test]
fn malformed_and_unknown_metadata_is_refused() {
    assert_eq!(
        stage(&frame("{\"frameVersion\":1,", &[0_u8; 32])),
        Err(StagingRefusal::UnsupportedMetadata),
        "truncated JSON"
    );
    assert_eq!(
        stage(&frame("not json at all", &[0_u8; 32])),
        Err(StagingRefusal::UnsupportedMetadata),
        "not JSON"
    );

    let unknown_top_level = metadata(4, 2).replace(
        r#""contentHash":"0a1b2c3d""#,
        r#""contentHash":"0a1b2c3d","cssFont":"48px \"Zmarkerfamilyz\"""#,
    );
    assert_eq!(
        stage(&frame(&unknown_top_level, &[0_u8; 32])),
        Err(StagingRefusal::UnsupportedMetadata),
        "an invented top-level field"
    );

    let unknown_face_field = metadata(4, 2).replace(
        r#""fontSizePx":48"#,
        r#""fontSizePx":48,"probes":[{"probeFamily":"serif"}]"#,
    );
    assert_eq!(
        stage(&frame(&unknown_face_field, &[0_u8; 32])),
        Err(StagingRefusal::UnsupportedMetadata),
        "invented shaping evidence"
    );

    let unknown_glyph_field = metadata(4, 2).replace(
        r#""advanceWidthPx":32"#,
        r#""advanceWidthPx":32,"codePoints":[453]"#,
    );
    assert_eq!(
        stage(&frame(&unknown_glyph_field, &[0_u8; 32])),
        Err(StagingRefusal::UnsupportedMetadata),
        "a second encoding of the cluster identity"
    );
}

#[test]
fn a_staged_atlas_becomes_the_checked_descriptor_the_compositor_draws_from() {
    // The point of forwarding cssFont and the probes. Without them this conversion cannot happen at
    // all, because osg-scene requires the shaping evidence before it will call an atlas valid — and
    // synthesising it here would be exactly the rubber stamp the migration removed.
    let staged = stage(&frame(&metadata(4, 2), &[0_u8; 32])).expect("valid frame");
    let descriptor = staged
        .to_descriptor()
        .expect("the staged atlas is a valid descriptor");

    assert_eq!(descriptor.glyphs().len(), 2);
    assert_eq!(descriptor.layout().lines.len(), 1);
    // codePoints is omitted on the wire and re-derived here; a cell must carry its cluster's own.
    for glyph in descriptor.glyphs() {
        let expected: Vec<u32> = glyph.cluster.chars().map(u32::from).collect();
        assert_eq!(glyph.code_points, expected);
    }
}

#[test]
fn a_face_whose_probes_prove_nothing_never_becomes_a_descriptor() {
    // Every probe agreeing means the requested family changed no measurement, so the atlas is
    // evidence of nothing. Staging accepts the frame's shape; the descriptor conversion is where
    // that claim is judged, which is why the conversion is the compositor's only door in.
    let metadata = metadata(4, 2).replace(
        r#""probeFamily":"serif","aloneWidthPx":100,"chainedWidthPx":80,"participated":true"#,
        r#""probeFamily":"serif","aloneWidthPx":80,"chainedWidthPx":80,"participated":false"#,
    ).replace(
        r#""probeFamily":"sans-serif","aloneWidthPx":90,"chainedWidthPx":80,"participated":true"#,
        r#""probeFamily":"sans-serif","aloneWidthPx":80,"chainedWidthPx":80,"participated":false"#,
    );

    assert_eq!(
        stage(&frame(&metadata, &[0_u8; 32])),
        Err(StagingRefusal::Descriptor(
            GlyphAtlasError::UnsupportedProbes
        )),
    );
}

#[test]
fn descriptor_agreements_the_wire_cannot_carry_are_re_derived() {
    let cases = [
        (
            metadata(4, 2).replace(r#""glyphCount":2"#, r#""glyphCount":3"#),
            GlyphAtlasError::GlyphCountMismatch,
        ),
        (
            metadata(4, 2).replace(r#""contentHash":"0a1b2c3d""#, r#""contentHash":"0A1B2C3D""#),
            GlyphAtlasError::UnsupportedContentHash,
        ),
        (
            metadata(4, 2).replace(r#""bytesPerRow":16"#, r#""bytesPerRow":256"#),
            GlyphAtlasError::UnsupportedRowStride,
        ),
        (
            metadata(4, 2).replace(r#""fontSizePx":48"#, r#""fontSizePx":2048"#),
            GlyphAtlasError::UnsupportedFontSize,
        ),
        (
            metadata(4, 2).replace(r#""baseDirection":"ltr""#, r#""baseDirection":"rtl""#),
            GlyphAtlasError::DerivedFieldMismatch,
        ),
        (
            metadata(4, 2).replace(r#""paddingPx":1"#, r#""paddingPx":64"#),
            GlyphAtlasError::UnsupportedPadding,
        ),
        (
            metadata(4, 2).replace(r#""xPx":2,"yPx":0"#, r#""xPx":3,"yPx":0"#),
            GlyphAtlasError::GlyphOutsideAtlas,
        ),
        (
            // The clusters swapped, so they are no longer in the baker's order.
            metadata(4, 2)
                .replace(MARKER_CLUSTER_ONE, "\u{fffd}")
                .replace(MARKER_CLUSTER_TWO, MARKER_CLUSTER_ONE)
                .replace('\u{fffd}', MARKER_CLUSTER_TWO),
            GlyphAtlasError::UnorderedGlyphs,
        ),
        (
            // The face claims a substitution that no cell records. Anchored on the probes that
            // follow it, so this targets the FACE's flag and never a cell's.
            metadata(4, 2).replace(
                r#""substituted":false,"probes""#,
                r#""substituted":true,"probes""#,
            ),
            GlyphAtlasError::DerivedFieldMismatch,
        ),
    ];
    for (metadata, expected) in cases {
        assert_eq!(
            stage(&frame(&metadata, &[0_u8; 32])),
            Err(StagingRefusal::Descriptor(expected)),
            "{expected} was not re-derived"
        );
    }
}

#[test]
fn a_refusal_never_names_a_family_a_cluster_a_path_or_a_byte_count() {
    let refusals = [
        StagingRefusal::UnsupportedMediaType,
        StagingRefusal::UnsupportedBody,
        StagingRefusal::FrameTooLarge,
        StagingRefusal::FrameTooShort,
        StagingRefusal::UnsupportedMagic,
        StagingRefusal::UnsupportedFrameVersion,
        StagingRefusal::UnsupportedMetadataLength,
        StagingRefusal::UnsupportedMetadata,
        StagingRefusal::PixelLengthMismatch,
        StagingRefusal::Unavailable,
        StagingRefusal::Descriptor(GlyphAtlasError::UnsupportedFace),
        StagingRefusal::Descriptor(GlyphAtlasError::UnsupportedCluster),
        StagingRefusal::Descriptor(GlyphAtlasError::PixelBufferMismatch),
    ];
    for refusal in refusals {
        let command = CommandError::from(refusal);
        assert_eq!(command.code(), refusal.code());
        let rendered = format!("{refusal} {command:?}");
        assert!(!rendered.contains(MARKER_FAMILY), "{rendered}");
        assert!(!rendered.contains(MARKER_CLUSTER_ONE), "{rendered}");
        assert!(!rendered.contains(MARKER_CLUSTER_TWO), "{rendered}");
        assert!(
            !rendered.contains('\\') && !rendered.contains('/'),
            "{rendered}"
        );
        assert!(!rendered.chars().any(|c| c.is_ascii_digit()), "{rendered}");
    }

    // The same holds for a refusal produced from real hostile input carrying the markers.
    let hostile = metadata(4, 2).replace(r#""weight":400"#, r#""weight":9001"#);
    let refusal = stage(&frame(&hostile, &[0_u8; 32])).expect_err("refused");
    let command = CommandError::from(refusal);
    let rendered = format!("{refusal} {command:?}");
    assert!(!rendered.contains(MARKER_FAMILY), "{rendered}");
    assert!(!rendered.contains("9001"), "{rendered}");
}

#[test]
fn a_staged_atlas_is_never_formatted_into_a_log() {
    let atlas = stage(&valid_frame()).expect("valid frame");
    let rendered = format!("{atlas:?}");

    assert!(!rendered.contains(MARKER_FAMILY), "{rendered}");
    assert!(!rendered.contains(MARKER_CLUSTER_ONE), "{rendered}");
    assert!(!rendered.contains(MARKER_CLUSTER_TWO), "{rendered}");
    assert!(rendered.contains("<redacted>"), "{rendered}");

    let store = GlyphAtlasStore::with_limits(MAX_STAGED_ATLASES, MAX_STAGED_BYTES);
    store.stage(atlas).expect("stage");
    assert!(!format!("{store:?}").contains(MARKER_FAMILY));
}

/// The byte budget the `WebView` bakes against is the byte budget this registry will hold.
///
/// The baker splits a cue list into pages and refuses a document whose pages would exceed
/// `maxTotalAtlasBytes`; this registry evicts by least recent use once `MAX_STAGED_BYTES` is passed.
/// If this side's number were the smaller, an export would stage its own earlier pages out of the
/// registry while staging its later ones, and `render_start` would then refuse a page the `WebView`
/// had every reason to believe was there — a failure neither side could explain.
///
/// Read out of the baker's own source rather than transcribed, for the same reason
/// `crates/osg-scene/tests/glyph/bounds.rs` reads the eleven bounds it mirrors: a number copied into
/// a second file drifts, and this one drifted into existence precisely because it was new.
#[test]
fn the_staging_budget_matches_the_baker_the_pages_come_from() {
    const BAKER: &str = include_str!("../../../../../src/platform/glyphAtlas.js");
    const STAGER: &str = include_str!("../../../../../src/platform/glyphAtlasStaging.js");

    let limit = |source: &str, name: &str| -> u64 {
        let needle = format!("{name}:");
        let start = source
            .find(&needle)
            .unwrap_or_else(|| panic!("{name} must exist"))
            + needle.len();
        let rest = &source[start..];
        let end = rest.find(',').expect("the limit must be terminated");
        rest[..end]
            .replace('_', "")
            .trim()
            .parse()
            .expect("a whole-number limit")
    };

    assert_eq!(limit(BAKER, "maxTotalAtlasBytes"), MAX_STAGED_BYTES);
    assert_eq!(
        limit(STAGER, "maxStagedAtlases"),
        u64::try_from(MAX_STAGED_ATLASES).expect("bound"),
    );
}
