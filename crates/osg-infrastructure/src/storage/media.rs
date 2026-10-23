use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use osg_domain::{AssetId, MediaAsset, MediaKind};
use serde_json::Value;
use uuid::Uuid;

use super::DatabaseError;
use super::artifacts::{ArtifactId, ArtifactKind, ContentHash};
use files::digest_media_handle;

mod files;
mod lifecycle;
mod publish;
mod resolution;

pub(super) use files::digest_media_file;
pub(super) use lifecycle::{
    artifact_has_persistent_owner, cleanup_expired_candidates, cleanup_failed_artifact_candidates,
    commit_media_artifact, discard_candidate_in_transaction, promote_candidate,
    promote_project_candidates,
};
pub(super) use publish::publish_native_media_snapshot;
pub use publish::{publish_durable_media, publish_durable_media_candidate};
pub(super) use resolution::{mark_location, project_media_is_current, resolution_plan};

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

#[cfg(test)]
mod tests;
