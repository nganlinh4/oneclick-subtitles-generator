//! Owned-version removal, rename rollback, and bounded trash reclamation.

use super::*;

/// Regression for the e2e journey settingsToolsRemoveAndFactoryReset: it installs yt-dlp
/// through the real Settings UI, removes it, and asserts a directory-shape digest of the
/// managed native-tools tree is byte-for-byte and entry-for-entry identical before install
/// and after removal. `ensure_versions_root` (manager/install.rs) lazily creates
/// `tools/yt-dlp/versions` the first time yt-dlp is installed; `remove` (manager/removal.rs)
/// only ever renamed the leaf `versions/{version}` directory into `.trash` and cleaned that
/// up, never the now-empty `versions` directory itself, so a real install-then-remove cycle
/// left exactly one orphaned empty directory behind that did not exist before yt-dlp was ever
/// installed. This walks the full store tree (mirroring the e2e oracle's
/// `directoryShapeDigest`) and asserts the post-removal shape is identical to the pre-install
/// baseline, not just "no leftover bytes".
#[test]
fn install_then_remove_restores_the_exact_pre_install_store_shape() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = manager(&temp, coordinator);
    assert_eq!(
        manager.status(NativeToolId::YtDlp).state,
        NativeToolState::Missing
    );
    let baseline = store_shape(temp.path());
    // The manager itself lazily creates `tools/yt-dlp/deliveries` at every startup
    // (regardless of install state) to hold dynamic yt-dlp update records, so that much of
    // `tools/yt-dlp` is legitimately already part of the pre-install baseline.
    assert!(baseline.paths.contains(&"dir:tools/yt-dlp".to_string()));
    assert!(
        baseline
            .paths
            .contains(&"dir:tools/yt-dlp/deliveries".to_string())
    );
    assert!(
        !baseline
            .paths
            .contains(&"dir:tools/yt-dlp/versions".to_string()),
        "versions/ must not exist before the first install"
    );

    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    let installed = store_shape(temp.path());
    assert!(
        installed
            .paths
            .contains(&"dir:tools/yt-dlp/versions".to_string()),
        "install must create versions/"
    );
    assert!(installed.files > baseline.files);

    assert_eq!(
        manager
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    let after_removal = store_shape(temp.path());
    assert_eq!(
        after_removal, baseline,
        "removal must restore the exact pre-install store shape, not merely delete bytes"
    );
}

#[test]
fn remove_reconciles_all_owned_versions_but_preserves_unowned_trees() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
    let unowned = temp
        .path()
        .join("tools/yt-dlp/versions/unowned-local-build");
    fs::create_dir(&unowned).unwrap();
    fs::write(unowned.join("keep.txt"), b"user-owned").unwrap();

    assert!(manager.version_path(&base).is_dir());
    assert!(manager.version_path(&updated).is_dir());
    assert_eq!(
        manager
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert!(!manager.version_path(&base).exists());
    assert!(!manager.version_path(&updated).exists());
    assert!(unowned.join("keep.txt").is_file());
    assert!(manager.0.dynamic_ytdlp.lock().unwrap().is_empty());
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn modified_rollback_version_aborts_removal_before_any_owned_tree_moves() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
    fs::write(
        manager.version_path(&base).join("bin/yt-dlp.exe"),
        b"modified-rollback",
    )
    .unwrap();

    assert_eq!(
        manager
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::PreservedModified
    );
    assert!(manager.version_path(&base).is_dir());
    assert!(manager.version_path(&updated).is_dir());
    assert_eq!(manager.0.dynamic_ytdlp.lock().unwrap().len(), 1);
}

#[test]
fn failed_later_rename_rolls_back_earlier_staging_and_preserves_active_delivery() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
    manager
        .0
        .fail_removal_rename_number
        .store(2, AtomicOrdering::Release);

    assert_eq!(
        manager.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {}),
        Err(NativeToolError::StoreUnavailable)
    );
    assert!(manager.version_path(&base).is_dir());
    assert!(manager.version_path(&updated).is_dir());
    assert!(manager.status(NativeToolId::YtDlp).installed);
    assert_eq!(manager.0.dynamic_ytdlp.lock().unwrap().len(), 1);
    assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 0);
}

#[test]
fn removal_selects_current_delivery_after_guard_and_stages_it_last() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (catalog, base_fetcher) = fixture_catalog();
    let base = catalog.current(NativeToolId::YtDlp).unwrap().clone();
    let base_manager = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        base_fetcher.clone(),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    base_manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    drop(base_manager);

    let executable = b"concurrent-updated-tool";
    let notices = [
        b"concurrent-license".as_slice(),
        b"concurrent-third-party".as_slice(),
    ];
    let updated = updated_ytdlp(&base, executable, &notices);
    let mut files = base_fetcher.0.clone();
    files.insert(updated.source_url.clone(), executable.to_vec());
    for (notice, contents) in updated.notices.iter().zip(notices) {
        files.insert(notice.source_url.clone(), contents.to_vec());
    }
    let manager = NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        Arc::new(MemoryFetcher(files)),
        Arc::new(SequenceResolver {
            responses: Mutex::new(vec![Ok(updated.clone())]),
            calls: AtomicUsize::new(0),
        }),
    )
    .unwrap();
    let hook = Arc::new(RemoveBeforeGuardHook::new());
    *manager.0.remove_before_guard_hook.lock().unwrap() = Some(Arc::clone(&hook));
    manager
        .0
        .fail_removal_rename_number
        .store(2, AtomicOrdering::Release);

    let removing = manager.clone();
    let removal = std::thread::spawn(move || {
        removing.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
    });
    hook.entered.wait();
    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    assert_eq!(
        manager.current_delivery(NativeToolId::YtDlp),
        Some(updated.clone())
    );
    hook.resume.wait();

    assert_eq!(
        removal.join().unwrap(),
        Err(NativeToolError::StoreUnavailable)
    );
    assert_eq!(
        *manager.0.removal_rename_attempts.lock().unwrap(),
        vec![base.version.clone(), updated.version.clone()]
    );
    assert!(manager.version_path(&base).is_dir());
    assert!(manager.version_path(&updated).is_dir());
    assert_eq!(manager.current_delivery(NativeToolId::YtDlp), Some(updated));
    assert!(manager.status(NativeToolId::YtDlp).installed);
}

#[test]
fn post_commit_cleanup_failure_stays_successful_and_safe_startup_gc_retries() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let managed = manager(&temp, coordinator.clone());
    managed
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    let delivery = managed.0.catalog.current(NativeToolId::YtDlp).unwrap();
    let unowned = temp.path().join(".trash").join(format!(
        "{}-{}-{}",
        delivery.tool.as_str(),
        delivery.version,
        Uuid::now_v7()
    ));
    fs::create_dir(&unowned).unwrap();
    fs::write(unowned.join("foreign.txt"), b"preserve").unwrap();
    managed
        .0
        .force_cleanup_failure
        .store(true, AtomicOrdering::Release);

    assert_eq!(
        managed
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert!(!managed.version_path(delivery).exists());
    assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 2);
    drop(managed);

    let reopened = manager(&temp, coordinator);
    assert_eq!(
        reopened.status(NativeToolId::YtDlp).state,
        NativeToolState::Missing
    );
    assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 1);
    assert_eq!(fs::read(unowned.join("foreign.txt")).unwrap(), b"preserve");
}

#[test]
fn dynamic_receipt_is_retained_until_failed_trash_cleanup_recovers_on_restart() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (catalog, fetcher) = fixture_catalog();
    let initial = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        fetcher.clone(),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    drop(initial);

    let base = catalog.current(NativeToolId::YtDlp).unwrap();
    let updated = updated_ytdlp(base, b"tool", &[b"license", b"third-party"]);
    crate::update::persist(temp.path(), &updated).unwrap();
    publish_fixture_delivery(
        temp.path(),
        &updated,
        b"tool",
        &[b"license", b"third-party"],
    );
    let managed = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        fetcher.clone(),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    managed
        .0
        .force_cleanup_failure
        .store(true, AtomicOrdering::Release);

    assert_eq!(
        managed
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 1);
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        1
    );
    drop(managed);

    let still_locked = NativeToolManager::with_parts_config(
        temp.path(),
        coordinator.clone(),
        catalog,
        fetcher.clone(),
        Arc::new(NoUpdateResolver),
        true,
    )
    .unwrap();
    assert!(still_locked.0.dynamic_ytdlp.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 1);
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        1
    );
    drop(still_locked);

    let reopened = NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        fetcher,
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    assert!(reopened.0.dynamic_ytdlp.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 0);
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn capped_trash_scan_retains_dynamic_provenance_until_a_complete_retry() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (catalog, fetcher) = fixture_catalog();
    let base = catalog.current(NativeToolId::YtDlp).unwrap();
    let updated = updated_ytdlp(base, b"tool", &[b"license", b"third-party"]);
    crate::update::persist(temp.path(), &updated).unwrap();
    publish_fixture_delivery(
        temp.path(),
        &updated,
        b"tool",
        &[b"license", b"third-party"],
    );
    let managed = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        fetcher.clone(),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    managed
        .0
        .force_cleanup_failure
        .store(true, AtomicOrdering::Release);
    assert_eq!(
        managed
            .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap(),
        RemovalOutcome::Removed
    );
    drop(managed);

    let trash_root = temp.path().join(".trash");
    let mut foreign = Vec::new();
    for index in 0..(MAX_TRASH_GC_ENTRIES + 32) {
        let path = trash_root.join(format!("foreign-before-cap-{index:03}"));
        fs::create_dir(&path).unwrap();
        foreign.push(path);
    }
    let capped = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        fetcher.clone(),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    assert!(capped.0.dynamic_ytdlp.lock().unwrap().is_empty());
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        1
    );
    drop(capped);

    for path in foreign {
        fs::remove_dir(path).unwrap();
    }
    let recovered = NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        fetcher,
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    assert!(recovered.0.dynamic_ytdlp.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(trash_root).unwrap().count(), 0);
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        0
    );
}
