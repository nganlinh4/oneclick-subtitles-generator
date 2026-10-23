//! Download request, response and progress-event DTOs.

use std::fmt;

use osg_domain::JobSnapshot;
use osg_download::{
    AudioDownloadFormat, BrowserCookieSource, DownloadPhase, DownloadProgress, DownloadSummary,
    InventoryId, InventoryRegistration, MediaInventory, SubtitleSource,
};
use serde::{Deserialize, Serialize};

use crate::commands::MediaCandidateResponse;
use crate::error::CommandError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DownloadUnavailableReason {
    DownloaderUnavailable,
    DownloaderHealthCheckFailed,
    JavaScriptRuntimeUnavailable,
    MediaToolsUnavailable,
    CacheUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadStatusResponse {
    pub(super) available: bool,
    pub(super) inspect_available: bool,
    pub(super) version: Option<String>,
    pub(super) reason: Option<DownloadUnavailableReason>,
    pub(super) max_concurrent_downloads: usize,
    pub(super) inventory_ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadInspectionResponse {
    pub(super) capability: InventoryRegistration,
    pub(super) inventory: MediaInventory,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CookieSourceRequest {
    #[default]
    None,
    Chrome,
    Chromium,
    Edge,
    Firefox,
    Brave,
    Safari,
    Vivaldi,
    Opera,
    Whale,
}

impl From<CookieSourceRequest> for BrowserCookieSource {
    fn from(value: CookieSourceRequest) -> Self {
        match value {
            CookieSourceRequest::None => Self::None,
            CookieSourceRequest::Chrome => Self::Chrome,
            CookieSourceRequest::Chromium => Self::Chromium,
            CookieSourceRequest::Edge => Self::Edge,
            CookieSourceRequest::Firefox => Self::Firefox,
            CookieSourceRequest::Brave => Self::Brave,
            CookieSourceRequest::Safari => Self::Safari,
            CookieSourceRequest::Vivaldi => Self::Vivaldi,
            CookieSourceRequest::Opera => Self::Opera,
            CookieSourceRequest::Whale => Self::Whale,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadInspectRequest {
    pub(super) url: String,
    #[serde(default)]
    pub(super) cookie_source: CookieSourceRequest,
}

impl fmt::Debug for DownloadInspectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadInspectRequest")
            .field("url", &"<redacted>")
            .field("cookie_source", &self.cookie_source)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum VideoQualityRequest {
    Best,
    AtMost { height: u16 },
    Exact { format_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum AudioQualityRequest {
    Best,
    Exact { format_id: String },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum AudioFormatRequest {
    Mp3,
    M4a,
    Flac,
    Wav,
}

impl From<AudioFormatRequest> for AudioDownloadFormat {
    fn from(value: AudioFormatRequest) -> Self {
        match value {
            AudioFormatRequest::Mp3 => Self::Mp3,
            AudioFormatRequest::M4a => Self::M4a,
            AudioFormatRequest::Flac => Self::Flac,
            AudioFormatRequest::Wav => Self::Wav,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum MediaSelectionRequest {
    Video {
        quality: VideoQualityRequest,
    },
    Audio {
        quality: AudioQualityRequest,
        format: AudioFormatRequest,
    },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SubtitleSourceRequest {
    Manual,
    Automatic,
}

impl From<SubtitleSourceRequest> for SubtitleSource {
    fn from(value: SubtitleSourceRequest) -> Self {
        match value {
            SubtitleSourceRequest::Manual => Self::Manual,
            SubtitleSourceRequest::Automatic => Self::Automatic,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubtitleSelectionRequest {
    pub(super) language: String,
    pub(super) source: SubtitleSourceRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadStartRequest {
    pub(super) inventory_id: InventoryId,
    pub(super) media: MediaSelectionRequest,
    pub(super) subtitle: Option<SubtitleSelectionRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DownloadPhaseResponse {
    Downloading,
    DownloadFinished,
    PostProcessing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgressResponse {
    pub(super) phase: DownloadPhaseResponse,
    pub(super) downloaded_bytes: Option<u64>,
    pub(super) total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    eta_seconds: Option<u64>,
    fraction: Option<f64>,
}

impl From<&DownloadProgress> for DownloadProgressResponse {
    fn from(value: &DownloadProgress) -> Self {
        Self {
            phase: match value.phase {
                DownloadPhase::Downloading => DownloadPhaseResponse::Downloading,
                DownloadPhase::DownloadFinished => DownloadPhaseResponse::DownloadFinished,
                DownloadPhase::PostProcessing => DownloadPhaseResponse::PostProcessing,
            },
            downloaded_bytes: value.downloaded_bytes,
            total_bytes: value.total_bytes,
            bytes_per_second: value.bytes_per_second,
            eta_seconds: value.eta_seconds,
            fraction: value.fraction,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedSubtitleResponse {
    pub(super) filename: String,
    pub(super) language: String,
    pub(super) content: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum DownloadJobEvent {
    Progress {
        job: JobSnapshot,
        progress: DownloadProgressResponse,
    },
    Completed {
        job: JobSnapshot,
        media: Box<MediaCandidateResponse>,
        summary: DownloadSummary,
        subtitle: Option<DownloadedSubtitleResponse>,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}
