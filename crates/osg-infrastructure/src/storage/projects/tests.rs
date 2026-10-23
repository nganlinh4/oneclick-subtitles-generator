use std::path::{Path, PathBuf};

use osg_application::{ProjectRepository, ProjectSnapshot};
use osg_domain::{
    MediaAsset, MediaKind, ProjectMetadata, RevisionId, RevisionReason, SubtitleCue, SubtitleTrack,
    TrackOrigin,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;
use uuid::Uuid;

use super::super::migrations::migrations;
use super::{
    DatabaseError, MAX_CURRENT_REVISIONS, MAX_PROJECT_CREATE_KEY_UTF16_UNITS, MAX_REDO_REVISIONS,
    MAX_REDO_STACK_JSON_BYTES, create_project_in_transaction, encode_snapshot, insert_revision,
    push_bounded, update_project_row, write_navigation, write_normalized, write_project_state,
};
use crate::storage::Database;

mod commits;
mod history;
mod integrity;

const EXPECTED_RETAINED_REVISIONS: i64 = 256;

fn database() -> (TempDir, PathBuf, Database) {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("db/osg.sqlite3");
    let database = Database::open(&path).expect("open database");
    (directory, path, database)
}

fn reason(value: &str) -> RevisionReason {
    RevisionReason::new(value).expect("valid revision reason")
}

fn media() -> MediaAsset {
    MediaAsset::new("movie.mp4", "mp4", 4_096, MediaKind::Video).expect("valid media")
}

fn stage_media(directory: &TempDir, database: &Database, asset: &MediaAsset) {
    let path = directory
        .path()
        .join(format!("{}.{}", asset.id().as_uuid(), asset.extension()));
    std::fs::File::create(&path)
        .expect("create media fixture")
        .set_len(asset.size_bytes())
        .expect("size media fixture");
    database
        .remember_media_candidate(asset, &path)
        .expect("stage media fixture");
}

fn track(label: &str, text: &str) -> SubtitleTrack {
    SubtitleTrack::new(
        label,
        TrackOrigin::Srt,
        vec![SubtitleCue::new(0, 1_000, text.to_owned()).expect("valid cue")],
    )
    .expect("valid track")
}

fn edit(
    base: &ProjectSnapshot,
    title: &str,
    media: Vec<MediaAsset>,
    tracks: Vec<SubtitleTrack>,
) -> ProjectSnapshot {
    ProjectSnapshot::new(
        ProjectMetadata::with_id(base.metadata().id(), title).expect("valid metadata"),
        base.state_version(),
        media,
        tracks,
    )
    .expect("valid snapshot")
}

fn revision_count(path: &Path, project_id: osg_domain::ProjectId) -> i64 {
    Connection::open(path)
        .expect("open database directly")
        .query_row(
            "SELECT count(*) FROM project_revisions WHERE project_id = ?1",
            [project_id.as_uuid()],
            |row| row.get(0),
        )
        .expect("count project revisions")
}

fn commit_numbered_revision(
    database: &Database,
    current: &ProjectSnapshot,
    index: usize,
) -> ProjectSnapshot {
    let title = format!("Revision {index}");
    let edited = edit(current, &title, Vec::new(), Vec::new());
    let commit = database
        .commit_project(&edited, &reason(&title))
        .expect("commit numbered revision");
    edited
        .with_state_version(commit.state_version)
        .expect("apply committed version")
}

#[allow(
    clippy::too_many_lines,
    reason = "exact legacy v3 schema and graph fixture"
)]
fn seed_v3_unbounded_graph(
    path: &Path,
    metadata: &ProjectMetadata,
) -> (ProjectSnapshot, Vec<RevisionId>) {
    std::fs::create_dir_all(path.parent().expect("database parent"))
        .expect("create v3 database parent");
    let mut connection = Connection::open(path).expect("open v3 fixture");
    migrations()
        .to_version(&mut connection, 3)
        .expect("apply migrations one through three only");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("enable foreign keys");
    let schema_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read v3 schema marker");
    assert_eq!(schema_version, 3);
    let v3_objects: Vec<String> = connection
        .prepare(
            "SELECT name FROM sqlite_schema
                 WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
        )
        .expect("inspect v3 schema")
        .query_map([], |row| row.get(0))
        .expect("query v3 schema")
        .collect::<Result<_, _>>()
        .expect("collect v3 schema");
    assert!(
        v3_objects
            .iter()
            .any(|name| name == "jobs_state_updated_idx")
    );
    for post_v3 in [
        "editor_track_revisions",
        "media_artifacts",
        "job_result_deliveries",
        "project_create_receipts",
    ] {
        assert!(!v3_objects.iter().any(|name| name == post_v3));
    }

    let transaction = connection
        .transaction()
        .expect("start v3 fixture transaction");
    let mut current =
        create_project_in_transaction(&transaction, metadata).expect("create genuine v3 project");
    let mut parent_uuid: Uuid = transaction
        .query_row(
            "SELECT current_revision_id FROM revision_navigation WHERE project_id = ?1",
            [metadata.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("read v3 root revision");
    let mut parent = RevisionId::from_uuid(parent_uuid).expect("valid v3 root revision");
    for index in 1..=(MAX_CURRENT_REVISIONS + 32) {
        let version = u64::try_from(index).expect("fixture version");
        let title = format!("Revision {index}");
        let snapshot = ProjectSnapshot::new(
            ProjectMetadata::with_id(metadata.id(), &title).expect("valid v3 metadata"),
            version,
            Vec::new(),
            Vec::new(),
        )
        .expect("valid v3 snapshot");
        let encoded = encode_snapshot(&snapshot).expect("encode v3 snapshot");
        let revision = RevisionId::new();
        update_project_row(&transaction, &snapshot, version - 1).expect("advance v3 project row");
        write_normalized(&transaction, &snapshot).expect("write v3 normalized state");
        insert_revision(
            &transaction,
            revision,
            metadata.id(),
            Some(parent),
            &title,
            version,
            &encoded,
            i64::try_from(index).expect("v3 timestamp"),
        )
        .expect("insert v3 revision");
        write_navigation(&transaction, metadata.id(), revision, &[], 1)
            .expect("advance v3 navigation");
        write_project_state(&transaction, &snapshot, revision, 1)
            .expect("advance v3 project state");
        parent = revision;
        parent_uuid = revision.into_uuid();
        current = snapshot;
    }

    let mut detached = Vec::new();
    let mut branch_parent =
        Some(RevisionId::from_uuid(parent_uuid).expect("valid v3 current revision"));
    for offset in 1..=2 {
        let version = current.state_version() + offset;
        let snapshot = ProjectSnapshot::new(metadata.clone(), version, Vec::new(), Vec::new())
            .expect("valid detached snapshot");
        let encoded = encode_snapshot(&snapshot).expect("encode detached snapshot");
        let revision = RevisionId::new();
        insert_revision(
            &transaction,
            revision,
            metadata.id(),
            branch_parent,
            "Detached branch",
            version,
            &encoded,
            i64::try_from(version).expect("SQLite version"),
        )
        .expect("insert detached branch");
        detached.push(revision);
        branch_parent = Some(revision);
    }
    transaction.commit().expect("commit genuine v3 graph");
    (current, detached)
}
