//! Artifact publication gates, rollback across stops and durable reopen.

use super::*;

#[test]
fn stop_after_durable_copy_rolls_back_artifact_and_manifest_before_restart_publication() {
    let fixture = SpeechTestFixture::new();
    let runtime = &fixture.runtime;
    let database = &fixture.database;
    let jobs = &fixture.jobs;
    let backend = SpeechBackendRequest::Gtts;
    let ownership = fixture.enable(backend);
    let job_id = fixture.running_job(backend);
    let source = fixture.directory.path().join("completed.wav");
    fs::write(&source, b"completed worker output").unwrap();
    let restarted_epoch = std::cell::Cell::new(None);
    let event_published = std::cell::Cell::new(false);

    let result = commit_completed_speech_source_with_hook(
        runtime,
        &ownership,
        database,
        &source,
        test_artifact_metadata("hostileStopTest"),
        None,
        job_id,
        "one".to_owned(),
        "narrationOutput",
        |published| {
            assert!(published.created);
            assert!(database.resolve_artifact(published.id).unwrap().is_some());
            runtime.shutdown(backend).unwrap();
            let epoch = runtime.lifecycle_epoch(backend).unwrap();
            assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
            assert!(database.resolve_artifact(published.id).unwrap().is_some());
            restarted_epoch.set(Some(epoch));
        },
        |_| event_published.set(true),
    );

    assert!(
        restarted_epoch.get().is_some(),
        "the publication hook did not run"
    );
    match result {
        Err(code) => assert_eq!(code, SpeechFailureCode::Cancelled),
        Ok(_) => panic!("the stale publication unexpectedly committed"),
    }
    assert!(!event_published.get());
    assert!(read_manifest(database, job_id).unwrap().results.is_empty());
    let fresh = publish_durable_artifact(
        runtime,
        database,
        Some(job_id),
        "narrationOutput",
        &source,
        test_artifact_metadata("hostileStopTest"),
    )
    .unwrap();
    assert!(fresh.created);
    rollback_published_speech_artifact(database, &fresh).unwrap();
    let epoch = restarted_epoch.get().unwrap();
    let restarted = runtime.require_enabled_lifecycle(backend, epoch).unwrap();
    assert!(!restarted.is_cancelled());
    assert!(matches!(
        ownership.commit_job_success(runtime, jobs, job_id),
        Err(SpeechFailureCode::Cancelled)
    ));
    assert_eq!(
        jobs.get(job_id).unwrap().snapshot().state(),
        JobState::Running
    );
}

#[test]
fn stopped_backend_rollback_cannot_delete_another_backends_identical_publication() {
    let fixture = SpeechTestFixture::new();
    let runtime = &fixture.runtime;
    let database = &fixture.database;
    let stopped_backend = SpeechBackendRequest::Gtts;
    let live_backend = SpeechBackendRequest::EdgeTts;
    let stopped_ownership = fixture.enable(stopped_backend);
    let live_ownership = fixture.enable(live_backend);
    let live_epoch = live_ownership.lifecycle_epoch;
    let stopped_job = fixture.running_job(stopped_backend);
    let live_job = fixture.running_job(live_backend);
    let source = fixture.directory.path().join("identical.wav");
    fs::write(&source, b"identical cross-backend speech output").unwrap();
    let blocked = spawn_blocked_speech_publication(
        runtime.clone(),
        stopped_ownership,
        database.clone(),
        source.clone(),
        stopped_job,
    );
    let stopped_artifact = blocked
        .artifact
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    runtime.shutdown(stopped_backend).unwrap();

    let live = spawn_live_speech_publication(
        runtime.clone(),
        live_ownership,
        database.clone(),
        source,
        live_job,
    );
    live.attempted.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        live.event.recv_timeout(Duration::from_millis(50)).is_err(),
        "the second backend crossed the first publication transaction"
    );

    blocked.release.send(()).unwrap();
    assert_eq!(
        blocked.handle.join().unwrap(),
        Err(SpeechFailureCode::Cancelled)
    );
    assert!(blocked.event.try_recv().is_err());
    assert!(
        read_manifest(database, stopped_job)
            .unwrap()
            .results
            .is_empty()
    );
    let live_result = live.handle.join().unwrap().unwrap();
    live.event.recv_timeout(Duration::from_secs(1)).unwrap();
    let StoredSpeechResult::Completed { artifact, .. } = &live_result else {
        panic!("the live backend did not publish its artifact");
    };
    assert_ne!(artifact.artifact_id, stopped_artifact.to_string());
    let live_artifact = parse_artifact_id(&artifact.artifact_id).unwrap();
    assert!(database.resolve_artifact(live_artifact).unwrap().is_some());
    assert_eq!(
        read_manifest(database, live_job).unwrap().results,
        vec![live_result]
    );
    assert!(
        runtime
            .require_enabled_lifecycle(live_backend, live_epoch)
            .is_ok()
    );
}

#[test]
fn different_content_publications_do_not_share_a_cross_backend_gate() {
    let fixture = SpeechTestFixture::new();
    let stopped_backend = SpeechBackendRequest::Gtts;
    let live_backend = SpeechBackendRequest::EdgeTts;
    let stopped_ownership = fixture.enable(stopped_backend);
    let live_ownership = fixture.enable(live_backend);
    let stopped_job = fixture.running_job(stopped_backend);
    let live_job = fixture.running_job(live_backend);
    let blocked_source = fixture.directory.path().join("blocked.wav");
    let live_source = fixture.directory.path().join("live.wav");
    fs::write(&blocked_source, b"blocked speech publication").unwrap();
    fs::write(&live_source, b"independent speech publication").unwrap();
    let blocked = spawn_blocked_speech_publication(
        fixture.runtime.clone(),
        stopped_ownership,
        fixture.database.clone(),
        blocked_source,
        stopped_job,
    );
    blocked
        .artifact
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    let live = spawn_live_speech_publication(
        fixture.runtime.clone(),
        live_ownership,
        fixture.database.clone(),
        live_source,
        live_job,
    );
    live.attempted.recv_timeout(Duration::from_secs(1)).unwrap();
    live.event.recv_timeout(Duration::from_secs(1)).unwrap();
    let live_result = live.handle.join().unwrap().unwrap();
    assert_eq!(
        read_manifest(&fixture.database, live_job).unwrap().results,
        vec![live_result]
    );

    fixture.runtime.shutdown(stopped_backend).unwrap();
    blocked.release.send(()).unwrap();
    assert_eq!(
        blocked.handle.join().unwrap(),
        Err(SpeechFailureCode::Cancelled)
    );
    assert!(blocked.event.try_recv().is_err());
    assert!(
        read_manifest(&fixture.database, stopped_job)
            .unwrap()
            .results
            .is_empty()
    );
}

#[test]
fn reference_publication_rechecks_the_size_bound_before_hashing() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
    let source = directory.path().join("oversized.wav");
    std::fs::File::create(&source)
        .unwrap()
        .set_len(MAX_REFERENCE_BYTES + 1)
        .unwrap();

    let result = publish_durable_artifact(
        &runtime,
        &database,
        None,
        "speechReference",
        &source,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: None,
            sample_rate_hz: None,
            channels: None,
            source: "nativeSelection",
        },
    );
    assert!(result.is_err());
}

#[test]
fn published_speech_artifact_survives_source_removal_and_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database_directory = directory.path().join("database");
    std::fs::create_dir_all(&database_directory).unwrap();
    let database_path = database_directory.join("osg.sqlite3");
    let source = directory.path().join("source.wav");
    let mut wav = Vec::with_capacity(46);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&38_u32.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&24_000_u32.to_le_bytes());
    wav.extend_from_slice(&48_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&2_u32.to_le_bytes());
    wav.extend_from_slice(&[0, 0]);
    std::fs::write(&source, &wav).unwrap();

    let database = Database::open(&database_path).unwrap();
    let published = publish_durable_artifact(
        &runtime,
        &database,
        None,
        "narrationOutput",
        &source,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(42),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "speechWorker",
        },
    )
    .unwrap();
    let artifact_id = parse_artifact_id(&published.descriptor.artifact_id).unwrap();
    std::fs::remove_file(&source).unwrap();
    assert_eq!(std::fs::read(&published.path).unwrap(), wav);
    assert!(published.path.extension().is_none());
    let media_server = osg_media_server::MediaServer::start(std::iter::empty()).unwrap();
    let playback = register_speech_playback(
        &media_server,
        &published.path,
        SpeechArtifactFormatResponse::Wav,
    )
    .unwrap();
    assert!(playback.mime_type.starts_with("audio/"));
    assert!(media_server.unregister(playback.id).unwrap());
    drop(database);

    let reopened = Database::open(&database_path).unwrap();
    let resolved = reopened.resolve_artifact(artifact_id).unwrap().unwrap();
    assert_eq!(std::fs::read(resolved.path()).unwrap(), wav);
    assert_eq!(resolved.record().kind().as_str(), "narrationOutput");
    let reopened_asset =
        resolve_audio_artifact(&reopened, &published.descriptor.artifact_id, false).unwrap();
    assert_eq!(reopened_asset.format(), AudioFormat::Wav);
    assert_eq!(reopened_asset.bytes(), u64::try_from(wav.len()).unwrap());
}
