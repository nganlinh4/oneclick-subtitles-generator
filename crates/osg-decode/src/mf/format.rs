//! Turning the two media types a source reader offers into the decisions the decoder needs.
//!
//! Two types describe every decode: the source's **native** type, which describes the file, and the
//! negotiated **output** type, which describes the frames the reader will hand back. Every function
//! here reads both and returns one answer, so which of the two wins — and why — is decided once,
//! here, rather than at each place that needs it.
//!
//! The rule is the same throughout: the output type is asked first, because it describes the bytes
//! actually arriving, and the native type is the fallback, because a converter in the middle may
//! have dropped a description it did not change. Silence is answered explicitly and never guessed
//! at: [`crate::presentation`] records what an absent pixel aspect or rotation is taken to mean, and
//! [`SourceColorimetry::assumed_for`] says out loud where a colour convention is applied.

use windows::Win32::Media::MediaFoundation::IMFMediaType;

use crate::colorimetry::SourceColorimetry;
use crate::error::DecodeError;
use crate::mf::media_type;
use crate::planes::FrameGeometry;
use crate::presentation::{PixelAspect, Rotation, SourcePresentation};
use crate::visible::VisibleRegion;

/// Reads what the container says about presenting its coded pixels.
///
/// # Errors
/// Returns [`DecodeError::UnsupportedPixelAspect`] for a declared ratio with a zero term and
/// [`DecodeError::UnsupportedRotation`] for a declared rotation that is not a quarter turn. Neither
/// is normalised away: a file that describes itself impossibly is refused rather than read two ways.
pub(crate) fn presentation(
    output: &IMFMediaType,
    native: &IMFMediaType,
    coded: FrameGeometry,
) -> Result<SourcePresentation, DecodeError> {
    let rotation = rotation(output, native, coded)?;
    let pixel_aspect = match media_type::pixel_aspect_ratio(output)
        .or_else(|| media_type::pixel_aspect_ratio(native))
    {
        None => PixelAspect::SQUARE,
        Some((numerator, denominator)) => {
            PixelAspect::new(numerator, denominator).ok_or(DecodeError::UnsupportedPixelAspect)?
        }
    };
    let visible = visible_region(output, native, coded);
    Ok(SourcePresentation::with_visible(
        coded,
        visible,
        rotation,
        pixel_aspect,
    ))
}

/// Which part of the decoded surface actually holds picture.
///
/// A decoder returns the surface it finds convenient. H.264 codes in sixteen-pixel macroblocks, so a
/// 640x360 stream decodes into 640x368 and 1920x1080 into 1920x1088; the extra rows hold whatever
/// the encoder left there. `MF_MT_FRAME_SIZE` describes that surface and cannot distinguish the
/// picture from the padding, so the aperture attributes are asked first.
///
/// PRECEDENCE, in order, with the reason each step exists:
///
///   1. the output type's apertures — the negotiated frames are the bytes actually arriving, and
///      `MF_MT_MINIMUM_DISPLAY_APERTURE` is documented as the region containing valid image data;
///   2. the native type's apertures — a converter in the middle may have dropped an attribute it did
///      not change;
///   3. the native type's frame size, when it fits inside the surface — this is the common case for
///      macroblock padding, where the file says 360 rows and the decoder hands back 368;
///   4. the whole surface — nothing said otherwise, so nothing is cropped.
///
/// Every candidate is validated by [`VisibleRegion::new`] before it is used, so a malformed or
/// out-of-bounds rectangle falls through to the next step rather than being repaired or trusted.
fn visible_region(
    output: &IMFMediaType,
    native: &IMFMediaType,
    coded: FrameGeometry,
) -> VisibleRegion {
    let declared = media_type::apertures(output)
        .into_iter()
        .chain(media_type::apertures(native));
    for (_, rect) in declared {
        let Ok(size) = FrameGeometry::new(rect.width, rect.height) else {
            continue;
        };
        if let Ok(region) = VisibleRegion::new(rect.x, rect.y, size, coded) {
            return region;
        }
    }

    if let Ok((width, height)) = media_type::frame_size(native)
        && let Ok(size) = FrameGeometry::new(width, height)
        && let Ok(region) = VisibleRegion::new(0, 0, size, coded)
    {
        return region;
    }

    VisibleRegion::whole(coded)
}

/// The turn the decoder has to apply, after allowing for one the platform may have applied already.
///
/// The reader is asked for NV12 and nothing else, so the video processor it inserts is a format
/// converter and leaves the frame on its side. It is not *forbidden* from turning the frame, though,
/// and a decoder that turned an already-turned frame would put it back where it started. The guard
/// is the shape of the negotiated buffer: a quarter turn transposes it, so an output frame that is
/// the transpose of the source's own is a frame the platform has already stood upright.
fn rotation(
    output: &IMFMediaType,
    native: &IMFMediaType,
    coded: FrameGeometry,
) -> Result<Rotation, DecodeError> {
    let Some(degrees) =
        media_type::video_rotation(output).or_else(|| media_type::video_rotation(native))
    else {
        return Ok(Rotation::None);
    };
    let rotation =
        Rotation::from_already_rotated_degrees(degrees).ok_or(DecodeError::UnsupportedRotation)?;
    if rotation.transposes() && already_turned(native, coded) {
        return Ok(Rotation::None);
    }
    Ok(rotation)
}

/// Whether something in the reader has already stood the frame upright.
///
/// The evidence is the shape of the negotiated buffer against the source's own: an output frame that
/// is the transpose of the native one has been turned on the way here. Both halves are needed — a
/// square frame is its own transpose, and a square source that declares a turn still needs one, so
/// an unchanged shape is read as "nothing happened" before the transpose is considered at all.
///
/// A native type that cannot be read is treated as no evidence, which leaves the declared turn to be
/// applied. Refusing to turn on missing evidence would hand back the sideways frame this exists to
/// prevent.
fn already_turned(native: &IMFMediaType, coded: FrameGeometry) -> bool {
    let Ok((width, height)) = media_type::frame_size(native) else {
        return false;
    };
    let Ok(source) = FrameGeometry::new(width, height) else {
        return false;
    };
    source != coded && source.transposed() == coded
}

/// Prefers the decoded type's colour description, falling back to the source's own.
///
/// # Errors
/// Returns [`DecodeError::UnsupportedColorimetry`] for a description this build will not guess at.
pub(crate) fn colorimetry(
    output: &IMFMediaType,
    native: &IMFMediaType,
    height: u32,
) -> Result<SourceColorimetry, DecodeError> {
    let (output_range, output_matrix) = media_type::colour_attributes(output);
    let (native_range, native_matrix) = media_type::colour_attributes(native);
    SourceColorimetry::from_attributes(
        output_range.filter(|value| *value != 0).or(native_range),
        output_matrix.filter(|value| *value != 0).or(native_matrix),
        height,
    )
}

/// The row stride to assume for a buffer that cannot report its own.
///
/// A declared stride is used when it is positive; a negative one describes bottom-up rows, which
/// [`crate::mf::sample`] refuses rather than silently mirroring. With nothing declared, an NV12
/// row is exactly as wide as the frame.
pub(crate) fn stride(output: &IMFMediaType, coded: FrameGeometry) -> usize {
    media_type::default_stride(output)
        .filter(|stride| *stride > 0)
        .and_then(|stride| usize::try_from(stride).ok())
        .filter(|stride| *stride >= coded.width())
        .unwrap_or_else(|| coded.width())
}
