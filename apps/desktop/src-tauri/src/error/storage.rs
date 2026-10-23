//! Application, database and job-registry error mapping to path-safe command errors.

use osg_application::{ApplicationError, JobRegistryError};
use osg_infrastructure::storage::DatabaseError;

use super::CommandError;

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
            | DatabaseError::MediaAssetMismatch(_)
            | DatabaseError::InvalidActiveWorkspace
            | DatabaseError::InvalidProjectAliasIndex
            | DatabaseError::StaleActiveWorkspaceIntent) => database_metadata_error(error),
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
            | DatabaseError::ArtifactPublicationInProgress(_)
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
            | DatabaseError::JobSequenceExhausted(_)
            | DatabaseError::InvalidJobResultDelivery
            | DatabaseError::JobResultDeliveryTooLarge
            | DatabaseError::JobResultDeliveryConflict(_)) => database_job_error(error),
            error @ (DatabaseError::ProjectAlreadyExists(_)
            | DatabaseError::InvalidProjectCreateKey
            | DatabaseError::ProjectCreateRequestConflict
            | DatabaseError::ProjectNotFound(_)
            | DatabaseError::StaleProjectVersion { .. }
            | DatabaseError::StaleProjectTrackHistory { .. }
            | DatabaseError::InvalidProjectRenderScene
            | DatabaseError::StaleProjectRenderScene { .. }
            | DatabaseError::ProjectRenderSceneVersionOverflow(_)
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
        DatabaseError::InvalidActiveWorkspace => CommandError::fixed(
            "activeWorkspaceInvalid",
            "The active editor workspace is invalid or no longer owns its media.",
        ),
        DatabaseError::InvalidProjectAliasIndex => CommandError::fixed(
            "subtitleProjectIndexInvalid",
            "The durable subtitle project index is invalid.",
        ),
        DatabaseError::StaleActiveWorkspaceIntent => CommandError::fixed(
            "activeWorkspaceSuperseded",
            "A newer editor workspace activation superseded this request.",
        ),
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
        DatabaseError::ArtifactPublicationInProgress(_)
        | DatabaseError::InvalidArtifactTransition(_) => CommandError::fixed(
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
        DatabaseError::InvalidJobResultDelivery => CommandError::fixed(
            "invalidJobResult",
            "The durable job result is invalid or unavailable.",
        ),
        DatabaseError::JobResultDeliveryTooLarge => CommandError::fixed(
            "jobResultTooLarge",
            "The durable job result exceeds its storage limit.",
        ),
        DatabaseError::JobResultDeliveryConflict(_) => CommandError::fixed(
            "jobResultConflict",
            "The job already owns a different durable result.",
        ),
        _ => unreachable!("job error classification is exhaustive"),
    }
}

fn database_project_error(error: &DatabaseError) -> CommandError {
    match error {
        DatabaseError::ProjectAlreadyExists(_) => {
            CommandError::fixed("projectAlreadyExists", "The project already exists.")
        }
        DatabaseError::InvalidProjectCreateKey => CommandError::fixed(
            "invalidProjectCreateKey",
            "The project create identity is invalid.",
        ),
        DatabaseError::ProjectCreateRequestConflict => CommandError::fixed(
            "projectCreateConflict",
            "The project create identity was already used for a different request.",
        ),
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
        DatabaseError::InvalidProjectRenderScene => CommandError::fixed(
            "projectDataCorrupt",
            "The stored project render scene is damaged.",
        ),
        DatabaseError::StaleProjectRenderScene { .. } => CommandError::fixed(
            "staleProjectRenderScene",
            "The project render scene changed. Reload it before rendering again.",
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
        | DatabaseError::ProjectRenderSceneVersionOverflow(_)
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
