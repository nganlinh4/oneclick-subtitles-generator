//! Publication retries and rollback of provisional images.

use super::*;

#[tokio::test]
async fn identical_provisional_jobs_never_share_and_a_late_rollback_cannot_delete_the_retry() {
    let (_directory, _database_path, database, project_id, first_id) = fixture();
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
    let first_running = background::apply(&jobs, first_id, JobUpdate::Start)
        .await
        .expect("first running job");
    let second = JobSnapshot::new(JobKind::GenerateImage);
    let second_id = second.id();
    database.create_job(&second).expect("second job");
    let second_running = background::apply(&jobs, second_id, JobUpdate::Start)
        .await
        .expect("second running job");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let runtime = GeneratedImageRuntime::default();
    let bytes = png(b"concurrent identical result");
    let first = stage_pending_image(
        &database,
        &media_server,
        &runtime,
        project_id,
        first_id,
        first_running.sequence(),
        &bytes,
    );
    let duplicate_error = runtime
        .access(|registry| {
            publish_and_register_image(
                &database,
                &media_server,
                registry,
                project_id,
                second_id,
                "image/png",
                &bytes,
            )
        })
        .expect_err("unacknowledged ownership is never shared");
    assert_eq!(duplicate_error.code(), "invalidInput");

    background::apply(&jobs, first_id, JobUpdate::RequestCancellation)
        .await
        .expect("cancel first");
    invalidate_pending_completion_parts(&jobs, &database, &media_server, &runtime, first_id).await;
    let second_publication = stage_pending_image(
        &database,
        &media_server,
        &runtime,
        project_id,
        second_id,
        second_running.sequence(),
        &bytes,
    );
    let second_success = background::apply_if_sequence(
        &jobs,
        second_id,
        second_running.sequence(),
        JobUpdate::Succeed,
    )
    .await
    .expect("retry succeeds");
    finalize_pending_completion_parts(&database, &runtime, second_id, &second_success)
        .await
        .expect("commit retry");

    rollback_published_image(&database, &media_server, &runtime, &first)
        .await
        .expect("late first rollback is idempotent");
    assert_ne!(
        first.image.artifact.artifact_id,
        second_publication.image.artifact.artifact_id
    );
    assert!(
        resolve_owned_image(
            &database,
            project_id,
            second_publication.image.artifact.artifact_id,
        )
        .unwrap()
        .is_some()
    );
    assert!(
        media_server
            .unregister_owned_image(second_publication.image.playback.id, project_id.into_uuid(),)
            .unwrap()
    );
}

#[test]
fn partial_publication_is_rolled_back_and_can_be_retried_without_an_orphan() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    let bytes = png(b"partial failure");
    let failed = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &bytes,
        |path, bytes| {
            fs::write(path, &bytes[..8])?;
            Err(io::Error::other("injected write failure"))
        },
    );
    assert!(failed.is_err());
    assert!(
        list_generated_images(&database, project_id)
            .expect("list after failure")
            .is_empty()
    );

    let (retried, created) = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &bytes,
        write_staged_image,
    )
    .expect("retry publication");
    assert!(created);
    assert_eq!(fs::read(retried.path()).expect("read retry"), bytes);
}

#[test]
fn a_failed_legacy_publication_record_cannot_poison_a_retry() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    let bytes = png(b"recover failed record");
    let draft = ArtifactDraft::new(
        artifact_kind(project_id).expect("artifact kind"),
        ContentHash::digest(&bytes),
        u64::try_from(bytes.len()).expect("bounded image size"),
        json!({"mimeType": "image/png"}),
    )
    .expect("draft")
    .with_project(project_id)
    .with_job(job_id);
    let ArtifactRegistration::Staging(staging) =
        database.register_artifact(&draft).expect("failed staging")
    else {
        panic!("new content must stage");
    };
    let failed_id = staging.record().id();
    database
        .mark_artifact_failed(
            failed_id,
            &ArtifactFailureCode::new("injectedFailure").expect("failure code"),
        )
        .expect("mark failed");

    let (retried, created) = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &bytes,
        write_staged_image,
    )
    .expect("retry failed record");
    assert!(created);
    // Storage recycles the failed row into a fresh staging reservation instead of
    // stranding it, so the retry keeps the identifier. What must not survive is the
    // failed attempt's residue: state, failure code, job binding, metadata, and the
    // staged bytes all belong to the retry.
    assert_eq!(retried.record().id(), failed_id);
    assert_eq!(retried.record().state(), ArtifactState::Pending);
    assert_eq!(retried.record().failure_code(), None);
    assert_eq!(retried.record().job_id(), Some(job_id));
    assert_eq!(
        retried.record().metadata()[COMMIT_ON_JOB_SUCCESS_METADATA_KEY],
        json!(true)
    );
    assert_eq!(fs::read(retried.path()).expect("staged retry"), bytes);

    succeed_job(&database, job_id);
    let committed = commit_prepared(&database, &retried);
    assert_eq!(committed.record().state(), ArtifactState::Ready);
    assert_eq!(committed.record().failure_code(), None);
    assert_eq!(fs::read(committed.path()).expect("committed retry"), bytes);
    assert_eq!(
        list_generated_images(&database, project_id).expect("recovered image"),
        vec![descriptor_from_record(committed.record(), project_id).expect("descriptor")]
    );
}

#[test]
fn playback_registration_failure_rolls_back_the_new_durable_artifact() {
    let (directory, _database_path, database, project_id, job_id) = fixture();
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let filler = directory.path().join("filler-image");
    fs::write(&filler, png(b"filler")).expect("filler image");
    let mut registered = 0_usize;
    while registered < 300
        && media_server
            .register_image_file(&filler, "image/png")
            .is_ok()
    {
        registered += 1;
    }
    assert!(
        registered > 0 && registered < 300,
        "media registry must fill"
    );

    let mut registry = GeneratedImageRegistry::default();
    assert!(
        publish_and_register_image(
            &database,
            &media_server,
            &mut registry,
            project_id,
            job_id,
            "image/png",
            &png(b"must roll back"),
        )
        .is_err()
    );
    assert!(
        list_generated_images(&database, project_id)
            .expect("list after registration failure")
            .is_empty()
    );
    assert!(registry.by_artifact.is_empty());
}

#[tokio::test]
async fn unreported_prepared_image_rolls_back_artifact_playback_and_job_across_restart() {
    let (_directory, database_path, database, project_id, job_id) = fixture();
    let jobs =
        Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("restore job registry"));
    background::apply(&jobs, job_id, JobUpdate::Start)
        .await
        .expect("start job");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let runtime = GeneratedImageRuntime::default();
    let published = runtime
        .access(|registry| {
            publish_and_register_image(
                &database,
                &media_server,
                registry,
                project_id,
                job_id,
                "image/png",
                &png(b"unreported completion"),
            )
        })
        .expect("publish prepared image");
    let artifact_id = published.image.artifact.artifact_id;
    let playback_id = published.image.playback.id;
    assert!(published.newly_created);
    runtime
        .access(|registry| {
            registry.pending_by_job.insert(
                job_id,
                PendingGeneratedImage {
                    published: published.clone(),
                    expected_job_sequence: 1,
                },
            );
            Ok(())
        })
        .expect("stage pending completion");

    fail_pending_completion_parts(&jobs, &database, &media_server, &runtime, job_id).await;

    assert!(database.get_artifact(artifact_id).unwrap().is_none());
    assert!(
        !media_server
            .unregister(playback_id)
            .expect("playback revoked")
    );
    drop(jobs);
    drop(database);
    let reopened = Database::open(&database_path).expect("restart database");
    assert!(
        list_generated_images(&reopened, project_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        reopened
            .get_job(job_id)
            .unwrap()
            .expect("durable job")
            .state(),
        JobState::Failed
    );
}
