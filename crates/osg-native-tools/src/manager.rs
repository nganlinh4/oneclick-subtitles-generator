use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize as TestAtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::archive::{install_artifact, set_permissions};
use crate::catalog::{DeliveryCatalog, ExecutableRole, NativeToolId, ToolDelivery, catalog};
use crate::download::{FileFetcher, HttpFileFetcher, RemoteFile};
use crate::path_security::{
    acquire_store_lock, cleanup_empty_work_tree, ensure_direct_child, initialize_store,
    remove_owned_tree_subset, require_directory, resolve_owned,
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
    verified_installs: Mutex<HashMap<(NativeToolId, String), receipt::InstallIdentity>>,
    #[cfg(test)]
    force_cleanup_failure: AtomicBool,
    #[cfg(test)]
    fail_removal_rename_number: TestAtomicUsize,
    #[cfg(test)]
    remove_before_guard_hook: Mutex<Option<Arc<RemoveBeforeGuardHook>>>,
    #[cfg(test)]
    removal_rename_attempts: Mutex<Vec<String>>,
    activity: Mutex<ActivityState>,
}

const YTDLP_UPDATE_CHECK_INTERVAL: Duration = Duration::from_mins(30);
const RETAINED_DYNAMIC_YTDLP_RELEASES: usize = 2;
const MAX_VERIFIED_INSTALLS: usize = 128;
const MAX_TRASH_GC_ENTRIES: usize = 128;

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

#[derive(Debug, Default)]
struct TrashCleanupReport {
    scan_complete: bool,
    unresolved: HashSet<(NativeToolId, String)>,
}

impl TrashCleanupReport {
    fn can_forget(&self, delivery: &ToolDelivery) -> bool {
        self.scan_complete
            && !self
                .unresolved
                .contains(&(delivery.tool, delivery.version.clone()))
    }
}

#[cfg(test)]
#[derive(Debug)]
struct RemoveBeforeGuardHook {
    entered: std::sync::Barrier,
    resume: std::sync::Barrier,
}

#[cfg(test)]
impl RemoveBeforeGuardHook {
    fn new() -> Self {
        Self {
            entered: std::sync::Barrier::new(2),
            resume: std::sync::Barrier::new(2),
        }
    }
}

#[cfg(test)]
fn should_fail_removal_rename(inner: &ManagerInner, completed: u64) -> bool {
    usize::try_from(completed).is_ok_and(|forced_number| {
        inner
            .fail_removal_rename_number
            .compare_exchange(
                forced_number,
                0,
                AtomicOrdering::AcqRel,
                AtomicOrdering::Acquire,
            )
            .is_ok()
    })
}

#[cfg(not(test))]
const fn should_fail_removal_rename(_: &ManagerInner, _: u64) -> bool {
    false
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
        Self::with_parts_config(root, coordinator, catalog, fetcher, ytdlp_releases, false)
    }

    fn with_parts_config(
        root: &Path,
        coordinator: Arc<dyn RuntimeCoordinator>,
        catalog: &'static DeliveryCatalog,
        fetcher: Arc<dyn FileFetcher>,
        ytdlp_releases: Arc<dyn YtDlpReleaseResolver>,
        force_startup_cleanup_failure: bool,
    ) -> Result<Self> {
        #[cfg(not(test))]
        let _ = force_startup_cleanup_failure;
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
            verified_installs: Mutex::new(HashMap::new()),
            #[cfg(test)]
            force_cleanup_failure: AtomicBool::new(force_startup_cleanup_failure),
            #[cfg(test)]
            fail_removal_rename_number: TestAtomicUsize::new(0),
            #[cfg(test)]
            remove_before_guard_hook: Mutex::new(None),
            #[cfg(test)]
            removal_rename_attempts: Mutex::new(Vec::new()),
            activity: Mutex::new(ActivityState::default()),
        }));
        let trash_cleanup = manager.cleanup_owned_trash();
        manager.reconcile_dynamic_ytdlp_versions(&trash_cleanup);
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
                if self.status_integrity_is_valid(&target, &delivery) {
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

    #[must_use]
    pub fn delivery_available(&self, tool: NativeToolId) -> bool {
        self.current_delivery(tool).is_some()
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
                    Ok(identity) => {
                        self.remember_verified(&delivery, identity)?;
                        self.activate_dynamic_delivery(&delivery)?;
                        return Ok(self.status(tool));
                    }
                    Err(NativeToolError::Cancelled) => return Err(NativeToolError::Cancelled),
                    Err(_) => {
                        self.forget_verified(&delivery);
                        self.quarantine_invalid_install(&target, &delivery)?;
                    }
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
        let _ = receipt::validate_integrity(&staging, &delivery, cancellation)?;

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
        let identity = receipt::validate_integrity(&target, &delivery, cancellation)?;
        self.remember_verified(&delivery, identity)?;
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
        #[cfg(test)]
        self.wait_at_remove_before_guard_hook();
        let _operation = self.begin_operation(tool)?;
        let current = self
            .current_delivery(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        cancellation.check()?;
        let deliveries = self.owned_deliveries(tool)?;
        let mut installed = Vec::new();
        for delivery in deliveries {
            cancellation.check()?;
            let target = self.version_path(&delivery);
            match fs::symlink_metadata(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => return Ok(RemovalOutcome::PreservedModified),
                Err(_) => return Err(NativeToolError::StoreUnavailable),
            }
            if let Err(error) = receipt::validate_integrity(&target, &delivery, cancellation) {
                return match error {
                    NativeToolError::Cancelled => Err(error),
                    _ => Ok(RemovalOutcome::PreservedModified),
                };
            }
            installed.push((delivery, target));
        }
        if installed.is_empty() {
            self.forget_verified_tool(tool);
            let trash_cleanup = self.cleanup_owned_trash();
            let remove_persisted = self.dynamic_provenance_is_reclaimed(tool, &trash_cleanup);
            self.remove_dynamic_state(tool, remove_persisted);
            return Ok(RemovalOutcome::Missing);
        }

        self.0.coordinator.quiesce(tool)?;
        cancellation.check()?;
        let trash_parent = self.0.root.join(".trash");
        require_directory(&trash_parent)?;
        // Move the selected delivery last. Any earlier rename failure therefore
        // leaves the active runtime available for the desktop rollback path.
        installed.sort_by_key(|(delivery, _)| delivery.version == current.version);
        let total = u64::try_from(installed.len()).map_err(|_| NativeToolError::InvalidInstall)?;
        progress.on_progress(OperationProgress::new(OperationPhase::Removing, 0, total));
        cancellation.check()?;
        let mut committed = Vec::with_capacity(installed.len());
        for (completed, (delivery, target)) in (1_u64..).zip(installed) {
            #[cfg(test)]
            self.0
                .removal_rename_attempts
                .lock()
                .expect("removal attempt recorder must remain available")
                .push(delivery.version.clone());
            let trash = trash_parent.join(format!(
                "{}-{}-{}",
                tool.as_str(),
                delivery.version,
                Uuid::now_v7()
            ));
            let forced_failure = should_fail_removal_rename(&self.0, completed);
            if forced_failure || fs::rename(&target, &trash).is_err() {
                for (_, original, staged) in committed.iter().rev() {
                    let _ = fs::rename(staged, original);
                }
                return Err(NativeToolError::StoreUnavailable);
            }
            self.forget_verified(&delivery);
            committed.push((delivery, target, trash));
        }

        // The validated renames above are the logical commit. Everything after
        // this point is idempotent, best-effort reclamation; a locked file must
        // not turn a completed uninstall into a false failure.
        progress.on_progress(OperationProgress::new(
            OperationPhase::Removing,
            total,
            total,
        ));
        let mut cleanup_complete = true;
        for (delivery, _, trash) in &committed {
            if self.cleanup_owned_trash_delivery(trash, delivery).is_err() {
                cleanup_complete = false;
            }
        }
        let remove_persisted = cleanup_complete && {
            let trash_cleanup = self.cleanup_owned_trash();
            self.dynamic_provenance_is_reclaimed(tool, &trash_cleanup)
        };
        self.remove_dynamic_state(tool, remove_persisted);
        Ok(RemovalOutcome::Removed)
    }

    pub fn resolve(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease> {
        self.resolve_selected(tool, cancellation, |manager| {
            manager
                .current_delivery(tool)
                .ok_or(NativeToolError::DeliveryUnavailable)
        })
    }

    /// Resolves one exact manager-owned version without consulting the
    /// currently selected delivery. This is intended for trusted rollback
    /// paths that must not activate a newer delivery rejected by a consumer.
    pub fn resolve_version(
        &self,
        tool: NativeToolId,
        version: &str,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease> {
        self.resolve_selected(tool, cancellation, |manager| {
            manager
                .owned_deliveries(tool)?
                .into_iter()
                .find(|delivery| delivery.version == version)
                .ok_or(NativeToolError::DeliveryUnavailable)
        })
    }

    fn resolve_selected(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        select: impl FnOnce(&Self) -> Result<ToolDelivery>,
    ) -> Result<ToolLease> {
        let delivery = {
            let mut activity = self
                .0
                .activity
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            if activity.operations.contains(&tool) {
                return Err(NativeToolError::OperationInProgress(tool));
            }
            // Select the delivery while holding the same boundary used to
            // begin installs/removals. The lease therefore always protects
            // the requested delivery at its atomic acquisition point.
            let delivery = select(self)?;
            *activity.leases.entry(tool).or_default() += 1;
            delivery
        };
        let mut lease = ToolLease {
            inner: Arc::clone(&self.0),
            tool,
            version: delivery.version.clone(),
            executables: HashMap::new(),
            active: true,
        };
        let root = self.version_path(&delivery);
        let identity = receipt::validate_integrity(&root, &delivery, cancellation)?;
        self.remember_verified(&delivery, identity)?;
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

    #[cfg(test)]
    fn wait_at_remove_before_guard_hook(&self) {
        let hook = self
            .0
            .remove_before_guard_hook
            .lock()
            .expect("remove interleaving hook must remain available")
            .take();
        if let Some(hook) = hook {
            hook.entered.wait();
            hook.resume.wait();
        }
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

    fn owned_deliveries(&self, tool: NativeToolId) -> Result<Vec<ToolDelivery>> {
        let mut deliveries = self.0.catalog.releases(tool).to_vec();
        if tool == NativeToolId::YtDlp {
            let dynamic = self
                .0
                .dynamic_ytdlp
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            for candidate in dynamic.iter() {
                if let Some(existing) = deliveries
                    .iter()
                    .find(|delivery| delivery.version == candidate.version)
                {
                    if existing != candidate {
                        return Err(NativeToolError::InvalidInstall);
                    }
                } else {
                    deliveries.push(candidate.clone());
                }
            }
        }
        deliveries.sort_by(|left, right| right.version.cmp(&left.version));
        Ok(deliveries)
    }

    fn status_integrity_is_valid(&self, target: &Path, delivery: &ToolDelivery) -> bool {
        let key = (delivery.tool, delivery.version.clone());
        let cached = self
            .0
            .verified_installs
            .lock()
            .ok()
            .and_then(|verified| verified.get(&key).cloned());
        if cached
            .as_ref()
            .is_some_and(|identity| receipt::identity_matches(target, delivery, identity))
        {
            return true;
        }
        if let Ok(identity) =
            receipt::validate_integrity(target, delivery, &CancellationToken::default())
        {
            self.remember_verified(delivery, identity).is_ok()
        } else {
            self.forget_verified(delivery);
            false
        }
    }

    fn remember_verified(
        &self,
        delivery: &ToolDelivery,
        identity: receipt::InstallIdentity,
    ) -> Result<()> {
        let mut verified = self
            .0
            .verified_installs
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        let key = (delivery.tool, delivery.version.clone());
        if !verified.contains_key(&key) && verified.len() >= MAX_VERIFIED_INSTALLS {
            verified.clear();
        }
        verified.insert(key, identity);
        Ok(())
    }

    fn forget_verified(&self, delivery: &ToolDelivery) {
        if let Ok(mut verified) = self.0.verified_installs.lock() {
            verified.remove(&(delivery.tool, delivery.version.clone()));
        }
    }

    fn forget_verified_tool(&self, tool: NativeToolId) {
        if let Ok(mut verified) = self.0.verified_installs.lock() {
            verified.retain(|(candidate, _), _| *candidate != tool);
        }
    }

    fn remove_dynamic_state(&self, tool: NativeToolId, remove_persisted: bool) {
        if tool != NativeToolId::YtDlp {
            return;
        }
        let removed = self
            .0
            .dynamic_ytdlp
            .lock()
            .map(|mut dynamic| std::mem::take(&mut *dynamic))
            .unwrap_or_default();
        if remove_persisted {
            for delivery in removed {
                let _ = crate::update::remove_persisted(&self.0.root, &delivery);
            }
        }
    }

    fn dynamic_provenance_is_reclaimed(
        &self,
        tool: NativeToolId,
        trash_cleanup: &TrashCleanupReport,
    ) -> bool {
        if tool != NativeToolId::YtDlp {
            return true;
        }
        self.0.dynamic_ytdlp.lock().is_ok_and(|dynamic| {
            dynamic
                .iter()
                .all(|delivery| trash_cleanup.can_forget(delivery))
        })
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

    fn move_verified_to_trash(&self, target: &Path, delivery: &ToolDelivery) -> Result<PathBuf> {
        let trash_root = ensure_direct_child(&self.0.root, ".trash")?;
        let trash = trash_root.join(format!(
            "{}-{}-{}",
            delivery.tool.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::rename(target, &trash).map_err(|_| NativeToolError::StoreUnavailable)?;
        self.forget_verified(delivery);
        Ok(trash)
    }

    fn cleanup_owned_trash_delivery(&self, trash: &Path, delivery: &ToolDelivery) -> Result<()> {
        let trash_root = self.0.root.join(".trash");
        if trash.parent() != Some(trash_root.as_path()) {
            return Err(NativeToolError::InvalidInstall);
        }
        #[cfg(test)]
        if self
            .0
            .force_cleanup_failure
            .swap(false, AtomicOrdering::AcqRel)
        {
            return Err(NativeToolError::StoreUnavailable);
        }
        let files = crate::path_security::collect_regular_files(trash)?;
        if !files.is_empty() && !receipt::ownership_matches(trash, delivery) {
            return Err(NativeToolError::InvalidInstall);
        }
        remove_owned_tree_subset(
            trash,
            &receipt::allowed_tree(delivery),
            receipt::RECEIPT_NAME,
        )
    }

    fn cleanup_owned_trash(&self) -> TrashCleanupReport {
        let mut report = TrashCleanupReport {
            scan_complete: true,
            unresolved: HashSet::new(),
        };
        let mut deliveries = Vec::new();
        for tool in NativeToolId::ALL {
            let Ok(mut owned) = self.owned_deliveries(tool) else {
                report.scan_complete = false;
                return report;
            };
            deliveries.append(&mut owned);
        }
        let trash_root = self.0.root.join(".trash");
        let Ok(mut entries) = fs::read_dir(&trash_root) else {
            report.scan_complete = false;
            return report;
        };
        for _ in 0..MAX_TRASH_GC_ENTRIES {
            let Some(entry) = entries.next() else {
                return report;
            };
            let Ok(entry) = entry else {
                report.scan_complete = false;
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let mut matching = deliveries.iter().filter(|delivery| {
                let prefix = format!("{}-{}-", delivery.tool.as_str(), delivery.version);
                name.strip_prefix(&prefix).is_some_and(|suffix| {
                    Uuid::parse_str(suffix)
                        .is_ok_and(|identifier| identifier.get_version_num() == 7)
                })
            });
            let Some(delivery) = matching.next() else {
                continue;
            };
            if matching.next().is_some() {
                report.scan_complete = false;
                continue;
            }
            if self
                .cleanup_owned_trash_delivery(&entry.path(), delivery)
                .is_err()
            {
                report
                    .unresolved
                    .insert((delivery.tool, delivery.version.clone()));
            }
        }

        // Reading one additional entry is enough to prove the bounded scan
        // was capped. Do not retire any dynamic provenance while an owned
        // trash entry may still exist beyond the boundary.
        if entries.next().is_some() {
            report.scan_complete = false;
        }
        report
    }

    fn reconcile_dynamic_ytdlp_versions(&self, trash_cleanup: &TrashCleanupReport) {
        let loaded = {
            let Ok(dynamic) = self.0.dynamic_ytdlp.lock() else {
                return;
            };
            dynamic.clone()
        };
        let mut retained = Vec::new();
        let mut retained_valid = 0_usize;
        for delivery in loaded {
            let target = self.version_path(&delivery);
            match fs::symlink_metadata(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.forget_verified(&delivery);
                    if trash_cleanup.can_forget(&delivery) {
                        let _ = crate::update::remove_persisted(&self.0.root, &delivery);
                    }
                }
                Ok(metadata) if metadata.is_dir() => {
                    match receipt::validate_integrity(
                        &target,
                        &delivery,
                        &CancellationToken::default(),
                    ) {
                        Ok(identity) if retained_valid < RETAINED_DYNAMIC_YTDLP_RELEASES => {
                            let _ = self.remember_verified(&delivery, identity);
                            retained_valid += 1;
                            retained.push(delivery);
                        }
                        Ok(_) => match self.move_verified_to_trash(&target, &delivery) {
                            Ok(trash) => {
                                if self.cleanup_owned_trash_delivery(&trash, &delivery).is_ok()
                                    && trash_cleanup.can_forget(&delivery)
                                {
                                    let _ =
                                        crate::update::remove_persisted(&self.0.root, &delivery);
                                }
                            }
                            Err(_) => retained.push(delivery),
                        },
                        Err(_) => {
                            self.forget_verified(&delivery);
                            if self.quarantine_invalid_install(&target, &delivery).is_ok() {
                                if trash_cleanup.can_forget(&delivery) {
                                    let _ =
                                        crate::update::remove_persisted(&self.0.root, &delivery);
                                }
                            } else {
                                retained.push(delivery);
                            }
                        }
                    }
                }
                Ok(_) | Err(_) => retained.push(delivery),
            }
        }
        retained.sort_by(|left, right| right.version.cmp(&left.version));
        if let Ok(mut dynamic) = self.0.dynamic_ytdlp.lock() {
            *dynamic = retained;
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
    use std::collections::VecDeque;
    use std::process::Command;
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
    struct LifecycleConsumer {
        failures: Mutex<VecDeque<bool>>,
        observed_versions: Mutex<Vec<Option<String>>>,
        active: Mutex<Option<ToolLease>>,
    }

    impl LifecycleConsumer {
        fn new(initial: ToolLease, failures: impl IntoIterator<Item = bool>) -> Self {
            Self {
                failures: Mutex::new(failures.into_iter().collect()),
                observed_versions: Mutex::new(Vec::new()),
                active: Mutex::new(Some(initial)),
            }
        }

        fn activate(&self, lease: ToolLease) -> Result<()> {
            let previous = self.active.lock().unwrap().replace(lease);
            self.record_refresh()?;
            if self.failures.lock().unwrap().pop_front().unwrap_or(false) {
                *self.active.lock().unwrap() = previous;
                self.record_refresh()?;
                return Err(NativeToolError::InvalidInstall);
            }
            drop(previous);
            Ok(())
        }

        fn deactivate(&self) -> Option<String> {
            let previous = self.active.lock().unwrap().take();
            let version = previous.as_ref().map(|lease| lease.version().to_owned());
            self.record_refresh().unwrap();
            drop(previous);
            version
        }

        fn restore_exact(&self, manager: &NativeToolManager, version: &str) -> Result<()> {
            let lease = match manager.resolve_version(
                NativeToolId::YtDlp,
                version,
                &CancellationToken::default(),
            ) {
                Ok(lease) => lease,
                Err(error) => {
                    self.active.lock().unwrap().take();
                    self.record_refresh()?;
                    return Err(error);
                }
            };
            self.active.lock().unwrap().replace(lease);
            if self.record_refresh().is_err() {
                self.active.lock().unwrap().take();
                let _ = self.record_refresh();
                return Err(NativeToolError::InvalidInstall);
            }
            Ok(())
        }

        fn record_refresh(&self) -> Result<()> {
            let version = self
                .active
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?
                .as_ref()
                .map(|lease| lease.version().to_owned());
            self.observed_versions
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?
                .push(version);
            Ok(())
        }

        fn version(&self) -> Option<String> {
            self.active
                .lock()
                .unwrap()
                .as_ref()
                .map(|lease| lease.version().to_owned())
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
    fn repeated_status_uses_identity_cache_but_removal_rehashes_before_commit() {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, Arc::new(TestCoordinator::default()));
        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();

        receipt::reset_hashed_bytes();
        assert!(manager.status(NativeToolId::YtDlp).installed);
        assert!(manager.status(NativeToolId::YtDlp).installed);
        assert_eq!(receipt::hashed_bytes(), 0);

        manager.0.verified_installs.lock().unwrap().clear();
        assert!(manager.status(NativeToolId::YtDlp).installed);
        let first_status_hash = receipt::hashed_bytes();
        assert!(first_status_hash > 0);
        assert!(manager.status(NativeToolId::YtDlp).installed);
        assert_eq!(receipt::hashed_bytes(), first_status_hash);

        let delivery = manager.0.catalog.current(NativeToolId::YtDlp).unwrap();
        let cached = manager
            .0
            .verified_installs
            .lock()
            .unwrap()
            .get(&(NativeToolId::YtDlp, delivery.version.clone()))
            .unwrap()
            .clone();
        let mut replacement_metadata = delivery.clone();
        replacement_metadata.source_url = "https://example.invalid/tampered".to_owned();
        assert!(!receipt::identity_matches(
            &manager.version_path(delivery),
            &replacement_metadata,
            &cached
        ));

        receipt::reset_hashed_bytes();
        assert_eq!(
            manager
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert!(receipt::hashed_bytes() > 0);
    }

    #[test]
    fn exact_version_resolution_verifies_owned_delivery_and_balances_failed_leases() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
        assert_eq!(manager.current_delivery(NativeToolId::YtDlp), Some(updated));

        let lease = manager
            .resolve_version(
                NativeToolId::YtDlp,
                &base.version,
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(lease.version(), base.version);
        assert_eq!(
            manager
                .0
                .activity
                .lock()
                .unwrap()
                .leases
                .get(&NativeToolId::YtDlp),
            Some(&1)
        );
        drop(lease);
        assert!(manager.0.activity.lock().unwrap().leases.is_empty());

        fs::write(
            manager.version_path(&base).join("bin/yt-dlp.exe"),
            b"modified-exact-version",
        )
        .unwrap();
        assert!(matches!(
            manager.resolve_version(
                NativeToolId::YtDlp,
                &base.version,
                &CancellationToken::default(),
            ),
            Err(NativeToolError::InvalidInstall)
        ));
        assert!(matches!(
            manager.resolve_version(
                NativeToolId::YtDlp,
                "2099.01.01",
                &CancellationToken::default(),
            ),
            Err(NativeToolError::DeliveryUnavailable)
        ));
        assert!(manager.0.activity.lock().unwrap().leases.is_empty());
    }

    #[test]
    fn rejected_update_and_failed_removal_restore_exact_previous_consumer_version() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
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

        let executable = b"rejected-updated-tool";
        let notices = [
            b"rejected-license".as_slice(),
            b"rejected-third-party".as_slice(),
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
        let active = manager
            .resolve_version(
                NativeToolId::YtDlp,
                &base.version,
                &CancellationToken::default(),
            )
            .unwrap();
        let consumer = LifecycleConsumer::new(active, [true]);

        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        let rejected = manager
            .resolve(NativeToolId::YtDlp, &CancellationToken::default())
            .unwrap();
        assert_eq!(rejected.version(), updated.version);
        assert_eq!(
            consumer.activate(rejected),
            Err(NativeToolError::InvalidInstall)
        );
        assert_eq!(consumer.version().as_deref(), Some(base.version.as_str()));
        assert_eq!(
            manager.current_delivery(NativeToolId::YtDlp),
            Some(updated.clone())
        );

        let previous_version = consumer.deactivate().unwrap();
        manager
            .0
            .fail_removal_rename_number
            .store(2, AtomicOrdering::Release);
        assert_eq!(
            manager.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {}),
            Err(NativeToolError::StoreUnavailable)
        );
        consumer.restore_exact(&manager, &previous_version).unwrap();
        assert_eq!(consumer.version().as_deref(), Some(base.version.as_str()));
        assert_eq!(
            *consumer.observed_versions.lock().unwrap(),
            vec![
                Some(updated.version),
                Some(base.version.clone()),
                None,
                Some(base.version),
            ]
        );
    }

    #[test]
    fn exact_consumer_rollback_failure_leaves_no_lease_and_refreshes_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (manager, base, _) = manager_with_ytdlp_update(&temp, coordinator);
        let active = manager
            .resolve_version(
                NativeToolId::YtDlp,
                &base.version,
                &CancellationToken::default(),
            )
            .unwrap();
        let consumer = LifecycleConsumer::new(active, []);
        let previous_version = consumer.deactivate().unwrap();
        fs::write(
            manager.version_path(&base).join("bin/yt-dlp.exe"),
            b"corrupt-before-rollback",
        )
        .unwrap();

        assert_eq!(
            consumer.restore_exact(&manager, &previous_version),
            Err(NativeToolError::InvalidInstall)
        );
        assert_eq!(consumer.version(), None);
        assert_eq!(
            *consumer.observed_versions.lock().unwrap(),
            vec![None, None]
        );
        assert!(manager.0.activity.lock().unwrap().leases.is_empty());
    }

    #[test]
    fn remove_reconciles_all_owned_versions_but_preserves_unowned_trees() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
        let unowned = temp
            .path()
            .join("tools/yt-dlp/versions/unowned-local-build");
        fs::create_dir(&unowned).unwrap();
        fs::write(unowned.join("keep.txt"), b"user-owned").unwrap();

        assert!(manager.version_path(&base).is_dir());
        assert!(manager.version_path(&updated).is_dir());
        assert_eq!(
            manager
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert!(!manager.version_path(&base).exists());
        assert!(!manager.version_path(&updated).exists());
        assert!(unowned.join("keep.txt").is_file());
        assert!(manager.0.dynamic_ytdlp.lock().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn modified_rollback_version_aborts_removal_before_any_owned_tree_moves() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
        fs::write(
            manager.version_path(&base).join("bin/yt-dlp.exe"),
            b"modified-rollback",
        )
        .unwrap();

        assert_eq!(
            manager
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
                .unwrap(),
            RemovalOutcome::PreservedModified
        );
        assert!(manager.version_path(&base).is_dir());
        assert!(manager.version_path(&updated).is_dir());
        assert_eq!(manager.0.dynamic_ytdlp.lock().unwrap().len(), 1);
    }

    #[test]
    fn failed_later_rename_rolls_back_earlier_staging_and_preserves_active_delivery() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (manager, base, updated) = manager_with_ytdlp_update(&temp, coordinator);
        manager
            .0
            .fail_removal_rename_number
            .store(2, AtomicOrdering::Release);

        assert_eq!(
            manager.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {}),
            Err(NativeToolError::StoreUnavailable)
        );
        assert!(manager.version_path(&base).is_dir());
        assert!(manager.version_path(&updated).is_dir());
        assert!(manager.status(NativeToolId::YtDlp).installed);
        assert_eq!(manager.0.dynamic_ytdlp.lock().unwrap().len(), 1);
        assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 0);
    }

    #[test]
    fn removal_selects_current_delivery_after_guard_and_stages_it_last() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
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

        let executable = b"concurrent-updated-tool";
        let notices = [
            b"concurrent-license".as_slice(),
            b"concurrent-third-party".as_slice(),
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
        let hook = Arc::new(RemoveBeforeGuardHook::new());
        *manager.0.remove_before_guard_hook.lock().unwrap() = Some(Arc::clone(&hook));
        manager
            .0
            .fail_removal_rename_number
            .store(2, AtomicOrdering::Release);

        let removing = manager.clone();
        let removal = std::thread::spawn(move || {
            removing.remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
        });
        hook.entered.wait();
        manager
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        assert_eq!(
            manager.current_delivery(NativeToolId::YtDlp),
            Some(updated.clone())
        );
        hook.resume.wait();

        assert_eq!(
            removal.join().unwrap(),
            Err(NativeToolError::StoreUnavailable)
        );
        assert_eq!(
            *manager.0.removal_rename_attempts.lock().unwrap(),
            vec![base.version.clone(), updated.version.clone()]
        );
        assert!(manager.version_path(&base).is_dir());
        assert!(manager.version_path(&updated).is_dir());
        assert_eq!(manager.current_delivery(NativeToolId::YtDlp), Some(updated));
        assert!(manager.status(NativeToolId::YtDlp).installed);
    }

    #[test]
    fn post_commit_cleanup_failure_stays_successful_and_safe_startup_gc_retries() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let managed = manager(&temp, coordinator.clone());
        managed
            .install(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
            .unwrap();
        let delivery = managed.0.catalog.current(NativeToolId::YtDlp).unwrap();
        let unowned = temp.path().join(".trash").join(format!(
            "{}-{}-{}",
            delivery.tool.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::create_dir(&unowned).unwrap();
        fs::write(unowned.join("foreign.txt"), b"preserve").unwrap();
        managed
            .0
            .force_cleanup_failure
            .store(true, AtomicOrdering::Release);

        assert_eq!(
            managed
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert!(!managed.version_path(delivery).exists());
        assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 2);
        drop(managed);

        let reopened = manager(&temp, coordinator);
        assert_eq!(
            reopened.status(NativeToolId::YtDlp).state,
            NativeToolState::Missing
        );
        assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 1);
        assert_eq!(fs::read(unowned.join("foreign.txt")).unwrap(), b"preserve");
    }

    #[test]
    fn dynamic_receipt_is_retained_until_failed_trash_cleanup_recovers_on_restart() {
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
        let updated = updated_ytdlp(base, b"tool", &[b"license", b"third-party"]);
        crate::update::persist(temp.path(), &updated).unwrap();
        publish_fixture_delivery(
            temp.path(),
            &updated,
            b"tool",
            &[b"license", b"third-party"],
        );
        let managed = NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            catalog,
            fetcher.clone(),
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        managed
            .0
            .force_cleanup_failure
            .store(true, AtomicOrdering::Release);

        assert_eq!(
            managed
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 1);
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            1
        );
        drop(managed);

        let still_locked = NativeToolManager::with_parts_config(
            temp.path(),
            coordinator.clone(),
            catalog,
            fetcher.clone(),
            Arc::new(NoUpdateResolver),
            true,
        )
        .unwrap();
        assert!(still_locked.0.dynamic_ytdlp.lock().unwrap().is_empty());
        assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 1);
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            1
        );
        drop(still_locked);

        let reopened = NativeToolManager::with_parts(
            temp.path(),
            coordinator,
            catalog,
            fetcher,
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        assert!(reopened.0.dynamic_ytdlp.lock().unwrap().is_empty());
        assert_eq!(fs::read_dir(temp.path().join(".trash")).unwrap().count(), 0);
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn capped_trash_scan_retains_dynamic_provenance_until_a_complete_retry() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let (catalog, fetcher) = fixture_catalog();
        let base = catalog.current(NativeToolId::YtDlp).unwrap();
        let updated = updated_ytdlp(base, b"tool", &[b"license", b"third-party"]);
        crate::update::persist(temp.path(), &updated).unwrap();
        publish_fixture_delivery(
            temp.path(),
            &updated,
            b"tool",
            &[b"license", b"third-party"],
        );
        let managed = NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            catalog,
            fetcher.clone(),
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        managed
            .0
            .force_cleanup_failure
            .store(true, AtomicOrdering::Release);
        assert_eq!(
            managed
                .remove(NativeToolId::YtDlp, &CancellationToken::default(), &|_| {})
                .unwrap(),
            RemovalOutcome::Removed
        );
        drop(managed);

        let trash_root = temp.path().join(".trash");
        let mut foreign = Vec::new();
        for index in 0..(MAX_TRASH_GC_ENTRIES + 32) {
            let path = trash_root.join(format!("foreign-before-cap-{index:03}"));
            fs::create_dir(&path).unwrap();
            foreign.push(path);
        }
        let capped = NativeToolManager::with_parts(
            temp.path(),
            coordinator.clone(),
            catalog,
            fetcher.clone(),
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        assert!(capped.0.dynamic_ytdlp.lock().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            1
        );
        drop(capped);

        for path in foreign {
            fs::remove_dir(path).unwrap();
        }
        let recovered = NativeToolManager::with_parts(
            temp.path(),
            coordinator,
            catalog,
            fetcher,
            Arc::new(NoUpdateResolver),
        )
        .unwrap();
        assert!(recovered.0.dynamic_ytdlp.lock().unwrap().is_empty());
        assert_eq!(fs::read_dir(trash_root).unwrap().count(), 0);
        assert_eq!(
            fs::read_dir(temp.path().join("tools/yt-dlp/deliveries"))
                .unwrap()
                .count(),
            0
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
    #[ignore = "downloads, executes, and removes the current official yt-dlp release"]
    fn live_ytdlp_installs_executes_reuses_and_removes() {
        live_tool_lifecycle(
            NativeToolId::YtDlp,
            &[(ExecutableRole::YtDlp, &["--version"], true)],
        );
    }

    #[test]
    #[ignore = "downloads, executes, and removes the reviewed Deno release"]
    fn live_deno_installs_executes_reuses_and_removes() {
        live_tool_lifecycle(
            NativeToolId::Deno,
            &[(ExecutableRole::Deno, &["--version"], false)],
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "downloads, executes, and removes the reviewed Windows FFmpeg release"]
    fn live_media_tools_install_execute_reuse_and_remove() {
        live_tool_lifecycle(
            NativeToolId::MediaTools,
            &[
                (ExecutableRole::Ffmpeg, &["-version"], false),
                (ExecutableRole::Ffprobe, &["-version"], false),
            ],
        );
    }

    fn live_tool_lifecycle(tool: NativeToolId, commands: &[(ExecutableRole, &[&str], bool)]) {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = NativeToolManager::new(temp.path(), coordinator.clone()).unwrap();
        let cancellation = CancellationToken::default();
        let progress = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&progress);
        let installed = manager
            .install(tool, &cancellation, &move |value| {
                observed.lock().unwrap().push(value);
            })
            .unwrap();
        assert_eq!(installed.state, NativeToolState::Installed);
        assert!(!progress.lock().unwrap().is_empty());

        let lease = manager.resolve(tool, &cancellation).unwrap();
        for (role, arguments, exact_version) in commands {
            let output = Command::new(lease.executable(*role).unwrap())
                .args(*arguments)
                .output()
                .unwrap();
            assert!(output.status.success());
            let stdout = String::from_utf8(output.stdout).unwrap();
            let stderr = String::from_utf8(output.stderr).unwrap();
            let version_output = format!("{stdout}\n{stderr}");
            if *exact_version {
                assert_eq!(version_output.trim(), lease.version());
            } else {
                assert!(version_output.contains(lease.version()));
                assert!(version_output.to_ascii_lowercase().contains(role.as_str()));
            }
        }
        drop(lease);

        progress.lock().unwrap().clear();
        let observed = Arc::clone(&progress);
        assert_eq!(
            manager
                .install(tool, &cancellation, &move |value| {
                    observed.lock().unwrap().push(value);
                })
                .unwrap()
                .state,
            NativeToolState::Installed
        );
        assert!(
            progress.lock().unwrap().is_empty(),
            "a verified current tool install must be reused without another download"
        );
        assert_eq!(
            manager.remove(tool, &cancellation, &|_| {}).unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(manager.status(tool).state, NativeToolState::Missing);
        assert_eq!(coordinator.0.load(Ordering::Relaxed), 2);
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
            publish_fixture_delivery(
                temp.path(),
                &delivery,
                b"tool",
                &[b"license", b"third-party"],
            );
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
