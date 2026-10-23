use std::io::{Cursor, Write as _};

use zip::write::SimpleFileOptions;

use super::*;

const X_SHA256: &str = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";

fn limits(selective: bool) -> ZipLimits {
    ZipLimits {
        policy: PathPolicy::TOOL,
        max_entries: 8,
        max_declared_bytes: 1024,
        selective,
    }
}

fn one_file() -> HashMap<&'static str, EntryTarget<'static>> {
    HashMap::from([(
        "deno.exe",
        EntryTarget {
            install_path: "bin/deno.exe",
            size_bytes: 1,
            sha256: X_SHA256,
            executable: true,
        },
    )])
}

fn zip_with(entries: &[(&str, &[u8])], directories: &[&str]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for directory in directories {
        writer
            .add_directory(*directory, SimpleFileOptions::default())
            .unwrap();
    }
    for (name, bytes) in entries {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn run(
    encoded: &[u8],
    expected: &HashMap<&str, EntryTarget<'_>>,
    limits: ZipLimits,
) -> (Result<u64>, tempfile::TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let archive_path = temp.path().join("archive.zip");
    let staging = temp.path().join("staging");
    fs::write(&archive_path, encoded).unwrap();
    fs::create_dir(&staging).unwrap();
    let result = extract_zip(
        &archive_path,
        &staging,
        expected,
        limits,
        ExtractProgress {
            cancellation: &CancellationToken::default(),
            sink: &|_| {},
            completed_before: 0,
            total: 1,
        },
    );
    (result, temp)
}

#[test]
fn traversal_entries_are_rejected_before_any_outside_write() {
    let encoded = zip_with(&[("../escape", b"x")], &[]);
    for selective in [false, true] {
        let (result, temp) = run(&encoded, &one_file(), limits(selective));
        assert_eq!(result, Err(DeliveryError::UnsafeArchive));
        assert!(!temp.path().join("escape").exists());
    }
}

#[test]
fn exact_archives_reject_extras_and_directories() {
    let encoded = zip_with(&[("deno.exe", b"x"), ("extra.txt", b"y")], &[]);
    assert_eq!(
        run(&encoded, &one_file(), limits(false)).0,
        Err(DeliveryError::UnsafeArchive)
    );
    let with_directory = zip_with(&[("deno.exe", b"x")], &["docs/"]);
    assert_eq!(
        run(&with_directory, &one_file(), limits(false)).0,
        Err(DeliveryError::UnsafeArchive)
    );
}

#[test]
fn selective_archives_extract_only_the_reviewed_inventory() {
    let encoded = zip_with(
        &[("deno.exe", b"x"), ("vendor-documentation.txt", b"pinned")],
        &["docs/"],
    );
    let (result, temp) = run(&encoded, &one_file(), limits(true));
    assert_eq!(result, Ok(1));
    let staging = temp.path().join("staging");
    assert_eq!(fs::read(staging.join("bin/deno.exe")).unwrap(), b"x");
    assert!(!staging.join("vendor-documentation.txt").exists());
}

#[test]
fn missing_and_duplicate_entries_fail_closed() {
    let empty = zip_with(&[("other.txt", b"x")], &[]);
    assert_eq!(
        run(&empty, &one_file(), limits(true)).0,
        Err(DeliveryError::UnsafeArchive)
    );
}

#[test]
fn digest_mismatches_and_declared_size_budgets_are_enforced() {
    let wrong = zip_with(&[("deno.exe", b"y")], &[]);
    assert_eq!(
        run(&wrong, &one_file(), limits(false)).0,
        Err(DeliveryError::Integrity)
    );
    let large = vec![0_u8; 2048];
    let oversized = zip_with(&[("deno.exe", b"x"), ("vendor.bin", &large)], &[]);
    assert_eq!(
        run(&oversized, &one_file(), limits(true)).0,
        Err(DeliveryError::StorageLimit)
    );
}

#[test]
fn cancellation_stops_before_writing() {
    let encoded = zip_with(&[("deno.exe", b"x")], &[]);
    let temp = tempfile::tempdir().unwrap();
    let archive_path = temp.path().join("archive.zip");
    let staging = temp.path().join("staging");
    fs::write(&archive_path, encoded).unwrap();
    fs::create_dir(&staging).unwrap();
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert_eq!(
        extract_zip(
            &archive_path,
            &staging,
            &one_file(),
            limits(false),
            ExtractProgress {
                cancellation: &cancellation,
                sink: &|_| {},
                completed_before: 0,
                total: 1,
            },
        ),
        Err(DeliveryError::Cancelled)
    );
    assert!(!staging.join("bin").exists());
}

#[test]
fn link_and_device_modes_are_never_regular_files() {
    assert!(safe_unix_mode(Some(0o100_755), false));
    assert!(safe_unix_mode(Some(0o040_755), true));
    assert!(safe_unix_mode(None, false));
    assert!(!safe_unix_mode(Some(0o040_755), false));
    assert!(!safe_unix_mode(Some(0o120_777), false));
    assert!(!safe_unix_mode(Some(0o060_644), false));
}
