//! The NV12 view, from plain vectors and no platform.
//!
//! The bug this file exists to catch is the padded row. A decoder's buffer is laid out by stride,
//! not by width, and reading it as `width * height` bytes works perfectly on a machine whose stride
//! happens to equal its width — which is most development machines and almost no hardware decoders.
//! The failure it produces is a picture sheared progressively to one side, and it does not appear
//! until someone else runs the build.

use osg_decode::{DecodeError, FrameGeometry, NvPlanes, SourceColorimetry};

const WIDTH: u32 = 4;
const HEIGHT: u32 = 4;

fn geometry() -> FrameGeometry {
    FrameGeometry::new(WIDTH, HEIGHT).expect("an even 4x4 frame")
}

/// A 4x4 NV12 frame at `stride`, with the padding filled with a value that must never be read.
///
/// Luma is `row * 16 + column`, so every pixel is distinguishable. Chroma is neutral, so the
/// conversion is a pure luma test and any colour in the result is a layout mistake.
fn padded_frame(stride: usize) -> Vec<u8> {
    const PADDING: u8 = 0xEE;
    let mut bytes = vec![PADDING; stride * (usize::try_from(HEIGHT).expect("small") * 3 / 2)];
    for row in 0..usize::try_from(HEIGHT).expect("small") {
        for column in 0..usize::try_from(WIDTH).expect("small") {
            bytes[row * stride + column] = u8::try_from(row * 16 + column).expect("a small sample");
        }
    }
    let chroma_start = stride * usize::try_from(HEIGHT).expect("small");
    for row in 0..usize::try_from(HEIGHT).expect("small") / 2 {
        for column in 0..usize::try_from(WIDTH).expect("small") {
            bytes[chroma_start + row * stride + column] = 128;
        }
    }
    bytes
}

#[test]
fn an_odd_edge_is_refused_because_chroma_cannot_describe_it() {
    assert_eq!(
        FrameGeometry::new(5, 4),
        Err(DecodeError::UnsupportedFrameLayout)
    );
    assert_eq!(
        FrameGeometry::new(4, 5),
        Err(DecodeError::UnsupportedFrameLayout)
    );
    assert_eq!(
        FrameGeometry::new(0, 4),
        Err(DecodeError::UnsupportedFrameLayout)
    );
}

#[test]
fn a_padded_buffer_reads_the_image_and_not_the_padding() {
    // The stride is a third wider than the frame, which is the shape a hardware decoder hands back.
    let stride = 6;
    let bytes = padded_frame(stride);
    let planes = NvPlanes::from_contiguous(&bytes, stride, geometry()).expect("a valid frame");

    for row in 0..4 {
        for column in 0..4 {
            assert_eq!(
                planes.luma_at(column, row),
                Some(u8::try_from(row * 16 + column).expect("a small sample")),
                "the sample at ({column}, {row}) came from the wrong place"
            );
        }
    }
    // Reading past the image must be refused rather than returning the padding behind it.
    assert_eq!(planes.luma_at(4, 0), None);
    assert_eq!(planes.luma_at(0, 4), None);
}

#[test]
fn the_same_image_converts_identically_at_every_stride() {
    // The property that makes the stride handling right: padding changes the buffer and must not
    // change one byte of the picture.
    let tight = padded_frame(4);
    let padded = padded_frame(6);
    let wide = padded_frame(64);

    let convert = |bytes: &[u8], stride: usize| {
        NvPlanes::from_contiguous(bytes, stride, geometry())
            .expect("a valid frame")
            .to_rgba8(SourceColorimetry::STUDIO_BT709)
    };

    let reference = convert(&tight, 4);
    assert_eq!(reference.len(), 4 * 4 * 4);
    assert_eq!(convert(&padded, 6), reference);
    assert_eq!(convert(&wide, 64), reference);
}

#[test]
fn chroma_is_shared_by_the_two_by_two_block_it_covers() {
    // 4:2:0 carries one chroma pair per four luma samples. Every one of the four must read the same
    // pair; a decoder that indexed chroma by pixel would halve the image horizontally.
    let stride = usize::try_from(WIDTH).expect("small");
    let mut bytes = padded_frame(stride);
    let chroma_start = stride * usize::try_from(HEIGHT).expect("small");
    // The top-left block gets a strong blue excursion, the rest stays neutral.
    bytes[chroma_start] = 220;
    bytes[chroma_start + 1] = 60;

    let planes = NvPlanes::from_contiguous(&bytes, stride, geometry()).expect("a valid frame");
    for (column, row) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        assert_eq!(planes.chroma_at(column, row), Some((220, 60)));
    }
    assert_eq!(planes.chroma_at(2, 0), Some((128, 128)));
    assert_eq!(planes.chroma_at(0, 2), Some((128, 128)));

    let pixels = planes.to_rgba8(SourceColorimetry::STUDIO_BT709);
    let pixel_at = |column: usize, row: usize| {
        let start = (row * 4 + column) * 4;
        [
            pixels[start],
            pixels[start + 1],
            pixels[start + 2],
            pixels[start + 3],
        ]
    };
    // The blue excursion is visible across the whole block and stops at its edge.
    assert!(pixel_at(0, 0)[2] > pixel_at(0, 0)[0]);
    assert!(pixel_at(1, 1)[2] > pixel_at(1, 1)[0]);
    assert_eq!(pixel_at(2, 2)[0], pixel_at(2, 2)[2]);
}

#[test]
fn every_decoded_pixel_is_opaque() {
    let stride = usize::try_from(WIDTH).expect("small");
    let bytes = padded_frame(stride);
    let pixels = NvPlanes::from_contiguous(&bytes, stride, geometry())
        .expect("a valid frame")
        .to_rgba8(SourceColorimetry::FULL_BT709);

    // Opaque throughout is what makes these bytes valid as both premultiplied and straight alpha,
    // which is what lets the compositor take them without a conversion nobody specified.
    for pixel in pixels.chunks_exact(4) {
        assert_eq!(pixel[3], 255);
    }
}

#[test]
fn a_buffer_shorter_than_its_frame_is_refused_with_both_lengths() {
    let stride = usize::try_from(WIDTH).expect("small");
    let bytes = padded_frame(stride);
    let truncated = &bytes[..bytes.len() - 1];

    // Not a panic and not a partial frame: a short buffer is a broken sample and says so.
    assert_eq!(
        NvPlanes::from_contiguous(truncated, stride, geometry()).unwrap_err(),
        DecodeError::SampleTooSmall {
            expected: 24,
            actual: 23,
        }
    );
}

#[test]
fn a_stride_narrower_than_the_frame_is_refused() {
    let bytes = vec![0_u8; 4096];
    assert_eq!(
        NvPlanes::from_contiguous(&bytes, 3, geometry()).unwrap_err(),
        DecodeError::UnsupportedFrameLayout
    );
}

#[test]
fn the_debug_view_of_a_frame_carries_no_pixels() {
    let stride = usize::try_from(WIDTH).expect("small");
    let bytes = padded_frame(stride);
    let planes = NvPlanes::from_contiguous(&bytes, stride, geometry()).expect("a valid frame");

    let debugged = format!("{planes:?}");
    assert!(debugged.contains("width"), "the debug view says nothing");
    // The user's video must not be reachable through a log line.
    assert!(
        !debugged.contains("luma: ["),
        "the debug view leaked pixels"
    );
    assert!(
        !debugged.contains("[0, 1, 2"),
        "the debug view leaked pixels"
    );
}
