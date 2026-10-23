//! Dynamic yt-dlp updates, exact-version resolution, and consumer rollback.

use super::*;

#[derive(Debug)]
struct LifecycleConsumer {
    failures: Mutex<VecDeque<bool>>,
    observed_versions: Mutex<Vec<Option<String>>>,
    active: Mutex<Option<ToolLease>>,
}

impl LifecycleConsumer {
    fn new(initial: ToolLease, failures: impl IntoIterator<Item = bool>) -> Self {
        Self {
            failures: Mutex::new(failures.into_iter().collect()),
            observed_versions: Mutex::new(Vec::new()),
            active: Mutex::new(Some(initial)),
        }
    }

    fn activate(&self, lease: ToolLease) -> Result<()> {
        let previous = self.active.lock().unwrap().replace(lease);
        self.record_refresh()?;
        if self.failures.lock().unwrap().pop_front().unwrap_or(false) {
            *self.active.lock().unwrap() = previous;
            self.record_refresh()?;
            return Err(NativeToolError::InvalidInstall);
        }
        drop(previous);
        Ok(())
    }

    fn deactivate(&self) -> Option<String> {
        let previous = self.active.lock().unwrap().take();
        let version = previous.as_ref().map(|lease| lease.version().to_owned());
        self.record_refresh().unwrap();
        drop(previous);
        version
    }

    fn restore_exact(&self, manager: &NativeToolManager, version: &str) -> Result<()> {
        let lease = match manager.resolve_version(
            NativeToolId::YtDlp,
            version,
            &CancellationToken::default(),
        ) {
            Ok(lease) => lease,
            Err(error) => {
                self.active.lock().unwrap().take();
                self.record_refresh()?;
                return Err(error);
            }
        };
        self.active.lock().unwrap().replace(lease);
        if self.record_refresh().is_err() {
            self.active.lock().unwrap().take();
            let _ = self.record_refresh();
            return Err(NativeToolError::InvalidInstall);
        }
        Ok(())
    }

    fn record_refresh(&self) -> Result<()> {
        let version = self
            .active
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?
            .as_ref()
            .map(|lease| lease.version().to_owned());
        self.observed_versions
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?
            .push(version);
        Ok(())
    }

    fn version(&self) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|lease| lease.version().to_owned())
    }
}

#[test]
fn exact_version_resolution_verifies_owned_delivery_and_balances_failed_leases() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
    assert_eq!(manager.current_delivery(NativeToolId::YtDlp), Some(updated));

    let lease = manager
        .resolve_version(
            NativeToolId::YtDlp,
            &base.version,
            &CancellationToken::default(),
        )
        .unwrap();
    assert_eq!(lease.version(), base.version);
    assert_eq!(
        manager
            .0
            .activity
            .lock()
            .unwrap()
            .leases
            .get(&NativeToolId::YtDlp),
        Some(&1)
    );
    drop(lease);
    assert!(manager.0.activity.lock().unwrap().leases.is_empty());

    fs::write(
        manager.version_path(&base).join("bin/yt-dlp.exe"),
        b"modified-exact-version",
    )
    .unwrap();
    assert!(matches!(
        manager.resolve_version(
            NativeToolId::YtDlp,
            &base.version,
            &CancellationToken::default(),
        ),
        Err(NativeToolError::InvalidInstall)
    ));
    assert!(matches!(
        manager.resolve_version(
            NativeToolId::YtDlp,
            "2099.01.01",
            &CancellationToken::default(),
        ),
        Err(NativeToolError::DeliveryUnavailable)
    ));
    assert!(manager.0.activity.lock().unwrap().leases.is_empty());
}

#[test]
fn rejected_update_and_failed_removal_restore_exact_previous_consumer_version() {
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

    let executable = b"rejected-updated-tool";
    let notices = [
        b"rejected-license".as_slice(),
        b"rejected-third-party".as_slice(),
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
    let active = manager
        .resolve_version(
            NativeToolId::YtDlp,
            &base.version,
            &CancellationToken::default(),
        )
        .unwrap();
    let consumer = LifecycleConsumer::new(active, [true]);

    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    let rejected = manager
        .resolve(NativeToolId::YtDlp, &CancellationToken::default())
        .unwrap();
    assert_eq!(rejected.version(), updated.version);
    assert_eq!(
        consumer.activate(rejected),
        Err(NativeToolError::InvalidInstall)
    );
    assert_eq!(consumer.version().as_deref(), Some(base.version.as_str()));
    assert_eq!(
        manager.current_delivery(NativeToolId::YtDlp),
        Some(updated.clone())
    );

    let previous_version = consumer.deactivate().unwrap();
    manager
        .0
        .fail_removal_rename_number
        .store(2, AtomicOrdering::Release);
    assert_eq!(
        manager.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {}),
        Err(NativeToolError::StoreUnavailable)
    );
    consumer.restore_exact(&manager, &previous_version).unwrap();
    assert_eq!(consumer.version().as_deref(), Some(base.version.as_str()));
    assert_eq!(
        *consumer.observed_versions.lock().unwrap(),
        vec![
            Some(updated.version),
            Some(base.version.clone()),
            None,
            Some(base.version),
        ]
    );
}

#[test]
fn exact_consumer_rollback_failure_leaves_no_lease_and_refreshes_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (manager, base, _) = manager_with_ytdlp_update(&temp, coordinator);
    let active = manager
        .resolve_version(
            NativeToolId::YtDlp,
            &base.version,
            &CancellationToken::default(),
        )
        .unwrap();
    let consumer = LifecycleConsumer::new(active, []);
    let previous_version = consumer.deactivate().unwrap();
    fs::write(
        manager.version_path(&base).join("bin/yt-dlp.exe"),
        b"corrupt-before-rollback",
    )
    .unwrap();

    assert_eq!(
        consumer.restore_exact(&manager, &previous_version),
        Err(NativeToolError::InvalidInstall)
    );
    assert_eq!(consumer.version(), None);
    assert_eq!(
        *consumer.observed_versions.lock().unwrap(),
        vec![None, None]
    );
    assert!(manager.0.activity.lock().unwrap().leases.is_empty());
}

#[test]
fn immutable_ytdlp_update_publishes_beside_the_active_lease_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let (catalog, base_fetcher) = fixture_catalog();
    let base = catalog.current(NativeToolId::YtDlp).unwrap().clone();
    let updated_bytes = b"updated-verified-tool";
    let updated_notices = [
        b"updated-license".as_slice(),
        b"updated-third-party".as_slice(),
    ];
    let updated = updated_ytdlp(&base, updated_bytes, &updated_notices);
    let mut files = base_fetcher.0.clone();
    files.insert(updated.source_url.clone(), updated_bytes.to_vec());
    for (notice, contents) in updated.notices.iter().zip(updated_notices) {
        files.insert(notice.source_url.clone(), contents.to_vec());
    }
    let base_manager = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        Arc::new(MemoryFetcher(files.clone())),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    base_manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    drop(base_manager);

    let resolver = Arc::new(SequenceResolver {
        responses: Mutex::new(vec![Ok(updated.clone())]),
        calls: AtomicUsize::new(0),
    });
    let manager = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        Arc::new(MemoryFetcher(files.clone())),
        resolver.clone(),
    )
    .unwrap();
    let active = manager
        .resolve(NativeToolId::YtDlp, &CancellationToken::default())
        .unwrap();
    assert_eq!(active.version(), base.version);
    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    assert_eq!(resolver.calls.load(Ordering::Relaxed), 2);
    assert_eq!(
        manager.status(NativeToolId::YtDlp).version,
        Some(updated.version.clone())
    );
    assert_eq!(active.version(), base.version);
    assert_eq!(coordinator.0.load(Ordering::Relaxed), 1);
    drop(active);
    drop(manager);

    let reopened = NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        Arc::new(MemoryFetcher(files)),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    let lease = reopened
        .resolve(NativeToolId::YtDlp, &CancellationToken::default())
        .unwrap();
    assert_eq!(lease.version(), updated.version);
}

#[test]
fn startup_retains_only_two_dynamic_ytdlp_rollback_records() {
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
    for version in ["2026.08.10", "2026.08.11", "2026.08.12"] {
        let mut delivery = updated_ytdlp(base, b"tool", &[b"license", b"third-party"]);
        delivery.version = version.to_string();
        delivery.source_url = format!(
            "https://github.com/yt-dlp/yt-dlp/releases/download/{version}/{}",
            delivery.asset
        );
        crate::update::persist(temp.path(), &delivery).unwrap();
        publish_fixture_delivery(
            temp.path(),
            &delivery,
            b"tool",
            &[b"license", b"third-party"],
        );
    }

    let reopened = NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        fetcher,
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    assert_eq!(reopened.0.dynamic_ytdlp.lock().unwrap().len(), 2);
    assert_eq!(
        fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
            .unwrap()
            .count(),
        2
    );
    assert_eq!(
        reopened.status(NativeToolId::YtDlp).available_version,
        Some("2026.08.12".to_string())
    );
}
