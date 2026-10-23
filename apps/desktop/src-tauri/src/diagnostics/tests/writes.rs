//! Degraded-receipt events and fail-closed handling of oversized or partial writes.

use super::*;

#[test]
fn receipt_write_degraded_event_fires_exactly_once_per_component_when_degraded() {
    let component = unique_test_component();
    let mut emitted = Vec::new();
    for _ in 0..3 {
        record_receipt_write_degraded_with(&component, true, |event, fields| {
            emitted.push((event, fields.to_vec()));
        });
    }
    assert_eq!(emitted.len(), 1, "repeated degraded reads must report once");
    let (event, fields) = &emitted[0];
    assert_eq!(*event, "engine-packages.receipt_write_degraded");
    assert_eq!(fields, &[("component", component)]);
}

#[test]
fn receipt_write_degraded_event_never_fires_when_healthy() {
    let component = unique_test_component();
    let mut emitted: Vec<(&'static str, Vec<(&'static str, String)>)> = Vec::new();
    for _ in 0..3 {
        record_receipt_write_degraded_with(&component, false, |event, fields| {
            emitted.push((event, fields.to_vec()));
        });
    }
    assert!(
        emitted.is_empty(),
        "a healthy component must never be reported"
    );

    // A healthy read never consumes the per-component "already reported" slot: a later
    // degraded read for the SAME component must still fire.
    record_receipt_write_degraded_with(&component, true, |event, fields| {
        emitted.push((event, fields.to_vec()));
    });
    assert_eq!(emitted.len(), 1);
}

#[test]
fn receipt_write_degraded_event_reports_each_distinct_component_independently() {
    let first = unique_test_component();
    let second = unique_test_component();
    let mut emitted = Vec::new();
    record_receipt_write_degraded_with(&first, true, |event, fields| {
        emitted.push((event, fields.to_vec()));
    });
    record_receipt_write_degraded_with(&second, true, |event, fields| {
        emitted.push((event, fields.to_vec()));
    });
    assert_eq!(
        emitted.len(),
        2,
        "distinct components must each be reported"
    );
    let reported_components = emitted
        .iter()
        .map(|(_, fields)| fields[0].1.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(reported_components, BTreeSet::from([first, second]));
}

#[test]
fn running_log_rejects_one_oversized_record_without_writing_it() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    let oversized = vec![b'x'; MAX_RECORD_BYTES + 1];
    assert_eq!(
        log.append(&oversized).expect_err("oversized record").kind(),
        io::ErrorKind::InvalidData,
    );
    assert!(
        fs::read(directory.path().join(LOG_FILE_NAME))
            .expect("current log")
            .is_empty()
    );
}

#[test]
fn partial_write_with_unknown_disk_length_disables_the_logger() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    let error = log
        .append_with_io(
            b"abcdef",
            |file, _| {
                file.write_all(b"abc")?;
                Err(io::Error::other("injected partial write failure"))
            },
            |_| Err(io::Error::other("injected metadata failure")),
        )
        .expect_err("partial write must fail");
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(log.length, MAX_LOG_BYTES);
    assert!(log.file.is_none());
    assert_eq!(
        fs::read(directory.path().join(LOG_FILE_NAME)).expect("partially written log"),
        b"abc"
    );
    assert!(log.append(b"z").is_err());
    assert_eq!(
        fs::read(directory.path().join(LOG_FILE_NAME)).expect("unchanged partial log"),
        b"abc"
    );
}

#[test]
fn partial_write_with_a_stale_measured_length_uses_the_full_record_upper_bound() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    log.append_with_io(
        b"abcdef",
        |file, _| {
            file.write_all(b"abc")?;
            Err(io::Error::other("injected partial write failure"))
        },
        |_| Ok(0),
    )
    .expect_err("partial write must fail");

    assert_eq!(log.length, 6);
    assert!(log.file.is_some());
    assert_eq!(
        fs::read(directory.path().join(LOG_FILE_NAME)).expect("partially written log"),
        b"abc"
    );
}

#[test]
fn reopened_file_with_unknown_length_disables_the_logger() {
    let directory = canonical_tempdir().expect("temporary log directory");
    let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
    log.file = None;
    let replacement = OpenOptions::new()
        .append(true)
        .open(directory.path().join(LOG_FILE_NAME))
        .expect("open replacement handle");
    let error = log
        .install_reopened_file_with(replacement, |_| {
            Err(io::Error::other("injected reopened metadata failure"))
        })
        .expect_err("metadata failure must reject reopened file");
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(log.length, MAX_LOG_BYTES);
    assert!(log.file.is_none());
}
