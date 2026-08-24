//! Building the four media types an OSG export needs.
//!
//! Two per stream: the encoded type registered on the sink writer, and the uncompressed type the
//! caller feeds in. Both video types carry explicit colour descriptions; the DXGI path uses a
//! different truthful output range from the CPU path. See [`crate::colorimetry`].
//!
//! All `unsafe` in this file is confined to the three attribute-setter helpers at the bottom, so
//! there is exactly one place a reviewer has to check for the whole media-type surface.

use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFMediaType, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_VIDEO_NOMINAL_RANGE,
    MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX, MFAudioFormat_AAC, MFAudioFormat_Float,
    MFCreateMediaType, MFMediaType_Audio, MFMediaType_Video, MFVideoFormat_ARGB32,
    MFVideoFormat_H264, MFVideoInterlace_Progressive, eAVEncH264VProfile_High,
};
use windows::core::GUID;

use crate::colorimetry::{Colorimetry, full_range_bt709, studio_range_bt709};
use crate::config::{AudioConfig, VideoConfig};
use crate::error::{EncodeError, MfStage};
use crate::mf::platform::platform_error;

/// Applies full-range Rec.709 to a video media type.
///
/// The one place the colour description is written. Failures propagate rather than being swallowed:
/// the reference ignores them, but for OSG a media type that silently kept studio range produces an
/// export visibly washed out against its preview, which is precisely the defect this renderer
/// migration exists to remove.
///
/// # Errors
/// Returns [`EncodeError::MediaFoundation`] when the platform refuses an attribute.
pub(crate) fn apply_full_range_bt709(media_type: &IMFMediaType) -> Result<(), EncodeError> {
    apply_colorimetry(media_type, full_range_bt709())
}

fn apply_colorimetry(
    media_type: &IMFMediaType,
    colorimetry: Colorimetry,
) -> Result<(), EncodeError> {
    let stage = MfStage::MediaType;
    set_u32(
        media_type,
        &MF_MT_VIDEO_NOMINAL_RANGE,
        colorimetry.nominal_range,
        stage,
    )?;
    set_u32(
        media_type,
        &MF_MT_VIDEO_PRIMARIES,
        colorimetry.primaries,
        stage,
    )?;
    set_u32(
        media_type,
        &MF_MT_YUV_MATRIX,
        colorimetry.transfer_matrix,
        stage,
    )
}

/// The encoded H.264 type registered on the sink writer.
pub(crate) fn encoded_video_type(config: VideoConfig) -> Result<IMFMediaType, EncodeError> {
    encoded_video_type_with_colorimetry(config, full_range_bt709())
}

/// H.264 output type for GPU-resident DXGI input.
///
/// Intel's Windows hardware transform was measured to emit studio-range samples from BGRA DXGI
/// surfaces even when the surface type itself is full-range. Describing that stream as full-range
/// expands video levels twice on decode. This media type records what the hardware actually emits.
pub(crate) fn encoded_gpu_video_type(config: VideoConfig) -> Result<IMFMediaType, EncodeError> {
    encoded_video_type_with_colorimetry(config, studio_range_bt709())
}

fn encoded_video_type_with_colorimetry(
    config: VideoConfig,
    colorimetry: Colorimetry,
) -> Result<IMFMediaType, EncodeError> {
    let media_type = create_media_type()?;
    let stage = MfStage::MediaType;

    set_guid(&media_type, &MF_MT_MAJOR_TYPE, &MFMediaType_Video, stage)?;
    set_guid(&media_type, &MF_MT_SUBTYPE, &MFVideoFormat_H264, stage)?;
    set_u32(
        &media_type,
        &MF_MT_AVG_BITRATE,
        config.bitrate_kbps().saturating_mul(1000),
        stage,
    )?;
    set_u64(
        &media_type,
        &MF_MT_FRAME_SIZE,
        packed_frame_size(config),
        stage,
    )?;
    set_u64(
        &media_type,
        &MF_MT_FRAME_RATE,
        packed_frame_rate(config),
        stage,
    )?;
    set_u64(
        &media_type,
        &MF_MT_PIXEL_ASPECT_RATIO,
        pack_ratio(1, 1),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_MAX_KEYFRAME_SPACING,
        config.keyframe_interval(),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_INTERLACE_MODE,
        interlace_progressive(),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_MPEG2_PROFILE,
        h264_high_profile(),
        stage,
    )?;
    apply_colorimetry(&media_type, colorimetry)?;

    Ok(media_type)
}

/// The uncompressed BGRA type the caller's frames are declared as.
pub(crate) fn uncompressed_video_type(config: VideoConfig) -> Result<IMFMediaType, EncodeError> {
    let media_type = create_media_type()?;
    let stage = MfStage::MediaType;

    set_guid(&media_type, &MF_MT_MAJOR_TYPE, &MFMediaType_Video, stage)?;
    set_guid(&media_type, &MF_MT_SUBTYPE, &MFVideoFormat_ARGB32, stage)?;
    set_u64(
        &media_type,
        &MF_MT_FRAME_SIZE,
        packed_frame_size(config),
        stage,
    )?;
    set_u64(
        &media_type,
        &MF_MT_FRAME_RATE,
        packed_frame_rate(config),
        stage,
    )?;
    set_u64(
        &media_type,
        &MF_MT_PIXEL_ASPECT_RATIO,
        pack_ratio(1, 1),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_INTERLACE_MODE,
        interlace_progressive(),
        stage,
    )?;
    set_u32(&media_type, &MF_MT_ALL_SAMPLES_INDEPENDENT, 1, stage)?;
    // A positive stride declares top-down rows. The platform's default for a 32-bit RGB type is
    // bottom-up, and the compositor reads back top row first, so leaving this unset flips every
    // exported frame vertically.
    set_u32(
        &media_type,
        &MF_MT_DEFAULT_STRIDE,
        top_down_stride(config),
        stage,
    )?;
    apply_full_range_bt709(&media_type)?;

    Ok(media_type)
}

/// The encoded AAC type registered on the sink writer.
pub(crate) fn encoded_audio_type(config: AudioConfig) -> Result<IMFMediaType, EncodeError> {
    let media_type = create_media_type()?;
    let stage = MfStage::MediaType;

    set_guid(&media_type, &MF_MT_MAJOR_TYPE, &MFMediaType_Audio, stage)?;
    set_guid(&media_type, &MF_MT_SUBTYPE, &MFAudioFormat_AAC, stage)?;
    set_u32(&media_type, &MF_MT_AUDIO_BITS_PER_SAMPLE, 16, stage)?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_SAMPLES_PER_SECOND,
        config.sample_rate().hz(),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_NUM_CHANNELS,
        config.channels().count(),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
        config.bitrate().bytes_per_second(),
        stage,
    )?;

    Ok(media_type)
}

/// The uncompressed 32-bit float PCM type the caller's audio blocks are declared as.
pub(crate) fn uncompressed_audio_type(config: AudioConfig) -> Result<IMFMediaType, EncodeError> {
    let media_type = create_media_type()?;
    let stage = MfStage::MediaType;
    let block_align = config.input_block_align();

    set_guid(&media_type, &MF_MT_MAJOR_TYPE, &MFMediaType_Audio, stage)?;
    set_guid(&media_type, &MF_MT_SUBTYPE, &MFAudioFormat_Float, stage)?;
    set_u32(&media_type, &MF_MT_AUDIO_BITS_PER_SAMPLE, 32, stage)?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_SAMPLES_PER_SECOND,
        config.sample_rate().hz(),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_NUM_CHANNELS,
        config.channels().count(),
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_BLOCK_ALIGNMENT,
        block_align,
        stage,
    )?;
    set_u32(
        &media_type,
        &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
        config.sample_rate().hz().saturating_mul(block_align),
        stage,
    )?;

    Ok(media_type)
}

/// `MF_MT_FRAME_SIZE` packs width into the high half and height into the low half.
fn packed_frame_size(config: VideoConfig) -> u64 {
    pack_ratio(config.width(), config.height())
}

/// `MF_MT_FRAME_RATE` packs the numerator into the high half and the denominator into the low half.
fn packed_frame_rate(config: VideoConfig) -> u64 {
    pack_ratio(config.fps_numerator(), config.fps_denominator())
}

fn pack_ratio(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// The row stride of a top-down BGRA frame.
///
/// `VideoConfig` caps the width at 7680, so the product is far inside `u32`.
fn top_down_stride(config: VideoConfig) -> u32 {
    config.width().saturating_mul(4)
}

fn interlace_progressive() -> u32 {
    MFVideoInterlace_Progressive.0.cast_unsigned()
}

fn h264_high_profile() -> u32 {
    eAVEncH264VProfile_High.0.cast_unsigned()
}

fn create_media_type() -> Result<IMFMediaType, EncodeError> {
    // SAFETY: `MFCreateMediaType` takes no arguments, borrows nothing and hands back an owned
    // reference-counted interface that the bindings release on drop. The Media Foundation platform
    // is started before any media type is built.
    unsafe { MFCreateMediaType() }.map_err(|error| platform_error(MfStage::MediaType, &error))
}

pub(crate) fn set_guid(
    attributes: &IMFAttributes,
    key: &GUID,
    value: &GUID,
    stage: MfStage,
) -> Result<(), EncodeError> {
    // SAFETY: both pointers are derived from live borrows that outlast the call, and the attribute
    // store copies the GUIDs rather than retaining the pointers.
    unsafe { attributes.SetGUID(key, value) }.map_err(|error| platform_error(stage, &error))
}

pub(crate) fn set_u32(
    attributes: &IMFAttributes,
    key: &GUID,
    value: u32,
    stage: MfStage,
) -> Result<(), EncodeError> {
    // SAFETY: the key pointer is derived from a live borrow that outlasts the call, and the value
    // is passed by copy.
    unsafe { attributes.SetUINT32(key, value) }.map_err(|error| platform_error(stage, &error))
}

fn set_u64(
    attributes: &IMFAttributes,
    key: &GUID,
    value: u64,
    stage: MfStage,
) -> Result<(), EncodeError> {
    // SAFETY: the key pointer is derived from a live borrow that outlasts the call, and the value
    // is passed by copy.
    unsafe { attributes.SetUINT64(key, value) }.map_err(|error| platform_error(stage, &error))
}
