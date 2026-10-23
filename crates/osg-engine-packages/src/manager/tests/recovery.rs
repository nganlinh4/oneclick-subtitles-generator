//! Restart recovery keeps only exact, well-formed private entries.

use super::*;
#[test]
fn restart_repairs_only_legacy_runtime_cache_and_removal_stays_exact() {
    let temp = tempfile::tempdir().unwrap();
    let first_fixture = fixture();
    let first_manager = manager(
        &temp,
        first_fixture.catalog,
        Arc::new(MemoryFetcher::new(first_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    first_manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let installed = first_manager.0.0.root.join("parakeet/versions/1.0.0");
    let cache = installed.join("runtime/lib/pkg/__pycache__");
    fs::create_dir_all(&cache).unwrap();
    let bytecode = cache.join("module.cpython-311.pyc");
    fs::write(&bytecode, b"legacy bytecode").unwrap();
    drop(first_manager);

    let second_fixture = fixture();
    let restarted = manager(
        &temp,
        second_fixture.catalog,
        Arc::new(MemoryFetcher::new(second_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    assert!(!bytecode.exists());
    assert_eq!(
        restarted.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    assert_eq!(
        restarted
            .remove(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
}

#[test]
fn restart_preserves_python_cache_when_any_unknown_file_is_present() {
    let temp = tempfile::tempdir().unwrap();
    let first_fixture = fixture();
    let first_manager = manager(
        &temp,
        first_fixture.catalog,
        Arc::new(MemoryFetcher::new(first_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    first_manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let installed = first_manager.0.0.root.join("parakeet/versions/1.0.0");
    let cache = installed.join("runtime/lib/pkg/__pycache__");
    fs::create_dir_all(&cache).unwrap();
    let bytecode = cache.join("module.cpython-311.pyc");
    let unknown = installed.join("runtime/user-data.bin");
    fs::write(&bytecode, b"legacy bytecode").unwrap();
    fs::write(&unknown, b"preserve").unwrap();
    drop(first_manager);

    let second_fixture = fixture();
    let restarted = manager(
        &temp,
        second_fixture.catalog,
        Arc::new(MemoryFetcher::new(second_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    assert!(bytecode.exists());
    assert_eq!(fs::read(&unknown).unwrap(), b"preserve");
    assert_eq!(
        restarted.status(EngineId::Parakeet).state,
        EnginePackageState::Corrupt
    );
    assert_eq!(
        restarted
            .remove(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::PreservedModified
    );
}

#[test]
fn restart_finishes_verified_trash() {
    let temp = tempfile::tempdir().unwrap();
    let first_fixture = speech_fixture();
    let manager = speech_manager(
        &temp,
        first_fixture.catalog,
        Arc::new(MemoryFetcher::new(first_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    manager
        .install(
            SpeechPackageId::EdgeTts,
            &CancellationToken::default(),
            &|_| {},
        )
        .unwrap();
    let store = manager.0.0.root.clone();
    let target = store.join("edge-tts/versions/1.0.0");
    let trash = store.join(format!(".trash/edge-tts-1.0.0-{}", Uuid::now_v7()));
    fs::rename(&target, &trash).unwrap();
    drop(manager);

    let second_fixture = speech_fixture();
    let restarted = speech_manager(
        &temp,
        second_fixture.catalog,
        Arc::new(MemoryFetcher::new(second_fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );
    assert!(!trash.exists());
    assert_eq!(
        restarted.status(SpeechPackageId::EdgeTts).state,
        SpeechPackageState::Missing
    );
    restarted
        .install(
            SpeechPackageId::EdgeTts,
            &CancellationToken::default(),
            &|_| {},
        )
        .unwrap();
    assert_eq!(
        restarted.status(SpeechPackageId::EdgeTts).state,
        SpeechPackageState::Installed
    );
}

#[test]
fn legacy_prefix_staging_and_quarantine_are_preserved_without_private_authority() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = speech_fixture();
    let root = initialize_store(&temp.path().join("speech-packages")).unwrap();
    let staging = root.join(format!(".staging/edge-tts-1.0.0-{}", Uuid::now_v7()));
    fs::create_dir_all(staging.join("runtime")).unwrap();
    fs::write(staging.join(PYTHON_PATH), PYTHON_BYTES).unwrap();

    assert_eq!(
        recover_interrupted_mutations(&root, &fixture.catalog),
        Err(PackageError::StoreUnavailable)
    );
    assert_eq!(fs::read(staging.join(PYTHON_PATH)).unwrap(), PYTHON_BYTES);

    fs::remove_dir_all(&staging).unwrap();
    let quarantine = root.join(format!(".quarantine/edge-tts-1.0.0-{}", Uuid::now_v7()));
    fs::create_dir(&quarantine).unwrap();
    fs::write(quarantine.join("foreign.bin"), b"preserve").unwrap();
    assert_eq!(
        recover_interrupted_mutations(&root, &fixture.catalog),
        Err(PackageError::StoreUnavailable)
    );
    assert_eq!(
        fs::read(quarantine.join("foreign.bin")).unwrap(),
        b"preserve"
    );
}

#[test]
fn restart_removes_only_well_formed_downloads_from_superseded_catalogs() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = speech_fixture();
    let delivery = fixture.catalog.current(&SpeechPackageId::EdgeTts).unwrap();
    let current_key = crate::download::cache_key(&delivery.sha256, &delivery.asset);
    let stale_key = "0000000000000000-obsolete.zip";
    let root = initialize_store(&temp.path().join("speech-packages")).unwrap();
    let downloads = root.join(".downloads");
    for suffix in ["partial", "resume.json"] {
        fs::write(
            downloads.join(format!("{current_key}.{suffix}")),
            b"current",
        )
        .unwrap();
        fs::write(downloads.join(format!("{stale_key}.{suffix}")), b"stale").unwrap();
    }

    let manager = speech_manager(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
    );

    for suffix in ["partial", "resume.json"] {
        assert!(downloads.join(format!("{current_key}.{suffix}")).is_file());
        assert!(!downloads.join(format!("{stale_key}.{suffix}")).exists());
    }
    drop(manager);
}

#[test]
fn restart_refuses_unknown_or_reparse_entries_in_private_download_storage() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = speech_fixture();
    let root = initialize_store(&temp.path().join("speech-packages")).unwrap();
    fs::write(root.join(".downloads/not-owned.txt"), b"preserve").unwrap();

    assert_eq!(
        recover_interrupted_mutations(&root, &fixture.catalog),
        Err(PackageError::StoreUnavailable)
    );
    assert!(root.join(".downloads/not-owned.txt").is_file());
}
