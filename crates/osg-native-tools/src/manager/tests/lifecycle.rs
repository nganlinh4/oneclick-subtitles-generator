//! Install, status, lease, and catalog-availability lifecycle.

use super::*;

#[test]
fn install_resolve_busy_remove_lifecycle_is_verified_and_path_free() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = manager(&temp, coordinator.clone());
    assert_eq!(
        manager.status(NativeToolId::YtDlp).state,
        NativeToolState::Missing
    );
    let installed = manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    assert_eq!(installed.state, NativeToolState::Installed);
    let encoded = serde_json::to_string(&installed).unwrap();
    assert!(!encoded.contains("http"));
    assert!(!encoded.contains("bin/"));
    assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));

    let lease = manager
        .resolve(NativeToolId::YtDlp, &CancellationToken::default())
        .unwrap();
    assert!(lease.executable(ExecutableRole::YtDlp).unwrap().is_file());
    assert_eq!(
        manager.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {},),
        Err(NativeToolError::RuntimeBusy)
    );
    drop(lease);
    assert_eq!(
        manager
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {},)
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert_eq!(coordinator.0.load(Ordering::Relaxed), 2);
}

#[test]
fn modified_install_is_reported_and_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, Arc::new(TestCoordinator::default()));
    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    let delivery = manager.0.catalog.current(NativeToolId::YtDlp).unwrap();
    fs::write(
        manager.version_path(delivery).join("bin/yt-dlp.exe"),
        b"modified",
    )
    .unwrap();
    assert_eq!(
        manager.status(NativeToolId::YtDlp).state,
        NativeToolState::Corrupt
    );
    assert_eq!(
        manager
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {},)
            .unwrap(),
        RemovalOutcome::PreservedModified
    );
    assert!(manager.version_path(delivery).exists());

    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    assert_eq!(
        manager.status(NativeToolId::YtDlp).state,
        NativeToolState::Installed
    );
    let quarantined = fs::read_dir(temp.path().join(".quarantine"))
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();
    assert!(quarantined.is_empty());
}

#[test]
fn startup_preserves_and_refuses_unjournaled_large_work_tree_lookalikes() {
    for (parent, leaf) in [
        (".downloads", "yt-dlp-2026.08.26-fake"),
        (".staging", "yt-dlp-2026.08.26-fake"),
        (".quarantine", "yt-dlp-2026.08.26-fake"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = initialize_store(temp.path()).unwrap();
        let lookalike = root.join(parent).join(leaf);
        fs::create_dir(&lookalike).unwrap();
        fs::write(lookalike.join("customer.bin"), b"preserve").unwrap();

        assert_eq!(
            NativeToolManager::new(temp.path(), Arc::new(TestCoordinator::default())).err(),
            Some(NativeToolError::StoreUnavailable)
        );
        assert_eq!(
            fs::read(lookalike.join("customer.bin")).unwrap(),
            b"preserve"
        );
    }
}

#[test]
fn repeated_status_uses_identity_cache_but_removal_rehashes_before_commit() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, Arc::new(TestCoordinator::default()));
    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();

    receipt::reset_hashed_bytes();
    assert!(manager.status(NativeToolId::YtDlp).installed);
    assert!(manager.status(NativeToolId::YtDlp).installed);
    assert_eq!(receipt::hashed_bytes(), 0);

    manager.0.verified_installs.lock().unwrap().clear();
    assert!(manager.status(NativeToolId::YtDlp).installed);
    let first_status_hash = receipt::hashed_bytes();
    assert!(first_status_hash > 0);
    assert!(manager.status(NativeToolId::YtDlp).installed);
    assert_eq!(receipt::hashed_bytes(), first_status_hash);

    let delivery = manager.0.catalog.current(NativeToolId::YtDlp).unwrap();
    let cached = manager
        .0
        .verified_installs
        .lock()
        .unwrap()
        .get(&(NativeToolId::YtDlp, delivery.version.clone()))
        .unwrap()
        .clone();
    let mut replacement_metadata = delivery.clone();
    replacement_metadata.source_url = "https://example.invalid/tampered".to_owned();
    assert!(!receipt::identity_matches(
        &manager.version_path(delivery),
        &replacement_metadata,
        &cached
    ));

    receipt::reset_hashed_bytes();
    assert_eq!(
        manager
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert!(receipt::hashed_bytes() > 0);
}

#[test]
fn media_tool_availability_matches_the_reviewed_platform_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = if crate::catalog::current_platform() == "windows-x86_64" {
        manager(&temp, coordinator.clone())
    } else {
        NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            DeliveryCatalog::builtin().unwrap(),
            Arc::new(MemoryFetcher(HashMap::new())),
            Arc::new(NoUpdateResolver),
        )
        .unwrap()
    };
    let status = manager.status(NativeToolId::MediaTools).state;
    let result = manager.install(
        NativeToolId::MediaTools,
        &CancellationToken::default(),
        &|_| {},
    );
    if crate::catalog::current_platform() == "windows-x86_64" {
        assert_eq!(status, NativeToolState::Missing);
        assert_eq!(result, Err(NativeToolError::Network));
    } else {
        assert_eq!(status, NativeToolState::Unavailable);
        assert_eq!(result, Err(NativeToolError::DeliveryUnavailable));
    }
    assert_eq!(coordinator.0.load(Ordering::Relaxed), 0);
}
