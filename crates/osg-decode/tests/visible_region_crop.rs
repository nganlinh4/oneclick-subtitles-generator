//! Converting only the picture inside a padded surface.
//!
//! These build the exact shape a decoder hands back for an ordinary 360p video — a 640x368 NV12
//! buffer holding 360 rows of picture — and check that the rows below the picture never reach the
//! output. A test that only compared sizes would pass while shipping a band of encoder leftovers
//! along the bottom edge, so the padding here is filled with a colour nothing else uses and the
//! result is searched for it.

use osg_decode::{FrameGeometry, NvPlanes, SourceColorimetry, VisibleRegion};

/// Luma and chroma values for the padding, chosen to convert to a colour the picture never contains.
const PADDING_LUMA: u8 = 255;
const PADDING_CHROMA: u8 = 255;

/// Luma and chroma for the picture: mid grey, so any padding bleed is obvious.
const PICTURE_LUMA: u8 = 128;
const PICTURE_CHROMA: u8 = 128;

fn geometry(width: u32, height: u32) -> FrameGeometry {
    FrameGeometry::new(width, height).expect("geometry")
}

/// An NV12 buffer whose first `picture_rows` rows are picture and whose remainder is padding.
fn padded_surface(surface: FrameGeometry, picture_rows: usize) -> Vec<u8> {
    let stride = surface.width();
    let mut bytes = vec![0_u8; stride * surface.height() + stride * surface.chroma_rows()];

    let (luma, chroma) = bytes.split_at_mut(stride * surface.height());
    for row in 0..surface.height() {
        let value = if row < picture_rows {
            PICTURE_LUMA
        } else {
            PADDING_LUMA
        };
        luma[row * stride..][..stride].fill(value);
    }
    for row in 0..surface.chroma_rows() {
        let value = if row * 2 < picture_rows {
            PICTURE_CHROMA
        } else {
            PADDING_CHROMA
        };
        chroma[row * stride..][..stride].fill(value);
    }
    bytes
}

fn pixel(pixels: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
    let start = (y * width + x) * 4;
    [
        pixels[start],
        pixels[start + 1],
        pixels[start + 2],
        pixels[start + 3],
    ]
}

#[test]
fn the_padding_rows_of_a_640x360_surface_never_reach_the_output() {
    let surface = geometry(640, 368);
    let bytes = padded_surface(surface, 360);
    let planes = NvPlanes::from_contiguous(&bytes, surface.width(), surface).expect("planes");
    let region = VisibleRegion::new(0, 0, geometry(640, 360), surface).expect("region");

    let pixels = planes.region_to_rgba8(SourceColorimetry::STUDIO_BT709, region);
    assert_eq!(pixels.len(), geometry(640, 360).rgba_bytes());

    // The last row of the output must be picture, not the padding that sits under it.
    let last = pixel(&pixels, 640, 320, 359);
    let first = pixel(&pixels, 640, 320, 0);
    assert_eq!(
        last, first,
        "the bottom row of the picture must match the top; padding has leaked in",
    );

    // And nothing anywhere may be the padding colour.
    let padded = NvPlanes::from_contiguous(&bytes, surface.width(), surface)
        .expect("planes")
        .to_rgba8(SourceColorimetry::STUDIO_BT709);
    let padding_pixel = pixel(&padded, 640, 320, 365);
    assert!(
        !pixels.chunks_exact(4).any(|chunk| chunk == padding_pixel),
        "a padding pixel appeared in the cropped output",
    );
}

#[test]
fn a_1080p_surface_crops_to_exactly_1080_rows() {
    // 1080 is not a multiple of sixteen either, so this is the same defect at the size most video
    // actually is.
    let surface = geometry(1920, 1088);
    let bytes = padded_surface(surface, 1080);
    let planes = NvPlanes::from_contiguous(&bytes, surface.width(), surface).expect("planes");
    let region = VisibleRegion::new(0, 0, geometry(1920, 1080), surface).expect("region");

    let pixels = planes.region_to_rgba8(SourceColorimetry::STUDIO_BT709, region);
    assert_eq!(pixels.len(), geometry(1920, 1080).rgba_bytes());
    assert_eq!(pixel(&pixels, 1920, 0, 1079), pixel(&pixels, 1920, 0, 0));
}

#[test]
fn an_unpadded_surface_converts_exactly_as_before() {
    // The ordinary path must be untouched: an aligned source has no crop to apply.
    let surface = geometry(640, 480);
    let bytes = padded_surface(surface, 480);
    let planes = NvPlanes::from_contiguous(&bytes, surface.width(), surface).expect("planes");

    let whole = planes.to_rgba8(SourceColorimetry::STUDIO_BT709);
    let region = planes.region_to_rgba8(
        SourceColorimetry::STUDIO_BT709,
        VisibleRegion::whole(surface),
    );
    assert_eq!(whole, region);
}

#[test]
fn a_region_with_a_nonzero_origin_takes_the_right_rectangle() {
    let surface = geometry(64, 64);
    let stride = surface.width();
    let mut bytes = vec![0_u8; stride * surface.height() + stride * surface.chroma_rows()];
    let (luma, chroma) = bytes.split_at_mut(stride * surface.height());
    // A luma ramp, so the crop's origin is visible in the values themselves.
    for row in 0..surface.height() {
        for column in 0..stride {
            luma[row * stride + column] = u8::try_from((row + column) % 256).expect("byte");
        }
    }
    chroma.fill(128);

    let planes = NvPlanes::from_contiguous(&bytes, stride, surface).expect("planes");
    let region = VisibleRegion::new(8, 4, geometry(16, 16), surface).expect("region");
    let pixels = planes.region_to_rgba8(SourceColorimetry::STUDIO_BT709, region);

    // The top-left of the crop must be the source sample at (8, 4), not at (0, 0).
    let whole = planes.to_rgba8(SourceColorimetry::STUDIO_BT709);
    assert_eq!(pixel(&pixels, 16, 0, 0), pixel(&whole, 64, 8, 4));
    assert_eq!(pixel(&pixels, 16, 15, 15), pixel(&whole, 64, 23, 19));
}
