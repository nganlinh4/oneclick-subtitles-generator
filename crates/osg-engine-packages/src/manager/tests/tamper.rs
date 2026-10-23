//! Tampered installs are reported, preserved, and repairable.

use super::*;
#[test]
fn a_different_size_tamper_is_not_ready_is_preserved_and_can_be_repaired() {
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
    let runtime = manager
        .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
        .unwrap();
    let model_file = runtime.model().join("config.json");
    drop(runtime);
    // A size-changing tamper: the receipt fast path's bounded metadata walk (existence + size,
    // see `an_unchanged_size_tamper_is_masked_by_the_fast_path_until_reinstalled` below for the
    // size-preserving case) must still catch this on the very next status probe after restart.
    fs::write(&model_file, b"a longer replacement payload").unwrap();
    drop(manager);
    let restarted_fixture = self::fixture();
    let manager = self::manager(
        &temp,
        restarted_fixture.catalog,
        Arc::new(MemoryFetcher::new(restarted_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    let corrupt = manager.status(EngineId::Parakeet);
    assert_eq!(corrupt.state, EnginePackageState::Corrupt);
    assert!(!corrupt.installed);
    assert_eq!(
        manager
            .remove(EngineId::Parakeet, &CancellationToken::default(), &|_| {},)
            .unwrap(),
        RemovalOutcome::PreservedModified
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    let quarantine = manager.0.0.root.join(".quarantine");
    assert!(fs::read_dir(quarantine).unwrap().next().is_none());
}

/// Proves at the public API level that a same-size write to the logically immutable but
/// Windows-writable publication invalidates the durable receipt across a process restart.
/// Status falls through to a deep verify, reports corruption, and install repairs the tree.
#[test]
fn an_unchanged_size_tamper_is_detected_after_restart_and_reinstalled() {
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
    let runtime = manager
        .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
        .unwrap();
    let model_file = runtime.model().join("config.json");
    drop(runtime);
    assert_eq!(
        MODEL_BYTES.len(),
        b"other".len(),
        "the tamper must preserve size"
    );
    fs::write(&model_file, b"other").unwrap();
    drop(manager);

    let restarted_fixture = self::fixture();
    let manager = self::manager(
        &temp,
        restarted_fixture.catalog,
        Arc::new(MemoryFetcher::new(restarted_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    let detected = manager.status(EngineId::Parakeet);
    assert_eq!(detected.state, EnginePackageState::Corrupt);
    assert!(!detected.installed);

    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    assert_eq!(fs::read(&model_file).unwrap(), MODEL_BYTES);
    let quarantine = manager.0.0.root.join(".quarantine");
    assert!(fs::read_dir(quarantine).unwrap().next().is_none());
}
