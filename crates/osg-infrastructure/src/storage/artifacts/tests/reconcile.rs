//! Startup reconciliation and filesystem hardening: pending promotion, provisional commits, repair
//! windows, conflicting targets, and non-regular or symlinked staging.

use super::*;

#[test]
fn startup_promotes_only_complete_pending_content() {
    let mut fixture = Fixture::new();
    let complete = b"fully fsynced output";
    let complete_staging = staging(
        fixture
            .database()
            .register_artifact(&draft("narrationOutput", complete))
            .expect("register complete"),
    );
    fs::write(complete_staging.path(), complete).expect("write complete staging");
    let complete_id = complete_staging.record().id();

    let corrupt_staging = staging(
        fixture
            .database()
            .register_artifact(&draft("waveform", b"expected"))
            .expect("register corrupt"),
    );
    fs::write(corrupt_staging.path(), b"corrupt!").expect("write corrupt staging");
    let corrupt_id = corrupt_staging.record().id();

    fixture.reopen();
    assert_eq!(
        fixture
            .database()
            .get_artifact(complete_id)
            .expect("complete status")
            .expect("complete record")
            .state(),
        ArtifactState::Ready
    );
    assert_eq!(
        fixture
            .database()
            .get_artifact(corrupt_id)
            .expect("corrupt status")
            .expect("corrupt record")
            .state(),
        ArtifactState::Failed
    );
}

#[test]
fn startup_commits_provisional_artifacts_only_for_durably_succeeded_jobs() {
    let mut fixture = Fixture::new();
    let project = ProjectMetadata::new("provisional image project").expect("project");
    fixture
        .database()
        .create_project(&project)
        .expect("create project");
    let kind = ArtifactKind::new("generatedBackgroundImage:restart").expect("kind");

    let register_provisional = |database: &Database, job: &JobSnapshot, bytes: &[u8]| {
        database.create_job(job).expect("create job");
        let mut running = job.clone();
        running.start().expect("start job");
        database
            .compare_and_swap_job(job.sequence(), &running)
            .expect("persist running job");
        let draft = ArtifactDraft::new(
            kind.clone(),
            ContentHash::digest(bytes),
            bytes.len() as u64,
            json!({"mimeType": "image/png", "commitOnJobSuccess": true}),
        )
        .expect("draft")
        .with_project(project.id())
        .with_job(job.id());
        let staged = staging(database.register_artifact(&draft).expect("register"));
        fs::write(staged.path(), bytes).expect("write provisional bytes");
        (running, staged.record().id(), staged.path().to_path_buf())
    };

    let interrupted = JobSnapshot::new(JobKind::GenerateImage);
    let (_running, interrupted_artifact, interrupted_path) = register_provisional(
        fixture.database(),
        &interrupted,
        b"provisional interrupted image",
    );
    assert!(
        fixture
            .database()
            .resolve_artifact(interrupted_artifact)
            .unwrap()
            .is_none()
    );
    fixture
        .database()
        .reconcile_artifacts()
        .expect("live reconciliation");
    assert_eq!(
        fixture
            .database()
            .get_artifact(interrupted_artifact)
            .unwrap()
            .expect("running provisional row")
            .state(),
        ArtifactState::Pending
    );
    assert!(interrupted_path.is_file());

    fixture.reopen();
    assert!(
        fixture
            .database()
            .get_artifact(interrupted_artifact)
            .unwrap()
            .is_none()
    );
    assert!(!interrupted_path.exists());

    let completed = JobSnapshot::new(JobKind::GenerateImage);
    let (mut running, completed_artifact, _completed_path) = register_provisional(
        fixture.database(),
        &completed,
        b"provisional completed image",
    );
    let running_sequence = running.sequence();
    running.succeed().expect("succeed job");
    fixture
        .database()
        .compare_and_swap_job(running_sequence, &running)
        .expect("persist succeeded job");

    fixture.reopen();
    let recovered = fixture
        .database()
        .get_artifact(completed_artifact)
        .expect("lookup recovered")
        .expect("recovered artifact");
    assert_eq!(recovered.state(), ArtifactState::Ready);
    assert!(
        fixture
            .database()
            .resolve_artifact(completed_artifact)
            .unwrap()
            .is_some()
    );
}

#[test]
fn startup_repairs_file_before_wal_commit_and_interrupted_removal_windows() {
    let mut fixture = Fixture::new();
    let bytes = b"crash window";
    let draft = draft("videoTemp", bytes);
    let staging = staging(
        fixture
            .database()
            .register_artifact(&draft)
            .expect("register"),
    );
    fs::write(staging.path(), bytes).expect("write staging");
    let id = staging.record().id();
    let final_path = fixture.artifact_root.join(final_name(
        staging.record().kind(),
        staging.record().content_hash(),
    ));
    fs::hard_link(staging.path(), &final_path).expect("simulate publication before commit");

    fixture.reopen();
    assert_eq!(
        fixture
            .database()
            .get_artifact(id)
            .expect("status")
            .expect("record")
            .state(),
        ArtifactState::Ready
    );

    let trash_path = fixture.artifact_root.join(trash_name(id));
    fs::rename(&final_path, &trash_path).expect("simulate rename before database delete");
    fixture.reopen();
    assert!(final_path.is_file());
    assert!(!trash_path.exists());
    assert!(
        fixture
            .database()
            .resolve_artifact(id)
            .expect("resolve")
            .is_some()
    );
}

#[test]
fn media_publication_reconciliation_preserves_live_work_and_cleans_commit_gap() {
    let fixture = Fixture::new();
    let bytes = b"publication crash window";
    let mut job = JobSnapshot::new(JobKind::DownloadMedia);
    fixture.database().create_job(&job).expect("create job");
    let sequence = job.sequence();
    job.start().expect("start job");
    fixture
        .database()
        .compare_and_swap_job(sequence, &job)
        .expect("persist running job");
    let draft = ArtifactDraft::new(
        ArtifactKind::new("downloadMedia").expect("kind"),
        ContentHash::digest(bytes),
        u64::try_from(bytes.len()).expect("fixture size"),
        json!({"osgMediaArtifact": true, "commitOnJobSuccess": true}),
    )
    .expect("draft")
    .with_job(job.id());
    let staged = staging(
        fixture
            .database()
            .register_artifact(&draft)
            .expect("register publication"),
    );
    fs::write(staged.path(), bytes).expect("write staged publication");
    let artifact_id = staged.record().id();
    let staging_path = staged.path().to_owned();

    fixture
        .database()
        .reconcile_artifacts()
        .expect("live reconciliation");
    assert_eq!(
        fixture
            .database()
            .get_artifact(artifact_id)
            .expect("live artifact")
            .expect("pending artifact")
            .state(),
        ArtifactState::Pending
    );
    assert!(staging_path.is_file());

    let sequence = job.sequence();
    job.succeed().expect("succeed job");
    fixture
        .database()
        .compare_and_swap_job(sequence, &job)
        .expect("persist succeeded job");
    let final_path = fixture.artifact_root.join(final_name(
        staged.record().kind(),
        staged.record().content_hash(),
    ));
    fs::rename(&staging_path, &final_path).expect("simulate file publication before DB commit");
    let report = fixture
        .database()
        .reconcile_artifacts()
        .expect("reconcile commit gap");

    assert_eq!(report.promoted_pending, 1);
    assert_eq!(report.removed_unowned_media, 1);
    assert!(
        fixture
            .database()
            .get_artifact(artifact_id)
            .expect("cleaned artifact lookup")
            .is_none()
    );
    assert!(!final_path.exists());
    assert!(!staging_path.exists());
}

#[test]
fn missing_ready_files_fail_and_orphaned_files_are_removed_on_startup() {
    let mut fixture = Fixture::new();
    let resolved = publish(fixture.database(), "albumArt", b"image bytes");
    let id = resolved.record().id();
    remove_if_regular(resolved.path()).expect("simulate missing ready file");
    let orphan = fixture.artifact_root.join("unregistered-file");
    fs::write(&orphan, b"orphan").expect("write orphan");

    fixture.reopen();
    assert_eq!(
        fixture
            .database()
            .get_artifact(id)
            .expect("status")
            .expect("record")
            .state(),
        ArtifactState::Failed
    );
    assert!(!orphan.exists());
}

#[test]
fn publication_never_clobbers_a_conflicting_target() {
    let fixture = Fixture::new();
    let bytes = b"expected content";
    let staging = staging(
        fixture
            .database()
            .register_artifact(&draft("renderedVideo", bytes))
            .expect("register"),
    );
    fs::write(staging.path(), bytes).expect("write staging");
    let final_path = fixture.artifact_root.join(final_name(
        staging.record().kind(),
        staging.record().content_hash(),
    ));
    fs::write(&final_path, b"attacker content").expect("conflicting target");

    assert!(matches!(
        fixture.database().mark_artifact_ready(staging.record().id()),
        Err(DatabaseError::ArtifactContentMismatch(id)) if id == staging.record().id()
    ));
    assert_eq!(
        fs::read(final_path).expect("read conflict"),
        b"attacker content"
    );
}

#[test]
fn non_regular_staging_and_replaced_roots_are_rejected() {
    let mut fixture = Fixture::new();
    let staging = staging(
        fixture
            .database()
            .register_artifact(&draft("uploads", b"upload"))
            .expect("register"),
    );
    fs::remove_file(staging.path()).expect("remove staging file");
    fs::create_dir(staging.path()).expect("replace staging with directory");
    assert!(matches!(
        fixture
            .database()
            .mark_artifact_ready(staging.record().id()),
        Err(DatabaseError::InvalidArtifactFile)
    ));

    fs::remove_dir(staging.path()).expect("remove staging directory");
    let moved_root = fixture.directory.path().join("moved-artifacts");
    fs::rename(&fixture.artifact_root, &moved_root).expect("replace artifact root");
    fs::create_dir(&fixture.artifact_root).expect("new root at same path");
    assert!(matches!(
        fixture.database().reconcile_artifacts(),
        Err(DatabaseError::InvalidArtifactRoot)
    ));
    fixture.close();
}

#[test]
fn symlink_staging_is_never_followed() {
    let fixture = Fixture::new();
    let staging = staging(
        fixture
            .database()
            .register_artifact(&draft("uploads", b"upload"))
            .expect("register"),
    );
    fs::remove_file(staging.path()).expect("remove staging");
    let outside = fixture.directory.path().join("outside");
    fs::write(&outside, b"upload").expect("outside fixture");
    if create_file_symlink(&outside, staging.path()).is_err() {
        return;
    }
    assert!(matches!(
        fixture
            .database()
            .mark_artifact_ready(staging.record().id()),
        Err(DatabaseError::InvalidArtifactFile)
    ));
    assert_eq!(fs::read(outside).expect("outside remains"), b"upload");
}
