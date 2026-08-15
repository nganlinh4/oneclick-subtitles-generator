//! Typed, path-safe failures for audio decoding and mixing.
//!
//! Every variant is `Copy` and carries only bounded numbers or a coarse category. No variant ever
//! carries a filesystem path, a decoder message, a container title, or a sample of the media, so a
//! failure can be logged or surfaced to the `WebView` without leaking what the user is working on.

use core::fmt;

/// Why a source could not be opened, reduced to a category that names no path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AccessFailure {
    /// Nothing exists at the location the caller gave.
    Missing,
    /// The location exists but this process may not read it.
    Denied,
    /// The location exists and is readable in principle but the read failed.
    Unreadable,
}

impl AccessFailure {
    /// Reduce an I/O failure to a path-free category.
    ///
    /// The [`std::io::Error`] itself is deliberately dropped rather than wrapped: its `Display` can
    /// carry the operating system's own rendering of the request, and nothing downstream needs it.
    pub(crate) const fn from_io_kind(kind: std::io::ErrorKind) -> Self {
        match kind {
            std::io::ErrorKind::NotFound => Self::Missing,
            std::io::ErrorKind::PermissionDenied => Self::Denied,
            _ => Self::Unreadable,
        }
    }
}

impl fmt::Display for AccessFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Missing => "it does not exist",
            Self::Denied => "it may not be read",
            Self::Unreadable => "it could not be read",
        };
        formatter.write_str(message)
    }
}

/// Everything decoding and mixing can refuse to do.
///
/// Failures are closed: the crate never substitutes silence for a broken source, never truncates a
/// mix to fit a bound, and never panics on a hostile or corrupt file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum AudioError {
    /// The source could not be opened at all.
    #[error("the audio source could not be opened: {reason}")]
    SourceUnavailable {
        /// The path-free reason the open failed.
        reason: AccessFailure,
    },

    /// No container reader recognised the bytes.
    #[error("the audio source is not in a container this build reads")]
    UnrecognisedContainer,

    /// The container was read but holds no track that could carry audio.
    #[error("the media carries no decodable audio track")]
    NoAudioTrack,

    /// The audio track's codec has no decoder in this build.
    ///
    /// Opus is the codec an OSG user is most likely to meet here: `symphonia` 0.5.5 has no pure
    /// Rust Opus decoder, so an Opus track in `WebM` or Ogg reaches this variant rather than being
    /// decoded. It is a refusal, not silence.
    #[error("the audio track uses a codec this build does not decode")]
    UnsupportedCodec,

    /// The stream never declared a usable sample rate or channel layout.
    #[error("the audio track declares no usable sample rate or channel layout")]
    MissingStreamParameters,

    /// The stream is corrupt, truncated, or changed its format mid-stream.
    #[error("the audio stream is corrupt or truncated")]
    CorruptStream,

    /// A single packet claimed more frames than a packet may hold.
    #[error("a decoded packet claims more than {max} frames")]
    PacketTooLarge {
        /// The largest frame count a single packet may decode to.
        max: u64,
    },

    /// The source declares a sample rate outside the supported range.
    #[error("the source sample rate must be {min}..={max} Hz, got {value}")]
    SourceSampleRateOutOfRange {
        /// The rejected rate.
        value: u32,
        /// The smallest accepted rate.
        min: u32,
        /// The largest accepted rate.
        max: u32,
    },

    /// The source declares more channels than the decoder accepts.
    #[error("the source channel count must be 1..={max}, got {value}")]
    SourceChannelCountOutOfRange {
        /// The rejected channel count.
        value: u32,
        /// The largest accepted channel count.
        max: u32,
    },

    /// The source carries more frames than any mix may read from it.
    #[error("the source carries more than the {max} frames a mix may read")]
    SourceTooLong {
        /// The largest frame count a single source may contribute.
        max: u64,
    },

    /// The requested output sample rate is outside the supported range.
    #[error("the output sample rate must be {min}..={max} Hz, got {value}")]
    OutputSampleRateOutOfRange {
        /// The rejected rate.
        value: u32,
        /// The smallest accepted rate.
        min: u32,
        /// The largest accepted rate.
        max: u32,
    },

    /// The requested output channel count is outside the supported range.
    #[error("the output channel count must be 1..={max}, got {value}")]
    OutputChannelCountOutOfRange {
        /// The rejected channel count.
        value: u32,
        /// The largest accepted channel count.
        max: u32,
    },

    /// The plan carries more sources than a mix may hold.
    #[error("a mix carries at most {max} sources, got {value}")]
    TooManySources {
        /// The rejected source count.
        value: usize,
        /// The largest accepted source count.
        max: usize,
    },

    /// The mix duration is negative, zero, or beyond the supported ceiling.
    #[error("the mix duration must be more than zero and at most {max} seconds")]
    DurationOutOfRange {
        /// The longest accepted mix, in seconds.
        max: u32,
    },

    /// The trim window is empty, inverted, negative, or beyond the supported ceiling.
    #[error("the trim window is empty, inverted or outside the supported range")]
    InvalidTrim,

    /// The source offset is negative or beyond the supported ceiling.
    #[error("the source offset is negative or outside the supported range")]
    InvalidOffset,

    /// The volume is outside the shipped 0-100 range.
    #[error("the volume must be 0..=100 percent, got {value}")]
    VolumeOutOfRange {
        /// The rejected percentage.
        value: u32,
    },

    /// The whole mix was asked for as one buffer but does not fit the buffering ceiling.
    #[error("the mix does not fit the {max} sample whole-buffer ceiling; read it in blocks")]
    MixTooLargeToBuffer {
        /// The largest whole-buffer mix, in samples.
        max: u64,
    },

    /// The render timeline could not be turned into a mix duration.
    #[error("the render timeline does not describe a mixable duration")]
    UnsupportedTimeline,
}
