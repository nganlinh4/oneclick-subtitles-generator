//! Verification deadlines, single-flight sharing, and fail-closed completion.

use super::*;
#[test]
fn verification_deadline_expires_in_one_process_and_refreshes_the_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let initial_now = 1_000_000_u64;
    let (now, clock) = fake_clock(initial_now);
    let deep_verifies = Arc::new(AtomicUsize::new(0));
    let verifier = {
        let deep_verifies = deep_verifies.clone();
        Arc::new(
            move |root: &Path, delivery: &PackageDelivery, cancellation: &CancellationToken| {
                deep_verifies.fetch_add(1, Ordering::AcqRel);
                receipt::validate_integrity(root, delivery, cancellation)
            },
        )
    };
    let manager = manager_with_clock_and_verifier(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
        clock,
        verifier,
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let receipt_path = manager.0.0.root.join(".verified/parakeet/1.0.0.json");
    let first: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    assert_eq!(first["verifiedAtUnixSeconds"], initial_now);

    let deadline = initial_now + verified_install::MAX_FAST_VERIFY_AGE_SECONDS;
    now.store(deadline - 1, Ordering::Release);
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    let still_first: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    assert_eq!(still_first["verifiedAtUnixSeconds"], initial_now);
    assert_eq!(deep_verifies.load(Ordering::Acquire), 0);

    // The same manager instance crosses the lease boundary. Its in-memory entry and durable
    // receipt both expire at this exact instant, forcing a full content pass and a refreshed
    // receipt without relying on a process restart.
    now.store(deadline, Ordering::Release);
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    let refreshed: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    assert_eq!(refreshed["verifiedAtUnixSeconds"], deadline);
    assert_eq!(
        refreshed["deepVerifyAfterUnixSeconds"],
        deadline + verified_install::MAX_FAST_VERIFY_AGE_SECONDS
    );
    assert_eq!(deep_verifies.load(Ordering::Acquire), 1);
}

#[test]
fn same_size_tamper_in_one_process_is_detected_at_the_verification_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let initial_now = 2_000_000_u64;
    let (now, clock) = fake_clock(initial_now);
    let manager = manager_with_clock_and_verifier(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
        clock,
        Arc::new(receipt::validate_integrity),
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    let model_file = manager
        .0
        .0
        .root
        .join("parakeet/versions/1.0.0")
        .join(MODEL_PATH);
    assert_eq!(MODEL_BYTES.len(), b"other".len());
    fs::write(&model_file, b"other").unwrap();

    // The Windows publication is logically immutable, not ACL-enforced. The bounded lease is
    // therefore allowed to remain cheap until its deadline, but never beyond it.
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    now.store(
        initial_now + verified_install::MAX_FAST_VERIFY_AGE_SECONDS,
        Ordering::Release,
    );
    let detected = manager.status(EngineId::Parakeet);
    assert_eq!(detected.state, EnginePackageState::Corrupt);
    assert!(!detected.installed);
    assert_eq!(fs::read(model_file).unwrap(), b"other");
}

#[test]
fn expired_verification_is_single_flight_across_concurrent_status_and_launch() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let initial_now = 3_000_000_u64;
    let (now, clock) = fake_clock(initial_now);
    let verify_calls = Arc::new(AtomicUsize::new(0));
    let release_verify = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = mpsc::channel();
    let verifier = {
        let verify_calls = verify_calls.clone();
        let release_verify = release_verify.clone();
        Arc::new(
            move |root: &Path, delivery: &PackageDelivery, cancellation: &CancellationToken| {
                verify_calls.fetch_add(1, Ordering::AcqRel);
                entered_tx.send(()).unwrap();
                while !release_verify.load(Ordering::Acquire) {
                    cancellation.check()?;
                    std::thread::yield_now();
                }
                receipt::validate_integrity(root, delivery, cancellation)
            },
        )
    };
    let manager = manager_with_clock_and_verifier(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
        clock,
        verifier,
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    now.store(
        initial_now + verified_install::MAX_FAST_VERIFY_AGE_SECONDS,
        Ordering::Release,
    );

    let start = Arc::new(Barrier::new(3));
    let status_thread = {
        let manager = manager.clone();
        let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            manager.status(EngineId::Parakeet)
        })
    };
    let launch_thread = {
        let manager = manager.clone();
        let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            manager
                .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
                .map(|runtime| runtime.version().to_owned())
        })
    };
    start.wait();
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let calls_while_blocked = verify_calls.load(Ordering::Acquire);
    release_verify.store(true, Ordering::Release);

    let status = status_thread.join().unwrap();
    let launched_version = launch_thread.join().unwrap().unwrap();
    assert_eq!(status.state, EnginePackageState::Installed);
    assert_eq!(launched_version, "1.0.0");
    assert_eq!(calls_while_blocked, 1);
    assert_eq!(verify_calls.load(Ordering::Acquire), 1);
}

#[test]
fn failed_verification_is_shared_by_waiters_but_a_later_call_may_retry() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let initial_now = 4_000_000_u64;
    let (now, clock) = fake_clock(initial_now);
    let verify_calls = Arc::new(AtomicUsize::new(0));
    let release_first = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = mpsc::channel();
    let verifier = {
        let verify_calls = verify_calls.clone();
        let release_first = release_first.clone();
        Arc::new(
            move |_: &Path, _: &PackageDelivery, cancellation: &CancellationToken| {
                let call = verify_calls.fetch_add(1, Ordering::AcqRel);
                if call == 0 {
                    entered_tx.send(()).unwrap();
                    while !release_first.load(Ordering::Acquire) {
                        cancellation.check()?;
                        std::thread::yield_now();
                    }
                }
                Err(PackageError::InvalidInstall)
            },
        )
    };
    let manager = manager_with_clock_and_verifier(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
        clock,
        verifier,
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    now.store(
        initial_now + verified_install::MAX_FAST_VERIFY_AGE_SECONDS,
        Ordering::Release,
    );

    let start = Arc::new(Barrier::new(4));
    let status_thread = {
        let manager = manager.clone();
        let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            manager.status(EngineId::Parakeet)
        })
    };
    let launch_thread = {
        let manager = manager.clone();
        let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            manager.resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
        })
    };
    let verdict_thread = {
        let manager = manager.clone();
        let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            let delivery = manager.0.0.catalog.current(&EngineId::Parakeet).unwrap();
            manager
                .0
                .verify_once(EngineId::Parakeet, delivery, &CancellationToken::default())
        })
    };
    start.wait();
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();

    // The active map, owner and two waiters each hold this exact generation Arc. Do not
    // release the hostile verifier until both public callers and the raw-verdict witness are
    // deterministically participating.
    let key = (EngineId::Parakeet, "1.0.0".to_string());
    wait_for_flight_holders(&manager, &key, 4);

    // A caller cancelled while waiting keeps its own cancellation verdict; it neither starts
    // another scan nor cancels the shared generation for the remaining callers.
    let cancelled = CancellationToken::default();
    cancelled.cancel();
    assert!(matches!(
        manager.resolve_for_launch(EngineId::Parakeet, &cancelled),
        Err(PackageError::Cancelled)
    ));
    assert_eq!(verify_calls.load(Ordering::Acquire), 1);
    release_first.store(true, Ordering::Release);

    let status = status_thread.join().unwrap();
    let launch = launch_thread.join().unwrap();
    let shared_verdict = verdict_thread.join().unwrap();
    assert_eq!(status.state, EnginePackageState::Corrupt);
    assert!(matches!(launch, Err(PackageError::InvalidInstall)));
    assert_eq!(shared_verdict, Err(PackageError::InvalidInstall));
    assert_eq!(
        verify_calls.load(Ordering::Acquire),
        1,
        "all callers already waiting on the failed generation must share one deep verdict"
    );

    // Failure is not a durable or in-memory negative cache. Once the failed generation has
    // retired, one independent later launch may own exactly one fresh retry.
    assert!(matches!(
        manager.resolve_for_launch(EngineId::Parakeet, &CancellationToken::default()),
        Err(PackageError::InvalidInstall)
    ));
    assert_eq!(verify_calls.load(Ordering::Acquire), 2);
}

#[test]
fn caller_between_outcome_publication_and_retirement_never_restarts_the_scan() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let initial_now = 4_500_000_u64;
    let (now, clock) = fake_clock(initial_now);
    let verify_calls = Arc::new(AtomicUsize::new(0));
    let verifier = {
        let verify_calls = verify_calls.clone();
        Arc::new(
            move |_: &Path, _: &PackageDelivery, _: &CancellationToken| {
                verify_calls.fetch_add(1, Ordering::AcqRel);
                Err(PackageError::InvalidInstall)
            },
        )
    };
    let manager = manager_with_clock_and_verifier(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
        clock,
        verifier,
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    now.store(
        initial_now + verified_install::MAX_FAST_VERIFY_AGE_SECONDS,
        Ordering::Release,
    );

    let (published_tx, published_rx) = mpsc::channel();
    let release_retirement = Arc::new(AtomicBool::new(false));
    let hook = {
        let release_retirement = release_retirement.clone();
        Arc::new(move || {
            published_tx.send(()).unwrap();
            while !release_retirement.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
        })
    };
    *manager.0.0.verification_published_hook.lock().unwrap() = Some(hook);

    let owner = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let delivery = manager.0.0.catalog.current(&EngineId::Parakeet).unwrap();
            manager
                .0
                .verify_once(EngineId::Parakeet, delivery, &CancellationToken::default())
        })
    };
    published_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();

    // The deep scan has returned and its failure is terminal, but the hook keeps the old Arc
    // in `verifying_versions`. A caller entering precisely here must consume that outcome.
    let (late_tx, late_rx) = mpsc::channel();
    let late_caller = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let result = manager
                .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
                .map(|_| ());
            late_tx.send(result).unwrap();
        })
    };
    let late_outcome = late_rx.recv_timeout(std::time::Duration::from_secs(5));
    release_retirement.store(true, Ordering::Release);

    assert_eq!(
        late_outcome.unwrap(),
        Err(PackageError::InvalidInstall),
        "the boundary caller must receive the published generation outcome"
    );
    assert_eq!(verify_calls.load(Ordering::Acquire), 1);
    assert_eq!(owner.join().unwrap(), Err(PackageError::InvalidInstall));
    late_caller.join().unwrap();
}

#[test]
fn poisoned_activity_completion_fails_closed_and_wakes_the_generation() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = fixture();
    let initial_now = 5_000_000_u64;
    let (now, clock) = fake_clock(initial_now);
    let verify_calls = Arc::new(AtomicUsize::new(0));
    let release_verify = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = mpsc::channel();
    let verifier = {
        let verify_calls = verify_calls.clone();
        let release_verify = release_verify.clone();
        Arc::new(
            move |_: &Path, _: &PackageDelivery, cancellation: &CancellationToken| {
                verify_calls.fetch_add(1, Ordering::AcqRel);
                entered_tx.send(()).unwrap();
                while !release_verify.load(Ordering::Acquire) {
                    cancellation.check()?;
                    std::thread::yield_now();
                }
                Err(PackageError::InvalidInstall)
            },
        )
    };
    let manager = manager_with_clock_and_verifier(
        &temp,
        fixture.catalog,
        Arc::new(MemoryFetcher::new(fixture.archive, false)),
        Arc::new(TestCoordinator::default()),
        clock,
        verifier,
    );
    manager
        .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
        .unwrap();
    now.store(
        initial_now + verified_install::MAX_FAST_VERIFY_AGE_SECONDS,
        Ordering::Release,
    );

    let verify = |manager: EnginePackageManager| {
        std::thread::spawn(move || {
            let delivery = manager.0.0.catalog.current(&EngineId::Parakeet).unwrap();
            manager
                .0
                .verify_once(EngineId::Parakeet, delivery, &CancellationToken::default())
        })
    };
    let owner = verify(manager.clone());
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let waiter = verify(manager.clone());
    let key = (EngineId::Parakeet, "1.0.0".to_string());
    wait_for_flight_holders(&manager, &key, 3);

    let poisoner = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let _activity = manager.0.0.activity.lock().unwrap();
            panic!("deliberately poison activity completion");
        })
    };
    assert!(poisoner.join().is_err());
    release_verify.store(true, Ordering::Release);

    assert_eq!(owner.join().unwrap(), Err(PackageError::StoreUnavailable));
    assert_eq!(
        waiter.join().unwrap(),
        Err(PackageError::StoreUnavailable),
        "the poisoned owner must still publish and wake its existing waiter"
    );
    assert_eq!(verify_calls.load(Ordering::Acquire), 1);
}

#[test]
fn cold_integrity_verification_is_single_flight_across_status_and_launch() {
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
    manager.0.clear_verified(EngineId::Parakeet);
    let key = (EngineId::Parakeet, delivery.version.clone());
    let flight = Arc::new(VerificationFlight::default());
    manager
        .0
        .0
        .activity
        .lock()
        .unwrap()
        .verifying_versions
        .insert(key.clone(), flight.clone());

    // A probe that collides with an in-flight verification WAITS for its verdict rather than
    // inventing one: reporting the collision as an error once made a racing status call show a
    // fully installed engine as missing while the winning probe was still hashing.
    let waiter = {
        let manager = manager.clone();
        std::thread::spawn(move || manager.status(EngineId::Parakeet))
    };
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        !waiter.is_finished(),
        "a concurrent status probe must wait for the in-flight verification, not answer early",
    );
    assert!(!manager.0.is_verified(EngineId::Parakeet, delivery));

    manager
        .0
        .record_verified_receipt(EngineId::Parakeet, delivery);
    {
        let mut activity = manager.0.0.activity.lock().unwrap();
        remove_verification_flight(&mut activity, &key, &flight);
    }
    flight.complete(Ok(()));
    let concurrent_status = waiter.join().unwrap();
    assert_eq!(concurrent_status.state, EnginePackageState::Installed);
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Installed
    );
    assert!(manager.0.is_verified(EngineId::Parakeet, delivery));
}
