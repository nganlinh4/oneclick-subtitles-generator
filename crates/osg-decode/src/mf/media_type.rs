//! Asking the source reader what the file is, and telling it what to decode into.
//!
//! All `unsafe` in this file is confined to the small accessor helpers at the bottom, so there is
//! exactly one place a reviewer has to check for the whole media-type surface.
//!
//! The output format is **NV12**, and the conversion to RGBA8 is done in [`crate::planes`] rather
//! than by asking the reader for RGB32. That is a deliberate cost: the platform's own converter
//! would take the colour decision out of our hands, and the colour decision is precisely the one
//! that has to be visible, testable and refusable. NV12 is also what every hardware decoder
//! produces natively, so asking for it is the path with no hidden transform in it at all.

use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFDXGIDeviceManager, IMFMediaType, IMFSourceReader, MF_MT_DEFAULT_STRIDE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_GEOMETRIC_APERTURE, MF_MT_MAJOR_TYPE,
    MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_ROTATION, MF_MT_YUV_MATRIX, MF_PD_DURATION,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_D3D_MANAGER, MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READER_MEDIASOURCE, MFCreateAttributes,
    MFCreateMediaType, MFMediaType_Video, MFVideoFormat_NV12,
};
use windows::core::GUID;

use crate::error::{DecodeError, MfStage};
use crate::mf::platform::platform_error;

/// The reader stream index that means "the first video stream".
pub(crate) fn first_video_stream() -> u32 {
    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0.cast_unsigned()
}

/// The reader stream index that means "every stream".
fn all_streams() -> u32 {
    MF_SOURCE_READER_ALL_STREAMS.0.cast_unsigned()
}

/// The reader stream index that means "the media source itself".
fn media_source() -> u32 {
    MF_SOURCE_READER_MEDIASOURCE.0.cast_unsigned()
}

/// The source reader's attribute store.
///
/// Hardware transforms are enabled so the decode uses the machine's video decoder when it has one.
/// Advanced video processing lets the reader insert the platform's converter when a source's native
/// output is not already NV12 — this build attaches no DXGI device manager, with which that
/// attribute is mutually exclusive, so the combination the reference had to avoid cannot arise
/// here.
pub(crate) fn reader_attributes() -> Result<IMFAttributes, DecodeError> {
    reader_attributes_inner(None)
}

/// The source reader's GPU attribute store.
pub(crate) fn gpu_reader_attributes(
    manager: &IMFDXGIDeviceManager,
) -> Result<IMFAttributes, DecodeError> {
    reader_attributes_inner(Some(manager))
}

fn reader_attributes_inner(
    manager: Option<&IMFDXGIDeviceManager>,
) -> Result<IMFAttributes, DecodeError> {
    let mut store: Option<IMFAttributes> = None;
    // SAFETY: the out-parameter is a live local for the duration of the call, and the count is the
    // number of attributes the store is sized for, not a length the platform reads through.
    unsafe { MFCreateAttributes(&raw mut store, 3) }
        .map_err(|error| platform_error(MfStage::ReaderAttributes, &error))?;
    let store = store.ok_or(DecodeError::MediaFoundation {
        stage: MfStage::ReaderAttributes,
        code: 0,
    })?;

    let stage = MfStage::ReaderAttributes;
    if let Some(manager) = manager {
        // SAFETY: both values are live COM interfaces. The attribute store retains its own
        // reference to the manager instead of borrowing it after this call.
        unsafe { store.SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, manager) }
            .map_err(|error| platform_error(stage, &error))?;
    }
    set_u32(&store, &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1, stage)?;
    set_u32(
        &store,
        &MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,
        1,
        stage,
    )?;
    Ok(store)
}

/// Deselects every stream and selects only the video stream.
///
/// Audio is decoded by `osg-audio` in pure Rust, because the mix has to be bit-reproducible in a
/// way a hardware decoder does not promise. Leaving the audio stream selected here would decode it
/// twice and throw one copy away.
pub(crate) fn select_video_only(reader: &IMFSourceReader, stream: u32) -> Result<(), DecodeError> {
    // SAFETY: the reader is live for the duration of the call and both arguments are passed by
    // value. Deselecting every stream cannot fail partially: the call either applies or reports.
    unsafe { reader.SetStreamSelection(all_streams(), false) }
        .map_err(|error| platform_error(MfStage::StreamSelection, &error))?;
    // SAFETY: as above, on the one stream this decoder reads.
    unsafe { reader.SetStreamSelection(stream, true) }
        .map_err(|error| platform_error(MfStage::StreamSelection, &error))
}

/// Tells the reader to decode into NV12.
pub(crate) fn request_nv12_output(
    reader: &IMFSourceReader,
    stream: u32,
) -> Result<(), DecodeError> {
    // SAFETY: `MFCreateMediaType` takes no arguments, borrows nothing and hands back an owned
    // reference-counted interface that the bindings release on drop.
    let media_type = unsafe { MFCreateMediaType() }
        .map_err(|error| platform_error(MfStage::MediaType, &error))?;

    set_guid(
        &media_type,
        &MF_MT_MAJOR_TYPE,
        &MFMediaType_Video,
        MfStage::MediaType,
    )?;
    set_guid(
        &media_type,
        &MF_MT_SUBTYPE,
        &MFVideoFormat_NV12,
        MfStage::MediaType,
    )?;

    // SAFETY: both interfaces are live for the duration of the call; `None` is the documented value
    // for the reserved parameter, and the reader copies what it needs from the media type.
    unsafe { reader.SetCurrentMediaType(stream, None, &media_type) }
        .map_err(|error| platform_error(MfStage::OutputMediaType, &error))
}

/// The reader's current output type for `stream`.
pub(crate) fn current_output_type(
    reader: &IMFSourceReader,
    stream: u32,
) -> Result<IMFMediaType, DecodeError> {
    // SAFETY: the reader is live for the duration of the call and the returned interface is owned.
    unsafe { reader.GetCurrentMediaType(stream) }
        .map_err(|error| platform_error(MfStage::OutputMediaType, &error))
}

/// The source's own, undecoded type for `stream`.
///
/// Read for the frame rate and the colour description, both of which describe the file rather than
/// the decode and are therefore more trustworthy here than on the negotiated output type.
pub(crate) fn native_type(
    reader: &IMFSourceReader,
    stream: u32,
) -> Result<IMFMediaType, DecodeError> {
    // SAFETY: the reader is live for the duration of the call, index zero is the first described
    // format, and the returned interface is owned.
    unsafe { reader.GetNativeMediaType(stream, 0) }.map_err(|_| DecodeError::NoVideoStream)
}

/// The frame size a media type declares, as `(width, height)`.
///
/// `MF_MT_FRAME_SIZE` packs width into the high half of a `u64` and height into the low half.
pub(crate) fn frame_size(media_type: &IMFMediaType) -> Result<(u32, u32), DecodeError> {
    let packed = read_u64(media_type, &MF_MT_FRAME_SIZE).ok_or(DecodeError::NoVideoStream)?;
    Ok(unpack_ratio(packed))
}

/// A rectangle of valid picture inside a decoded surface, in whole pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ApertureRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Which aperture attribute a rectangle came from, so precedence is visible in a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApertureSource {
    /// The region documented as containing valid image data.
    MinimumDisplay,
    /// The active picture intended for display with the pixel aspect applied.
    Geometric,
}

/// The apertures a media type declares, most authoritative first.
///
/// Media Foundation describes the valid picture inside a decoded surface with `MFVideoArea`
/// attributes rather than with the frame size: `MF_MT_MINIMUM_DISPLAY_APERTURE` is documented as the
/// region containing valid image data, and `MF_MT_GEOMETRIC_APERTURE` as the active picture intended
/// for display with the pixel aspect ratio applied. A decoder is free to hand back a surface larger
/// than either -- H.264 codes in sixteen-pixel macroblocks, so a 640x360 stream decodes into a
/// 640x368 surface -- and reading `MF_MT_FRAME_SIZE` alone cannot tell the picture from the padding.
///
/// Returned in preference order rather than as one answer, because the caller also has the native
/// type to fall back to and is the only place that knows what the whole surface is.
pub(crate) fn apertures(media_type: &IMFMediaType) -> Vec<(ApertureSource, ApertureRect)> {
    [
        (
            ApertureSource::MinimumDisplay,
            MF_MT_MINIMUM_DISPLAY_APERTURE,
        ),
        (ApertureSource::Geometric, MF_MT_GEOMETRIC_APERTURE),
    ]
    .into_iter()
    .filter_map(|(source, key)| read_video_area(media_type, &key).map(|rect| (source, rect)))
    .collect()
}

/// Reads an `MFVideoArea` blob.
///
/// The layout is fixed by the platform: an offset pair in 16.16 fixed point, then a signed 32-bit
/// width and height. The fractional part of an offset is discarded deliberately -- a sub-pixel
/// origin cannot address a chroma sample, and rounding it away is what every consumer of this
/// attribute does. A blob shorter than the structure, or one describing a negative extent, is
/// treated as absent rather than repaired.
fn read_video_area(media_type: &IMFMediaType, key: &GUID) -> Option<ApertureRect> {
    const VIDEO_AREA_BYTES: usize = 16;
    let mut blob = [0_u8; VIDEO_AREA_BYTES];
    let mut written = 0_u32;
    // SAFETY: the key and the buffer are live borrows that outlast the call, the buffer length is
    // passed as its true size, and the written length is inspected rather than assumed.
    let read = unsafe { media_type.GetBlob(key, &mut blob, Some(&raw mut written)) };
    if read.is_err() || written as usize != VIDEO_AREA_BYTES {
        return None;
    }

    let whole = |offset: usize| {
        i32::from_le_bytes([
            blob[offset],
            blob[offset + 1],
            blob[offset + 2],
            blob[offset + 3],
        ])
    };
    // 16.16 fixed point: the whole-pixel part is the high half.
    let x = whole(0) >> 16;
    let y = whole(4) >> 16;
    let width = whole(8);
    let height = whole(12);
    if x < 0 || y < 0 || width <= 0 || height <= 0 {
        return None;
    }
    Some(ApertureRect {
        x: x.cast_unsigned(),
        y: y.cast_unsigned(),
        width: width.cast_unsigned(),
        height: height.cast_unsigned(),
    })
}

/// The frame rate a media type declares, as `(numerator, denominator)`.
///
/// Absent on some sources — a still image stream, or a container that simply does not say — which
/// is why the caller has to decide what to do about it rather than being handed a zero.
pub(crate) fn frame_rate(media_type: &IMFMediaType) -> Option<(u32, u32)> {
    let (numerator, denominator) = unpack_ratio(read_u64(media_type, &MF_MT_FRAME_RATE)?);
    if numerator == 0 || denominator == 0 {
        return None;
    }
    Some((numerator, denominator))
}

/// The row stride a media type declares, when it declares one.
///
/// Stored as a `UINT32` holding a signed value: negative means the rows run bottom-up.
pub(crate) fn default_stride(media_type: &IMFMediaType) -> Option<i32> {
    read_u32(media_type, &MF_MT_DEFAULT_STRIDE).map(u32::cast_signed)
}

/// The pixel aspect ratio a media type declares, as `(numerator, denominator)`.
///
/// `MF_MT_PIXEL_ASPECT_RATIO` is packed like every other Media Foundation ratio: the width term in
/// the high half of a `u64`, the height term in the low half. Absent on most files, which is a
/// statement that the pixels are square rather than a gap to fill in.
pub(crate) fn pixel_aspect_ratio(media_type: &IMFMediaType) -> Option<(u32, u32)> {
    Some(unpack_ratio(read_u64(
        media_type,
        &MF_MT_PIXEL_ASPECT_RATIO,
    )?))
}

/// The rotation a media type declares, in degrees already applied anticlockwise.
///
/// See [`crate::Rotation`] for what the value means and which way it has to be undone.
pub(crate) fn video_rotation(media_type: &IMFMediaType) -> Option<u32> {
    read_u32(media_type, &MF_MT_VIDEO_ROTATION)
}

/// The `MF_MT_VIDEO_NOMINAL_RANGE` and `MF_MT_YUV_MATRIX` values a media type declares.
pub(crate) fn colour_attributes(media_type: &IMFMediaType) -> (Option<u32>, Option<u32>) {
    (
        read_u32(media_type, &MF_MT_VIDEO_NOMINAL_RANGE),
        read_u32(media_type, &MF_MT_YUV_MATRIX),
    )
}

/// The source's declared duration in 100ns units.
pub(crate) fn duration_100ns(reader: &IMFSourceReader) -> Result<i64, DecodeError> {
    // SAFETY: the reader is live for the duration of the call, the attribute key is a static GUID,
    // and the returned `PROPVARIANT` is owned by the local that receives it and cleared on drop.
    let value = unsafe { reader.GetPresentationAttribute(media_source(), &MF_PD_DURATION) }
        .map_err(|error| platform_error(MfStage::PresentationAttribute, &error))?;
    let hundred_nanos = u64::try_from(&value)
        .map_err(|error| platform_error(MfStage::PresentationAttribute, &error))?;
    i64::try_from(hundred_nanos).map_err(|_| DecodeError::SourceOutOfBounds {
        bound: crate::error::SourceBound::Duration,
    })
}

/// Splits a packed Media Foundation ratio into its high and low halves.
fn unpack_ratio(packed: u64) -> (u32, u32) {
    let high = u32::try_from(packed >> 32).unwrap_or(0);
    let low = u32::try_from(packed & 0xFFFF_FFFF).unwrap_or(0);
    (high, low)
}

fn set_guid(
    attributes: &IMFAttributes,
    key: &GUID,
    value: &GUID,
    stage: MfStage,
) -> Result<(), DecodeError> {
    // SAFETY: both pointers are derived from live borrows that outlast the call, and the attribute
    // store copies the GUIDs rather than retaining the pointers.
    unsafe { attributes.SetGUID(key, value) }.map_err(|error| platform_error(stage, &error))
}

fn set_u32(
    attributes: &IMFAttributes,
    key: &GUID,
    value: u32,
    stage: MfStage,
) -> Result<(), DecodeError> {
    // SAFETY: the key pointer is derived from a live borrow that outlasts the call, and the value
    // is passed by copy.
    unsafe { attributes.SetUINT32(key, value) }.map_err(|error| platform_error(stage, &error))
}

/// Reads an optional `UINT32` attribute.
///
/// An absent attribute is `None` rather than an error: most of what this module reads is optional
/// by specification, and a missing colour description is a decision to make, not a failure.
fn read_u32(attributes: &IMFAttributes, key: &GUID) -> Option<u32> {
    // SAFETY: the key pointer is derived from a live borrow that outlasts the call; the value is
    // returned by copy and no pointer is retained.
    unsafe { attributes.GetUINT32(key) }.ok()
}

/// Reads an optional `UINT64` attribute.
fn read_u64(attributes: &IMFAttributes, key: &GUID) -> Option<u64> {
    // SAFETY: the key pointer is derived from a live borrow that outlasts the call; the value is
    // returned by copy and no pointer is retained.
    unsafe { attributes.GetUINT64(key) }.ok()
}
