//! The colour description every media type in this crate carries.
//!
//! The compositor emits full-range sRGB. Media Foundation's colour-conversion transform reads the
//! nominal range off the media type, and its default assumption is studio range: left undeclared,
//! it remaps 0-255 into 16-235 on the way into H.264 and the export comes back visibly washed out
//! against the preview it is required to match. The three attributes below are therefore set on
//! **both** the uncompressed input type and the encoded output type — declaring only one side lets
//! the transform reintroduce the same remap.
//!
//! The numeric values are the Media Foundation enumerants. They are spelled out here rather than
//! only referenced from the platform bindings so the pure half of the crate can be tested without
//! Media Foundation, and a Windows-only test asserts the bindings still agree with them.

/// `MFNominalRange_0_255` — the full 0-255 range, matching the compositor's output.
///
/// Note that this is *not* the largest enumerant: `MFNominalRange_16_235` is 2. Transposing the two
/// is the exact mistake this module exists to prevent.
pub const NOMINAL_RANGE_0_255: u32 = 1;

/// `MFVideoPrimaries_BT709` — the sRGB/Rec.709 primaries the compositor renders in.
pub const VIDEO_PRIMARIES_BT709: u32 = 2;

/// `MFVideoTransferMatrix_BT709` — the Rec.709 RGB-to-YCbCr matrix.
pub const TRANSFER_MATRIX_BT709: u32 = 1;

/// The colour description applied to an encoder media type.
///
/// A plain value with no platform types in it, so the choice can be asserted in a test that runs
/// anywhere, and so the platform backend has exactly one place to read it from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Colorimetry {
    /// The `MF_MT_VIDEO_NOMINAL_RANGE` value.
    pub nominal_range: u32,
    /// The `MF_MT_VIDEO_PRIMARIES` value.
    pub primaries: u32,
    /// The `MF_MT_YUV_MATRIX` value.
    pub transfer_matrix: u32,
}

impl Colorimetry {
    /// Full-range Rec.709: the only colour description this crate emits.
    pub const FULL_RANGE_BT709: Self = Self {
        nominal_range: NOMINAL_RANGE_0_255,
        primaries: VIDEO_PRIMARIES_BT709,
        transfer_matrix: TRANSFER_MATRIX_BT709,
    };
}

/// The colour description every OSG media type carries, input and output alike.
///
/// This is the named function the backend calls; it exists so the choice is made in one place and
/// can be asserted directly instead of being read out of two media-type builders.
#[must_use]
pub const fn full_range_bt709() -> Colorimetry {
    Colorimetry::FULL_RANGE_BT709
}
