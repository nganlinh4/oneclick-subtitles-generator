//! Source-file access that rejects links, reparse points and sources changed during the scan.

use std::fs::{self, File};
use std::path::{Component, Path};

use osg_infrastructure::storage::{
    LegacyImportCandidate, LegacyImportItemKey, LegacyImportItemKind,
};
use same_file::Handle;

use super::types::{PlanningError, SourceRoot, ValidatedSourceFile};

impl SourceRoot {
    pub(super) fn open(selected: &Path) -> Result<Self, PlanningError> {
        reject_unsafe_entry(selected, true)?;
        let canonical = fs::canonicalize(selected)?;
        reject_unsafe_entry(&canonical, true)?;
        let identity = Handle::from_path(&canonical)?;
        let root = Self {
            canonical,
            identity,
        };
        root.verify()?;
        Ok(root)
    }

    pub(super) fn verify(&self) -> Result<(), PlanningError> {
        let metadata = fs::symlink_metadata(&self.canonical)?;
        reject_unsafe_metadata(&metadata, true)?;
        if Handle::from_path(&self.canonical)? != self.identity
            || fs::canonicalize(&self.canonical)? != self.canonical
        {
            return Err(PlanningError::Invalid);
        }
        Ok(())
    }
}

pub(super) fn open_source_file(
    source_root: &SourceRoot,
    path: &Path,
) -> Result<ValidatedSourceFile, PlanningError> {
    source_root.verify()?;
    reject_unsafe_entry(path, false)?;
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(&source_root.canonical) {
        return Err(PlanningError::Invalid);
    }
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    reject_unsafe_metadata(&metadata, false)?;
    let identity = Handle::from_file(file.try_clone()?)?;
    verify_source_path(source_root, path, &identity, false)?;
    Ok(ValidatedSourceFile {
        file,
        identity,
        metadata,
    })
}

pub(super) fn verify_source_path(
    source_root: &SourceRoot,
    path: &Path,
    expected_identity: &Handle,
    directory: bool,
) -> Result<(), PlanningError> {
    source_root.verify()?;
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, directory)?;
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(&source_root.canonical)
        || Handle::from_path(path)? != *expected_identity
    {
        return Err(PlanningError::Invalid);
    }
    source_root.verify()
}

pub(super) fn reject_unsafe_metadata(
    metadata: &fs::Metadata,
    directory: bool,
) -> Result<(), PlanningError> {
    if metadata.file_type().is_symlink()
        || is_reparse_point(metadata)
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        Err(PlanningError::Invalid)
    } else {
        Ok(())
    }
}

pub(super) fn candidate(
    kind: LegacyImportItemKind,
    index: usize,
) -> Result<LegacyImportCandidate, PlanningError> {
    let prefix = match kind {
        LegacyImportItemKind::Setting => "setting",
        LegacyImportItemKind::Credential => "credential",
        LegacyImportItemKind::Artifact => "artifact",
        LegacyImportItemKind::Ignored => "ignored",
    };
    LegacyImportItemKey::new(format!("{prefix}/{index:05}"))
        .map(|key| LegacyImportCandidate::new(key, kind))
        .map_err(|_| PlanningError::Invalid)
}

pub(super) fn append_manifest_field(
    manifest: &mut Vec<u8>,
    value: &[u8],
) -> Result<(), PlanningError> {
    let length = u64::try_from(value.len()).map_err(|_| PlanningError::TooLarge)?;
    manifest.extend_from_slice(&length.to_be_bytes());
    manifest.extend_from_slice(value);
    Ok(())
}

pub(super) fn safe_relative_path(root: &Path, path: &Path) -> Result<String, PlanningError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| PlanningError::Invalid)?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(PlanningError::Invalid);
        };
        let value = value.to_str().ok_or(PlanningError::Invalid)?;
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(PlanningError::Invalid);
        }
        components.push(value);
    }
    let result = components.join("/");
    if result.is_empty() || result.len() > 1_800 {
        Err(PlanningError::Invalid)
    } else {
        Ok(result)
    }
}

fn reject_unsafe_entry(path: &Path, directory: bool) -> Result<(), PlanningError> {
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, directory)
}

#[cfg(windows)]
pub(super) fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(super) const fn is_reparse_point(_: &fs::Metadata) -> bool {
    false
}
