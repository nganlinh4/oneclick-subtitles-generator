//! Turning a composed frame into the image the editor's `<img>` loads.
//!
//! One decision matters here and it is easy to get wrong in a way that looks like nothing:
//! [`osg_compositor::Frame`] carries **premultiplied** alpha and `PNG` alpha is **straight** by
//! specification. Writing the premultiplied bytes into the file unchanged makes every partly
//! transparent pixel darker than it should be — and only those, so opaque areas look perfect while
//! antialiased glyph edges and fading cues go crunchy and dark-fringed. The preview would show that
//! and the export would not, which is precisely the divergence the single-pipeline architecture
//! exists to make impossible.
//!
//! [`osg_compositor::Frame::to_straight_alpha`] is the one conversion, and it lives next to the
//! pixels rather than being rewritten per call site. This module's only job is to call it and to
//! hand the result to an encoder that will not touch the colour any further.

use osg_compositor::Frame;
use png::{BitDepth, ColorType, Compression, Encoder, FilterType};

use super::MAX_FRAME_BYTES;
use super::refusal::PreviewRefusal;

/// Encodes a composed frame as a straight-alpha `PNG`.
///
/// Deterministic: fixed colour type, depth, filter and compression, no timestamp chunk and no
/// ancillary metadata, so the same frame encodes to the same bytes on every machine and a preview
/// image can be compared byte for byte with the frame an export composed.
pub(crate) fn encode_png(frame: &Frame) -> Result<Vec<u8>, PreviewRefusal> {
    let mut bytes = Vec::new();
    let mut encoder = Encoder::new(&mut bytes, frame.width(), frame.height());
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(Compression::Default);
    // Not adaptive: filter selection must not depend on heuristics that a library version could
    // change, or two builds would encode the same frame differently.
    encoder.set_filter(FilterType::Sub);
    let mut writer = encoder
        .write_header()
        .map_err(|_| PreviewRefusal::FrameUnpublishable)?;
    writer
        .write_image_data(&frame.to_straight_alpha())
        .map_err(|_| PreviewRefusal::FrameUnpublishable)?;
    writer
        .finish()
        .map_err(|_| PreviewRefusal::FrameUnpublishable)?;

    if bytes.len() > MAX_FRAME_BYTES {
        return Err(PreviewRefusal::FrameUnpublishable);
    }
    Ok(bytes)
}

/// Decodes a preview `PNG` back to RGBA8, for the tests that assert what was actually written.
///
/// Test-only on purpose. Nothing in the product reads a preview frame back: the image exists to be
/// loaded by an element, and a native reader would be a second definition of what was published.
#[cfg(test)]
pub(crate) fn decode_png(bytes: &[u8]) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(bytes);
    let mut reader = decoder.read_info().expect("the preview png has a header");
    let mut pixels = vec![0_u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut pixels)
        .expect("the preview png has one frame");
    assert_eq!(info.color_type, ColorType::Rgba);
    assert_eq!(info.bit_depth, BitDepth::Eight);
    pixels.truncate(info.buffer_size());
    (info.width, info.height, pixels)
}
