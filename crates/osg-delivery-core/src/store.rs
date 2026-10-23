//! Marker-owned store roots, their exclusive cross-process lock, and direct children.

use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use crate::paths::{is_link_or_reparse, is_windows_device_name, require_directory};
use crate::{DeliveryError, Result};

/// The marker file that proves a directory is an OSG-owned store, its lock file, and the
/// direct children created on initialization.
#[derive(Clone, Copy, Debug)]
pub struct StoreSpec {
    pub marker: &'static str,
    pub marker_bytes: &'static [u8],
    pub lock: &'static str,
    pub lock_bytes: &'static [u8],
    pub children: &'static [&'static str],
}

pub fn initialize_store(root: &Path, spec: &StoreSpec) -> Result<PathBuf> {
    fs::create_dir_all(root).map_err(|_| DeliveryError::StoreUnavailable)?;
    let canonical = fs::canonicalize(root).map_err(|_| DeliveryError::StoreUnavailable)?;
    require_directory(&canonical)?;
    let marker = canonical.join(spec.marker);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(mut file) => {
            file.write_all(spec.marker_bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| DeliveryError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            require_store(&canonical, spec)?;
        }
        Err(_) => return Err(DeliveryError::StoreUnavailable),
    }
    for name in spec.children {
        ensure_direct_child(&canonical, name)?;
    }
    Ok(canonical)
}

pub fn require_store(root: &Path, spec: &StoreSpec) -> Result<()> {
    require_directory(root)?;
    let marker = root.join(spec.marker);
    let metadata = fs::symlink_metadata(&marker).map_err(|_| DeliveryError::StoreUnavailable)?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || metadata.len() != spec.marker_bytes.len() as u64
        || fs::read(marker).ok().as_deref() != Some(spec.marker_bytes)
    {
        return Err(DeliveryError::StoreUnavailable);
    }
    Ok(())
}

/// Takes the store's exclusive lock; the returned handle holds it until dropped.
pub fn acquire_store_lock(root: &Path, spec: &StoreSpec) -> Result<fs::File> {
    require_store(root, spec)?;
    let lock_path = root.join(spec.lock);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(mut created) => {
            created
                .write_all(spec.lock_bytes)
                .and_then(|()| created.sync_all())
                .map_err(|_| DeliveryError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(DeliveryError::StoreUnavailable),
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|_| DeliveryError::StoreUnavailable)?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| DeliveryError::StoreUnavailable)?;

    let path_metadata =
        fs::symlink_metadata(&lock_path).map_err(|_| DeliveryError::StoreUnavailable)?;
    let handle_metadata = file
        .metadata()
        .map_err(|_| DeliveryError::StoreUnavailable)?;
    if !path_metadata.is_file()
        || is_link_or_reparse(&path_metadata)
        || !handle_metadata.is_file()
        || handle_metadata.len() != spec.lock_bytes.len() as u64
    {
        return Err(DeliveryError::StoreUnavailable);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| DeliveryError::StoreUnavailable)?;
    let mut contents = Vec::with_capacity(spec.lock_bytes.len());
    file.read_to_end(&mut contents)
        .map_err(|_| DeliveryError::StoreUnavailable)?;
    if contents != spec.lock_bytes {
        return Err(DeliveryError::StoreUnavailable);
    }
    Ok(file)
}

/// Returns `root/name`, creating it when missing; an existing non-directory or link is refused.
pub fn ensure_direct_child(root: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty()
        || name.contains(['/', '\\', ':', '\0'])
        || matches!(name, "." | "..")
        || is_windows_device_name(name)
    {
        return Err(DeliveryError::StoreUnavailable);
    }
    require_directory(root)?;
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|_| DeliveryError::StoreUnavailable)?;
            require_directory(&path)?;
        }
        Ok(_) | Err(_) => return Err(DeliveryError::StoreUnavailable),
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: StoreSpec = StoreSpec {
        marker: ".test-store-v1",
        marker_bytes: b"test store v1\n",
        lock: ".test-store.lock",
        lock_bytes: b"test lock v1\n",
        children: &[".downloads", ".staging"],
    };

    #[test]
    fn store_marker_prevents_unowned_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = initialize_store(&temp.path().join("store"), &SPEC).unwrap();
        assert!(root.join(".downloads").is_dir());
        assert!(require_store(&root, &SPEC).is_ok());
        fs::write(root.join(SPEC.marker), b"wrong").unwrap();
        assert!(require_store(&root, &SPEC).is_err());
        assert!(initialize_store(&root, &SPEC).is_err());
    }

    #[test]
    fn the_store_lock_is_exclusive_and_content_checked() {
        let temp = tempfile::tempdir().unwrap();
        let root = initialize_store(temp.path(), &SPEC).unwrap();
        let held = acquire_store_lock(&root, &SPEC).unwrap();
        assert!(acquire_store_lock(&root, &SPEC).is_err());
        drop(held);
        assert!(acquire_store_lock(&root, &SPEC).is_ok());

        let tampered = tempfile::tempdir().unwrap();
        let root = initialize_store(tampered.path(), &SPEC).unwrap();
        fs::write(root.join(SPEC.lock), b"foreign lock\n").unwrap();
        assert!(acquire_store_lock(&root, &SPEC).is_err());
    }

    #[test]
    fn the_store_lock_requires_an_owned_store() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            acquire_store_lock(temp.path(), &SPEC).map(|_| ()),
            Err(DeliveryError::StoreUnavailable)
        );
        assert!(!temp.path().join(SPEC.lock).exists());
    }

    #[test]
    fn direct_children_reject_separators_and_device_names() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["", ".", "..", "a/b", "a\\b", "C:", "NUL", "com1"] {
            assert!(ensure_direct_child(temp.path(), name).is_err(), "{name}");
        }
        fs::write(temp.path().join("file"), b"x").unwrap();
        assert!(ensure_direct_child(temp.path(), "file").is_err());
        assert!(ensure_direct_child(temp.path(), "tools").unwrap().is_dir());
    }
}
