//! Symlink, hard-link and path-replacement rejection.

use super::*;

#[test]
fn file_symlinks_are_rejected_without_touching_their_targets() {
    let temporary = canonical_tempdir().expect("temporary root");
    let directory = temporary.path().join("logs");
    fs::create_dir(&directory).expect("create log directory");
    let external = temporary.path().join("external.log");
    fs::write(&external, b"outside").expect("write external file");
    if create_file_symlink(&external, &directory.join(LOG_FILE_NAME)).is_err() {
        return;
    }

    let error = DiagnosticLog::open(&directory)
        .err()
        .expect("symlinked current log must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        fs::read(external).expect("external remains readable"),
        b"outside"
    );
}

#[test]
fn lock_symlinks_are_rejected_without_touching_their_targets() {
    let temporary = canonical_tempdir().expect("temporary root");
    let directory = temporary.path().join("logs");
    fs::create_dir(&directory).expect("create log directory");
    let external = temporary.path().join("external.lock");
    fs::write(&external, b"outside-lock").expect("write external lock");
    if create_file_symlink(&external, &directory.join(LOCK_FILE_NAME)).is_err() {
        return;
    }

    let error = DiagnosticLog::open(&directory)
        .err()
        .expect("symlinked process lock must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        fs::read(external).expect("external lock remains readable"),
        b"outside-lock"
    );
    assert!(!directory.join(LOG_FILE_NAME).exists());
}

#[test]
fn replacing_the_open_log_path_disables_logging_before_writing_the_replacement() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    log.append(b"owned").expect("owner append");
    let current = directory.path().join(LOG_FILE_NAME);
    let displaced = directory.path().join("displaced.log");
    if fs::rename(&current, &displaced).is_err() {
        return;
    }
    fs::write(&current, b"replacement").expect("write replacement path");

    assert_eq!(
        log.append(b"must-not-be-written")
            .expect_err("replaced path must fail")
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert!(log.file.is_none());
    assert_eq!(
        fs::read(current).expect("replacement remains"),
        b"replacement"
    );
    assert_eq!(fs::read(displaced).expect("owned log remains"), b"owned");
}

#[test]
fn directory_symlinks_are_rejected_before_creating_any_log_entry() {
    let temporary = canonical_tempdir().expect("temporary root");
    let target = temporary.path().join("target");
    let alias = temporary.path().join("alias");
    fs::create_dir(&target).expect("create target directory");
    if create_directory_symlink(&target, &alias).is_err() {
        return;
    }

    let error = DiagnosticLog::open(&alias)
        .err()
        .expect("symlinked log directory must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(fs::read_dir(target).expect("target directory").count(), 0);
}

#[test]
fn symlinked_directory_ancestor_is_rejected_before_creating_any_log_entry() {
    let temporary = canonical_tempdir().expect("temporary root");
    let target = temporary.path().join("target");
    let alias = temporary.path().join("alias");
    fs::create_dir(&target).expect("create target directory");
    if create_directory_symlink(&target, &alias).is_err() {
        return;
    }
    let nested = alias.join("logs");

    let error = DiagnosticLog::open(&nested)
        .err()
        .expect("redirected log ancestor must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(fs::read_dir(target).expect("target directory").count(), 0);
}

#[test]
fn previous_log_symlink_blocks_rotation_without_touching_external_data() {
    let temporary = canonical_tempdir().expect("temporary root");
    let directory = temporary.path().join("logs");
    fs::create_dir(&directory).expect("create log directory");
    fs::write(
        directory.join(LOG_FILE_NAME),
        vec![b'x'; usize::try_from(MAX_LOG_BYTES).expect("bounded diagnostic log fixture")],
    )
    .expect("write full current log");
    let external = temporary.path().join("external.previous");
    fs::write(&external, b"outside-previous").expect("write external previous");
    if create_file_symlink(&external, &directory.join(PREVIOUS_LOG_FILE_NAME)).is_err() {
        return;
    }

    let error = DiagnosticLog::open(&directory)
        .err()
        .expect("symlinked previous log must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        fs::read(external).expect("external previous remains readable"),
        b"outside-previous"
    );
    assert_eq!(
        fs::metadata(directory.join(LOG_FILE_NAME))
            .expect("current remains")
            .len(),
        MAX_LOG_BYTES
    );
}

#[test]
fn unsafe_rotation_target_created_during_runtime_disables_logging() {
    let temporary = canonical_tempdir().expect("temporary root");
    let directory = temporary.path().join("logs");
    let mut log = DiagnosticLog::open(&directory).expect("open diagnostic log");
    let record = vec![b'x'; MAX_RECORD_BYTES];
    let record_count = MAX_LOG_BYTES / u64::try_from(MAX_RECORD_BYTES).expect("bounded record");
    for _ in 0..record_count {
        log.append(&record).expect("fill current log exactly");
    }
    let external = temporary.path().join("external.previous");
    fs::write(&external, b"outside-previous").expect("write external previous");
    if create_file_symlink(&external, &directory.join(PREVIOUS_LOG_FILE_NAME)).is_err() {
        return;
    }

    assert_eq!(
        log.append(b"must-not-be-written")
            .expect_err("unsafe rotation must fail")
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert!(log.file.is_none());
    assert_eq!(log.length, MAX_LOG_BYTES);
    assert_eq!(
        fs::read(external).expect("external previous remains readable"),
        b"outside-previous"
    );
    assert_eq!(
        fs::metadata(directory.join(LOG_FILE_NAME))
            .expect("current remains")
            .len(),
        MAX_LOG_BYTES
    );
}

#[cfg(any(unix, windows))]
#[test]
fn existing_hardlinked_current_previous_and_lock_paths_are_rejected() {
    let temporary = canonical_tempdir().expect("temporary root");
    for file_name in [LOG_FILE_NAME, PREVIOUS_LOG_FILE_NAME, LOCK_FILE_NAME] {
        let directory = temporary.path().join(file_name.replace('.', "_"));
        fs::create_dir(&directory).expect("create log directory");
        let external = temporary.path().join(format!("external-{file_name}"));
        fs::write(&external, b"outside").expect("write external file");
        fs::hard_link(&external, directory.join(file_name)).expect("create hardlink");

        let error = DiagnosticLog::open(&directory)
            .err()
            .expect("hardlinked diagnostic path must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(external).expect("external remains"), b"outside");
        if file_name != LOCK_FILE_NAME {
            assert!(!directory.join(LOCK_FILE_NAME).exists());
        }
        if file_name != LOG_FILE_NAME {
            assert!(!directory.join(LOG_FILE_NAME).exists());
        }
    }
}

#[cfg(any(unix, windows))]
#[test]
fn hardlink_added_after_open_is_rejected_before_the_next_write() {
    let temporary = canonical_tempdir().expect("temporary root");
    let directory = temporary.path().join("logs");
    let mut log = DiagnosticLog::open(&directory).expect("open diagnostic log");
    let current = directory.join(LOG_FILE_NAME);
    let alias = temporary.path().join("external-current.log");
    fs::hard_link(&current, &alias).expect("create runtime hardlink");

    assert_eq!(
        log.append(b"must-not-be-written")
            .expect_err("runtime hardlink must disable logging")
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert!(log.file.is_none());
    assert!(fs::read(&current).expect("current remains").is_empty());
    assert!(fs::read(&alias).expect("alias remains").is_empty());
}
