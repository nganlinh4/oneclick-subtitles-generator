use std::time::Duration;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, DownloadError>;

/// Closed, privacy-safe classification of a failed downloader process. Raw stderr can contain
/// source URLs, account names, cookies, and filesystem paths, so it never crosses this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessFailureKind {
    AuthenticationRequired,
    RateLimited,
    Network,
    FormatUnavailable,
    SourceUnavailable,
    PostProcessing,
    Extractor,
    Unknown,
}

impl ProcessFailureKind {
    #[must_use]
    pub const fn diagnostic(self) -> &'static str {
        match self {
            Self::AuthenticationRequired => "authentication-required",
            Self::RateLimited => "rate-limited",
            Self::Network => "network",
            Self::FormatUnavailable => "format-unavailable",
            Self::SourceUnavailable => "source-unavailable",
            Self::PostProcessing => "post-processing",
            Self::Extractor => "extractor",
            Self::Unknown => "unknown",
        }
    }
}

/// Public errors never contain a source URL, cookie source, local path, or raw
/// `yt-dlp` output, so they are safe to map to an IPC response.
#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("yt-dlp was not found in an approved location")]
    BinaryNotFound,
    #[error("the configured yt-dlp executable is invalid: {0}")]
    InvalidBinary(&'static str),
    #[error("a supported JavaScript runtime was not found in an approved location")]
    JavaScriptRuntimeNotFound,
    #[error("the configured JavaScript runtime is invalid: {0}")]
    InvalidJavaScriptRuntime(&'static str),
    #[error("the media URL is invalid: {0}")]
    InvalidUrl(&'static str),
    #[error("the media URL host is not allowed by the active policy")]
    UnsupportedSite,
    #[error("the media URL resolves to a non-public network address")]
    NonPublicAddress,
    #[error("the media URL host could not be resolved")]
    ResolutionFailed,
    #[error("invalid download destination: {0}")]
    InvalidDestination(&'static str),
    #[error("invalid download option: {0}")]
    InvalidOption(&'static str),
    #[error("failed to start yt-dlp: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("yt-dlp process I/O failed: {0}")]
    ProcessIo(#[source] std::io::Error),
    #[error("yt-dlp exited unsuccessfully (code {code:?})")]
    ProcessFailed {
        code: Option<i32>,
        kind: ProcessFailureKind,
    },
    #[error("yt-dlp exceeded its {timeout:?} time limit")]
    TimedOut { timeout: Duration },
    #[error("the download was cancelled")]
    Cancelled,
    #[error("yt-dlp output exceeded the safe capture limit")]
    OutputLimit,
    #[error("yt-dlp returned invalid inventory JSON")]
    InventoryJson(#[source] serde_json::Error),
    #[error("yt-dlp returned invalid inventory data: {0}")]
    InvalidInventory(&'static str),
    #[error("the requested format does not belong to this media inventory")]
    FormatMismatch,
    #[error("the requested subtitle does not belong to this media inventory")]
    SubtitleMismatch,
    #[error("the native media inventory registry is full")]
    InventoryRegistryFull,
    #[error("the native media inventory capability does not exist")]
    InventoryNotFound,
    #[error("the native media inventory capability has expired")]
    InventoryExpired,
    #[error("the native media inventory registry is unavailable")]
    InventoryRegistryUnavailable,
    #[error("FFmpeg is required for this download plan")]
    FfmpegRequired,
    #[error("the output already exists")]
    OutputExists,
    #[error("yt-dlp completed without producing the requested artifact")]
    MissingArtifact,
    #[error("the downloaded subtitle artifact is invalid")]
    InvalidSubtitleArtifact,
    #[error("the downloaded subtitle artifact exceeds the safe IPC limit")]
    SubtitleArtifactTooLarge,
    #[error("download artifact publication failed: {0}")]
    Publish(#[source] std::io::Error),
}
