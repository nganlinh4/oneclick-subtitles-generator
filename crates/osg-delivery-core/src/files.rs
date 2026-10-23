//! Content hashing, verified copies, bounded reads, and no-clobber writes.

use std::fs;
use std::io::{Read, Write as _};
use std::path::Path;

use sha2::{Digest as _, Sha256};

use crate::Result;
use crate::paths::require_regular_file;
use crate::{CancellationToken, DeliveryError, OperationPhase, OperationProgress, ProgressSink};

const BUFFER_BYTES: usize = 256 * 1024;

/// Streams a regular file through SHA-256. An unreadable or linked path is `InvalidInstall`.
pub fn hash_file(path: &Path, cancellation: &CancellationToken) -> Result<String> {
    require_regular_file(path)?;
    let mut input = fs::File::open(path).map_err(|_| DeliveryError::InvalidInstall)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; BUFFER_BYTES].into_boxed_slice();
    loop {
        cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| DeliveryError::InvalidInstall)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The exact size and digest a copied stream must produce.
#[derive(Clone, Copy, Debug)]
pub struct ExpectedContent<'a> {
    pub size_bytes: u64,
    pub sha256: &'a str,
}

/// Cancellation and progress for one copy inside a larger operation.
#[derive(Clone, Copy)]
pub struct CopyProgress<'a> {
    pub cancellation: &'a CancellationToken,
    pub sink: &'a dyn ProgressSink,
    pub phase: OperationPhase,
    pub completed_before: u64,
    pub total: u64,
}

impl std::fmt::Debug for CopyProgress<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CopyProgress")
            .field("phase", &self.phase)
            .field("completed_before", &self.completed_before)
            .field("total", &self.total)
            .finish_non_exhaustive()
    }
}

/// Copies `input` into a freshly created `output`, hashing as it goes.
///
/// A source that reads more than declared or fails to read is `UnsafeArchive`, a size or digest
/// mismatch is `Integrity`, a running total beyond `copy.total` is `StorageLimit`, and a write
/// failure is `StoreUnavailable`. The output is flushed and synced before returning.
pub fn copy_verified(
    input: &mut impl Read,
    output: &mut fs::File,
    expected: ExpectedContent<'_>,
    copy: CopyProgress<'_>,
) -> Result<()> {
    let mut hasher = Sha256::new();
    let mut written = 0_u64;
    let mut buffer = vec![0_u8; BUFFER_BYTES].into_boxed_slice();
    loop {
        copy.cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| DeliveryError::UnsafeArchive)?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .filter(|value| *value <= expected.size_bytes)
            .ok_or(DeliveryError::UnsafeArchive)?;
        let overall = copy
            .completed_before
            .checked_add(written)
            .filter(|value| *value <= copy.total)
            .ok_or(DeliveryError::StorageLimit)?;
        output
            .write_all(&buffer[..read])
            .map_err(|_| DeliveryError::StoreUnavailable)?;
        hasher.update(&buffer[..read]);
        copy.sink
            .on_progress(OperationProgress::new(copy.phase, overall, copy.total));
    }
    if written != expected.size_bytes || format!("{:x}", hasher.finalize()) != expected.sha256 {
        return Err(DeliveryError::Integrity);
    }
    output
        .flush()
        .and_then(|()| output.sync_all())
        .map_err(|_| DeliveryError::StoreUnavailable)
}

/// Reads a whole regular file of 1..=`maximum` bytes, refusing links and short or growing reads.
pub fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let metadata = require_regular_file(path)?;
    if metadata.len() == 0 || metadata.len() > maximum {
        return Err(DeliveryError::InvalidInstall);
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| DeliveryError::InvalidInstall)?;
    let mut encoded = Vec::with_capacity(capacity);
    fs::File::open(path)
        .map_err(|_| DeliveryError::InvalidInstall)?
        .take(maximum + 1)
        .read_to_end(&mut encoded)
        .map_err(|_| DeliveryError::InvalidInstall)?;
    if encoded.len() as u64 != metadata.len() {
        return Err(DeliveryError::InvalidInstall);
    }
    Ok(encoded)
}

/// Writes `bytes` to a path that must not exist yet, then syncs it.
pub fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| DeliveryError::StoreUnavailable)?;
    output
        .write_all(bytes)
        .and_then(|()| output.sync_all())
        .map_err(|_| DeliveryError::StoreUnavailable)
}

/// Whether an installed file can be launched: an `.exe` on Windows, an execute bit elsewhere.
#[cfg(windows)]
#[must_use]
pub fn is_executable(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(unix)]
#[must_use]
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

/// Gives a staged regular file its final mode (a no-op on Windows).
pub fn set_permissions(path: &Path, executable: bool) -> Result<()> {
    require_regular_file(path).map_err(|_| DeliveryError::StoreUnavailable)?;
    set_platform_permissions(path, executable)
}

#[cfg(unix)]
fn set_platform_permissions(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| DeliveryError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn set_platform_permissions(_: &Path, _: bool) -> Result<()> {
    Ok(())
}

/// Makes a rename inside `path` durable (directory handles cannot be synced on Windows).
#[cfg(unix)]
pub fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| DeliveryError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
pub fn sync_directory(_: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn copy_into(source: &[u8], expected: ExpectedContent<'_>, total: u64) -> Result<Vec<u8>> {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("out");
        let mut output = fs::File::create(&target).unwrap();
        copy_verified(
            &mut &source[..],
            &mut output,
            expected,
            CopyProgress {
                cancellation: &CancellationToken::default(),
                sink: &|_| {},
                phase: OperationPhase::Extracting,
                completed_before: 0,
                total,
            },
        )?;
        drop(output);
        Ok(fs::read(target).unwrap())
    }

    #[test]
    fn verified_copies_reject_oversize_mismatch_and_budget_overruns() {
        let exact = ExpectedContent {
            size_bytes: 5,
            sha256: HELLO_SHA256,
        };
        assert_eq!(copy_into(b"hello", exact, 5).unwrap(), b"hello");
        assert_eq!(
            copy_into(b"hello!", exact, 6),
            Err(DeliveryError::UnsafeArchive)
        );
        assert_eq!(copy_into(b"jello", exact, 5), Err(DeliveryError::Integrity));
        assert_eq!(copy_into(b"hell", exact, 5), Err(DeliveryError::Integrity));
        assert_eq!(
            copy_into(b"hello", exact, 4),
            Err(DeliveryError::StorageLimit)
        );
    }

    #[test]
    fn hashing_is_cancellable_and_refuses_directories() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("hello");
        fs::write(&file, b"hello").unwrap();
        assert_eq!(
            hash_file(&file, &CancellationToken::default()).unwrap(),
            HELLO_SHA256
        );
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        assert_eq!(hash_file(&file, &cancelled), Err(DeliveryError::Cancelled));
        assert_eq!(
            hash_file(temp.path(), &CancellationToken::default()),
            Err(DeliveryError::InvalidInstall)
        );
    }

    #[test]
    fn bounded_reads_and_no_clobber_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("receipt.json");
        write_new_synced(&path, b"{}").unwrap();
        assert_eq!(
            write_new_synced(&path, b"[]"),
            Err(DeliveryError::StoreUnavailable)
        );
        assert_eq!(read_bounded(&path, 2).unwrap(), b"{}");
        assert_eq!(read_bounded(&path, 1), Err(DeliveryError::InvalidInstall));
    }

    #[cfg(windows)]
    #[test]
    fn only_exe_files_count_as_executable_on_windows() {
        assert!(is_executable(Path::new("runtime/python.exe")));
        assert!(is_executable(Path::new("bin/FFMPEG.EXE")));
        assert!(!is_executable(Path::new("bin/tool.com")));
        assert!(!is_executable(Path::new("bin/tool")));
    }
}
