use osg_application::{ApplicationError, JobRegistryError};
use osg_infrastructure::secrets::{CredentialError, CredentialServiceError};
use osg_infrastructure::storage::DatabaseError;
use osg_media_server::MediaServerError;
use osg_providers::ProviderError;
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

    pub(crate) fn render_runtime_unavailable() -> Self {
        Self::fixed(
            "renderRuntimeUnavailable",
            "The verified native Remotion runtime is not installed for this platform.",
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

    pub(crate) fn external_link_failed() -> Self {
        Self::fixed(
            "externalLinkUnavailable",
            "The requested external link could not be opened.",
        )
    }
}

impl From<ApplicationError> for CommandError {
    fn from(error: ApplicationError) -> Self {
        Self {
            code: error.code().as_str(),
            message: error.to_string(),
        }
    }
}

impl From<DatabaseError> for CommandError {
    fn from(error: DatabaseError) -> Self {
        match &error {
            error @ (DatabaseError::InvalidSettingKey
            | DatabaseError::SecretSetting
            | DatabaseError::CredentialNotFound
            | DatabaseError::CredentialPurposeAlreadyExists(_)
            | DatabaseError::InvalidCredentialMetadata
            | DatabaseError::SettingTooLarge
            | DatabaseError::InvalidMediaLocation
            | DatabaseError::MediaAssetMismatch(_)) => database_metadata_error(error),
            error @ (DatabaseError::InvalidArtifactRoot
            | DatabaseError::ArtifactRootEntryLimitReached
            | DatabaseError::ArtifactPublicationCollision
            | DatabaseError::InvalidArtifactFile
            | DatabaseError::InvalidArtifactMetadata
            | DatabaseError::InvalidArtifactKind
            | DatabaseError::InvalidArtifactFailureCode
            | DatabaseError::InvalidArtifactSize
            | DatabaseError::ArtifactMetadataTooLarge
            | DatabaseError::ArtifactLimitReached
            | DatabaseError::ArtifactNotFound(_)
            | DatabaseError::ArtifactContentMismatch(_)
            | DatabaseError::ArtifactReuseConflict(_)
            | DatabaseError::InvalidArtifactTransition(_)
            | DatabaseError::ArtifactNotCacheable(_)) => database_artifact_error(error),
            error @ (DatabaseError::InvalidCacheCategory
            | DatabaseError::InvalidCacheKey
            | DatabaseError::InvalidCacheEntry
            | DatabaseError::InvalidCacheLease
            | DatabaseError::CacheLimitReached
            | DatabaseError::CacheKeyConflict
            | DatabaseError::CacheLeaseLimitReached) => database_cache_error(error),
            error @ (DatabaseError::JobAlreadyExists(_)
            | DatabaseError::JobNotFound(_)
            | DatabaseError::InvalidNewJob(_)
            | DatabaseError::InvalidJobMetadata
            | DatabaseError::InvalidJobSuccessor(_)
            | DatabaseError::JobSequenceExhausted(_)) => database_job_error(error),
            error @ (DatabaseError::ProjectAlreadyExists(_)
            | DatabaseError::ProjectNotFound(_)
            | DatabaseError::StaleProjectVersion { .. }
            | DatabaseError::StaleProjectTrackHistory { .. }
            | DatabaseError::ProjectTrackHistoryDiverged(_)
            | DatabaseError::AmbiguousProjectTrackSelector(_)
            | DatabaseError::ProjectTrackHistoryVersionOverflow(_)
            | DatabaseError::ProjectVersionOverflow(_)
            | DatabaseError::InvalidProjectSnapshot(_)
            | DatabaseError::CrossProjectIdentifier { .. }
            | DatabaseError::ProjectSnapshotTooLarge { .. }
            | DatabaseError::CompressedProjectSnapshotTooLarge { .. }
            | DatabaseError::CorruptProjectRevision { .. }
            | DatabaseError::CorruptProjectTrackHistory(_)
            | DatabaseError::CorruptRevisionNavigation(_)) => database_project_error(error),
            DatabaseError::InvalidLegacyImport => Self::fixed(
                "invalidLegacyImport",
                "The legacy migration metadata is invalid.",
            ),
            DatabaseError::LegacyImportNotFound => Self::fixed(
                "legacyImportNotFound",
                "The legacy migration record does not exist.",
            ),
            DatabaseError::LegacyImportBusy => Self::legacy_import_busy(),
            DatabaseError::LegacyImportComplete => Self::fixed(
                "legacyImportComplete",
                "The legacy migration is already complete.",
            ),
            _ => Self::fixed("database", "The local application database is unavailable."),
        }
    }
}

fn database_metadata_error(error: &DatabaseError) -> CommandError {
    match error {
        DatabaseError::InvalidSettingKey => {
            CommandError::fixed("invalidSetting", "The setting name is invalid.")
        }
        DatabaseError::SecretSetting => CommandError::fixed(
            "secretSetting",
            "Credentials cannot be stored as application settings.",
        ),
        DatabaseError::CredentialNotFound => {
            CommandError::fixed("credentialNotFound", "The credential does not exist.")
        }
        DatabaseError::CredentialPurposeAlreadyExists(_) => CommandError::fixed(
            "credentialPurposeExists",
            "A credential already exists for this purpose.",
        ),
        DatabaseError::InvalidCredentialMetadata => {
            CommandError::fixed("invalidCredential", "The credential metadata is invalid.")
        }
        DatabaseError::SettingTooLarge => {
            CommandError::fixed("settingTooLarge", "The setting value is too large.")
        }
        DatabaseError::InvalidMediaLocation => CommandError::fixed(
            "invalidMediaLocation",
            "The selected media file is unavailable or changed while it was being imported.",
        ),
        DatabaseError::MediaAssetMismatch(_) => CommandError::fixed(
            "mediaIdentityConflict",
            "The media identifier conflicts with different stored metadata.",
        ),
        _ => unreachable!("metadata error classification is exhaustive"),
    }
}

fn database_artifact_error(error: &DatabaseError) -> CommandError {
    match error {
        DatabaseError::InvalidArtifactRoot
        | DatabaseError::ArtifactRootEntryLimitReached
        | DatabaseError::ArtifactPublicationCollision
        | DatabaseError::InvalidArtifactFile => CommandError::fixed(
            "artifactStorage",
            "Artifact storage is unavailable or inconsistent.",
        ),
        DatabaseError::InvalidArtifactMetadata => CommandError::fixed(
            "artifactDataCorrupt",
            "Stored artifact metadata is invalid.",
        ),
        DatabaseError::InvalidArtifactKind
        | DatabaseError::InvalidArtifactFailureCode
        | DatabaseError::InvalidArtifactSize => {
            CommandError::fixed("invalidArtifactRequest", "The artifact request is invalid.")
        }
        DatabaseError::ArtifactMetadataTooLarge => CommandError::fixed(
            "artifactMetadataTooLarge",
            "The artifact metadata is too large.",
        ),
        DatabaseError::ArtifactLimitReached => CommandError::fixed(
            "artifactLimit",
            "The artifact storage limit has been reached.",
        ),
        DatabaseError::ArtifactNotFound(_) => {
            CommandError::fixed("artifactNotFound", "The artifact does not exist.")
        }
        DatabaseError::ArtifactContentMismatch(_) => CommandError::fixed(
            "artifactContentMismatch",
            "The artifact content does not match its stored identity.",
        ),
        DatabaseError::ArtifactReuseConflict(_) => CommandError::fixed(
            "artifactConflict",
            "The artifact conflicts with existing ownership or retention metadata.",
        ),
        DatabaseError::InvalidArtifactTransition(_) => CommandError::fixed(
            "artifactStateConflict",
            "The artifact cannot perform that operation in its current state.",
        ),
        DatabaseError::ArtifactNotCacheable(_) => {
            CommandError::fixed("artifactNotReady", "The artifact is not ready for caching.")
        }
        _ => unreachable!("artifact error classification is exhaustive"),
    }
}

fn database_cache_error(error: &DatabaseError) -> CommandError {
    match error {
        DatabaseError::InvalidCacheCategory
        | DatabaseError::InvalidCacheKey
        | DatabaseError::InvalidCacheEntry
        | DatabaseError::InvalidCacheLease => {
            CommandError::fixed("invalidCacheRequest", "The cache request is invalid.")
        }
        DatabaseError::CacheLimitReached => {
            CommandError::fixed("cacheLimit", "The cache entry limit has been reached.")
        }
        DatabaseError::CacheKeyConflict => CommandError::fixed(
            "cacheKeyConflict",
            "The cache key conflicts with different stored inputs.",
        ),
        DatabaseError::CacheLeaseLimitReached => {
            CommandError::fixed("cacheLeaseLimit", "The cache lease limit has been reached.")
        }
        _ => unreachable!("cache error classification is exhaustive"),
    }
}

fn database_job_error(error: &DatabaseError) -> CommandError {
    match error {
        DatabaseError::JobAlreadyExists(_) => {
            CommandError::fixed("jobAlreadyExists", "The job already exists.")
        }
        DatabaseError::JobNotFound(_) => {
            CommandError::fixed("jobNotFound", "The job does not exist.")
        }
        DatabaseError::InvalidNewJob(_)
        | DatabaseError::InvalidJobMetadata
        | DatabaseError::InvalidJobSuccessor(_) => {
            CommandError::fixed("invalidJob", "The job data is invalid.")
        }
        DatabaseError::JobSequenceExhausted(_) => {
            CommandError::fixed("jobSequenceLimit", "The job can no longer be updated.")
        }
        _ => unreachable!("job error classification is exhaustive"),
    }
}

fn database_project_error(error: &DatabaseError) -> CommandError {
    match error {
        DatabaseError::ProjectAlreadyExists(_) => {
            CommandError::fixed("projectAlreadyExists", "The project already exists.")
        }
        DatabaseError::ProjectNotFound(_) => {
            CommandError::fixed("projectNotFound", "The project does not exist.")
        }
        DatabaseError::StaleProjectVersion { .. } => CommandError::fixed(
            "staleProjectVersion",
            "The project changed since it was opened. Reload it before saving again.",
        ),
        DatabaseError::StaleProjectTrackHistory { .. } => CommandError::fixed(
            "staleProjectTrackHistory",
            "The subtitle editor history changed. Reload it before saving again.",
        ),
        DatabaseError::ProjectTrackHistoryDiverged(_) => CommandError::fixed(
            "projectTrackHistoryDiverged",
            "The subtitle track changed outside this editor history.",
        ),
        DatabaseError::AmbiguousProjectTrackSelector(_) => CommandError::fixed(
            "invalidProject",
            "The project contains an ambiguous subtitle-track slot.",
        ),
        DatabaseError::ProjectVersionOverflow(_)
        | DatabaseError::ProjectTrackHistoryVersionOverflow(_) => CommandError::fixed(
            "projectVersionLimit",
            "The project can no longer create revisions.",
        ),
        DatabaseError::InvalidProjectSnapshot(_) | DatabaseError::CrossProjectIdentifier { .. } => {
            CommandError::fixed("invalidProject", "The project data is invalid.")
        }
        DatabaseError::ProjectSnapshotTooLarge { .. }
        | DatabaseError::CompressedProjectSnapshotTooLarge { .. } => {
            CommandError::fixed("projectTooLarge", "The project is too large to save.")
        }
        DatabaseError::CorruptProjectRevision { .. }
        | DatabaseError::CorruptProjectTrackHistory(_)
        | DatabaseError::CorruptRevisionNavigation(_) => {
            CommandError::fixed("projectDataCorrupt", "The stored project data is damaged.")
        }
        _ => unreachable!("project error classification is exhaustive"),
    }
}

impl From<JobRegistryError<DatabaseError>> for CommandError {
    fn from(error: JobRegistryError<DatabaseError>) -> Self {
        match error {
            JobRegistryError::NotFound(_) => Self {
                code: "jobNotFound",
                message: "The job does not exist.".to_owned(),
            },
            JobRegistryError::Conflict { .. } => Self {
                code: "jobConflict",
                message: "The job changed concurrently. Refresh its status and try again."
                    .to_owned(),
            },
            JobRegistryError::Domain(_) => Self {
                code: "invalidJobState",
                message: "The job cannot perform that operation in its current state.".to_owned(),
            },
            JobRegistryError::Store(error) => error.into(),
            JobRegistryError::Duplicate(_)
            | JobRegistryError::Unavailable
            | JobRegistryError::InvalidLookup(_)
            | JobRegistryError::InvalidConflict(_) => Self {
                code: "jobRegistry",
                message: "The background job registry is unavailable.".to_owned(),
            },
        }
    }
}

impl From<MediaServerError> for CommandError {
    fn from(error: MediaServerError) -> Self {
        let code = match &error {
            MediaServerError::InvalidPath | MediaServerError::EmptyFile => "invalidPath",
            MediaServerError::RegistryFull => "mediaRegistryFull",
            MediaServerError::Bind(_)
            | MediaServerError::Thread(_)
            | MediaServerError::InvalidOrigin
            | MediaServerError::RegistryUnavailable => "mediaServer",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<osg_media::MediaError> for CommandError {
    fn from(error: osg_media::MediaError) -> Self {
        use osg_media::MediaError;

        let (code, message) = match error {
            MediaError::BinaryNotFound(_) | MediaError::InvalidBinary { .. } => (
                "mediaToolsUnavailable",
                "The bundled media tools are unavailable or invalid.",
            ),
            MediaError::InvalidPath { .. } => (
                "invalidMediaLocation",
                "The selected media file is unavailable or invalid.",
            ),
            MediaError::InvalidOption(_) | MediaError::UnsupportedConversion => (
                "invalidMediaOperation",
                "The requested media operation is not supported.",
            ),
            MediaError::TimedOut { .. } => (
                "mediaTimeout",
                "The media operation exceeded its safe time limit.",
            ),
            MediaError::Cancelled(_) => ("mediaCancelled", "The media operation was cancelled."),
            MediaError::OutputExists => (
                "mediaOutputExists",
                "The media output already exists and was not overwritten.",
            ),
            MediaError::MissingArtifact => (
                "mediaArtifactMissing",
                "The media tool did not produce a valid output artifact.",
            ),
            MediaError::InvalidProbe(_)
            | MediaError::ProbeJson(_)
            | MediaError::InvalidWaveform(_) => (
                "invalidMediaMetadata",
                "The media metadata or waveform output is invalid.",
            ),
            MediaError::Spawn { .. }
            | MediaError::ProcessIo { .. }
            | MediaError::ProcessFailed { .. }
            | MediaError::OutputLimit { .. }
            | MediaError::Finalize(_) => (
                "mediaToolFailure",
                "The native media tool could not complete the operation.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl From<osg_native_tools::NativeToolError> for CommandError {
    fn from(error: osg_native_tools::NativeToolError) -> Self {
        use osg_native_tools::NativeToolError;

        match error {
            NativeToolError::InvalidRequest => Self::fixed(
                "invalidNativeToolRequest",
                "The native tool request is invalid.",
            ),
            NativeToolError::DeliveryUnavailable => Self::fixed(
                "nativeToolUnavailable",
                "No reviewed native tool delivery is available for this platform.",
            ),
            NativeToolError::OperationInProgress(_) => Self::fixed(
                "nativeToolBusy",
                "Another native tool operation is already running.",
            ),
            NativeToolError::Cancelled => Self::fixed(
                "nativeToolCancelled",
                "The native tool operation was cancelled.",
            ),
            NativeToolError::RuntimeBusy => Self::fixed(
                "nativeToolInUse",
                "Wait for the current media operation to finish, then retry the tool change.",
            ),
            NativeToolError::Network
            | NativeToolError::IncompleteDownload
            | NativeToolError::StorageLimit => Self::fixed(
                "nativeToolDownloadFailed",
                "The verified native tool package could not be downloaded.",
            ),
            NativeToolError::Integrity | NativeToolError::UnsafeArchive => Self::fixed(
                "nativeToolIntegrityFailed",
                "The native tool package failed integrity or archive verification.",
            ),
            NativeToolError::InvalidInstall => Self::fixed(
                "nativeToolInstallModified",
                "The native tool installation is incomplete or locally modified.",
            ),
            NativeToolError::StoreUnavailable | NativeToolError::InvalidCatalog => Self::fixed(
                "nativeToolStorage",
                "The verified native tool store is unavailable.",
            ),
        }
    }
}

impl From<osg_render::RenderError> for CommandError {
    fn from(error: osg_render::RenderError) -> Self {
        use osg_render::RenderError;

        match error {
            RenderError::InvalidRequest => Self::fixed(
                "invalidRenderRequest",
                "The video render request is invalid.",
            ),
            RenderError::SourceChanged => Self::fixed(
                "renderSourceChanged",
                "The source media changed before rendering completed.",
            ),
            RenderError::NarrationChanged => Self::fixed(
                "renderNarrationChanged",
                "The narration audio changed before rendering completed.",
            ),
            RenderError::RuntimeUnavailable => Self::render_runtime_unavailable(),
            RenderError::StagingUnavailable => Self::fixed(
                "renderStagingUnavailable",
                "The native render staging area is unavailable.",
            ),
            RenderError::MediaPreparationFailed => Self::fixed(
                "renderMediaPreparationFailed",
                "The native media preparation step could not complete.",
            ),
            RenderError::InvalidWorkerProtocol => Self::fixed(
                "renderWorkerProtocol",
                "The managed render worker returned an invalid response.",
            ),
            RenderError::WorkerFailed => Self::fixed(
                "renderWorkerFailed",
                "The managed Remotion worker could not complete the render.",
            ),
            RenderError::Cancelled => {
                Self::fixed("renderCancelled", "The video render was cancelled.")
            }
            RenderError::TimedOut => Self::fixed(
                "renderTimeout",
                "The video render exceeded its safe time limit.",
            ),
            RenderError::InvalidOutput => Self::fixed(
                "renderOutputInvalid",
                "The managed render worker did not produce a valid MP4 output.",
            ),
            RenderError::Io => Self::fixed(
                "renderIo",
                "The native video render could not access its managed files.",
            ),
        }
    }
}

impl From<osg_media_pipeline::PipelineError> for CommandError {
    fn from(error: osg_media_pipeline::PipelineError) -> Self {
        use osg_media_pipeline::PipelineError;

        match error {
            PipelineError::Media(error) => error.into(),
            PipelineError::MissingAudio => Self::fixed(
                "mediaMissingAudio",
                "The selected media does not contain an audio stream.",
            ),
            PipelineError::NoPlayableStream => Self::fixed(
                "mediaNotPlayable",
                "The selected media does not contain a playable audio or video stream.",
            ),
            PipelineError::InvalidClipRange => Self::fixed(
                "invalidMediaRange",
                "The requested clip range is outside the selected media.",
            ),
            PipelineError::StagingUnavailable => Self::fixed(
                "mediaStagingUnavailable",
                "The native media staging area is unavailable or inconsistent.",
            ),
        }
    }
}

impl From<osg_asr::AsrError> for CommandError {
    fn from(error: osg_asr::AsrError) -> Self {
        use osg_asr::AsrError;

        let (code, message) = match error {
            AsrError::InvalidOption(_)
            | AsrError::LanguageUnsupported
            | AsrError::LanguageUnavailable => (
                "invalidAsrRequest",
                "The requested ASR options are not supported by this engine.",
            ),
            AsrError::InvalidAudio => (
                "invalidAsrAudio",
                "The selected media could not be normalized for transcription.",
            ),
            AsrError::InvalidRuntime => (
                "asrRuntimeUnavailable",
                "This local ASR engine is not installed or its runtime is incomplete.",
            ),
            AsrError::Cancelled => ("asrCancelled", "The ASR operation was cancelled."),
            AsrError::TimedOut(_) => (
                "asrTimeout",
                "The ASR operation exceeded its safe time limit.",
            ),
            AsrError::InvalidOutput | AsrError::Protocol(_) | AsrError::OutputLimit => (
                "invalidAsrOutput",
                "The ASR worker returned invalid or excessive transcription data.",
            ),
            AsrError::Spawn(_)
            | AsrError::ProcessIo { .. }
            | AsrError::WorkerFailed(_)
            | AsrError::Synchronization => (
                "asrWorkerFailure",
                "The local ASR worker could not complete the transcription.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl From<osg_engine_packages::PackageError> for CommandError {
    fn from(error: osg_engine_packages::PackageError) -> Self {
        use osg_engine_packages::PackageError;

        let (code, message) = match error {
            PackageError::InvalidRequest => (
                "invalidEnginePackageRequest",
                "The engine package request is invalid.",
            ),
            PackageError::DeliveryUnavailable => (
                "packageUnavailable",
                "No verified package is available for this engine and platform.",
            ),
            PackageError::OperationInProgress(_)
            | PackageError::SpeechOperationInProgress(_)
            | PackageError::RenderOperationInProgress(_)
            | PackageError::AssetOperationInProgress(_)
            | PackageError::UiFontOperationInProgress(_) => (
                "packageOperationInProgress",
                "Another engine package operation is already active.",
            ),
            PackageError::Cancelled => (
                "enginePackageCancelled",
                "The engine package operation was cancelled.",
            ),
            PackageError::Network => (
                "packageNetwork",
                "The verified engine package could not be downloaded.",
            ),
            PackageError::InvalidResume | PackageError::IncompleteDownload => (
                "packageDownloadInvalid",
                "The engine package download is incomplete or cannot be resumed safely.",
            ),
            PackageError::StorageLimit => (
                "packageStorageLimit",
                "The engine package exceeds the application storage limit.",
            ),
            PackageError::InsufficientSpace => (
                "packageInsufficientSpace",
                "There is not enough free disk space for this engine package.",
            ),
            PackageError::ArchiveIntegrity | PackageError::UnsafeArchive => (
                "packageIntegrity",
                "The engine package failed integrity or archive safety checks.",
            ),
            PackageError::InvalidInstall => (
                "packageInstallInvalid",
                "The installed engine package is incomplete or was modified.",
            ),
            PackageError::RuntimeBusy => (
                "engineRuntimeBusy",
                "The engine package is currently in use.",
            ),
            PackageError::StoreUnavailable => {
                ("packageStorage", "The engine package store is unavailable.")
            }
            PackageError::InvalidCatalog => (
                "packageCatalogInvalid",
                "The embedded engine package catalog is invalid.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl From<CredentialError> for CommandError {
    fn from(error: CredentialError) -> Self {
        let code = match error {
            CredentialError::Unavailable => "credentialStoreUnavailable",
            CredentialError::Locked => "credentialStoreLocked",
            CredentialError::NotFound => "credentialNotFound",
            CredentialError::InvalidCredential => "invalidCredential",
            CredentialError::PurposeMismatch => "credentialPurposeMismatch",
            CredentialError::EmptySecret => "emptyCredential",
            CredentialError::VerificationFailed => "credentialVerificationFailed",
            CredentialError::BackendFailure => "credentialStoreFailure",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<ProviderError> for CommandError {
    fn from(error: ProviderError) -> Self {
        let (code, message) = match error {
            ProviderError::InvalidRequest => {
                ("invalidProviderRequest", "The provider request is invalid.")
            }
            ProviderError::InvalidResponse => (
                "invalidProviderResponse",
                "The provider returned invalid or excessive data.",
            ),
            ProviderError::Timeout => (
                "providerTimeout",
                "The provider request exceeded its safe time limit.",
            ),
            ProviderError::Transport => (
                "providerNetwork",
                "The provider request could not be completed.",
            ),
            ProviderError::Unauthorized => (
                "providerCredentialRejected",
                "The provider rejected the configured credential.",
            ),
            ProviderError::AuthenticationRequired => (
                "youtubeAuthenticationRequired",
                "YouTube authentication is required.",
            ),
            ProviderError::QuotaExceeded => (
                "youtubeQuotaExceeded",
                "The YouTube quota has been exceeded.",
            ),
            ProviderError::ApiNotEnabled => (
                "youtubeApiNotEnabled",
                "The YouTube Data API is not enabled for this project.",
            ),
            ProviderError::NotFound => (
                "providerResultNotFound",
                "No matching provider result was found.",
            ),
            ProviderError::OAuthDenied => (
                "oauthDenied",
                "The YouTube authorization request was denied.",
            ),
            ProviderError::OAuthBusy => (
                "oauthBusy",
                "Another YouTube authorization request is already active.",
            ),
            ProviderError::OAuthCancelled => (
                "oauthCancelled",
                "The YouTube authorization request was cancelled.",
            ),
            ProviderError::OAuthExpired => {
                ("oauthExpired", "The YouTube authorization request expired.")
            }
            ProviderError::BrowserOpen => (
                "oauthBrowserUnavailable",
                "The system browser could not be opened for YouTube authorization.",
            ),
        };
        Self::fixed(code, message)
    }
}

impl From<CredentialServiceError> for CommandError {
    fn from(error: CredentialServiceError) -> Self {
        match error {
            CredentialServiceError::Credential(error) => error.into(),
            CredentialServiceError::Database(error) => error.into(),
        }
    }
}

impl From<osg_gemini::Error> for CommandError {
    fn from(error: osg_gemini::Error) -> Self {
        use osg_gemini::Error;

        let (code, message) = match error {
            Error::Cancelled => ("geminiCancelled", "The Gemini operation was cancelled."),
            Error::InvalidConfig(_) | Error::InvalidRequest(_) => (
                "invalidGeminiRequest",
                "The Gemini request or configuration is invalid.",
            ),
            Error::UnsupportedMimeType(_) => (
                "unsupportedGeminiMedia",
                "Gemini does not support this media format.",
            ),
            Error::InlineRequestTooLarge { .. } | Error::UploadTooLarge { .. } => (
                "geminiMediaTooLarge",
                "The media is too large for the configured Gemini request limits.",
            ),
            Error::Io { .. } => (
                "geminiMediaUnavailable",
                "The selected media file is no longer available.",
            ),
            Error::Transport(_) | Error::UploadOutcomeUnknown => (
                "geminiNetwork",
                "Gemini could not be reached reliably. Check the connection and try again.",
            ),
            Error::Timeout { .. } => (
                "geminiTimeout",
                "Gemini did not finish within the configured time limit.",
            ),
            Error::Provider(provider) => match provider.http_status {
                400 | 404 => (
                    "invalidGeminiRequest",
                    "Gemini rejected the selected model or request.",
                ),
                401 | 403 => (
                    "geminiCredentialRejected",
                    "Gemini rejected the selected credential.",
                ),
                429 => (
                    "geminiRateLimited",
                    "Gemini is rate limited or out of quota. Try another configured key or wait.",
                ),
                _ => ("geminiProvider", "Gemini could not complete the operation."),
            },
            Error::CooldownActive { .. } => (
                "geminiRateLimited",
                "The selected Gemini model is cooling down after a rate limit.",
            ),
            Error::UploadProtocol(_) | Error::FileProcessingFailed { .. } => (
                "geminiUpload",
                "Gemini could not process the uploaded media.",
            ),
            Error::ResponseTooLarge { .. } => (
                "geminiResponseTooLarge",
                "The Gemini response exceeded the safe application limit.",
            ),
            Error::NoTextOutput => ("geminiNoText", "Gemini returned no usable text output."),
            Error::NoImageOutput => (
                "geminiNoImage",
                "Gemini returned no usable generated image.",
            ),
            Error::InvalidImageOutput => (
                "geminiInvalidImage",
                "Gemini returned malformed generated image data.",
            ),
            Error::ImageOutputBlocked => (
                "geminiImageBlocked",
                "Gemini blocked the requested generated image.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use std::io;

    use osg_domain::{ProjectId, RevisionId};
    use osg_infrastructure::storage::DatabaseError;

    use super::CommandError;

    #[test]
    fn database_errors_exposed_to_the_webview_are_sanitized() {
        let path_error = DatabaseError::Io(io::Error::other(
            "C:\\Users\\private\\AppData\\Local\\secret.sqlite3",
        ));
        let command: CommandError = path_error.into();

        assert_eq!(command.code, "database");
        assert!(!command.message.contains("Users"));

        let revision_error = DatabaseError::CorruptProjectRevision {
            revision_id: RevisionId::new(),
            detail: "raw blob contains a private diagnostic",
        };
        let command: CommandError = revision_error.into();
        assert_eq!(command.code, "projectDataCorrupt");
        assert!(!command.message.contains("private diagnostic"));

        let stale = DatabaseError::StaleProjectVersion {
            project_id: ProjectId::new(),
            expected: 3,
            actual: 4,
        };
        let command: CommandError = stale.into();
        assert_eq!(command.code, "staleProjectVersion");
        assert!(!command.message.contains('3'));
        assert!(!command.message.contains('4'));

        let stale_track = DatabaseError::StaleProjectTrackHistory {
            project_id: ProjectId::new(),
            expected: 9,
            actual: 10,
        };
        let command: CommandError = stale_track.into();
        assert_eq!(command.code, "staleProjectTrackHistory");
        assert!(!command.message.contains('9'));
        assert!(!command.message.contains("10"));
    }

    #[test]
    fn gemini_errors_exposed_to_the_webview_are_sanitized() {
        let provider = osg_gemini::Error::Provider(osg_gemini::ProviderError {
            http_status: 429,
            api_status: Some("RESOURCE_EXHAUSTED".to_owned()),
            message: "private prompt, key, and provider diagnostic".to_owned(),
            retry_after: Some(std::time::Duration::from_secs(17)),
            retryable: true,
        });
        let command: CommandError = provider.into();

        assert_eq!(command.code, "geminiRateLimited");
        assert!(!command.message.contains("private prompt"));
        assert!(!command.message.contains("RESOURCE_EXHAUSTED"));
        assert!(!command.message.contains("17"));
    }

    #[test]
    fn engine_package_errors_exposed_to_the_webview_are_bounded_and_sanitized() {
        let command: CommandError = osg_engine_packages::PackageError::OperationInProgress(
            osg_engine_packages::EngineId::Qwen3Asr1_7b,
        )
        .into();

        assert_eq!(command.code, "packageOperationInProgress");
        assert!(!command.message.contains("qwen"));
        assert!(!command.message.contains("Users"));

        let integrity: CommandError = osg_engine_packages::PackageError::ArchiveIntegrity.into();
        assert_eq!(integrity.code, "packageIntegrity");
        assert!(!integrity.message.contains("http"));
    }
}
