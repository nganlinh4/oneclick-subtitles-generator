use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::catalog::MAX_FILES;
use crate::{NativeToolError, Result};

const STORE_MARKER: &str = ".osg-native-tools-v1";
const STORE_MARKER_BYTES: &[u8] = b"OSG native tool store v1\n";
const STORE_LOCK: &str = ".osg-native-tools.lock";
const STORE_LOCK_BYTES: &[u8] = b"OSG native tool lock v1\n";
const MAX_PATH_BYTES: usize = 512;
const MAX_DEPTH: usize = 16;
const MAX_SEGMENT_BYTES: usize = 120;

pub(crate) fn validate_relative_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\\', ':', '\0'])
    {
        return Err(NativeToolError::InvalidCatalog);
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.is_empty() || segments.len() > MAX_DEPTH {
        return Err(NativeToolError::InvalidCatalog);
    }
    for segment in segments {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || segment.len() > MAX_SEGMENT_BYTES
            || segment.ends_with(['.', ' '])
            || !segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+')
            })
            || is_windows_device_name(segment)
        {
            return Err(NativeToolError::InvalidCatalog);
        }
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
    fs::create_dir_all(root).map_err(|_| NativeToolError::StoreUnavailable)?;
    let canonical = fs::canonicalize(root).map_err(|_| NativeToolError::StoreUnavailable)?;
    require_directory(&canonical)?;
    let marker = canonical.join(STORE_MARKER);
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker)
    {
        Ok(mut file) => {
            use std::io::Write as _;
            file.write_all(STORE_MARKER_BYTES)
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            file.sync_all()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata =
                fs::symlink_metadata(&marker).map_err(|_| NativeToolError::StoreUnavailable)?;
            if !metadata.is_file()
                || is_link_or_reparse(&metadata)
                || fs::read(&marker).ok().as_deref() != Some(STORE_MARKER_BYTES)
            {
                return Err(NativeToolError::StoreUnavailable);
            }
        }
        Err(_) => return Err(NativeToolError::StoreUnavailable),
    }
    for directory in [".downloads", ".staging", ".trash", ".quarantine", "tools"] {
        ensure_direct_child(&canonical, directory)?;
    }
    Ok(canonical)
}

pub(crate) fn acquire_store_lock(root: &Path) -> Result<fs::File> {
    use std::io::{Read as _, Seek as _, SeekFrom};

    let lock_path = root.join(STORE_LOCK);
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&lock_path)
    {
        Ok(mut file) => {
            use std::io::Write as _;
            file.write_all(STORE_LOCK_BYTES)
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            file.sync_all()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(NativeToolError::StoreUnavailable),
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| NativeToolError::StoreUnavailable)?;
    let metadata =
        fs::symlink_metadata(&lock_path).map_err(|_| NativeToolError::StoreUnavailable)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(NativeToolError::StoreUnavailable);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    if contents != STORE_LOCK_BYTES {
        return Err(NativeToolError::StoreUnavailable);
    }
    Ok(file)
}

pub(crate) fn ensure_direct_child(root: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty()
        || name.contains(['/', '\\', '\0'])
        || matches!(name, "." | "..")
        || is_windows_device_name(name)
    {
        return Err(NativeToolError::StoreUnavailable);
    }
    require_directory(root)?;
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|_| NativeToolError::StoreUnavailable)?;
            require_directory(&path)?;
        }
        Ok(_) | Err(_) => return Err(NativeToolError::StoreUnavailable),
    }
    Ok(path)
}

pub(crate) fn require_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NativeToolError::StoreUnavailable)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(NativeToolError::StoreUnavailable);
    }
    Ok(())
}

pub(crate) fn require_regular_file(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NativeToolError::InvalidInstall)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(NativeToolError::InvalidInstall);
    }
    Ok(metadata)
}

pub(crate) fn prepare_target(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative_path(relative).map_err(|_| NativeToolError::UnsafeArchive)?;
    require_directory(root).map_err(|_| NativeToolError::UnsafeArchive)?;
    let mut current = root.to_path_buf();
    let segments = relative.split('/').collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| NativeToolError::UnsafeArchive)?;
                require_directory(&current).map_err(|_| NativeToolError::UnsafeArchive)?;
            }
            Ok(_) | Err(_) => return Err(NativeToolError::UnsafeArchive),
        }
    }
    Ok(root.join(relative))
}

pub(crate) fn resolve_owned(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative_path(relative).map_err(|_| NativeToolError::InvalidInstall)?;
    require_directory(root).map_err(|_| NativeToolError::InvalidInstall)?;
    let mut current = root.to_path_buf();
    let segments = relative.split('/').collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| NativeToolError::InvalidInstall)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(NativeToolError::InvalidInstall);
        }
    }
    Ok(root.join(relative))
}

pub(crate) fn collect_regular_files(root: &Path) -> Result<HashSet<String>> {
    require_directory(root).map_err(|_| NativeToolError::InvalidInstall)?;
    let mut files = HashSet::new();
    let mut pending = vec![root.to_path_buf()];
    let mut directories = 0_usize;
    while let Some(directory) = pending.pop() {
        directories = directories
            .checked_add(1)
            .filter(|count| *count <= MAX_FILES * 4)
            .ok_or(NativeToolError::InvalidInstall)?;
        for entry in fs::read_dir(&directory).map_err(|_| NativeToolError::InvalidInstall)? {
            let entry = entry.map_err(|_| NativeToolError::InvalidInstall)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| NativeToolError::InvalidInstall)?;
            if is_link_or_reparse(&metadata) {
                return Err(NativeToolError::InvalidInstall);
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| NativeToolError::InvalidInstall)?
                    .components()
                    .map(|component| match component {
                        Component::Normal(value) => value.to_str().map(str::to_owned),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or(NativeToolError::InvalidInstall)?
                    .join("/");
                validate_relative_path(&relative).map_err(|_| NativeToolError::InvalidInstall)?;
                if !files.insert(relative) || files.len() > MAX_FILES + 1 {
                    return Err(NativeToolError::InvalidInstall);
                }
            } else {
                return Err(NativeToolError::InvalidInstall);
            }
        }
    }
    Ok(files)
}

pub(crate) fn remove_exact_tree(root: &Path, allowed_files: &HashSet<String>) -> Result<()> {
    let actual = collect_regular_files(root)?;
    if &actual != allowed_files {
        return Err(NativeToolError::InvalidInstall);
    }
    let mut files = actual.into_iter().collect::<Vec<_>>();
    files.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    for relative in files {
        let path = resolve_owned(root, &relative)?;
        require_regular_file(&path)?;
        fs::remove_file(path).map_err(|_| NativeToolError::StoreUnavailable)?;
    }
    remove_empty_directories(root)?;
    fs::remove_dir(root).map_err(|_| NativeToolError::StoreUnavailable)
}

pub(crate) fn cleanup_empty_work_tree(root: &Path) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    require_directory(root)?;
    let files = collect_regular_files(root)?;
    for relative in files {
        let path = resolve_owned(root, &relative)?;
        require_regular_file(&path)?;
        fs::remove_file(path).map_err(|_| NativeToolError::StoreUnavailable)?;
    }
    remove_empty_directories(root)?;
    fs::remove_dir(root).map_err(|_| NativeToolError::StoreUnavailable)
}

fn remove_empty_directories(root: &Path) -> Result<()> {
    let mut directories = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|_| NativeToolError::StoreUnavailable)? {
            let entry = entry.map_err(|_| NativeToolError::StoreUnavailable)?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            if metadata.is_dir() && !is_link_or_reparse(&metadata) {
                pending.push(entry.path());
                directories.push(entry.path());
            } else if !metadata.is_file() || is_link_or_reparse(&metadata) {
                return Err(NativeToolError::StoreUnavailable);
            }
        }
    }
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        fs::remove_dir(directory).map_err(|_| NativeToolError::StoreUnavailable)?;
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
            "../bin",
            "bin/../tool",
            "/bin/tool",
            "C:/tool",
            "bin\\tool",
            "bin//tool",
            "bin/CON",
            "bin/com1.exe",
            "bin/trailing.",
        ] {
            assert!(validate_relative_path(invalid).is_err(), "{invalid}");
        }
        assert!(validate_relative_path("licenses/tool-LICENSE.txt").is_ok());
    }
}
