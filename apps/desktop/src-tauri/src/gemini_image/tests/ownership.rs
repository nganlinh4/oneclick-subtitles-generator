//! Playback release and project ownership of library operations.

use super::*;

#[tokio::test]
async fn unreported_deduplicated_image_releases_only_its_playback() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    let jobs =
        Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("restore job registry"));
    background::apply(&jobs, job_id, JobUpdate::Start)
        .await
        .expect("start job");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let runtime = GeneratedImageRuntime::default();
    let bytes = png(b"deduplicated completion");
    let owner = JobSnapshot::new(JobKind::GenerateImage);
    let owner_id = owner.id();
    database.create_job(&owner).expect("owner job");
    let original = publish_generated_image(
        &database,
        project_id,
        owner_id,
        "image/png",
        &bytes,
        write_staged_image,
    )
    .expect("publish original")
    .0;
    succeed_job(&database, owner_id);
    let original = commit_prepared(&database, &original);
    let artifact_id = original.record().id();
    let duplicate = runtime
        .access(|registry| {
            publish_and_register_image(
                &database,
                &media_server,
                registry,
                project_id,
                job_id,
                "image/png",
                &bytes,
            )
        })
        .expect("reuse original");
    let playback_id = duplicate.image.playback.id;
    assert!(!duplicate.newly_created);
    runtime
        .access(|registry| {
            registry.pending_by_job.insert(
                job_id,
                PendingGeneratedImage {
                    published: duplicate,
                    expected_job_sequence: 1,
                },
            );
            Ok(())
        })
        .expect("stage deduplicated completion");

    fail_pending_completion_parts(&jobs, &database, &media_server, &runtime, job_id).await;

    assert!(database.get_artifact(artifact_id).unwrap().is_some());
    assert!(
        resolve_owned_image(&database, project_id, artifact_id)
            .unwrap()
            .is_some()
    );
    assert!(
        !media_server
            .unregister(playback_id)
            .expect("playback revoked")
    );
    assert_eq!(
        database
            .get_job(job_id)
            .unwrap()
            .expect("durable job")
            .state(),
        JobState::Failed
    );
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the ownership lifecycle is intentionally exercised as one ordered end-to-end scenario"
)]
fn delete_clear_and_playback_registry_enforce_project_ownership() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let mut registry = GeneratedImageRegistry::default();
    let other = ProjectMetadata::new("other project").expect("other project");
    let other_id = other.id();
    database.create_project(&other).expect("create other");
    let first = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &png(b"first"),
        write_staged_image,
    )
    .expect("first")
    .0;
    let second = publish_generated_image(
        &database,
        project_id,
        job_id,
        "image/png",
        &png(b"second"),
        write_staged_image,
    )
    .expect("second")
    .0;
    succeed_job(&database, job_id);
    let first = commit_prepared(&database, &first);
    let second = commit_prepared(&database, &second);
    let first_id = first.record().id();
    let second_id = second.record().id();
    let first_playable =
        register_playable_image(&media_server, &mut registry, &first).expect("first playback");
    let duplicate_playable =
        register_playable_image(&media_server, &mut registry, &first).expect("duplicate playback");
    let second_playable =
        register_playable_image(&media_server, &mut registry, &second).expect("second playback");
    assert!(resolve_owned_image(&database, other_id, first_id).is_err());
    assert_eq!(
        list_generated_images(&database, project_id).unwrap().len(),
        2
    );
    assert_eq!(list_generated_images(&database, other_id).unwrap().len(), 0);

    assert!(
        release_generated_image_playback(
            &mut registry,
            &media_server,
            project_id,
            first_id,
            duplicate_playable.playback.id,
        )
        .expect("release only duplicate")
    );
    let first_entry = registry
        .by_artifact
        .get(&first_id)
        .expect("first playback remains");
    assert!(
        first_entry
            .playback_ids
            .contains(&first_playable.playback.id)
    );
    assert!(
        !first_entry
            .playback_ids
            .contains(&duplicate_playable.playback.id)
    );

    assert!(
        release_generated_image_playback(
            &mut registry,
            &media_server,
            other_id,
            first_id,
            first_playable.playback.id,
        )
        .is_err()
    );
    assert!(registry.by_artifact.contains_key(&first_id));
    assert!(
        delete_generated_image(&database, &media_server, &mut registry, other_id, first_id,)
            .is_err()
    );
    assert!(database.get_artifact(first_id).unwrap().is_some());

    assert!(
        delete_generated_image(
            &database,
            &media_server,
            &mut registry,
            project_id,
            first_id,
        )
        .expect("delete first")
    );
    assert!(!registry.by_artifact.contains_key(&first_id));
    assert_eq!(
        list_generated_images(&database, project_id).unwrap().len(),
        1
    );
    assert_eq!(
        clear_generated_images(&database, &media_server, &mut registry, other_id,)
            .expect("clear other"),
        0
    );
    assert!(database.get_artifact(second_id).unwrap().is_some());
    assert_eq!(
        clear_generated_images(&database, &media_server, &mut registry, project_id,)
            .expect("clear project"),
        1
    );
    assert!(!registry.by_artifact.contains_key(&second_id));
    assert!(
        !media_server
            .unregister(second_playable.playback.id)
            .expect("already released")
    );
    assert!(
        list_generated_images(&database, project_id)
            .unwrap()
            .is_empty()
    );
}
