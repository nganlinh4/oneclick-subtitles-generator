use std::ffi::OsString;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use osg_application::ProjectSnapshot;
use osg_domain::{AssetId, JobId, MediaAsset, MediaKind, ProjectId};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use super::artifacts::{
    self, ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
    ArtifactRoot, ContentHash, ResolvedArtifact,
};
use super::{Database, DatabaseError};

const MAX_PATH_BYTES: usize = 64 * 1024;
pub(super) const MAX_MEDIA_LOCATION_CANDIDATES: usize = 64;
const MEDIA_LIFECYCLE_KEY: &str = "osgMediaLifecycle";
const MEDIA_CANDIDATE_EXPIRY_KEY: &str = "osgMediaCandidateExpiresAtMs";
const MEDIA_CANDIDATE_LIFECYCLE: &str = "candidate";
const MEDIA_PROJECT_LIFECYCLE: &str = "project";
const MEDIA_CANDIDATE_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_EXPIRED_CANDIDATE_CLEANUP: i64 = 256;
const MEDIA_ARTIFACT_METADATA_KEY: &str = "osgMediaArtifact";
const COMMIT_ON_JOB_SUCCESS_METADATA_KEY: &str = "commitOnJobSuccess";
const NATIVE_MEDIA_SNAPSHOT_KIND: &str = "nativeMediaSnapshot";
const MAX_MEDIA_OPERATION_TIME_US: u64 = 7 * 24 * 60 * 60 * 1_000_000;
static MEDIA_PUBLICATION_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn validate_media_artifact_draft(
    kind: &ArtifactKind,
    metadata: &Value,
) -> Result<(), DatabaseError> {
    if metadata
        .as_object()
        .is_some_and(|object| object.contains_key(MEDIA_ARTIFACT_METADATA_KEY))
        && canonical_media_provenance(kind, metadata).is_none()
    {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    Ok(())
}

pub(super) fn artifact_metadata_semantically_compatible(
    kind: &ArtifactKind,
    existing: &Value,
    proposed: &Value,
) -> bool {
    let existing_provenance = canonical_media_provenance(kind, existing);
    let proposed_provenance = canonical_media_provenance(kind, proposed);
    let existing_claims_media = existing_provenance.is_some()
        || metadata_contains_key(existing, MEDIA_ARTIFACT_METADATA_KEY);
    let proposed_claims_media = proposed_provenance.is_some()
        || metadata_contains_key(proposed, MEDIA_ARTIFACT_METADATA_KEY);
    if !existing_claims_media && !proposed_claims_media {
        return true;
    }
    existing_provenance.is_some()
        && existing_provenance == proposed_provenance
        && proposed_provenance.is_some()
}

pub(super) fn media_artifact_needs_branding(
    kind: &ArtifactKind,
    existing: &Value,
    proposed: &Value,
) -> bool {
    artifact_metadata_semantically_compatible(kind, existing, proposed)
        && metadata_bool(existing, MEDIA_ARTIFACT_METADATA_KEY).is_none()
        && metadata_bool(proposed, MEDIA_ARTIFACT_METADATA_KEY) == Some(true)
}

fn metadata_contains_key(metadata: &Value, key: &str) -> bool {
    metadata
        .as_object()
        .is_some_and(|object| object.contains_key(key))
}

fn metadata_bool(metadata: &Value, key: &str) -> Option<bool> {
    metadata.as_object()?.get(key)?.as_bool()
}

fn canonical_media_provenance(kind: &ArtifactKind, metadata: &Value) -> Option<Value> {
    let object = metadata.as_object()?;
    if metadata_bool(metadata, MEDIA_ARTIFACT_METADATA_KEY).is_some_and(|value| !value)
        || metadata_bool(metadata, COMMIT_ON_JOB_SUCCESS_METADATA_KEY).is_some_and(|value| !value)
        || object
            .get(MEDIA_ARTIFACT_METADATA_KEY)
            .is_some_and(|value| !value.is_boolean())
        || object
            .get(COMMIT_ON_JOB_SUCCESS_METADATA_KEY)
            .is_some_and(|value| !value.is_boolean())
    {
        return None;
    }
    let base_keys: &[&str] = match kind.as_str() {
        "downloadedMedia" => &["source", "filename"],
        "preparedMedia" => &["operation", "sourceAssetId"],
        "analysisClip" => &["operation", "sourceAssetId", "startUs", "endUs"],
        "extractedAudio" => &["operation", "sourceAssetId", "format", "startUs", "endUs"],
        NATIVE_MEDIA_SNAPSHOT_KIND => &["source"],
        _ if metadata_bool(metadata, MEDIA_ARTIFACT_METADATA_KEY) == Some(true) => {
            let mut canonical = object.clone();
            canonical.remove(MEDIA_ARTIFACT_METADATA_KEY);
            canonical.remove(COMMIT_ON_JOB_SUCCESS_METADATA_KEY);
            return Some(Value::Object(canonical));
        }
        _ => return None,
    };
    if object.keys().any(|key| {
        key != MEDIA_ARTIFACT_METADATA_KEY
            && key != COMMIT_ON_JOB_SUCCESS_METADATA_KEY
            && !base_keys.contains(&key.as_str())
    }) || base_keys.iter().any(|key| !object.contains_key(*key))
    {
        return None;
    }
    let valid = match kind.as_str() {
        "downloadedMedia" => {
            object.get("source").and_then(Value::as_str) == Some("urlDownload")
                && object
                    .get("filename")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 512)
        }
        "preparedMedia" => {
            object.get("operation").and_then(Value::as_str) == Some("preparePlayback")
                && valid_asset_uuid(object.get("sourceAssetId"))
        }
        "analysisClip" => {
            object.get("operation").and_then(Value::as_str) == Some("analysisClip")
                && valid_asset_uuid(object.get("sourceAssetId"))
                && valid_bounded_range(object.get("startUs"), object.get("endUs"), true)
        }
        "extractedAudio" => {
            object.get("operation").and_then(Value::as_str) == Some("extractAudio")
                && valid_asset_uuid(object.get("sourceAssetId"))
                && object
                    .get("format")
                    .and_then(Value::as_str)
                    .is_some_and(|value| matches!(value, "wav" | "m4a" | "mp3" | "flac"))
                && valid_bounded_range(object.get("startUs"), object.get("endUs"), false)
        }
        NATIVE_MEDIA_SNAPSHOT_KIND => {
            object.get("source").and_then(Value::as_str) == Some("nativeSnapshot")
        }
        _ => false,
    };
    valid.then(|| {
        let mut canonical = serde_json::Map::new();
        for key in base_keys {
            canonical.insert((*key).to_owned(), object[*key].clone());
        }
        Value::Object(canonical)
    })
}

fn media_provenance_matches_asset(
    kind: &ArtifactKind,
    metadata: &Value,
    asset: &MediaAsset,
) -> bool {
    match kind.as_str() {
        "downloadedMedia" => {
            metadata.get("filename").and_then(Value::as_str) == Some(asset.display_name())
        }
        "preparedMedia" => asset.display_name() == format!("prepared-media.{}", asset.extension()),
        "analysisClip" => {
            asset.kind() == MediaKind::Video
                && asset.display_name() == format!("analysis-clip.{}", asset.extension())
        }
        "extractedAudio" => {
            asset.kind() == MediaKind::Audio
                && asset.display_name() == format!("extracted-audio.{}", asset.extension())
                && metadata.get("format").and_then(Value::as_str) == Some(asset.extension())
        }
        _ => true,
    }
}

fn valid_asset_uuid(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .and_then(|value| AssetId::from_uuid(value).ok())
        .is_some()
}

fn valid_bounded_range(start: Option<&Value>, end: Option<&Value>, end_required: bool) -> bool {
    let Some(start) = start.and_then(Value::as_u64) else {
        return false;
    };
    if start > MAX_MEDIA_OPERATION_TIME_US {
        return false;
    }
    match end {
        Some(Value::Null) => !end_required && start == 0,
        Some(end) => end
            .as_u64()
            .is_some_and(|end| end > start && end <= MAX_MEDIA_OPERATION_TIME_US),
        None => false,
    }
}

pub(super) struct MediaResolutionPlan {
    pub(super) asset: MediaAsset,
    pub(super) content_hash: Option<ContentHash>,
    pub(super) candidate_lifecycle: bool,
    pub(super) candidates: Vec<MediaLocationCandidate>,
    pub(super) has_more_candidates: bool,
}

pub(super) struct MediaLocationCandidate {
    pub(super) id: Option<Uuid>,
    pub(super) path: Option<PathBuf>,
    pub(super) managed_snapshot: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct MediaFileIdentity {
    size_bytes: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(windows)]
    last_write_time: u64,
}

pub(super) struct VerifiedMediaFile {
    pub(super) content_hash: ContentHash,
    pub(super) file: std::fs::File,
}

#[derive(Clone)]
pub struct ResolvedMedia {
    asset: MediaAsset,
    path: PathBuf,
    file: Arc<std::fs::File>,
    content_hash: ContentHash,
}

#[derive(Clone)]
pub struct PublishedMedia {
    asset: MediaAsset,
    artifact_id: ArtifactId,
    content_hash: ContentHash,
    path: PathBuf,
}

impl PublishedMedia {
    #[must_use]
    pub const fn asset(&self) -> &MediaAsset {
        &self.asset
    }

    #[must_use]
    pub const fn artifact_id(&self) -> ArtifactId {
        self.artifact_id
    }

    #[must_use]
    pub const fn content_hash(&self) -> ContentHash {
        self.content_hash
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl std::fmt::Debug for PublishedMedia {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PublishedMedia")
            .field("asset", &self.asset)
            .field("artifact_id", &self.artifact_id)
            .field("content_hash", &self.content_hash)
            .field("path", &"<redacted>")
            .finish()
    }
}

/// Publishes a verified media file into durable content-addressed storage and
/// remembers its independent opaque media identity. The final artifact path is
/// intentionally extensionless; playback must use the asset's trusted MIME or
/// extension metadata rather than re-inspecting that path.
pub fn publish_durable_media(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
) -> Result<PublishedMedia, DatabaseError> {
    publish_media(database, job_id, kind, asset, source_path, metadata, false)
}

/// Publishes media bytes durably while keeping the new media identity in the explicit candidate
/// lifecycle. Candidate media can be discarded only while it is still detached from every
/// project, or promoted after a project commit makes the reference durable.
pub fn publish_durable_media_candidate(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
) -> Result<PublishedMedia, DatabaseError> {
    publish_media(database, job_id, kind, asset, source_path, metadata, true)
}

#[allow(
    clippy::too_many_arguments,
    reason = "durable publication keeps its immutable artifact and media identity inputs explicit"
)]
fn publish_media(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
    candidate: bool,
) -> Result<PublishedMedia, DatabaseError> {
    let snapshot = snapshot_media_file(source_path, asset.size_bytes())?;
    publish_media_snapshot(
        database,
        Some(job_id),
        kind,
        asset,
        snapshot,
        metadata,
        candidate,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the snapshot publication boundary keeps identity, lifecycle, and optional job claim explicit"
)]
fn publish_media_snapshot(
    database: &Database,
    job_id: Option<JobId>,
    kind: ArtifactKind,
    asset: MediaAsset,
    mut snapshot: MediaSourceSnapshot,
    metadata: Value,
    candidate: bool,
) -> Result<PublishedMedia, DatabaseError> {
    let content_hash = snapshot.content_hash;
    let Value::Object(mut metadata) = metadata else {
        return Err(DatabaseError::InvalidArtifactMetadata);
    };
    metadata.insert(MEDIA_ARTIFACT_METADATA_KEY.to_owned(), Value::Bool(true));
    if candidate && job_id.is_some() {
        metadata.insert(
            COMMIT_ON_JOB_SUCCESS_METADATA_KEY.to_owned(),
            Value::Bool(true),
        );
    }
    let metadata = Value::Object(metadata);
    if !media_provenance_matches_asset(&kind, &metadata, &asset) {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let mut draft = ArtifactDraft::new(kind, content_hash, asset.size_bytes(), metadata)?;
    if let Some(job_id) = job_id {
        draft = draft.with_job(job_id);
    }
    // The database actor owns the durable reservation, while the potentially large filesystem
    // copy happens on the caller.  A process-wide publication lock bridges that gap.  Together
    // with the database writer lease it guarantees that exactly one publisher owns a pending
    // kind/content tuple until it reaches ready or failed.
    let _publication_guard = MEDIA_PUBLICATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = if let Some(job_id) = job_id {
        database.register_media_artifact(&draft, asset.id(), job_id)?
    } else {
        database.register_artifact(&draft)?
    };
    let (artifact_id, staged) = match &registration {
        ArtifactRegistration::Existing(record) | ArtifactRegistration::Pending(record) => {
            (record.id(), false)
        }
        ArtifactRegistration::Staging(staging) => (staging.record().id(), true),
    };
    match registration {
        ArtifactRegistration::Existing(_) => {}
        ArtifactRegistration::Pending(record) => {
            return Err(DatabaseError::ArtifactPublicationInProgress(record.id()));
        }
        ArtifactRegistration::Staging(staging) => {
            let publication = (|| -> std::io::Result<()> {
                let mut target = std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(staging.path())?;
                snapshot.file.seek(SeekFrom::Start(0))?;
                let copied = std::io::copy(&mut snapshot.file, &mut target)?;
                if copied != asset.size_bytes() {
                    return Err(std::io::Error::other("media artifact size changed"));
                }
                target.sync_all()
            })();
            if let Err(error) = publication {
                fail_publication(database, artifact_id);
                return Err(error.into());
            }
        }
    }
    let committed = if let Some(job_id) = job_id {
        database.commit_media_artifact(&asset, artifact_id, job_id, candidate)
    } else {
        database.commit_unclaimed_media_artifact(&asset, artifact_id, candidate)
    };
    let resolved = match committed {
        Ok(resolved) => resolved,
        Err(error) => {
            if staged {
                fail_publication(database, artifact_id);
            }
            return Err(error);
        }
    };
    if resolved.record().content_hash() != content_hash {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    Ok(PublishedMedia {
        asset,
        artifact_id,
        content_hash,
        path: resolved.path().to_owned(),
    })
}

struct MediaSourceSnapshot {
    file: std::fs::File,
    content_hash: ContentHash,
}

pub(super) fn publish_native_media_snapshot(
    database: &Database,
    asset: MediaAsset,
    source_path: &Path,
    candidate: bool,
) -> Result<PublishedMedia, DatabaseError> {
    let snapshot = snapshot_media_file(source_path, asset.size_bytes())?;
    publish_media_snapshot(
        database,
        None,
        ArtifactKind::new(NATIVE_MEDIA_SNAPSHOT_KIND)?,
        asset,
        snapshot,
        serde_json::json!({ "source": "nativeSnapshot" }),
        candidate,
    )
}

fn fail_publication(database: &Database, artifact_id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("mediaPublish") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}

impl ResolvedMedia {
    pub(super) fn new(
        asset: MediaAsset,
        path: PathBuf,
        file: std::fs::File,
        content_hash: ContentHash,
    ) -> Self {
        Self {
            asset,
            path,
            file: Arc::new(file),
            content_hash,
        }
    }

    #[must_use]
    pub const fn asset(&self) -> &MediaAsset {
        &self.asset
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn verified_file(&self) -> Arc<std::fs::File> {
        Arc::clone(&self.file)
    }

    #[must_use]
    pub const fn content_hash(&self) -> ContentHash {
        self.content_hash
    }

    /// Re-hashes the already-open verified handle.  Callers use this immediately after handing
    /// the same handle to a consumer registry, closing the in-place mutation window without a
    /// path reopen or a second pathname trust decision.
    pub fn revalidate_verified_file(&self) -> Result<(), DatabaseError> {
        let (content_hash, _) = digest_media_handle(&self.file, self.asset.size_bytes(), || {})?;
        if content_hash != self.content_hash {
            return Err(DatabaseError::InvalidMediaLocation);
        }
        Ok(())
    }
}

impl std::fmt::Debug for ResolvedMedia {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedMedia")
            .field("asset", &self.asset)
            .field("path", &"<redacted>")
            .field("file", &"<verified handle>")
            .field("content_hash", &self.content_hash)
            .finish()
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "media identity validation, lifecycle refresh, and bounded location publication must remain one transaction-local operation"
)]
pub(super) fn remember_in_transaction(
    connection: &Connection,
    asset: &MediaAsset,
    canonical_path: &Path,
    content_hash: ContentHash,
    candidate: bool,
) -> Result<Uuid, DatabaseError> {
    if !canonical_path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let path_bytes = encode_path(canonical_path)?;
    let size_bytes =
        i64::try_from(asset.size_bytes()).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let timestamp = super::actor::now_ms();
    let existing = connection
        .query_row(
            "SELECT kind, display_name, extension, size_bytes, content_hash, metadata_json
             FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    if existing.as_ref().is_some_and(|existing| {
        existing.0 != media_kind_name(asset.kind())
            || existing.1 != asset.display_name()
            || existing.2 != asset.extension()
            || existing.3 != size_bytes
            || existing
                .4
                .as_ref()
                .is_some_and(|stored| stored.as_slice() != content_hash.as_bytes())
            || (candidate && !metadata_has_lifecycle(&existing.5, MEDIA_CANDIDATE_LIFECYCLE))
    }) {
        return Err(DatabaseError::MediaAssetMismatch(asset.id()));
    }
    let metadata_json = if candidate {
        metadata_with_candidate_lease(
            existing.as_ref().map_or("{}", |stored| stored.5.as_str()),
            timestamp,
        )?
    } else {
        "{}".to_owned()
    };
    connection.execute(
        "INSERT OR IGNORE INTO media_assets(
           id, kind, display_name, extension, size_bytes, content_hash,
           metadata_json, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            asset.id().as_uuid(),
            media_kind_name(asset.kind()),
            asset.display_name(),
            asset.extension(),
            size_bytes,
            content_hash.as_bytes().as_slice(),
            &metadata_json,
            timestamp,
        ],
    )?;
    if candidate && existing.is_some() {
        connection.execute(
            "UPDATE media_assets SET metadata_json = ?1 WHERE id = ?2",
            params![&metadata_json, asset.id().as_uuid()],
        )?;
    }
    connection.execute(
        "UPDATE media_assets SET content_hash = ?1
         WHERE id = ?2 AND content_hash IS NULL",
        params![content_hash.as_bytes().as_slice(), asset.id().as_uuid()],
    )?;
    let proposed_location_id = Uuid::now_v7();
    let location_id = connection.query_row(
        "INSERT INTO media_locations(
           id, media_id, path_bytes, path_encoding, platform, available,
           last_verified_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
         ON CONFLICT(media_id, path_bytes, path_encoding) DO UPDATE SET
           platform = excluded.platform,
           available = 1,
           last_verified_at_ms = excluded.last_verified_at_ms
         RETURNING id",
        params![
            proposed_location_id,
            asset.id().as_uuid(),
            path_bytes,
            path_encoding(),
            platform_name(),
            timestamp,
        ],
        |row| row.get(0),
    )?;
    let offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    connection.execute(
        "DELETE FROM media_locations
         WHERE id IN (
           SELECT id FROM media_locations
           WHERE media_id = ?1
           ORDER BY (id = ?2) DESC, available DESC, last_verified_at_ms DESC, id
           LIMIT -1 OFFSET ?3
         )",
        params![asset.id().as_uuid(), location_id, offset],
    )?;
    Ok(location_id)
}

pub(super) fn commit_media_artifact(
    connection: &mut Connection,
    artifact_root: &ArtifactRoot,
    asset: &MediaAsset,
    artifact_id: ArtifactId,
    job_id: Option<JobId>,
    candidate: bool,
) -> Result<ResolvedArtifact, DatabaseError> {
    let transaction = connection.transaction()?;
    let record = artifacts::ready(&transaction, artifact_root, artifact_id)?;
    if record.size_bytes() != asset.size_bytes()
        || record
            .metadata()
            .as_object()
            .and_then(|metadata| metadata.get("osgMediaArtifact"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    let resolved = artifacts::resolve(&transaction, artifact_root, artifact_id)?
        .ok_or(DatabaseError::ArtifactNotFound(artifact_id))?;
    remember_in_transaction(
        &transaction,
        asset,
        resolved.path(),
        record.content_hash(),
        candidate,
    )?;
    let timestamp = super::actor::now_ms();
    transaction.execute(
        "INSERT INTO media_artifacts(media_id, artifact_id, created_at_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(media_id, artifact_id) DO NOTHING",
        params![asset.id().as_uuid(), artifact_id.as_uuid(), timestamp,],
    )?;
    if let Some(job_id) = job_id {
        transaction.execute(
            "INSERT OR IGNORE INTO media_artifact_job_claims(
               media_id, artifact_id, job_id, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                asset.id().as_uuid(),
                artifact_id.as_uuid(),
                job_id.as_uuid(),
                timestamp,
            ],
        )?;
    }
    transaction.commit()?;
    Ok(resolved)
}

pub(super) fn promote_project_candidates(
    connection: &Connection,
    snapshot: &ProjectSnapshot,
) -> Result<(), DatabaseError> {
    let project_id = snapshot.metadata().id();
    for asset in snapshot.media() {
        connection.execute(
            "INSERT OR IGNORE INTO media_project_owners(media_id, project_id, created_at_ms)
             VALUES (?1, ?2, ?3)",
            params![
                asset.id().as_uuid(),
                project_id.as_uuid(),
                super::actor::now_ms(),
            ],
        )?;
        let owner: Uuid = connection.query_row(
            "SELECT project_id FROM media_project_owners WHERE media_id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )?;
        if owner != *project_id.as_uuid() {
            return Err(DatabaseError::CrossProjectIdentifier {
                project_id,
                entity: "media asset",
            });
        }
        let metadata_json: String = connection.query_row(
            "SELECT metadata_json FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )?;
        if metadata_has_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE) {
            continue;
        }
        let promoted_metadata = metadata_with_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE)?;
        let changed = connection.execute(
            "UPDATE media_assets SET metadata_json = ?1
             WHERE id = ?2 AND metadata_json = ?3",
            params![promoted_metadata, asset.id().as_uuid(), metadata_json],
        )?;
        if changed != 1 {
            return Err(DatabaseError::InvalidMediaLocation);
        }
    }
    Ok(())
}

pub(super) fn discard_candidate_in_transaction(
    connection: &Connection,
    media_id: AssetId,
) -> Result<Option<Vec<ArtifactId>>, DatabaseError> {
    let Some(metadata_json) = connection
        .query_row(
            "SELECT metadata_json FROM media_assets WHERE id = ?1",
            [media_id.as_uuid()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    if !metadata_has_lifecycle(&metadata_json, MEDIA_CANDIDATE_LIFECYCLE) {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT artifact_id FROM media_artifacts
         WHERE media_id = ?1 ORDER BY artifact_id",
    )?;
    let rows = statement.query_map([media_id.as_uuid()], |row| row.get::<_, Uuid>(0))?;
    let mut artifacts = Vec::new();
    for row in rows {
        artifacts.push(ArtifactId::from_uuid(row?)?);
    }
    drop(statement);
    let changed = connection.execute(
        "DELETE FROM media_assets
         WHERE id = ?1 AND metadata_json = ?2
           AND NOT EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)
           AND NOT EXISTS(SELECT 1 FROM media_aliases WHERE media_id = ?1)
           AND NOT EXISTS(
             SELECT 1
              FROM media_artifact_job_claims AS claim
              JOIN jobs AS job ON job.id = claim.job_id
              WHERE claim.media_id = ?1
               AND job.state IN ('queued', 'running', 'cancelling')
           )",
        params![media_id.as_uuid(), metadata_json],
    )?;
    Ok((changed == 1).then_some(artifacts))
}

pub(super) fn artifact_has_persistent_owner(
    connection: &Connection,
    artifact_id: ArtifactId,
) -> Result<bool, DatabaseError> {
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM media_artifacts WHERE artifact_id = ?1
               UNION ALL
               SELECT 1 FROM cache_entries WHERE artifact_id = ?1
               UNION ALL
               SELECT 1 FROM artifacts WHERE id = ?1 AND project_id IS NOT NULL
             )",
            [artifact_id.as_uuid()],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub(super) fn cleanup_failed_artifact_candidates(
    connection: &Connection,
    artifact_id: ArtifactId,
) -> Result<usize, DatabaseError> {
    connection
        .execute(
            "DELETE FROM media_assets
             WHERE json_extract(metadata_json, '$.osgMediaLifecycle') = 'candidate'
               AND NOT EXISTS(
                 SELECT 1 FROM project_media WHERE media_id = media_assets.id
               )
               AND NOT EXISTS(
                 SELECT 1 FROM media_aliases WHERE media_id = media_assets.id
               )
               AND id IN (
                 SELECT claim.media_id
                  FROM media_artifact_job_claims AS claim
                  JOIN jobs AS job ON job.id = claim.job_id
                  WHERE claim.artifact_id = ?1
                   AND job.state IN ('failed', 'cancelled', 'interrupted')
               )
               AND NOT EXISTS(
                 SELECT 1
                  FROM media_artifacts AS keep
                  WHERE keep.media_id = media_assets.id
                    AND (
                      NOT EXISTS(
                        SELECT 1 FROM media_artifact_job_claims AS any_claim
                        WHERE any_claim.media_id = keep.media_id
                          AND any_claim.artifact_id = keep.artifact_id
                      )
                      OR EXISTS(
                        SELECT 1
                        FROM media_artifact_job_claims AS keep_claim
                        JOIN jobs AS keep_job ON keep_job.id = keep_claim.job_id
                        WHERE keep_claim.media_id = keep.media_id
                          AND keep_claim.artifact_id = keep.artifact_id
                          AND keep_job.state IN (
                            'queued', 'running', 'cancelling', 'succeeded'
                          )
                      )
                    )
               )",
            [artifact_id.as_uuid()],
        )
        .map_err(Into::into)
}

pub(super) fn promote_candidate(
    connection: &mut Connection,
    media_id: AssetId,
) -> Result<bool, DatabaseError> {
    let transaction = connection.transaction()?;
    let Some((metadata_json, referenced)) = transaction
        .query_row(
            "SELECT metadata_json,
                    EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)
             FROM media_assets WHERE id = ?1",
            [media_id.as_uuid()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
    else {
        transaction.commit()?;
        return Ok(false);
    };
    if metadata_has_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE) {
        transaction.commit()?;
        return Ok(false);
    }
    if metadata_has_lifecycle(&metadata_json, MEDIA_CANDIDATE_LIFECYCLE) {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    if referenced {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    transaction.commit()?;
    Ok(false)
}

fn metadata_has_lifecycle(metadata_json: &str, lifecycle: &str) -> bool {
    serde_json::from_str::<Value>(metadata_json)
        .ok()
        .is_some_and(|metadata| {
            metadata
                .get(MEDIA_LIFECYCLE_KEY)
                .and_then(Value::as_str)
                .is_some_and(|value| value == lifecycle)
        })
}

fn metadata_with_lifecycle(metadata_json: &str, lifecycle: &str) -> Result<String, DatabaseError> {
    let mut metadata = serde_json::from_str::<Value>(metadata_json)?;
    let object = metadata
        .as_object_mut()
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    object.insert(
        MEDIA_LIFECYCLE_KEY.to_owned(),
        Value::String(lifecycle.to_owned()),
    );
    if lifecycle == MEDIA_PROJECT_LIFECYCLE {
        object.remove(MEDIA_CANDIDATE_EXPIRY_KEY);
    }
    serde_json::to_string(&metadata).map_err(Into::into)
}

fn metadata_with_candidate_lease(
    metadata_json: &str,
    timestamp: i64,
) -> Result<String, DatabaseError> {
    let mut metadata = serde_json::from_str::<Value>(metadata_json)?;
    let object = metadata
        .as_object_mut()
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    let expires_at = timestamp
        .checked_add(MEDIA_CANDIDATE_TTL_MS)
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    object.insert(
        MEDIA_LIFECYCLE_KEY.to_owned(),
        Value::String(MEDIA_CANDIDATE_LIFECYCLE.to_owned()),
    );
    object.insert(
        MEDIA_CANDIDATE_EXPIRY_KEY.to_owned(),
        Value::from(expires_at),
    );
    serde_json::to_string(&metadata).map_err(Into::into)
}

pub(super) fn cleanup_expired_candidates(
    connection: &Connection,
    timestamp: i64,
) -> Result<u64, DatabaseError> {
    let removed = connection.execute(
        "DELETE FROM media_assets
         WHERE id IN (
           SELECT candidate.id
           FROM media_assets AS candidate
           WHERE json_extract(candidate.metadata_json, '$.osgMediaLifecycle') = 'candidate'
             AND json_type(
               candidate.metadata_json, '$.osgMediaCandidateExpiresAtMs'
             ) = 'integer'
             AND json_extract(
               candidate.metadata_json, '$.osgMediaCandidateExpiresAtMs'
             ) <= ?1
             AND NOT EXISTS(
               SELECT 1 FROM project_media WHERE media_id = candidate.id
             )
             AND NOT EXISTS(
               SELECT 1 FROM media_aliases WHERE media_id = candidate.id
             )
             AND NOT EXISTS(
               SELECT 1
                FROM media_artifact_job_claims AS claim
                JOIN jobs AS job ON job.id = claim.job_id
                WHERE claim.media_id = candidate.id
                 AND job.state IN ('queued', 'running', 'cancelling')
             )
           ORDER BY candidate.created_at_ms, candidate.id
           LIMIT ?2
         )",
        params![timestamp, MAX_EXPIRED_CANDIDATE_CLEANUP],
    )?;
    u64::try_from(removed).map_err(|_| DatabaseError::InvalidMediaLocation)
}

pub(super) fn resolution_plan(
    connection: &Connection,
    artifact_root: &ArtifactRoot,
    id: AssetId,
    require_project_owner: bool,
    project_revision: Option<(ProjectId, u64)>,
) -> Result<Option<MediaResolutionPlan>, DatabaseError> {
    let stored_asset = connection
        .query_row(
            "SELECT display_name, extension, size_bytes, kind, content_hash, metadata_json,
                    EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)
             FROM media_assets WHERE id = ?1",
            [id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((display_name, extension, size_bytes, kind, content_hash, metadata_json, referenced)) =
        stored_asset
    else {
        return Ok(None);
    };
    let lifecycle_is_project = metadata_has_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE);
    let authorized = if let Some((project_id, expected_state_version)) = project_revision {
        project_media_is_current(connection, project_id, expected_state_version, id)?
    } else {
        referenced && lifecycle_is_project
    };
    if require_project_owner && !authorized {
        return Ok(None);
    }
    compact_media_locations(connection, id)?;
    let size_bytes = u64::try_from(size_bytes).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let kind = match kind.as_str() {
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        _ => return Err(DatabaseError::InvalidMediaLocation),
    };
    let asset = MediaAsset::with_id(id, display_name, extension, size_bytes, kind)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let content_hash = content_hash
        .map(|bytes| {
            <[u8; 32]>::try_from(bytes)
                .map(ContentHash::from_bytes)
                .map_err(|_| DatabaseError::InvalidMediaLocation)
        })
        .transpose()?;
    let candidate_lifecycle = metadata_has_lifecycle(&metadata_json, MEDIA_CANDIDATE_LIFECYCLE);
    let (mut candidates, artifact_has_more) =
        managed_artifact_candidates(connection, artifact_root, id)?;
    let remaining = MAX_MEDIA_LOCATION_CANDIDATES.saturating_sub(candidates.len());
    if remaining == 0 {
        return Ok(Some(MediaResolutionPlan {
            asset,
            content_hash,
            candidate_lifecycle,
            candidates,
            has_more_candidates: artifact_has_more,
        }));
    }
    let (locations, location_has_more) = media_location_candidates(connection, id, remaining)?;
    candidates.extend(locations);
    Ok(Some(MediaResolutionPlan {
        asset,
        content_hash,
        candidate_lifecycle,
        candidates,
        has_more_candidates: artifact_has_more || location_has_more,
    }))
}

fn compact_media_locations(connection: &Connection, id: AssetId) -> Result<(), DatabaseError> {
    let location_offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    connection.execute(
        "DELETE FROM media_locations
         WHERE id IN (
           SELECT id FROM media_locations
           WHERE media_id = ?1
           ORDER BY available DESC,
                    CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                    CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                    id
           LIMIT -1 OFFSET ?2
         )",
        params![id.as_uuid(), location_offset],
    )?;
    Ok(())
}

fn managed_artifact_candidates(
    connection: &Connection,
    artifact_root: &ArtifactRoot,
    id: AssetId,
) -> Result<(Vec<MediaLocationCandidate>, bool), DatabaseError> {
    let candidate_limit = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES + 1)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let mut artifact_statement = connection.prepare(
        "SELECT link.artifact_id
         FROM media_artifacts AS link
         JOIN artifacts AS artifact ON artifact.id = link.artifact_id
         WHERE link.media_id = ?1 AND artifact.state = 'ready'
         ORDER BY artifact.created_at_ms DESC, artifact.id DESC
         LIMIT ?2",
    )?;
    let artifact_rows = artifact_statement
        .query_map(params![id.as_uuid(), candidate_limit], |row| {
            row.get::<_, Uuid>(0)
        })?;
    let mut artifact_ids = Vec::new();
    for row in artifact_rows {
        artifact_ids.push(ArtifactId::from_uuid(row?)?);
    }
    drop(artifact_statement);
    let mut candidates = Vec::new();
    for artifact_id in artifact_ids {
        if let Some(resolved) = artifacts::resolve(connection, artifact_root, artifact_id)? {
            candidates.push(MediaLocationCandidate {
                id: None,
                path: Some(resolved.path().to_owned()),
                managed_snapshot: true,
            });
        }
    }
    let artifact_has_more = candidates.len() > MAX_MEDIA_LOCATION_CANDIDATES;
    candidates.truncate(MAX_MEDIA_LOCATION_CANDIDATES);
    Ok((candidates, artifact_has_more))
}

fn media_location_candidates(
    connection: &Connection,
    id: AssetId,
    limit: usize,
) -> Result<(Vec<MediaLocationCandidate>, bool), DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id, path_bytes, path_encoding
         FROM media_locations
         WHERE media_id = ?1 AND platform = ?2
         ORDER BY available DESC,
                  CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                  CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                  id
         LIMIT ?3",
    )?;
    let location_limit =
        i64::try_from(limit + 1).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let rows = statement.query_map(
        params![id.as_uuid(), platform_name(), location_limit],
        |row| {
            Ok((
                row.get::<_, Uuid>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    let mut locations = Vec::new();
    for row in rows {
        locations.push(row?);
    }
    drop(statement);
    let location_has_more = locations.len() > limit;
    locations.truncate(limit);
    Ok((
        locations
            .into_iter()
            .map(|(location_id, bytes, encoding)| MediaLocationCandidate {
                id: Some(location_id),
                path: decode_path(&bytes, &encoding),
                managed_snapshot: false,
            })
            .collect(),
        location_has_more,
    ))
}

pub(super) fn project_media_is_current(
    connection: &Connection,
    project_id: ProjectId,
    expected_state_version: u64,
    id: AssetId,
) -> Result<bool, DatabaseError> {
    let expected_state_version =
        i64::try_from(expected_state_version).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM project_media AS owned
               JOIN projects AS project ON project.id = owned.project_id
               JOIN media_assets AS media ON media.id = owned.media_id
               WHERE owned.project_id = ?1
                 AND owned.media_id = ?2
                 AND project.state_version = ?3
                 AND json_extract(media.metadata_json, '$.osgMediaLifecycle') = 'project'
             )",
            params![project_id.as_uuid(), id.as_uuid(), expected_state_version],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub(super) fn mark_location(
    connection: &mut Connection,
    media_id: AssetId,
    location_id: Uuid,
    available: bool,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE media_locations
         SET available = ?1, last_verified_at_ms = ?2
         WHERE id = ?3 AND media_id = ?4",
        params![
            available,
            super::actor::now_ms(),
            location_id,
            media_id.as_uuid(),
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let location_count: i64 = transaction.query_row(
        "SELECT count(*) FROM media_locations WHERE media_id = ?1",
        [media_id.as_uuid()],
        |row| row.get(0),
    )?;
    if usize::try_from(location_count).map_err(|_| DatabaseError::InvalidMediaLocation)?
        > MAX_MEDIA_LOCATION_CANDIDATES
    {
        if available {
            let offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
                .map_err(|_| DatabaseError::InvalidMediaLocation)?;
            transaction.execute(
                "DELETE FROM media_locations
                 WHERE id IN (
                   SELECT id FROM media_locations
                   WHERE media_id = ?1
                   ORDER BY available DESC,
                            CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                            CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                            id
                   LIMIT -1 OFFSET ?2
                 )",
                params![media_id.as_uuid(), offset],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM media_locations WHERE id = ?1 AND media_id = ?2",
                params![location_id, media_id.as_uuid()],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn digest_media_file(
    path: &Path,
    expected_size: u64,
) -> Result<VerifiedMediaFile, DatabaseError> {
    digest_media_file_with_post_hash(path, expected_size, || {})
}

fn digest_media_file_with_post_hash(
    path: &Path,
    expected_size: u64,
    post_hash: impl FnOnce(),
) -> Result<VerifiedMediaFile, DatabaseError> {
    if !path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let file = open_media_file(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let hashed_handle = same_file::Handle::from_file(
        file.try_clone()
            .map_err(|_| DatabaseError::InvalidMediaLocation)?,
    )
    .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let (content_hash, after_identity) = digest_media_handle(&file, expected_size, post_hash)?;
    let _ = after_identity;
    let current_path_handle =
        same_file::Handle::from_path(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if hashed_handle != current_path_handle {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(VerifiedMediaFile { content_hash, file })
}

/// Copies the exact opened source handle into a private anonymous file while hashing it.  The
/// second source pass proves that a concurrent in-place writer did not produce a mixed snapshot;
/// after this boundary all publication reads come exclusively from the private handle.
fn snapshot_media_file(
    path: &Path,
    expected_size: u64,
) -> Result<MediaSourceSnapshot, DatabaseError> {
    snapshot_media_file_with_post_copy(path, expected_size, || {})
}

fn snapshot_media_file_with_post_copy(
    path: &Path,
    expected_size: u64,
    post_copy: impl FnOnce(),
) -> Result<MediaSourceSnapshot, DatabaseError> {
    let source_metadata =
        std::fs::symlink_metadata(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if !source_metadata.file_type().is_file()
        || source_metadata.file_type().is_symlink()
        || source_metadata.len() != expected_size
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    let source = open_media_file(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let source_handle = same_file::Handle::from_file(
        source
            .try_clone()
            .map_err(|_| DatabaseError::InvalidArtifactFile)?,
    )
    .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let before = source
        .metadata()
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let before_identity = media_file_identity(&before);
    let mut reader = source
        .try_clone()
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let mut file = tempfile::tempfile().map_err(DatabaseError::Io)?;
    let mut hasher = blake3::Hasher::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| DatabaseError::InvalidArtifactFile)?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(read).map_err(|_| DatabaseError::InvalidArtifactFile)?)
            .filter(|copied| *copied <= expected_size)
            .ok_or(DatabaseError::InvalidArtifactFile)?;
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    }
    if copied != expected_size {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    file.sync_all()
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let content_hash = ContentHash::from_bytes(*hasher.finalize().as_bytes());
    post_copy();
    let (source_hash, after_identity) = digest_media_handle(&source, expected_size, || {})
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let current_path_handle =
        same_file::Handle::from_path(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if content_hash != source_hash
        || before_identity != after_identity
        || source_handle != current_path_handle
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    Ok(MediaSourceSnapshot { file, content_hash })
}

fn digest_media_handle(
    file: &std::fs::File,
    expected_size: u64,
    post_hash: impl FnOnce(),
) -> Result<(ContentHash, MediaFileIdentity), DatabaseError> {
    let before = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if !before.is_file() || before.len() != expected_size {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let before_identity = media_file_identity(&before);
    let read_limit = expected_size
        .checked_add(1)
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    let mut reader = file
        .try_clone()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let mut bounded = BufReader::new(reader).take(read_limit);
    let content_hash = ContentHash::digest_reader(&mut bounded)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let remaining = bounded.limit();
    drop(bounded);
    post_hash();

    let after = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let after_identity = media_file_identity(&after);
    if remaining != 1
        || !after.is_file()
        || after.len() != expected_size
        || before_identity != after_identity
    {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok((content_hash, after_identity))
}

fn open_media_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        // The verified handle lives for the playback registration, so excluding write sharing
        // prevents a later writer from mutating the bytes behind that exact Windows handle.
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
    }
    options.open(path)
}

fn media_file_identity(metadata: &std::fs::Metadata) -> MediaFileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        MediaFileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        MediaFileIdentity {
            size_bytes: metadata.file_size(),
            modified: metadata.modified().ok(),
            creation_time: metadata.creation_time(),
            last_write_time: metadata.last_write_time(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        MediaFileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

fn encode_path(path: &Path) -> Result<Vec<u8>, DatabaseError> {
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(bytes)
}

fn decode_path(bytes: &[u8], encoding: &str) -> Option<PathBuf> {
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES || encoding != path_encoding() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let wide = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        Some(PathBuf::from(OsString::from_wide(&wide)))
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
    }
}

const fn path_encoding() -> &'static str {
    if cfg!(windows) {
        "windows-utf16le"
    } else {
        "unix-bytes"
    }
}

const fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

const fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

#[cfg(test)]
mod tests {
    use osg_application::ProjectSnapshot;
    use osg_domain::{
        JobId, JobKind, JobSnapshot, MediaAsset, MediaKind, ProjectMetadata, RevisionReason,
    };
    use rusqlite::params;
    use serde_json::Value;
    use uuid::Uuid;

    #[cfg(unix)]
    use super::snapshot_media_file_with_post_copy;
    use super::{
        decode_path, digest_media_file, digest_media_file_with_post_hash, encode_path,
        path_encoding, platform_name, publish_durable_media, publish_durable_media_candidate,
    };
    use crate::storage::{
        ArtifactDraft, ArtifactKind, ArtifactRegistration, ArtifactState, CacheCategory, CacheKey,
        CacheWrite, ContentHash, DatabaseError,
    };

    fn complete_queued_job(database: &super::super::Database, job: &mut JobSnapshot) {
        let queued_sequence = job.sequence();
        job.start().expect("start completed job");
        database
            .compare_and_swap_job(queued_sequence, job)
            .expect("persist running job");
        let running_sequence = job.sequence();
        job.succeed().expect("complete job");
        database
            .compare_and_swap_job(running_sequence, job)
            .expect("persist completed job");
    }

    fn make_test_file_writable(path: &std::path::Path) {
        let metadata = std::fs::metadata(path).expect("artifact metadata");
        let mut permissions = metadata.permissions();
        #[cfg(windows)]
        {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            permissions.set_mode(permissions.mode() | 0o200);
        }
        std::fs::set_permissions(path, permissions).expect("make fixture writable");
    }

    #[test]
    fn candidate_identity_hashes_the_full_file_and_is_stable_across_paths() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let first_path = directory.path().join("first.mp4");
        let second_path = directory.path().join("renamed.mp4");
        let different_path = directory.path().join("different.mp4");
        let mut shared = vec![0x41; 1024 * 1024 + 1];
        std::fs::write(&first_path, &shared).expect("first fixture");
        std::fs::write(&second_path, &shared).expect("renamed fixture");
        shared[1024 * 1024] = 0x42;
        std::fs::write(&different_path, &shared).expect("different fixture");
        let size = u64::try_from(shared.len()).expect("fixture size");
        let first = MediaAsset::new("first.mp4", "mp4", size, MediaKind::Video).expect("asset");
        let renamed = MediaAsset::new("renamed.mp4", "mp4", size, MediaKind::Video).expect("asset");
        let different =
            MediaAsset::new("different.mp4", "mp4", size, MediaKind::Video).expect("asset");

        let first_hash = database
            .remember_media_candidate(&first, &first_path)
            .expect("first candidate");
        let repeated_hash = database
            .remember_media_candidate(&first, &first_path)
            .expect("idempotent reselection");
        let renamed_hash = database
            .remember_media_candidate(&renamed, &second_path)
            .expect("same bytes at a different path");
        let different_hash = database
            .remember_media_candidate(&different, &different_path)
            .expect("different tail byte");

        assert_eq!(first_hash, repeated_hash);
        assert_eq!(first_hash, renamed_hash);
        assert_ne!(first_hash, different_hash);
        assert_eq!(first_hash, ContentHash::digest(&vec![0x41; shared.len()]));
    }

    #[test]
    fn known_media_publication_requires_metadata_to_match_the_published_asset() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let source = directory.path().join("actual.mp4");
        std::fs::write(&source, b"media").expect("source fixture");
        let job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&job).expect("job");
        let asset = MediaAsset::new("actual.mp4", "mp4", 5, MediaKind::Video).expect("asset");

        assert!(matches!(
            publish_durable_media_candidate(
                &database,
                job.id(),
                ArtifactKind::new("downloadedMedia").expect("kind"),
                asset.clone(),
                &source,
                serde_json::json!({
                    "source": "urlDownload", "filename": "different.mp4"
                }),
            ),
            Err(DatabaseError::InvalidArtifactMetadata)
        ));
        assert!(
            database
                .resolve_media(asset.id())
                .expect("media lookup")
                .is_none()
        );
    }

    #[test]
    fn expired_detached_picker_candidate_is_reconciled_without_touching_source_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let source_path = directory.path().join("private.mp4");
        let bytes = vec![0x4a; 16 * 1024];
        std::fs::write(&source_path, &bytes).expect("picker fixture");
        let asset = MediaAsset::new(
            "private.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        database
            .remember_media_candidate(&asset, &source_path)
            .expect("stage picker candidate");
        rusqlite::Connection::open(&database_path)
            .expect("expire candidate")
            .execute(
                "UPDATE media_assets
                 SET metadata_json = json_set(
                   metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                 )
                 WHERE id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("expire candidate");

        let report = database
            .reconcile_artifacts()
            .expect("reconcile expired candidate");

        assert_eq!(report.removed_expired_media_candidates, 1);
        assert!(
            database
                .resolve_media(asset.id())
                .expect("expired candidate lookup")
                .is_none()
        );
        assert_eq!(std::fs::read(source_path).expect("source remains"), bytes);
    }

    #[test]
    fn alias_owned_candidate_survives_discard_and_expiry_until_the_alias_is_removed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let source_path = directory.path().join("aliased.mp4");
        let bytes = vec![0x4b; 8 * 1024];
        std::fs::write(&source_path, &bytes).expect("aliased fixture");
        let asset = MediaAsset::new(
            "aliased.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        database
            .remember_media_candidate(&asset, &source_path)
            .expect("stage aliased candidate");
        let connection = rusqlite::Connection::open(&database_path).expect("alias connection");
        connection
            .execute(
                "INSERT INTO media_aliases(namespace, alias, media_id, created_at_ms)
                 VALUES ('url', 'stable-content-alias', ?1, 1)",
                [asset.id().as_uuid()],
            )
            .expect("create alias ownership");
        connection
            .execute(
                "UPDATE media_assets
                 SET metadata_json = json_set(
                   metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                 ) WHERE id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("expire aliased candidate");
        assert!(
            !database
                .discard_media_candidate(asset.id())
                .expect("alias-owned discard")
        );
        assert_eq!(
            database
                .reconcile_artifacts()
                .expect("reconcile alias-owned candidate")
                .removed_expired_media_candidates,
            0
        );
        assert!(
            database
                .resolve_media(asset.id())
                .expect("alias-owned candidate lookup")
                .is_some()
        );

        connection
            .execute(
                "DELETE FROM media_aliases WHERE namespace = 'url' AND alias = ?1",
                ["stable-content-alias"],
            )
            .expect("remove alias ownership");
        assert!(
            database
                .discard_media_candidate(asset.id())
                .expect("discard after alias removal")
        );
    }

    #[test]
    fn content_dedup_links_each_candidate_and_discards_in_either_order() {
        for discard_first in [true, false] {
            let directory = tempfile::tempdir().expect("temporary directory");
            let database_path = directory.path().join("osg.sqlite3");
            let database = super::super::Database::open(&database_path).expect("open database");
            let source_path = directory.path().join("download.mp4");
            let bytes = vec![0x6a; 64 * 1024];
            std::fs::write(&source_path, &bytes).expect("download fixture");
            let mut first_job = JobSnapshot::new(JobKind::DownloadMedia);
            let mut second_job = JobSnapshot::new(JobKind::DownloadMedia);
            database.create_job(&first_job).expect("first job");
            database.create_job(&second_job).expect("second job");
            let first_asset = MediaAsset::new(
                "first.mp4",
                "mp4",
                u64::try_from(bytes.len()).expect("fixture size"),
                MediaKind::Video,
            )
            .expect("first asset");
            let second_asset = MediaAsset::new(
                "second.mp4",
                "mp4",
                u64::try_from(bytes.len()).expect("fixture size"),
                MediaKind::Video,
            )
            .expect("second asset");
            let kind = ArtifactKind::new("downloadMedia").expect("artifact kind");
            let first = publish_durable_media_candidate(
                &database,
                first_job.id(),
                kind.clone(),
                first_asset.clone(),
                &source_path,
                serde_json::json!({"source": "shared"}),
            )
            .expect("publish first candidate");
            let second = publish_durable_media_candidate(
                &database,
                second_job.id(),
                kind,
                second_asset.clone(),
                &source_path,
                serde_json::json!({"source": "shared"}),
            )
            .expect("publish second candidate");
            assert_eq!(first.artifact_id(), second.artifact_id());
            for job in [&mut first_job, &mut second_job] {
                complete_queued_job(&database, job);
            }
            let connection = rusqlite::Connection::open(&database_path).expect("inspect links");
            let link_count: i64 = connection
                .query_row(
                    "SELECT count(*) FROM media_artifacts WHERE artifact_id = ?1",
                    [first.artifact_id().as_uuid()],
                    |row| row.get(0),
                )
                .expect("link count");
            assert_eq!(link_count, 2);
            drop(connection);

            let (discarded, survivor) = if discard_first {
                (&first_asset, &second_asset)
            } else {
                (&second_asset, &first_asset)
            };
            assert!(
                database
                    .discard_media_candidate(discarded.id())
                    .expect("discard first candidate")
            );
            assert!(
                database
                    .resolve_media(survivor.id())
                    .expect("resolve survivor")
                    .is_some()
            );
            assert!(
                database
                    .resolve_artifact(first.artifact_id())
                    .expect("resolve shared artifact")
                    .is_some()
            );
            assert!(
                database
                    .discard_media_candidate(survivor.id())
                    .expect("discard final candidate")
            );
            assert!(
                database
                    .resolve_artifact(first.artifact_id())
                    .expect("resolve removed artifact")
                    .is_none()
            );
            assert!(!first.path().exists());
        }
    }

    #[test]
    fn explicit_discard_preserves_a_candidate_owned_by_a_live_job() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let source_path = directory.path().join("live.mp4");
        let bytes = b"live download candidate";
        std::fs::write(&source_path, bytes).expect("download fixture");
        let mut job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&job).expect("create download job");
        let queued_sequence = job.sequence();
        job.start().expect("start download job");
        database
            .compare_and_swap_job(queued_sequence, &job)
            .expect("persist running download");
        let asset = MediaAsset::new(
            "live.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        let published = publish_durable_media_candidate(
            &database,
            job.id(),
            ArtifactKind::new("downloadMedia").expect("artifact kind"),
            asset.clone(),
            &source_path,
            serde_json::json!({"source": "live"}),
        )
        .expect("publish live candidate");

        assert!(
            !database
                .discard_media_candidate(asset.id())
                .expect("live candidate must be protected")
        );
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve protected media")
                .is_some()
        );
        assert!(
            database
                .resolve_artifact(published.artifact_id())
                .expect("resolve protected artifact")
                .is_some()
        );

        let running_sequence = job.sequence();
        job.succeed().expect("finish download job");
        database
            .compare_and_swap_job(running_sequence, &job)
            .expect("persist finished download");
        assert!(
            database
                .discard_media_candidate(asset.id())
                .expect("terminal candidate can be discarded")
        );
        assert!(
            database
                .resolve_artifact(published.artifact_id())
                .expect("discarded artifact lookup")
                .is_none()
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "each active job state is exercised as the sole surviving plural claim"
    )]
    fn plural_job_claims_protect_each_active_state_from_discard_expiry_and_failure() {
        for active_state in ["queued", "running", "cancelling"] {
            let directory = tempfile::tempdir().expect("temporary directory");
            let database_path = directory.path().join("osg.sqlite3");
            let database = super::super::Database::open(&database_path).expect("database");
            let source_path = directory.path().join(format!("{active_state}.mp4"));
            let bytes = format!("plural claim fixture {active_state}").into_bytes();
            std::fs::write(&source_path, &bytes).expect("source fixture");
            let asset = MediaAsset::new(
                format!("{active_state}.mp4"),
                "mp4",
                u64::try_from(bytes.len()).expect("fixture size"),
                MediaKind::Video,
            )
            .expect("asset");
            let mut failed_job = JobSnapshot::new(JobKind::DownloadMedia);
            let mut active_job = JobSnapshot::new(JobKind::DownloadMedia);
            database.create_job(&failed_job).expect("failed job");
            database.create_job(&active_job).expect("active job");
            let sequence = failed_job.sequence();
            failed_job.start().expect("start failed job");
            database
                .compare_and_swap_job(sequence, &failed_job)
                .expect("persist failed-job running state");
            if matches!(active_state, "running" | "cancelling") {
                let sequence = active_job.sequence();
                active_job.start().expect("start active job");
                database
                    .compare_and_swap_job(sequence, &active_job)
                    .expect("persist active running state");
            }
            if active_state == "cancelling" {
                let sequence = active_job.sequence();
                active_job
                    .request_cancellation()
                    .expect("request cancellation");
                database
                    .compare_and_swap_job(sequence, &active_job)
                    .expect("persist cancelling state");
            }
            let kind = ArtifactKind::new("downloadMediaClaimFixture").expect("kind");
            let first = publish_durable_media_candidate(
                &database,
                failed_job.id(),
                kind.clone(),
                asset.clone(),
                &source_path,
                serde_json::json!({"source": "plural-claim"}),
            )
            .expect("publish failed owner");
            let second = publish_durable_media_candidate(
                &database,
                active_job.id(),
                kind,
                asset.clone(),
                &source_path,
                serde_json::json!({"source": "plural-claim"}),
            )
            .expect("publish active owner");
            assert_eq!(first.artifact_id(), second.artifact_id());
            let claims: i64 = rusqlite::Connection::open(&database_path)
                .expect("inspect claims")
                .query_row(
                    "SELECT COUNT(*) FROM media_artifact_job_claims
                     WHERE media_id = ?1 AND artifact_id = ?2",
                    params![asset.id().as_uuid(), first.artifact_id().as_uuid()],
                    |row| row.get(0),
                )
                .expect("claim count");
            assert_eq!(claims, 2);
            rusqlite::Connection::open(&database_path)
                .expect("expire candidate")
                .execute(
                    "UPDATE media_assets SET metadata_json = json_set(
                       metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                     ) WHERE id = ?1",
                    [asset.id().as_uuid()],
                )
                .expect("expire candidate");
            let sequence = failed_job.sequence();
            failed_job.fail().expect("fail owner");
            database
                .compare_and_swap_job(sequence, &failed_job)
                .expect("persist failed owner");

            assert_eq!(
                database
                    .reconcile_artifacts()
                    .expect("reconcile active claim")
                    .removed_expired_media_candidates,
                0
            );
            assert!(
                !database
                    .discard_media_candidate(asset.id())
                    .expect("active claim blocks discard")
            );
            assert!(
                database
                    .resolve_media(asset.id())
                    .expect("resolve")
                    .is_some()
            );

            if active_state == "queued" {
                let sequence = active_job.sequence();
                active_job.start().expect("start queued claim");
                database
                    .compare_and_swap_job(sequence, &active_job)
                    .expect("persist running queued claim");
            }
            let sequence = active_job.sequence();
            if active_state == "cancelling" {
                active_job
                    .confirm_cancelled()
                    .expect("confirm cancellation");
            } else {
                active_job.fail().expect("fail active claim");
            }
            database
                .compare_and_swap_job(sequence, &active_job)
                .expect("persist terminal active claim");
            let report = database
                .reconcile_artifacts()
                .expect("reconcile terminal claims");
            assert_eq!(report.removed_expired_media_candidates, 1);
            assert!(
                database
                    .resolve_media(asset.id())
                    .expect("removed media")
                    .is_none()
            );
            assert!(
                database
                    .resolve_artifact(first.artifact_id())
                    .expect("removed artifact")
                    .is_none()
            );
        }
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "restart interruption checks every plural claim"
    )]
    fn restart_interrupts_in_flight_claims_but_a_queued_claim_still_protects_the_candidate() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let source_path = directory.path().join("restart.mp4");
        let bytes = b"plural restart fixture";
        std::fs::write(&source_path, bytes).expect("source fixture");
        let asset = MediaAsset::new(
            "restart.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        let queued_id;
        let running_id;
        let cancelling_id;
        let artifact_id;
        {
            let database = super::super::Database::open(&database_path).expect("database");
            let queued = JobSnapshot::new(JobKind::DownloadMedia);
            let mut running = JobSnapshot::new(JobKind::DownloadMedia);
            let mut cancelling = JobSnapshot::new(JobKind::DownloadMedia);
            for job in [&queued, &running, &cancelling] {
                database.create_job(job).expect("create job");
            }
            let sequence = running.sequence();
            running.start().expect("start running claim");
            database
                .compare_and_swap_job(sequence, &running)
                .expect("persist running claim");
            let sequence = cancelling.sequence();
            cancelling.start().expect("start cancelling claim");
            database
                .compare_and_swap_job(sequence, &cancelling)
                .expect("persist pre-cancel running claim");
            let sequence = cancelling.sequence();
            cancelling
                .request_cancellation()
                .expect("request cancellation");
            database
                .compare_and_swap_job(sequence, &cancelling)
                .expect("persist cancelling claim");
            let kind = ArtifactKind::new("restartMediaClaimFixture").expect("kind");
            let mut published = None;
            for job in [&queued, &running, &cancelling] {
                published = Some(
                    publish_durable_media_candidate(
                        &database,
                        job.id(),
                        kind.clone(),
                        asset.clone(),
                        &source_path,
                        serde_json::json!({"source": "restart"}),
                    )
                    .expect("publish claim"),
                );
            }
            queued_id = queued.id();
            running_id = running.id();
            cancelling_id = cancelling.id();
            artifact_id = published.expect("publication").artifact_id();
            rusqlite::Connection::open(&database_path)
                .expect("expire candidate")
                .execute(
                    "UPDATE media_assets SET metadata_json = json_set(
                       metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                     ) WHERE id = ?1",
                    [asset.id().as_uuid()],
                )
                .expect("expire candidate");
        }

        let database = super::super::Database::open(&database_path).expect("restart database");
        assert_eq!(
            database
                .get_job(running_id)
                .expect("running job")
                .expect("running claim")
                .state(),
            osg_domain::JobState::Interrupted
        );
        assert_eq!(
            database
                .get_job(cancelling_id)
                .expect("cancelling job")
                .expect("cancelling claim")
                .state(),
            osg_domain::JobState::Interrupted
        );
        let mut queued = database
            .get_job(queued_id)
            .expect("queued job")
            .expect("queued claim");
        assert_eq!(queued.state(), osg_domain::JobState::Queued);
        assert!(
            database
                .resolve_media(asset.id())
                .expect("protected media")
                .is_some()
        );
        assert!(
            !database
                .discard_media_candidate(asset.id())
                .expect("discard")
        );
        let sequence = queued.sequence();
        queued.start().expect("start queued claim");
        database
            .compare_and_swap_job(sequence, &queued)
            .expect("persist running claim");
        let sequence = queued.sequence();
        queued.fail().expect("fail last claim");
        database
            .compare_and_swap_job(sequence, &queued)
            .expect("persist failed claim");
        database
            .reconcile_artifacts()
            .expect("reconcile all terminal claims");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("removed media")
                .is_none()
        );
        assert!(
            database
                .resolve_artifact(artifact_id)
                .expect("removed artifact")
                .is_none()
        );
    }

    #[test]
    fn artifact_ready_media_and_link_rows_commit_or_roll_back_together() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let bytes = b"atomic publication";
        let job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&job).expect("create job");
        let draft = ArtifactDraft::new(
            ArtifactKind::new("downloadMedia").expect("artifact kind"),
            ContentHash::digest(bytes),
            u64::try_from(bytes.len()).expect("fixture size"),
            serde_json::json!({"osgMediaArtifact": true, "commitOnJobSuccess": true}),
        )
        .expect("artifact draft")
        .with_job(job.id());
        let staging = match database
            .register_artifact(&draft)
            .expect("register artifact")
        {
            ArtifactRegistration::Staging(staging) => staging,
            ArtifactRegistration::Existing(_) | ArtifactRegistration::Pending(_) => {
                panic!("fresh artifact must stage")
            }
        };
        std::fs::write(staging.path(), bytes).expect("write staging bytes");
        let artifact_id = staging.record().id();
        let invalid_asset = MediaAsset::new(
            "download.mp4",
            "mp4",
            u64::try_from(bytes.len() + 1).expect("invalid size"),
            MediaKind::Video,
        )
        .expect("invalid asset fixture");

        assert!(matches!(
            database.commit_media_artifact(&invalid_asset, artifact_id, job.id(), true),
            Err(DatabaseError::InvalidArtifactFile)
        ));
        let record = database
            .get_artifact(artifact_id)
            .expect("artifact lookup")
            .expect("pending artifact");
        assert_eq!(record.state(), ArtifactState::Pending);
        let connection = rusqlite::Connection::open(database_path).expect("inspect transaction");
        let rows: i64 = connection
            .query_row(
                "SELECT
                   (SELECT count(*) FROM media_assets WHERE id = ?1) +
                   (SELECT count(*) FROM media_artifacts WHERE artifact_id = ?2)",
                params![invalid_asset.id().as_uuid(), artifact_id.as_uuid()],
                |row| row.get(0),
            )
            .expect("atomic rows");
        assert_eq!(rows, 0);
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "the deduplicated cleanup race must keep both job transitions and both ownership assertions visible"
    )]
    fn failed_deduplicated_job_cleanup_preserves_the_other_live_candidate() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let source_path = directory.path().join("download.mp4");
        let bytes = vec![0x6c; 48 * 1024];
        std::fs::write(&source_path, &bytes).expect("download fixture");
        let mut failed_job = JobSnapshot::new(JobKind::DownloadMedia);
        let mut live_job = JobSnapshot::new(JobKind::DownloadMedia);
        for job in [&mut failed_job, &mut live_job] {
            database.create_job(job).expect("create job");
            let sequence = job.sequence();
            job.start().expect("start job");
            database
                .compare_and_swap_job(sequence, job)
                .expect("persist running job");
        }
        let size = u64::try_from(bytes.len()).expect("fixture size");
        let failed_asset =
            MediaAsset::new("failed.mp4", "mp4", size, MediaKind::Video).expect("failed asset");
        let live_asset =
            MediaAsset::new("live.mp4", "mp4", size, MediaKind::Video).expect("live asset");
        let kind = ArtifactKind::new("downloadMedia").expect("artifact kind");
        let failed = publish_durable_media_candidate(
            &database,
            failed_job.id(),
            kind.clone(),
            failed_asset.clone(),
            &source_path,
            serde_json::json!({"source": "shared"}),
        )
        .expect("publish failed candidate");
        let live = publish_durable_media_candidate(
            &database,
            live_job.id(),
            kind,
            live_asset.clone(),
            &source_path,
            serde_json::json!({"source": "shared"}),
        )
        .expect("publish live candidate");
        assert_eq!(failed.artifact_id(), live.artifact_id());

        let failed_sequence = failed_job.sequence();
        failed_job.fail().expect("fail first job");
        database
            .compare_and_swap_job(failed_sequence, &failed_job)
            .expect("persist failed job");
        database
            .reconcile_artifacts()
            .expect("reconcile one failed owner");
        assert!(
            database
                .resolve_media(failed_asset.id())
                .expect("failed candidate lookup")
                .is_none()
        );
        assert!(
            database
                .resolve_media(live_asset.id())
                .expect("live candidate lookup")
                .is_some()
        );
        assert!(
            database
                .resolve_artifact(live.artifact_id())
                .expect("shared artifact lookup")
                .is_some()
        );

        let live_sequence = live_job.sequence();
        live_job.fail().expect("fail live job");
        database
            .compare_and_swap_job(live_sequence, &live_job)
            .expect("persist second failed job");
        database
            .reconcile_artifacts()
            .expect("reconcile all failed owners");
        assert!(
            database
                .resolve_media(live_asset.id())
                .expect("cleaned live candidate lookup")
                .is_none()
        );
        assert!(
            database
                .resolve_artifact(live.artifact_id())
                .expect("cleaned artifact lookup")
                .is_none()
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "the retry crash fixture verifies every shared edge, claim, cache key, and project revision across restart"
    )]
    fn failed_retry_keeps_shared_media_cache_and_claim_edges_across_a_crash() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("db/osg.sqlite3");
        let artifact_root = directory.path().join("artifacts");
        let source_path = directory.path().join("shared.mp4");
        let bytes = vec![0x79; 96 * 1024];
        std::fs::write(&source_path, &bytes).expect("source fixture");
        let size = u64::try_from(bytes.len()).expect("fixture size");
        let first_asset =
            MediaAsset::new("first.mp4", "mp4", size, MediaKind::Video).expect("first asset");
        let second_asset =
            MediaAsset::new("second.mp4", "mp4", size, MediaKind::Video).expect("second asset");
        let kind = ArtifactKind::new("sharedRetryMediaFixture").expect("kind");
        let metadata = serde_json::json!({"source": "shared-retry"});
        let project_id;
        let project_version;
        let artifact_id;
        let cache_key;
        let crash_job_id;
        {
            let database =
                super::super::Database::open_with_artifact_root(&database_path, &artifact_root)
                    .expect("database");
            let mut first_job = JobSnapshot::new(JobKind::DownloadMedia);
            let mut second_job = JobSnapshot::new(JobKind::DownloadMedia);
            database.create_job(&first_job).expect("first job");
            database.create_job(&second_job).expect("second job");
            let first = publish_durable_media_candidate(
                &database,
                first_job.id(),
                kind.clone(),
                first_asset.clone(),
                &source_path,
                metadata.clone(),
            )
            .expect("first publication");
            let second = publish_durable_media_candidate(
                &database,
                second_job.id(),
                kind.clone(),
                second_asset.clone(),
                &source_path,
                metadata.clone(),
            )
            .expect("second publication");
            artifact_id = first.artifact_id();
            assert_eq!(artifact_id, second.artifact_id());
            complete_queued_job(&database, &mut first_job);
            complete_queued_job(&database, &mut second_job);

            let project = ProjectMetadata::new("shared retry owner").expect("project");
            project_id = project.id();
            let base = database.create_project(&project).expect("create project");
            let snapshot = ProjectSnapshot::new(
                project,
                base.state_version(),
                vec![first_asset.clone()],
                Vec::new(),
            )
            .expect("project snapshot");
            project_version = database
                .commit_project(
                    &snapshot,
                    &RevisionReason::new("own shared retry media").expect("reason"),
                )
                .expect("commit project")
                .state_version;

            let category = CacheCategory::new("sharedRetryMedia").expect("category");
            cache_key = CacheKey::derive(&category, 1, &[b"shared-retry"]).expect("cache key");
            database
                .put_cache_entry(
                    &CacheWrite::new(cache_key, artifact_id, category, 1, None)
                        .expect("cache write"),
                )
                .expect("cache edge");

            make_test_file_writable(first.path());
            let mut corrupt = bytes.clone();
            let midpoint = corrupt.len() / 2;
            corrupt[midpoint] ^= 0xff;
            std::fs::write(first.path(), corrupt).expect("corrupt ready artifact");
            assert!(
                database
                    .resolve_artifact(artifact_id)
                    .expect("detect corruption")
                    .is_none()
            );
            assert_eq!(
                database
                    .get_artifact(artifact_id)
                    .expect("artifact lookup")
                    .expect("failed artifact")
                    .state(),
                ArtifactState::Failed
            );

            let crash_job = JobSnapshot::new(JobKind::DownloadMedia);
            database.create_job(&crash_job).expect("crash job");
            crash_job_id = crash_job.id();
            let crash_draft = ArtifactDraft::new(
                kind.clone(),
                ContentHash::digest(&bytes),
                size,
                serde_json::json!({
                    "source": "shared-retry",
                    "osgMediaArtifact": true,
                    "commitOnJobSuccess": true
                }),
            )
            .expect("crash retry draft")
            .with_job(crash_job.id());
            let crash_stage = match database
                .register_media_artifact(&crash_draft, second_asset.id(), crash_job.id())
                .expect("reserve crash retry")
            {
                ArtifactRegistration::Staging(staging) => staging,
                ArtifactRegistration::Existing(_) | ArtifactRegistration::Pending(_) => {
                    panic!("failed retry must acquire the preserved row")
                }
            };
            assert_eq!(crash_stage.record().id(), artifact_id);
            assert_eq!(crash_stage.record().state(), ArtifactState::Pending);
            // Simulate process death after the failed row was reset but before any bytes or a new
            // media claim were committed.  Startup must fail the reservation without deleting
            // the already durable project/media/cache ownership graph.
        }

        let database =
            super::super::Database::open_with_artifact_root(&database_path, &artifact_root)
                .expect("restart after retry crash");
        assert_eq!(
            database
                .get_artifact(artifact_id)
                .expect("artifact lookup after crash")
                .expect("preserved failed row")
                .state(),
            ArtifactState::Failed
        );
        let mut crash_job = database
            .get_job(crash_job_id)
            .expect("crash job lookup")
            .expect("crash job");
        assert_eq!(crash_job.state(), osg_domain::JobState::Queued);
        assert!(
            !database
                .discard_media_candidate(second_asset.id())
                .expect("transactional retry claim protects after restart")
        );
        let sequence = crash_job.sequence();
        crash_job.start().expect("start crash job");
        database
            .compare_and_swap_job(sequence, &crash_job)
            .expect("persist crash job running");
        let sequence = crash_job.sequence();
        crash_job.fail().expect("fail crash job");
        database
            .compare_and_swap_job(sequence, &crash_job)
            .expect("persist crash job failure");
        let connection = rusqlite::Connection::open(&database_path).expect("inspect edges");
        let (media_edges, cache_edges, old_claims): (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM media_artifacts WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM cache_entries WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM media_artifact_job_claims WHERE artifact_id = ?1)",
                [artifact_id.as_uuid()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("preserved ownership graph");
        assert_eq!((media_edges, cache_edges, old_claims), (2, 1, 3));
        drop(connection);

        let mut retry_job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&retry_job).expect("retry job");
        let retry = publish_durable_media_candidate(
            &database,
            retry_job.id(),
            kind,
            second_asset.clone(),
            &source_path,
            metadata,
        )
        .expect("retry publication");
        assert_eq!(retry.artifact_id(), artifact_id);
        assert_eq!(std::fs::read(retry.path()).expect("retry bytes"), bytes);
        complete_queued_job(&database, &mut retry_job);
        let connection = rusqlite::Connection::open(&database_path).expect("inspect retry graph");
        let (media_edges, cache_edges, claims): (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM media_artifacts WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM cache_entries WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM media_artifact_job_claims WHERE artifact_id = ?1)",
                [artifact_id.as_uuid()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("retry ownership graph");
        assert_eq!((media_edges, cache_edges, claims), (2, 1, 4));
        drop(connection);
        assert!(
            database
                .discard_media_candidate(second_asset.id())
                .expect("discard retry loser")
        );
        assert!(
            database
                .resolve_project_media_revision(project_id, project_version, first_asset.id())
                .expect("exact project resolve")
                .is_some()
        );
        assert_eq!(
            database
                .lookup_cache(cache_key)
                .expect("cache lookup")
                .expect("preserved cache artifact")
                .record()
                .id(),
            artifact_id
        );
        drop(database);

        let reopened =
            super::super::Database::open_with_artifact_root(&database_path, &artifact_root)
                .expect("final restart");
        let resolved = reopened
            .resolve_project_media_revision(project_id, project_version, first_asset.id())
            .expect("resolve project after restart")
            .expect("project media after restart");
        assert_eq!(
            std::fs::read(resolved.path()).expect("project bytes"),
            bytes
        );
        assert_eq!(
            reopened
                .lookup_cache(cache_key)
                .expect("cache after restart")
                .expect("cache artifact after restart")
                .record()
                .id(),
            artifact_id
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "the history safety scenario intentionally exercises promotion, detach, theft rejection, and undo end to end"
    )]
    fn project_promotion_owns_artifact_and_asset_across_detach_and_undo() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let source_path = directory.path().join("download.mp4");
        let bytes = vec![0x7b; 32 * 1024];
        std::fs::write(&source_path, &bytes).expect("download fixture");
        let job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&job).expect("download job");
        let asset = MediaAsset::new(
            "download.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        let published = publish_durable_media_candidate(
            &database,
            job.id(),
            ArtifactKind::new("downloadMedia").expect("artifact kind"),
            asset.clone(),
            &source_path,
            serde_json::json!({"source": "history"}),
        )
        .expect("publish candidate");

        let metadata = ProjectMetadata::new("Owner A").expect("project metadata");
        let base = database.create_project(&metadata).expect("create owner A");
        let attach = ProjectSnapshot::new(
            metadata.clone(),
            base.state_version(),
            vec![asset.clone()],
            Vec::new(),
        )
        .expect("attach snapshot");
        let attached = database
            .commit_project(
                &attach,
                &RevisionReason::new("attach candidate").expect("revision reason"),
            )
            .expect("attach candidate");
        assert!(
            database
                .resolve_project_media(asset.id())
                .expect("resolve attached media")
                .is_some()
        );
        assert!(
            database
                .resolve_project_media_revision(metadata.id(), attached.state_version, asset.id(),)
                .expect("resolve exact attached revision")
                .is_some()
        );
        assert!(
            database
                .resolve_project_media_revision(metadata.id(), base.state_version(), asset.id(),)
                .expect("reject stale project revision")
                .is_none()
        );
        assert!(
            !database
                .discard_media_candidate(asset.id())
                .expect("project candidate cannot discard")
        );

        let detach = ProjectSnapshot::new(
            metadata.clone(),
            attached.state_version,
            Vec::new(),
            Vec::new(),
        )
        .expect("detach snapshot");
        let detached = database
            .commit_project(
                &detach,
                &RevisionReason::new("detach media").expect("revision reason"),
            )
            .expect("detach media");
        assert!(
            database
                .resolve_project_media(asset.id())
                .expect("detached project lookup")
                .is_none()
        );
        assert!(
            !database
                .project_media_is_current(metadata.id(), attached.state_version, asset.id())
                .expect("detached asset is not current for the old revision")
        );
        assert!(
            database
                .resolve_artifact(published.artifact_id())
                .expect("artifact survives history detach")
                .is_some()
        );

        let other_metadata = ProjectMetadata::new("Owner B").expect("second project metadata");
        let other_base = database
            .create_project(&other_metadata)
            .expect("create owner B");
        let steal = ProjectSnapshot::new(
            other_metadata,
            other_base.state_version(),
            vec![asset.clone()],
            Vec::new(),
        )
        .expect("steal snapshot");
        assert!(matches!(
            database.commit_project(
                &steal,
                &RevisionReason::new("steal media").expect("revision reason")
            ),
            Err(DatabaseError::CrossProjectIdentifier { .. })
        ));

        let restored = database
            .undo_project(metadata.id(), detached.state_version)
            .expect("undo detach")
            .expect("history target");
        assert_eq!(restored.media(), std::slice::from_ref(&asset));
        assert!(
            database
                .resolve_project_media_revision(
                    metadata.id(),
                    restored.state_version(),
                    asset.id(),
                )
                .expect("resolve restored current revision")
                .is_some()
        );
        assert!(
            database
                .resolve_project_media(asset.id())
                .expect("resolve restored media")
                .is_some()
        );
        assert_eq!(
            database
                .resolve_artifact(published.artifact_id())
                .expect("resolve restored artifact")
                .expect("restored artifact")
                .record()
                .content_hash(),
            published.content_hash()
        );
    }

    #[test]
    fn project_commit_rejects_a_candidate_discarded_before_the_transaction() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let media_path = directory.path().join("discarded.mp4");
        std::fs::write(&media_path, b"discarded").expect("media fixture");
        let asset = MediaAsset::new("discarded.mp4", "mp4", 9, MediaKind::Video).expect("asset");
        database
            .remember_media_candidate(&asset, &media_path)
            .expect("stage candidate");
        assert!(
            database
                .discard_media_candidate(asset.id())
                .expect("discard candidate")
        );

        let metadata = ProjectMetadata::new("Discard race").expect("project metadata");
        let base = database.create_project(&metadata).expect("create project");
        let attempted = ProjectSnapshot::new(
            metadata.clone(),
            base.state_version(),
            vec![asset.clone()],
            Vec::new(),
        )
        .expect("candidate snapshot");
        assert!(matches!(
            database.commit_project(
                &attempted,
                &RevisionReason::new("attach discarded candidate").expect("revision reason")
            ),
            Err(DatabaseError::InvalidProjectSnapshot(_))
        ));

        let authoritative = database
            .load_project(metadata.id())
            .expect("load project")
            .expect("project exists");
        assert_eq!(authoritative.state_version(), base.state_version());
        assert!(authoritative.media().is_empty());
        assert!(
            database
                .resolve_media(asset.id())
                .expect("discarded candidate remains absent")
                .is_none()
        );
    }

    #[test]
    fn project_commit_atomically_promotes_candidates_and_detached_candidates_discard() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let detached_path = directory.path().join("detached.mp4");
        std::fs::write(&detached_path, b"detached").expect("detached fixture");
        let detached = MediaAsset::new("detached.mp4", "mp4", 8, MediaKind::Video).expect("asset");
        database
            .remember_media_candidate(&detached, &detached_path)
            .expect("detached candidate");
        assert!(matches!(
            database.promote_media_candidate(detached.id()),
            Err(DatabaseError::InvalidMediaLocation)
        ));
        assert!(
            database
                .discard_media_candidate(detached.id())
                .expect("discard detached candidate")
        );
        assert!(
            database
                .resolve_media(detached.id())
                .expect("resolve discarded candidate")
                .is_none()
        );

        let attached_path = directory.path().join("attached.mp4");
        std::fs::write(&attached_path, b"attached").expect("attached fixture");
        let attached = MediaAsset::new("attached.mp4", "mp4", 8, MediaKind::Video).expect("asset");
        database
            .remember_media_candidate(&attached, &attached_path)
            .expect("attached candidate");
        rusqlite::Connection::open(&database_path)
            .expect("inspect candidate metadata")
            .execute(
                "UPDATE media_assets SET metadata_json = ?1 WHERE id = ?2",
                params![
                    r#"{"futureField":7,"osgMediaLifecycle":"candidate"}"#,
                    attached.id().as_uuid()
                ],
            )
            .expect("add forward-compatible candidate metadata");
        let metadata = ProjectMetadata::new("Candidate owner").expect("project metadata");
        let base = database.create_project(&metadata).expect("create project");
        let candidate_snapshot = ProjectSnapshot::new(
            metadata,
            base.state_version(),
            vec![attached.clone()],
            Vec::new(),
        )
        .expect("candidate project snapshot");
        database
            .commit_project(
                &candidate_snapshot,
                &RevisionReason::new("Attach selected media").expect("revision reason"),
            )
            .expect("attach candidate");
        drop(database);
        let database =
            super::super::Database::open(&database_path).expect("reopen after project commit");

        assert!(
            !database
                .discard_media_candidate(attached.id())
                .expect("referenced candidate is protected")
        );
        assert!(
            !database
                .promote_media_candidate(attached.id())
                .expect("explicit promotion is an idempotent compatibility check")
        );
        let promoted_metadata: String = rusqlite::Connection::open(&database_path)
            .expect("inspect promoted metadata")
            .query_row(
                "SELECT metadata_json FROM media_assets WHERE id = ?1",
                [attached.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("promoted metadata");
        let promoted_metadata: Value =
            serde_json::from_str(&promoted_metadata).expect("valid promoted metadata");
        assert_eq!(promoted_metadata["osgMediaLifecycle"], "project");
        assert_eq!(promoted_metadata["futureField"], 7);
        assert!(
            !database
                .discard_media_candidate(attached.id())
                .expect("promoted media is never candidate garbage")
        );
        assert!(
            database
                .resolve_project_media(attached.id())
                .expect("resolve promoted media")
                .is_some()
        );
    }

    #[test]
    fn native_path_encoding_is_lossless() {
        let path = std::env::current_dir()
            .expect("current directory")
            .join("unicode-한글-media.mp4");
        let encoded = encode_path(&path).expect("encoded path");
        assert_eq!(
            decode_path(&encoded, path_encoding()).as_deref(),
            Some(path.as_path())
        );
        assert!(decode_path(&encoded, "wrong-encoding").is_none());
    }

    #[test]
    fn durable_location_uses_an_immutable_snapshot_even_when_source_mtime_is_restored() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let path = directory.path().join("selected.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let source_mtime = std::fs::metadata(&path)
            .expect("source metadata")
            .modified()
            .expect("source mtime");
        let asset = MediaAsset::new("selected.mp4", "mp4", 5, MediaKind::Video).expect("asset");

        database.remember_media(&asset, &path).expect("remember");
        let stored_hash: Vec<u8> = rusqlite::Connection::open(&database_path)
            .expect("inspect database")
            .query_row(
                "SELECT content_hash FROM media_assets WHERE id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("stored media hash");
        assert_eq!(stored_hash, ContentHash::digest(b"media").as_bytes());
        let snapshot_path = database
            .resolve_media(asset.id())
            .expect("resolve")
            .expect("managed snapshot")
            .path()
            .to_owned();
        assert_ne!(
            snapshot_path,
            std::fs::canonicalize(&path).expect("canonical source")
        );
        assert_eq!(
            std::fs::read(&snapshot_path).expect("snapshot bytes"),
            b"media"
        );

        let mismatch = MediaAsset::with_id(asset.id(), "different.mp4", "mp4", 5, MediaKind::Video)
            .expect("mismatch asset");
        assert!(matches!(
            database.remember_media(&mismatch, &path),
            Err(super::super::DatabaseError::MediaAssetMismatch(id)) if id == asset.id()
        ));

        std::fs::write(&path, b"other").expect("replace with same-size content");
        filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(source_mtime))
            .expect("restore source mtime");
        assert_eq!(
            database
                .resolve_media(asset.id())
                .expect("resolve changed source")
                .expect("immutable snapshot")
                .path(),
            snapshot_path
        );
        assert!(matches!(
            database.remember_media(&asset, &path),
            Err(DatabaseError::MediaAssetMismatch(id)) if id == asset.id()
        ));

        std::fs::write(&path, b"media").expect("restore original content");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve restored content")
                .is_some()
        );
    }

    #[test]
    fn legacy_media_without_a_content_hash_fails_closed_until_reselected() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let path = directory.path().join("legacy.mp4");
        std::fs::write(&path, b"legacy").expect("fixture");
        let asset = MediaAsset::new("legacy.mp4", "mp4", 6, MediaKind::Video).expect("asset");
        database.remember_media(&asset, &path).expect("remember");

        let connection = rusqlite::Connection::open(&database_path).expect("inspect database");
        connection
            .execute(
                "UPDATE media_assets SET content_hash = NULL WHERE id = ?1",
                params![asset.id().as_uuid()],
            )
            .expect("simulate legacy null hash");
        drop(connection);

        assert!(
            database
                .resolve_media(asset.id())
                .expect("legacy resolve")
                .is_none()
        );
        database
            .remember_media(&asset, &path)
            .expect("explicit reselection fills hash");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("reselected resolve")
                .is_some()
        );
    }

    #[test]
    fn bounded_media_digest_rejects_growth_and_shrinkage() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("bounded.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical fixture");

        let verified = digest_media_file(&canonical, 5).expect("exact digest");
        assert_eq!(verified.content_hash, ContentHash::digest(b"media"));
        assert!(matches!(
            digest_media_file(&canonical, 4),
            Err(DatabaseError::InvalidMediaLocation)
        ));
        assert!(matches!(
            digest_media_file(&canonical, 6),
            Err(DatabaseError::InvalidMediaLocation)
        ));
    }

    #[test]
    fn bounded_media_digest_rejects_a_path_replaced_after_the_handle_was_hashed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("selected.mp4");
        let displaced = directory.path().join("displaced.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical fixture");

        let result = digest_media_file_with_post_hash(&canonical, 5, || {
            std::fs::rename(&canonical, &displaced).expect("displace opened file");
            std::fs::write(&canonical, b"media").expect("same-size replacement");
        });

        assert!(matches!(result, Err(DatabaseError::InvalidMediaLocation)));
    }

    #[test]
    #[cfg(unix)]
    fn unix_snapshot_rejects_same_length_post_copy_mutation_with_restored_mtime() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("mutable.mp4");
        std::fs::write(&path, b"before").expect("source fixture");
        let modified = std::fs::metadata(&path)
            .expect("source metadata")
            .modified()
            .expect("source mtime");
        let result = snapshot_media_file_with_post_copy(&path, 6, || {
            std::fs::write(&path, b"after!").expect("same-length hostile mutation");
            filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(modified))
                .expect("restore original mtime");
        });

        assert!(matches!(result, Err(DatabaseError::InvalidArtifactFile)));
    }

    #[test]
    fn registered_handle_revalidation_rejects_same_size_in_place_mutation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("mutable.mp4");
        std::fs::write(&path, b"before").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical fixture");
        // Use a normally shared handle to model a hostile writer which was already open before
        // registration.  Production Windows opens additionally deny later write sharing.
        let file = std::fs::File::open(&canonical).expect("open shared fixture");
        let asset = MediaAsset::new("mutable.mp4", "mp4", 6, MediaKind::Video).expect("asset");
        let resolved =
            super::ResolvedMedia::new(asset, canonical, file, ContentHash::digest(b"before"));

        std::fs::write(&path, b"after!").expect("same-size mutation");

        assert!(matches!(
            resolved.revalidate_verified_file(),
            Err(DatabaseError::InvalidMediaLocation)
        ));
    }

    #[test]
    fn repeated_native_selections_reuse_one_owned_snapshot_location() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");

        for index in 0..super::MAX_MEDIA_LOCATION_CANDIDATES {
            let path = directory.path().join(format!("clip-{index}.mp4"));
            std::fs::write(&path, b"media").expect("media fixture");
            database
                .remember_media(&asset, &path)
                .expect("bounded location");
        }
        let overflow = directory.path().join("clip-overflow.mp4");
        std::fs::write(&overflow, b"media").expect("overflow fixture");
        database
            .remember_media(&asset, &overflow)
            .expect("newest location compacts the oldest");
        let retained: i64 = rusqlite::Connection::open(&database_path)
            .expect("inspect compacted locations")
            .query_row(
                "SELECT count(*) FROM media_locations WHERE media_id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("retained count");
        assert_eq!(retained, 1);
        assert!(
            database
                .resolve_media(asset.id())
                .expect("bounded resolve")
                .is_some()
        );
    }

    #[test]
    fn null_hash_legacy_overflow_can_be_reselected_and_keeps_the_selected_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let selected = directory.path().join("selected.mp4");
        std::fs::write(&selected, b"media").expect("selected fixture");
        let selected = std::fs::canonicalize(selected).expect("canonical selected fixture");
        let selected_bytes = encode_path(&selected).expect("encoded selected path");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
        database
            .remember_media(&asset, &selected)
            .expect("initial selection");

        let mut connection = rusqlite::Connection::open(&database_path).expect("seed legacy rows");
        let transaction = connection.transaction().expect("legacy transaction");
        transaction
            .execute(
                "UPDATE media_assets SET content_hash = NULL WHERE id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("legacy null hash");
        let hostile_timestamp = i64::MAX - 1;
        for index in 0..super::MAX_MEDIA_LOCATION_CANDIDATES {
            let legacy_path = directory.path().join(format!("legacy-{index}.mp4"));
            std::fs::write(&legacy_path, b"media").expect("legacy fixture");
            let legacy_path = std::fs::canonicalize(legacy_path).expect("canonical legacy fixture");
            transaction
                .execute(
                    "INSERT INTO media_locations(
                       id, media_id, path_bytes, path_encoding, platform, available,
                       last_verified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                    params![
                        Uuid::now_v7(),
                        asset.id().as_uuid(),
                        encode_path(&legacy_path).expect("encoded legacy path"),
                        path_encoding(),
                        platform_name(),
                        hostile_timestamp,
                    ],
                )
                .expect("overflow legacy location");
        }
        transaction.commit().expect("legacy overflow");

        database
            .remember_media(&asset, &selected)
            .expect("explicit reselection repairs null hash and overflow");
        let (retained, selected_retained, hash): (i64, i64, Vec<u8>) = connection
            .query_row(
                "SELECT
                   (SELECT count(*) FROM media_locations WHERE media_id = ?1),
                   (SELECT count(*) FROM media_locations
                    WHERE media_id = ?1 AND path_bytes = ?2 AND path_encoding = ?3),
                   content_hash
                 FROM media_assets WHERE id = ?1",
                params![asset.id().as_uuid(), selected_bytes, path_encoding()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("repaired legacy state");
        assert_eq!(
            retained,
            i64::try_from(super::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
        );
        assert_eq!(selected_retained, 0);
        assert_eq!(hash, ContentHash::digest(b"media").as_bytes());
        let resolved = database
            .resolve_media(asset.id())
            .expect("resolve repaired asset")
            .expect("repaired media");
        assert_eq!(
            std::fs::read(resolved.path()).expect("resolved repaired bytes"),
            b"media"
        );
    }

    #[test]
    fn oversized_legacy_location_sets_recover_a_valid_tail_and_compact_to_the_cap() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let valid_path = directory.path().join("valid.mp4");
        std::fs::write(&valid_path, b"media").expect("valid fixture");
        let valid_path = std::fs::canonicalize(valid_path).expect("canonical valid fixture");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
        database
            .remember_media(&asset, &valid_path)
            .expect("remember valid tail");

        let mut connection = rusqlite::Connection::open(&database_path).expect("seed legacy rows");
        let transaction = connection.transaction().expect("legacy transaction");
        transaction
            .execute(
                "UPDATE media_locations
                 SET available = 0, last_verified_at_ms = 1
                 WHERE media_id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("demote valid legacy tail");
        for index in 0..super::MAX_MEDIA_LOCATION_CANDIDATES {
            let invalid_path = directory.path().join(format!("invalid-{index}.mp4"));
            std::fs::write(&invalid_path, b"other").expect("invalid fixture");
            let invalid_path =
                std::fs::canonicalize(invalid_path).expect("canonical invalid fixture");
            transaction
                .execute(
                    "INSERT INTO media_locations(
                       id, media_id, path_bytes, path_encoding, platform, available,
                       last_verified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 2)",
                    params![
                        Uuid::now_v7(),
                        asset.id().as_uuid(),
                        encode_path(&invalid_path).expect("encoded invalid path"),
                        path_encoding(),
                        platform_name(),
                    ],
                )
                .expect("legacy overflow location");
        }
        transaction.commit().expect("legacy rows");

        let resolved = database
            .resolve_media(asset.id())
            .expect("recover overflow")
            .expect("valid tail");
        assert_ne!(resolved.path(), valid_path);
        assert_eq!(
            std::fs::read(resolved.path()).expect("owned snapshot bytes"),
            b"media"
        );
        let retained: i64 = connection
            .query_row(
                "SELECT count(*) FROM media_locations WHERE media_id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("retained locations");
        assert_eq!(
            retained,
            i64::try_from(super::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
        );
    }

    #[test]
    fn available_location_precedes_a_newer_unavailable_same_size_candidate() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let good_path = directory.path().join("good.mp4");
        let bad_path = directory.path().join("bad.mp4");
        std::fs::write(&good_path, b"media").expect("good fixture");
        std::fs::write(&bad_path, b"other").expect("same-size bad fixture");
        let good_path = std::fs::canonicalize(good_path).expect("canonical good fixture");
        let bad_path = std::fs::canonicalize(bad_path).expect("canonical bad fixture");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
        database
            .remember_media(&asset, &good_path)
            .expect("remember good media");

        let connection = rusqlite::Connection::open(&database_path).expect("seed bad location");
        connection
            .execute(
                "INSERT INTO media_locations(
                   id, media_id, path_bytes, path_encoding, platform, available,
                   last_verified_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
                params![
                    Uuid::now_v7(),
                    asset.id().as_uuid(),
                    encode_path(&bad_path).expect("encoded bad path"),
                    path_encoding(),
                    platform_name(),
                    i64::MAX - 1,
                ],
            )
            .expect("newest unavailable location");

        let artifact_root = super::ArtifactRoot::prepare(&directory.path().join("artifacts"))
            .expect("artifact root");
        let plan = super::resolution_plan(&connection, &artifact_root, asset.id(), false, None)
            .expect("resolution plan")
            .expect("known media");
        assert_eq!(plan.candidates.len(), 3);
        assert!(plan.candidates[0].managed_snapshot);
        assert_eq!(plan.candidates[2].path.as_deref(), Some(bad_path.as_path()));
        let first = database
            .resolve_media(asset.id())
            .expect("first resolution")
            .expect("available media");
        assert_ne!(first.path(), good_path);
        assert_ne!(first.path(), bad_path);
        assert_eq!(
            std::fs::read(first.path()).expect("snapshot bytes"),
            b"media"
        );
        let snapshot_path = first.path().to_owned();
        assert_eq!(
            database
                .resolve_media(asset.id())
                .expect("repeat resolution")
                .expect("available media")
                .path(),
            snapshot_path
        );
    }

    #[test]
    fn durable_media_publication_retains_extensions_as_metadata_and_reuses_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = super::super::Database::open_with_artifact_root(
            directory.path().join("db/osg.sqlite3"),
            directory.path().join("artifacts"),
        )
        .expect("database");
        let job_id = JobId::new();
        database
            .create_job(&JobSnapshot::with_id(job_id, JobKind::RenderVideo))
            .expect("job");
        let source = directory.path().join("clip.mp4");
        std::fs::write(&source, b"durable clip bytes").expect("source");
        let first_asset =
            MediaAsset::new("clip.mp4", "mp4", 18, MediaKind::Video).expect("first asset");
        let first = publish_durable_media(
            &database,
            job_id,
            ArtifactKind::new("analysisClipTest").expect("kind"),
            first_asset.clone(),
            &source,
            serde_json::json!({"purpose": "geminiSegment"}),
        )
        .expect("first publication");
        assert!(first.path().extension().is_none());
        assert_eq!(first.asset(), &first_asset);
        assert!(!format!("{first:?}").contains(directory.path().to_string_lossy().as_ref()));

        let second_asset =
            MediaAsset::new("clip.mp4", "mp4", 18, MediaKind::Video).expect("second opaque asset");
        let second = publish_durable_media(
            &database,
            job_id,
            ArtifactKind::new("analysisClipTest").expect("kind"),
            second_asset.clone(),
            &source,
            serde_json::json!({"purpose": "geminiSegment"}),
        )
        .expect("deduplicated publication");
        assert_ne!(first_asset.id(), second_asset.id());
        assert_eq!(first.artifact_id(), second.artifact_id());
        assert_eq!(first.path(), second.path());

        std::fs::remove_file(&source).expect("remove transient source");
        database.clear_all_cache().expect("clear derived cache");
        for asset in [first_asset, second_asset] {
            let resolved = database
                .resolve_media(asset.id())
                .expect("resolve")
                .expect("durable media");
            assert_eq!(resolved.asset(), &asset);
            assert_eq!(
                std::fs::read(resolved.path()).expect("durable bytes"),
                b"durable clip bytes"
            );
        }
    }

    #[test]
    fn concurrent_same_content_media_publications_share_one_ready_artifact() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = super::super::Database::open_with_artifact_root(
            directory.path().join("db/osg.sqlite3"),
            directory.path().join("artifacts"),
        )
        .expect("database");
        let job_id = JobId::new();
        database
            .create_job(&JobSnapshot::with_id(job_id, JobKind::DownloadMedia))
            .expect("job");
        let source = directory.path().join("shared.mp4");
        let bytes = vec![0x5d; 2 * 1024 * 1024];
        std::fs::write(&source, &bytes).expect("source");
        let size = u64::try_from(bytes.len()).expect("fixture size");
        let assets = [
            MediaAsset::new("first.mp4", "mp4", size, MediaKind::Video).expect("first asset"),
            MediaAsset::new("second.mp4", "mp4", size, MediaKind::Video).expect("second asset"),
        ];

        let publication_guard = super::MEDIA_PUBLICATION_LOCK
            .lock()
            .expect("publication lock");
        let (started, waiting) = std::sync::mpsc::sync_channel(2);
        let mut workers = Vec::new();
        for asset in assets.clone() {
            let database = database.clone();
            let source = source.clone();
            let started = started.clone();
            workers.push(std::thread::spawn(move || {
                started.send(()).expect("announce publisher");
                publish_durable_media(
                    &database,
                    job_id,
                    ArtifactKind::new("concurrentMedia").expect("kind"),
                    asset,
                    &source,
                    serde_json::json!({"fixture": "concurrent"}),
                )
            }));
        }
        waiting.recv().expect("first publisher waiting");
        waiting.recv().expect("second publisher waiting");
        drop(publication_guard);

        let first = workers
            .remove(0)
            .join()
            .expect("first thread")
            .expect("first publication");
        let second = workers
            .remove(0)
            .join()
            .expect("second thread")
            .expect("second publication");
        assert_eq!(first.artifact_id(), second.artifact_id());
        assert_eq!(
            database
                .get_artifact(first.artifact_id())
                .expect("artifact lookup")
                .expect("artifact exists")
                .state(),
            ArtifactState::Ready
        );
        for asset in assets {
            assert!(
                database
                    .resolve_media(asset.id())
                    .expect("resolve media")
                    .is_some()
            );
        }
    }
}
