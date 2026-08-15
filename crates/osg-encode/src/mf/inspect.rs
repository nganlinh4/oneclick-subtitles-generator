//! Reading back what the encoder actually wrote onto its media types.
//!
//! The colour description and the H.264 stream settings are the two parts of this crate that fail
//! *quietly* when they are wrong: the export still encodes, still plays, and is simply washed out
//! or slow to scrub. A test that only compared our constants to themselves would not catch a
//! mis-set attribute, so this module asks the platform what it stored and hands the answer back as
//! plain numbers.

use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_INTERLACE_MODE,
    MF_MT_MAX_KEYFRAME_SPACING, MF_MT_MPEG2_PROFILE, MF_MT_VIDEO_NOMINAL_RANGE,
    MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX,
};
use windows::core::GUID;

use crate::colorimetry::Colorimetry;
use crate::config::VideoConfig;
use crate::error::{EncodeError, MfStage};
use crate::mf::media_type::{encoded_video_type, uncompressed_video_type};
use crate::mf::platform::{ensure_media_foundation, platform_error};

/// What the encoder wrote onto the two video media types for a given configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoMediaTypeReadback {
    /// The colour description on the encoded H.264 type.
    pub encoded_colorimetry: Colorimetry,
    /// The colour description on the uncompressed BGRA type.
    pub uncompressed_colorimetry: Colorimetry,
    /// `MF_MT_MPEG2_PROFILE` on the encoded type.
    pub profile: u32,
    /// `MF_MT_INTERLACE_MODE` on the encoded type.
    pub encoded_interlace_mode: u32,
    /// `MF_MT_INTERLACE_MODE` on the uncompressed type.
    pub uncompressed_interlace_mode: u32,
    /// `MF_MT_MAX_KEYFRAME_SPACING` on the encoded type.
    pub max_keyframe_spacing: u32,
    /// `MF_MT_AVG_BITRATE` on the encoded type, in bits per second.
    pub average_bitrate: u32,
    /// `MF_MT_DEFAULT_STRIDE` on the uncompressed type. Positive means top-down rows.
    pub default_stride: u32,
}

/// Builds the two video media types a configuration implies and reads their settings back.
///
/// Windows only, and intended for tests and diagnostics: it starts the media platform, builds two
/// media types and drops them again. It writes nothing and opens no file.
///
/// # Errors
/// Returns [`EncodeError`] when the platform cannot be started, a media type cannot be built, or an
/// attribute the encoder is supposed to have set is missing.
pub fn read_back_video_media_types(
    config: VideoConfig,
) -> Result<VideoMediaTypeReadback, EncodeError> {
    ensure_media_foundation()?;
    let encoded = encoded_video_type(config)?;
    let uncompressed = uncompressed_video_type(config)?;

    Ok(VideoMediaTypeReadback {
        encoded_colorimetry: read_colorimetry(&encoded)?,
        uncompressed_colorimetry: read_colorimetry(&uncompressed)?,
        profile: read_u32(&encoded, &MF_MT_MPEG2_PROFILE)?,
        encoded_interlace_mode: read_u32(&encoded, &MF_MT_INTERLACE_MODE)?,
        uncompressed_interlace_mode: read_u32(&uncompressed, &MF_MT_INTERLACE_MODE)?,
        max_keyframe_spacing: read_u32(&encoded, &MF_MT_MAX_KEYFRAME_SPACING)?,
        average_bitrate: read_u32(&encoded, &MF_MT_AVG_BITRATE)?,
        default_stride: read_u32(&uncompressed, &MF_MT_DEFAULT_STRIDE)?,
    })
}

fn read_colorimetry(media_type: &IMFMediaType) -> Result<Colorimetry, EncodeError> {
    Ok(Colorimetry {
        nominal_range: read_u32(media_type, &MF_MT_VIDEO_NOMINAL_RANGE)?,
        primaries: read_u32(media_type, &MF_MT_VIDEO_PRIMARIES)?,
        transfer_matrix: read_u32(media_type, &MF_MT_YUV_MATRIX)?,
    })
}

fn read_u32(media_type: &IMFMediaType, key: &GUID) -> Result<u32, EncodeError> {
    // SAFETY: the key pointer is derived from a live borrow that outlasts the call, and the value is
    // returned by copy through the bindings' own out-parameter handling.
    unsafe { media_type.GetUINT32(key) }.map_err(|error| platform_error(MfStage::MediaType, &error))
}
