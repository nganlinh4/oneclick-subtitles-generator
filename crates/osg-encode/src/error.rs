//! Typed, path-safe failures for the native encoder.
//!
//! Every variant is `Copy` and carries only bounded numbers and closed enums. Nothing here can
//! transport a filesystem path, an export identifier, a credential or a line of a user's subtitle
//! text, so an encode failure is safe to log verbatim.

use core::fmt;

/// Which configuration field a bound rejected.
///
/// Names the field, never the value, so a rejection can be reported without echoing anything the
/// caller supplied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConfigField {
    /// The frame width in pixels.
    Width,
    /// The frame height in pixels.
    Height,
    /// The frame rate numerator or denominator.
    FrameRate,
    /// The number of frames the encode will carry.
    FrameCount,
    /// The average video bitrate.
    VideoBitrate,
    /// The largest permitted gap between keyframes.
    KeyframeInterval,
    /// The audio sample rate.
    AudioSampleRate,
    /// The audio channel count.
    AudioChannels,
    /// The average audio bitrate.
    AudioBitrate,
}

impl fmt::Display for ConfigField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Width => "frame width",
            Self::Height => "frame height",
            Self::FrameRate => "frame rate",
            Self::FrameCount => "frame count",
            Self::VideoBitrate => "video bitrate",
            Self::KeyframeInterval => "keyframe interval",
            Self::AudioSampleRate => "audio sample rate",
            Self::AudioChannels => "audio channel count",
            Self::AudioBitrate => "audio bitrate",
        };
        formatter.write_str(name)
    }
}

/// Why an output location was refused.
///
/// The path itself is never part of the value. Callers already hold it; an error does not need to
/// repeat it into a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OutputRejection {
    /// The path was relative. The encoder is handed a resolved location, never one to resolve.
    NotAbsolute,
    /// The file name did not end in `.mp4`. The container is chosen by extension.
    NotMp4,
    /// The path had no file name at all.
    NoFileName,
    /// The path contained a NUL, which cannot cross the wide-string boundary.
    InteriorNul,
    /// The path was longer than the platform accepts.
    TooLong,
    /// The parent directory does not exist. The encoder creates a file, never a tree.
    ParentMissing,
    /// Something is already there. The encoder never clobbers: a failed or cancelled encode
    /// removes its own output, and that policy is only safe if the file was ours to begin with.
    AlreadyExists,
}

impl fmt::Display for OutputRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Self::NotAbsolute => "it is not absolute",
            Self::NotMp4 => "it does not name an .mp4 file",
            Self::NoFileName => "it has no file name",
            Self::InteriorNul => "it contains a NUL byte",
            Self::TooLong => "it is longer than the platform accepts",
            Self::ParentMissing => "its parent directory does not exist",
            Self::AlreadyExists => "a file is already there",
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
    /// Allocating the sink writer's attribute store.
    WriterAttributes,
    /// Creating the sink writer over the output file.
    CreateSinkWriter,
    /// Allocating a media type.
    MediaType,
    /// Registering an encoded stream on the writer.
    AddStream,
    /// Declaring the uncompressed format fed into a stream.
    InputMediaType,
    /// Opening the container for writing.
    BeginWriting,
    /// Allocating a sample buffer.
    AllocateBuffer,
    /// Locking a sample buffer for the CPU copy.
    LockBuffer,
    /// Allocating a sample.
    CreateSample,
    /// Handing a sample to the writer.
    WriteSample,
    /// Flushing the encoder and closing the container.
    Finalize,
}

impl fmt::Display for MfStage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let stage = match self {
            Self::ComApartment => "joining the COM apartment",
            Self::PlatformStartup => "starting the media platform",
            Self::WriterAttributes => "allocating the writer attributes",
            Self::CreateSinkWriter => "creating the sink writer",
            Self::MediaType => "allocating a media type",
            Self::AddStream => "adding an encoded stream",
            Self::InputMediaType => "declaring an input format",
            Self::BeginWriting => "opening the container",
            Self::AllocateBuffer => "allocating a sample buffer",
            Self::LockBuffer => "locking a sample buffer",
            Self::CreateSample => "allocating a sample",
            Self::WriteSample => "writing a sample",
            Self::Finalize => "finalizing the container",
        };
        formatter.write_str(stage)
    }
}

/// Everything the encoder can refuse to do.
///
/// Fails closed throughout: there is no variant that means "encoded something different from what
/// you asked for". A platform without an audited backend gets [`Self::UnsupportedPlatform`] and
/// never a substitute encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum EncodeError {
    /// This build has no audited encoder backend for the running platform.
    #[error("this platform has no audited video encoder backend")]
    UnsupportedPlatform,

    /// A configuration value fell outside the supported range.
    #[error("the {field} is outside the supported range")]
    UnsupportedConfig {
        /// The field that was rejected.
        field: ConfigField,
    },

    /// The output location cannot be written as an MP4 file.
    #[error("the output location was refused because {reason}")]
    OutputUnusable {
        /// Why the location was refused.
        reason: OutputRejection,
    },

    /// The frame buffer length does not match its declared size.
    #[error("a {width}x{height} frame needs {expected} bytes, the buffer holds {actual}")]
    FrameSizeMismatch {
        /// The declared width.
        width: u32,
        /// The declared height.
        height: u32,
        /// The byte count the declared size requires.
        expected: u64,
        /// The byte count the buffer actually has.
        actual: u64,
    },

    /// A frame was offered whose size is not the size the encode was configured for.
    #[error("the encode is {expected_width}x{expected_height}, the frame is {width}x{height}")]
    FrameSizeUnexpected {
        /// The configured width.
        expected_width: u32,
        /// The configured height.
        expected_height: u32,
        /// The offered width.
        width: u32,
        /// The offered height.
        height: u32,
    },

    /// Frames arrived out of order. The container carries one monotonic timeline, not a set.
    #[error("frames must be encoded in order: expected frame {expected}, got frame {actual}")]
    FrameOutOfOrder {
        /// The frame index the encoder was waiting for.
        expected: u32,
        /// The frame index that arrived.
        actual: u32,
    },

    /// A frame index beyond the configured frame count was offered.
    #[error("frame {index} is outside the configured {frame_count}-frame timeline")]
    FrameOutOfRange {
        /// The offered index.
        index: u32,
        /// How many frames the encode carries.
        frame_count: u32,
    },

    /// A presentation timestamp could not be represented in 100ns units.
    #[error("the presentation timestamp of frame {index} cannot be represented")]
    TimestampOutOfRange {
        /// The frame index whose timestamp overflowed.
        index: u32,
    },

    /// An audio timestamp could not be represented in 100ns units.
    #[error("the presentation timestamp of audio sample {sample_index} cannot be represented")]
    AudioTimestampOutOfRange {
        /// The sample index whose timestamp overflowed.
        sample_index: u64,
    },

    /// Audio was offered to an encode that has no audio stream.
    #[error("this encode carries no audio stream")]
    NoAudioStream,

    /// An audio block was not a whole number of interleaved frames.
    #[error("an audio block must be a whole number of {channels}-channel frames, got {samples}")]
    AudioBlockMisaligned {
        /// The configured channel count.
        channels: u32,
        /// The sample count that was offered.
        samples: usize,
    },

    /// Audio blocks arrived out of order.
    #[error("audio must be encoded in order: expected sample {expected}, got sample {actual}")]
    AudioOutOfOrder {
        /// The sample index the encoder was waiting for.
        expected: u64,
        /// The sample index that arrived.
        actual: u64,
    },

    /// The encode was cancelled and has released its output.
    #[error("the encode was cancelled")]
    Cancelled,

    /// The encode was already finalized or cancelled.
    #[error("the encode has already finished")]
    AlreadyFinished,

    /// The finished file could not be measured.
    #[error("the finished file could not be measured")]
    OutputUnmeasurable,

    /// A platform call failed. The stage is ours; the code is the platform's `HRESULT`.
    #[error("the media platform refused {stage}: 0x{code:08x}")]
    MediaFoundation {
        /// Which call failed.
        stage: MfStage,
        /// The platform status code.
        code: u32,
    },
}
