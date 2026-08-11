use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
use crate::update::{GitHubYtDlpReleaseResolver, YtDlpReleaseResolver};
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
    pub download_bytes: u64,
    pub available_installed_bytes: u64,
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
    ytdlp_releases: Arc<dyn YtDlpReleaseResolver>,
    ytdlp_update_check: Mutex<YtDlpUpdateCheck>,
    dynamic_ytdlp: Mutex<Vec<ToolDelivery>>,
    activity: Mutex<ActivityState>,
}

const YTDLP_UPDATE_CHECK_INTERVAL: Duration = Duration::from_mins(30);
const RETAINED_DYNAMIC_YTDLP_RELEASES: usize = 2;

#[derive(Debug, Default)]
struct YtDlpUpdateCheck {
    checked_at: Option<Instant>,
    candidate: Option<ToolDelivery>,
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
        let ytdlp_releases = Arc::new(GitHubYtDlpReleaseResolver::new()?);
        Self::with_parts(root.as_ref(), coordinator, catalog, fetcher, ytdlp_releases)
    }

    fn with_parts(
        root: &Path,
        coordinator: Arc<dyn RuntimeCoordinator>,
        catalog: &'static DeliveryCatalog,
        fetcher: Arc<dyn FileFetcher>,
        ytdlp_releases: Arc<dyn YtDlpReleaseResolver>,
    ) -> Result<Self> {
        let root = initialize_store(root)?;
        let store_lock = acquire_store_lock(&root)?;
        let dynamic_ytdlp = crate::update::load_installed(&root, catalog.platform())?;
        let manager = Self(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            catalog,
            fetcher,
            coordinator,
            ytdlp_releases,
            ytdlp_update_check: Mutex::new(YtDlpUpdateCheck::default()),
            dynamic_ytdlp: Mutex::new(dynamic_ytdlp),
            activity: Mutex::new(ActivityState::default()),
        }));
        manager.reconcile_dynamic_ytdlp_versions();
        Ok(manager)
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
        let Some(delivery) = self.current_delivery(tool) else {
            return NativeToolStatus {
                id: tool,
                label: info.label,
                delivery_available: false,
                installed: false,
                state: NativeToolState::Unavailable,
                version: None,
                available_version: None,
                installed_bytes: 0,
                download_bytes: 0,
                available_installed_bytes: 0,
            };
        };
        let target = self.version_path(&delivery);
        let state = match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => NativeToolState::Missing,
            Ok(metadata) if metadata.is_dir() => {
                if receipt::validate_integrity(&target, &delivery, &CancellationToken::default())
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
            download_bytes: delivery.size_bytes,
            available_installed_bytes: delivery.installed_bytes,
        }
    }

    pub fn install(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<NativeToolStatus> {
        let _operation = self.begin_install_operation(tool)?;
        let delivery = self.install_delivery(tool)?;
        cancellation.check()?;
        let target = self.version_path(&delivery);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(metadata) if metadata.is_dir() => {
                match receipt::validate_integrity(&target, &delivery, cancellation) {
                    Ok(()) => {
                        self.activate_dynamic_delivery(&delivery)?;
                        return Ok(self.status(tool));
                    }
                    Err(NativeToolError::Cancelled) => return Err(NativeToolError::Cancelled),
                    Err(_) => self.quarantine_invalid_install(&target, &delivery)?,
                }
            }
            Ok(_) => return Err(NativeToolError::InvalidInstall),
            Err(_) => return Err(NativeToolError::StoreUnavailable),
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
        install_artifact(&artifact_path, &staging, &delivery, cancellation, progress)?;
        for notice in &delivery.notices {
            cancellation.check()?;
            let source = resolve_owned(&downloads, &notice.install_path)?;
            let target = crate::path_security::prepare_target(&staging, &notice.install_path)?;
            fs::rename(source, &target).map_err(|_| NativeToolError::StoreUnavailable)?;
            set_permissions(&target, false)?;
        }
        cleanup_empty_work_tree(&downloads)?;
        work.downloads_cleaned = true;
        receipt::write(&staging, &delivery)?;
        receipt::validate_integrity(&staging, &delivery, cancellation)?;

        if !self.has_active_leases(tool)? {
            self.0.coordinator.quiesce(tool)?;
        }
        cancellation.check()?;
        let versions = self.ensure_versions_root(tool)?;
        let target = versions.join(&delivery.version);
        if target.exists() {
            return Err(NativeToolError::InvalidInstall);
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 0, 1));
        fs::rename(&staging, &target).map_err(|_| NativeToolError::StoreUnavailable)?;
        work.staging_published = true;
        receipt::validate_integrity(&target, &delivery, cancellation)?;
        self.activate_dynamic_delivery(&delivery)?;
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
            .current_delivery(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        let _operation = self.begin_operation(tool)?;
        cancellation.check()?;
        let target = self.version_path(&delivery);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RemovalOutcome::Missing);
            }
            Ok(_) => {}
            Err(_) => return Err(NativeToolError::StoreUnavailable),
        }
        if let Err(error) = receipt::validate_integrity(&target, &delivery, cancellation) {
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
        remove_exact_tree(&trash, &receipt::allowed_tree(&delivery))?;
        progress.on_progress(OperationProgress::new(OperationPhase::Removing, 1, 1));
        Ok(RemovalOutcome::Removed)
    }

    pub fn resolve(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease> {
        let delivery = self
            .current_delivery(tool)
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
        let root = self.version_path(&delivery);
        receipt::validate_integrity(&root, &delivery, cancellation)?;
        let canonical_root =
            fs::canonicalize(&root).map_err(|_| NativeToolError::InvalidInstall)?;
        for file in &delivery.files {
            let Some(role) = file.role else {
                continue;
            };
            let candidate = resolve_owned(&root, &file.install_path)?;
            let canonical =
                fs::canonicalize(candidate).map_err(|_| NativeToolError::InvalidInstall)?;
            if !canonical.starts_with(&canonical_root) {
                return Err(NativeToolError::InvalidInstall);
            }
            lease.executables.insert(role, canonical);
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

    fn begin_install_operation(&self, tool: NativeToolId) -> Result<OperationGuard> {
        let mut activity = self
            .0
            .activity
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        if activity.operations.contains(&tool) {
            return Err(NativeToolError::OperationInProgress(tool));
        }
        if tool != NativeToolId::YtDlp
            && activity.leases.get(&tool).copied().unwrap_or_default() > 0
        {
            return Err(NativeToolError::RuntimeBusy);
        }
        activity.operations.insert(tool);
        drop(activity);
        Ok(OperationGuard {
            inner: Arc::clone(&self.0),
            tool,
        })
    }

    fn has_active_leases(&self, tool: NativeToolId) -> Result<bool> {
        self.0
            .activity
            .lock()
            .map(|activity| activity.leases.get(&tool).copied().unwrap_or_default() > 0)
            .map_err(|_| NativeToolError::StoreUnavailable)
    }

    fn current_delivery(&self, tool: NativeToolId) -> Option<ToolDelivery> {
        if tool == NativeToolId::YtDlp
            && let Ok(dynamic) = self.0.dynamic_ytdlp.lock()
            && let Some(delivery) = dynamic.first()
        {
            return Some(delivery.clone());
        }
        self.0.catalog.current(tool).cloned()
    }

    fn install_delivery(&self, tool: NativeToolId) -> Result<ToolDelivery> {
        let current = self
            .current_delivery(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        if tool != NativeToolId::YtDlp {
            return Ok(current);
        }
        let mut update_check = self
            .0
            .ytdlp_update_check
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        if update_check
            .checked_at
            .is_some_and(|checked_at| checked_at.elapsed() < YTDLP_UPDATE_CHECK_INTERVAL)
        {
            return Ok(update_check
                .candidate
                .as_ref()
                .filter(|candidate| candidate.version > current.version)
                .cloned()
                .unwrap_or(current));
        }
        let candidate = self
            .0
            .ytdlp_releases
            .latest(self.0.catalog.platform())
            .ok()
            .filter(|latest| latest.version > current.version);
        update_check.checked_at = Some(Instant::now());
        update_check.candidate.clone_from(&candidate);
        Ok(candidate.unwrap_or(current))
    }

    fn activate_dynamic_delivery(&self, delivery: &ToolDelivery) -> Result<()> {
        if delivery.tool != NativeToolId::YtDlp
            || self
                .0
                .catalog
                .current(NativeToolId::YtDlp)
                .is_some_and(|builtin| builtin.version == delivery.version)
        {
            return Ok(());
        }
        crate::update::persist(&self.0.root, delivery)?;
        let mut dynamic = self
            .0
            .dynamic_ytdlp
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        dynamic.retain(|candidate| candidate.version != delivery.version);
        dynamic.push(delivery.clone());
        dynamic.sort_by(|left, right| right.version.cmp(&left.version));
        Ok(())
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

    fn quarantine_invalid_install(&self, target: &Path, delivery: &ToolDelivery) -> Result<()> {
        require_directory(target).map_err(|_| NativeToolError::InvalidInstall)?;
        let quarantine_root = ensure_direct_child(&self.0.root, ".quarantine")?;
        let quarantine = quarantine_root.join(format!(
            "{}-{}-{}",
            delivery.tool.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::rename(target, quarantine).map_err(|_| NativeToolError::StoreUnavailable)
    }

    fn reconcile_dynamic_ytdlp_versions(&self) {
        let retired = {
            let Ok(mut dynamic) = self.0.dynamic_ytdlp.lock() else {
                return;
            };
            if dynamic.len() <= RETAINED_DYNAMIC_YTDLP_RELEASES {
                return;
            }
            dynamic.split_off(RETAINED_DYNAMIC_YTDLP_RELEASES)
        };
        for delivery in retired {
            let target = self.version_path(&delivery);
            let retired_install = match fs::symlink_metadata(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Ok(metadata) if metadata.is_dir() => {
                    if receipt::validate_integrity(
                        &target,
                        &delivery,
                        &CancellationToken::default(),
                    )
                    .is_ok()
                    {
                        let Ok(trash_root) = ensure_direct_child(&self.0.root, ".trash") else {
                            continue;
                        };
                        let trash = trash_root.join(format!(
                            "{}-{}-{}",
                            delivery.tool.as_str(),
                            delivery.version,
                            Uuid::now_v7()
                        ));
                        fs::rename(&target, &trash)
                            .map_err(|_| NativeToolError::StoreUnavailable)
                            .and_then(|()| {
                                remove_exact_tree(&trash, &receipt::allowed_tree(&delivery))
                            })
                    } else {
                        self.quarantine_invalid_install(&target, &delivery)
                    }
                }
                Ok(_) | Err(_) => Err(NativeToolError::InvalidInstall),
            };
            if retired_install.is_ok() {
                let _ = crate::update::remove_persisted(&self.0.root, &delivery);
            }
        }
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

        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        assert_eq!(
            manager.status(NativeToolId::YtDlp).state,
            NativeToolState::Installed
        );
        let quarantined = fs::read_dir(temp.path().join(".quarantine"))
            .unwrap()
            .collect::<std::io::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(quarantined.len(), 1);
        assert_eq!(
            fs::read(quarantined[0].path().join("bin/yt-dlp.exe")).unwrap(),
            b"modified"
        );
    }

    #[test]
    fn media_tool_availability_matches_the_reviewed_platform_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = if crate::catalog::current_platform() == "windows-x86_64" {
            manager(&temp, coordinator.clone())
        } else {
            NativeToolManager::with_parts(
                temp.path(),
                coordinator.clone(),
                DeliveryCatalog::builtin().unwrap(),
                Arc::new(MemoryFetcher(HashMap::new())),
                Arc::new(NoUpdateResolver),
            )
            .unwrap()
        };
        let status = manager.status(NativeToolId::MediaTools).state;
        let result = manager.install(
            NativeToolId::MediaTools,
            &CancellationToken::default(),
            &|_| {},
        );
        if crate::catalog::current_platform() == "windows-x86_64" {
            assert_eq!(status, NativeToolState::Missing);
            assert_eq!(result, Err(NativeToolError::Network));
        } else {
            assert_eq!(status, NativeToolState::Unavailable);
            assert_eq!(result, Err(NativeToolError::DeliveryUnavailable));
        }
        assert_eq!(coordinator.0.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn immutable_ytdlp_update_publishes_beside_the_active_lease_and_survives_restart() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (catalog, base_fetcher) = fixture_catalog();
        let base = catalog.current(NativeToolId::YtDlp).unwrap().clone();
        let updated_bytes = b"updated-verified-tool";
        let updated_notices = [
            b"updated-license".as_slice(),
            b"updated-third-party".as_slice(),
        ];
        let updated = updated_ytdlp(&base, updated_bytes, &updated_notices);
        let mut files = base_fetcher.0.clone();
        files.insert(updated.source_url.clone(), updated_bytes.to_vec());
        for (notice, contents) in updated.notices.iter().zip(updated_notices) {
            files.insert(notice.source_url.clone(), contents.to_vec());
        }
        let base_manager = NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            catalog,
            Arc::new(MemoryFetcher(files.clone())),
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        base_manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        drop(base_manager);

        let resolver = Arc::new(SequenceResolver {
            responses: Mutex::new(vec![Ok(updated.clone())]),
            calls: AtomicUsize::new(0),
        });
        let manager = NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            catalog,
            Arc::new(MemoryFetcher(files.clone())),
            resolver.clone(),
        )
        .unwrap();
        let active = manager
            .resolve(NativeToolId::YtDlp, &CancellationToken::default())
            .unwrap();
        assert_eq!(active.version(), base.version);
        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        assert_eq!(resolver.calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            manager.status(NativeToolId::YtDlp).version,
            Some(updated.version.clone())
        );
        assert_eq!(active.version(), base.version);
        assert_eq!(coordinator.0.load(Ordering::Relaxed), 1);
        drop(active);
        drop(manager);

        let reopened = NativeToolManager::with_parts(
            temp.path(),
            coordinator,
            catalog,
            Arc::new(MemoryFetcher(files)),
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        let lease = reopened
            .resolve(NativeToolId::YtDlp, &CancellationToken::default())
            .unwrap();
        assert_eq!(lease.version(), updated.version);
    }

    #[test]
    fn startup_retains_only_two_dynamic_ytdlp_rollback_records() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (catalog, fetcher) = fixture_catalog();
        let initial = NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            catalog,
            fetcher.clone(),
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        drop(initial);

        let base = catalog.current(NativeToolId::YtDlp).unwrap();
        for version in ["2026.08.10", "2026.08.11", "2026.08.12"] {
            let mut delivery = updated_ytdlp(base, b"tool", &[b"license", b"third-party"]);
            delivery.version = version.to_string();
            delivery.source_url = format!(
                "https://github.com/yt-dlp/yt-dlp/releases/download/{version}/{}",
                delivery.asset
            );
            crate::update::persist(temp.path(), &delivery).unwrap();
        }

        let reopened = NativeToolManager::with_parts(
            temp.path(),
            coordinator,
            catalog,
            fetcher,
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        assert_eq!(reopened.0.dynamic_ytdlp.lock().unwrap().len(), 2);
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            2
        );
        assert_eq!(
            reopened.status(NativeToolId::YtDlp).available_version,
            Some("2026.08.12".to_string())
        );
    }
}
