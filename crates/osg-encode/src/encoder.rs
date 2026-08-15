//! The platform-independent encoder contract.
//!
//! One trait, one factory, one honest failure. A platform without an audited backend returns
//! [`EncodeError::UnsupportedPlatform`] from [`open_encoder`]; it never quietly encodes with
//! something else, and it never reports success for a file it did not write.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::audio::AudioBlock;
use crate::config::EncoderConfig;
use crate::error::EncodeError;
use crate::pixels::FrameBuffer;

/// A shared stop signal for an encode in progress.
///
/// Cloneable and thread-safe, so a long export can be abandoned from the UI thread while the encode
/// loop is inside a frame. The encoder checks it on entry to every write, so cancellation takes
/// effect within one frame rather than at the end of the run.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A token that has not been signalled.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Signals every holder of this token to stop.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether the token has been signalled.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What a finished encode produced.
///
/// Carries no path: the caller supplied the location and does not need it echoed back, and an
/// outcome is safe to log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeOutcome {
    frames_written: u32,
    audio_samples_written: u64,
    file_bytes: u64,
    duration_100ns: i64,
}

impl EncodeOutcome {
    pub(crate) const fn new(
        frames_written: u32,
        audio_samples_written: u64,
        file_bytes: u64,
        duration_100ns: i64,
    ) -> Self {
        Self {
            frames_written,
            audio_samples_written,
            file_bytes,
            duration_100ns,
        }
    }

    /// How many video frames reached the encoder.
    #[must_use]
    pub const fn frames_written(self) -> u32 {
        self.frames_written
    }

    /// How many interleaved audio sample frames reached the encoder.
    #[must_use]
    pub const fn audio_samples_written(self) -> u64 {
        self.audio_samples_written
    }

    /// The size of the finished file in bytes.
    #[must_use]
    pub const fn file_bytes(self) -> u64 {
        self.file_bytes
    }

    /// The exact end of the video timeline, in 100ns units.
    #[must_use]
    pub const fn duration_100ns(self) -> i64 {
        self.duration_100ns
    }
}

/// A platform encoder writing H.264 video and optional AAC audio into an MP4 container.
///
/// Implementations are used from the thread that created them: the backends this trait exists for
/// are COM APIs, whose objects belong to the apartment they were created in.
///
/// The lifecycle is deliberately explicit. An encoder that is dropped without [`Self::finalize`]
/// having succeeded must remove its output rather than leave behind a file that looks like a
/// finished export but has no index and will not play.
pub trait VideoEncoder: core::fmt::Debug {
    /// The configuration this encoder was opened with.
    fn config(&self) -> EncoderConfig;

    /// A handle that can stop this encode from another thread.
    fn cancel_token(&self) -> CancelToken;

    /// Encodes one composed frame.
    ///
    /// Frames must arrive in order starting at zero; the container carries one monotonic timeline
    /// and the encoder will not reorder on the caller's behalf.
    ///
    /// # Errors
    /// Returns [`EncodeError`] when the frame is the wrong size, out of order, past the end of the
    /// configured timeline, when the encode was cancelled, or when the platform refuses the write.
    fn write_frame(&mut self, frame_index: u32, frame: &FrameBuffer<'_>)
    -> Result<(), EncodeError>;

    /// Encodes one block of interleaved PCM starting at `first_sample`.
    ///
    /// # Errors
    /// Returns [`EncodeError::NoAudioStream`] when the encode carries no audio, and otherwise the
    /// same failures as [`Self::write_frame`].
    fn write_audio(&mut self, first_sample: u64, block: &AudioBlock<'_>)
    -> Result<(), EncodeError>;

    /// Flushes the encoder, closes the container and measures the result.
    ///
    /// # Errors
    /// Returns [`EncodeError::AlreadyFinished`] when the encode has already ended, and
    /// [`EncodeError`] variants for a platform or filesystem failure.
    fn finalize(&mut self) -> Result<EncodeOutcome, EncodeError>;

    /// Abandons the encode and removes the partial file.
    ///
    /// Idempotent, so a cancellation racing a natural end is not itself an error.
    ///
    /// # Errors
    /// Returns [`EncodeError`] only when the partial file could not be released.
    fn cancel(&mut self) -> Result<(), EncodeError>;
}

/// Opens the audited encoder backend for the running platform.
///
/// `output` must be an absolute path to a `.mp4` file whose parent directory already exists. It is
/// consumed here and never appears in an error.
///
/// # Errors
/// Returns [`EncodeError::UnsupportedPlatform`] when this build has no audited backend for the
/// running platform, and otherwise the first configuration, path or platform failure.
#[cfg(windows)]
pub fn open_encoder(
    output: &Path,
    config: EncoderConfig,
) -> Result<Box<dyn VideoEncoder>, EncodeError> {
    let encoder = crate::mf::MediaFoundationEncoder::open(output, config)?;
    Ok(Box::new(encoder))
}

/// Opens the audited encoder backend for the running platform.
///
/// # Errors
/// Always [`EncodeError::UnsupportedPlatform`] on this target: the shipped release target is
/// Windows, and another platform gets its own audited backend behind this trait rather than a
/// silent fallback to whatever encoder happens to be installed.
#[cfg(not(windows))]
pub fn open_encoder(
    output: &Path,
    config: EncoderConfig,
) -> Result<Box<dyn VideoEncoder>, EncodeError> {
    let _ = (output, config);
    Err(EncodeError::UnsupportedPlatform)
}
