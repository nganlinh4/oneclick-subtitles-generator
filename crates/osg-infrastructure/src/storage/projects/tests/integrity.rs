//! Corruption detection, rollback of failed writes, media-location privacy, and cross-project
//! identifier isolation.

use super::*;

#[test]
fn corrupted_snapshot_hash_is_detected_before_deserialization_or_commit() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Corrupt hash").expect("valid project");
    database.create_project(&metadata).expect("create project");
    drop(database);
    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute(
            "UPDATE project_revisions SET snapshot_hash = zeroblob(32)",
            [],
        )
        .expect("corrupt hash");
    drop(connection);

    let reopened = Database::open(path).expect("reopen database");
    assert!(matches!(
        reopened.load_project(metadata.id()),
        Err(DatabaseError::CorruptProjectRevision {
            detail: "snapshot hash verification failed",
            ..
        })
    ));
}

#[test]
fn corrupted_compressed_blob_is_detected_with_bounded_decompression() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Corrupt blob").expect("valid project");
    database.create_project(&metadata).expect("create project");
    drop(database);
    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute("UPDATE project_revisions SET snapshot_zstd = x'00'", [])
        .expect("corrupt blob");
    drop(connection);

    let reopened = Database::open(path).expect("reopen database");
    assert!(matches!(
        reopened.load_project(metadata.id()),
        Err(DatabaseError::CorruptProjectRevision { .. })
    ));
}

#[test]
fn failed_normalized_write_rolls_back_every_row_and_the_revision() {
    let (directory, path, database) = database();
    let metadata = ProjectMetadata::new("Rollback").expect("valid project");
    let base = database.create_project(&metadata).expect("create project");
    drop(database);
    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute_batch(
            "CREATE TRIGGER reject_test_cue BEFORE INSERT ON cues
                 BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END;",
        )
        .expect("install failure trigger");
    drop(connection);

    let reopened = Database::open(&path).expect("reopen database");
    let asset = media();
    stage_media(&directory, &reopened, &asset);
    let edited = edit(
        &base,
        "Must roll back",
        vec![asset],
        vec![track("English", "Rollback")],
    );
    assert!(
        reopened
            .commit_project(&edited, &reason("Fail atomically"))
            .is_err()
    );
    assert_eq!(
        reopened.load_project(metadata.id()).expect("load original"),
        Some(base)
    );
    drop(reopened);

    let connection = Connection::open(path).expect("open database directly");
    let counts: (i64, i64, i64, i64) = connection
        .query_row(
            "SELECT
                   (SELECT count(*) FROM project_revisions),
                   (SELECT count(*) FROM media_assets),
                   (SELECT count(*) FROM tracks),
                   (SELECT state_version FROM projects WHERE id = ?1)",
            [metadata.id().as_uuid()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read rollback state");
    assert_eq!(counts, (1, 1, 0, 0));
}

#[test]
fn media_locations_are_never_serialized_or_deleted_by_project_history() {
    let (directory, path, database) = database();
    let metadata = ProjectMetadata::new("Private paths").expect("valid project");
    let base = database.create_project(&metadata).expect("create project");
    let asset = media();
    stage_media(&directory, &database, &asset);
    let with_media = edit(&base, "Private paths", vec![asset.clone()], Vec::new());
    let media_commit = database
        .commit_project(&with_media, &reason("Attach media"))
        .expect("commit media");
    let committed = database
        .load_project(metadata.id())
        .expect("load media project")
        .expect("project exists");

    let private_path = b"/private/user/videos/movie.mp4";
    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute(
            "INSERT INTO media_locations(
                   id, media_id, path_bytes, path_encoding, platform, available
                 ) VALUES (?1, ?2, ?3, 'unix-bytes', 'linux', 1)",
            params![
                Uuid::now_v7(),
                asset.id().as_uuid(),
                private_path.as_slice()
            ],
        )
        .expect("save private media location");
    let compressed: Vec<u8> = connection
        .query_row(
            "SELECT snapshot_zstd FROM project_revisions WHERE id = ?1",
            [media_commit.revision_id.as_uuid()],
            |row| row.get(0),
        )
        .expect("read canonical snapshot");
    let raw = zstd::stream::decode_all(compressed.as_slice()).expect("decode snapshot");
    assert!(
        !raw.windows(private_path.len())
            .any(|window| window == private_path)
    );
    assert!(
        !String::from_utf8(raw)
            .expect("snapshot JSON")
            .contains("pathBytes")
    );
    drop(connection);

    let without_media = edit(&committed, "Private paths", Vec::new(), Vec::new());
    database
        .commit_project(&without_media, &reason("Detach media"))
        .expect("detach media");
    let connection = Connection::open(&path).expect("open database directly");
    let location_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM media_locations WHERE media_id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("count media locations");
    assert_eq!(location_count, 2);
}

#[test]
fn identifiers_owned_by_another_project_are_rejected_at_every_level() {
    let (directory, _path, database) = database();
    let first = ProjectMetadata::new("First").expect("valid project");
    let second = ProjectMetadata::new("Second").expect("valid project");
    let first_base = database.create_project(&first).expect("create first");
    let second_base = database.create_project(&second).expect("create second");
    let shared_media = media();
    stage_media(&directory, &database, &shared_media);
    let shared_track = track("Shared", "Shared cue");
    let first_edit = edit(
        &first_base,
        "First",
        vec![shared_media.clone()],
        vec![shared_track.clone()],
    );
    database
        .commit_project(&first_edit, &reason("Own identifiers"))
        .expect("commit first");

    let media_reuse = edit(&second_base, "Second", vec![shared_media], Vec::new());
    assert!(matches!(
        database.commit_project(&media_reuse, &reason("Reuse media")),
        Err(DatabaseError::CrossProjectIdentifier {
            entity: "media asset",
            ..
        })
    ));

    let track_reuse = edit(
        &second_base,
        "Second",
        Vec::new(),
        vec![shared_track.clone()],
    );
    assert!(matches!(
        database.commit_project(&track_reuse, &reason("Reuse track")),
        Err(DatabaseError::CrossProjectIdentifier {
            entity: "subtitle track",
            ..
        })
    ));

    let track_with_reused_cue = SubtitleTrack::new(
        "New track",
        TrackOrigin::Srt,
        vec![shared_track.cues()[0].clone()],
    )
    .expect("valid track with copied cue");
    let cue_reuse = edit(
        &second_base,
        "Second",
        Vec::new(),
        vec![track_with_reused_cue],
    );
    assert!(matches!(
        database.commit_project(&cue_reuse, &reason("Reuse cue")),
        Err(DatabaseError::CrossProjectIdentifier {
            entity: "subtitle cue",
            ..
        })
    ));
}
