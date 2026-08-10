use crate::binary::BinaryKind;
use std::time::Duration;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, MediaError>;

/// Errors intentionally omit source/output paths and raw tool stderr so they
/// remain safe if an application maps them to an IPC response.
#[derive(Debug, Error)]
pub enum MediaError {
    #[error("{0} executable was not found in an approved location")]
    BinaryNotFound(BinaryKind),
    #[error("the configured {tool} executable is invalid: {reason}")]
    InvalidBinary {
        tool: BinaryKind,
        reason: &'static str,
    },
    #[error("invalid {role} media path: {reason}")]
    InvalidPath {
        role: &'static str,
        reason: &'static str,
    },
    #[error("invalid media option: {0}")]
    InvalidOption(&'static str),
    #[error("failed to start {tool}: {source}")]
    Spawn {
        tool: BinaryKind,
        #[source]
        source: std::io::Error,
    },
    #[error("{tool} I/O failed: {source}")]
    ProcessIo {
        tool: BinaryKind,
        #[source]
        source: std::io::Error,
    },
    #[error("{tool} exited unsuccessfully (code {code:?})")]
    ProcessFailed { tool: BinaryKind, code: Option<i32> },
    #[error("{tool} exceeded its {timeout:?} time limit")]
    TimedOut { tool: BinaryKind, timeout: Duration },
    #[error("{0} operation was cancelled")]
    Cancelled(BinaryKind),
    #[error("{tool} output exceeded the safe capture limit")]
    OutputLimit { tool: BinaryKind },
    #[error("ffprobe returned invalid metadata: {0}")]
    InvalidProbe(&'static str),
    #[error("ffprobe JSON could not be parsed")]
    ProbeJson(#[source] serde_json::Error),
    #[error("the media cannot be converted for the selected compatibility target")]
    UnsupportedConversion,
    #[error("the output already exists")]
    OutputExists,
    #[error("the media operation completed without producing a valid artifact")]
    MissingArtifact,
    #[error("artifact finalization failed: {0}")]
    Finalize(#[source] std::io::Error),
    #[error("waveform data is invalid: {0}")]
    InvalidWaveform(&'static str),
}
