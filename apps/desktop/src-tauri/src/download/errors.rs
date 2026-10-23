//! Download error mapping and path-free diagnostics.

use osg_domain::JobId;
use osg_download::{DownloadError, ProcessFailureKind};

use crate::diagnostics;
use crate::error::CommandError;

pub(super) fn map_download_error(error: &DownloadError) -> CommandError {
    match error {
        DownloadError::InvalidUrl(_)
        | DownloadError::UnsupportedSite
        | DownloadError::NonPublicAddress
        | DownloadError::ResolutionFailed => CommandError::invalid_input(
            "The media URL is invalid, unsupported, or does not resolve publicly.",
        ),
        DownloadError::InvalidOption(_)
        | DownloadError::FormatMismatch
        | DownloadError::SubtitleMismatch => {
            CommandError::invalid_input("The selected media format is invalid.")
        }
        DownloadError::InventoryNotFound | DownloadError::InventoryExpired => {
            CommandError::invalid_input("The media inspection expired. Inspect the URL again.")
        }
        DownloadError::InventoryRegistryFull => {
            CommandError::invalid_input("Too many inspected media items are active.")
        }
        DownloadError::BinaryNotFound
        | DownloadError::InvalidBinary(_)
        | DownloadError::JavaScriptRuntimeNotFound
        | DownloadError::InvalidJavaScriptRuntime(_)
        | DownloadError::FfmpegRequired => CommandError::media_tools_unavailable(),
        DownloadError::Cancelled => CommandError::internal("The media download was cancelled."),
        DownloadError::Spawn(_) => CommandError::downloader_execution_failed(),
        DownloadError::ProcessFailed { kind, .. } => match kind {
            ProcessFailureKind::AuthenticationRequired => {
                CommandError::downloader_authentication_required()
            }
            ProcessFailureKind::RateLimited => CommandError::downloader_rate_limited(),
            ProcessFailureKind::Network => CommandError::downloader_network_failed(),
            ProcessFailureKind::FormatUnavailable => CommandError::downloader_format_unavailable(),
            ProcessFailureKind::SourceUnavailable => CommandError::downloader_source_unavailable(),
            ProcessFailureKind::PostProcessing => CommandError::downloader_post_processing_failed(),
            ProcessFailureKind::Extractor | ProcessFailureKind::Unknown => {
                CommandError::downloader_execution_failed()
            }
        },
        DownloadError::InvalidDestination(_)
        | DownloadError::ProcessIo(_)
        | DownloadError::TimedOut { .. }
        | DownloadError::OutputLimit
        | DownloadError::InventoryJson(_)
        | DownloadError::InvalidInventory(_)
        | DownloadError::InventoryRegistryUnavailable
        | DownloadError::OutputExists
        | DownloadError::MissingArtifact
        | DownloadError::InvalidSubtitleArtifact
        | DownloadError::SubtitleArtifactTooLarge
        | DownloadError::Publish(_) => {
            CommandError::internal("The native media download could not be completed.")
        }
    }
}

pub(super) fn record_download_engine_failure(job_id: JobId, error: &DownloadError) {
    diagnostics::record(
        "download.engine_failed",
        &[
            ("job", job_id.to_string()),
            ("reason", download_error_diagnostic(error).to_owned()),
        ],
    );
}

pub(super) fn record_download_command_failure(job_id: JobId, error: &CommandError) {
    diagnostics::record(
        "download.command_failed",
        &[
            ("job", job_id.to_string()),
            ("code", error.code().to_owned()),
        ],
    );
}

pub(super) fn record_download_admission_failure(reason: &'static str, code: Option<&str>) {
    diagnostics::record(
        "download.admission_failed",
        &[
            ("reason", reason.to_owned()),
            ("code", code.unwrap_or("unknown").to_owned()),
        ],
    );
}

pub(super) fn record_download_inspection_failure(reason: &'static str, code: Option<&str>) {
    diagnostics::record(
        "download.inspection_failed",
        &[
            ("reason", reason.to_owned()),
            ("code", code.unwrap_or("unknown").to_owned()),
        ],
    );
}

pub(super) fn download_error_diagnostic(error: &DownloadError) -> &'static str {
    match error {
        DownloadError::InvalidUrl(_) => "invalid-url",
        DownloadError::UnsupportedSite => "unsupported-site",
        DownloadError::NonPublicAddress => "non-public-address",
        DownloadError::ResolutionFailed => "resolution-failed",
        DownloadError::InvalidOption(_) => "invalid-option",
        DownloadError::FormatMismatch => "format-mismatch",
        DownloadError::SubtitleMismatch => "subtitle-mismatch",
        DownloadError::InventoryNotFound => "inventory-not-found",
        DownloadError::InventoryExpired => "inventory-expired",
        DownloadError::InventoryRegistryFull => "inventory-registry-full",
        DownloadError::BinaryNotFound => "binary-not-found",
        DownloadError::InvalidBinary(_) => "invalid-binary",
        DownloadError::JavaScriptRuntimeNotFound => "javascript-runtime-not-found",
        DownloadError::InvalidJavaScriptRuntime(_) => "invalid-javascript-runtime",
        DownloadError::FfmpegRequired => "ffmpeg-required",
        DownloadError::Cancelled => "cancelled",
        DownloadError::Spawn(_) => "spawn-failed",
        DownloadError::ProcessFailed { kind, .. } => kind.diagnostic(),
        DownloadError::InvalidDestination(_) => "invalid-destination",
        DownloadError::ProcessIo(_) => "process-io",
        DownloadError::TimedOut { .. } => "timed-out",
        DownloadError::OutputLimit => "output-limit",
        DownloadError::InventoryJson(_) => "inventory-json",
        DownloadError::InvalidInventory(reason) => invalid_inventory_diagnostic(reason),
        DownloadError::InventoryRegistryUnavailable => "inventory-registry-unavailable",
        DownloadError::OutputExists => "output-exists",
        DownloadError::MissingArtifact => "missing-artifact",
        DownloadError::InvalidSubtitleArtifact => "invalid-subtitle-artifact",
        DownloadError::SubtitleArtifactTooLarge => "subtitle-artifact-too-large",
        DownloadError::Publish(_) => "publish-failed",
    }
}

fn invalid_inventory_diagnostic(reason: &'static str) -> &'static str {
    // `InvalidInventory` only carries compile-time strings owned by osg-download. Keep diagnostics
    // bounded and path/URL-free while distinguishing parser drift from size/shape attacks.
    match reason {
        "top level must be an object" => "invalid-inventory-top-level",
        "formats are missing" => "invalid-inventory-formats-missing",
        "formats are invalid" => "invalid-inventory-formats-shape",
        "too many formats" => "invalid-inventory-format-limit",
        "duplicate format ID" => "invalid-inventory-duplicate-format",
        "no usable formats" => "invalid-inventory-no-usable-formats",
        "direct media type is invalid" => "invalid-inventory-direct-type",
        "direct media passthrough is not approved" => "invalid-inventory-direct-unapproved",
        "direct format ID is invalid" => "invalid-inventory-direct-format",
        "direct formats are invalid" => "invalid-inventory-direct-formats",
        "direct formats are contradictory" => "invalid-inventory-direct-contradiction",
        "too many subtitle tracks" => "invalid-inventory-subtitle-limit",
        "too many subtitle representations" => "invalid-inventory-subtitle-representation-limit",
        "yt-dlp returned an invalid version" => "invalid-inventory-version",
        _ => "invalid-inventory",
    }
}
