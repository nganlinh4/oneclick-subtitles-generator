use std::io;

use thiserror::Error;

use osg_domain::{AssetId, JobId, ProjectId, RevisionId};

use super::ArtifactId;
use crate::secrets::CredentialPurpose;

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("could not prepare the application data directory: {0}")]
    Io(#[from] io::Error),
    #[error("SQLite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("the database actor is unavailable")]
    ActorUnavailable,
    #[error("the database actor stopped before replying")]
    ActorResponseDropped,
    #[error("database integrity check failed: {0}")]
    Integrity(String),
    #[error("SQLite refused WAL journal mode and returned `{0}`")]
    WalUnavailable(String),
    #[error("the database belongs to a different application (application_id {0:#010x})")]
    WrongApplicationId(i64),
    #[error("the database schema version {found} is newer than the supported version {supported}")]
    FutureSchema { found: u32, supported: u32 },
    #[error("bundled SQLite {found} is older than the required version {required}")]
    SqliteTooOld {
        found: String,
        required: &'static str,
    },
    #[error("invalid setting namespace or key")]
    InvalidSettingKey,
    #[error("credentials cannot be written to the settings database")]
    SecretSetting,
    #[error("credential metadata is invalid")]
    InvalidCredentialMetadata,
    #[error("the credential reference does not exist")]
    CredentialNotFound,
    #[error("a {0} credential already exists")]
    CredentialPurposeAlreadyExists(CredentialPurpose),
    #[error("a setting value exceeds the one MiB storage limit")]
    SettingTooLarge,
    #[error("the native media location is invalid or no longer matches its asset")]
    InvalidMediaLocation,
    #[error("media asset {0} has different immutable metadata")]
    MediaAssetMismatch(AssetId),
    #[error("the artifact storage root is invalid or was replaced")]
    InvalidArtifactRoot,
    #[error("the artifact store contains too many filesystem entries to reconcile safely")]
    ArtifactRootEntryLimitReached,
    #[error("artifact metadata is invalid")]
    InvalidArtifactMetadata,
    #[error("artifact kind is invalid")]
    InvalidArtifactKind,
    #[error("artifact failure code is invalid")]
    InvalidArtifactFailureCode,
    #[error("artifact size is invalid")]
    InvalidArtifactSize,
    #[error("artifact metadata exceeds the one MiB storage limit")]
    ArtifactMetadataTooLarge,
    #[error("the artifact record limit has been reached")]
    ArtifactLimitReached,
    #[error("artifact {0} does not exist")]
    ArtifactNotFound(ArtifactId),
    #[error("artifact {0} has different immutable content metadata")]
    ArtifactContentMismatch(ArtifactId),
    #[error("artifact {0} has incompatible ownership or retention metadata")]
    ArtifactReuseConflict(ArtifactId),
    #[error("artifact {0} cannot make that lifecycle transition")]
    InvalidArtifactTransition(ArtifactId),
    #[error("an artifact publication target already exists with different content")]
    ArtifactPublicationCollision,
    #[error("an artifact filesystem entry is missing, a symlink, or not a regular file")]
    InvalidArtifactFile,
    #[error("artifact {0} is not ready and cannot back a cache entry")]
    ArtifactNotCacheable(ArtifactId),
    #[error("cache category is invalid")]
    InvalidCacheCategory,
    #[error("cache key inputs are invalid or exceed their bounds")]
    InvalidCacheKey,
    #[error("cache entry metadata is invalid")]
    InvalidCacheEntry,
    #[error("the cache entry limit has been reached")]
    CacheLimitReached,
    #[error("the cache key is already bound to different immutable inputs")]
    CacheKeyConflict,
    #[error("cache lease metadata is invalid")]
    InvalidCacheLease,
    #[error("the cache lease limit has been reached")]
    CacheLeaseLimitReached,
    #[error("job {0} already exists")]
    JobAlreadyExists(JobId),
    #[error("job {0} does not exist")]
    JobNotFound(JobId),
    #[error("a newly created job must be queued at sequence zero")]
    InvalidNewJob(JobId),
    #[error("stored job metadata is invalid")]
    InvalidJobMetadata,
    #[error("job {0} is not a legal one-sequence successor")]
    InvalidJobSuccessor(JobId),
    #[error("job {0} has exhausted its durable sequence")]
    JobSequenceExhausted(JobId),
    #[error("job {0} changed during startup recovery")]
    ConcurrentJobRecovery(JobId),
    #[error("the stored setting is not valid JSON: {0}")]
    InvalidStoredJson(#[from] serde_json::Error),
    #[error("the database actor thread could not be started")]
    ActorStart,
    #[error("the database backup destination is invalid")]
    InvalidBackupPath,
    #[error("the database backup destination already exists")]
    BackupDestinationExists,
    #[error("project {0} already exists")]
    ProjectAlreadyExists(ProjectId),
    #[error("project {0} does not exist")]
    ProjectNotFound(ProjectId),
    #[error(
        "project {project_id} was changed by another writer (expected version {expected}, actual version {actual})"
    )]
    StaleProjectVersion {
        project_id: ProjectId,
        expected: u64,
        actual: u64,
    },
    #[error(
        "project {project_id} editor history changed (expected version {expected}, actual version {actual})"
    )]
    StaleProjectTrackHistory {
        project_id: ProjectId,
        expected: u64,
        actual: u64,
    },
    #[error("project {0} editor track changed outside its durable history")]
    ProjectTrackHistoryDiverged(ProjectId),
    #[error("project {0} has an ambiguous editor-track selector")]
    AmbiguousProjectTrackSelector(ProjectId),
    #[error("project {0} has exhausted the editor-history version range")]
    ProjectTrackHistoryVersionOverflow(ProjectId),
    #[error("project {0} has corrupt editor-track history")]
    CorruptProjectTrackHistory(ProjectId),
    #[error("project {0} has exhausted the durable state-version range")]
    ProjectVersionOverflow(ProjectId),
    #[error("project snapshot is invalid: {0}")]
    InvalidProjectSnapshot(String),
    #[error("the raw project snapshot is {actual} bytes, exceeding the {limit}-byte limit")]
    ProjectSnapshotTooLarge { limit: usize, actual: usize },
    #[error("the compressed project snapshot is {actual} bytes, exceeding the {limit}-byte limit")]
    CompressedProjectSnapshotTooLarge { limit: usize, actual: usize },
    #[error("legacy import metadata is invalid")]
    InvalidLegacyImport,
    #[error("the legacy import source does not exist")]
    LegacyImportNotFound,
    #[error("the legacy import source is already being processed")]
    LegacyImportBusy,
    #[error("the legacy import source is already complete")]
    LegacyImportComplete,
    #[error("project revision {revision_id} is corrupt: {detail}")]
    CorruptProjectRevision {
        revision_id: RevisionId,
        detail: &'static str,
    },
    #[error("project {project_id} reuses a {entity} identifier owned by another project")]
    CrossProjectIdentifier {
        project_id: ProjectId,
        entity: &'static str,
    },
    #[error("project {0} has corrupt revision-navigation state")]
    CorruptRevisionNavigation(ProjectId),
}
