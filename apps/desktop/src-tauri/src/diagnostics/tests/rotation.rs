//! Size-bounded rotation and recovery of interrupted or failed rotations.

use super::*;

#[test]
fn running_log_allows_the_exact_bound_then_rotates_before_one_more_byte() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    let record = vec![b'a'; MAX_RECORD_BYTES];
    let record_count = MAX_LOG_BYTES / u64::try_from(MAX_RECORD_BYTES).expect("bounded record");
    for _ in 0..record_count {
        log.append(&record).expect("append through exact bound");
    }

    let current = directory.path().join(LOG_FILE_NAME);
    let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
    assert_eq!(
        fs::metadata(&current).expect("current metadata").len(),
        MAX_LOG_BYTES
    );
    assert!(!previous.exists());

    log.append(b"b").expect("rotate beyond exact bound");
    assert_eq!(
        fs::metadata(&previous).expect("previous metadata").len(),
        MAX_LOG_BYTES
    );
    assert_eq!(fs::read(&current).expect("fresh current"), b"b");
}

#[test]
fn startup_rotation_occurs_at_the_exact_bound_but_not_one_byte_below() {
    let temporary = canonical_tempdir().expect("temporary root");
    let below = temporary.path().join("below");
    fs::create_dir(&below).expect("create below-bound directory");
    fs::write(
        below.join(LOG_FILE_NAME),
        vec![b'a'; usize::try_from(MAX_LOG_BYTES - 1).expect("bounded fixture")],
    )
    .expect("write below-bound log");
    let below_log = DiagnosticLog::open(&below).expect("open below-bound log");
    assert_eq!(below_log.length, MAX_LOG_BYTES - 1);
    assert!(!below.join(PREVIOUS_LOG_FILE_NAME).exists());
    drop(below_log);

    let exact = temporary.path().join("exact");
    fs::create_dir(&exact).expect("create exact-bound directory");
    fs::write(
        exact.join(LOG_FILE_NAME),
        vec![b'b'; usize::try_from(MAX_LOG_BYTES).expect("bounded fixture")],
    )
    .expect("write exact-bound log");
    let exact_log = DiagnosticLog::open(&exact).expect("open exact-bound log");
    assert_eq!(exact_log.length, 0);
    assert_eq!(
        fs::metadata(exact.join(PREVIOUS_LOG_FILE_NAME))
            .expect("rotated exact-bound log")
            .len(),
        MAX_LOG_BYTES
    );
}

#[test]
fn interrupted_rotation_states_restore_both_prior_logs_before_opening() {
    enum InterruptedState {
        PreviousMoved,
        CurrentMoved,
        FreshCurrentCreated,
    }

    for (index, state) in [
        InterruptedState::PreviousMoved,
        InterruptedState::CurrentMoved,
        InterruptedState::FreshCurrentCreated,
    ]
    .into_iter()
    .enumerate()
    {
        let temporary = canonical_tempdir().expect("temporary root");
        let directory = temporary.path().join(format!("state-{index}"));
        fs::create_dir(&directory).expect("create interrupted log directory");
        let current = directory.join(LOG_FILE_NAME);
        let previous = directory.join(PREVIOUS_LOG_FILE_NAME);
        let backup = directory.join(ROTATION_BACKUP_FILE_NAME);
        match state {
            InterruptedState::PreviousMoved => {
                fs::write(&current, b"prior-current").expect("seed current");
                fs::write(&backup, b"prior-previous").expect("seed backup");
            }
            InterruptedState::CurrentMoved => {
                fs::write(&previous, b"prior-current").expect("seed moved current");
                fs::write(&backup, b"prior-previous").expect("seed backup");
            }
            InterruptedState::FreshCurrentCreated => {
                fs::write(&current, b"").expect("seed fresh current");
                fs::write(&previous, b"prior-current").expect("seed moved current");
                fs::write(&backup, b"prior-previous").expect("seed backup");
            }
        }

        let log = DiagnosticLog::open(&directory).expect("recover interrupted rotation");
        assert_eq!(
            fs::read(&current).expect("restored current"),
            b"prior-current"
        );
        assert_eq!(
            fs::read(&previous).expect("restored previous"),
            b"prior-previous"
        );
        assert!(!backup.exists());
        drop(log);
    }
}

#[test]
fn injected_rotation_failures_restore_both_prior_logs_at_every_boundary() {
    for point in [
        RotationPoint::Validated,
        RotationPoint::PreviousMoved,
        RotationPoint::CurrentMoved,
        RotationPoint::CurrentCreated,
        RotationPoint::BeforeCommit,
    ] {
        let directory = canonical_tempdir().expect("temporary log directory");
        let current = directory.path().join(LOG_FILE_NAME);
        let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
        let backup = directory.path().join(ROTATION_BACKUP_FILE_NAME);
        fs::write(&current, b"prior-current").expect("seed current");
        fs::write(&previous, b"prior-previous").expect("seed previous");
        let directory_handle = open_log_directory(directory.path()).expect("open directory");
        let process_lock = ProcessLock::acquire(directory.path(), &directory_handle)
            .expect("acquire process lock");

        let error =
            rotate_paths_with_hook(directory.path(), &directory_handle, &current, |observed| {
                if observed == point {
                    Err(io::Error::other("injected rotation failure"))
                } else {
                    Ok(())
                }
            })
            .expect_err("injected rotation must fail");
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(
            fs::read(&current).expect("restored current"),
            b"prior-current"
        );
        assert_eq!(
            fs::read(&previous).expect("restored previous"),
            b"prior-previous"
        );
        assert!(!backup.exists());
        drop(process_lock);
    }
}

#[test]
fn running_log_rotates_repeatedly_and_keeps_two_log_files_plus_the_lock() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    let first = vec![b'a'; usize::try_from(MAX_LOG_BYTES - 2).expect("bounded fixture")];
    for record in first.chunks(MAX_RECORD_BYTES) {
        log.append(record).expect("append bounded first log");
    }
    log.append(b"bcd").expect("rotate and append next record");

    let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
    let current = directory.path().join(LOG_FILE_NAME);
    assert_eq!(fs::read(&previous).expect("previous log"), first);
    assert_eq!(fs::read(&current).expect("current log"), b"bcd");

    let second = vec![b'e'; usize::try_from(MAX_LOG_BYTES - 3).expect("bounded fixture")];
    for record in second.chunks(MAX_RECORD_BYTES) {
        log.append(record).expect("fill current log exactly");
    }
    log.append(b"f").expect("rotate a second time");
    assert_eq!(
        fs::metadata(&previous)
            .expect("replaced previous log")
            .len(),
        MAX_LOG_BYTES,
    );
    assert_eq!(fs::read(&current).expect("fresh current log"), b"f");
    let names = fs::read_dir(directory.path())
        .expect("log directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        names,
        BTreeSet::from([
            LOCK_FILE_NAME.to_owned(),
            LOG_FILE_NAME.to_owned(),
            PREVIOUS_LOG_FILE_NAME.to_owned(),
        ])
    );
}
