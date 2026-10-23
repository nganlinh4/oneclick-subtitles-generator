//! Portable relative-path validation and link/reparse-refusing filesystem walks.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::BuildHasher;
use std::path::{Component, Path, PathBuf};

use crate::{DeliveryError, Result};

const MAX_PATH_BYTES: usize = 512;
const MAX_SEGMENT_BYTES: usize = 120;

/// The character and depth budget a store accepts for inventory paths.
///
/// Both policies reject traversal, absolute and drive paths, backslashes, empty or dot segments,
/// trailing dots/spaces, Windows device names, and non-ASCII bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PathPolicy {
    max_depth: usize,
    package_punctuation: bool,
}

impl PathPolicy {
    /// Native tools ship a handful of short, vendor-named files.
    pub const TOOL: Self = Self {
        max_depth: 16,
        package_punctuation: false,
    };
    /// Runtime packages carry third-party trees (for example setuptools' `script (dev).tmpl`)
    /// whose names need spaces, `@`, and parentheses, and deeper site-packages nesting.
    pub const PACKAGE: Self = Self {
        max_depth: 24,
        package_punctuation: true,
    };

    fn allows(self, byte: u8) -> bool {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'.' | b'-' | b'_' | b'+')
            || (self.package_punctuation && matches!(byte, b'@' | b' ' | b'(' | b')'))
    }
}

pub fn validate_relative_path(value: &str, policy: PathPolicy) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\\', ':', '\0'])
        || value.split('/').count() > policy.max_depth
    {
        return Err(DeliveryError::InvalidCatalog);
    }
    for segment in value.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || segment.len() > MAX_SEGMENT_BYTES
            || segment.ends_with(['.', ' '])
            || !segment.bytes().all(|byte| policy.allows(byte))
            || is_windows_device_name(segment)
        {
            return Err(DeliveryError::InvalidCatalog);
        }
    }
    Ok(())
}

#[must_use]
pub fn is_windows_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit())
}

#[cfg(windows)]
#[must_use]
pub fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
#[must_use]
pub fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub fn require_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DeliveryError::StoreUnavailable)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(DeliveryError::StoreUnavailable);
    }
    Ok(())
}

pub fn require_regular_file(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DeliveryError::InvalidInstall)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(DeliveryError::InvalidInstall);
    }
    Ok(metadata)
}

/// Creates the parent directories of `relative` below `root`, refusing any link on the way.
pub fn prepare_target(root: &Path, relative: &str, policy: PathPolicy) -> Result<PathBuf> {
    validate_relative_path(relative, policy).map_err(|_| DeliveryError::UnsafeArchive)?;
    require_directory(root).map_err(|_| DeliveryError::UnsafeArchive)?;
    let mut current = root.to_path_buf();
    let segments = relative.split('/').collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| DeliveryError::UnsafeArchive)?;
                require_directory(&current).map_err(|_| DeliveryError::UnsafeArchive)?;
            }
            Ok(_) | Err(_) => return Err(DeliveryError::UnsafeArchive),
        }
    }
    Ok(root.join(relative))
}

/// Resolves an owned file below `root` whose every parent is a real directory.
pub fn resolve_owned(root: &Path, relative: &str, policy: PathPolicy) -> Result<PathBuf> {
    validate_relative_path(relative, policy).map_err(|_| DeliveryError::InvalidInstall)?;
    require_directory(root).map_err(|_| DeliveryError::InvalidInstall)?;
    let mut current = root.to_path_buf();
    let segments = relative.split('/').collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|_| DeliveryError::InvalidInstall)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(DeliveryError::InvalidInstall);
        }
    }
    Ok(root.join(relative))
}

/// A bounded walk's limits: the path policy every found file must satisfy and the most
/// inventory files (plus one store-owned receipt) and directories it may contain.
#[derive(Clone, Copy, Debug)]
pub struct TreeLimits {
    pub policy: PathPolicy,
    pub max_files: usize,
}

pub fn collect_regular_files(root: &Path, limits: TreeLimits) -> Result<HashSet<String>> {
    Ok(
        collect_regular_file_metadata(root, limits, |_, _| Ok::<_, DeliveryError>(()))?
            .into_keys()
            .collect(),
    )
}

/// One recursive metadata-only walk that refuses links, reparse points, and special files.
/// `observe` may keep cheap metadata from the already-issued stat but must not open the file.
pub fn collect_regular_file_metadata<T, E>(
    root: &Path,
    limits: TreeLimits,
    mut observe: impl FnMut(&Path, &fs::Metadata) -> std::result::Result<T, E>,
) -> std::result::Result<HashMap<String, T>, E>
where
    E: From<DeliveryError>,
{
    require_directory(root).map_err(|_| DeliveryError::InvalidInstall)?;
    let mut files = HashMap::new();
    let mut pending = vec![root.to_path_buf()];
    let mut directories = 0_usize;
    while let Some(directory) = pending.pop() {
        directories = directories
            .checked_add(1)
            .filter(|count| *count <= limits.max_files)
            .ok_or(DeliveryError::InvalidInstall)?;
        for entry in fs::read_dir(&directory).map_err(|_| DeliveryError::InvalidInstall)? {
            let entry_path = entry.map_err(|_| DeliveryError::InvalidInstall)?.path();
            let metadata =
                fs::symlink_metadata(&entry_path).map_err(|_| DeliveryError::InvalidInstall)?;
            if is_link_or_reparse(&metadata) {
                return Err(DeliveryError::InvalidInstall.into());
            }
            if metadata.is_dir() {
                pending.push(entry_path);
            } else if metadata.is_file() {
                let relative = relative_name(root, &entry_path, limits.policy)?;
                let observed = observe(&entry_path, &metadata)?;
                if files.insert(relative, observed).is_some() || files.len() > limits.max_files + 1
                {
                    return Err(DeliveryError::InvalidInstall.into());
                }
            } else {
                return Err(DeliveryError::InvalidInstall.into());
            }
        }
    }
    Ok(files)
}

fn relative_name(root: &Path, path: &Path, policy: PathPolicy) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| DeliveryError::InvalidInstall)?
        .components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(DeliveryError::InvalidInstall)?
        .join("/");
    validate_relative_path(&relative, policy).map_err(|_| DeliveryError::InvalidInstall)?;
    Ok(relative)
}

/// Deletes a tree that may contain only `allowed` files, then the tree itself.
///
/// Any unexpected entry preserves the whole tree. When `ownership_marker` is given, a non-empty
/// tree must still contain it and it is deleted last, so an interrupted cleanup stays
/// recognizable and can be finished later.
pub fn remove_known_tree<S: BuildHasher>(
    root: &Path,
    allowed: &HashSet<String, S>,
    ownership_marker: Option<&str>,
    limits: TreeLimits,
) -> Result<()> {
    let actual = collect_regular_files(root, limits)?;
    if !actual.iter().all(|path| allowed.contains(path))
        || ownership_marker.is_some_and(|marker| !actual.is_empty() && !actual.contains(marker))
    {
        return Err(DeliveryError::InvalidInstall);
    }
    let mut files = actual.into_iter().collect::<Vec<_>>();
    files.sort_by_key(|path| {
        (
            ownership_marker == Some(path.as_str()),
            std::cmp::Reverse(path.matches('/').count()),
        )
    });
    for relative in files {
        let path = resolve_owned(root, &relative, limits.policy)?;
        require_regular_file(&path)?;
        fs::remove_file(path).map_err(|_| DeliveryError::StoreUnavailable)?;
    }
    remove_empty_directories(root)?;
    fs::remove_dir(root).map_err(|_| DeliveryError::StoreUnavailable)
}

/// Best-effort: removes `path` only when it is a plain, empty directory. A missing, non-empty,
/// or linked entry is left untouched.
pub fn remove_empty_directory(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(DeliveryError::StoreUnavailable),
    };
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Ok(());
    }
    let mut entries = fs::read_dir(path).map_err(|_| DeliveryError::StoreUnavailable)?;
    if entries.next().is_some() {
        return Ok(());
    }
    fs::remove_dir(path).map_err(|_| DeliveryError::StoreUnavailable)
}

/// Removes `path` when it is a regular file; a missing path is not an error.
pub fn remove_regular_if_exists(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_link_or_reparse(&metadata) => {
            fs::remove_file(path).map_err(|_| DeliveryError::StoreUnavailable)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) | Err(_) => Err(DeliveryError::StoreUnavailable),
    }
}

fn remove_empty_directories(root: &Path) -> Result<()> {
    let mut directories = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|_| DeliveryError::StoreUnavailable)? {
            let entry = entry.map_err(|_| DeliveryError::StoreUnavailable)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| DeliveryError::StoreUnavailable)?;
            if metadata.is_dir() && !is_link_or_reparse(&metadata) {
                pending.push(entry.path());
                directories.push(entry.path());
            } else if !metadata.is_file() || is_link_or_reparse(&metadata) {
                return Err(DeliveryError::StoreUnavailable);
            }
        }
    }
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        fs::remove_dir(directory).map_err(|_| DeliveryError::StoreUnavailable)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
