//! Frames written by hand, shared by every test module in this boundary.

use super::decode::decode_frame;
use super::refusal::StagingRefusal;
use super::{
    FRAME_HEADER_BYTES, GLYPH_ATLAS_FRAME_MEDIA_TYPE, GLYPH_ATLAS_STAGING_VERSION, StagedGlyphAtlas,
};

/// A family and two clusters that appear nowhere else, so a leak is unambiguous.
pub(super) const MARKER_FAMILY: &str = "Zmarkerfamilyz";
pub(super) const MARKER_CLUSTER_ONE: &str = "Ǆ";
pub(super) const MARKER_CLUSTER_TWO: &str = "ǅ";

/// The exact metadata `glyphAtlasStaging.js` emits, written literally so this test pins the
/// wire format independently of the JavaScript that produces it.
///
/// `glyphs` is spliced in whole rather than generated, so a test can pin an inkless run as
/// deliberately as it pins an inked one.
pub(super) fn metadata_with(
    width_px: u32,
    height_px: u32,
    glyph_count: u32,
    glyphs: &str,
) -> String {
    format!(
        concat!(
            r#"{{"frameVersion":1,"atlasVersion":1,"contentHash":"0a1b2c3d","#,
            r#""face":{{"requestedFamily":"{family}","weight":400,"style":"normal","#,
            r#""fontSizePx":48,"substituted":false}},"#,
            r#""metrics":{{"ascentPx":38,"descentPx":10,"lineHeightPx":56,"baselinePx":40,"#,
            r#""runAdvanceWidthPx":64,"shapingResidualPx":0,"baseDirection":"ltr"}},"#,
            r#""atlas":{{"widthPx":{width},"heightPx":{height},"paddingPx":1,"#,
            r#""glyphCount":{count},"pixelFormat":"rgba8","bytesPerRow":{stride}}},"#,
            r#""glyphs":[{glyphs}]}}"#
        ),
        family = MARKER_FAMILY,
        width = width_px,
        height = height_px,
        count = glyph_count,
        stride = width_px * 4,
        glyphs = glyphs,
    )
}

pub(super) fn metadata(width_px: u32, height_px: u32) -> String {
    let cell = |cluster: &str, x_px: u32| {
        format!(
            concat!(
                r#"{{"cluster":"{cluster}","direction":"ltr","advanceWidthPx":32,"#,
                r#""xPx":{x},"yPx":0,"widthPx":2,"heightPx":2,"originXPx":0,"#,
                r#""originYPx":1,"substituted":false}}"#
            ),
            cluster = cluster,
            x = x_px,
        )
    };
    metadata_with(
        width_px,
        height_px,
        2,
        &format!(
            "{},{}",
            cell(MARKER_CLUSTER_ONE, 0),
            cell(MARKER_CLUSTER_TWO, 2)
        ),
    )
}

/// Builds a frame by hand from its three parts, so a test can corrupt exactly one of them.
pub(super) fn frame_parts(
    magic: &[u8],
    frame_version: u32,
    metadata: &[u8],
    declared_metadata_len: u32,
    pixels: &[u8],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + metadata.len() + pixels.len());
    frame.extend_from_slice(magic);
    frame.extend_from_slice(&frame_version.to_le_bytes());
    frame.extend_from_slice(&declared_metadata_len.to_le_bytes());
    frame.extend_from_slice(metadata);
    frame.extend_from_slice(pixels);
    frame
}

pub(super) fn frame(metadata: &str, pixels: &[u8]) -> Vec<u8> {
    let metadata = metadata.as_bytes();
    frame_parts(
        b"OSGATLAS",
        GLYPH_ATLAS_STAGING_VERSION,
        metadata,
        u32::try_from(metadata.len()).expect("test metadata length"),
        pixels,
    )
}

/// A 4x2 RGBA8 atlas: 32 tightly packed bytes.
pub(super) fn valid_frame() -> Vec<u8> {
    frame(&metadata(4, 2), &[0x7f_u8; 32])
}

pub(super) fn stage(frame: &[u8]) -> Result<StagedGlyphAtlas, StagingRefusal> {
    decode_frame(Some(GLYPH_ATLAS_FRAME_MEDIA_TYPE), frame)
}
