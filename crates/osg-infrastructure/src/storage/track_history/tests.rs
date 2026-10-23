use std::path::PathBuf;

use osg_application::{ProjectSnapshot, ProjectTrackSelector};
use osg_domain::{
    MediaAsset, MediaKind, ProjectMetadata, RevisionReason, SubtitleCue, SubtitleTrack, TrackOrigin,
};
use rusqlite::Connection;
use tempfile::TempDir;

use super::{MAX_TRACK_REDO_JSON_BYTES, MAX_TRACK_REVISIONS};
use crate::storage::{Database, DatabaseError};

fn database() -> (TempDir, PathBuf, Database) {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("db/osg.sqlite3");
    let database = Database::open(&path).expect("open database");
    (directory, path, database)
}

fn selector() -> ProjectTrackSelector {
    ProjectTrackSelector::new("Cached subtitles", TrackOrigin::LegacyJson).expect("valid selector")
}

fn reason(value: &str) -> RevisionReason {
    RevisionReason::new(value).expect("valid reason")
}

fn track(text: &str) -> SubtitleTrack {
    SubtitleTrack::new(
        "Cached subtitles",
        TrackOrigin::LegacyJson,
        vec![SubtitleCue::new(0, 1_000, text.to_owned()).expect("valid cue")],
    )
    .expect("valid track")
}

fn revise(base: &SubtitleTrack, text: &str) -> SubtitleTrack {
    let cue = &base.cues()[0];
    SubtitleTrack::restore(
        base.id(),
        base.label(),
        base.origin(),
        vec![
            SubtitleCue::restore(
                cue.id(),
                1,
                cue.start_ms(),
                cue.end_ms(),
                text.to_owned(),
                cue.source_id(),
            )
            .expect("valid revised cue"),
        ],
    )
    .expect("valid revised track")
}

fn snapshot_with(
    base: &ProjectSnapshot,
    media: Vec<MediaAsset>,
    track: &SubtitleTrack,
) -> ProjectSnapshot {
    ProjectSnapshot::new(
        base.metadata().clone(),
        base.state_version(),
        media,
        vec![track.clone()],
    )
    .expect("valid snapshot")
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

fn seeded(database: &Database) -> (ProjectMetadata, SubtitleTrack, ProjectSnapshot) {
    let metadata = ProjectMetadata::new("Editor history").expect("valid project");
    let created = database.create_project(&metadata).expect("create project");
    let initial_track = track("A");
    let seeded = snapshot_with(&created, Vec::new(), &initial_track);
    database
        .commit_project(&seeded, &reason("Initial subtitles"))
        .expect("seed subtitles");
    let loaded = database
        .load_project(metadata.id())
        .expect("load project")
        .expect("project exists");
    (metadata, initial_track, loaded)
}

#[test]
fn track_undo_crosses_unrelated_revisions_without_reverting_media() {
    let (directory, _path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let edited = revise(&initial, "B");
    let committed = database
        .commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&edited),
            &reason("Editor text"),
        )
        .expect("commit editor track");
    assert_eq!(committed.status.history_version, 1);

    let media = MediaAsset::new("movie.mp4", "mp4", 4_096, MediaKind::Video).expect("valid media");
    stage_media(&directory, &database, &media);
    let with_media = snapshot_with(&committed.snapshot, vec![media.clone()], &edited);
    database
        .commit_project(&with_media, &reason("Attach media"))
        .expect("commit unrelated media");

    let undone = database
        .undo_project_track(metadata.id(), &selector(), 1, &reason("Editor text"))
        .expect("undo editor track")
        .expect("undo target");
    assert_eq!(undone.snapshot.media(), &[media]);
    assert_eq!(undone.snapshot.tracks()[0], initial);
    assert_eq!(undone.status.history_version, 2);
    assert!(undone.status.can_redo);
}

#[test]
fn restart_preserves_track_cursor_and_guarded_navigation() {
    let (_directory, path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let edited = revise(&initial, "B");
    database
        .commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&edited),
            &reason("Editor text"),
        )
        .expect("commit editor track");
    drop(database);

    let reopened = Database::open(path).expect("reopen database");
    let status = reopened
        .project_track_history_status(metadata.id(), &selector())
        .expect("load cursor");
    assert_eq!(status.history_version, 1);
    assert_eq!(status.undo_reason, Some(reason("Editor text")));
    assert!(
        reopened
            .undo_project_track(
                metadata.id(),
                &selector(),
                status.history_version,
                &reason("Wrong reason"),
            )
            .expect("guard mismatch is safe")
            .is_none()
    );
    assert_eq!(
        reopened
            .project_track_history_status(metadata.id(), &selector())
            .expect("unchanged cursor")
            .history_version,
        1
    );
}

#[test]
fn stale_writer_cannot_overwrite_a_newer_track_revision() {
    let (_directory, _path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let second = revise(&initial, "B");
    let third = revise(&initial, "C");
    database
        .commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&second),
            &reason("First writer"),
        )
        .expect("first writer commits");
    assert!(matches!(
        database.commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&third),
            &reason("Stale writer"),
        ),
        Err(DatabaseError::StaleProjectTrackHistory {
            expected: 0,
            actual: 1,
            ..
        })
    ));
    let loaded = database
        .load_project(metadata.id())
        .expect("load project")
        .expect("project exists");
    assert_eq!(loaded.tracks()[0], second);
}

#[test]
fn branch_after_undo_clears_only_track_redo_and_preserves_latest_media() {
    let (directory, path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let second = revise(&initial, "B");
    let third = revise(&initial, "C");
    let branch = revise(&initial, "D");
    database
        .commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&second),
            &reason("B"),
        )
        .expect("commit B");
    database
        .commit_project_track(
            metadata.id(),
            &selector(),
            1,
            Some(&second),
            Some(&third),
            &reason("C"),
        )
        .expect("commit C");
    database
        .undo_project_track(metadata.id(), &selector(), 2, &reason("C"))
        .expect("undo C")
        .expect("undo target");

    let media = MediaAsset::new("latest.mp4", "mp4", 8_192, MediaKind::Video).expect("valid media");
    stage_media(&directory, &database, &media);
    let current = database
        .load_project(metadata.id())
        .expect("load project")
        .expect("project exists");
    database
        .commit_project(
            &snapshot_with(&current, vec![media.clone()], &second),
            &reason("Unrelated media"),
        )
        .expect("commit media");
    let committed = database
        .commit_project_track(
            metadata.id(),
            &selector(),
            3,
            Some(&second),
            Some(&branch),
            &reason("D"),
        )
        .expect("commit branch");
    assert_eq!(committed.snapshot.media(), &[media]);
    assert_eq!(committed.snapshot.tracks()[0], branch);
    assert!(!committed.status.can_redo);

    drop(database);
    let connection = Connection::open(path).expect("open database directly");
    let revision_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM editor_track_revisions WHERE project_id = ?1",
            [metadata.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("count revisions");
    assert_eq!(revision_count, 3, "the abandoned C branch is deleted");
}

#[test]
fn corrupt_track_hash_is_rejected() {
    let (_directory, path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let edited = revise(&initial, "B");
    database
        .commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&edited),
            &reason("B"),
        )
        .expect("commit B");
    drop(database);

    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute(
            "UPDATE editor_track_revisions SET track_hash = zeroblob(32)
                 WHERE id = (SELECT current_revision_id FROM editor_track_navigation
                             WHERE project_id = ?1)",
            [metadata.id().as_uuid()],
        )
        .expect("corrupt hash");
    drop(connection);
    let corrupt = Database::open(&path).expect("reopen corrupt database");
    assert!(matches!(
        corrupt.project_track_history_status(metadata.id(), &selector()),
        Err(DatabaseError::CorruptProjectTrackHistory(id)) if id == metadata.id()
    ));
}

#[test]
fn oversized_redo_json_is_rejected_before_parsing() {
    let (_directory, path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let edited = revise(&initial, "B");
    database
        .commit_project_track(
            metadata.id(),
            &selector(),
            0,
            Some(&initial),
            Some(&edited),
            &reason("B"),
        )
        .expect("commit B");
    drop(database);

    let connection = Connection::open(&path).expect("open database directly");
    let current: uuid::Uuid = connection
        .query_row(
            "SELECT current_revision_id FROM editor_track_navigation WHERE project_id = ?1",
            [metadata.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("read current revision");
    let repeated = serde_json::to_string(&vec![current.to_string(); MAX_TRACK_REVISIONS * 8])
        .expect("serialize oversized redo");
    assert!(repeated.len() > MAX_TRACK_REDO_JSON_BYTES);
    connection
        .execute(
            "UPDATE editor_track_navigation SET redo_stack_json = ?1 WHERE project_id = ?2",
            rusqlite::params![repeated, metadata.id().as_uuid()],
        )
        .expect("store oversized redo");
    drop(connection);

    let corrupt = Database::open(path).expect("reopen database");
    assert!(matches!(
        corrupt.project_track_history_status(metadata.id(), &selector()),
        Err(DatabaseError::CorruptProjectTrackHistory(id)) if id == metadata.id()
    ));
}

#[test]
fn retained_track_history_is_bounded() {
    let (_directory, path, database) = database();
    let (metadata, initial, _) = seeded(&database);
    let mut current = initial;
    for index in 0..(MAX_TRACK_REVISIONS + 20) {
        let next = revise(&current, &format!("edit {index}"));
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                u64::try_from(index).expect("bounded index"),
                Some(&current),
                Some(&next),
                &reason("Editor text"),
            )
            .expect("commit bounded edit");
        current = next;
    }
    drop(database);

    let connection = Connection::open(path).expect("open database directly");
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM editor_track_revisions WHERE project_id = ?1",
            [metadata.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("count retained revisions");
    assert_eq!(
        count,
        i64::try_from(MAX_TRACK_REVISIONS).expect("bounded maximum")
    );
}
