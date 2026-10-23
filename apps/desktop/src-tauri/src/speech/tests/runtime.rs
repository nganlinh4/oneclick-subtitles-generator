//! Runtime construction, stop/restart ownership and per-backend lifecycle epochs.

use super::*;

#[test]
fn synthesis_concurrency_probe_tracks_overlap_and_releases_every_slot() {
    let probe = SynthesisConcurrencyProbe::default();
    let first = probe.enter();
    let second = probe.enter();
    assert_eq!(probe.peak(), 2);
    assert_eq!(probe.active.load(Ordering::Acquire), 2);
    drop(first);
    drop(second);
    assert_eq!(probe.active.load(Ordering::Acquire), 0);
    assert_eq!(probe.peak(), 2);
}

#[test]
fn production_constructor_creates_the_optional_f5_model_store_before_canonicalizing_it() {
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("work");
    fs::create_dir_all(&work).unwrap();
    let authority = RuntimeStagingAuthority::prepare(&work.join("authority")).unwrap();
    let install = directory.path().join("fresh-install");
    let runtime =
        SpeechRuntime::new_with_staging_authority(&install, &work, None, authority).unwrap();
    assert!(runtime.0.model_store.is_dir());
}

#[test]
fn runtime_stop_invalidates_in_flight_probe_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::EdgeTts;
    let before_stop = runtime.lifecycle_epoch(backend).unwrap();
    let voices = vec![SpeechVoiceResponse {
        id: "en-US-Test".to_owned(),
        display_name: "Test voice".to_owned(),
        language: "en-US".to_owned(),
        gender: SpeechVoiceGenderResponse::Neutral,
    }];
    assert!(runtime.commit_voice_inventory_for_epoch(backend, before_stop, voices.clone()));
    let lifecycle_cancellation = runtime
        .require_enabled_lifecycle(backend, before_stop)
        .unwrap();

    runtime.shutdown(backend).unwrap();

    let after_stop = runtime.lifecycle_epoch(backend).unwrap();
    assert_ne!(before_stop, after_stop);
    assert!(lifecycle_cancellation.is_cancelled());
    assert!(!runtime.commit_voice_inventory_for_epoch(backend, before_stop, voices));
    let lifecycle = runtime.lifecycle(backend).unwrap();
    assert!(!lifecycle.enabled);
    assert!(lifecycle.voices.is_none());
    assert!(matches!(
        runtime.require_enabled_lifecycle(backend, before_stop),
        Err(SpeechError::Cancelled)
    ));
    assert!(
        runtime
            .enabled_worker_for_epoch(backend, before_stop)
            .is_err()
    );
    assert!(runtime.0.workers.lock().unwrap().is_empty());
}

#[test]
fn replacement_cancels_epoch_before_waiting_for_busy_worker_shutdown() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::EdgeTts;
    let epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
    let old_cancellation = runtime.require_enabled_lifecycle(backend, epoch).unwrap();
    let (shutdown_started_tx, shutdown_started_rx) = std::sync::mpsc::channel();
    let (release_shutdown_tx, release_shutdown_rx) = std::sync::mpsc::channel();
    let replacement_runtime = runtime.clone();
    let replacement = std::thread::spawn(move || {
        replacement_runtime.invalidate_replacement_before_shutdown(backend, epoch, || {
            shutdown_started_tx.send(()).unwrap();
            release_shutdown_rx.recv().unwrap();
        })
    });

    shutdown_started_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(old_cancellation.is_cancelled());
    let invalidated = runtime.lifecycle(backend).unwrap();
    assert!(invalidated.epoch > epoch);
    assert!(!invalidated.enabled);
    assert!(invalidated.voices.is_none());
    release_shutdown_tx.send(()).unwrap();
    assert_eq!(replacement.join().unwrap().unwrap(), invalidated.epoch);
}

#[test]
fn delayed_conversion_owner_cannot_cross_stop_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::Chatterbox;
    let original_epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(backend, original_epoch, Vec::new()));
    let captured = runtime
        .require_enabled_lifecycle(backend, original_epoch)
        .unwrap();

    runtime.shutdown(backend).unwrap();
    let restarted_epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(backend, restarted_epoch, Vec::new()));

    assert!(captured.is_cancelled());
    assert_ne!(original_epoch, restarted_epoch);
    assert!(
        runtime
            .require_enabled_lifecycle(backend, original_epoch)
            .is_err()
    );
    assert!(
        runtime
            .require_enabled_lifecycle(backend, restarted_epoch)
            .is_ok()
    );
}

#[test]
fn speech_and_conversion_stop_during_registration_never_return_running() {
    for backend in [SpeechBackendRequest::Gtts, SpeechBackendRequest::Chatterbox] {
        let fixture = SpeechTestFixture::new();
        run_async_speech_test(assert_stop_during_registration_is_rejected(
            &fixture, backend,
        ));
    }
}

#[test]
fn manifest_precommit_stalls_allow_cross_backend_reentry_and_stop() {
    for backend in [SpeechBackendRequest::Gtts, SpeechBackendRequest::Chatterbox] {
        let fixture = SpeechTestFixture::new();
        run_async_speech_test(assert_manifest_precommit_stall_is_backend_isolated(
            &fixture, backend,
        ));
    }
}

#[test]
fn same_backend_stop_waits_for_the_exact_commit_gate() {
    let fixture = SpeechTestFixture::new();
    let backend = SpeechBackendRequest::Gtts;
    let ownership = fixture.enable(backend);
    let slot = fixture.runtime.lifecycle_slot(backend).unwrap();
    let commit = slot.commit_gate.lock().unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let stop_runtime = fixture.runtime.clone();
    let stopper = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        stop_runtime.shutdown(backend).unwrap();
        finished_tx.send(()).unwrap();
    });

    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(finished_rx.recv_timeout(Duration::from_millis(50)).is_err());
    assert!(ownership.ensure_current(&fixture.runtime).is_ok());
    drop(commit);
    finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    stopper.join().unwrap();
    assert!(ownership.ensure_current(&fixture.runtime).is_err());
}

#[test]
fn lifecycle_cancellation_is_isolated_by_backend() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let chatterbox = SpeechBackendRequest::Chatterbox;
    let edge = SpeechBackendRequest::EdgeTts;
    let chatterbox_epoch = runtime.lifecycle_epoch(chatterbox).unwrap();
    let edge_epoch = runtime.lifecycle_epoch(edge).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(chatterbox, chatterbox_epoch, Vec::new()));
    assert!(runtime.commit_voice_inventory_for_epoch(edge, edge_epoch, Vec::new()));
    let chatterbox_owner = runtime
        .require_enabled_lifecycle(chatterbox, chatterbox_epoch)
        .unwrap();
    let edge_owner = runtime.require_enabled_lifecycle(edge, edge_epoch).unwrap();

    runtime.shutdown(edge).unwrap();

    assert!(edge_owner.is_cancelled());
    assert!(!chatterbox_owner.is_cancelled());
    assert!(
        runtime
            .require_enabled_lifecycle(chatterbox, chatterbox_epoch)
            .is_ok()
    );
}

#[test]
fn worker_join_failure_invalidates_batch_and_conversion_owners() {
    for backend in [SpeechBackendRequest::Gtts, SpeechBackendRequest::Chatterbox] {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
        let owner = runtime.require_enabled_lifecycle(backend, epoch).unwrap();

        let result = worker_join_result::<(), _>(&runtime, backend, epoch, Err("join failed"));

        assert!(matches!(result, Err(SpeechFailureCode::WorkerFailed)));
        assert!(owner.is_cancelled());
        let lifecycle = runtime.lifecycle(backend).unwrap();
        assert!(lifecycle.epoch > epoch);
        assert!(!lifecycle.enabled);
        assert!(lifecycle.voices.is_none());
    }
}

#[test]
fn probe_join_failure_invalidates_the_actual_epoch_but_not_a_restarted_epoch() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::EdgeTts;
    let other_backend = SpeechBackendRequest::Gtts;
    let requested_epoch = runtime.lifecycle_epoch(backend).unwrap();
    let actual_epoch = runtime
        .invalidate_lifecycle(backend, Some(requested_epoch))
        .unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(backend, actual_epoch, Vec::new()));
    let actual_owner = runtime
        .require_enabled_lifecycle(backend, actual_epoch)
        .unwrap();
    let other_epoch = runtime.lifecycle_epoch(other_backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(other_backend, other_epoch, Vec::new()));
    let other_owner = runtime
        .require_enabled_lifecycle(other_backend, other_epoch)
        .unwrap();
    insert_cached_test_worker(&runtime, backend, &directory.path().join("actual.py"));
    let ownership = ProbeLifecycleOwnership::new(requested_epoch);
    ownership.update(actual_epoch);

    let result = probe_join_result::<(), _>(&runtime, backend, &ownership, Err("join"));

    assert!(result.is_err());
    assert!(actual_owner.is_cancelled());
    assert!(!other_owner.is_cancelled());
    assert!(!runtime.0.workers.lock().unwrap().contains_key(&backend));
    let invalidated_epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(invalidated_epoch > actual_epoch);

    assert!(runtime.commit_voice_inventory_for_epoch(backend, invalidated_epoch, Vec::new()));
    let restarted_owner = runtime
        .require_enabled_lifecycle(backend, invalidated_epoch)
        .unwrap();
    insert_cached_test_worker(&runtime, backend, &directory.path().join("restarted.py"));
    ownership.update(actual_epoch);

    let stale_result = probe_join_result::<(), _>(&runtime, backend, &ownership, Err("stale join"));

    assert!(stale_result.is_err());
    assert!(!restarted_owner.is_cancelled());
    assert_eq!(runtime.lifecycle_epoch(backend).unwrap(), invalidated_epoch);
    assert!(runtime.0.workers.lock().unwrap().contains_key(&backend));
}

#[test]
fn voice_inventory_never_creates_or_starts_a_stopped_worker() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::Gtts;
    let epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(
        backend,
        epoch,
        vec![SpeechVoiceResponse {
            id: "en".to_owned(),
            display_name: "English".to_owned(),
            language: "en".to_owned(),
            gender: SpeechVoiceGenderResponse::Unknown,
        }],
    ));
    assert!(runtime.0.workers.lock().unwrap().is_empty());

    assert!(runtime.voice_inventory(backend, epoch).is_err());
    assert!(runtime.0.workers.lock().unwrap().is_empty());

    runtime.shutdown(backend).unwrap();
    assert!(runtime.voice_inventory(backend, epoch).is_err());
    assert!(runtime.0.workers.lock().unwrap().is_empty());
}

#[test]
fn unhealthy_worker_invalidation_advances_epoch_and_drops_inventory() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::Chatterbox;
    let epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
    let lifecycle_cancellation = runtime.require_enabled_lifecycle(backend, epoch).unwrap();

    let next_epoch = runtime
        .invalidate_backend_runtime(backend, Some(epoch))
        .unwrap();

    assert_ne!(epoch, next_epoch);
    assert!(lifecycle_cancellation.is_cancelled());
    let lifecycle = runtime.lifecycle(backend).unwrap();
    assert_eq!(lifecycle.epoch, next_epoch);
    assert!(!lifecycle.enabled);
    assert!(lifecycle.voices.is_none());
}

#[test]
fn cached_worker_replacement_invalidates_the_owned_epoch() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SpeechRuntime::new(
        directory.path().join("install"),
        directory.path().join("work"),
        None,
    )
    .unwrap();
    let backend = SpeechBackendRequest::F5Tts;
    let epoch = runtime.lifecycle_epoch(backend).unwrap();
    assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
    let lifecycle_cancellation = runtime.require_enabled_lifecycle(backend, epoch).unwrap();
    let executable = std::env::current_exe().unwrap();
    let worker = Arc::new(ManagedSpeechWorker {
        worker: LazySpeechWorker::new(
            WorkerProgram::native(&executable).unwrap(),
            backend.native(),
        ),
        managed_runtime: None,
    });
    runtime.0.workers.lock().unwrap().insert(
        backend,
        CachedWorker {
            paths: WorkerPaths {
                python: executable,
                bootstrap: directory.path().join("replaced-worker.py"),
                model: None,
                model_store: None,
            },
            worker,
        },
    );

    let status = runtime.status(backend);

    assert!(status.epoch > epoch);
    assert!(!status.enabled);
    assert!(!status.ready);
    assert!(!status.warm);
    assert!(lifecycle_cancellation.is_cancelled());
    assert!(runtime.0.workers.lock().unwrap().is_empty());
}

#[test]
fn debug_formatting_never_resolves_or_invalidates_runtimes() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let backend = SpeechBackendRequest::EdgeTts;
    let epoch = runtime.lifecycle_epoch(backend).unwrap();
    // Enabled without a cached worker: a status read would treat this backend as dead.
    assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));

    let rendered = format!("{runtime:?}");

    assert_eq!(rendered, "SpeechRuntime { .. }");
    assert_eq!(runtime.lifecycle_epoch(backend).unwrap(), epoch);
    assert!(runtime.require_enabled_lifecycle(backend, epoch).is_ok());
}
