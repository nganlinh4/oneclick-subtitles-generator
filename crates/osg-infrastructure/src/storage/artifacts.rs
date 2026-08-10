use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use osg_domain::{JobId, ProjectId};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use uuid::{Uuid, Variant, Version};

use super::DatabaseError;
use super::actor::now_ms;

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

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ArtifactId(Uuid);

impl ArtifactId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, DatabaseError> {
        if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122
        {
            Ok(Self(value))
        } else {
            Err(DatabaseError::InvalidArtifactMetadata)
        }
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for ArtifactId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ArtifactId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::fmt::Display for ArtifactId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContentHash([u8; 32]);

impl ContentHash {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn digest(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    /// Computes a content hash incrementally without retaining the artifact in
    /// memory. The reader and any filesystem location remain native-only.
    pub fn digest_reader(mut reader: impl Read) -> std::io::Result<Self> {
        let mut hasher = blake3::Hasher::new();
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        Ok(Self(*hasher.finalize().as_bytes()))
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for ContentHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&hex(&self.0))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct CacheKey([u8; 32]);

impl CacheKey {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn derive(
        category: &CacheCategory,
        algorithm_version: u32,
        parts: &[&[u8]],
    ) -> Result<Self, DatabaseError> {
        if algorithm_version == 0
            || parts.is_empty()
            || parts.len() > MAX_CACHE_KEY_PARTS
            || parts
                .iter()
                .try_fold(0_usize, |total, part| {
                    total.checked_add(part.len()).filter(|total| {
                        *total <= MAX_CACHE_KEY_INPUT_BYTES && u32::try_from(part.len()).is_ok()
                    })
                })
                .is_none()
        {
            return Err(DatabaseError::InvalidCacheKey);
        }
        let category_length =
            u32::try_from(category.as_str().len()).map_err(|_| DatabaseError::InvalidCacheKey)?;
        let part_count = u32::try_from(parts.len()).map_err(|_| DatabaseError::InvalidCacheKey)?;
        let mut hasher = blake3::Hasher::new_derive_key("osg-cache-key-v1");
        hasher.update(&category_length.to_be_bytes());
        hasher.update(category.as_str().as_bytes());
        hasher.update(&algorithm_version.to_be_bytes());
        hasher.update(&part_count.to_be_bytes());
        for part in parts {
            let part_length =
                u32::try_from(part.len()).map_err(|_| DatabaseError::InvalidCacheKey)?;
            hasher.update(&part_length.to_be_bytes());
            hasher.update(part);
        }
        Ok(Self(*hasher.finalize().as_bytes()))
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for CacheKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&hex(&self.0))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct CacheLeaseId(Uuid);

impl CacheLeaseId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for CacheLeaseId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for CacheLeaseId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactKind(String);

impl ArtifactKind {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        validate_name(&value)
            .then_some(Self(value))
            .ok_or(DatabaseError::InvalidArtifactKind)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheCategory(String);

impl CacheCategory {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        validate_name(&value)
            .then_some(Self(value))
            .ok_or(DatabaseError::InvalidCacheCategory)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactFailureCode(String);

impl ArtifactFailureCode {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        if !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err(DatabaseError::InvalidArtifactFailureCode)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

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
}

impl std::fmt::Debug for ArtifactRegistration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Staging(staging) => formatter.debug_tuple("Staging").field(staging).finish(),
            Self::Existing(record) => formatter.debug_tuple("Existing").field(record).finish(),
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
}

#[derive(Clone)]
pub(super) struct ArtifactRoot {
    canonical: PathBuf,
    identity: RootIdentity,
}

impl std::fmt::Debug for ArtifactRoot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtifactRoot")
            .field("canonical", &"<redacted>")
            .finish()
    }
}

impl ArtifactRoot {
    pub(super) fn prepare(path: &Path) -> Result<Self, DatabaseError> {
        fs::create_dir_all(path)?;
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(DatabaseError::InvalidArtifactRoot);
        }
        let canonical = fs::canonicalize(path)?;
        let identity = RootIdentity::load_or_create(&canonical)?;
        Ok(Self {
            canonical,
            identity,
        })
    }

    fn verify(&self) -> Result<(), DatabaseError> {
        let metadata = fs::symlink_metadata(&self.canonical)
            .map_err(|_| DatabaseError::InvalidArtifactRoot)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || RootIdentity::load(&self.canonical).ok().as_ref() != Some(&self.identity)
            || fs::canonicalize(&self.canonical).ok().as_deref() != Some(self.canonical.as_path())
        {
            return Err(DatabaseError::InvalidArtifactRoot);
        }
        Ok(())
    }

    fn child(&self, name: &str) -> Result<PathBuf, DatabaseError> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(DatabaseError::InvalidArtifactMetadata);
        }
        Ok(self.canonical.join(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RootIdentity([u8; 16]);

impl RootIdentity {
    fn load_or_create(root: &Path) -> Result<Self, DatabaseError> {
        match Self::load(root) {
            Ok(identity) => Ok(identity),
            Err(DatabaseError::InvalidArtifactRoot) if !root.join(ROOT_IDENTITY_FILE).exists() => {
                let identity = Self(*Uuid::now_v7().as_bytes());
                let temporary = root.join(format!(".root-identity-{}.pending", Uuid::now_v7()));
                let result = (|| {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temporary)?;
                    file.write_all(&identity.0)?;
                    file.sync_all()?;
                    match fs::hard_link(&temporary, root.join(ROOT_IDENTITY_FILE)) {
                        Ok(()) => Ok(identity),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            Self::load(root)
                        }
                        Err(error) => Err(error.into()),
                    }
                })();
                let _ = fs::remove_file(temporary);
                result
            }
            Err(error) => Err(error),
        }
    }

    fn load(root: &Path) -> Result<Self, DatabaseError> {
        let path = root.join(ROOT_IDENTITY_FILE);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| DatabaseError::InvalidArtifactRoot)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 16 {
            return Err(DatabaseError::InvalidArtifactRoot);
        }
        let bytes = fs::read(path).map_err(|_| DatabaseError::InvalidArtifactRoot)?;
        Ok(Self(
            bytes
                .try_into()
                .map_err(|_| DatabaseError::InvalidArtifactRoot)?,
        ))
    }
}

type RawArtifact = (
    Uuid,
    Option<Uuid>,
    Option<Uuid>,
    String,
    String,
    Vec<u8>,
    i64,
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
);

pub(super) fn register(
    connection: &Connection,
    root: &ArtifactRoot,
    draft: &ArtifactDraft,
) -> Result<ArtifactRegistration, DatabaseError> {
    root.verify()?;
    validate_size(draft.size_bytes)?;
    if draft.retention == ArtifactRetention::Cache && draft.project_id.is_some() {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let metadata_json = serde_json::to_string(&draft.metadata)?;
    if metadata_json.len() > MAX_ARTIFACT_METADATA_BYTES {
        return Err(DatabaseError::ArtifactMetadataTooLarge);
    }
    if let Some(existing) = find_by_content(connection, &draft.kind, draft.content_hash)? {
        if existing.size_bytes != draft.size_bytes {
            return Err(DatabaseError::ArtifactContentMismatch(existing.id));
        }
        let reusable = match (draft.retention, existing.retention) {
            (ArtifactRetention::Cache, _) => true,
            (ArtifactRetention::Durable, ArtifactRetention::Durable) => {
                draft.project_id == existing.project_id
            }
            (ArtifactRetention::Durable, ArtifactRetention::Cache) => false,
        };
        if !reusable {
            return Err(DatabaseError::ArtifactReuseConflict(existing.id));
        }
        return Ok(ArtifactRegistration::Existing(existing));
    }
    let count: i64 =
        connection.query_row("SELECT COUNT(*) FROM artifacts", [], |row| row.get(0))?;
    ensure_artifact_capacity(count)?;

    let id = ArtifactId::new();
    let relative_path = final_name(&draft.kind, draft.content_hash);
    let timestamp = now_ms();
    connection.execute(
        "INSERT INTO artifacts(
           id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
           retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL, ?9, ?10, ?10)",
        params![
            id.as_uuid(),
            draft.project_id.map(ProjectId::into_uuid),
            draft.job_id.map(JobId::into_uuid),
            draft.kind.as_str(),
            relative_path,
            draft.content_hash.as_bytes().as_slice(),
            i64::try_from(draft.size_bytes).map_err(|_| DatabaseError::InvalidArtifactSize)?,
            retention_name(draft.retention),
            metadata_json,
            timestamp,
        ],
    )?;
    let record = get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))?;
    let path = root.child(&staging_name(id))?;
    if let Err(error) = OpenOptions::new().write(true).create_new(true).open(&path) {
        let failure = ArtifactFailureCode::new("stagingCreate")?;
        let _ = fail(connection, root, id, &failure);
        return Err(DatabaseError::Io(error));
    }
    Ok(ArtifactRegistration::Staging(ArtifactStaging {
        record,
        path,
    }))
}

pub(super) fn get(
    connection: &Connection,
    id: ArtifactId,
) -> Result<Option<ArtifactRecord>, DatabaseError> {
    connection
        .query_row(
            "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts WHERE id = ?1",
            [id.as_uuid()],
            raw_artifact,
        )
        .optional()?
        .map(decode_artifact)
        .transpose()
}

pub(super) fn ready(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<ArtifactRecord, DatabaseError> {
    root.verify()?;
    let record = get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))?;
    if record.state == ArtifactState::Failed {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    let final_path = final_path(root, &record)?;
    if record.state == ArtifactState::Ready {
        validate_file(&final_path, &record)?;
        return Ok(record);
    }
    let staging_path = root.child(&staging_name(id))?;
    if final_path.exists() {
        validate_file(&final_path, &record)?;
    } else {
        validate_file(&staging_path, &record)?;
        match fs::hard_link(&staging_path, &final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                validate_file(&final_path, &record)?;
            }
            Err(error) => return Err(error.into()),
        }
        validate_file(&final_path, &record)?;
        root.verify()?;
    }
    remove_if_regular(&staging_path)?;
    seal_file(&final_path)?;
    root.verify()?;
    let changed = connection.execute(
        "UPDATE artifacts
         SET state = 'ready', failure_code = NULL, updated_at_ms = ?1
         WHERE id = ?2 AND state = 'pending'",
        params![now_ms(), id.as_uuid()],
    )?;
    if changed != 1 {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))
}

pub(super) fn fail(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
    failure_code: &ArtifactFailureCode,
) -> Result<ArtifactRecord, DatabaseError> {
    root.verify()?;
    let record = get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))?;
    if record.state != ArtifactState::Pending {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    transition_failed(connection, id, failure_code)?;
    remove_if_regular(&root.child(&staging_name(id))?)?;
    remove_if_regular(&final_path(root, &record)?)?;
    get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))
}

pub(super) fn resolve(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<Option<ResolvedArtifact>, DatabaseError> {
    root.verify()?;
    let Some(record) = get(connection, id)? else {
        return Ok(None);
    };
    if record.state != ArtifactState::Ready {
        return Ok(None);
    }
    let path = final_path(root, &record)?;
    if validate_file(&path, &record).is_err() {
        transition_failed(
            connection,
            id,
            &ArtifactFailureCode::new("missingOrCorrupt")?,
        )?;
        return Ok(None);
    }
    Ok(Some(ResolvedArtifact { record, path }))
}

pub(super) fn remove(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<Option<ArtifactRecord>, DatabaseError> {
    root.verify()?;
    let Some(record) = get(connection, id)? else {
        return Ok(None);
    };
    let final_path = final_path(root, &record)?;
    let staging_path = root.child(&staging_name(id))?;
    let trash_path = root.child(&trash_name(id))?;
    let moved = match fs::symlink_metadata(&final_path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(DatabaseError::InvalidArtifactFile);
            }
            if trash_path.exists() {
                return Err(DatabaseError::ArtifactPublicationCollision);
            }
            fs::rename(&final_path, &trash_path)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = connection.execute("DELETE FROM artifacts WHERE id = ?1", [id.as_uuid()]) {
        if moved && !final_path.exists() {
            let _ = fs::rename(&trash_path, &final_path);
        }
        return Err(error.into());
    }
    remove_if_regular(&staging_path)?;
    remove_if_regular(&trash_path)?;
    Ok(Some(record))
}

pub(super) fn put_cache(connection: &Connection, write: &CacheWrite) -> Result<(), DatabaseError> {
    let artifact = get(connection, write.artifact_id)?
        .ok_or(DatabaseError::ArtifactNotFound(write.artifact_id))?;
    if artifact.state != ArtifactState::Ready {
        return Err(DatabaseError::ArtifactNotCacheable(write.artifact_id));
    }
    let existing = connection.query_row(
        "SELECT artifact_id, category, algorithm_version FROM cache_entries WHERE cache_key = ?1",
        [write.key.as_bytes().as_slice()],
        |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
    ).optional()?;
    if let Some((artifact_id, category, version)) = existing {
        if artifact_id != *write.artifact_id.as_uuid()
            || category != write.category.as_str()
            || version != i64::from(write.algorithm_version)
        {
            return Err(DatabaseError::CacheKeyConflict);
        }
        connection.execute(
            "UPDATE cache_entries SET last_accessed_at_ms = ?1, expires_at_ms = ?2
             WHERE cache_key = ?3",
            params![
                now_ms(),
                write
                    .expires_at_ms
                    .map(i64::try_from)
                    .transpose()
                    .map_err(|_| DatabaseError::InvalidCacheEntry)?,
                write.key.as_bytes().as_slice()
            ],
        )?;
        return Ok(());
    }
    let count: i64 =
        connection.query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))?;
    ensure_cache_capacity(count)?;
    connection.execute(
        "INSERT INTO cache_entries(
           cache_key, artifact_id, category, algorithm_version, last_accessed_at_ms, expires_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            write.key.as_bytes().as_slice(),
            write.artifact_id.as_uuid(),
            write.category.as_str(),
            write.algorithm_version,
            now_ms(),
            write
                .expires_at_ms
                .map(i64::try_from)
                .transpose()
                .map_err(|_| DatabaseError::InvalidCacheEntry)?,
        ],
    )?;
    Ok(())
}

pub(super) fn lookup_cache(
    connection: &Connection,
    root: &ArtifactRoot,
    key: CacheKey,
) -> Result<Option<ResolvedArtifact>, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT artifact_id, expires_at_ms FROM cache_entries WHERE cache_key = ?1",
            [key.as_bytes().as_slice()],
            |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let Some((artifact_id, expires_at_ms)) = row else {
        return Ok(None);
    };
    let id = ArtifactId::from_uuid(artifact_id)?;
    if expires_at_ms.is_some_and(|expiry| expiry <= now_ms()) {
        let leased: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM cache_leases
               WHERE cache_key = ?1 AND expires_at_ms > ?2
             )",
            params![key.as_bytes().as_slice(), now_ms()],
            |row| row.get(0),
        )?;
        if !leased {
            connection.execute(
                "DELETE FROM cache_entries WHERE cache_key = ?1",
                [key.as_bytes().as_slice()],
            )?;
            remove_unreferenced_cache_artifact(connection, root, id)?;
        }
        return Ok(None);
    }
    let Some(resolved) = resolve(connection, root, id)? else {
        connection.execute(
            "DELETE FROM cache_entries WHERE cache_key = ?1",
            [key.as_bytes().as_slice()],
        )?;
        remove_unreferenced_cache_artifact(connection, root, id)?;
        return Ok(None);
    };
    connection.execute(
        "UPDATE cache_entries SET last_accessed_at_ms = ?1 WHERE cache_key = ?2",
        params![now_ms(), key.as_bytes().as_slice()],
    )?;
    Ok(Some(resolved))
}

pub(super) fn lease_cache(
    connection: &Connection,
    root: &ArtifactRoot,
    key: CacheKey,
    owner: &str,
    ttl_ms: u64,
) -> Result<Option<LeasedArtifact>, DatabaseError> {
    if !validate_owner(owner) || ttl_ms == 0 || ttl_ms > MAX_CACHE_LEASE_MS {
        return Err(DatabaseError::InvalidCacheLease);
    }
    let Some(artifact) = lookup_cache(connection, root, key)? else {
        return Ok(None);
    };
    let timestamp = now_ms();
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [timestamp],
    )?;
    let count: i64 =
        connection.query_row("SELECT COUNT(*) FROM cache_leases", [], |row| row.get(0))?;
    ensure_cache_lease_capacity(count)?;
    let ttl_ms = i64::try_from(ttl_ms).map_err(|_| DatabaseError::InvalidCacheLease)?;
    let expires_at_ms = timestamp
        .checked_add(ttl_ms)
        .ok_or(DatabaseError::InvalidCacheLease)?;
    let id = CacheLeaseId::new();
    connection.execute(
        "INSERT INTO cache_leases(id, cache_key, owner, expires_at_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            id.as_uuid(),
            key.as_bytes().as_slice(),
            owner,
            expires_at_ms
        ],
    )?;
    Ok(Some(LeasedArtifact {
        artifact,
        lease: CacheLease {
            id,
            key,
            owner: owner.to_owned(),
            expires_at_ms: u64::try_from(expires_at_ms)
                .map_err(|_| DatabaseError::InvalidCacheLease)?,
        },
    }))
}

pub(super) fn release_cache_lease(
    connection: &Connection,
    id: CacheLeaseId,
) -> Result<bool, DatabaseError> {
    Ok(connection.execute("DELETE FROM cache_leases WHERE id = ?1", [id.as_uuid()])? != 0)
}

pub(super) fn cache_info(
    connection: &Connection,
    root: &ArtifactRoot,
) -> Result<CacheInfo, DatabaseError> {
    reconcile(connection, root)?;
    let mut statement = connection.prepare(
        "SELECT category, COUNT(*), COALESCE(SUM(size_bytes), 0)
         FROM (
           SELECT ce.category AS category, a.id AS artifact_id, a.size_bytes AS size_bytes
           FROM cache_entries ce JOIN artifacts a ON a.id = ce.artifact_id
           WHERE a.state = 'ready'
           GROUP BY ce.category, a.id
         )
         GROUP BY category ORDER BY category",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(CacheCategoryInfo {
            category: row.get(0)?,
            count: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(u64::MAX),
            size_bytes: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(u64::MAX),
        })
    })?;
    let mut categories = Vec::new();
    for row in rows {
        categories.push(row?);
    }
    let (count, size): (i64, i64) = connection.query_row(
        "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0)
         FROM (
           SELECT a.id, a.size_bytes FROM cache_entries ce
           JOIN artifacts a ON a.id = ce.artifact_id
           WHERE a.state = 'ready' GROUP BY a.id
         )",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(CacheInfo {
        categories,
        total_count: u64::try_from(count).map_err(|_| DatabaseError::InvalidCacheEntry)?,
        total_size_bytes: u64::try_from(size).map_err(|_| DatabaseError::InvalidCacheEntry)?,
    })
}

pub(super) fn clear_cache(
    connection: &mut Connection,
    root: &ArtifactRoot,
    category: Option<&CacheCategory>,
) -> Result<CacheClearResult, DatabaseError> {
    root.verify()?;
    let timestamp = now_ms();
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [timestamp],
    )?;
    let mut statement = connection.prepare(
        "SELECT ce.cache_key, ce.artifact_id,
                EXISTS(SELECT 1 FROM cache_leases cl
                       WHERE cl.cache_key = ce.cache_key AND cl.expires_at_ms > ?1)
         FROM cache_entries ce WHERE ?2 IS NULL OR ce.category = ?2
         ORDER BY ce.cache_key",
    )?;
    let rows = statement.query_map(
        params![timestamp, category.map(CacheCategory::as_str)],
        |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Uuid>(1)?,
                row.get::<_, bool>(2)?,
            ))
        },
    )?;
    let mut selected = Vec::new();
    for row in rows {
        selected.push(row?);
    }
    drop(statement);

    let leased_count = selected.iter().filter(|(_, _, leased)| *leased).count() as u64;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut candidates = HashSet::new();
    for (key, artifact_id, leased) in &selected {
        if !leased {
            transaction.execute("DELETE FROM cache_entries WHERE cache_key = ?1", [key])?;
            candidates.insert(ArtifactId::from_uuid(*artifact_id)?);
        }
    }
    transaction.commit()?;

    let mut removed_count = 0_u64;
    let mut removed_size_bytes = 0_u64;
    let mut retained_shared_count = 0_u64;
    let mut cleanup_failed_count = 0_u64;
    for id in candidates {
        let referenced: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM cache_entries WHERE artifact_id = ?1)",
            [id.as_uuid()],
            |row| row.get(0),
        )?;
        let Some(record) = get(connection, id)? else {
            continue;
        };
        if referenced || record.retention != ArtifactRetention::Cache {
            retained_shared_count = retained_shared_count.saturating_add(1);
        } else {
            match remove(connection, root, id) {
                Ok(Some(removed)) => {
                    removed_count = removed_count.saturating_add(1);
                    removed_size_bytes = removed_size_bytes.saturating_add(removed.size_bytes);
                }
                Ok(None) => {}
                Err(_) => {
                    let _ = transition_failed(
                        connection,
                        id,
                        &ArtifactFailureCode::new("cacheCleanup")?,
                    );
                    cleanup_failed_count = cleanup_failed_count.saturating_add(1);
                }
            }
        }
    }
    Ok(CacheClearResult {
        category: category.map(|value| value.as_str().to_owned()),
        removed_count,
        removed_size_bytes,
        retained_shared_count,
        leased_count,
        cleanup_failed_count,
    })
}

pub(super) fn clear_cache_with_info(
    connection: &mut Connection,
    root: &ArtifactRoot,
    category: Option<&CacheCategory>,
) -> Result<CacheClearOutcome, DatabaseError> {
    let before = cache_info(connection, root)?;
    let clear = clear_cache(connection, root, category)?;
    let after = cache_info(connection, root)?;
    Ok(CacheClearOutcome {
        before,
        clear,
        after,
    })
}

pub(super) fn reconcile(
    connection: &Connection,
    root: &ArtifactRoot,
) -> Result<ReconciliationReport, DatabaseError> {
    root.verify()?;
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [now_ms()],
    )?;
    let records = list(connection)?;
    if u64::try_from(records.len()).unwrap_or(u64::MAX) > MAX_ARTIFACTS {
        return Err(DatabaseError::ArtifactLimitReached);
    }
    let mut report = ReconciliationReport::default();
    let failure = ArtifactFailureCode::new("startupReconciliation")?;
    let mut expected = HashSet::from([ROOT_IDENTITY_FILE.to_owned()]);
    for record in records {
        let final_path = final_path(root, &record)?;
        let staging_path = root.child(&staging_name(record.id))?;
        let trash_path = root.child(&trash_name(record.id))?;
        match record.state {
            ArtifactState::Pending => {
                if validate_file(&final_path, &record).is_ok()
                    || (validate_file(&staging_path, &record).is_ok()
                        && publish_existing_stage(&staging_path, &final_path, &record).is_ok())
                {
                    remove_if_regular(&staging_path)?;
                    seal_file(&final_path)?;
                    root.verify()?;
                    connection.execute(
                        "UPDATE artifacts SET state = 'ready', failure_code = NULL,
                         updated_at_ms = ?1 WHERE id = ?2 AND state = 'pending'",
                        params![now_ms(), record.id.as_uuid()],
                    )?;
                    expected.insert(record.relative_path.clone());
                    report.promoted_pending = report.promoted_pending.saturating_add(1);
                } else {
                    transition_failed(connection, record.id, &failure)?;
                    let _ = remove_if_regular(&staging_path);
                    let _ = remove_if_regular(&final_path);
                    report.marked_failed = report.marked_failed.saturating_add(1);
                }
            }
            ArtifactState::Ready => {
                if validate_file(&final_path, &record).is_ok() {
                    expected.insert(record.relative_path.clone());
                } else if validate_file(&trash_path, &record).is_ok() && !final_path.exists() {
                    fs::rename(&trash_path, &final_path)?;
                    validate_file(&final_path, &record)?;
                    expected.insert(record.relative_path.clone());
                    report.restored_removals = report.restored_removals.saturating_add(1);
                } else {
                    transition_failed(connection, record.id, &failure)?;
                    let _ = remove_if_regular(&final_path);
                    let _ = remove_if_regular(&trash_path);
                    report.marked_failed = report.marked_failed.saturating_add(1);
                }
            }
            ArtifactState::Failed => {
                let _ = remove_if_regular(&staging_path);
                let _ = remove_if_regular(&final_path);
                let _ = remove_if_regular(&trash_path);
            }
        }
    }

    purge_expired_cache(connection, root)?;

    let mut statement = connection.prepare(
        "SELECT id FROM artifacts a
         WHERE a.retention = 'cache'
           AND NOT EXISTS(SELECT 1 FROM cache_entries ce WHERE ce.artifact_id = a.id)",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, Uuid>(0))?;
    let mut unreferenced = Vec::new();
    for row in rows {
        unreferenced.push(ArtifactId::from_uuid(row?)?);
    }
    drop(statement);
    for id in unreferenced {
        if let Some(record) = remove(connection, root, id)? {
            expected.remove(&record.relative_path);
            report.removed_unreferenced_cache = report.removed_unreferenced_cache.saturating_add(1);
        }
    }

    let mut entries = fs::read_dir(&root.canonical)?;
    for index in 0..=MAX_ROOT_ENTRIES {
        let Some(entry) = entries.next() else {
            break;
        };
        if index == MAX_ROOT_ENTRIES {
            return Err(DatabaseError::ArtifactRootEntryLimitReached);
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            remove_owned_entry(&entry.path())?;
            report.removed_orphans = report.removed_orphans.saturating_add(1);
            continue;
        };
        if !expected.contains(name) {
            remove_owned_entry(&entry.path())?;
            report.removed_orphans = report.removed_orphans.saturating_add(1);
        }
    }
    Ok(report)
}

fn list(connection: &Connection) -> Result<Vec<ArtifactRecord>, DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts ORDER BY created_at_ms, id LIMIT ?1",
    )?;
    let rows = statement.query_map(
        [i64::try_from(MAX_ARTIFACTS + 1).unwrap_or(i64::MAX)],
        raw_artifact,
    )?;
    let mut records = Vec::new();
    for row in rows {
        records.push(decode_artifact(row?)?);
    }
    Ok(records)
}

fn find_by_content(
    connection: &Connection,
    kind: &ArtifactKind,
    content_hash: ContentHash,
) -> Result<Option<ArtifactRecord>, DatabaseError> {
    connection
        .query_row(
            "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts WHERE kind = ?1 AND content_hash = ?2",
            params![kind.as_str(), content_hash.as_bytes().as_slice()],
            raw_artifact,
        )
        .optional()?
        .map(decode_artifact)
        .transpose()
}

fn raw_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawArtifact> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
    ))
}

fn decode_artifact(raw: RawArtifact) -> Result<ArtifactRecord, DatabaseError> {
    let (
        id,
        project_id,
        job_id,
        kind,
        relative_path,
        hash,
        size,
        retention,
        state,
        failure_code,
        metadata_json,
        created,
        updated,
    ) = raw;
    let id = ArtifactId::from_uuid(id)?;
    let project_id = project_id
        .map(ProjectId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let job_id = job_id
        .map(JobId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let kind = ArtifactKind::new(kind).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let content_hash = ContentHash::from_bytes(
        hash.try_into()
            .map_err(|_| DatabaseError::InvalidArtifactMetadata)?,
    );
    if relative_path != final_name(&kind, content_hash) {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let size_bytes = u64::try_from(size).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    validate_size(size_bytes).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let retention = match retention.as_str() {
        "durable" => ArtifactRetention::Durable,
        "cache" => ArtifactRetention::Cache,
        _ => return Err(DatabaseError::InvalidArtifactMetadata),
    };
    let state = match state.as_str() {
        "pending" => ArtifactState::Pending,
        "ready" => ArtifactState::Ready,
        "failed" => ArtifactState::Failed,
        _ => return Err(DatabaseError::InvalidArtifactMetadata),
    };
    let failure_code = failure_code
        .map(ArtifactFailureCode::new)
        .transpose()
        .map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    if (state == ArtifactState::Failed) != failure_code.is_some() {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let metadata = serde_json::from_str(&metadata_json)?;
    validate_metadata(&metadata).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let created_at_ms =
        u64::try_from(created).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let updated_at_ms =
        u64::try_from(updated).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    if updated_at_ms < created_at_ms {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    Ok(ArtifactRecord {
        id,
        project_id,
        job_id,
        kind,
        relative_path,
        content_hash,
        size_bytes,
        retention,
        state,
        failure_code,
        metadata,
        created_at_ms,
        updated_at_ms,
    })
}

fn transition_failed(
    connection: &Connection,
    id: ArtifactId,
    failure_code: &ArtifactFailureCode,
) -> Result<(), DatabaseError> {
    let changed = connection.execute(
        "UPDATE artifacts SET state = 'failed', failure_code = ?1, updated_at_ms = ?2
         WHERE id = ?3 AND state != 'failed'",
        params![failure_code.as_str(), now_ms(), id.as_uuid()],
    )?;
    if changed == 0 && get(connection, id)?.is_none() {
        return Err(DatabaseError::ArtifactNotFound(id));
    }
    Ok(())
}

fn purge_expired_cache(connection: &Connection, root: &ArtifactRoot) -> Result<(), DatabaseError> {
    let timestamp = now_ms();
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [timestamp],
    )?;
    let mut statement = connection.prepare(
        "SELECT DISTINCT ce.artifact_id FROM cache_entries ce
         WHERE ce.expires_at_ms IS NOT NULL AND ce.expires_at_ms <= ?1
           AND NOT EXISTS(
             SELECT 1 FROM cache_leases cl
             WHERE cl.cache_key = ce.cache_key AND cl.expires_at_ms > ?1
           )",
    )?;
    let rows = statement.query_map([timestamp], |row| row.get::<_, Uuid>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(ArtifactId::from_uuid(row?)?);
    }
    drop(statement);
    connection.execute(
        "DELETE FROM cache_entries
         WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?1
           AND NOT EXISTS(
             SELECT 1 FROM cache_leases cl
             WHERE cl.cache_key = cache_entries.cache_key AND cl.expires_at_ms > ?1
           )",
        [timestamp],
    )?;
    for id in ids {
        remove_unreferenced_cache_artifact(connection, root, id)?;
    }
    Ok(())
}

fn remove_unreferenced_cache_artifact(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<(), DatabaseError> {
    let referenced: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM cache_entries WHERE artifact_id = ?1)",
        [id.as_uuid()],
        |row| row.get(0),
    )?;
    if !referenced
        && get(connection, id)?.is_some_and(|record| record.retention == ArtifactRetention::Cache)
    {
        let _ = remove(connection, root, id)?;
    }
    Ok(())
}

fn publish_existing_stage(
    staging_path: &Path,
    final_path: &Path,
    record: &ArtifactRecord,
) -> Result<(), DatabaseError> {
    if !final_path.exists() {
        match fs::hard_link(staging_path, final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    validate_file(final_path, record)
}

fn final_path(root: &ArtifactRoot, record: &ArtifactRecord) -> Result<PathBuf, DatabaseError> {
    if record.relative_path != final_name(&record.kind, record.content_hash) {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    root.child(&record.relative_path)
}

fn final_name(kind: &ArtifactKind, content_hash: ContentHash) -> String {
    let kind_hash = blake3::hash(kind.as_str().as_bytes());
    format!(
        "o-{}-{}",
        hex(&kind_hash.as_bytes()[..8]),
        hex(content_hash.as_bytes())
    )
}

fn staging_name(id: ArtifactId) -> String {
    format!(".pending-{}", id.as_uuid())
}
fn trash_name(id: ArtifactId) -> String {
    format!(".trash-{}", id.as_uuid())
}

fn validate_file(path: &Path, record: &ArtifactRecord) -> Result<(), DatabaseError> {
    let metadata = require_regular_file(path)?;
    if metadata.len() != record.size_bytes {
        return Err(DatabaseError::ArtifactContentMismatch(record.id));
    }
    let file = OpenOptions::new().read(true).open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hasher.finalize().as_bytes() != record.content_hash.as_bytes()
        || fs::symlink_metadata(path)?.len() != record.size_bytes
    {
        return Err(DatabaseError::ArtifactContentMismatch(record.id));
    }
    Ok(())
}

fn seal_file(path: &Path) -> Result<(), DatabaseError> {
    let metadata = require_regular_file(path)?;
    if metadata.permissions().readonly() {
        return Ok(());
    }
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;
    let mut permissions = metadata.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

fn require_regular_file(path: &Path) -> Result<fs::Metadata, DatabaseError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    Ok(metadata)
}

fn remove_if_regular(path: &Path) -> Result<(), DatabaseError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            if metadata.permissions().readonly() {
                let mut permissions = metadata.permissions();
                #[cfg(windows)]
                {
                    // Windows exposes a read-only file attribute rather than Unix mode bits.
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    permissions.set_mode(permissions.mode() | 0o200);
                }
                fs::set_permissions(path, permissions)?;
            }
            fs::remove_file(path)?;
            Ok(())
        }
        Ok(_) => Err(DatabaseError::InvalidArtifactFile),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_owned_entry(path: &Path) -> Result<(), DatabaseError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)?;
        Ok(())
    } else {
        Err(DatabaseError::InvalidArtifactFile)
    }
}

fn validate_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn validate_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn ensure_artifact_capacity(count: i64) -> Result<(), DatabaseError> {
    if u64::try_from(count).unwrap_or(u64::MAX) < MAX_ARTIFACTS {
        Ok(())
    } else {
        Err(DatabaseError::ArtifactLimitReached)
    }
}

fn ensure_cache_capacity(count: i64) -> Result<(), DatabaseError> {
    if u64::try_from(count).unwrap_or(u64::MAX) < MAX_CACHE_ENTRIES {
        Ok(())
    } else {
        Err(DatabaseError::CacheLimitReached)
    }
}

fn ensure_cache_lease_capacity(count: i64) -> Result<(), DatabaseError> {
    if u64::try_from(count).unwrap_or(u64::MAX) < MAX_CACHE_LEASES {
        Ok(())
    } else {
        Err(DatabaseError::CacheLeaseLimitReached)
    }
}

const fn retention_name(retention: ArtifactRetention) -> &'static str {
    match retention {
        ArtifactRetention::Durable => "durable",
        ArtifactRetention::Cache => "cache",
    }
}

fn validate_size(size: u64) -> Result<(), DatabaseError> {
    if size <= MAX_ARTIFACT_SIZE_BYTES && i64::try_from(size).is_ok() {
        Ok(())
    } else {
        Err(DatabaseError::InvalidArtifactSize)
    }
}

fn validate_metadata(metadata: &Value) -> Result<(), DatabaseError> {
    let encoded = serde_json::to_vec(metadata)?;
    if encoded.len() <= MAX_ARTIFACT_METADATA_BYTES {
        Ok(())
    } else {
        Err(DatabaseError::ArtifactMetadataTooLarge)
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(DIGITS[usize::from(byte >> 4)]));
        result.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};

    use serde_json::json;
    use tempfile::TempDir;

    use super::{
        ArtifactDraft, ArtifactFailureCode, ArtifactKind, ArtifactRegistration, ArtifactStaging,
        ArtifactState, CacheCategory, CacheKey, CacheWrite, ContentHash, MAX_ARTIFACT_SIZE_BYTES,
        MAX_CACHE_KEY_PARTS, ensure_artifact_capacity, ensure_cache_capacity,
        ensure_cache_lease_capacity, final_name, remove_if_regular, staging_name, trash_name,
    };
    use crate::storage::{Database, DatabaseError};

    #[test]
    fn streaming_content_hash_matches_in_memory_digest() {
        let bytes = vec![0x5a; 3 * 64 * 1024 + 17];
        let streamed = ContentHash::digest_reader(Cursor::new(&bytes)).expect("streaming digest");
        assert_eq!(streamed, ContentHash::digest(&bytes));
    }

    struct Fixture {
        directory: TempDir,
        database_path: PathBuf,
        artifact_root: PathBuf,
        database: Option<Database>,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = TempDir::new().expect("temporary directory");
            let database_path = directory.path().join("db/osg.sqlite3");
            let artifact_root = directory.path().join("artifacts");
            let database = Database::open_with_artifact_root(&database_path, &artifact_root)
                .expect("open database");
            Self {
                directory,
                database_path,
                artifact_root,
                database: Some(database),
            }
        }

        fn database(&self) -> &Database {
            self.database.as_ref().expect("database is open")
        }

        fn reopen(&mut self) {
            drop(self.database.take());
            self.database = Some(
                Database::open_with_artifact_root(&self.database_path, &self.artifact_root)
                    .expect("reopen database"),
            );
        }

        fn close(&mut self) {
            drop(self.database.take());
        }
    }

    fn draft(kind: &str, bytes: &[u8]) -> ArtifactDraft {
        ArtifactDraft::new(
            ArtifactKind::new(kind).expect("kind"),
            ContentHash::digest(bytes),
            bytes.len() as u64,
            json!({"fixture": true}),
        )
        .expect("artifact draft")
    }

    fn staging(registration: ArtifactRegistration) -> ArtifactStaging {
        match registration {
            ArtifactRegistration::Staging(staging) => staging,
            ArtifactRegistration::Existing(record) => {
                panic!("expected new staging reservation, got {record:?}")
            }
        }
    }

    fn publish(database: &Database, kind: &str, bytes: &[u8]) -> super::ResolvedArtifact {
        let draft = draft(kind, bytes);
        publish_draft(database, &draft, bytes)
    }

    fn publish_cache(database: &Database, kind: &str, bytes: &[u8]) -> super::ResolvedArtifact {
        let draft = ArtifactDraft::new_cache(
            ArtifactKind::new(kind).expect("kind"),
            ContentHash::digest(bytes),
            bytes.len() as u64,
            json!({"fixture": true}),
        )
        .expect("cache artifact draft");
        publish_draft(database, &draft, bytes)
    }

    fn publish_draft(
        database: &Database,
        draft: &ArtifactDraft,
        bytes: &[u8],
    ) -> super::ResolvedArtifact {
        let staging = staging(
            database
                .register_artifact(draft)
                .expect("register artifact"),
        );
        fs::write(staging.path(), bytes).expect("write staging artifact");
        let id = staging.record().id();
        database.mark_artifact_ready(id).expect("mark ready");
        database
            .resolve_artifact(id)
            .expect("resolve artifact")
            .expect("ready artifact")
    }

    #[test]
    fn artifact_lifecycle_is_content_addressed_and_path_private() {
        let fixture = Fixture::new();
        let bytes = b"subtitle artifact";
        let staging = staging(
            fixture
                .database()
                .register_artifact(&draft("subtitles", bytes))
                .expect("register"),
        );
        let debug = format!("{staging:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(fixture.artifact_root.to_string_lossy().as_ref()));
        fs::write(staging.path(), bytes).expect("write staging");

        let ready = fixture
            .database()
            .mark_artifact_ready(staging.record().id())
            .expect("publish");
        assert_eq!(ready.state(), ArtifactState::Ready);
        let resolved = fixture
            .database()
            .resolve_artifact(ready.id())
            .expect("resolve")
            .expect("artifact");
        assert_eq!(fs::read(resolved.path()).expect("read artifact"), bytes);
        assert!(!format!("{resolved:?}").contains(resolved.path().to_string_lossy().as_ref()));

        let duplicate = fixture
            .database()
            .register_artifact(&draft("subtitles", bytes))
            .expect("deduplicate");
        assert!(matches!(
            duplicate,
            ArtifactRegistration::Existing(record) if record.id() == ready.id()
        ));
        assert!(
            fixture
                .database()
                .remove_artifact(ready.id())
                .expect("remove")
                .is_some()
        );
        assert!(
            fixture
                .database()
                .resolve_artifact(ready.id())
                .expect("resolve removed")
                .is_none()
        );
    }

    #[test]
    fn explicit_failure_is_bounded_and_cleans_staging() {
        let fixture = Fixture::new();
        let staging = staging(
            fixture
                .database()
                .register_artifact(&draft("waveform", b"peaks"))
                .expect("register"),
        );
        let path = staging.path().to_owned();
        let failure = ArtifactFailureCode::new("workerCancelled").expect("failure code");
        let failed = fixture
            .database()
            .mark_artifact_failed(staging.record().id(), &failure)
            .expect("fail artifact");
        assert_eq!(failed.state(), ArtifactState::Failed);
        assert_eq!(failed.failure_code(), Some(&failure));
        assert!(!path.exists());
        assert!(matches!(
            fixture.database().mark_artifact_ready(failed.id()),
            Err(DatabaseError::InvalidArtifactTransition(id)) if id == failed.id()
        ));
    }

    #[test]
    fn startup_promotes_only_complete_pending_content() {
        let mut fixture = Fixture::new();
        let complete = b"fully fsynced output";
        let complete_staging = staging(
            fixture
                .database()
                .register_artifact(&draft("narrationOutput", complete))
                .expect("register complete"),
        );
        fs::write(complete_staging.path(), complete).expect("write complete staging");
        let complete_id = complete_staging.record().id();

        let corrupt_staging = staging(
            fixture
                .database()
                .register_artifact(&draft("waveform", b"expected"))
                .expect("register corrupt"),
        );
        fs::write(corrupt_staging.path(), b"corrupt!").expect("write corrupt staging");
        let corrupt_id = corrupt_staging.record().id();

        fixture.reopen();
        assert_eq!(
            fixture
                .database()
                .get_artifact(complete_id)
                .expect("complete status")
                .expect("complete record")
                .state(),
            ArtifactState::Ready
        );
        assert_eq!(
            fixture
                .database()
                .get_artifact(corrupt_id)
                .expect("corrupt status")
                .expect("corrupt record")
                .state(),
            ArtifactState::Failed
        );
    }

    #[test]
    fn startup_repairs_file_before_wal_commit_and_interrupted_removal_windows() {
        let mut fixture = Fixture::new();
        let bytes = b"crash window";
        let draft = draft("videoTemp", bytes);
        let staging = staging(
            fixture
                .database()
                .register_artifact(&draft)
                .expect("register"),
        );
        fs::write(staging.path(), bytes).expect("write staging");
        let id = staging.record().id();
        let final_path = fixture.artifact_root.join(final_name(
            staging.record().kind(),
            staging.record().content_hash(),
        ));
        fs::hard_link(staging.path(), &final_path).expect("simulate publication before commit");

        fixture.reopen();
        assert_eq!(
            fixture
                .database()
                .get_artifact(id)
                .expect("status")
                .expect("record")
                .state(),
            ArtifactState::Ready
        );

        let trash_path = fixture.artifact_root.join(trash_name(id));
        fs::rename(&final_path, &trash_path).expect("simulate rename before database delete");
        fixture.reopen();
        assert!(final_path.is_file());
        assert!(!trash_path.exists());
        assert!(
            fixture
                .database()
                .resolve_artifact(id)
                .expect("resolve")
                .is_some()
        );
    }

    #[test]
    fn missing_ready_files_fail_and_orphaned_files_are_removed_on_startup() {
        let mut fixture = Fixture::new();
        let resolved = publish(fixture.database(), "albumArt", b"image bytes");
        let id = resolved.record().id();
        remove_if_regular(resolved.path()).expect("simulate missing ready file");
        let orphan = fixture.artifact_root.join("unregistered-file");
        fs::write(&orphan, b"orphan").expect("write orphan");

        fixture.reopen();
        assert_eq!(
            fixture
                .database()
                .get_artifact(id)
                .expect("status")
                .expect("record")
                .state(),
            ArtifactState::Failed
        );
        assert!(!orphan.exists());
    }

    #[test]
    fn publication_never_clobbers_a_conflicting_target() {
        let fixture = Fixture::new();
        let bytes = b"expected content";
        let staging = staging(
            fixture
                .database()
                .register_artifact(&draft("renderedVideo", bytes))
                .expect("register"),
        );
        fs::write(staging.path(), bytes).expect("write staging");
        let final_path = fixture.artifact_root.join(final_name(
            staging.record().kind(),
            staging.record().content_hash(),
        ));
        fs::write(&final_path, b"attacker content").expect("conflicting target");

        assert!(matches!(
            fixture.database().mark_artifact_ready(staging.record().id()),
            Err(DatabaseError::ArtifactContentMismatch(id)) if id == staging.record().id()
        ));
        assert_eq!(
            fs::read(final_path).expect("read conflict"),
            b"attacker content"
        );
    }

    #[test]
    fn non_regular_staging_and_replaced_roots_are_rejected() {
        let mut fixture = Fixture::new();
        let staging = staging(
            fixture
                .database()
                .register_artifact(&draft("uploads", b"upload"))
                .expect("register"),
        );
        fs::remove_file(staging.path()).expect("remove staging file");
        fs::create_dir(staging.path()).expect("replace staging with directory");
        assert!(matches!(
            fixture
                .database()
                .mark_artifact_ready(staging.record().id()),
            Err(DatabaseError::InvalidArtifactFile)
        ));

        fs::remove_dir(staging.path()).expect("remove staging directory");
        let moved_root = fixture.directory.path().join("moved-artifacts");
        fs::rename(&fixture.artifact_root, &moved_root).expect("replace artifact root");
        fs::create_dir(&fixture.artifact_root).expect("new root at same path");
        assert!(matches!(
            fixture.database().reconcile_artifacts(),
            Err(DatabaseError::InvalidArtifactRoot)
        ));
        fixture.close();
    }

    #[test]
    fn symlink_staging_is_never_followed() {
        let fixture = Fixture::new();
        let staging = staging(
            fixture
                .database()
                .register_artifact(&draft("uploads", b"upload"))
                .expect("register"),
        );
        fs::remove_file(staging.path()).expect("remove staging");
        let outside = fixture.directory.path().join("outside");
        fs::write(&outside, b"upload").expect("outside fixture");
        if create_file_symlink(&outside, staging.path()).is_err() {
            return;
        }
        assert!(matches!(
            fixture
                .database()
                .mark_artifact_ready(staging.record().id()),
            Err(DatabaseError::InvalidArtifactFile)
        ));
        assert_eq!(fs::read(outside).expect("outside remains"), b"upload");
    }

    #[test]
    fn cache_keys_are_framed_and_category_clear_preserves_shared_content() {
        let fixture = Fixture::new();
        let artifact = publish_cache(fixture.database(), "waveform", b"peak data");
        let first_category = CacheCategory::new("videos").expect("first category");
        let second_category = CacheCategory::new("videoTemp").expect("second category");
        let first_key = CacheKey::derive(&first_category, 1, &[b"ab", b"c"]).expect("first key");
        let ambiguous = CacheKey::derive(&first_category, 1, &[b"a", b"bc"]).expect("framed key");
        assert_ne!(first_key, ambiguous);
        let second_key = CacheKey::derive(&second_category, 2, &[b"ab", b"c"]).expect("second key");

        fixture
            .database()
            .put_cache_entry(
                &CacheWrite::new(
                    first_key,
                    artifact.record().id(),
                    first_category.clone(),
                    1,
                    None,
                )
                .expect("first entry"),
            )
            .expect("put first cache");
        fixture
            .database()
            .put_cache_entry(
                &CacheWrite::new(
                    second_key,
                    artifact.record().id(),
                    second_category.clone(),
                    2,
                    None,
                )
                .expect("second entry"),
            )
            .expect("put second cache");
        let info = fixture.database().cache_info().expect("cache info");
        assert_eq!(info.total_count, 1);
        assert_eq!(info.total_size_bytes, 9);
        assert_eq!(info.categories.len(), 2);

        let first_clear = fixture
            .database()
            .clear_cache_category(&first_category)
            .expect("clear first category");
        assert_eq!(first_clear.removed_count, 0);
        assert_eq!(first_clear.retained_shared_count, 1);
        assert!(
            fixture
                .database()
                .lookup_cache(first_key)
                .expect("first miss")
                .is_none()
        );
        assert!(
            fixture
                .database()
                .lookup_cache(second_key)
                .expect("second hit")
                .is_some()
        );

        let all_clear = fixture.database().clear_all_cache().expect("clear all");
        assert_eq!(all_clear.removed_count, 1);
        assert_eq!(all_clear.removed_size_bytes, 9);
        assert_eq!(
            fixture
                .database()
                .cache_info()
                .expect("empty info")
                .total_count,
            0
        );
        assert!(
            fixture
                .database()
                .get_artifact(artifact.record().id())
                .expect("artifact lookup")
                .is_none()
        );
    }

    #[test]
    fn durable_content_can_back_cache_but_cache_content_cannot_become_durable_implicitly() {
        let fixture = Fixture::new();
        let bytes = b"shared durable bytes";
        let durable = publish(fixture.database(), "albumArt", bytes);
        let cache_draft = ArtifactDraft::new_cache(
            ArtifactKind::new("albumArt").expect("kind"),
            ContentHash::digest(bytes),
            bytes.len() as u64,
            json!({}),
        )
        .expect("cache draft");
        assert!(matches!(
            fixture.database().register_artifact(&cache_draft).expect("reuse durable"),
            ArtifactRegistration::Existing(record) if record.id() == durable.record().id()
        ));
        let category = CacheCategory::new("albumArt").expect("category");
        let key = CacheKey::derive(&category, 1, &[b"shared"]).expect("key");
        fixture
            .database()
            .put_cache_entry(
                &CacheWrite::new(key, durable.record().id(), category.clone(), 1, None)
                    .expect("cache entry"),
            )
            .expect("put cache");
        let cleared = fixture
            .database()
            .clear_cache_category(&category)
            .expect("clear cache link");
        assert_eq!(cleared.removed_count, 0);
        assert_eq!(cleared.retained_shared_count, 1);
        assert!(
            fixture
                .database()
                .resolve_artifact(durable.record().id())
                .expect("resolve durable")
                .is_some()
        );

        let cached = publish_cache(fixture.database(), "waveform", b"derived only");
        let durable_draft = draft("waveform", b"derived only");
        assert!(matches!(
            fixture.database().register_artifact(&durable_draft),
            Err(DatabaseError::ArtifactReuseConflict(id)) if id == cached.record().id()
        ));
        fixture
            .database()
            .remove_artifact(durable.record().id())
            .expect("remove durable");
        fixture
            .database()
            .remove_artifact(cached.record().id())
            .expect("remove cache artifact");
    }

    #[test]
    fn active_cache_leases_prevent_clear_until_released() {
        let fixture = Fixture::new();
        let artifact = publish_cache(fixture.database(), "waveform", b"leased peaks");
        let category = CacheCategory::new("waveform").expect("category");
        let key = CacheKey::derive(&category, 1, &[b"media-hash"]).expect("key");
        fixture
            .database()
            .put_cache_entry(
                &CacheWrite::new(key, artifact.record().id(), category.clone(), 1, None)
                    .expect("entry"),
            )
            .expect("put cache");
        let leased = fixture
            .database()
            .lease_cache(key, "waveformPlayer", 60_000)
            .expect("lease cache")
            .expect("cache hit");
        assert_eq!(leased.artifact().record().id(), artifact.record().id());
        fixture
            .database()
            .put_cache_entry(
                &CacheWrite::new(key, artifact.record().id(), category.clone(), 1, Some(0))
                    .expect("expire entry"),
            )
            .expect("mark entry expired");
        assert!(
            fixture
                .database()
                .lookup_cache(key)
                .expect("expired lookup")
                .is_none()
        );

        let blocked = fixture
            .database()
            .clear_all_cache()
            .expect("clear while leased");
        assert_eq!(blocked.leased_count, 1);
        assert_eq!(blocked.removed_count, 0);
        assert!(
            fixture
                .database()
                .get_artifact(artifact.record().id())
                .expect("leased artifact")
                .is_some()
        );
        assert!(
            fixture
                .database()
                .release_cache_lease(leased.lease().id())
                .expect("release")
        );
        assert!(
            !fixture
                .database()
                .release_cache_lease(leased.lease().id())
                .expect("idempotent release")
        );
        assert_eq!(
            fixture
                .database()
                .cache_info()
                .expect("expire after release")
                .total_count,
            0
        );
        assert!(
            fixture
                .database()
                .get_artifact(artifact.record().id())
                .expect("expired artifact removed")
                .is_none()
        );
    }

    #[test]
    fn startup_removes_cache_artifacts_never_linked_to_an_entry() {
        let mut fixture = Fixture::new();
        let artifact = publish_cache(fixture.database(), "waveform", b"abandoned peaks");
        let id = artifact.record().id();
        let path = artifact.path().to_owned();

        fixture.reopen();
        assert!(
            fixture
                .database()
                .get_artifact(id)
                .expect("lookup")
                .is_none()
        );
        assert!(!path.exists());
    }

    #[test]
    fn size_names_metadata_and_key_inputs_are_bounded() {
        assert!(matches!(
            ArtifactDraft::new(
                ArtifactKind::new("oversized").expect("kind"),
                ContentHash::digest(b"x"),
                MAX_ARTIFACT_SIZE_BYTES + 1,
                json!({}),
            ),
            Err(DatabaseError::InvalidArtifactSize)
        ));
        assert!(ArtifactKind::new("../../escape").is_err());
        assert!(CacheCategory::new("video/../../escape").is_err());
        assert!(ArtifactFailureCode::new("sensitive error with spaces").is_err());
        let category = CacheCategory::new("waveform").expect("category");
        assert!(CacheKey::derive(&category, 1, &[]).is_err());
        let parts = vec![b"x".as_slice(); MAX_CACHE_KEY_PARTS + 1];
        assert!(CacheKey::derive(&category, 1, &parts).is_err());
        assert!(
            ArtifactDraft::new(
                ArtifactKind::new("metadata").expect("kind"),
                ContentHash::digest(b"x"),
                1,
                json!({"value": "x".repeat(super::MAX_ARTIFACT_METADATA_BYTES)}),
            )
            .is_err()
        );
        assert!(
            ensure_artifact_capacity(
                i64::try_from(super::MAX_ARTIFACTS - 1).expect("artifact count")
            )
            .is_ok()
        );
        assert!(matches!(
            ensure_artifact_capacity(i64::try_from(super::MAX_ARTIFACTS).expect("artifact count")),
            Err(DatabaseError::ArtifactLimitReached)
        ));
        assert!(
            ensure_cache_capacity(
                i64::try_from(super::MAX_CACHE_ENTRIES - 1).expect("cache count")
            )
            .is_ok()
        );
        assert!(matches!(
            ensure_cache_capacity(i64::try_from(super::MAX_CACHE_ENTRIES).expect("cache count")),
            Err(DatabaseError::CacheLimitReached)
        ));
        assert!(
            ensure_cache_lease_capacity(
                i64::try_from(super::MAX_CACHE_LEASES - 1).expect("lease count")
            )
            .is_ok()
        );
        assert!(matches!(
            ensure_cache_lease_capacity(
                i64::try_from(super::MAX_CACHE_LEASES).expect("lease count")
            ),
            Err(DatabaseError::CacheLeaseLimitReached)
        ));
    }

    #[test]
    fn staging_and_final_names_are_single_components() {
        let id = super::ArtifactId::new();
        let staging = staging_name(id);
        assert_eq!(Path::new(&staging).components().count(), 1);
        let kind = ArtifactKind::new("narrationOutput").expect("kind");
        let final_path = final_name(&kind, ContentHash::digest(b"bytes"));
        assert_eq!(Path::new(&final_path).components().count(), 1);
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
}
