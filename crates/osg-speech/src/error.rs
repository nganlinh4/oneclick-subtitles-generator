use std::time::Duration;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, SpeechError>;

/// Public errors never contain speech text, provider secrets, raw worker
/// output, or local filesystem paths.
#[derive(Debug, Error)]
pub enum SpeechError {
    #[error("speech worker was not found in an approved location")]
    WorkerNotFound,
    #[error("invalid speech worker program: {0}")]
    InvalidWorker(&'static str),
    #[error("invalid speech input: {0}")]
    InvalidInput(&'static str),
    #[error("invalid speech option: {0}")]
    InvalidOption(&'static str),
    #[error("invalid audio asset: {0}")]
    InvalidAsset(&'static str),
    #[error("invalid output destination: {0}")]
    InvalidDestination(&'static str),
    #[error("speech request backend does not match the worker")]
    BackendMismatch,
    #[error("failed to start speech worker: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("speech worker I/O failed: {0}")]
    WorkerIo(#[source] std::io::Error),
    #[error("speech worker violated the framed protocol: {0}")]
    Protocol(&'static str),
    #[error("speech worker frame exceeded the capture limit")]
    FrameLimit,
    #[error("speech worker exited unexpectedly (code {code:?})")]
    WorkerExited { code: Option<i32> },
    #[error("speech worker rejected the operation ({code}, retryable: {retryable})")]
    WorkerRejected { code: &'static str, retryable: bool },
    #[error("speech operation exceeded its {timeout:?} time limit")]
    TimedOut { timeout: Duration },
    #[error("speech operation was cancelled")]
    Cancelled,
    #[error("speech worker completed without producing an artifact")]
    MissingArtifact,
    #[error("speech worker produced an invalid audio artifact: {0}")]
    InvalidArtifact(&'static str),
    #[error("the speech output already exists")]
    OutputExists,
    #[error("speech artifact publication failed: {0}")]
    Publish(#[source] std::io::Error),
    #[error("speech worker state is unavailable")]
    StateUnavailable,
}
