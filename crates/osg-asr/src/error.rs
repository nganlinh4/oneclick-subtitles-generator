use std::io;
use std::time::Duration;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, AsrError>;

#[derive(Debug, Error)]
pub enum AsrError {
    #[error("invalid ASR option: {0}")]
    InvalidOption(&'static str),
    #[error("normalized audio is unavailable or invalid")]
    InvalidAudio,
    #[error("the ASR worker runtime is unavailable or invalid")]
    InvalidRuntime,
    #[error("the requested ASR engine does not support a forced language")]
    LanguageUnsupported,
    #[error("the requested language is unsupported by this ASR engine")]
    LanguageUnavailable,
    #[error("failed to start the ASR worker")]
    Spawn(#[source] io::Error),
    #[error("ASR worker I/O failed during {action}")]
    ProcessIo {
        action: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("ASR worker protocol violation: {0}")]
    Protocol(&'static str),
    #[error("ASR worker output exceeded a safety limit")]
    OutputLimit,
    #[error("ASR worker failed: {0}")]
    WorkerFailed(&'static str),
    #[error("ASR worker returned invalid transcription data")]
    InvalidOutput,
    #[error("ASR job was cancelled")]
    Cancelled,
    #[error("ASR job timed out after {0:?}")]
    TimedOut(Duration),
    #[error("ASR worker is unavailable after an internal synchronization failure")]
    Synchronization,
}
