//! The single path-safe, secret-free error type every command returns.

mod media;
mod providers;
mod storage;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub(crate) const fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    fn fixed(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal",
            message: message.into(),
        }
    }

    #[cfg(not(feature = "e2e-automation"))]
    pub(crate) fn invalid_path(message: impl Into<String>) -> Self {
        Self {
            code: "invalidPath",
            message: message.into(),
        }
    }

    pub(crate) fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: "invalidInput",
            message: message.into(),
        }
    }

    pub(crate) fn stale_project_version() -> Self {
        Self::fixed(
            "staleProjectVersion",
            "The project changed since it was opened. Reload it before saving again.",
        )
    }

    pub(crate) fn media_conversion_required() -> Self {
        Self {
            code: "mediaConversionRequired",
            message: "This media format must be converted before it can be sent to Gemini."
                .to_owned(),
        }
    }

    pub(crate) fn media_too_large() -> Self {
        Self {
            code: "mediaTooLarge",
            message: "The selected media file exceeds the 5 GB limit.".to_owned(),
        }
    }

    pub(crate) fn media_unavailable() -> Self {
        Self {
            code: "mediaUnavailable",
            message: "The stored media file is unavailable. Locate or import it again.".to_owned(),
        }
    }

    pub(crate) fn media_selection_changed() -> Self {
        Self::fixed(
            "mediaSelectionChanged",
            "The selected media changed before the operation completed.",
        )
    }

    pub(crate) fn media_export_unsafe() -> Self {
        Self::fixed(
            "unsafeExportDestination",
            "The selected export destination is unsafe or unavailable.",
        )
    }

    pub(crate) fn media_export_source_changed() -> Self {
        Self::fixed(
            "mediaSourceChanged",
            "The stored media changed while it was being exported.",
        )
    }

    pub(crate) fn media_export_failed() -> Self {
        Self::fixed(
            "mediaExportFailed",
            "The media file could not be exported to the selected destination.",
        )
    }

    pub(crate) fn speech_export_failed() -> Self {
        Self::fixed(
            "speechExportFailed",
            "The narration audio could not be exported to the selected destination.",
        )
    }

    pub(crate) fn subtitle_export_failed() -> Self {
        Self::fixed(
            "subtitleExportFailed",
            "The subtitle document could not be saved to the selected destination.",
        )
    }

    pub(crate) fn media_tools_unavailable() -> Self {
        Self {
            code: "mediaToolsUnavailable",
            message: "The verified FFmpeg and FFprobe tools are unavailable.".to_owned(),
        }
    }

    pub(crate) fn downloader_execution_failed() -> Self {
        Self::fixed(
            "downloaderExecutionFailed",
            "The native downloader could not complete the operation.",
        )
    }

    pub(crate) fn downloader_authentication_required() -> Self {
        Self::fixed(
            "downloaderAuthenticationRequired",
            "The source requires browser sign-in cookies.",
        )
    }

    pub(crate) fn downloader_rate_limited() -> Self {
        Self::fixed(
            "downloaderRateLimited",
            "The source temporarily rate-limited the downloader.",
        )
    }

    pub(crate) fn downloader_network_failed() -> Self {
        Self::fixed(
            "downloaderNetworkFailed",
            "The source refused or interrupted the media transfer.",
        )
    }

    pub(crate) fn downloader_format_unavailable() -> Self {
        Self::fixed(
            "downloaderFormatUnavailable",
            "The inspected media format is no longer available.",
        )
    }

    pub(crate) fn downloader_source_unavailable() -> Self {
        Self::fixed(
            "downloaderSourceUnavailable",
            "The source video is unavailable.",
        )
    }

    pub(crate) fn downloader_post_processing_failed() -> Self {
        Self::fixed(
            "downloaderPostProcessingFailed",
            "The downloaded streams could not be combined into a video.",
        )
    }

    pub(crate) fn render_busy() -> Self {
        Self::fixed(
            "renderBusy",
            "Another native video render is already running.",
        )
    }

    pub(crate) fn render_publication_failed() -> Self {
        Self::fixed(
            "renderPublicationFailed",
            "The rendered video could not be stored durably.",
        )
    }

    /// One typed refusal from the native export pipeline.
    ///
    /// The vocabulary itself lives in `crate::render::refusal`, beside the pipeline that produces
    /// it, because those codes name export outcomes and nothing else constructs them. Both halves
    /// are `&'static str`, so a refusal can carry no path, no credential and no subtitle text.
    pub(crate) fn render_refusal(code: &'static str, message: &'static str) -> Self {
        Self::fixed(code, message)
    }

    /// One value-free refusal from the glyph-atlas staging boundary.
    pub(crate) fn glyph_atlas_refusal(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn channel_closed() -> Self {
        Self {
            code: "channelClosed",
            message: "The result channel closed before the background job finished.".to_owned(),
        }
    }

    pub(crate) fn legacy_import_invalid() -> Self {
        Self::fixed(
            "invalidLegacyImport",
            "The selected legacy application data is invalid or unsafe.",
        )
    }

    pub(crate) fn legacy_import_too_large() -> Self {
        Self::fixed(
            "legacyImportTooLarge",
            "The selected legacy application data exceeds the migration limits.",
        )
    }

    pub(crate) fn legacy_import_busy() -> Self {
        Self::fixed(
            "legacyImportBusy",
            "Another legacy data migration is already running.",
        )
    }

    pub(crate) fn updater_unavailable() -> Self {
        Self::fixed(
            "updaterUnavailable",
            "The signed update service is unavailable.",
        )
    }

    pub(crate) fn updater_busy() -> Self {
        Self::fixed(
            "updaterBusy",
            "Another signed application update is already running.",
        )
    }

    pub(crate) fn updater_stale() -> Self {
        Self::fixed(
            "updaterStale",
            "The selected application update is no longer current.",
        )
    }

    pub(crate) fn updater_cancelled() -> Self {
        Self::fixed("updaterCancelled", "The application update was cancelled.")
    }

    #[cfg(not(feature = "e2e-automation"))]
    pub(crate) fn external_link_failed() -> Self {
        Self::fixed(
            "externalLinkUnavailable",
            "The requested external link could not be opened.",
        )
    }
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests;
