mod links;
mod locking;
mod rotation;
mod writes;

use std::collections::BTreeSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::process::Command;
use std::sync::{Arc, Barrier};
use std::thread;

// macOS exposes its temporary parent through /var -> /private/var. Use its physical
// spelling for fixtures; production log admission must still reject redirecting ancestors.
fn canonical_tempdir() -> io::Result<tempfile::TempDir> {
    tempfile::tempdir_in(fs::canonicalize(env::temp_dir())?)
}

use uuid::Uuid;

use super::file_safety::{open_log_directory, sanitize};
#[cfg(windows)]
use super::rotation::recover_interrupted_rotation;
use super::rotation::{RotationPoint, rotate_paths_with_hook};
use super::{
    DiagnosticLog, DiagnosticRegistry, LOCK_FILE_NAME, LOG_FILE_NAME, MAX_FIELD_BYTES,
    MAX_LOG_BYTES, MAX_RECORD_BYTES, PREVIOUS_LOG_FILE_NAME, ProcessLock,
    ROTATION_BACKUP_FILE_NAME, new_app_instance_id, record_receipt_write_degraded_with,
};

const PROCESS_LOCK_PROBE_DIRECTORY: &str = "OSG_TEST_DIAGNOSTIC_LOCK_DIRECTORY";
const PROCESS_LOCK_PROBE_EXPECTATION: &str = "OSG_TEST_DIAGNOSTIC_LOCK_EXPECTATION";

#[test]
fn diagnostic_fields_accept_identifiers_and_redact_paths_or_secrets() {
    assert_eq!(sanitize("media-tools"), "media-tools");
    assert_eq!(sanitize("019c:completed"), "019c:completed");
    assert_eq!(sanitize("C:\\private\\tool.exe"), "redacted");
    assert_eq!(sanitize("token=value"), "redacted");
    assert_eq!(sanitize(&"a".repeat(MAX_FIELD_BYTES + 1)), "redacted");
}

#[test]
fn application_instance_identifier_is_uuid_v7_and_log_safe() {
    let identifier = new_app_instance_id();
    assert_eq!(Uuid::parse_str(&identifier).unwrap().get_version_num(), 7);
    assert_eq!(sanitize(&identifier), identifier);
}

/// `RECEIPT_WRITE_DEGRADED_REPORTED` is one process-wide static; every test below uses its own
/// fresh UUID as the component id so parallel test threads can never collide on it.
fn unique_test_component() -> String {
    format!("test-component-{}", Uuid::new_v4().simple())
}

#[test]
fn diagnostic_process_lock_probe_child() {
    let Some(directory) = env::var_os(PROCESS_LOCK_PROBE_DIRECTORY) else {
        return;
    };
    let expectation = env::var(PROCESS_LOCK_PROBE_EXPECTATION).expect("lock expectation");
    let result = DiagnosticLog::open(std::path::Path::new(&directory));
    match expectation.as_str() {
        "contended" => assert_eq!(
            result.err().expect("lock must be contended").kind(),
            io::ErrorKind::WouldBlock
        ),
        "available" => assert!(result.is_ok()),
        _ => panic!("unexpected diagnostic lock probe expectation"),
    }
}

fn directory_snapshot(directory: &std::path::Path) -> Vec<(String, u64, Option<Vec<u8>>)> {
    let mut entries = fs::read_dir(directory)
        .expect("snapshot directory")
        .map(|entry| {
            let entry = entry.expect("snapshot entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            (
                name.clone(),
                fs::metadata(entry.path()).expect("snapshot metadata").len(),
                (name != LOCK_FILE_NAME).then(|| fs::read(entry.path()).expect("snapshot file")),
            )
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

fn run_process_lock_probe(directory: &std::path::Path, expectation: &str) {
    let output = Command::new(env::current_exe().expect("current test executable"))
        .args([
            "--exact",
            "diagnostics::tests::diagnostic_process_lock_probe_child",
            "--nocapture",
        ])
        .env(PROCESS_LOCK_PROBE_DIRECTORY, directory)
        .env(PROCESS_LOCK_PROBE_EXPECTATION, expectation)
        .output()
        .expect("run diagnostic lock probe process");
    assert!(
        output.status.success(),
        "diagnostic lock probe failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(unix)]
fn create_directory_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}
