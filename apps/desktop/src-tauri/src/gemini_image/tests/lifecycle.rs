//! Restart recovery, idempotent completion and cancellation/completion races.

use super::*;

#[test]
fn generated_images_survive_restart_and_wrong_projects_cannot_resolve_or_delete() {
    let (directory, database_path, database, project_id, job_id) = fixture();
    let other = ProjectMetadata::new("other project").expect("other project");
    let other_id = other.id();
    database.create_project(&other).expect("create other");
    let bytes = png(b"durable image");
    let (published, created) = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &bytes,
        write_staged_image,
    )
    .expect("publish");
    assert!(created);
    let artifact_id = published.record().id();
    let (other_published, other_created) = publish_generated_image(
        &database,
        other_id,
        job_id,
        "image/png",
        &bytes,
        write_staged_image,
    )
    .expect("publish identical content for other project");
    assert!(other_created);
    assert_ne!(other_published.record().id(), artifact_id);
    assert!(resolve_owned_image(&database, other_id, artifact_id).is_err());
    succeed_job(&database, job_id);
    let published = commit_prepared(&database, &published);
    let other_published = commit_prepared(&database, &other_published);
    drop(published);
    drop(other_published);
    drop(database);

    let reopened = Database::open(&database_path).expect("reopen database");
    let listed = list_generated_images(&reopened, project_id).expect("list after restart");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].artifact_id, artifact_id);
    assert_eq!(
        list_generated_images(&reopened, other_id)
            .expect("list other project after restart")
            .len(),
        1
    );
    assert!(resolve_owned_image(&reopened, other_id, artifact_id).is_err());
    assert!(
        resolve_owned_image(&reopened, project_id, artifact_id)
            .expect("resolve owned")
            .is_some()
    );
    let export = prepare_image_export(
        &reopened,
        GeneratedImageExportRequest {
            project_id,
            artifact_id: artifact_id.to_string(),
            suggested_name: "background-1.png".to_owned(),
        },
    )
    .expect("prepare export after restart");
    assert_eq!(fs::read(export.staging.path()).expect("read export"), bytes);
    assert!(!format!("{export:?}").contains(directory.path().to_string_lossy().as_ref()));
    assert!(
        prepare_image_export(
            &reopened,
            GeneratedImageExportRequest {
                project_id: other_id,
                artifact_id: artifact_id.to_string(),
                suggested_name: "background-1.png".to_owned(),
            },
        )
        .is_err()
    );
    drop(reopened);
    drop(directory);
}

#[test]
fn a_real_restart_before_ack_interrupts_the_job_and_removes_the_provisional_image() {
    let (_directory, database_path, database, project_id, job_id) = fixture();
    let jobs = JobRegistry::restore(Arc::new(database.clone())).expect("jobs");
    jobs.apply(job_id, JobUpdate::Start).expect("running job");
    drop(jobs);
    let prepared = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &png(b"crash before acknowledgement"),
        write_staged_image,
    )
    .expect("provisional publication")
    .0;
    let artifact_id = prepared.record().id();
    let staging_path = prepared.path().to_path_buf();
    assert_eq!(
        database
            .get_artifact(artifact_id)
            .unwrap()
            .expect("provisional row")
            .state(),
        ArtifactState::Pending
    );
    assert!(
        list_generated_images(&database, project_id)
            .unwrap()
            .is_empty()
    );
    assert!(resolve_owned_image(&database, project_id, artifact_id).is_err());
    assert!(
        prepare_image_export(
            &database,
            GeneratedImageExportRequest {
                project_id,
                artifact_id: artifact_id.to_string(),
                suggested_name: "provisional.png".to_owned(),
            },
        )
        .is_err()
    );
    drop(prepared);
    drop(database);

    let reopened = Database::open(&database_path).expect("restart database");
    assert!(reopened.get_artifact(artifact_id).unwrap().is_none());
    assert!(!staging_path.exists());
    assert!(
        list_generated_images(&reopened, project_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        reopened
            .get_job(job_id)
            .unwrap()
            .expect("interrupted job")
            .state(),
        JobState::Interrupted
    );
}

#[tokio::test]
async fn completion_is_idempotently_recovered_after_its_response_is_lost() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
    let running = background::apply(&jobs, job_id, JobUpdate::Start)
        .await
        .expect("running job");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let runtime = GeneratedImageRuntime::default();
    let published = stage_pending_image(
        &database,
        &media_server,
        &runtime,
        project_id,
        job_id,
        running.sequence(),
        &png(b"lost acknowledgement response"),
    );
    let artifact_id = published.image.artifact.artifact_id;
    let playback_id = published.image.playback.id;
    let succeeded =
        background::apply_if_sequence(&jobs, job_id, running.sequence(), JobUpdate::Succeed)
            .await
            .expect("acknowledgement wins");

    finalize_pending_completion_parts(&database, &runtime, job_id, &succeeded)
        .await
        .expect("first completion response is lost");
    finalize_pending_completion_parts(&database, &runtime, job_id, &succeeded)
        .await
        .expect("duplicate completion is idempotent");
    runtime
        .access(|registry| {
            registry.completed_by_job.clear();
            Ok(())
        })
        .expect("simulate receipt loss");
    let recovered = recover_completed_image(
        &database,
        &jobs,
        &GeneratedImageRuntime::default(),
        job_id,
        project_id,
        artifact_id,
        playback_id,
    )
    .await
    .expect("durable completion recovery");
    assert_eq!(recovered, succeeded);
    assert_eq!(
        list_generated_images(&database, project_id).unwrap().len(),
        1
    );
}

#[tokio::test]
async fn cancellation_and_completion_have_one_winner_and_cleanup_matches_that_winner() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
    let running = background::apply(&jobs, job_id, JobUpdate::Start)
        .await
        .expect("running job");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let runtime = GeneratedImageRuntime::default();
    let cancelled_publication = stage_pending_image(
        &database,
        &media_server,
        &runtime,
        project_id,
        job_id,
        running.sequence(),
        &png(b"cancellation wins"),
    );
    background::apply(&jobs, job_id, JobUpdate::RequestCancellation)
        .await
        .expect("persist cancellation");
    assert!(
        background::apply_if_sequence(&jobs, job_id, running.sequence(), JobUpdate::Succeed,)
            .await
            .is_err()
    );
    let cancelled =
        invalidate_pending_completion_parts(&jobs, &database, &media_server, &runtime, job_id)
            .await
            .expect("cancelled snapshot");
    assert_eq!(cancelled.state(), JobState::Cancelled);
    assert!(
        database
            .get_artifact(cancelled_publication.image.artifact.artifact_id)
            .unwrap()
            .is_none()
    );
    assert!(
        !media_server
            .unregister(cancelled_publication.image.playback.id)
            .unwrap()
    );

    let second = JobSnapshot::new(JobKind::GenerateImage);
    let second_id = second.id();
    database.create_job(&second).expect("second job");
    let second_running = background::apply(&jobs, second_id, JobUpdate::Start)
        .await
        .expect("second running job");
    let completed_publication = stage_pending_image(
        &database,
        &media_server,
        &runtime,
        project_id,
        second_id,
        second_running.sequence(),
        &png(b"completion wins"),
    );
    let succeeded = background::apply_if_sequence(
        &jobs,
        second_id,
        second_running.sequence(),
        JobUpdate::Succeed,
    )
    .await
    .expect("completion wins");
    assert!(
        background::apply(&jobs, second_id, JobUpdate::RequestCancellation)
            .await
            .is_err()
    );
    let observed =
        invalidate_pending_completion_parts(&jobs, &database, &media_server, &runtime, second_id)
            .await
            .expect("successful snapshot");
    assert_eq!(observed, succeeded);
    assert!(
        resolve_owned_image(
            &database,
            project_id,
            completed_publication.image.artifact.artifact_id,
        )
        .unwrap()
        .is_some()
    );
    assert!(
        media_server
            .unregister_owned_image(
                completed_publication.image.playback.id,
                project_id.into_uuid(),
            )
            .unwrap()
    );
}
