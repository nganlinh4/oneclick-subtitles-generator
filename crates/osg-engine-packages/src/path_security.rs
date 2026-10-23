//! This store's bindings of the shared delivery path and store primitives, plus the one
//! package-specific cleanup (legacy Python caches).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use osg_delivery_core::paths::{self, PathPolicy, TreeLimits};
use osg_delivery_core::store::{self, StoreSpec};

pub(crate) use osg_delivery_core::paths::{
    is_link_or_reparse, require_directory, require_regular_file,
};

use crate::catalog::MAX_FILES;
use crate::{PackageError, Result};

const POLICY: PathPolicy = PathPolicy::PACKAGE;
const LIMITS: TreeLimits = TreeLimits {
    policy: POLICY,
    max_files: MAX_FILES,
};
const STORE: StoreSpec = StoreSpec {
    marker: ".osg-engine-packages-v1",
    marker_bytes: b"OSG engine package store v1\n",
    lock: ".osg-engine-packages.lock",
    lock_bytes: b"OSG engine package lock v1\n",
    children: &[
        ".downloads",
        ".staging",
        ".trash",
        ".quarantine",
        ".verified",
    ],
};

pub(crate) fn validate_relative_path(value: &str) -> Result<()> {
    Ok(paths::validate_relative_path(value, POLICY)?)
}

pub(crate) fn initialize_store(root: &Path) -> Result<PathBuf> {
    Ok(store::initialize_store(root, &STORE)?)
}

pub(crate) fn require_store(root: &Path) -> Result<()> {
    Ok(store::require_store(root, &STORE)?)
}

pub(crate) fn acquire_store_lock(root: &Path) -> Result<fs::File> {
    Ok(store::acquire_store_lock(root, &STORE)?)
}

pub(crate) fn ensure_direct_child(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(store::ensure_direct_child(root, name)?)
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

/// One metadata-only walk that lets a caller keep cheap metadata (for example sizes) from the
/// already-issued stat, without opening or hashing any file content.
pub(crate) fn collect_regular_file_metadata<T>(
    root: &Path,
    observe: impl FnMut(&Path, &fs::Metadata) -> Result<T>,
) -> Result<HashMap<String, T>> {
    paths::collect_regular_file_metadata(root, LIMITS, observe)
}

/// Deletes a staged or trashed package tree that may hold only `allowed_files`.
pub(crate) fn cleanup_known_tree(root: &Path, allowed_files: &HashSet<String>) -> Result<()> {
    Ok(paths::remove_known_tree(root, allowed_files, None, LIMITS)?)
}

/// Removes only generated Python/Numba caches from an otherwise receipt-bounded managed runtime.
///
/// OSG versions before the immutable-runtime launch fix did not pass `-B` to managed ASR Python.
/// Those workers could add `runtime/**/__pycache__/*.{pyc,nbc,nbi}`, making an authentic package
/// fail exact tree validation and become impossible to remove. This migration first inventories
/// the complete tree, refuses to touch it if any other undeclared file is present, and resolves
/// every deletion through the same link/reparse-safe path boundary used by package cleanup.
pub(crate) fn scrub_generated_python_cache(
    root: &Path,
    allowed_files: &HashSet<String>,
    python_relative_path: &str,
) -> Result<bool> {
    validate_relative_path(python_relative_path).map_err(|_| PackageError::InvalidInstall)?;
    let Some((runtime_root, _)) = python_relative_path.rsplit_once('/') else {
        return Ok(false);
    };
    let runtime_prefix = format!("{runtime_root}/");
    let actual = collect_regular_files(root)?;
    let mut generated = actual
        .iter()
        .filter(|path| !allowed_files.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    if generated.is_empty()
        || generated
            .iter()
            .any(|path| !is_generated_python_cache(path, &runtime_prefix))
    {
        return Ok(false);
    }
    generated.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    for relative in generated {
        let path = resolve_owned(root, &relative)?;
        require_regular_file(&path)?;
        fs::remove_file(path).map_err(|_| PackageError::StoreUnavailable)?;
    }
    Ok(true)
}

fn is_generated_python_cache(path: &str, runtime_prefix: &str) -> bool {
    let Some(relative) = path.strip_prefix(runtime_prefix) else {
        return false;
    };
    let segments = relative.split('/').collect::<Vec<_>>();
    segments.len() >= 2
        && segments[segments.len() - 2] == "__pycache__"
        && segments.last().is_some_and(|name| {
            name.len() > 4
                && Path::new(name).extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("pyc")
                        || extension.eq_ignore_ascii_case("nbc")
                        || extension.eq_ignore_ascii_case("nbi")
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_python_cache_scrub_is_exact_and_refuses_mixed_extras() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("runtime/lib/pkg/__pycache__")).unwrap();
        fs::write(root.path().join("runtime/python.exe"), b"python").unwrap();
        fs::write(root.path().join("runtime/lib/pkg/module.py"), b"source").unwrap();
        let generated = root
            .path()
            .join("runtime/lib/pkg/__pycache__/module.cpython-311.pyc");
        let numba_data = root
            .path()
            .join("runtime/lib/pkg/__pycache__/module.function-1.py311.1.nbc");
        let numba_index = root
            .path()
            .join("runtime/lib/pkg/__pycache__/module.function-1.py311.nbi");
        fs::write(&generated, b"bytecode").unwrap();
        fs::write(&numba_data, b"compiled").unwrap();
        fs::write(&numba_index, b"index").unwrap();
        let allowed = HashSet::from([
            "runtime/python.exe".to_owned(),
            "runtime/lib/pkg/module.py".to_owned(),
        ]);
        assert!(scrub_generated_python_cache(root.path(), &allowed, "runtime/python.exe").unwrap());
        assert!(!generated.exists());
        assert!(!numba_data.exists());
        assert!(!numba_index.exists());

        fs::write(&generated, b"bytecode").unwrap();
        let unknown = root.path().join("runtime/lib/pkg/user-data.bin");
        fs::write(&unknown, b"preserve").unwrap();
        assert!(
            !scrub_generated_python_cache(root.path(), &allowed, "runtime/python.exe").unwrap()
        );
        assert!(generated.exists());
        assert_eq!(fs::read(unknown).unwrap(), b"preserve");
    }
}
