use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::catalog::MAX_FILES;
use crate::{PackageError, Result};

const STORE_MARKER: &str = ".osg-engine-packages-v1";
const STORE_MARKER_BYTES: &[u8] = b"OSG engine package store v1\n";
const STORE_LOCK: &str = ".osg-engine-packages.lock";
const STORE_LOCK_BYTES: &[u8] = b"OSG engine package lock v1\n";
const MAX_PATH_BYTES: usize = 512;
const MAX_DEPTH: usize = 24;
const MAX_SEGMENT_BYTES: usize = 120;

pub(crate) fn validate_manifest_path(value: &str) -> Result<()> {
    validate_portable_path(value, false)
}

pub(crate) fn validate_directory_path(value: &str) -> Result<()> {
    validate_portable_path(value, true)
}

fn validate_portable_path(value: &str, directory: bool) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\\', ':', '\0'])
    {
        return Err(PackageError::InvalidCatalog);
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.is_empty() || segments.len() > MAX_DEPTH {
        return Err(PackageError::InvalidCatalog);
    }
    for segment in segments {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.len() > MAX_SEGMENT_BYTES
            || segment.ends_with(['.', ' '])
            || !segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'-' | b'_' | b'+' | b'@' | b' ' | b'(' | b')')
            })
            || is_windows_device_name(segment)
        {
            return Err(PackageError::InvalidCatalog);
        }
    }
    if directory && value.rsplit('/').next().is_none_or(str::is_empty) {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

fn is_windows_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub(crate) fn initialize_store(root: &Path) -> Result<PathBuf> {
    fs::create_dir_all(root).map_err(|_| PackageError::StoreUnavailable)?;
    let canonical = fs::canonicalize(root).map_err(|_| PackageError::StoreUnavailable)?;
    require_directory(&canonical)?;
    let marker = canonical.join(STORE_MARKER);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(mut file) => {
            use std::io::Write as _;
            file.write_all(STORE_MARKER_BYTES)
                .map_err(|_| PackageError::StoreUnavailable)?;
            file.sync_all()
                .map_err(|_| PackageError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata =
                fs::symlink_metadata(&marker).map_err(|_| PackageError::StoreUnavailable)?;
            if !metadata.is_file()
                || is_link_or_reparse(&metadata)
                || fs::read(&marker).ok().as_deref() != Some(STORE_MARKER_BYTES)
            {
                return Err(PackageError::StoreUnavailable);
            }
        }
        Err(_) => return Err(PackageError::StoreUnavailable),
    }
    for name in [".downloads", ".staging", ".trash"] {
        ensure_direct_child(&canonical, name)?;
    }
    Ok(canonical)
}

pub(crate) fn require_store(root: &Path) -> Result<()> {
    require_directory(root)?;
    let marker = root.join(STORE_MARKER);
    let metadata = fs::symlink_metadata(&marker).map_err(|_| PackageError::StoreUnavailable)?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || fs::read(marker).ok().as_deref() != Some(STORE_MARKER_BYTES)
    {
        return Err(PackageError::StoreUnavailable);
    }
    Ok(())
}

pub(crate) fn acquire_store_lock(root: &Path) -> Result<fs::File> {
    use std::io::{Read as _, Seek as _, SeekFrom};

    require_store(root)?;
    let marker = root.join(STORE_LOCK);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(mut created) => {
            use std::io::Write as _;
            created
                .write_all(STORE_LOCK_BYTES)
                .map_err(|_| PackageError::StoreUnavailable)?;
            created
                .sync_all()
                .map_err(|_| PackageError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(PackageError::StoreUnavailable),
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&marker)
        .map_err(|_| PackageError::StoreUnavailable)?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| PackageError::StoreUnavailable)?;

    let path_metadata =
        fs::symlink_metadata(&marker).map_err(|_| PackageError::StoreUnavailable)?;
    let handle_metadata = file
        .metadata()
        .map_err(|_| PackageError::StoreUnavailable)?;
    if !path_metadata.is_file()
        || is_link_or_reparse(&path_metadata)
        || !handle_metadata.is_file()
        || handle_metadata.len() != STORE_LOCK_BYTES.len() as u64
    {
        return Err(PackageError::StoreUnavailable);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| PackageError::StoreUnavailable)?;
    let mut contents = Vec::with_capacity(STORE_LOCK_BYTES.len());
    file.read_to_end(&mut contents)
        .map_err(|_| PackageError::StoreUnavailable)?;
    if contents != STORE_LOCK_BYTES {
        return Err(PackageError::StoreUnavailable);
    }
    Ok(file)
}

pub(crate) fn ensure_direct_child(root: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty()
        || name.contains(['/', '\\', '\0'])
        || matches!(name, "." | "..")
        || is_windows_device_name(name)
    {
        return Err(PackageError::StoreUnavailable);
    }
    require_store_if_root(root)?;
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|_| PackageError::StoreUnavailable)?;
            require_directory(&path)?;
        }
        Ok(_) | Err(_) => return Err(PackageError::StoreUnavailable),
    }
    Ok(path)
}

fn require_store_if_root(root: &Path) -> Result<()> {
    require_directory(root)
}

pub(crate) fn require_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PackageError::StoreUnavailable)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(PackageError::StoreUnavailable);
    }
    Ok(())
}

pub(crate) fn require_regular_file(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PackageError::InvalidInstall)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(PackageError::InvalidInstall);
    }
    Ok(metadata)
}

pub(crate) fn prepare_target(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_manifest_path(relative).map_err(|_| PackageError::UnsafeArchive)?;
    require_directory(root).map_err(|_| PackageError::UnsafeArchive)?;
    let mut current = root.to_path_buf();
    let segments = relative.split('/').collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| PackageError::UnsafeArchive)?;
                require_directory(&current).map_err(|_| PackageError::UnsafeArchive)?;
            }
            Ok(_) | Err(_) => return Err(PackageError::UnsafeArchive),
        }
    }
    Ok(root.join(Path::new(relative)))
}

pub(crate) fn resolve_owned(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_manifest_path(relative).map_err(|_| PackageError::InvalidInstall)?;
    require_directory(root).map_err(|_| PackageError::InvalidInstall)?;
    let mut current = root.to_path_buf();
    let segments = relative.split('/').collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|_| PackageError::InvalidInstall)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(PackageError::InvalidInstall);
        }
    }
    Ok(root.join(Path::new(relative)))
}

pub(crate) fn collect_regular_files(root: &Path) -> Result<HashSet<String>> {
    require_directory(root).map_err(|_| PackageError::InvalidInstall)?;
    let mut files = HashSet::new();
    let mut pending = vec![root.to_path_buf()];
    let mut directories = 0_usize;
    while let Some(directory) = pending.pop() {
        directories = directories
            .checked_add(1)
            .filter(|count| *count <= MAX_FILES)
            .ok_or(PackageError::InvalidInstall)?;
        for entry in fs::read_dir(&directory).map_err(|_| PackageError::InvalidInstall)? {
            let entry = entry.map_err(|_| PackageError::InvalidInstall)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| PackageError::InvalidInstall)?;
            if is_link_or_reparse(&metadata) {
                return Err(PackageError::InvalidInstall);
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| PackageError::InvalidInstall)?
                    .components()
                    .map(|component| match component {
                        Component::Normal(value) => value.to_str().map(str::to_owned),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or(PackageError::InvalidInstall)?
                    .join("/");
                validate_manifest_path(&relative).map_err(|_| PackageError::InvalidInstall)?;
                if !files.insert(relative) || files.len() > MAX_FILES + 1 {
                    return Err(PackageError::InvalidInstall);
                }
            } else {
                return Err(PackageError::InvalidInstall);
            }
        }
    }
    Ok(files)
}

pub(crate) fn cleanup_known_tree(root: &Path, allowed_files: &HashSet<String>) -> Result<()> {
    let actual = collect_regular_files(root)?;
    if actual.iter().any(|path| !allowed_files.contains(path)) {
        return Err(PackageError::InvalidInstall);
    }
    let mut files = actual.into_iter().collect::<Vec<_>>();
    files.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    for relative in files {
        let path = resolve_owned(root, &relative)?;
        require_regular_file(&path)?;
        fs::remove_file(path).map_err(|_| PackageError::StoreUnavailable)?;
    }
    remove_empty_directories(root)?;
    fs::remove_dir(root).map_err(|_| PackageError::StoreUnavailable)
}

fn remove_empty_directories(root: &Path) -> Result<()> {
    let mut directories = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|_| PackageError::StoreUnavailable)? {
            let entry = entry.map_err(|_| PackageError::StoreUnavailable)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| PackageError::StoreUnavailable)?;
            if metadata.is_dir() && !is_link_or_reparse(&metadata) {
                pending.push(entry.path());
                directories.push(entry.path());
            } else if !metadata.is_file() || is_link_or_reparse(&metadata) {
                return Err(PackageError::StoreUnavailable);
            }
        }
    }
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        fs::remove_dir(directory).map_err(|_| PackageError::StoreUnavailable)?;
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(crate) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_paths_reject_traversal_devices_and_platform_syntax() {
        for invalid in [
            "",
            "../model",
            "model/../x",
            "/root",
            "C:/model",
            "model\\x",
            "model//x",
            "model/CON",
            "model/com1.bin",
            "model/trailing.",
        ] {
            assert!(validate_manifest_path(invalid).is_err(), "{invalid}");
        }
        assert!(validate_manifest_path("model/weights/model-00001.safetensors").is_ok());
    }

    #[test]
    fn store_marker_prevents_unowned_cleanup_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = initialize_store(&temp.path().join("packages")).unwrap();
        assert!(require_store(&root).is_ok());
        fs::write(root.join(STORE_MARKER), b"wrong").unwrap();
        assert!(require_store(&root).is_err());
    }
}
