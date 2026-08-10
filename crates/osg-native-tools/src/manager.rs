use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use uuid::Uuid;

use crate::archive::{install_artifact, set_permissions};
use crate::catalog::{DeliveryCatalog, ExecutableRole, NativeToolId, ToolDelivery, catalog};
use crate::download::{FileFetcher, HttpFileFetcher, RemoteFile};
use crate::path_security::{
    acquire_store_lock, cleanup_empty_work_tree, ensure_direct_child, initialize_store,
    remove_exact_tree, require_directory, resolve_owned,
};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt;
use crate::{CancellationToken, NativeToolError, Result};

/// Desktop integration must terminate and reap every process using a tool
/// before publication or removal can continue.
pub trait RuntimeCoordinator: Send + Sync {
    fn quiesce(&self, tool: NativeToolId) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeToolState {
    Unavailable,
    Missing,
    Installed,
    Corrupt,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolStatus {
    pub id: NativeToolId,
    pub label: &'static str,
    pub delivery_available: bool,
    pub installed: bool,
    pub state: NativeToolState,
    pub version: Option<String>,
    pub available_version: Option<String>,
    pub installed_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemovalOutcome {
    Missing,
    Removed,
    PreservedModified,
}

#[derive(Clone)]
pub struct NativeToolManager(Arc<ManagerInner>);

struct ManagerInner {
    root: PathBuf,
    _store_lock: fs::File,
    catalog: &'static DeliveryCatalog,
    fetcher: Arc<dyn FileFetcher>,
    coordinator: Arc<dyn RuntimeCoordinator>,
    activity: Mutex<ActivityState>,
}

#[derive(Debug, Default)]
struct ActivityState {
    operations: HashSet<NativeToolId>,
    leases: HashMap<NativeToolId, usize>,
}

impl fmt::Debug for NativeToolManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeToolManager")
            .field("root", &"<redacted>")
            .field("platform", &self.0.catalog.platform())
            .finish_non_exhaustive()
    }
}

impl NativeToolManager {
    pub fn new(root: impl AsRef<Path>, coordinator: Arc<dyn RuntimeCoordinator>) -> Result<Self> {
        let catalog = DeliveryCatalog::builtin()?;
        let fetcher = Arc::new(HttpFileFetcher::new()?);
        Self::with_parts(root.as_ref(), coordinator, catalog, fetcher)
    }

    fn with_parts(
        root: &Path,
        coordinator: Arc<dyn RuntimeCoordinator>,
        catalog: &'static DeliveryCatalog,
        fetcher: Arc<dyn FileFetcher>,
    ) -> Result<Self> {
        let root = initialize_store(root)?;
        let store_lock = acquire_store_lock(&root)?;
        Ok(Self(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            catalog,
            fetcher,
            coordinator,
            activity: Mutex::new(ActivityState::default()),
        })))
    }

    #[must_use]
    pub fn statuses(&self) -> Vec<NativeToolStatus> {
        NativeToolId::ALL
            .into_iter()
            .map(|tool| self.status(tool))
            .collect()
    }

    #[must_use]
    pub fn status(&self, tool: NativeToolId) -> NativeToolStatus {
        let info = catalog()
            .iter()
            .find(|entry| entry.id == tool)
            .expect("public tool catalog is exhaustive");
        let Some(delivery) = self.0.catalog.current(tool) else {
            return NativeToolStatus {
                id: tool,
                label: info.label,
                delivery_available: false,
                installed: false,
                state: NativeToolState::Unavailable,
                version: None,
                available_version: None,
                installed_bytes: 0,
            };
        };
        let target = self.version_path(delivery);
        let state = match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => NativeToolState::Missing,
            Ok(metadata) if metadata.is_dir() => {
                if receipt::validate_integrity(&target, delivery, &CancellationToken::default())
                    .is_ok()
                {
                    NativeToolState::Installed
                } else {
                    NativeToolState::Corrupt
                }
            }
            Ok(_) | Err(_) => NativeToolState::Corrupt,
        };
        NativeToolStatus {
            id: tool,
            label: info.label,
            delivery_available: true,
            installed: state == NativeToolState::Installed,
            state,
            version: (state == NativeToolState::Installed).then(|| delivery.version.clone()),
            available_version: Some(delivery.version.clone()),
            installed_bytes: if state == NativeToolState::Installed {
                delivery.installed_bytes
            } else {
                0
            },
        }
    }

    pub fn install(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<NativeToolStatus> {
        let delivery = self
            .0
            .catalog
            .current(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        let _operation = self.begin_operation(tool)?;
        cancellation.check()?;
        let target = self.version_path(delivery);
        if target.exists() {
            receipt::validate_integrity(&target, delivery, cancellation)?;
            return Ok(self.status(tool));
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Preparing, 0, 1));

        let operation_name = format!("{}-{}-{}", tool.as_str(), delivery.version, Uuid::now_v7());
        let staging_parent = self.0.root.join(".staging");
        let downloads_parent = self.0.root.join(".downloads");
        require_directory(&staging_parent)?;
        require_directory(&downloads_parent)?;
        let staging = staging_parent.join(&operation_name);
        let downloads = downloads_parent.join(&operation_name);
        fs::create_dir(&staging).map_err(|_| NativeToolError::StoreUnavailable)?;
        fs::create_dir(&downloads).map_err(|_| NativeToolError::StoreUnavailable)?;
        require_directory(&staging)?;
        require_directory(&downloads)?;
        let mut work = WorkGuard::new(staging.clone(), downloads.clone());

        let artifact_path = downloads.join(&delivery.asset);
        self.0.fetcher.fetch(
            RemoteFile {
                url: &delivery.source_url,
                size_bytes: delivery.size_bytes,
                sha256: &delivery.sha256,
            },
            &artifact_path,
            cancellation,
            progress,
        )?;
        for notice in &delivery.notices {
            cancellation.check()?;
            let target = crate::path_security::prepare_target(&downloads, &notice.install_path)?;
            self.0.fetcher.fetch(
                RemoteFile {
                    url: &notice.source_url,
                    size_bytes: notice.size_bytes,
                    sha256: &notice.sha256,
                },
                &target,
                cancellation,
                progress,
            )?;
        }
        install_artifact(&artifact_path, &staging, delivery, cancellation, progress)?;
        for notice in &delivery.notices {
            cancellation.check()?;
            let source = resolve_owned(&downloads, &notice.install_path)?;
            let target = crate::path_security::prepare_target(&staging, &notice.install_path)?;
            fs::rename(source, &target).map_err(|_| NativeToolError::StoreUnavailable)?;
            set_permissions(&target, false)?;
        }
        cleanup_empty_work_tree(&downloads)?;
        work.downloads_cleaned = true;
        receipt::write(&staging, delivery)?;
        receipt::validate_integrity(&staging, delivery, cancellation)?;

        self.0.coordinator.quiesce(tool)?;
        cancellation.check()?;
        let versions = self.ensure_versions_root(tool)?;
        let target = versions.join(&delivery.version);
        if target.exists() {
            return Err(NativeToolError::InvalidInstall);
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 0, 1));
        fs::rename(&staging, &target).map_err(|_| NativeToolError::StoreUnavailable)?;
        work.staging_published = true;
        receipt::validate_integrity(&target, delivery, cancellation)?;
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 1, 1));
        Ok(self.status(tool))
    }

    pub fn remove(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        let delivery = self
            .0
            .catalog
            .current(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        let _operation = self.begin_operation(tool)?;
        cancellation.check()?;
        let target = self.version_path(delivery);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RemovalOutcome::Missing);
            }
            Ok(_) => {}
            Err(_) => return Err(NativeToolError::StoreUnavailable),
        }
        if let Err(error) = receipt::validate_integrity(&target, delivery, cancellation) {
            return match error {
                NativeToolError::Cancelled => Err(error),
                _ => Ok(RemovalOutcome::PreservedModified),
            };
        }
        self.0.coordinator.quiesce(tool)?;
        cancellation.check()?;
        progress.on_progress(OperationProgress::new(OperationPhase::Removing, 0, 1));
        let trash_parent = self.0.root.join(".trash");
        require_directory(&trash_parent)?;
        let trash = trash_parent.join(format!(
            "{}-{}-{}",
            tool.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::rename(&target, &trash).map_err(|_| NativeToolError::StoreUnavailable)?;
        remove_exact_tree(&trash, &receipt::allowed_tree(delivery))?;
        progress.on_progress(OperationProgress::new(OperationPhase::Removing, 1, 1));
        Ok(RemovalOutcome::Removed)
    }

    pub fn resolve(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease> {
        let delivery = self
            .0
            .catalog
            .current(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        {
            let mut activity = self
                .0
                .activity
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            if activity.operations.contains(&tool) {
                return Err(NativeToolError::OperationInProgress(tool));
            }
            *activity.leases.entry(tool).or_default() += 1;
        }
        let mut lease = ToolLease {
            inner: Arc::clone(&self.0),
            tool,
            version: delivery.version.clone(),
            executables: HashMap::new(),
            active: true,
        };
        let root = self.version_path(delivery);
        receipt::validate_integrity(&root, delivery, cancellation)?;
        let canonical_root =
            fs::canonicalize(&root).map_err(|_| NativeToolError::InvalidInstall)?;
        for file in &delivery.files {
            let candidate = resolve_owned(&root, &file.install_path)?;
            let canonical =
                fs::canonicalize(candidate).map_err(|_| NativeToolError::InvalidInstall)?;
            if !canonical.starts_with(&canonical_root) {
                return Err(NativeToolError::InvalidInstall);
            }
            lease.executables.insert(file.role, canonical);
        }
        Ok(lease)
    }

    fn begin_operation(&self, tool: NativeToolId) -> Result<OperationGuard> {
        let mut activity = self
            .0
            .activity
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        if activity.operations.contains(&tool) {
            return Err(NativeToolError::OperationInProgress(tool));
        }
        if activity.leases.get(&tool).copied().unwrap_or(0) > 0 {
            return Err(NativeToolError::RuntimeBusy);
        }
        activity.operations.insert(tool);
        drop(activity);
        Ok(OperationGuard {
            inner: Arc::clone(&self.0),
            tool,
        })
    }

    fn version_path(&self, delivery: &ToolDelivery) -> PathBuf {
        self.0
            .root
            .join("tools")
            .join(delivery.tool.as_str())
            .join("versions")
            .join(&delivery.version)
    }

    fn ensure_versions_root(&self, tool: NativeToolId) -> Result<PathBuf> {
        let tools = self.0.root.join("tools");
        let tool_root = ensure_direct_child(&tools, tool.as_str())?;
        ensure_direct_child(&tool_root, "versions")
    }
}

struct OperationGuard {
    inner: Arc<ManagerInner>,
    tool: NativeToolId,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.inner.activity.lock() {
            activity.operations.remove(&self.tool);
        }
    }
}

struct WorkGuard {
    staging: PathBuf,
    downloads: PathBuf,
    staging_published: bool,
    downloads_cleaned: bool,
}

impl WorkGuard {
    fn new(staging: PathBuf, downloads: PathBuf) -> Self {
        Self {
            staging,
            downloads,
            staging_published: false,
            downloads_cleaned: false,
        }
    }
}

impl Drop for WorkGuard {
    fn drop(&mut self) {
        if !self.downloads_cleaned {
            let _ = cleanup_empty_work_tree(&self.downloads);
        }
        if !self.staging_published {
            let _ = cleanup_empty_work_tree(&self.staging);
        }
    }
}

/// A verified in-process executable capability. Debug and serialization never
/// expose its filesystem paths.
pub struct ToolLease {
    inner: Arc<ManagerInner>,
    tool: NativeToolId,
    version: String,
    executables: HashMap<ExecutableRole, PathBuf>,
    active: bool,
}

impl ToolLease {
    #[must_use]
    pub const fn tool(&self) -> NativeToolId {
        self.tool
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn executable(&self, role: ExecutableRole) -> Option<&Path> {
        self.executables.get(&role).map(PathBuf::as_path)
    }
}

impl fmt::Debug for ToolLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolLease")
            .field("tool", &self.tool)
            .field("version", &self.version)
            .field("executables", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl Drop for ToolLease {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut activity) = self.inner.activity.lock()
            && let Some(count) = activity.leases.get_mut(&self.tool)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                activity.leases.remove(&self.tool);
            }
        }
        self.active = false;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::catalog::parse_for_test;

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

    fn fixture_catalog() -> (&'static DeliveryCatalog, Arc<MemoryFetcher>) {
        let raw = include_str!("../delivery/native-tools.delivery.json");
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
        NativeToolManager::with_parts(temp.path(), coordinator, catalog, fetcher).unwrap()
    }

    #[test]
    fn install_resolve_busy_remove_lifecycle_is_verified_and_path_free() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = manager(&temp, coordinator.clone());
        assert_eq!(
            manager.status(NativeToolId::YtDlp).state,
            NativeToolState::Missing
        );
        let installed = manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        assert_eq!(installed.state, NativeToolState::Installed);
        let encoded = serde_json::to_string(&installed).unwrap();
        assert!(!encoded.contains("http"));
        assert!(!encoded.contains("bin/"));
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));

        let lease = manager
            .resolve(NativeToolId::YtDlp, &CancellationToken::default())
            .unwrap();
        assert!(lease.executable(ExecutableRole::YtDlp).unwrap().is_file());
        assert_eq!(
            manager.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {},),
            Err(NativeToolError::RuntimeBusy)
        );
        drop(lease);
        assert_eq!(
            manager
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {},)
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(coordinator.0.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn modified_install_is_reported_and_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, Arc::new(TestCoordinator::default()));
        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        let delivery = manager.0.catalog.current(NativeToolId::YtDlp).unwrap();
        fs::write(
            manager.version_path(delivery).join("bin/yt-dlp.exe"),
            b"modified",
        )
        .unwrap();
        assert_eq!(
            manager.status(NativeToolId::YtDlp).state,
            NativeToolState::Corrupt
        );
        assert_eq!(
            manager
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {},)
                .unwrap(),
            RemovalOutcome::PreservedModified
        );
        assert!(manager.version_path(delivery).exists());
    }

    #[test]
    fn blocked_ffmpeg_never_downloads_or_quiesces() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = manager(&temp, coordinator.clone());
        assert_eq!(
            manager.status(NativeToolId::MediaTools).state,
            NativeToolState::Unavailable
        );
        assert_eq!(
            manager.install(
                NativeToolId::MediaTools,
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(NativeToolError::DeliveryUnavailable)
        );
        assert_eq!(coordinator.0.load(Ordering::Relaxed), 0);
    }
}
