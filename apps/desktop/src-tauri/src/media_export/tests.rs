use std::cell::Cell;
use std::fs;
use std::path::Path;

use osg_domain::{JobKind, JobSnapshot};
use osg_runtime_staging::RuntimeStagingAuthority;

use super::*;

#[test]
fn completed_event_uses_the_exact_webview_field_contract() {
    let mut job = JobSnapshot::new(JobKind::ExportMedia);
    job.start().expect("start export job");
    job.succeed().expect("finish export job");
    let value = serde_json::to_value(MediaExportEvent::Completed {
        job,
        bytes_written: 42,
    })
    .expect("serialize export completion");
    let object = value.as_object().expect("event object");

    assert_eq!(
        object.get("event").and_then(serde_json::Value::as_str),
        Some("completed")
    );
    assert_eq!(
        object
            .get("bytesWritten")
            .and_then(serde_json::Value::as_u64),
        Some(42)
    );
    assert!(!object.contains_key("bytes_written"));
}

fn write_bytes(path: &Path, byte: u8, count: usize) {
    fs::write(path, vec![byte; count]).expect("write fixture");
}

fn staging_authority(root: &Path) -> RuntimeStagingAuthority {
    RuntimeStagingAuthority::prepare(&root.join("staging-authority")).unwrap()
}

#[test]
fn staged_copy_atomically_replaces_an_existing_regular_file() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source.mp4");
    let destination = root.path().join("export.mp4");
    write_bytes(&source, 7, COPY_BUFFER_BYTES + 31);
    write_bytes(&destination, 2, 8);
    let mut progress = Vec::new();
    let authority = staging_authority(root.path());

    copy_export(
        &authority,
        &source,
        &destination,
        COPY_BUFFER_BYTES as u64 + 31,
        || false,
        |completed, total| {
            progress.push((completed, total));
            Ok(())
        },
    )
    .expect("export");

    assert_eq!(
        fs::read(&destination).expect("read export"),
        vec![7; COPY_BUFFER_BYTES + 31]
    );
    assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    assert_eq!(
        progress.last(),
        Some(&(
            2 * (COPY_BUFFER_BYTES as u64 + 31),
            2 * (COPY_BUFFER_BYTES as u64 + 31)
        ))
    );
}

#[test]
fn cancellation_preserves_the_previous_destination() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source.mp4");
    let destination = root.path().join("export.mp4");
    write_bytes(&source, 7, COPY_BUFFER_BYTES * 2);
    write_bytes(&destination, 2, 8);
    let cancelled = Cell::new(false);
    let authority = staging_authority(root.path());

    let result = copy_export(
        &authority,
        &source,
        &destination,
        (COPY_BUFFER_BYTES * 2) as u64,
        || cancelled.get(),
        |_, _| {
            cancelled.set(true);
            Ok(())
        },
    );

    assert_eq!(result, Err(ExportCopyError::Cancelled));
    assert_eq!(fs::read(&destination).expect("read original"), vec![2; 8]);
}

#[test]
fn same_size_source_mutation_is_detected_before_commit() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source.mp4");
    let destination = root.path().join("export.mp4");
    write_bytes(&source, 7, COPY_BUFFER_BYTES * 2);
    let mutated = Cell::new(false);
    let authority = staging_authority(root.path());

    let result = copy_export(
        &authority,
        &source,
        &destination,
        (COPY_BUFFER_BYTES * 2) as u64,
        || false,
        |completed, total| {
            if !mutated.replace(true) && completed < total {
                write_bytes(&source, 9, COPY_BUFFER_BYTES * 2);
            }
            Ok(())
        },
    );

    assert_eq!(result, Err(ExportCopyError::SourceChanged));
    assert!(!destination.exists());
}

#[test]
fn source_and_destination_must_be_distinct_files() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source.mp4");
    write_bytes(&source, 7, 32);
    let authority = staging_authority(root.path());

    assert_eq!(
        copy_export(&authority, &source, &source, 32, || false, |_, _| Ok(())),
        Err(ExportCopyError::UnsafeDestination)
    );
    assert_eq!(fs::read(&source).expect("source"), vec![7; 32]);
}

#[cfg(unix)]
#[test]
fn symlink_sources_and_destinations_are_rejected() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("tempdir");
    let real_source = root.path().join("real.mp4");
    let source_link = root.path().join("source.mp4");
    let real_destination = root.path().join("real-export.mp4");
    let destination_link = root.path().join("export.mp4");
    write_bytes(&real_source, 7, 32);
    write_bytes(&real_destination, 2, 8);
    symlink(&real_source, &source_link).expect("source symlink");
    symlink(&real_destination, &destination_link).expect("destination symlink");
    let authority = staging_authority(root.path());

    assert_eq!(
        copy_export(
            &authority,
            &source_link,
            &root.path().join("fresh.mp4"),
            32,
            || false,
            |_, _| Ok(())
        ),
        Err(ExportCopyError::SourceChanged)
    );
    assert_eq!(
        copy_export(
            &authority,
            &real_source,
            &destination_link,
            32,
            || false,
            |_, _| Ok(())
        ),
        Err(ExportCopyError::UnsafeDestination)
    );
}

#[cfg(unix)]
#[test]
fn trusted_symlinked_ancestors_resolve_before_file_identity_checks() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("tempdir");
    let real = root.path().join("real");
    fs::create_dir_all(&real).expect("real directory");
    let alias = root.path().join("alias");
    symlink(&real, &alias).expect("directory alias");
    let source = alias.join("source.mp4");
    let destination = alias.join("export.mp4");
    write_bytes(&source, 7, 32);
    let authority = staging_authority(root.path());

    copy_export(
        &authority,
        &source,
        &destination,
        32,
        || false,
        |_, _| Ok(()),
    )
    .expect("export through canonical parent");

    assert_eq!(
        fs::read(real.join("export.mp4")).expect("read export"),
        vec![7; 32]
    );
}

#[test]
fn progress_never_claims_completion_before_the_job_succeeds() {
    assert_eq!(progress_basis_points(0, 20), 0);
    assert_eq!(progress_basis_points(10, 20), 4_999);
    assert_eq!(progress_basis_points(20, 20), 9_999);
}
