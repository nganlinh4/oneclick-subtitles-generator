//! Registry initialization and cross-process lock ownership.

use super::*;

#[test]
fn registry_reinitialization_fails_before_mutating_same_or_different_directory() {
    let temporary = canonical_tempdir().expect("temporary root");
    let first = temporary.path().join("first");
    let second = temporary.path().join("second");
    let registry = DiagnosticRegistry::new();
    registry.initialize(&first).expect("initialize registry");
    let before = fs::read(first.join(LOG_FILE_NAME)).expect("initial app start");
    let entries_before = directory_snapshot(&first);

    assert_eq!(
        registry
            .initialize(&first)
            .expect_err("same-directory reinitialization")
            .kind(),
        io::ErrorKind::AlreadyExists,
    );
    assert_eq!(
        registry
            .initialize(&second)
            .expect_err("different-directory reinitialization")
            .kind(),
        io::ErrorKind::AlreadyExists,
    );
    assert_eq!(
        fs::read(first.join(LOG_FILE_NAME)).expect("unchanged log"),
        before
    );
    assert_eq!(directory_snapshot(&first), entries_before);
    assert!(!second.exists());
    assert_eq!(
        before
            .split(|byte| *byte == b'\n')
            .filter(|record| !record.is_empty())
            .count(),
        1
    );
}

#[test]
fn concurrent_registry_initialization_has_one_owner_and_no_loser_directory() {
    let temporary = canonical_tempdir().expect("temporary root");
    let directories = [temporary.path().join("one"), temporary.path().join("two")];
    let registry = Arc::new(DiagnosticRegistry::new());
    let barrier = Arc::new(Barrier::new(3));
    let workers = directories
        .iter()
        .cloned()
        .map(|directory| {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                registry.initialize(&directory).map(|()| directory)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("initializer thread"))
        .collect::<Vec<_>>();

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .filter(|error| error.kind() == io::ErrorKind::AlreadyExists)
            .count(),
        1
    );
    assert_eq!(directories.iter().filter(|path| path.exists()).count(), 1);
}

#[test]
fn process_lock_contention_cannot_rotate_or_append_logs() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut owner = DiagnosticLog::open(directory.path()).expect("first process owner");
    owner.append(b"owned").expect("owner append");
    let before = directory_snapshot(directory.path());

    run_process_lock_probe(directory.path(), "contended");
    assert_eq!(directory_snapshot(directory.path()), before);

    drop(owner);
    run_process_lock_probe(directory.path(), "available");
}

#[cfg(windows)]
#[test]
fn sharing_denied_rotation_keeps_both_logs_and_recovers_the_transaction() {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;

    let directory = canonical_tempdir().expect("temporary log directory");
    let current = directory.path().join(LOG_FILE_NAME);
    let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
    let backup = directory.path().join(ROTATION_BACKUP_FILE_NAME);
    fs::write(&current, b"prior-current").expect("seed current");
    fs::write(&previous, b"prior-previous").expect("seed previous");
    let directory_handle = open_log_directory(directory.path()).expect("open directory");
    let process_lock =
        ProcessLock::acquire(directory.path(), &directory_handle).expect("acquire lock");

    let current_blocker = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&current)
        .expect("hold current without delete sharing");
    rotate_paths_with_hook(directory.path(), &directory_handle, &current, |_| Ok(()))
        .expect_err("sharing-denied current rename must fail");
    assert_eq!(
        fs::read(&current).expect("current remains"),
        b"prior-current"
    );
    assert_eq!(
        fs::read(&previous).expect("previous restored"),
        b"prior-previous"
    );
    assert!(!backup.exists());
    drop(current_blocker);

    let mut backup_blocker = None;
    rotate_paths_with_hook(directory.path(), &directory_handle, &current, |point| {
        if point == RotationPoint::BeforeCommit {
            backup_blocker = Some(
                OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ)
                    .open(&backup)?,
            );
        }
        Ok(())
    })
    .expect_err("sharing-denied commit must fail");
    assert_eq!(
        fs::read(&current).expect("restored current"),
        b"prior-current"
    );
    assert_eq!(
        fs::read(&backup).expect("preserved backup"),
        b"prior-previous"
    );
    assert!(!previous.exists());

    drop(backup_blocker);
    recover_interrupted_rotation(directory.path(), &directory_handle, &current)
        .expect("recover sharing-denied transaction");
    assert_eq!(
        fs::read(&current).expect("recovered current"),
        b"prior-current"
    );
    assert_eq!(
        fs::read(&previous).expect("recovered previous"),
        b"prior-previous"
    );
    assert!(!backup.exists());
    drop(process_lock);
}

#[test]
fn existing_lock_data_is_never_truncated_or_deleted() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let lock = directory.path().join(LOCK_FILE_NAME);
    fs::write(&lock, b"unknown-owner-data").expect("seed lock data");
    let log = DiagnosticLog::open(directory.path()).expect("open with existing lock data");
    drop(log);
    assert_eq!(
        fs::read(lock).expect("read lock data"),
        b"unknown-owner-data"
    );
}
