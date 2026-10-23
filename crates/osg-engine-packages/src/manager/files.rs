//! Verified legacy copies, declared-directory resolution, and directory sync.

use std::fs;
use std::path::{Path, PathBuf};

use osg_delivery_core::DeliveryError;
use osg_delivery_core::files::{ExpectedContent, copy_verified, set_permissions};

pub(super) use osg_delivery_core::files::CopyProgress;

use crate::catalog::DeliveryFile;
use crate::path_security::{is_link_or_reparse, require_directory, require_regular_file};
use crate::{PackageError, Result};

pub(super) fn canonical_regular_directory(path: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|_| PackageError::InvalidRequest)?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|_| PackageError::InvalidRequest)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(PackageError::InvalidRequest);
    }
    Ok(canonical)
}

pub(super) fn resolve_declared_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    crate::path_security::validate_relative_path(relative)
        .map_err(|_| PackageError::InvalidInstall)?;
    let mut current = root.to_path_buf();
    for segment in relative.split('/') {
        current.push(segment);
        require_directory(&current).map_err(|_| PackageError::InvalidInstall)?;
    }
    Ok(current)
}

pub(super) fn sync_directory(path: &Path) -> Result<()> {
    Ok(osg_delivery_core::files::sync_directory(path)?)
}

/// Copies a regular file into staging, verifying its exact size and digest. Any source
/// defect is reported as an invalid install, never as a store failure.
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
    copy_verified(
        &mut input,
        &mut output,
        ExpectedContent {
            size_bytes: expected.size_bytes,
            sha256: &expected.sha256,
        },
        copy,
    )
    .map_err(|error| match error {
        DeliveryError::Cancelled => PackageError::Cancelled,
        DeliveryError::StoreUnavailable => PackageError::StoreUnavailable,
        _ => PackageError::InvalidInstall,
    })?;
    drop(output);
    set_permissions(target, expected.executable)?;
    if require_regular_file(target)?.len() != expected.size_bytes {
        return Err(PackageError::InvalidInstall);
    }
    Ok(())
}
