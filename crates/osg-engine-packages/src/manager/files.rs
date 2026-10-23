//! Verified file copies, directory sync, and adopted-file permissions.

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::catalog::DeliveryFile;
use crate::path_security::{is_link_or_reparse, require_directory, require_regular_file};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::{CancellationToken, PackageError, Result};

pub(super) fn canonical_regular_directory(path: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|_| PackageError::InvalidRequest)?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|_| PackageError::InvalidRequest)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(PackageError::InvalidRequest);
    }
    Ok(canonical)
}

pub(super) fn resolve_declared_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    crate::path_security::validate_directory_path(relative)
        .map_err(|_| PackageError::InvalidInstall)?;
    let mut current = root.to_path_buf();
    for segment in relative.split('/') {
        current.push(segment);
        require_directory(&current).map_err(|_| PackageError::InvalidInstall)?;
    }
    Ok(current)
}

#[cfg(unix)]
pub(super) fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PackageError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
pub(super) fn sync_directory(_: &Path) -> Result<()> {
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) struct CopyProgress<'a> {
    pub(super) cancellation: &'a CancellationToken,
    pub(super) completed_before: u64,
    pub(super) total: u64,
    pub(super) progress: &'a dyn ProgressSink,
    pub(super) phase: OperationPhase,
}

pub(super) fn copy_verified_legacy_file(
    source: &Path,
    target: &Path,
    expected: &DeliveryFile,
    copy: CopyProgress<'_>,
) -> Result<()> {
    let metadata = require_regular_file(source)?;
    if metadata.len() != expected.size_bytes {
        return Err(PackageError::InvalidInstall);
    }
    let mut input = fs::File::open(source).map_err(|_| PackageError::InvalidInstall)?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|_| PackageError::StoreUnavailable)?;
    let mut hasher = Sha256::new();
    let mut written = 0_u64;
    let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
    loop {
        copy.cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| PackageError::InvalidInstall)?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .filter(|value| *value <= expected.size_bytes)
            .ok_or(PackageError::InvalidInstall)?;
        output
            .write_all(&buffer[..read])
            .map_err(|_| PackageError::StoreUnavailable)?;
        hasher.update(&buffer[..read]);
        copy.progress.on_progress(OperationProgress::new(
            copy.phase,
            copy.completed_before.saturating_add(written),
            copy.total,
        ));
    }
    if written != expected.size_bytes || format!("{:x}", hasher.finalize()) != expected.sha256 {
        return Err(PackageError::InvalidInstall);
    }
    output.flush().map_err(|_| PackageError::StoreUnavailable)?;
    output
        .sync_all()
        .map_err(|_| PackageError::StoreUnavailable)?;
    set_adopted_permissions(target, expected.executable)?;
    let copied = require_regular_file(target)?;
    if copied.len() != expected.size_bytes {
        return Err(PackageError::InvalidInstall);
    }
    Ok(())
}

pub(super) fn report_asset_download_progress(
    progress: &dyn ProgressSink,
    value: OperationProgress,
    completed_before: u64,
    asset_size: u64,
    total: u64,
) {
    let local_done = match value.phase {
        OperationPhase::Downloading => value.bytes_done.min(asset_size),
        OperationPhase::Verifying if value.basis_points == 10_000 => asset_size,
        _ => return,
    };
    progress.on_progress(OperationProgress::new(
        OperationPhase::Downloading,
        completed_before.saturating_add(local_done),
        total,
    ));
}

#[cfg(unix)]
pub(super) fn set_adopted_permissions(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| PackageError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
pub(super) fn set_adopted_permissions(_: &Path, _: bool) -> Result<()> {
    Ok(())
}
