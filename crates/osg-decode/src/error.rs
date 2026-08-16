//! Typed, path-safe failures for the native decoder.
//!
//! Every variant is `Copy` and carries only bounded numbers and closed enums. Nothing here can
//! transport a filesystem path, a credential, or a pixel of the user's source video, so a decode
//! failure is safe to log verbatim.

use core::fmt;

/// Why a source location was refused.
///
/// The path itself is never part of the value. The caller already holds it; an error does not need
/// to repeat it into a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SourceRejection {
    /// The path was relative. The decoder is handed a resolved location, never one to resolve.
    NotAbsolute,
    /// The path had no file name at all.
    NoFileName,
    /// The path contained a NUL, which cannot cross the wide-string boundary.
    InteriorNul,
    /// The path was longer than the platform accepts.
    TooLong,
    /// Nothing readable is there.
    NotAFile,
}

impl fmt::Display for SourceRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Self::NotAbsolute => "it is not absolute",
            Self::NoFileName => "it has no file name",
            Self::InteriorNul => "it contains a NUL byte",
            Self::TooLong => "it is longer than the platform accepts",
            Self::NotAFile => "there is no readable file there",
        };
        formatter.write_str(reason)
    }
}

/// The platform call that failed.
///
/// Stage names are fixed strings chosen in this file. None of them is derived from caller data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum MfStage {
    /// Joining the multithreaded COM apartment.
    ComApartment,
    /// Starting the Media Foundation platform.
    PlatformStartup,
    /// Allocating the source reader's attribute store.
    ReaderAttributes,
    /// Creating the source reader over the input file.
    CreateSourceReader,
    /// Selecting or deselecting a stream on the reader.
    StreamSelection,
    /// Allocating a media type.
    MediaType,
    /// Reading the source's own, undecoded format.
    NativeMediaType,
    /// Declaring the uncompressed format the reader must decode into.
    OutputMediaType,
    /// Reading a presentation attribute, such as the source duration.
    PresentationAttribute,
    /// Pulling one decoded sample.
    ReadSample,
    /// Moving the reader to a position.
    Seek,
    /// Reaching a decoded sample's memory.
    SampleBuffer,
    /// Locking a sample buffer for the CPU read.
    LockBuffer,
}

impl fmt::Display for MfStage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let stage = match self {
            Self::ComApartment => "joining the COM apartment",
            Self::PlatformStartup => "starting the media platform",
            Self::ReaderAttributes => "allocating the reader attributes",
            Self::CreateSourceReader => "creating the source reader",
            Self::StreamSelection => "selecting a stream",
            Self::MediaType => "allocating a media type",
            Self::NativeMediaType => "reading the source format",
            Self::OutputMediaType => "declaring the decoded format",
            Self::PresentationAttribute => "reading a presentation attribute",
            Self::ReadSample => "reading a sample",
            Self::Seek => "moving to a position",
            Self::SampleBuffer => "reaching a sample's memory",
            Self::LockBuffer => "locking a sample buffer",
        };
        formatter.write_str(stage)
    }
}

/// Which bound a source failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SourceBound {
    /// The frame width in pixels.
    Width,
    /// The frame height in pixels.
    Height,
    /// The declared duration.
    Duration,
}

impl fmt::Display for SourceBound {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let bound = match self {
            Self::Width => "frame width",
            Self::Height => "frame height",
            Self::Duration => "duration",
        };
        formatter.write_str(bound)
    }
}

/// Everything the decoder can refuse to do.
///
/// Fails closed throughout: there is no variant that means "decoded something other than the frame
/// you asked for". A platform without an audited backend gets [`Self::UnsupportedPlatform`] and
/// never a substitute decoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum DecodeError {
    /// This build has no audited decoder backend for the running platform.
    #[error("this platform has no audited video decoder backend")]
    UnsupportedPlatform,

    /// The source location cannot be opened.
    #[error("the source location was refused because {reason}")]
    SourceUnusable {
        /// Why the location was refused.
        reason: SourceRejection,
    },

    /// The file carries no video stream the platform can decode.
    #[error("the source carries no decodable video stream")]
    NoVideoStream,

    /// The source is larger than this build will decode.
    #[error("the source {bound} is outside the supported range")]
    SourceOutOfBounds {
        /// Which bound was exceeded.
        bound: SourceBound,
    },

    /// The source declares a frame rate the shared timeline cannot represent.
    #[error("the source frame rate is outside the supported range")]
    UnsupportedFrameRate,

    /// The decoded frame is not a layout this crate can read.
    ///
    /// Covers an odd edge — 4:2:0 chroma has no half pixel — a non-positive row stride, and a
    /// buffer the platform reported as smaller than the frame it is supposed to hold.
    #[error("the decoded frame layout is not one this decoder can read")]
    UnsupportedFrameLayout,

    /// The source declares a pixel aspect ratio with a zero term.
    ///
    /// Not treated as square pixels: an absent ratio is a statement that the pixels are square, and
    /// a present one that cannot be a ratio is a file describing itself impossibly. Composing from
    /// it would silently pick one of the two readings.
    #[error("the source declares a pixel aspect ratio that is not a ratio")]
    UnsupportedPixelAspect,

    /// The source declares a rotation that is not a quarter turn.
    ///
    /// Media Foundation documents only 0, 90, 180 and 270. Anything else would need a resample
    /// rather than a turn, and ignoring it would hand back a frame lying on its side.
    #[error("the source declares a rotation that is not a quarter turn")]
    UnsupportedRotation,

    /// The source declares a colour range or matrix this crate will not guess at.
    ///
    /// Deliberately not silently treated as the nearest supported description: every wrong guess
    /// here is a visible, whole-image error, which is the class of defect the colour handling
    /// exists to prevent. A caller that knows better can override the description explicitly.
    #[error("the source declares a colour description this decoder will not guess at")]
    UnsupportedColorimetry,

    /// A decoded buffer was smaller than the frame it is supposed to hold.
    #[error("a decoded frame needs {expected} bytes, the buffer holds {actual}")]
    SampleTooSmall {
        /// The byte count the declared geometry requires.
        expected: u64,
        /// The byte count the platform reported.
        actual: u64,
    },

    /// A frame index outside the output timeline was asked for.
    #[error("frame {index} is outside the {frame_count}-frame timeline")]
    FrameOutOfRange {
        /// The index that was asked for.
        index: u32,
        /// How many frames the timeline carries.
        frame_count: u32,
    },

    /// A timeline instant could not be represented in 100ns units.
    #[error("the sample instant of frame {index} cannot be represented")]
    TimestampOutOfRange {
        /// The frame index whose instant overflowed.
        index: u32,
    },

    /// The stream ended before the frame that was asked for.
    ///
    /// A truncated or hostile file reaches end-of-stream early; the decoder says so rather than
    /// returning the last frame it happened to have and letting the export look complete.
    #[error("the stream ended after {decoded} frames, before the frame that was asked for")]
    TruncatedStream {
        /// How many samples were decoded before the stream ended.
        decoded: u64,
    },

    /// The source changed geometry part-way through.
    ///
    /// The export's output size and crop both derive from the source dimensions, so a mid-stream
    /// change is refused rather than absorbed.
    #[error("the source changed geometry part-way through the stream")]
    SourceGeometryChanged,

    /// The decoder walked its whole budget without reaching the frame that was asked for.
    #[error("the frame at {target_100ns} could not be reached within the decode budget")]
    FrameNotFound {
        /// The instant, in 100ns units, that was being looked for.
        target_100ns: i64,
    },

    /// The decode was cancelled.
    #[error("the decode was cancelled")]
    Cancelled,

    /// The decoder has been closed.
    #[error("the decoder has been closed")]
    Closed,

    /// A platform call failed. The stage is ours; the code is the platform's `HRESULT`.
    #[error("the media platform refused {stage}: 0x{code:08x}")]
    MediaFoundation {
        /// Which call failed.
        stage: MfStage,
        /// The platform status code.
        code: u32,
    },
}
