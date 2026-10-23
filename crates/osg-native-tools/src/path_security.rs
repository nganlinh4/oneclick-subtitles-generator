//! This store's bindings of the shared delivery path and store primitives.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use osg_delivery_core::paths::{self, PathPolicy, TreeLimits};
use osg_delivery_core::store::{self, StoreSpec};

pub(crate) use osg_delivery_core::paths::{
    remove_empty_directory, require_directory, require_regular_file,
};

use crate::Result;
use crate::catalog::MAX_FILES;

const POLICY: PathPolicy = PathPolicy::TOOL;
const LIMITS: TreeLimits = TreeLimits {
    policy: POLICY,
    max_files: MAX_FILES,
};
const STORE: StoreSpec = StoreSpec {
    marker: ".osg-native-tools-v1",
    marker_bytes: b"OSG native tool store v1\n",
    lock: ".osg-native-tools.lock",
    lock_bytes: b"OSG native tool lock v1\n",
    children: &[".downloads", ".staging", ".trash", ".quarantine", "tools"],
};

pub(crate) fn validate_relative_path(value: &str) -> Result<()> {
    Ok(paths::validate_relative_path(value, POLICY)?)
}

pub(crate) fn initialize_store(root: &Path) -> Result<PathBuf> {
    Ok(store::initialize_store(root, &STORE)?)
}

pub(crate) fn ensure_direct_child(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(store::ensure_direct_child(root, name)?)
}

pub(crate) fn acquire_store_lock(root: &Path) -> Result<fs::File> {
    Ok(store::acquire_store_lock(root, &STORE)?)
}

pub(crate) fn prepare_target(root: &Path, relative: &str) -> Result<PathBuf> {
    Ok(paths::prepare_target(root, relative, POLICY)?)
}

pub(crate) fn resolve_owned(root: &Path, relative: &str) -> Result<PathBuf> {
    Ok(paths::resolve_owned(root, relative, POLICY)?)
}

pub(crate) fn collect_regular_files(root: &Path) -> Result<HashSet<String>> {
    Ok(paths::collect_regular_files(root, LIMITS)?)
}

/// Deletes a work tree that may hold only `allowed` files.
pub(crate) fn remove_known_tree(root: &Path, allowed: &HashSet<String>) -> Result<()> {
    Ok(paths::remove_known_tree(root, allowed, None, LIMITS)?)
}

/// Finishes a previously validated managed-tree cleanup without ever deleting an unexpected
/// file. A prior interrupted cleanup may have removed a subset of the owned files, but any
/// unowned entry still preserves the entire remainder for inspection.
pub(crate) fn remove_owned_tree_subset(
    root: &Path,
    allowed_files: &HashSet<String>,
    ownership_marker: &str,
) -> Result<()> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Ok(paths::remove_known_tree(
            root,
            allowed_files,
            Some(ownership_marker),
            LIMITS,
        )?),
        Err(_) => Err(crate::NativeToolError::StoreUnavailable),
    }
}
