//! Artifact registration, dedup reservations, branding, listing, and explicit failure.

use super::*;

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
fn pending_dedup_reservation_cannot_be_stolen_and_failed_publication_can_retry() {
    let fixture = Fixture::new();
    let bytes = b"retryable publication";
    let draft = draft("retryableArtifact", bytes);
    let first = staging(
        fixture
            .database()
            .register_artifact(&draft)
            .expect("first reservation"),
    );
    let id = first.record().id();

    assert!(matches!(
        fixture.database().register_artifact(&draft),
        Ok(ArtifactRegistration::Pending(record)) if record.id() == id
    ));
    assert_eq!(
        fixture
            .database()
            .get_artifact(id)
            .expect("pending lookup")
            .expect("pending record")
            .state(),
        ArtifactState::Pending
    );

    fixture
        .database()
        .mark_artifact_failed(
            id,
            &ArtifactFailureCode::new("fixtureFailure").expect("failure code"),
        )
        .expect("fail publication");
    let retry = staging(
        fixture
            .database()
            .register_artifact(&draft)
            .expect("retry failed publication"),
    );
    assert_eq!(retry.record().id(), id);
    assert_eq!(
        fixture
            .database()
            .get_artifact(id)
            .expect("retry lookup")
            .expect("preserved retry row")
            .state(),
        ArtifactState::Pending
    );
    let retry_id = retry.record().id();
    fs::write(retry.path(), bytes).expect("write retry");
    let ready = fixture
        .database()
        .mark_artifact_ready(retry_id)
        .expect("publish retry");
    assert_eq!(ready.state(), ArtifactState::Ready);
    assert_eq!(
        fs::read(
            fixture
                .database()
                .resolve_artifact(retry_id)
                .expect("resolve retry")
                .expect("ready retry")
                .path()
        )
        .expect("read retry"),
        bytes
    );
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the positive adoption and negative poison collision share one exact v5 fixture"
)]
fn genuine_unmarked_v5_media_is_branded_but_incompatible_collisions_fail_closed() {
    let fixture = Fixture::new();
    let kind = ArtifactKind::new("downloadedMedia").expect("kind");
    let legacy_bytes = b"genuine v5 downloaded media";
    let legacy = ArtifactDraft::new(
        kind.clone(),
        ContentHash::digest(legacy_bytes),
        u64::try_from(legacy_bytes.len()).expect("fixture size"),
        json!({"source": "urlDownload", "filename": "legacy.mp4"}),
    )
    .expect("legacy draft");
    let legacy_stage = staging(
        fixture
            .database()
            .register_artifact(&legacy)
            .expect("register legacy artifact"),
    );
    fs::write(legacy_stage.path(), legacy_bytes).expect("write legacy artifact");
    let legacy_id = legacy_stage.record().id();
    fixture
        .database()
        .mark_artifact_ready(legacy_id)
        .expect("ready legacy artifact");
    Connection::open(&fixture.database_path)
        .expect("open legacy fixture")
        .execute(
            "UPDATE artifacts SET metadata_json = ?1 WHERE id = ?2",
            [
                rusqlite::types::Value::Text(
                    "{ \"filename\" : \"legacy.mp4\", \"source\" : \"urlDownload\" }".to_owned(),
                ),
                rusqlite::types::Value::Blob(legacy_id.as_uuid().as_bytes().to_vec()),
            ],
        )
        .expect("preserve noncanonical v5 JSON formatting");
    let branded = ArtifactDraft::new(
        kind.clone(),
        ContentHash::digest(legacy_bytes),
        u64::try_from(legacy_bytes.len()).expect("fixture size"),
        json!({
            "source": "urlDownload", "filename": "legacy.mp4",
            "osgMediaArtifact": true, "commitOnJobSuccess": true
        }),
    )
    .expect("branded draft");
    assert!(matches!(
        fixture.database().register_artifact(&branded),
        Ok(ArtifactRegistration::Existing(record)) if record.id() == legacy_id
    ));
    let adopted = fixture
        .database()
        .get_artifact(legacy_id)
        .expect("adopted lookup")
        .expect("adopted artifact");
    assert_eq!(
        adopted
            .metadata()
            .get("osgMediaArtifact")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );

    let poisoned_bytes = b"poisoned same-kind collision";
    let poisoned = ArtifactDraft::new(
        kind.clone(),
        ContentHash::digest(poisoned_bytes),
        u64::try_from(poisoned_bytes.len()).expect("fixture size"),
        json!({
            "source": "urlDownload", "filename": "poison.mp4",
            "unexpectedOwner": "legacy-import"
        }),
    )
    .expect("poisoned legacy draft");
    let poisoned_stage = staging(
        fixture
            .database()
            .register_artifact(&poisoned)
            .expect("register poisoned legacy artifact"),
    );
    fs::write(poisoned_stage.path(), poisoned_bytes).expect("write poisoned artifact");
    let poisoned_id = poisoned_stage.record().id();
    fixture
        .database()
        .mark_artifact_ready(poisoned_id)
        .expect("ready poisoned artifact");
    let proposed = ArtifactDraft::new(
        kind,
        ContentHash::digest(poisoned_bytes),
        u64::try_from(poisoned_bytes.len()).expect("fixture size"),
        json!({
            "source": "urlDownload", "filename": "poison.mp4",
            "osgMediaArtifact": true
        }),
    )
    .expect("proposed media draft");
    assert!(matches!(
        fixture.database().register_artifact(&proposed),
        Err(DatabaseError::ArtifactReuseConflict(id)) if id == poisoned_id
    ));
    let unchanged = fixture
        .database()
        .get_artifact(poisoned_id)
        .expect("poisoned lookup")
        .expect("poisoned artifact");
    assert_eq!(unchanged.state(), ArtifactState::Ready);
    assert!(unchanged.metadata().get("osgMediaArtifact").is_none());
}

#[test]
fn ready_artifact_listing_is_bounded_project_scoped_and_restart_durable() {
    let mut fixture = Fixture::new();
    let first_project = ProjectMetadata::new("first project").expect("first project");
    let second_project = ProjectMetadata::new("second project").expect("second project");
    fixture
        .database()
        .create_project(&first_project)
        .expect("create first project");
    fixture
        .database()
        .create_project(&second_project)
        .expect("create second project");
    let kind = ArtifactKind::new("generatedBackgroundImage").expect("kind");
    let publish_for = |database: &Database, project, bytes: &[u8]| {
        let draft = ArtifactDraft::new(
            kind.clone(),
            ContentHash::digest(bytes),
            bytes.len() as u64,
            json!({"mimeType": "image/png"}),
        )
        .expect("draft")
        .with_project(project);
        publish_draft(database, &draft, bytes)
    };

    let first = publish_for(fixture.database(), first_project.id(), b"first image");
    let other = publish_for(fixture.database(), second_project.id(), b"other image");
    let second = publish_for(fixture.database(), first_project.id(), b"second image");

    let listed = fixture
        .database()
        .list_ready_artifacts(first_project.id(), &kind, 256)
        .expect("list first project");
    assert_eq!(
        listed.iter().map(ArtifactRecord::id).collect::<Vec<_>>(),
        vec![first.record().id(), second.record().id()]
    );
    assert!(
        !listed
            .iter()
            .any(|record| record.id() == other.record().id())
    );
    assert!(
        fixture
            .database()
            .list_ready_artifacts(first_project.id(), &kind, 0)
            .is_err()
    );
    assert!(
        fixture
            .database()
            .list_ready_artifacts(first_project.id(), &kind, 4_097)
            .is_err()
    );

    fixture.reopen();
    let reopened = fixture
        .database()
        .list_ready_artifacts(first_project.id(), &kind, 256)
        .expect("list after restart");
    assert_eq!(
        reopened.iter().map(ArtifactRecord::id).collect::<Vec<_>>(),
        vec![first.record().id(), second.record().id()]
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
fn transactional_removal_restores_the_ready_file_when_the_database_rolls_back() {
    let fixture = Fixture::new();
    let resolved = publish(fixture.database(), "downloadMedia", b"rollback media");
    let artifact_id = resolved.record().id();
    let final_path = resolved.path().to_owned();
    let trash_path = fixture.artifact_root.join(trash_name(artifact_id));
    let root = ArtifactRoot::prepare(&fixture.artifact_root).expect("artifact root");
    let mut connection = Connection::open(&fixture.database_path).expect("direct connection");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("foreign keys");
    let transaction = connection.transaction().expect("removal transaction");
    let removal = remove_transactional(&transaction, &root, artifact_id)
        .expect("transactional removal")
        .expect("removal guard");
    assert!(!final_path.exists());
    assert!(trash_path.is_file());

    drop(transaction);
    drop(removal);

    assert!(final_path.is_file());
    assert!(!trash_path.exists());
    assert!(
        fixture
            .database()
            .resolve_artifact(artifact_id)
            .expect("resolve rolled-back artifact")
            .is_some()
    );
}
