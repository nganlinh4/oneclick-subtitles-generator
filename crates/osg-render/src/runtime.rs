use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{RenderError, Result};

pub const REMOTION_VERSION: &str = "4.0.507";
const MANIFEST_NAME: &str = "remotion-runtime.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 100_000;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const REQUIRED_ROLES: [&str; 7] = [
    "node",
    "browser",
    "rendererPackage",
    "bundleIndex",
    "binariesMarker",
    "fontManifest",
    "notices",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeFile {
    pub role: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRuntimeManifest {
    pub schema_version: u32,
    pub target: String,
    pub remotion_version: String,
    pub files: Vec<RuntimeFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub available: bool,
    pub remotion_version: &'static str,
    pub reason: Option<&'static str>,
}

#[derive(Clone)]
pub struct RenderRuntime {
    root: PathBuf,
    manifest: PathBuf,
    manifest_hash: String,
    node: PathBuf,
    browser: PathBuf,
    renderer_root: PathBuf,
    bundle: PathBuf,
    binaries: PathBuf,
    worker: PathBuf,
    worker_hash: String,
    runtime_hashes: HashMap<PathBuf, String>,
    bundle_hashes: HashMap<PathBuf, String>,
}

impl std::fmt::Debug for RenderRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RenderRuntime")
            .field("root", &"<redacted>")
            .field("remotion_version", &REMOTION_VERSION)
            .finish_non_exhaustive()
    }
}

impl RenderRuntime {
    #[allow(
        clippy::too_many_lines,
        reason = "runtime verification is kept as one fail-closed transaction"
    )]
    pub fn load(
        runtime_root: &Path,
        worker_path: &Path,
        expected_worker: &[u8],
        expected_target: &str,
    ) -> Result<Self> {
        let root = canonical_regular_directory(runtime_root)?;
        let manifest_path = root.join(MANIFEST_NAME);
        let metadata = safe_file_metadata(&manifest_path)?;
        if metadata.len() == 0 || metadata.len() > MAX_MANIFEST_BYTES {
            return Err(RenderError::RuntimeUnavailable);
        }
        let manifest_bytes =
            fs::read(&manifest_path).map_err(|_| RenderError::RuntimeUnavailable)?;
        let manifest: RenderRuntimeManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| RenderError::RuntimeUnavailable)?;
        if manifest.schema_version != 1
            || manifest.target != expected_target
            || manifest.remotion_version != REMOTION_VERSION
            || manifest.files.len() < REQUIRED_ROLES.len()
            || manifest.files.len() > MAX_RUNTIME_FILES
        {
            return Err(RenderError::RuntimeUnavailable);
        }

        let mut files = HashMap::new();
        let mut verified_files = HashMap::new();
        let mut paths = HashSet::new();
        for entry in &manifest.files {
            if entry.role != "payload"
                && (files.contains_key(entry.role.as_str())
                    || !REQUIRED_ROLES.contains(&entry.role.as_str()))
                || entry.size_bytes == 0
                || entry.size_bytes > MAX_RUNTIME_FILE_BYTES
                || !valid_sha256(&entry.sha256)
            {
                return Err(RenderError::RuntimeUnavailable);
            }
            let relative = safe_relative_path(&entry.path)?;
            if !paths.insert(relative.clone()) {
                return Err(RenderError::RuntimeUnavailable);
            }
            let path = root.join(relative);
            validate_under_root(&root, &path)?;
            let metadata = safe_file_metadata(&path)?;
            if metadata.len() != entry.size_bytes
                || sha256_file(&path)? != entry.sha256.to_ascii_lowercase()
            {
                return Err(RenderError::RuntimeUnavailable);
            }
            if entry.role != "payload" {
                files.insert(entry.role.as_str(), path.clone());
            }
            verified_files.insert(path, entry.sha256.to_ascii_lowercase());
        }
        if REQUIRED_ROLES.iter().any(|role| !files.contains_key(role)) {
            return Err(RenderError::RuntimeUnavailable);
        }

        verify_runtime_tree(&root, &manifest_path, &verified_files)?;
        let worker = fs::canonicalize(worker_path).map_err(|_| RenderError::RuntimeUnavailable)?;
        let worker_metadata = safe_file_metadata(&worker)?;
        if worker_metadata.len()
            != u64::try_from(expected_worker.len()).map_err(|_| RenderError::RuntimeUnavailable)?
            || fs::read(&worker).map_err(|_| RenderError::RuntimeUnavailable)? != expected_worker
        {
            return Err(RenderError::RuntimeUnavailable);
        }

        let node = files
            .remove("node")
            .ok_or(RenderError::RuntimeUnavailable)?;
        let browser = files
            .remove("browser")
            .ok_or(RenderError::RuntimeUnavailable)?;
        ensure_executable(&node)?;
        ensure_executable(&browser)?;
        let renderer_package = files
            .remove("rendererPackage")
            .ok_or(RenderError::RuntimeUnavailable)?;
        let renderer_root = renderer_package
            .parent()
            .ok_or(RenderError::RuntimeUnavailable)?
            .to_owned();
        let bundle_index = files
            .remove("bundleIndex")
            .ok_or(RenderError::RuntimeUnavailable)?;
        let bundle = bundle_index
            .parent()
            .ok_or(RenderError::RuntimeUnavailable)?
            .to_owned();
        let binaries_marker = files
            .remove("binariesMarker")
            .ok_or(RenderError::RuntimeUnavailable)?;
        let binaries = binaries_marker
            .parent()
            .ok_or(RenderError::RuntimeUnavailable)?
            .to_owned();
        let font_manifest = files
            .remove("fontManifest")
            .ok_or(RenderError::RuntimeUnavailable)?;
        if !font_manifest.starts_with(&bundle) {
            return Err(RenderError::RuntimeUnavailable);
        }
        let bundle_hashes = collect_bundle_hashes(&bundle, &verified_files)?;
        let package: serde_json::Value = serde_json::from_slice(
            &fs::read(&renderer_package).map_err(|_| RenderError::RuntimeUnavailable)?,
        )
        .map_err(|_| RenderError::RuntimeUnavailable)?;
        if package.get("version").and_then(serde_json::Value::as_str) != Some(REMOTION_VERSION) {
            return Err(RenderError::RuntimeUnavailable);
        }

        Ok(Self {
            root,
            manifest: manifest_path,
            manifest_hash: format!("{:x}", Sha256::digest(&manifest_bytes)),
            node,
            browser,
            renderer_root,
            bundle,
            binaries,
            worker,
            worker_hash: format!("{:x}", Sha256::digest(expected_worker)),
            runtime_hashes: verified_files,
            bundle_hashes,
        })
    }

    #[must_use]
    pub const fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            available: true,
            remotion_version: REMOTION_VERSION,
            reason: None,
        }
    }

    #[must_use]
    pub(crate) fn node(&self) -> &Path {
        &self.node
    }

    #[must_use]
    pub(crate) fn browser(&self) -> &Path {
        &self.browser
    }

    #[must_use]
    pub(crate) fn renderer_root(&self) -> &Path {
        &self.renderer_root
    }

    #[must_use]
    pub(crate) fn bundle(&self) -> &Path {
        &self.bundle
    }

    #[must_use]
    pub(crate) fn binaries(&self) -> &Path {
        &self.binaries
    }

    #[must_use]
    pub(crate) fn worker(&self) -> &Path {
        &self.worker
    }

    pub(crate) fn verify_execution_payload(&self) -> Result<()> {
        if sha256_file(&self.manifest)? != self.manifest_hash
            || sha256_file(&self.worker)? != self.worker_hash
        {
            return Err(RenderError::RuntimeUnavailable);
        }
        verify_runtime_tree(&self.root, &self.manifest, &self.runtime_hashes)?;
        for (path, expected) in &self.runtime_hashes {
            if sha256_file(path)? != *expected {
                return Err(RenderError::RuntimeUnavailable);
            }
        }
        Ok(())
    }

    pub(crate) fn verify_copied_bundle_file(&self, source: &Path, copied: &Path) -> Result<()> {
        let expected = self
            .bundle_hashes
            .get(source)
            .ok_or(RenderError::RuntimeUnavailable)?;
        if sha256_file(copied)? != *expected {
            return Err(RenderError::RuntimeUnavailable);
        }
        Ok(())
    }

    #[must_use]
    pub(crate) fn bundle_file_count(&self) -> usize {
        self.bundle_hashes.len()
    }
}

fn collect_bundle_hashes(
    bundle: &Path,
    verified_files: &HashMap<PathBuf, String>,
) -> Result<HashMap<PathBuf, String>> {
    let mut hashes = HashMap::new();
    let mut pending = vec![bundle.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|_| RenderError::RuntimeUnavailable)? {
            let entry = entry.map_err(|_| RenderError::RuntimeUnavailable)?;
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| RenderError::RuntimeUnavailable)?;
            if is_link_or_reparse(&metadata) {
                return Err(RenderError::RuntimeUnavailable);
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let expected = verified_files
                    .get(&path)
                    .ok_or(RenderError::RuntimeUnavailable)?;
                hashes.insert(path, expected.clone());
            } else {
                return Err(RenderError::RuntimeUnavailable);
            }
        }
    }
    if hashes.is_empty() {
        return Err(RenderError::RuntimeUnavailable);
    }
    Ok(hashes)
}

fn verify_runtime_tree(
    root: &Path,
    manifest: &Path,
    verified_files: &HashMap<PathBuf, String>,
) -> Result<()> {
    let mut pending = vec![root.to_owned()];
    let mut entries = 0_usize;
    let mut observed_files = 0_usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|_| RenderError::RuntimeUnavailable)? {
            entries = entries
                .checked_add(1)
                .filter(|count| *count <= MAX_RUNTIME_FILES.saturating_mul(2))
                .ok_or(RenderError::RuntimeUnavailable)?;
            let entry = entry.map_err(|_| RenderError::RuntimeUnavailable)?;
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| RenderError::RuntimeUnavailable)?;
            if is_link_or_reparse(&metadata) {
                return Err(RenderError::RuntimeUnavailable);
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                if path == manifest {
                    continue;
                }
                if !verified_files.contains_key(&path) {
                    return Err(RenderError::RuntimeUnavailable);
                }
                observed_files = observed_files
                    .checked_add(1)
                    .ok_or(RenderError::RuntimeUnavailable)?;
            } else {
                return Err(RenderError::RuntimeUnavailable);
            }
        }
    }
    (observed_files == verified_files.len())
        .then_some(())
        .ok_or(RenderError::RuntimeUnavailable)
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > 4_096 || value.contains('\\') {
        return Err(RenderError::RuntimeUnavailable);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(RenderError::RuntimeUnavailable);
    }
    Ok(path.to_owned())
}

fn canonical_regular_directory(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|_| RenderError::RuntimeUnavailable)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(RenderError::RuntimeUnavailable);
    }
    fs::canonicalize(path).map_err(|_| RenderError::RuntimeUnavailable)
}

fn validate_under_root(root: &Path, path: &Path) -> Result<()> {
    let mut cursor = root.to_owned();
    let relative = path
        .strip_prefix(root)
        .map_err(|_| RenderError::RuntimeUnavailable)?;
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(RenderError::RuntimeUnavailable);
        }
        cursor.push(component.as_os_str());
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|_| RenderError::RuntimeUnavailable)?;
        if is_link_or_reparse(&metadata) {
            return Err(RenderError::RuntimeUnavailable);
        }
    }
    let canonical = fs::canonicalize(path).map_err(|_| RenderError::RuntimeUnavailable)?;
    if !canonical.starts_with(root) {
        return Err(RenderError::RuntimeUnavailable);
    }
    Ok(())
}

fn safe_file_metadata(path: &Path) -> Result<Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| RenderError::RuntimeUnavailable)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(RenderError::RuntimeUnavailable);
    }
    Ok(metadata)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|_| RenderError::RuntimeUnavailable)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| RenderError::RuntimeUnavailable)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    (fs::metadata(path)
        .map_err(|_| RenderError::RuntimeUnavailable)?
        .permissions()
        .mode()
        & 0o111
        != 0)
        .then_some(())
        .ok_or(RenderError::RuntimeUnavailable)
}

#[cfg(windows)]
fn ensure_executable(path: &Path) -> Result<()> {
    let extension = path.extension().and_then(|value| value.to_str());
    matches!(extension, Some(value) if value.eq_ignore_ascii_case("exe"))
        .then_some(())
        .ok_or(RenderError::RuntimeUnavailable)
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

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn write_runtime_file(root: &Path, relative: &str, bytes: &[u8], executable: bool) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("runtime parent")).expect("create parent");
        fs::write(&path, bytes).expect("write runtime file");
        #[cfg(unix)]
        if executable {
            let mut permissions = fs::metadata(&path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("executable permissions");
        }
        #[cfg(windows)]
        let _ = executable;
    }

    fn complete_runtime(root: &Path, worker: &Path) -> Vec<serde_json::Value> {
        let node = if cfg!(windows) {
            "bin/node.exe"
        } else {
            "bin/node"
        };
        let browser = if cfg!(windows) {
            "browser/chrome.exe"
        } else {
            "browser/chrome"
        };
        let files = [
            ("node", node, b"node".as_slice(), true),
            ("browser", browser, b"browser".as_slice(), true),
            (
                "rendererPackage",
                "renderer/package.json",
                br#"{"version":"4.0.507","main":"index.js"}"#.as_slice(),
                false,
            ),
            (
                "bundleIndex",
                "bundle/index.html",
                b"<html></html>".as_slice(),
                false,
            ),
            (
                "binariesMarker",
                "binaries/.ready",
                b"ready".as_slice(),
                false,
            ),
            (
                "fontManifest",
                "bundle/fonts/fonts.css",
                b"@font-face{}".as_slice(),
                false,
            ),
            (
                "notices",
                "THIRD_PARTY_NOTICES.txt",
                b"notices".as_slice(),
                false,
            ),
        ];
        fs::write(worker, b"worker").expect("worker");
        files
            .into_iter()
            .map(|(role, path, bytes, executable)| {
                write_runtime_file(root, path, bytes, executable);
                json!({
                    "role": role,
                    "path": path,
                    "sizeBytes": bytes.len(),
                    "sha256": hash(bytes),
                })
            })
            .collect()
    }

    #[test]
    fn complete_runtime_loads_and_any_bundle_mutation_fails_closed() {
        let root = tempfile::tempdir().expect("root");
        let worker_root = tempfile::tempdir().expect("worker root");
        let worker = worker_root.path().join("worker.mjs");
        let files = complete_runtime(root.path(), &worker);
        let manifest = json!({
            "schemaVersion":1,
            "target":"test-target",
            "remotionVersion":REMOTION_VERSION,
            "files":files,
        });
        fs::write(
            root.path().join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).expect("json"),
        )
        .expect("manifest");

        let runtime = RenderRuntime::load(root.path(), &worker, b"worker", "test-target")
            .expect("complete runtime");
        assert!(runtime.status().available);
        assert_eq!(runtime.bundle_file_count(), 2);

        fs::write(root.path().join("bundle/index.html"), b"mutated").expect("mutation");
        assert!(matches!(
            runtime.verify_execution_payload(),
            Err(RenderError::RuntimeUnavailable)
        ));
        assert!(matches!(
            RenderRuntime::load(root.path(), &worker, b"worker", "test-target"),
            Err(RenderError::RuntimeUnavailable)
        ));
    }

    #[test]
    fn incomplete_or_mutated_runtime_fails_closed_without_path_debugging() {
        let root = tempfile::tempdir().expect("root");
        let worker = root.path().join("worker.mjs");
        fs::write(&worker, b"worker").expect("worker");
        fs::write(root.path().join(MANIFEST_NAME), b"{}").expect("manifest");
        let error = RenderRuntime::load(root.path(), &worker, b"worker", "test-target")
            .expect_err("incomplete runtime");
        assert!(matches!(error, RenderError::RuntimeUnavailable));
        assert!(!format!("{error:?}").contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn duplicate_roles_and_escape_paths_are_rejected_before_hashing() {
        let root = tempfile::tempdir().expect("root");
        let worker = root.path().join("worker.mjs");
        fs::write(&worker, b"worker").expect("worker");
        let entry = json!({
            "role":"node","path":"../escape","sizeBytes":1,"sha256":hash(b"x")
        });
        let manifest = json!({
            "schemaVersion":1,"target":"test-target","remotionVersion":REMOTION_VERSION,
            "files":[entry.clone(), entry.clone(), entry.clone(), entry.clone(), entry.clone(), entry.clone(), entry]
        });
        fs::write(
            root.path().join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).expect("json"),
        )
        .expect("manifest");
        assert!(matches!(
            RenderRuntime::load(root.path(), &worker, b"worker", "test-target"),
            Err(RenderError::RuntimeUnavailable)
        ));
    }
}
