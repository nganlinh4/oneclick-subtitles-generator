//! Shared doubles and fixtures for the manager tests; each subject lives in its own submodule.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering, Ordering as AtomicOrdering};

use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use super::*;
use crate::CancellationToken;
use crate::archive::set_permissions;
use crate::catalog::{ExecutableRole, parse_for_test};
use crate::download::RemoteFile;
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};

mod lifecycle;
mod live;
mod removal;
mod rollback;

#[derive(Debug, Default)]
struct TestCoordinator(AtomicUsize);

impl RuntimeCoordinator for TestCoordinator {
    fn quiesce(&self, _: NativeToolId) -> Result<()> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Debug)]
struct MemoryFetcher(HashMap<String, Vec<u8>>);

#[derive(Debug)]
struct NoUpdateResolver;

impl YtDlpReleaseResolver for NoUpdateResolver {
    fn latest(&self, _: &str) -> Result<ToolDelivery> {
        Err(NativeToolError::Network)
    }
}

#[derive(Debug)]
struct SequenceResolver {
    responses: Mutex<Vec<Result<ToolDelivery>>>,
    calls: AtomicUsize,
}

impl YtDlpReleaseResolver for SequenceResolver {
    fn latest(&self, _: &str) -> Result<ToolDelivery> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let mut responses = self.responses.lock().unwrap();
        if responses.is_empty() {
            return Err(NativeToolError::Network);
        }
        responses.remove(0)
    }
}

impl FileFetcher for MemoryFetcher {
    fn fetch(
        &self,
        remote: RemoteFile<'_>,
        target: &Path,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<()> {
        cancellation.check()?;
        let bytes = self.0.get(remote.url).ok_or(NativeToolError::Network)?;
        if bytes.len() as u64 != remote.size_bytes || digest(bytes) != remote.sha256 {
            return Err(NativeToolError::Integrity);
        }
        fs::write(target, bytes).map_err(|_| NativeToolError::StoreUnavailable)?;
        progress.on_progress(OperationProgress::new(
            OperationPhase::Downloading,
            remote.size_bytes,
            remote.size_bytes,
        ));
        Ok(())
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Mirrors `e2e/support/settingsSurfaceOracle.js`'s `directoryShapeDigest`:
/// a full recursive inventory of `root` (every directory, file, and its
/// size, in sorted order) so a Rust test can assert the exact same
/// "byte-for-byte, entry-for-entry identical" invariant the e2e journey
/// settingsToolsRemoveAndFactoryReset checks after removal.
#[derive(Debug, PartialEq, Eq)]
struct StoreShape {
    entries: usize,
    files: usize,
    bytes: u64,
    paths: Vec<String>,
}

fn visit_store_shape(
    current: &Path,
    root: &Path,
    paths: &mut Vec<String>,
    files: &mut usize,
    bytes: &mut u64,
) {
    let mut children = fs::read_dir(current)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    children.sort();
    for child in children {
        let relative = child
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = fs::symlink_metadata(&child).unwrap();
        if metadata.is_dir() {
            paths.push(format!("dir:{relative}"));
            visit_store_shape(&child, root, paths, files, bytes);
        } else {
            *files += 1;
            *bytes += metadata.len();
            paths.push(format!("file:{relative}:{}", metadata.len()));
        }
    }
}

fn store_shape(root: &Path) -> StoreShape {
    let mut paths = Vec::new();
    let mut files = 0_usize;
    let mut bytes = 0_u64;
    visit_store_shape(root, root, &mut paths, &mut files, &mut bytes);
    StoreShape {
        entries: paths.len(),
        files,
        bytes,
        paths,
    }
}

fn fixture_catalog() -> (&'static DeliveryCatalog, Arc<MemoryFetcher>) {
    let raw = include_str!("../../delivery/native-tools.delivery.json");
    let mut document: serde_json::Value = serde_json::from_str(raw).unwrap();
    let yt = &mut document["tools"][1];
    let notice_bytes = [b"license".as_slice(), b"third-party".as_slice()];
    for (index, bytes) in notice_bytes.iter().enumerate() {
        yt["notices"][index]["sizeBytes"] = serde_json::json!(bytes.len());
        yt["notices"][index]["sha256"] = serde_json::json!(digest(bytes));
    }
    let tool_bytes = b"verified-tool";
    for platform in crate::catalog::PLATFORM_KEYS {
        let release = &mut yt["platforms"][platform]["releases"][0];
        release["artifact"]["sizeBytes"] = serde_json::json!(tool_bytes.len());
        release["artifact"]["sha256"] = serde_json::json!(digest(tool_bytes));
        release["files"][0]["sizeBytes"] = serde_json::json!(tool_bytes.len());
        release["files"][0]["sha256"] = serde_json::json!(digest(tool_bytes));
    }
    let catalog = Box::leak(Box::new(
        parse_for_test(&document.to_string(), "windows-x86_64").unwrap(),
    ));
    let delivery = catalog.current(NativeToolId::YtDlp).unwrap();
    let mut files = HashMap::new();
    files.insert(delivery.source_url.clone(), tool_bytes.to_vec());
    for (notice, bytes) in delivery.notices.iter().zip(notice_bytes) {
        files.insert(notice.source_url.clone(), bytes.to_vec());
    }
    (catalog, Arc::new(MemoryFetcher(files)))
}

fn manager(temp: &tempfile::TempDir, coordinator: Arc<TestCoordinator>) -> NativeToolManager {
    let (catalog, fetcher) = fixture_catalog();
    NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        fetcher,
        Arc::new(NoUpdateResolver),
    )
    .unwrap()
}

fn updated_ytdlp(base: &ToolDelivery, bytes: &[u8], notices: &[&[u8]]) -> ToolDelivery {
    let mut delivery = base.clone();
    delivery.version = "2026.08.10".to_string();
    delivery.source_revision = "a".repeat(40);
    delivery.source_url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/download/{}/{}",
        delivery.version, delivery.asset
    );
    delivery.size_bytes = bytes.len() as u64;
    delivery.sha256 = digest(bytes);
    delivery.files[0].size_bytes = bytes.len() as u64;
    delivery.files[0].sha256 = digest(bytes);
    for (notice, contents) in delivery.notices.iter_mut().zip(notices) {
        let source_name = notice.source_url.rsplit('/').next().unwrap();
        notice.source_url = format!(
            "https://raw.githubusercontent.com/yt-dlp/yt-dlp/{}/{source_name}",
            delivery.source_revision
        );
        notice.size_bytes = contents.len() as u64;
        notice.sha256 = digest(contents);
    }
    delivery.installed_bytes = delivery.size_bytes
        + delivery
            .notices
            .iter()
            .map(|notice| notice.size_bytes)
            .sum::<u64>();
    delivery
}

fn publish_fixture_delivery(
    store: &Path,
    delivery: &ToolDelivery,
    executable: &[u8],
    notices: &[&[u8]],
) {
    let target = store
        .join("tools")
        .join(delivery.tool.as_str())
        .join("versions")
        .join(&delivery.version);
    fs::create_dir_all(&target).unwrap();
    for file in &delivery.files {
        let path = crate::path_security::prepare_target(&target, &file.install_path).unwrap();
        fs::write(&path, executable).unwrap();
        set_permissions(&path, file.role.is_some()).unwrap();
    }
    for (notice, contents) in delivery.notices.iter().zip(notices) {
        let path = crate::path_security::prepare_target(&target, &notice.install_path).unwrap();
        fs::write(&path, contents).unwrap();
        set_permissions(&path, false).unwrap();
    }
    receipt::write(&target, delivery).unwrap();
    receipt::validate_integrity(&target, delivery, &CancellationToken::default()).unwrap();
}

fn manager_with_ytdlp_update(
    temp: &tempfile::TempDir,
    coordinator: Arc<TestCoordinator>,
) -> (NativeToolManager, ToolDelivery, ToolDelivery) {
    let (catalog, base_fetcher) = fixture_catalog();
    let base = catalog.current(NativeToolId::YtDlp).unwrap().clone();
    let base_manager = NativeToolManager::with_parts(
        temp.path(),
        coordinator.clone(),
        catalog,
        base_fetcher.clone(),
        Arc::new(NoUpdateResolver),
    )
    .unwrap();
    base_manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    drop(base_manager);

    let executable = b"updated-verified-tool";
    let notices = [
        b"updated-license".as_slice(),
        b"updated-third-party".as_slice(),
    ];
    let updated = updated_ytdlp(&base, executable, &notices);
    let mut files = base_fetcher.0.clone();
    files.insert(updated.source_url.clone(), executable.to_vec());
    for (notice, contents) in updated.notices.iter().zip(notices) {
        files.insert(notice.source_url.clone(), contents.to_vec());
    }
    let manager = NativeToolManager::with_parts(
        temp.path(),
        coordinator,
        catalog,
        Arc::new(MemoryFetcher(files)),
        Arc::new(SequenceResolver {
            responses: Mutex::new(vec![Ok(updated.clone())]),
            calls: AtomicUsize::new(0),
        }),
    )
    .unwrap();
    manager
        .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        .unwrap();
    (manager, base, updated)
}
