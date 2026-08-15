//! How the source's YCbCr samples become RGB, and why the answer is never assumed.
//!
//! This is the decode half of the problem `osg-encode`'s [`colorimetry`] module describes on the
//! encode side, and it fails the same way: a studio-range frame decoded as if it were full range
//! comes back washed out, and a full-range frame decoded as if it were studio range comes back with
//! crushed blacks and clipped highlights. Neither is subtle — it is every pixel of every frame —
//! and neither announces itself, because the image is still an image.
//!
//! Getting it right is only possible if the source is asked rather than guessed at, so the values
//! here come from `MF_MT_VIDEO_NOMINAL_RANGE` and `MF_MT_YUV_MATRIX` on the decoded media type.
//! When a source declares nothing, [`SourceColorimetry::assumed_for`] applies the one convention
//! the whole industry shares, and says out loud in its documentation that it is a convention. When
//! a source declares something this crate cannot reproduce faithfully, it is refused rather than
//! approximated.
//!
//! Everything in this module is pure integer arithmetic over plain numbers, so all of it is
//! testable without Media Foundation, a GPU or a media file.
//!
//! [`colorimetry`]: https://docs.rs/osg-encode

use crate::error::DecodeError;

/// `MFNominalRange_Unknown` — the source said nothing.
pub const MF_NOMINAL_RANGE_UNKNOWN: u32 = 0;
/// `MFNominalRange_0_255` — full range, where luma 0 is black and 255 is white.
pub const MF_NOMINAL_RANGE_0_255: u32 = 1;
/// `MFNominalRange_16_235` — studio range, where luma 16 is black and 235 is white.
///
/// Note that this is the *larger* enumerant. Transposing the two is the exact mistake this module
/// exists to prevent, on the decode side just as `osg-encode` prevents it on the encode side.
pub const MF_NOMINAL_RANGE_16_235: u32 = 2;

/// `MFVideoTransferMatrix_Unknown` — the source said nothing.
pub const MF_YUV_MATRIX_UNKNOWN: u32 = 0;
/// `MFVideoTransferMatrix_BT709` — the Rec.709 matrix, used by essentially all HD and later video.
pub const MF_YUV_MATRIX_BT709: u32 = 1;
/// `MFVideoTransferMatrix_BT601` — the Rec.601 matrix, used by standard-definition video.
pub const MF_YUV_MATRIX_BT601: u32 = 2;

/// The height at or above which an undeclared source is assumed to be Rec.709.
///
/// The convention every decoder shares: standard definition is Rec.601, high definition is Rec.709,
/// and 720 rows is the boundary between them.
pub const HIGH_DEFINITION_HEIGHT: u32 = 720;

/// How a source's luma and chroma samples use the 0-255 byte range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NominalRange {
    /// Luma runs 16-235 and chroma 16-240. What almost every camera and encoder produces.
    Studio,
    /// Luma and chroma run the full 0-255. What `osg-encode` writes, and what the compositor
    /// composes in.
    Full,
}

/// Which RGB-to-YCbCr matrix the source was encoded with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YuvMatrix {
    /// Rec.601: `Kr = 0.299`, `Kb = 0.114`. Standard definition.
    Bt601,
    /// Rec.709: `Kr = 0.2126`, `Kb = 0.0722`. High definition and everything after it.
    Bt709,
}

impl YuvMatrix {
    /// The red luma coefficient, `Kr`.
    #[must_use]
    pub const fn red_luma(self) -> f64 {
        match self {
            Self::Bt601 => 0.299,
            Self::Bt709 => 0.2126,
        }
    }

    /// The blue luma coefficient, `Kb`.
    #[must_use]
    pub const fn blue_luma(self) -> f64 {
        match self {
            Self::Bt601 => 0.114,
            Self::Bt709 => 0.0722,
        }
    }
}

/// The complete colour description one source is decoded with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceColorimetry {
    /// How the byte range is used.
    pub range: NominalRange,
    /// Which matrix converts luma and chroma back to RGB.
    pub matrix: YuvMatrix,
}

impl SourceColorimetry {
    /// Studio-range Rec.709: what a camera or a normal H.264 encode produces.
    pub const STUDIO_BT709: Self = Self {
        range: NominalRange::Studio,
        matrix: YuvMatrix::Bt709,
    };

    /// Full-range Rec.709: what `osg-encode` writes, so a re-import of an OSG export lands here.
    pub const FULL_BT709: Self = Self {
        range: NominalRange::Full,
        matrix: YuvMatrix::Bt709,
    };

    /// Studio-range Rec.601: standard-definition footage.
    pub const STUDIO_BT601: Self = Self {
        range: NominalRange::Studio,
        matrix: YuvMatrix::Bt601,
    };

    /// The description to use when the source declares nothing.
    ///
    /// Studio range, because compressed video that says nothing is studio range in overwhelming
    /// practice, and the matrix chosen by frame height, because that is the convention every other
    /// decoder follows. This is a convention, not a measurement; a caller that knows better
    /// overrides it rather than being silently overruled by it.
    #[must_use]
    pub const fn assumed_for(height: u32) -> Self {
        let matrix = if height >= HIGH_DEFINITION_HEIGHT {
            YuvMatrix::Bt709
        } else {
            YuvMatrix::Bt601
        };
        Self {
            range: NominalRange::Studio,
            matrix,
        }
    }

    /// Reads a colour description off the two Media Foundation attribute values.
    ///
    /// Either may be absent, which is what `None` means, and either may be present but zero, which
    /// is the platform's own "unknown". Both fall back to [`Self::assumed_for`].
    ///
    /// # Errors
    /// Returns [`DecodeError::UnsupportedColorimetry`] for a declared range or matrix this crate
    /// cannot reproduce faithfully — the narrow broadcast ranges, and the SMPTE 240M and Rec.2020
    /// matrices, which would need tone mapping this crate does not do.
    pub fn from_attributes(
        nominal_range: Option<u32>,
        yuv_matrix: Option<u32>,
        height: u32,
    ) -> Result<Self, DecodeError> {
        let assumed = Self::assumed_for(height);
        let range = match nominal_range {
            None | Some(MF_NOMINAL_RANGE_UNKNOWN) => assumed.range,
            Some(MF_NOMINAL_RANGE_0_255) => NominalRange::Full,
            Some(MF_NOMINAL_RANGE_16_235) => NominalRange::Studio,
            Some(_) => return Err(DecodeError::UnsupportedColorimetry),
        };
        let matrix = match yuv_matrix {
            None | Some(MF_YUV_MATRIX_UNKNOWN) => assumed.matrix,
            Some(MF_YUV_MATRIX_BT709) => YuvMatrix::Bt709,
            Some(MF_YUV_MATRIX_BT601) => YuvMatrix::Bt601,
            Some(_) => return Err(DecodeError::UnsupportedColorimetry),
        };
        Ok(Self { range, matrix })
    }
}

/// The fractional bits the conversion coefficients carry.
const FRACTIONAL_BITS: u32 = 16;
/// One, in the conversion's fixed-point units.
const ONE: i32 = 1 << FRACTIONAL_BITS;
/// Half, for rounding to nearest on the way back to bytes.
const HALF: i32 = ONE / 2;

/// Studio luma runs 16-235, so 219 levels carry the whole 0-255 output range.
const STUDIO_LUMA_LEVELS: f64 = 219.0;
/// Studio chroma runs 16-240, so 224 levels carry the whole signed excursion.
const STUDIO_CHROMA_LEVELS: f64 = 224.0;
/// The full 8-bit excursion both studio scalings are expressed against.
const FULL_LEVELS: f64 = 255.0;
/// The neutral chroma sample: no colour.
const CHROMA_NEUTRAL: i32 = 128;

/// One source's YCbCr-to-RGB conversion, resolved to integers.
///
/// Built once per frame and then applied per pixel in integer arithmetic, so the conversion is
/// deterministic: the same sample produces the same byte on every machine and in every run, which
/// is what lets a decoded underlay be compared frame by frame at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YuvToRgb {
    luma_offset: i32,
    luma_scale: i32,
    chroma_to_red: i32,
    chroma_to_green_from_blue: i32,
    chroma_to_green_from_red: i32,
    chroma_to_blue: i32,
}

impl YuvToRgb {
    /// Resolves `colorimetry` into the integer coefficients the per-pixel conversion uses.
    ///
    /// The derivation is written out rather than tabulated so the numbers can be checked against
    /// the standard they come from: `R = Y + 2(1 - Kr)Cr`, `B = Y + 2(1 - Kb)Cb`, and the green
    /// coefficients that follow from `Kg = 1 - Kr - Kb`.
    #[must_use]
    pub fn new(colorimetry: SourceColorimetry) -> Self {
        let red_luma = colorimetry.matrix.red_luma();
        let blue_luma = colorimetry.matrix.blue_luma();
        let green_luma = 1.0 - red_luma - blue_luma;

        let (luma_offset, luma_scale, chroma_scale) = match colorimetry.range {
            NominalRange::Full => (0, 1.0, 1.0),
            NominalRange::Studio => (
                16,
                FULL_LEVELS / STUDIO_LUMA_LEVELS,
                FULL_LEVELS / STUDIO_CHROMA_LEVELS,
            ),
        };

        let to_red = 2.0 * (1.0 - red_luma);
        let to_blue = 2.0 * (1.0 - blue_luma);

        Self {
            luma_offset,
            luma_scale: to_fixed(luma_scale),
            chroma_to_red: to_fixed(to_red * chroma_scale),
            chroma_to_green_from_blue: to_fixed(to_blue * blue_luma / green_luma * chroma_scale),
            chroma_to_green_from_red: to_fixed(to_red * red_luma / green_luma * chroma_scale),
            chroma_to_blue: to_fixed(to_blue * chroma_scale),
        }
    }

    /// Converts one YCbCr sample to opaque RGB.
    ///
    /// Out-of-range inputs are clamped rather than refused: a studio-range source is allowed to
    /// carry footroom and headroom samples, and the correct thing to show for them is black and
    /// white, not an error.
    #[must_use]
    pub fn pixel(self, luma: u8, blue_chroma: u8, red_chroma: u8) -> [u8; 3] {
        let luma = (i32::from(luma) - self.luma_offset) * self.luma_scale;
        let blue = i32::from(blue_chroma) - CHROMA_NEUTRAL;
        let red = i32::from(red_chroma) - CHROMA_NEUTRAL;

        [
            to_byte(luma + self.chroma_to_red * red),
            to_byte(
                luma - self.chroma_to_green_from_blue * blue - self.chroma_to_green_from_red * red,
            ),
            to_byte(luma + self.chroma_to_blue * blue),
        ]
    }
}

/// Rounds a coefficient into the conversion's fixed-point units.
///
/// Every argument is a standard-derived constant below four, so the product is far inside `i32`.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the arguments are colour coefficients below four, so the scaled value is below 2^18"
)]
fn to_fixed(value: f64) -> i32 {
    (value * f64::from(ONE) + 0.5) as i32
}

/// Rounds a fixed-point channel back to a byte, clamping the excursions a legal source may carry.
#[expect(
    clippy::cast_sign_loss,
    reason = "the value is clamped to 0..=255 before the cast, so it is never negative"
)]
fn to_byte(fixed: i32) -> u8 {
    (((fixed + HALF) >> FRACTIONAL_BITS).clamp(0, 255)) as u8
}
