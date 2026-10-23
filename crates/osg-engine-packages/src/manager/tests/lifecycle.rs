//! Install, launch lease, receipt, resume, and removal over one package lifecycle.

use super::*;
#[test]
fn install_launch_lease_and_remove_form_one_safe_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, false));
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = manager(&temp, fixture.catalog, fetcher, coordinator.clone());
    let progress = RecordedProgress::default();

    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Missing
    );
    let status = manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &progress)
        .unwrap();
    assert_eq!(status.state, EnginePackageState::Installed);
    assert!(status.installed);
    assert_eq!(status.installed_bytes, 19);
    let phases = progress
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|entry| entry.phase)
        .collect::<Vec<_>>();
    assert!(phases.contains(&OperationPhase::Downloading));
    assert!(phases.contains(&OperationPhase::Verifying));
    assert!(phases.contains(&OperationPhase::Extracting));
    assert!(phases.contains(&OperationPhase::Publishing));

    let runtime = manager
        .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
        .unwrap();
    assert!(runtime.python().ends_with("python.exe"));
    assert!(runtime.model().ends_with("model"));
    assert_eq!(
        manager.remove(EngineId::Parakeet, &CancellationToken::default(), &progress,),
        Err(PackageError::RuntimeBusy)
    );
    drop(runtime);
    assert_eq!(
        manager
            .remove(EngineId::Parakeet, &CancellationToken::default(), &progress,)
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Missing
    );
    assert_eq!(coordinator.calls.load(Ordering::Relaxed), 3);
}

#[test]
fn install_writes_a_durable_receipt_outside_the_published_tree_and_remove_clears_it() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, false));
    let manager = manager(
        &temp,
        fixture.catalog,
        fetcher,
        Arc::new(TestCoordinator::default()),
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let receipt = manager.0.0.root.join(".verified/parakeet/1.0.0.json");
    assert!(receipt.is_file());
    // It plays no part in the published tree's own exact-membership checks.
    let published = manager.0.0.root.join("parakeet/versions/1.0.0");
    assert!(!published.join(".verified").exists());

    // A fresh process (no in-memory `verified_versions` cache) resolves the engine for launch
    // by reading this receipt rather than by re-hashing the published tree's content.
    drop(manager);
    let restarted_fixture = self::fixture();
    let manager = self::manager(
        &temp,
        restarted_fixture.catalog,
        Arc::new(MemoryFetcher::new(restarted_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );

    assert_eq!(
        manager
            .remove(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert!(!receipt.exists());
}

#[test]
fn a_receipt_write_failure_is_reported_instead_of_silently_swallowed() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, false));
    let manager = manager(
        &temp,
        fixture.catalog,
        fetcher,
        Arc::new(TestCoordinator::default()),
    );
    assert!(!manager.receipt_write_degraded(EngineId::Parakeet));

    // Occupy the exact directory `verified_install::write` needs to create
    // (`.verified/<component>/`) with a plain file, so the write can never succeed no matter
    // how many times it is retried -- exactly the "permanently failing cache write" the
    // observability requirement exists for.
    let verified_root = manager.0.0.root.join(".verified");
    fs::create_dir_all(&verified_root).unwrap();
    fs::write(verified_root.join("parakeet"), b"not a directory").unwrap();

    let status = manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    // The best-effort receipt write never blocks the install it rides along with.
    assert_eq!(status.state, EnginePackageState::Installed);
    assert!(
        !manager
            .0
            .0
            .root
            .join(".verified/parakeet/1.0.0.json")
            .exists()
    );
    assert!(
        manager.receipt_write_degraded(EngineId::Parakeet),
        "a permanently failing receipt write must be reported, not silently swallowed"
    );

    // Clearing the obstruction and driving a fresh full verify (the in-memory
    // `verified_versions` cache from `install` is cleared first, exactly like a later process
    // starting cold) lets the next write succeed and clears the reported failure.
    fs::remove_file(verified_root.join("parakeet")).unwrap();
    manager.0.clear_verified(EngineId::Parakeet);
    let _ = manager.status(EngineId::Parakeet);
    assert!(
        !manager.receipt_write_degraded(EngineId::Parakeet),
        "a subsequent successful write must clear the previously reported failure"
    );
    assert!(
        manager
            .0
            .0
            .root
            .join(".verified/parakeet/1.0.0.json")
            .is_file()
    );
}

#[test]
fn interrupted_download_is_resumed_from_the_verified_partial() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, true));
    let manager = manager(
        &temp,
        fixture.catalog,
        fetcher.clone(),
        Arc::new(TestCoordinator::default()),
    );
    let first = CancellationToken::default();
    assert_eq!(
        manager.install(EngineId::Parakeet, &first, &|_| {}),
        Err(PackageError::Cancelled)
    );
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Missing
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let offsets = fetcher.offsets();
    assert_eq!(offsets.len(), 2);
    assert_eq!(offsets[0], 0);
    assert!(offsets[1] > 0);
    assert!(offsets[1] < fetcher.archive.len() as u64);
}

#[test]
fn transient_network_failures_retry_and_resume_in_one_install() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let fetcher = Arc::new(MemoryFetcher::with_transient_failures(fixture.archive, 2));
    let manager = manager(
        &temp,
        fixture.catalog,
        fetcher.clone(),
        Arc::new(TestCoordinator::default()),
    );

    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();

    let offsets = fetcher.offsets();
    assert_eq!(offsets.len(), 3);
    assert_eq!(offsets[0], 0);
    assert!(offsets.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(offsets[2] < fetcher.archive.len() as u64);
}

#[test]
fn speech_install_holds_a_runtime_lease_and_never_invents_a_model() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = speech_fixture();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = speech_manager(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        coordinator.clone(),
    );
    assert_eq!(
        manager.status(SpeechPackageId::EdgeTts).state,
        SpeechPackageState::Missing
    );
    manager
        .install(
            SpeechPackageId::EdgeTts,
            &CancellationToken::default(),
            &|_| {},
        )
        .unwrap();
    let runtime = manager
        .resolve_for_launch(SpeechPackageId::EdgeTts, &CancellationToken::default())
        .unwrap();
    assert_eq!(runtime.backend(), SpeechPackageId::EdgeTts);
    assert_eq!(runtime.version(), "1.0.0");
    assert!(runtime.python().ends_with("python.exe"));
    assert!(runtime.model().is_none());
    assert_eq!(
        manager.remove(
            SpeechPackageId::EdgeTts,
            &CancellationToken::default(),
            &|_| {},
        ),
        Err(PackageError::RuntimeBusy)
    );
    drop(runtime);
    assert_eq!(
        manager
            .remove(
                SpeechPackageId::EdgeTts,
                &CancellationToken::default(),
                &|_| {},
            )
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert_eq!(coordinator.calls.load(Ordering::Relaxed), 3);
}

#[test]
fn builtin_speech_catalog_exposes_only_published_platform_deliveries() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = SpeechPackageManager::new(temp.path(), coordinator.clone()).unwrap();
    for status in manager.statuses() {
        if crate::catalog::current_platform() == "windows-x86_64" {
            assert_eq!(status.state, SpeechPackageState::Missing);
            assert!(status.delivery_available);
        } else {
            assert_eq!(status.state, SpeechPackageState::Unavailable);
            assert!(!status.delivery_available);
        }
    }
    assert!(matches!(
        manager.resolve_for_launch(SpeechPackageId::Chatterbox, &CancellationToken::default(),),
        Err(PackageError::InvalidInstall)
    ));
    assert_eq!(coordinator.calls.load(Ordering::Relaxed), 0);
}

#[test]
fn builtin_asr_catalog_exposes_only_published_platform_deliveries() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = EnginePackageManager::new(temp.path(), coordinator.clone()).unwrap();
    for status in manager.statuses() {
        if crate::catalog::current_platform() == "windows-x86_64" {
            assert_eq!(status.state, EnginePackageState::Missing);
            assert!(status.delivery_available);
        } else {
            assert_eq!(status.state, EnginePackageState::Unavailable);
            assert!(!status.delivery_available);
        }
    }
    assert_eq!(coordinator.calls.load(Ordering::Relaxed), 0);
}

#[test]
#[ignore = "downloads the published Windows runtime and Parakeet model"]
fn published_parakeet_installs_launches_and_removes_over_https() {
    if crate::catalog::current_platform() != "windows-x86_64" {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = EnginePackageManager::new(temp.path(), coordinator).unwrap();
    let progress = RecordedProgress::default();
    let installed = manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &progress)
        .unwrap();
    assert_eq!(installed.state, EnginePackageState::Installed);
    let runtime = manager
        .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
        .unwrap();
    assert!(runtime.python().is_file());
    assert!(runtime.model().is_dir());
    drop(runtime);
    assert_eq!(
        manager
            .remove(EngineId::Parakeet, &CancellationToken::default(), &progress)
            .unwrap(),
        RemovalOutcome::Removed
    );
    let phases = progress
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|entry| entry.phase)
        .collect::<Vec<_>>();
    assert!(
        phases
            .windows(2)
            .all(|pair| phase_order(pair[0]) <= phase_order(pair[1]))
    );
}

fn phase_order(phase: OperationPhase) -> u8 {
    match phase {
        OperationPhase::Preparing => 0,
        OperationPhase::Downloading => 1,
        OperationPhase::Verifying => 2,
        OperationPhase::Extracting => 3,
        OperationPhase::Publishing => 4,
        OperationPhase::Removing => 5,
    }
}
