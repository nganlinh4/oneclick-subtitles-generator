//! Project commits against candidates: expiry safety, missing bytes, and atomic promotion.

use super::*;

#[test]
fn expired_candidate_cleanup_never_removes_project_owned_media() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let owned_path = directory.path().join("owned.mp4");
    let owned_bytes = vec![0x11; 12 * 1024];
    std::fs::write(&owned_path, &owned_bytes).expect("owned fixture");
    let owned = MediaAsset::new(
        "owned.mp4",
        "mp4",
        u64::try_from(owned_bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("owned asset");
    database
        .remember_media_candidate(&owned, &owned_path)
        .expect("stage owned candidate");
    let (metadata, _, attached_version) =
        attach_media_to_new_project(&database, "Expiry owner", &owned);
    let stray_path = directory.path().join("stray.mp4");
    let stray_bytes = vec![0x22; 12 * 1024];
    std::fs::write(&stray_path, &stray_bytes).expect("stray fixture");
    let stray = MediaAsset::new(
        "stray.mp4",
        "mp4",
        u64::try_from(stray_bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("stray asset");
    database
        .remember_media_candidate(&stray, &stray_path)
        .expect("stage stray candidate");
    // Force the hostile shape a downgrade or a corrupt writer could leave behind: the
    // project-owned asset wears an expired candidate lease it never earned.
    rusqlite::Connection::open(&database_path)
        .expect("expire both assets")
        .execute(
            "UPDATE media_assets
                 SET metadata_json = json_set(
                   json_set(metadata_json, '$.osgMediaLifecycle', 'candidate'),
                   '$.osgMediaCandidateExpiresAtMs', 0
                 )
                 WHERE id IN (?1, ?2)",
            params![owned.id().as_uuid(), stray.id().as_uuid()],
        )
        .expect("expire both assets");
    let downgraded: String = rusqlite::Connection::open(&database_path)
        .expect("inspect the downgraded lease")
        .query_row(
            "SELECT metadata_json FROM media_assets WHERE id = ?1",
            [owned.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("downgraded metadata");
    let downgraded: Value = serde_json::from_str(&downgraded).expect("valid downgraded metadata");
    assert_eq!(downgraded["osgMediaLifecycle"], "candidate");
    assert_eq!(downgraded["osgMediaCandidateExpiresAtMs"], 0);

    let report = database
        .reconcile_artifacts()
        .expect("reconcile expired candidates");

    assert_eq!(report.removed_expired_media_candidates, 1);
    assert!(
        database
            .resolve_media(stray.id())
            .expect("stray candidate lookup")
            .is_none()
    );
    assert!(
        database
            .resolve_media(owned.id())
            .expect("owned media lookup")
            .is_some()
    );
    assert_eq!(
        lifetime_owners(&database_path, owned.id()),
        vec![*metadata.id().as_uuid()]
    );
    rusqlite::Connection::open(&database_path)
        .expect("repair the downgraded lifecycle")
        .execute(
            "UPDATE media_assets
                 SET metadata_json = json_set(metadata_json, '$.osgMediaLifecycle', 'project')
                 WHERE id = ?1",
            [owned.id().as_uuid()],
        )
        .expect("repair the downgraded lifecycle");
    assert!(
        database
            .resolve_project_media_revision(metadata.id(), attached_version, owned.id())
            .expect("resolve the surviving project media")
            .is_some()
    );
}

#[test]
fn project_owned_media_without_bytes_fails_closed_without_naming_a_path() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let source_path = directory.path().join("vanishing.mp4");
    let (asset, _) = stage_remembered_import(&database, &source_path, 0x0f);
    let (metadata, _, attached_version) =
        attach_media_to_new_project(&database, "Vanishing owner", &asset);
    let snapshot_path = database
        .resolve_project_media_revision(metadata.id(), attached_version, asset.id())
        .expect("resolve before the bytes vanish")
        .expect("project media")
        .path()
        .to_owned();

    make_test_file_writable(&snapshot_path);
    std::fs::remove_file(&snapshot_path).expect("remove the managed snapshot");
    std::fs::remove_file(&source_path).expect("remove the original import");

    assert!(
        database
            .resolve_project_media_revision(metadata.id(), attached_version, asset.id())
            .expect("revision resolve fails closed")
            .is_none()
    );
    assert!(
        database
            .resolve_project_media(asset.id())
            .expect("owner resolve fails closed")
            .is_none()
    );
    assert!(
        database
            .resolve_media(asset.id())
            .expect("identity resolve fails closed")
            .is_none()
    );
    // Only the bytes are gone: the durable ownership facts must survive untouched.
    assert!(
        database
            .project_media_is_current(metadata.id(), attached_version, asset.id())
            .expect("ownership is unchanged")
    );
    assert_eq!(
        lifetime_owners(&database_path, asset.id()),
        vec![*metadata.id().as_uuid()]
    );

    let error = database
        .remember_media(&asset, &source_path)
        .expect_err("a vanished import cannot be remembered again");
    assert!(matches!(error, DatabaseError::InvalidMediaLocation));
    let private = directory.path().to_string_lossy().into_owned();
    assert!(!format!("{error}").contains(&private));
    assert!(!format!("{error:?}").contains(&private));
}

#[test]
fn project_commit_rejects_a_candidate_discarded_before_the_transaction() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database =
        crate::storage::Database::open(directory.path().join("osg.sqlite3")).expect("database");
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
    let database = crate::storage::Database::open(&database_path).expect("database");
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
        crate::storage::Database::open(&database_path).expect("reopen after project commit");

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
