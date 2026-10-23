//! No-clobber destination planning and link/reparse-safe path-chain validation.

use std::ffi::OsString;
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};

use same_file::Handle;

use super::{DestinationPlan, ExportCopyError};

impl DestinationPlan {
    pub(super) fn new(path: &Path, source_identity: &Handle) -> Result<Self, ExportCopyError> {
        if !path.is_absolute() {
            return Err(ExportCopyError::UnsafeDestination);
        }
        let parent = path
            .parent()
            .filter(|value| !value.as_os_str().is_empty())
            .ok_or(ExportCopyError::UnsafeDestination)?;
        let file_name: OsString = path
            .file_name()
            .filter(|value| !value.is_empty())
            .ok_or(ExportCopyError::UnsafeDestination)?
            .to_owned();
        let directory = fs::canonicalize(parent).map_err(|_| ExportCopyError::UnsafeDestination)?;
        validate_path_chain(&directory)?;
        let directory_identity =
            Handle::from_path(&directory).map_err(|_| ExportCopyError::UnsafeDestination)?;
        let destination = directory.join(file_name);
        let existing_identity = existing_destination_identity(&destination, source_identity)?;
        Ok(Self {
            directory,
            directory_identity,
            destination,
            existing_identity,
        })
    }

    fn verify(&self, source_identity: &Handle) -> Result<(), ExportCopyError> {
        validate_path_chain(&self.directory)?;
        if Handle::from_path(&self.directory).map_err(|_| ExportCopyError::UnsafeDestination)?
            != self.directory_identity
        {
            return Err(ExportCopyError::UnsafeDestination);
        }
        let actual = existing_destination_identity(&self.destination, source_identity)?;
        if actual != self.existing_identity {
            return Err(ExportCopyError::UnsafeDestination);
        }
        Ok(())
    }

    pub(super) fn into_verified_destination(
        self,
        source_identity: &Handle,
    ) -> Result<PathBuf, ExportCopyError> {
        self.verify(source_identity)?;
        let Self {
            directory,
            directory_identity,
            destination,
            existing_identity,
        } = self;
        drop(directory);
        drop(directory_identity);
        drop(existing_identity);
        Ok(destination)
    }
}

pub(super) fn path_with_canonical_parent(
    path: &Path,
    error: ExportCopyError,
) -> Result<PathBuf, ExportCopyError> {
    if !path.is_absolute() {
        return Err(error);
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or(error)?;
    let file_name = path
        .file_name()
        .filter(|value| !value.is_empty())
        .ok_or(error)?;
    let parent = fs::canonicalize(parent).map_err(|_| error)?;
    validate_path_chain(&parent).map_err(|_| error)?;
    Ok(parent.join(file_name))
}

fn existing_destination_identity(
    path: &Path,
    source_identity: &Handle,
) -> Result<Option<Handle>, ExportCopyError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_unsafe_metadata(&metadata, false)?;
            let identity =
                Handle::from_path(path).map_err(|_| ExportCopyError::UnsafeDestination)?;
            if identity == *source_identity {
                return Err(ExportCopyError::UnsafeDestination);
            }
            Ok(Some(identity))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ExportCopyError::UnsafeDestination),
    }
}

pub(super) fn validate_path_chain(path: &Path) -> Result<(), ExportCopyError> {
    if !path.is_absolute() {
        return Err(ExportCopyError::UnsafeDestination);
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        let validate_component = !matches!(component, Component::Prefix(_));
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                current.push(component.as_os_str());
            }
            Component::CurDir | Component::ParentDir => {
                return Err(ExportCopyError::UnsafeDestination);
            }
        }
        if validate_component && current.has_root() {
            let metadata =
                fs::symlink_metadata(&current).map_err(|_| ExportCopyError::UnsafeDestination)?;
            if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                return Err(ExportCopyError::UnsafeDestination);
            }
        }
    }
    Ok(())
}

pub(super) fn reject_unsafe_metadata(
    metadata: &Metadata,
    directory: bool,
) -> Result<(), ExportCopyError> {
    if metadata.file_type().is_symlink()
        || is_link_or_reparse(metadata)
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        Err(ExportCopyError::UnsafeDestination)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}
