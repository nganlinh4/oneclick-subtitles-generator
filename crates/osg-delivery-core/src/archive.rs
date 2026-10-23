//! Bounded, inventory-driven ZIP extraction into a private staging directory.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::BuildHasher;
use std::path::Path;

use crate::files::{CopyProgress, ExpectedContent, copy_verified, set_permissions};
use crate::paths::{PathPolicy, prepare_target, require_regular_file, validate_relative_path};
use crate::{CancellationToken, DeliveryError, OperationPhase, ProgressSink, Result};

/// Where one reviewed archive entry lands and what it must contain.
#[derive(Clone, Copy, Debug)]
pub struct EntryTarget<'a> {
    pub install_path: &'a str,
    pub size_bytes: u64,
    pub sha256: &'a str,
    pub executable: bool,
}

/// Archive-wide bounds. `selective` admits (and skips) directories and unlisted vendor files
/// already pinned by the outer archive digest; otherwise the archive must be exactly the
/// inventory.
#[derive(Clone, Copy, Debug)]
pub struct ZipLimits {
    pub policy: PathPolicy,
    pub max_entries: usize,
    pub max_declared_bytes: u64,
    pub selective: bool,
}

/// Progress for an extraction that may be one part of a larger operation.
#[derive(Clone, Copy)]
pub struct ExtractProgress<'a> {
    pub cancellation: &'a CancellationToken,
    pub sink: &'a dyn ProgressSink,
    pub completed_before: u64,
    pub total: u64,
}

impl std::fmt::Debug for ExtractProgress<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExtractProgress")
            .field("completed_before", &self.completed_before)
            .field("total", &self.total)
            .finish_non_exhaustive()
    }
}

/// Extracts every entry of `expected` (keyed by archive name) into `staging_root` and returns
/// the extracted byte count.
///
/// Traversal, absolute, device and duplicate names, link or device modes, size lies, and digest
/// mismatches fail closed before or while the entry is written; nothing is written outside
/// `staging_root` and no existing file is overwritten.
pub fn extract_zip<S: BuildHasher>(
    archive_path: &Path,
    staging_root: &Path,
    expected: &HashMap<&str, EntryTarget<'_>, S>,
    limits: ZipLimits,
    progress: ExtractProgress<'_>,
) -> Result<u64> {
    let archive_file = fs::File::open(archive_path).map_err(|_| DeliveryError::UnsafeArchive)?;
    let mut archive =
        zip::ZipArchive::new(archive_file).map_err(|_| DeliveryError::UnsafeArchive)?;
    if archive.len() > limits.max_entries
        || expected.len() > limits.max_entries
        || (!limits.selective && archive.len() != expected.len())
    {
        return Err(DeliveryError::UnsafeArchive);
    }
    let mut seen = HashSet::new();
    let mut extracted = 0_usize;
    let mut declared = 0_u64;
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        progress.cancellation.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| DeliveryError::UnsafeArchive)?;
        let name = entry.name().to_owned();
        let canonical = if entry.is_dir() {
            name.trim_end_matches('/')
        } else {
            name.as_str()
        };
        validate_relative_path(canonical, limits.policy)
            .map_err(|_| DeliveryError::UnsafeArchive)?;
        let enclosed = entry.enclosed_name().ok_or(DeliveryError::UnsafeArchive)?;
        declared = declared
            .checked_add(entry.size())
            .filter(|bytes| *bytes <= limits.max_declared_bytes)
            .ok_or(DeliveryError::StorageLimit)?;
        if !safe_unix_mode(entry.unix_mode(), entry.is_dir())
            || enclosed.to_string_lossy().replace('\\', "/") != canonical
            || !seen.insert(canonical.to_owned())
        {
            return Err(DeliveryError::UnsafeArchive);
        }
        let Some(target) = expected.get(canonical).copied() else {
            if limits.selective {
                continue;
            }
            return Err(DeliveryError::UnsafeArchive);
        };
        if entry.is_dir() || entry.size() != target.size_bytes {
            return Err(DeliveryError::UnsafeArchive);
        }
        let path = prepare_target(staging_root, target.install_path, limits.policy)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| DeliveryError::UnsafeArchive)?;
        copy_verified(
            &mut entry,
            &mut output,
            ExpectedContent {
                size_bytes: target.size_bytes,
                sha256: target.sha256,
            },
            CopyProgress {
                cancellation: progress.cancellation,
                sink: progress.sink,
                phase: OperationPhase::Extracting,
                completed_before: progress.completed_before.saturating_add(expanded),
                total: progress.total,
            },
        )?;
        drop(output);
        set_permissions(&path, target.executable)?;
        if require_regular_file(&path)?.len() != target.size_bytes {
            return Err(DeliveryError::Integrity);
        }
        expanded = expanded
            .checked_add(target.size_bytes)
            .ok_or(DeliveryError::StorageLimit)?;
        extracted += 1;
    }
    if extracted != expected.len() {
        return Err(DeliveryError::UnsafeArchive);
    }
    Ok(expanded)
}

/// Only regular files (and, for directory entries, directories) may come out of an archive.
fn safe_unix_mode(mode: Option<u32>, directory: bool) -> bool {
    mode.is_none_or(|mode| {
        let file_type = mode & 0o170_000;
        file_type == 0 || file_type == if directory { 0o040_000 } else { 0o100_000 }
    })
}

#[cfg(test)]
mod tests;
