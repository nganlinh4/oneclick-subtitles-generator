use thiserror::Error;

pub type Result<T> = std::result::Result<T, RenderError>;

/// Errors are intentionally categorical. Native paths, worker stderr, input
/// text, and process arguments must never be retained in a displayable error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum RenderError {
    #[error("the render request is invalid")]
    InvalidRequest,
    #[error("the render source is unavailable or changed")]
    SourceChanged,
    #[error("the narration artifact is unavailable or changed")]
    NarrationChanged,
    #[error("the managed render runtime is unavailable or invalid")]
    RuntimeUnavailable,
    #[error("the managed render staging area is unavailable")]
    StagingUnavailable,
    #[error("the native media preparation process failed")]
    MediaPreparationFailed,
    #[error("the Remotion worker returned an invalid protocol message")]
    InvalidWorkerProtocol,
    #[error("the Remotion worker failed")]
    WorkerFailed,
    #[error("the render operation was cancelled")]
    Cancelled,
    #[error("the render operation exceeded its time limit")]
    TimedOut,
    #[error("the render output is missing or invalid")]
    InvalidOutput,
    #[error("native render I/O failed")]
    Io,
}

impl From<std::io::Error> for RenderError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}
