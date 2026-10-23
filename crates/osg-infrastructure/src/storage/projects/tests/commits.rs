//! Project creation, idempotent create, atomic commits, and stale-writer rejection.

use super::*;

#[test]
fn repository_port_creates_loads_and_reopens_a_project() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Persistent project").expect("valid project");

    let created = ProjectRepository::create(&database, &metadata).expect("create project");
    assert_eq!(created.state_version(), 0);
    assert_eq!(
        ProjectRepository::load(&database, metadata.id()).expect("load project"),
        Some(created.clone())
    );

    drop(database);
    let reopened = Database::open(path).expect("reopen database");
    assert_eq!(
        reopened
            .load_project(metadata.id())
            .expect("load reopened project"),
        Some(created)
    );
}

#[test]
fn speaker_presentation_survives_normalized_load_history_and_restart() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Speakers").unwrap();
    let base = database.create_project(&metadata).unwrap();
    let speaker = serde_json::from_value(serde_json::json!({
        "id": "w0:1", "name": "민지", "labelStyle": "brackets"
    }))
    .unwrap();
    let cue = SubtitleCue::new(0, 1000, "Hello".to_owned())
        .unwrap()
        .with_speaker(Some(speaker));
    let track = SubtitleTrack::new("Subtitles", TrackOrigin::LegacyJson, vec![cue]).unwrap();
    let candidate = edit(&base, "Speakers", Vec::new(), vec![track]);
    database
        .commit_project(&candidate, &reason("speakers"))
        .unwrap();
    let loaded = database.load_project(metadata.id()).unwrap().unwrap();
    assert_eq!(loaded.tracks(), candidate.tracks());
    let undone = database.undo_project(metadata.id(), 1).unwrap().unwrap();
    assert!(undone.tracks().is_empty());
    let redone = database
        .redo_project_guarded(metadata.id(), 2, &reason("speakers"))
        .unwrap()
        .unwrap();
    assert_eq!(redone.tracks(), candidate.tracks());
    drop(database);
    let reopened = Database::open(&path).unwrap();
    let loaded = reopened.load_project(metadata.id()).unwrap().unwrap();
    assert_eq!(loaded.tracks(), candidate.tracks());
    assert_eq!(loaded.tracks()[0].cues()[0].text(), "Hello");
}

#[test]
fn idempotent_create_replays_one_authoritative_project_across_restart() {
    let (_directory, path, database) = database();
    let first_request = ProjectMetadata::new("Recovered project").expect("first request");
    let created = database
        .create_project_idempotent(&first_request, "cache:durable-create")
        .expect("first create");

    let retry_request = ProjectMetadata::new("Recovered project").expect("retry request");
    assert_ne!(first_request.id(), retry_request.id());
    let replayed = database
        .create_project_idempotent(&retry_request, "cache:durable-create")
        .expect("same-session replay");
    assert_eq!(replayed, created);
    assert!(matches!(
        database.create_project_idempotent(
            &ProjectMetadata::new("Different request").expect("conflicting request"),
            "cache:durable-create",
        ),
        Err(DatabaseError::ProjectCreateRequestConflict)
    ));

    drop(database);
    let reopened = Database::open(&path).expect("reopen database");
    let after_restart = reopened
        .create_project_idempotent(
            &ProjectMetadata::new("Recovered project").expect("restart request"),
            "cache:durable-create",
        )
        .expect("restart replay");
    assert_eq!(after_restart, created);

    let connection = Connection::open(path).expect("inspect durable receipt");
    let project_count: i64 = connection
        .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
        .expect("count projects");
    let receipt_count: i64 = connection
        .query_row("SELECT count(*) FROM project_create_receipts", [], |row| {
            row.get(0)
        })
        .expect("count receipts");
    assert_eq!(project_count, 1);
    assert_eq!(receipt_count, 1);
}

#[test]
fn idempotent_create_rejects_unstable_or_hostile_keys_without_writing() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Rejected project").expect("request");
    for invalid in ["", "contains\ncontrol"] {
        assert!(matches!(
            database.create_project_idempotent(&metadata, invalid),
            Err(DatabaseError::InvalidProjectCreateKey)
        ));
    }
    let oversized = "x".repeat(MAX_PROJECT_CREATE_KEY_UTF16_UNITS + 1);
    assert!(matches!(
        database.create_project_idempotent(&metadata, &oversized),
        Err(DatabaseError::InvalidProjectCreateKey)
    ));
    let project_count: i64 = Connection::open(path)
        .expect("inspect database")
        .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
        .expect("count projects");
    assert_eq!(project_count, 0);
}

#[test]
fn commit_atomically_updates_normalized_state_and_the_immutable_snapshot() {
    let (directory, path, database) = database();
    let metadata = ProjectMetadata::new("Before").expect("valid project");
    let created = database.create_project(&metadata).expect("create project");
    let asset = media();
    stage_media(&directory, &database, &asset);
    let edited = edit(
        &created,
        "After",
        vec![asset],
        vec![track("English", "Hello")],
    );

    let commit = database
        .commit_project(&edited, &reason("Imported subtitles"))
        .expect("commit project");
    assert_eq!(commit.state_version, 1);
    let expected = edited.with_state_version(1).expect("next version");
    assert_eq!(
        database.load_project(metadata.id()).expect("load project"),
        Some(expected.clone())
    );

    drop(database);
    let connection = Connection::open(path).expect("open database directly");
    let (project_version, revision_version, media_count, track_count, cue_count): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT p.state_version, r.state_version,
                        (SELECT count(*) FROM project_media WHERE project_id = p.id),
                        (SELECT count(*) FROM tracks WHERE project_id = p.id),
                        (SELECT count(*) FROM cues c JOIN tracks t ON t.id = c.track_id
                         WHERE t.project_id = p.id)
                 FROM projects p
                 JOIN revision_navigation n ON n.project_id = p.id
                 JOIN project_revisions r ON r.id = n.current_revision_id
                 WHERE p.id = ?1",
            [metadata.id().as_uuid()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read normalized state");
    assert_eq!((project_version, revision_version), (1, 1));
    assert_eq!((media_count, track_count, cue_count), (1, 1, 1));
}

#[test]
fn stale_writer_is_rejected_without_changing_the_winning_commit() {
    let (_directory, _path, database) = database();
    let metadata = ProjectMetadata::new("Concurrent").expect("valid project");
    let base = database.create_project(&metadata).expect("create project");
    let winner = edit(&base, "Winner", Vec::new(), vec![track("A", "winner")]);
    let stale = edit(&base, "Stale", Vec::new(), vec![track("B", "stale")]);

    database
        .commit_project(&winner, &reason("Winning write"))
        .expect("commit winner");
    assert!(matches!(
        database.commit_project(&stale, &reason("Stale write")),
        Err(DatabaseError::StaleProjectVersion {
            expected: 0,
            actual: 1,
            ..
        })
    ));
    let loaded = database
        .load_project(metadata.id())
        .expect("load winner")
        .expect("project exists");
    assert_eq!(loaded.metadata().name(), "Winner");
    assert_eq!(loaded.tracks()[0].cues()[0].text(), "winner");
}

#[test]
fn version_overflow_is_rejected_without_mutating_the_project() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Version limit").expect("valid project");
    database.create_project(&metadata).expect("create project");
    drop(database);
    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute(
            "UPDATE projects SET state_version = ?1 WHERE id = ?2",
            params![i64::MAX, metadata.id().as_uuid()],
        )
        .expect("set project version");
    connection
        .execute(
            "UPDATE project_state SET state_version = ?1 WHERE project_id = ?2",
            params![i64::MAX, metadata.id().as_uuid()],
        )
        .expect("set state version");
    drop(connection);

    let reopened = Database::open(path).expect("reopen database");
    let at_limit = reopened
        .load_project(metadata.id())
        .expect("load project")
        .expect("project exists");
    assert_eq!(at_limit.state_version(), i64::MAX as u64);
    assert!(matches!(
        reopened.commit_project(&at_limit, &reason("Overflow")),
        Err(DatabaseError::ProjectVersionOverflow(id)) if id == metadata.id()
    ));
    assert_eq!(
        reopened
            .load_project(metadata.id())
            .expect("load unchanged project")
            .expect("project exists")
            .state_version(),
        i64::MAX as u64
    );
}
