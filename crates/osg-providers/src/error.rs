use thiserror::Error;

/// A deliberately sanitized provider failure.
///
/// Variants contain no URLs, response bodies, request values, or underlying transport errors, so
/// they are safe to map onto the desktop IPC boundary.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ProviderError {
    #[error("the provider request is invalid")]
    InvalidRequest,
    #[error("the provider returned invalid data")]
    InvalidResponse,
    #[error("the provider request timed out")]
    Timeout,
    #[error("the provider request could not be completed")]
    Transport,
    #[error("the provider rejected the configured credential")]
    Unauthorized,
    #[error("YouTube authentication is required")]
    AuthenticationRequired,
    #[error("the provider quota has been exceeded")]
    QuotaExceeded,
    #[error("the YouTube Data API is not enabled")]
    ApiNotEnabled,
    #[error("no matching result was found")]
    NotFound,
    #[error("the OAuth request was denied")]
    OAuthDenied,
    #[error("an OAuth request is already active")]
    OAuthBusy,
    #[error("the OAuth request was cancelled")]
    OAuthCancelled,
    #[error("the OAuth request expired")]
    OAuthExpired,
    #[error("the system browser could not be opened")]
    BrowserOpen,
}

pub type Result<T> = std::result::Result<T, ProviderError>;
