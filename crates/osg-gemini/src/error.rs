use std::time::Duration;

/// Crate result type.
pub type Result<T> = std::result::Result<T, Error>;

/// Coarse transport classification that never exposes a URL, API key, prompt,
/// file path, or response body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportKind {
    Connect,
    Timeout,
    Decode,
    Body,
    Other,
}

/// Bounded, redacted provider error metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderError {
    pub http_status: u16,
    pub api_status: Option<String>,
    pub message: String,
    pub retry_after: Option<Duration>,
    pub retryable: bool,
}

/// Failures from validation, transport, Gemini, upload processing, or explicit
/// cancellation. Variants deliberately omit API keys and local paths.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Gemini operation was cancelled")]
    Cancelled,

    #[error("invalid Gemini configuration: {0}")]
    InvalidConfig(String),

    #[error("invalid Gemini request: {0}")]
    InvalidRequest(String),

    #[error("unsupported Gemini media MIME type: {0}")]
    UnsupportedMimeType(String),

    #[error("inline Gemini request is too large ({actual_bytes} bytes; limit {limit_bytes})")]
    InlineRequestTooLarge {
        actual_bytes: usize,
        limit_bytes: usize,
    },

    #[error("Gemini upload is too large ({actual_bytes} bytes; limit {limit_bytes})")]
    UploadTooLarge { actual_bytes: u64, limit_bytes: u64 },

    #[error("Gemini file I/O failed during {operation}: {kind:?}")]
    Io {
        operation: &'static str,
        kind: std::io::ErrorKind,
    },

    #[error("Gemini transport failed: {0:?}")]
    Transport(TransportKind),

    #[error("Gemini {operation} timed out after {timeout:?}")]
    Timeout {
        operation: &'static str,
        timeout: Duration,
    },

    #[error("Gemini API error: HTTP {status}", status = .0.http_status)]
    Provider(ProviderError),

    #[error("Gemini model is cooling down for {retry_after:?}")]
    CooldownActive { retry_after: Duration },

    #[error("invalid Gemini upload protocol response: {0}")]
    UploadProtocol(String),

    #[error("Gemini file processing failed: {message}")]
    FileProcessingFailed { message: String },

    #[error("Gemini upload may have completed, but its final response was lost")]
    UploadOutcomeUnknown,

    #[error("Gemini response exceeded {limit_bytes} bytes")]
    ResponseTooLarge { limit_bytes: usize },

    #[error("Gemini returned no non-thinking text output")]
    NoTextOutput,

    #[error("Gemini returned no image output")]
    NoImageOutput,

    #[error("Gemini returned an invalid image output")]
    InvalidImageOutput,

    #[error("Gemini blocked the requested image output")]
    ImageOutputBlocked,
}

impl Error {
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) | Self::Timeout { .. } => true,
            Self::Provider(error) => error.retryable,
            _ => false,
        }
    }
}

pub(crate) fn io_error(operation: &'static str, error: &std::io::Error) -> Error {
    Error::Io {
        operation,
        kind: error.kind(),
    }
}
