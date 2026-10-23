//! Metadata serialization, journal retirement, and unlocked write-sidecar recovery.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use fs2::FileExt;

use crate::METADATA_LOCK_FILE;
use crate::filesystem::{reject_unsafe_metadata, sync_directory};
use crate::kind::EntryType;
/// Serializes publication/reconciliation across independent authority handles and processes.
/// Per-entry journal locks still protect live payloads. This guard is never held while downloading,
/// decoding, rendering or otherwise using a staged payload.
pub(crate) struct MetadataLock(File);

impl Drop for MetadataLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(crate) fn lock_metadata(root: &Path) -> io::Result<MetadataLock> {
    let path = root.join(METADATA_LOCK_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => reject_unsafe_metadata(&metadata, EntryType::File)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    reject_unsafe_metadata(&fs::symlink_metadata(&path)?, EntryType::File)?;
    file.lock_exclusive()?;
    Ok(MetadataLock(file))
}

pub(crate) fn release_and_remove_journal(journal: File, path: &Path, authority_root: &Path) {
    // If metadata cannot be locked, keep the authenticated journal for recovery rather than race
    // another scanner. Dropping the file releases its live-owner lock without deleting authority.
    let Ok(_metadata_lock) = lock_metadata(authority_root) else {
        return;
    };
    release_and_remove_journal_locked(journal, path, authority_root);
}

pub(crate) fn release_and_remove_journal_locked(journal: File, path: &Path, authority_root: &Path) {
    let _ = FileExt::unlock(&journal);
    drop(journal);
    let _ = fs::remove_file(path);
    let _ = sync_directory(authority_root);
}

pub(crate) fn is_exact_write_sidecar(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|tail| tail.strip_suffix(".tmp"))
        .is_some_and(|nonce| {
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

pub(crate) fn remove_unlocked_sidecar(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    reject_unsafe_metadata(&metadata, EntryType::File)?;
    let sidecar = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match sidecar.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if is_lock_contended(&error) => return Ok(false),
        Err(error) => return Err(error),
    }
    match fs::remove_file(path) {
        Ok(()) => {
            let _ = FileExt::unlock(&sidecar);
            drop(sidecar);
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let _ = FileExt::unlock(&sidecar);
            drop(sidecar);
            Ok(false)
        }
        Err(error) => {
            let _ = FileExt::unlock(&sidecar);
            drop(sidecar);
            Err(error)
        }
    }
}

pub(crate) fn is_lock_contended(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // `fs2` reports Win32 sharing/lock violations without remapping them to WouldBlock.
        matches!(error.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}
