use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use osg_domain::{AssetId, JobId, JobKind, JobSnapshot, ProjectMetadata};
use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

use super::root::{final_name, remove_if_regular, staging_name, trash_name};
use super::rows::{ensure_artifact_capacity, ensure_cache_capacity, ensure_cache_lease_capacity};
use super::{
    ArtifactDraft, ArtifactFailureCode, ArtifactKind, ArtifactRecord, ArtifactRegistration,
    ArtifactRoot, ArtifactStaging, ArtifactState, CacheCategory, CacheKey, CacheWrite, ContentHash,
    MAX_ARTIFACT_SIZE_BYTES, MAX_CACHE_KEY_PARTS, remove_transactional,
};
use crate::storage::{Database, DatabaseError};

mod cache;
mod lifecycle;
mod reconcile;

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
        ArtifactRegistration::Pending(record) => {
            panic!("expected new staging reservation, got pending {record:?}")
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
        ensure_artifact_capacity(i64::try_from(super::MAX_ARTIFACTS - 1).expect("artifact count"))
            .is_ok()
    );
    assert!(matches!(
        ensure_artifact_capacity(i64::try_from(super::MAX_ARTIFACTS).expect("artifact count")),
        Err(DatabaseError::ArtifactLimitReached)
    ));
    assert!(
        ensure_cache_capacity(i64::try_from(super::MAX_CACHE_ENTRIES - 1).expect("cache count"))
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
        ensure_cache_lease_capacity(i64::try_from(super::MAX_CACHE_LEASES).expect("lease count")),
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
