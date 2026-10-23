use std::fs;
use std::path::{Path, PathBuf};

use osg_domain::{JobId, ProjectId};
use serde::Serialize;
use serde_json::Value;

use super::DatabaseError;
use root::remove_if_regular;
use rows::{validate_metadata, validate_size};

mod cache;
mod ids;
mod reconcile;
mod registry;
mod root;
mod rows;

pub(super) use cache::{
    cache_info, clear_cache, clear_cache_with_info, commit_cache_artifact, invalidate_cache,
    lease_cache, lookup_cache, put_cache, release_cache_lease,
};
pub use ids::{
    ArtifactFailureCode, ArtifactId, ArtifactKind, CacheCategory, CacheKey, CacheLeaseId,
    ContentHash,
};
pub(super) use reconcile::reconcile;
pub(super) use registry::{
    fail, get, list_ready_for_project, ready, register, register_media, remove,
    remove_transactional, resolve,
};
pub(super) use root::ArtifactRoot;

pub const MAX_ARTIFACT_SIZE_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
pub const MAX_ARTIFACTS: u64 = 100_000;
pub const MAX_CACHE_ENTRIES: u64 = 100_000;
pub const MAX_CACHE_LEASES: u64 = 10_000;
pub const MAX_ARTIFACT_METADATA_BYTES: usize = 1024 * 1024;
const MAX_CACHE_KEY_PARTS: usize = 64;
const MAX_CACHE_KEY_INPUT_BYTES: usize = 1024 * 1024;
const MAX_ROOT_ENTRIES: usize = 200_000;
const MAX_CACHE_LEASE_MS: u64 = 24 * 60 * 60 * 1000;
const ROOT_IDENTITY_FILE: &str = ".root-identity";
const COMMIT_ON_JOB_SUCCESS_METADATA_KEY: &str = "commitOnJobSuccess";
const MEDIA_ARTIFACT_METADATA_KEY: &str = "osgMediaArtifact";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactState {
    Pending,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactRetention {
    Durable,
    Cache,
}

#[derive(Clone)]
pub struct ArtifactDraft {
    kind: ArtifactKind,
    content_hash: ContentHash,
    size_bytes: u64,
    retention: ArtifactRetention,
    project_id: Option<ProjectId>,
    job_id: Option<JobId>,
    metadata: Value,
}

impl ArtifactDraft {
    pub fn new(
        kind: ArtifactKind,
        content_hash: ContentHash,
        size_bytes: u64,
        metadata: Value,
    ) -> Result<Self, DatabaseError> {
        validate_size(size_bytes)?;
        validate_metadata(&metadata)?;
        Ok(Self {
            kind,
            content_hash,
            size_bytes,
            retention: ArtifactRetention::Durable,
            project_id: None,
            job_id: None,
            metadata,
        })
    }

    pub fn new_cache(
        kind: ArtifactKind,
        content_hash: ContentHash,
        size_bytes: u64,
        metadata: Value,
    ) -> Result<Self, DatabaseError> {
        let mut draft = Self::new(kind, content_hash, size_bytes, metadata)?;
        draft.retention = ArtifactRetention::Cache;
        Ok(draft)
    }

    #[must_use]
    pub const fn with_project(mut self, project_id: ProjectId) -> Self {
        self.project_id = Some(project_id);
        self
    }

    #[must_use]
    pub const fn with_job(mut self, job_id: JobId) -> Self {
        self.job_id = Some(job_id);
        self
    }
}

impl std::fmt::Debug for ArtifactDraft {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtifactDraft")
            .field("kind", &self.kind)
            .field("content_hash", &self.content_hash)
            .field("size_bytes", &self.size_bytes)
            .field("retention", &self.retention)
            .field("project_id", &self.project_id)
            .field("job_id", &self.job_id)
            .field("metadata", &"<redacted>")
            .finish()
    }
}

#[derive(Clone)]
pub struct ArtifactRecord {
    id: ArtifactId,
    project_id: Option<ProjectId>,
    job_id: Option<JobId>,
    kind: ArtifactKind,
    relative_path: String,
    content_hash: ContentHash,
    size_bytes: u64,
    retention: ArtifactRetention,
    state: ArtifactState,
    failure_code: Option<ArtifactFailureCode>,
    metadata: Value,
    created_at_ms: u64,
    updated_at_ms: u64,
}

impl ArtifactRecord {
    #[must_use]
    pub const fn id(&self) -> ArtifactId {
        self.id
    }
    #[must_use]
    pub const fn project_id(&self) -> Option<ProjectId> {
        self.project_id
    }
    #[must_use]
    pub const fn job_id(&self) -> Option<JobId> {
        self.job_id
    }
    #[must_use]
    pub const fn kind(&self) -> &ArtifactKind {
        &self.kind
    }
    #[must_use]
    pub const fn content_hash(&self) -> ContentHash {
        self.content_hash
    }
    #[must_use]
    pub const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }
    #[must_use]
    pub const fn retention(&self) -> ArtifactRetention {
        self.retention
    }
    #[must_use]
    pub const fn state(&self) -> ArtifactState {
        self.state
    }
    #[must_use]
    pub const fn failure_code(&self) -> Option<&ArtifactFailureCode> {
        self.failure_code.as_ref()
    }
    #[must_use]
    pub const fn metadata(&self) -> &Value {
        &self.metadata
    }
    #[must_use]
    pub const fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    #[must_use]
    pub const fn updated_at_ms(&self) -> u64 {
        self.updated_at_ms
    }
}

impl std::fmt::Debug for ArtifactRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtifactRecord")
            .field("id", &self.id)
            .field("project_id", &self.project_id)
            .field("job_id", &self.job_id)
            .field("kind", &self.kind)
            .field("relative_path", &"<redacted>")
            .field("content_hash", &self.content_hash)
            .field("size_bytes", &self.size_bytes)
            .field("retention", &self.retention)
            .field("state", &self.state)
            .field("failure_code", &self.failure_code)
            .field("metadata", &"<redacted>")
            .field("created_at_ms", &self.created_at_ms)
            .field("updated_at_ms", &self.updated_at_ms)
            .finish()
    }
}

#[derive(Clone)]
pub struct ArtifactStaging {
    record: ArtifactRecord,
    path: PathBuf,
}

impl ArtifactStaging {
    #[must_use]
    pub const fn record(&self) -> &ArtifactRecord {
        &self.record
    }
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl std::fmt::Debug for ArtifactStaging {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtifactStaging")
            .field("record", &self.record)
            .field("path", &"<redacted>")
            .finish()
    }
}

#[derive(Clone)]
pub enum ArtifactRegistration {
    Staging(ArtifactStaging),
    Existing(ArtifactRecord),
    Pending(ArtifactRecord),
}

impl std::fmt::Debug for ArtifactRegistration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Staging(staging) => formatter.debug_tuple("Staging").field(staging).finish(),
            Self::Existing(record) => formatter.debug_tuple("Existing").field(record).finish(),
            Self::Pending(record) => formatter.debug_tuple("Pending").field(record).finish(),
        }
    }
}

#[derive(Clone)]
pub struct ResolvedArtifact {
    record: ArtifactRecord,
    path: PathBuf,
}

impl ResolvedArtifact {
    #[must_use]
    pub const fn record(&self) -> &ArtifactRecord {
        &self.record
    }
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl std::fmt::Debug for ResolvedArtifact {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedArtifact")
            .field("record", &self.record)
            .field("path", &"<redacted>")
            .finish()
    }
}

pub(super) struct TransactionalArtifactRemoval {
    final_path: PathBuf,
    staging_path: PathBuf,
    trash_path: PathBuf,
    moved: bool,
    finalized: bool,
}

impl TransactionalArtifactRemoval {
    pub(super) fn finalize(mut self) {
        self.finalized = true;
        let _ = remove_if_regular(&self.staging_path);
        let _ = remove_if_regular(&self.trash_path);
    }
}

impl Drop for TransactionalArtifactRemoval {
    fn drop(&mut self) {
        if !self.finalized && self.moved && !self.final_path.exists() {
            let _ = fs::rename(&self.trash_path, &self.final_path);
        }
    }
}

impl std::fmt::Debug for TransactionalArtifactRemoval {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TransactionalArtifactRemoval")
            .field("final_path", &"<redacted>")
            .field("staging_path", &"<redacted>")
            .field("trash_path", &"<redacted>")
            .field("moved", &self.moved)
            .field("finalized", &self.finalized)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct CacheWrite {
    key: CacheKey,
    artifact_id: ArtifactId,
    category: CacheCategory,
    algorithm_version: u32,
    expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheLease {
    id: CacheLeaseId,
    key: CacheKey,
    owner: String,
    expires_at_ms: u64,
}

impl CacheLease {
    #[must_use]
    pub const fn id(&self) -> CacheLeaseId {
        self.id
    }

    #[must_use]
    pub const fn key(&self) -> CacheKey {
        self.key
    }

    #[must_use]
    pub fn owner(&self) -> &str {
        &self.owner
    }

    #[must_use]
    pub const fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

#[derive(Clone)]
pub struct LeasedArtifact {
    artifact: ResolvedArtifact,
    lease: CacheLease,
}

impl LeasedArtifact {
    #[must_use]
    pub const fn artifact(&self) -> &ResolvedArtifact {
        &self.artifact
    }

    #[must_use]
    pub const fn lease(&self) -> &CacheLease {
        &self.lease
    }
}

impl std::fmt::Debug for LeasedArtifact {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LeasedArtifact")
            .field("artifact", &self.artifact)
            .field("lease", &self.lease)
            .finish()
    }
}

impl CacheWrite {
    pub fn new(
        key: CacheKey,
        artifact_id: ArtifactId,
        category: CacheCategory,
        algorithm_version: u32,
        expires_at_ms: Option<u64>,
    ) -> Result<Self, DatabaseError> {
        if algorithm_version == 0 || expires_at_ms.is_some_and(|value| value > i64::MAX as u64) {
            return Err(DatabaseError::InvalidCacheEntry);
        }
        Ok(Self {
            key,
            artifact_id,
            category,
            algorithm_version,
            expires_at_ms,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCategoryInfo {
    pub category: String,
    pub count: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub categories: Vec<CacheCategoryInfo>,
    pub total_count: u64,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub category: Option<String>,
    pub removed_count: u64,
    pub removed_size_bytes: u64,
    pub retained_shared_count: u64,
    pub leased_count: u64,
    pub cleanup_failed_count: u64,
}

/// A cache clear and its adjacent snapshots, captured within one database actor operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearOutcome {
    pub before: CacheInfo,
    pub clear: CacheClearResult,
    pub after: CacheInfo,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReconciliationReport {
    pub promoted_pending: u64,
    pub restored_removals: u64,
    pub marked_failed: u64,
    pub removed_orphans: u64,
    pub removed_unreferenced_cache: u64,
    pub removed_unowned_media: u64,
    pub removed_expired_media_candidates: u64,
}

#[cfg(test)]
mod tests;
