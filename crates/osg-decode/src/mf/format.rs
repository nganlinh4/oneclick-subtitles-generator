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
    Ok(SourcePresentation::new(coded, rotation, pixel_aspect))
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
