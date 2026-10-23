use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize as TestAtomicUsize};
use std::sync::{Arc, Mutex};

use osg_runtime_staging::RuntimeStagingAuthority;
use serde::Serialize;

use crate::catalog::{DeliveryCatalog, NativeToolId, ToolDelivery, catalog};
use crate::download::{FileFetcher, HttpFileFetcher};
use crate::path_security::{acquire_store_lock, ensure_direct_child, initialize_store};
use crate::receipt;
use crate::update::{GitHubYtDlpReleaseResolver, YtDlpReleaseResolver};
use crate::{NativeToolError, Result};

mod deliveries;
mod install;
mod lease;
mod removal;
#[cfg(test)]
mod tests;

pub use lease::ToolLease;

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
    staging_authority: RuntimeStagingAuthority,
    catalog: &'static DeliveryCatalog,
    fetcher: Arc<dyn FileFetcher>,
    coordinator: Arc<dyn RuntimeCoordinator>,
    ytdlp_releases: Arc<dyn YtDlpReleaseResolver>,
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

const RETAINED_DYNAMIC_YTDLP_RELEASES: usize = 2;
const MAX_VERIFIED_INSTALLS: usize = 128;
const MAX_TRASH_GC_ENTRIES: usize = 128;

#[derive(Debug, Default)]
struct ActivityState {
    operations: HashSet<NativeToolId>,
    leases: HashMap<NativeToolId, usize>,
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

    /// Creates a manager using the application's private crash-recovery authority.
    ///
    /// The authority journal is locked before archive or extraction directories are created, so a
    /// hard-killed installer cannot leave an unbounded full archive plus an unpacked copy behind.
    pub fn new_with_staging_authority(
        root: impl AsRef<Path>,
        coordinator: Arc<dyn RuntimeCoordinator>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        let catalog = DeliveryCatalog::builtin()?;
        let fetcher = Arc::new(HttpFileFetcher::new()?);
        let ytdlp_releases = Arc::new(GitHubYtDlpReleaseResolver::new()?);
        Self::with_parts_config_and_authority(
            root.as_ref(),
            coordinator,
            catalog,
            fetcher,
            ytdlp_releases,
            false,
            Some(staging_authority),
        )
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
        Self::with_parts_config_and_authority(
            root,
            coordinator,
            catalog,
            fetcher,
            ytdlp_releases,
            force_startup_cleanup_failure,
            None,
        )
    }

    fn with_parts_config_and_authority(
        root: &Path,
        coordinator: Arc<dyn RuntimeCoordinator>,
        catalog: &'static DeliveryCatalog,
        fetcher: Arc<dyn FileFetcher>,
        ytdlp_releases: Arc<dyn YtDlpReleaseResolver>,
        force_startup_cleanup_failure: bool,
        staging_authority: Option<RuntimeStagingAuthority>,
    ) -> Result<Self> {
        #[cfg(not(test))]
        let _ = force_startup_cleanup_failure;
        let root = initialize_store(root)?;
        let store_lock = acquire_store_lock(&root)?;
        let staging_authority = match staging_authority {
            Some(authority) => {
                authority
                    .reconcile_all()
                    .map_err(|_| NativeToolError::StoreUnavailable)?;
                authority
            }
            None => RuntimeStagingAuthority::prepare(&root.join(".runtime-staging-authority"))
                .map_err(|_| NativeToolError::StoreUnavailable)?,
        };
        refuse_unowned_large_work_trees(&root)?;
        let dynamic_ytdlp = crate::update::load_installed(&root, catalog.platform())?;
        let manager = Self(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            staging_authority,
            catalog,
            fetcher,
            coordinator,
            ytdlp_releases,
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
}

fn refuse_unowned_large_work_trees(root: &Path) -> Result<()> {
    for name in [".downloads", ".staging", ".quarantine"] {
        let work_root = ensure_direct_child(root, name)?;
        if fs::read_dir(&work_root)
            .map_err(|_| NativeToolError::StoreUnavailable)?
            .next()
            .is_some()
        {
            // Prefixes and UUIDs are not deletion authority. New entries have already been
            // reconciled through their private journal; anything left here predates that scheme or
            // is foreign and is therefore preserved for explicit inspection.
            return Err(NativeToolError::StoreUnavailable);
        }
    }
    Ok(())
}
