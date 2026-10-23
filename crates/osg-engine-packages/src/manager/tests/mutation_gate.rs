//! Store locking, the mutation gate, and status during an in-flight mutation.

use super::*;
#[test]
fn store_lock_and_global_mutation_gate_prevent_competing_writers() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let manager = manager(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    assert!(
        EnginePackageManager::new(
            temp.path().join("packages"),
            Arc::new(TestCoordinator::default())
        )
        .is_err()
    );
    let operation = manager.0.begin_operation(EngineId::Parakeet).unwrap();
    assert_eq!(
        manager
            .0
            .begin_operation(EngineId::FasterWhisperTurbo)
            .err(),
        Some(PackageError::OperationInProgress(
            EngineId::FasterWhisperTurbo
        ))
    );
    drop(operation);
    assert!(
        manager
            .0
            .begin_operation(EngineId::FasterWhisperTurbo)
            .is_ok()
    );
}

#[test]
fn package_status_never_validates_a_first_install_publication_in_progress() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let manager = manager(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let delivery = manager.0.0.catalog.current(&EngineId::Parakeet).unwrap();
    let target = manager.0.version_root(delivery);

    // Model the publication window: the target is visible, but it has not committed as a
    // verified version yet. The replacement changes size so the corruption is observable to
    // the bounded metadata-only fast path too, not only to a full content scan -- a same-size
    // edit is the documented case a receipt written before this point cannot see until a
    // later full verification, which is not what this test is modeling.
    manager.0.clear_verified(EngineId::Parakeet);
    fs::write(target.join(MODEL_PATH), b"a tampered replacement payload").unwrap();
    let operation = manager.0.begin_operation(EngineId::Parakeet).unwrap();

    let during = manager.status(EngineId::Parakeet);
    assert_eq!(during.state, EnginePackageState::Missing);
    assert!(!during.installed);
    assert!(!manager.0.is_verified(EngineId::Parakeet, delivery));

    drop(operation);
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Corrupt
    );
}

#[test]
fn package_status_preserves_the_last_verified_version_during_layout_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let manager = manager(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let delivery = manager.0.0.catalog.current(&EngineId::Parakeet).unwrap();
    let target = manager.0.version_root(delivery);
    let held = temp.path().join("held-verified-version");
    let operation = manager.0.begin_operation(EngineId::Parakeet).unwrap();
    fs::rename(&target, &held).unwrap();

    let during = manager.status(EngineId::Parakeet);
    assert_eq!(during.state, EnginePackageState::Installed);
    assert!(during.installed);
    assert_eq!(during.version.as_deref(), Some(delivery.version.as_str()));

    fs::rename(&held, &target).unwrap();
    drop(operation);
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
}
