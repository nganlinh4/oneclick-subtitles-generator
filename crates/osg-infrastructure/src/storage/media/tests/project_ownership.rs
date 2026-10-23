//! Project promotion and lifetime ownership of media across detach, undo, and reopen.

use super::*;

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the history safety scenario intentionally exercises promotion, detach, theft rejection, and undo end to end"
)]
fn project_promotion_owns_artifact_and_asset_across_detach_and_undo() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database =
        crate::storage::Database::open(directory.path().join("osg.sqlite3")).expect("database");
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
            .resolve_project_media_revision(metadata.id(), restored.state_version(), asset.id(),)
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
fn remembered_import_attached_by_a_project_commit_resolves_after_a_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let source_path = directory.path().join("import.mp4");
    let asset;
    let bytes;
    let metadata;
    let attached_version;
    {
        let database = crate::storage::Database::open(&database_path).expect("database");
        let (staged, staged_bytes) = stage_remembered_import(&database, &source_path, 0x3c);
        asset = staged;
        bytes = staged_bytes;
        let (owner, _, attached) =
            attach_media_to_new_project(&database, "Subtitle alias owner", &asset);
        metadata = owner;
        attached_version = attached;
        assert!(
            database
                .resolve_project_media_revision(metadata.id(), attached_version, asset.id())
                .expect("resolve the attached revision")
                .is_some()
        );
    }

    let reopened = crate::storage::Database::open(&database_path).expect("reopen after restart");
    assert!(
        reopened
            .project_media_is_current(metadata.id(), attached_version, asset.id())
            .expect("ownership survives the restart")
    );
    let resolved = reopened
        .resolve_project_media_revision(metadata.id(), attached_version, asset.id())
        .expect("resolve the attached revision after restart")
        .expect("project media after restart");
    assert_eq!(resolved.asset(), &asset);
    assert_eq!(
        std::fs::read(resolved.path()).expect("reopened bytes"),
        bytes
    );
    assert_eq!(
        lifetime_owners(&database_path, asset.id()),
        vec![*metadata.id().as_uuid()]
    );
}

#[test]
fn undo_past_the_attach_revision_fails_closed_but_keeps_the_lifetime_owner() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let source_path = directory.path().join("undone.mp4");
    let (asset, _) = stage_remembered_import(&database, &source_path, 0x2d);
    let (metadata, _, attached_version) =
        attach_media_to_new_project(&database, "Undo owner", &asset);
    assert!(
        database
            .project_media_is_current(metadata.id(), attached_version, asset.id())
            .expect("attached media is current")
    );

    let restored = database
        .undo_project(metadata.id(), attached_version)
        .expect("undo the attach revision")
        .expect("history target");
    assert!(restored.media().is_empty());

    for version in [attached_version, restored.state_version()] {
        assert!(
            !database
                .project_media_is_current(metadata.id(), version, asset.id())
                .expect("undone media is current for no revision")
        );
        assert!(
            database
                .resolve_project_media_revision(metadata.id(), version, asset.id())
                .expect("resolve an undone revision")
                .is_none()
        );
    }
    assert!(
        database
            .resolve_project_media(asset.id())
            .expect("resolve undone project media")
            .is_none()
    );
    assert_eq!(
        lifetime_owners(&database_path, asset.id()),
        vec![*metadata.id().as_uuid()]
    );
}

#[test]
fn a_stale_project_state_version_never_resolves_attached_media() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let source_path = directory.path().join("versioned.mp4");
    let (asset, _) = stage_remembered_import(&database, &source_path, 0x5f);
    let (metadata, base_version, attached_version) =
        attach_media_to_new_project(&database, "Stale version owner", &asset);

    let renamed = ProjectSnapshot::new(
        ProjectMetadata::with_id(metadata.id(), "Stale version owner renamed")
            .expect("renamed metadata"),
        attached_version,
        vec![asset.clone()],
        Vec::new(),
    )
    .expect("rename snapshot");
    let renamed_version = database
        .commit_project(
            &renamed,
            &RevisionReason::new("rename the project").expect("revision reason"),
        )
        .expect("rename the project")
        .state_version;
    assert!(renamed_version > attached_version);

    for stale_version in [base_version, attached_version] {
        assert!(
            !database
                .project_media_is_current(metadata.id(), stale_version, asset.id())
                .expect("a stale state version is never current")
        );
        assert!(
            database
                .resolve_project_media_revision(metadata.id(), stale_version, asset.id())
                .expect("resolve a stale state version")
                .is_none()
        );
    }
    assert!(
        database
            .project_media_is_current(metadata.id(), renamed_version, asset.id())
            .expect("the current state version is current")
    );
    assert!(
        database
            .resolve_project_media_revision(metadata.id(), renamed_version, asset.id())
            .expect("resolve the current state version")
            .is_some()
    );
}

#[test]
fn a_second_project_cannot_claim_owned_media_across_a_database_reopen() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let source_path = directory.path().join("owned.mp4");
    let asset;
    let owner_metadata;
    let attached_version;
    {
        let database = crate::storage::Database::open(&database_path).expect("database");
        let (staged, _) = stage_remembered_import(&database, &source_path, 0x4d);
        asset = staged;
        let (owner, _, attached) = attach_media_to_new_project(&database, "Owner A", &asset);
        owner_metadata = owner;
        attached_version = attached;
    }

    let reopened = crate::storage::Database::open(&database_path).expect("reopen after restart");
    let other_metadata = ProjectMetadata::new("Owner B").expect("second project metadata");
    let other_base = reopened
        .create_project(&other_metadata)
        .expect("create owner B");
    let steal = ProjectSnapshot::new(
        other_metadata.clone(),
        other_base.state_version(),
        vec![asset.clone()],
        Vec::new(),
    )
    .expect("steal snapshot");
    assert!(matches!(
        reopened.commit_project(
            &steal,
            &RevisionReason::new("steal attached media").expect("revision reason"),
        ),
        Err(DatabaseError::CrossProjectIdentifier { project_id, entity })
            if project_id == other_metadata.id() && entity == "media asset"
    ));

    let detach = ProjectSnapshot::new(
        owner_metadata.clone(),
        attached_version,
        Vec::new(),
        Vec::new(),
    )
    .expect("detach snapshot");
    reopened
        .commit_project(
            &detach,
            &RevisionReason::new("detach media").expect("revision reason"),
        )
        .expect("detach media");
    assert!(matches!(
        reopened.commit_project(
            &steal,
            &RevisionReason::new("steal detached media").expect("revision reason"),
        ),
        Err(DatabaseError::CrossProjectIdentifier { project_id, entity })
            if project_id == other_metadata.id() && entity == "media asset"
    ));
    assert_eq!(
        lifetime_owners(&database_path, asset.id()),
        vec![*owner_metadata.id().as_uuid()]
    );
}
