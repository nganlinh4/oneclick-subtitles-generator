use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::hash::Hash;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use crate::archive;
use crate::catalog::{
    DeliveryCatalog, DeliveryFile, EngineId, PackageCatalog, PackageDelivery, catalog,
};
use crate::download::{ArchiveFetcher, HttpArchiveFetcher, obtain};
use crate::path_security::{
    acquire_store_lock, cleanup_known_tree, collect_regular_files, ensure_direct_child,
    initialize_store, is_link_or_reparse, require_directory, require_regular_file, require_store,
    resolve_owned,
};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt;
use crate::speech_catalog::{SpeechDeliveryCatalog, SpeechPackageId, speech_catalog};
use crate::{CancellationToken, PackageError, Result};

const MIN_FREE_RESERVE_BYTES: u64 = 256 * 1024 * 1024;

/// Desktop integration must terminate and reap the engine's supervised worker
/// process tree before package publication or removal can continue.
pub trait RuntimeCoordinator: Send + Sync {
    fn quiesce(&self, engine: EngineId) -> Result<()>;
}

/// Desktop integration must terminate and reap every worker using the speech
/// package before publication or removal can continue.
pub trait SpeechRuntimeCoordinator: Send + Sync {
    fn quiesce(&self, backend: SpeechPackageId) -> Result<()>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageState {
    Unavailable,
    Missing,
    Installed,
    UpdateAvailable,
    Corrupt,
}

pub type EnginePackageState = PackageState;
pub type SpeechPackageState = PackageState;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageStatus<K> {
    pub id: K,
    pub label: &'static str,
    pub delivery_available: bool,
    pub installed: bool,
    pub update_available: bool,
    pub state: PackageState,
    pub version: Option<String>,
    pub available_version: Option<String>,
    pub installed_bytes: u64,
    pub download_bytes: u64,
    pub available_installed_bytes: u64,
}

pub type EnginePackageStatus = PackageStatus<EngineId>;
pub type SpeechPackageStatus = PackageStatus<SpeechPackageId>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemovalOutcome {
    Missing,
    Removed,
    PreservedModified,
}

#[derive(Clone)]
pub struct EnginePackageManager(ManagedPackageManager<EngineId>);

#[derive(Clone)]
pub struct SpeechPackageManager(ManagedPackageManager<SpeechPackageId>);

#[derive(Clone)]
struct ManagedPackageManager<K: 'static>(Arc<ManagerInner<K>>);

struct ManagerInner<K: 'static> {
    root: PathBuf,
    _store_lock: fs::File,
    catalog: &'static PackageCatalog<K>,
    fetcher: Arc<dyn ArchiveFetcher>,
    quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
    activity: Mutex<ActivityState<K>>,
}

#[derive(Debug)]
struct ActivityState<K> {
    operations: HashSet<K>,
    leases: HashMap<K, usize>,
}

impl<K> Default for ActivityState<K> {
    fn default() -> Self {
        Self {
            operations: HashSet::new(),
            leases: HashMap::new(),
        }
    }
}

impl fmt::Debug for EnginePackageManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnginePackageManager")
            .field("inner", &self.0)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for SpeechPackageManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechPackageManager")
            .field("inner", &self.0)
            .finish_non_exhaustive()
    }
}

impl<K> fmt::Debug for ManagedPackageManager<K>
where
    K: Eq + Hash,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedPackageManager")
            .field("root", &"<redacted>")
            .field("platform", &self.0.catalog.platform())
            .finish_non_exhaustive()
    }
}

trait ManagedPackageKey: Copy + Eq + Hash + fmt::Display + fmt::Debug + Send + Sync + 'static {
    fn as_str(self) -> &'static str;
    fn label(self) -> &'static str;
    fn requires_aligner(self) -> bool;
    fn operation_in_progress(self) -> PackageError;
}

impl ManagedPackageKey for EngineId {
    fn as_str(self) -> &'static str {
        self.as_str()
    }

    fn label(self) -> &'static str {
        catalog()
            .iter()
            .find(|info| info.id == self)
            .map_or("Unknown ASR engine", |info| info.label)
    }

    fn requires_aligner(self) -> bool {
        self.requires_aligner()
    }

    fn operation_in_progress(self) -> PackageError {
        PackageError::OperationInProgress(self)
    }
}

impl ManagedPackageKey for SpeechPackageId {
    fn as_str(self) -> &'static str {
        self.as_str()
    }

    fn label(self) -> &'static str {
        speech_catalog()
            .iter()
            .find(|info| info.id == self)
            .map_or("Unknown speech backend", |info| info.label)
    }

    fn requires_aligner(self) -> bool {
        false
    }

    fn operation_in_progress(self) -> PackageError {
        PackageError::SpeechOperationInProgress(self)
    }
}

impl EnginePackageManager {
    pub fn new(root: impl AsRef<Path>, coordinator: Arc<dyn RuntimeCoordinator>) -> Result<Self> {
        let catalog = DeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |engine| coordinator.quiesce(engine));
        Ok(Self(ManagedPackageManager::new(
            root.as_ref(),
            catalog,
            quiesce,
        )?))
    }

    #[must_use]
    pub fn statuses(&self) -> Vec<EnginePackageStatus> {
        catalog().iter().map(|info| self.status(info.id)).collect()
    }

    #[must_use]
    pub fn status(&self, engine: EngineId) -> EnginePackageStatus {
        self.0.status(engine)
    }

    pub fn install(
        &self,
        engine: EngineId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<EnginePackageStatus> {
        self.0.install(engine, cancellation, progress)
    }

    pub fn adopt_legacy(
        &self,
        engine: EngineId,
        layout: &LegacyLayout,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<EnginePackageStatus> {
        self.0.adopt_legacy(engine, layout, cancellation, progress)
    }

    pub fn remove(
        &self,
        engine: EngineId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        self.0.remove(engine, cancellation, progress)
    }

    pub fn resolve_for_launch(
        &self,
        engine: EngineId,
        cancellation: &CancellationToken,
    ) -> Result<InstalledRuntime> {
        self.0.resolve_for_launch(engine, cancellation)
    }
}

impl SpeechPackageManager {
    pub fn new(
        root: impl AsRef<Path>,
        coordinator: Arc<dyn SpeechRuntimeCoordinator>,
    ) -> Result<Self> {
        let catalog = SpeechDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |backend| coordinator.quiesce(backend));
        Ok(Self(ManagedPackageManager::new(
            root.as_ref(),
            catalog,
            quiesce,
        )?))
    }

    #[must_use]
    pub fn statuses(&self) -> Vec<SpeechPackageStatus> {
        speech_catalog()
            .iter()
            .map(|info| self.status(info.id))
            .collect()
    }

    #[must_use]
    pub fn status(&self, backend: SpeechPackageId) -> SpeechPackageStatus {
        self.0.status(backend)
    }

    pub fn install(
        &self,
        backend: SpeechPackageId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<SpeechPackageStatus> {
        self.0.install(backend, cancellation, progress)
    }

    pub fn remove(
        &self,
        backend: SpeechPackageId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        self.0.remove(backend, cancellation, progress)
    }

    pub fn resolve_for_launch(
        &self,
        backend: SpeechPackageId,
        cancellation: &CancellationToken,
    ) -> Result<InstalledSpeechRuntime> {
        self.0.resolve_for_launch(backend, cancellation)
    }
}

impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    fn new(
        root: &Path,
        catalog: &'static PackageCatalog<K>,
        quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
    ) -> Result<Self> {
        let root = initialize_store(root)?;
        let store_lock = acquire_store_lock(&root)?;
        recover_interrupted_mutations(&root, catalog)?;
        let fetcher = Arc::new(HttpArchiveFetcher::new()?);
        Ok(Self(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            catalog,
            fetcher,
            quiesce,
            activity: Mutex::new(ActivityState::default()),
        })))
    }

    #[must_use]
    fn status(&self, component: K) -> PackageStatus<K> {
        let releases = self.0.catalog.releases(&component);
        if releases.is_empty() {
            return PackageStatus {
                id: component,
                label: component.label(),
                delivery_available: false,
                installed: false,
                update_available: false,
                state: PackageState::Unavailable,
                version: None,
                available_version: None,
                installed_bytes: 0,
                download_bytes: 0,
                available_installed_bytes: 0,
            };
        }

        let mut first_valid = None;
        let mut installed_bytes = 0_u64;
        let mut corrupt = false;
        let verification = CancellationToken::default();
        for (index, delivery) in releases.iter().enumerate() {
            let root = self.version_root(delivery);
            match fs::symlink_metadata(&root) {
                Ok(_) => match receipt::validate_integrity(&root, delivery, &verification) {
                    Ok(()) => {
                        if first_valid.is_none() {
                            first_valid = Some((index, delivery));
                        }
                        installed_bytes =
                            installed_bytes.saturating_add(delivery.unpacked_size_bytes);
                    }
                    Err(_) => corrupt = true,
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => corrupt = true,
            }
        }
        if first_valid.is_none() && self.has_unrecognized_component_state(component) {
            corrupt = true;
        }
        let current = releases.first().expect("non-empty releases");
        let (state, version, installed, update_available) = if corrupt {
            (
                PackageState::Corrupt,
                first_valid.map(|(_, delivery)| delivery.version.clone()),
                first_valid.is_some(),
                false,
            )
        } else if let Some((index, delivery)) = first_valid {
            (
                if index == 0 {
                    PackageState::Installed
                } else {
                    PackageState::UpdateAvailable
                },
                Some(delivery.version.clone()),
                true,
                index != 0,
            )
        } else {
            (PackageState::Missing, None, false, false)
        };
        PackageStatus {
            id: component,
            label: component.label(),
            delivery_available: true,
            installed,
            update_available,
            state,
            version,
            available_version: Some(current.version.clone()),
            installed_bytes,
            download_bytes: current.size_bytes,
            available_installed_bytes: current.unpacked_size_bytes,
        }
    }

    fn install(
        &self,
        component: K,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<PackageStatus<K>> {
        let _operation = self.begin_operation(component)?;
        cancellation.check()?;
        require_store(&self.0.root)?;
        let delivery = self
            .0
            .catalog
            .current(&component)
            .ok_or(PackageError::DeliveryUnavailable)?;
        let target = self.version_root(delivery);
        match receipt::validate_integrity(&target, delivery, cancellation) {
            Ok(()) => return Ok(self.status(component)),
            Err(PackageError::Cancelled) => return Err(PackageError::Cancelled),
            Err(_) => {}
        }
        (self.0.quiesce)(component)?;
        self.require_no_leases(component)?;
        cancellation.check()?;
        self.ensure_disk_capacity(delivery)?;

        let (_, versions) = self.ensure_component_layout(component)?;
        if target.parent() != Some(versions.as_path()) {
            return Err(PackageError::StoreUnavailable);
        }
        let staging_parent = self.staging_root()?;
        let staging = staging_parent.join(format!(
            "{}-{}-{}",
            component.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::create_dir(&staging).map_err(|_| PackageError::StoreUnavailable)?;
        require_directory(&staging)?;

        let result: Result<()> = (|| {
            let archive = obtain(
                self.0.fetcher.as_ref(),
                &self.download_root()?,
                delivery,
                cancellation,
                progress,
            )?;
            archive::extract(&archive.path, &staging, delivery, cancellation, progress)?;
            receipt::write(&staging, delivery)?;
            receipt::validate_integrity(&staging, delivery, cancellation)?;
            self.publish_staged(&staging, &target, delivery, cancellation, progress)?;
            let _ = archive.remove_after_success();
            Ok(())
        })();
        if staging.exists() {
            let _ = cleanup_known_tree(&staging, &receipt::allowed_tree(delivery));
        }
        if result.is_err() {
            let _ = self.remove_empty_component_layout(component);
        }
        result?;
        Ok(self.status(component))
    }

    fn adopt_legacy(
        &self,
        component: K,
        layout: &LegacyLayout,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<PackageStatus<K>> {
        let _operation = self.begin_operation(component)?;
        cancellation.check()?;
        require_store(&self.0.root)?;
        let delivery = self
            .0
            .catalog
            .current(&component)
            .ok_or(PackageError::DeliveryUnavailable)?;
        if component.requires_aligner() != layout.aligner.is_some() {
            return Err(PackageError::InvalidRequest);
        }
        let target = self.version_root(delivery);
        match receipt::validate_integrity(&target, delivery, cancellation) {
            Ok(()) => return Ok(self.status(component)),
            Err(PackageError::Cancelled) => return Err(PackageError::Cancelled),
            Err(_) => {}
        }
        (self.0.quiesce)(component)?;
        self.require_no_leases(component)?;
        self.ensure_disk_capacity(delivery)?;
        let (_, versions) = self.ensure_component_layout(component)?;
        if target.parent() != Some(versions.as_path()) {
            return Err(PackageError::InvalidInstall);
        }
        let staging = self.staging_root()?.join(format!(
            "adopt-{}-{}-{}",
            component.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::create_dir(&staging).map_err(|_| PackageError::StoreUnavailable)?;
        require_directory(&staging)?;

        let result: Result<()> = (|| {
            let total = delivery.unpacked_size_bytes;
            let mut copied = 0_u64;
            for expected in &delivery.files {
                cancellation.check()?;
                let (source_root, suffix) = layout.source_for(expected.role, &expected.path)?;
                let source = resolve_owned(source_root, suffix)?;
                let target_file = crate::path_security::prepare_target(&staging, &expected.path)?;
                copy_verified_legacy_file(
                    &source,
                    &target_file,
                    expected,
                    cancellation,
                    copied,
                    total,
                    progress,
                )?;
                copied = copied.saturating_add(expected.size_bytes);
            }
            receipt::write(&staging, delivery)?;
            receipt::validate_integrity(&staging, delivery, cancellation)?;
            self.publish_staged(&staging, &target, delivery, cancellation, progress)?;
            Ok(())
        })();
        if staging.exists() {
            let _ = cleanup_known_tree(&staging, &receipt::allowed_tree(delivery));
        }
        if result.is_err() {
            let _ = self.remove_empty_component_layout(component);
        }
        result?;
        Ok(self.status(component))
    }

    fn remove(
        &self,
        component: K,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        let _operation = self.begin_operation(component)?;
        cancellation.check()?;
        require_store(&self.0.root)?;
        let releases = self.0.catalog.releases(&component);
        if releases.is_empty() {
            return Err(PackageError::DeliveryUnavailable);
        }
        (self.0.quiesce)(component)?;
        self.require_no_leases(component)?;
        if self.has_unrecognized_component_state(component) {
            return Ok(RemovalOutcome::PreservedModified);
        }
        let existing = releases
            .iter()
            .filter(|delivery| self.version_root(delivery).exists())
            .collect::<Vec<_>>();
        if existing.is_empty() {
            return Ok(RemovalOutcome::Missing);
        }
        for delivery in &existing {
            match receipt::validate_integrity(&self.version_root(delivery), delivery, cancellation)
            {
                Ok(()) => {}
                Err(PackageError::Cancelled) => return Err(PackageError::Cancelled),
                Err(_) => return Ok(RemovalOutcome::PreservedModified),
            }
        }
        let total = existing
            .iter()
            .map(|delivery| delivery.unpacked_size_bytes)
            .sum::<u64>();
        let mut removed = 0_u64;
        for delivery in existing {
            cancellation.check()?;
            let source = self.version_root(delivery);
            let trash = self.trash_root()?.join(format!(
                "{}-{}-{}",
                component.as_str(),
                delivery.version,
                Uuid::now_v7()
            ));
            fs::rename(&source, &trash).map_err(|_| PackageError::StoreUnavailable)?;
            if let Some(parent) = source.parent() {
                sync_directory(parent)?;
            }
            if let Some(parent) = trash.parent() {
                sync_directory(parent)?;
            }
            if let Err(error) = receipt::validate_integrity(&trash, delivery, cancellation) {
                fs::rename(&trash, &source).map_err(|_| PackageError::StoreUnavailable)?;
                if let Some(parent) = source.parent() {
                    sync_directory(parent)?;
                }
                return match error {
                    PackageError::Cancelled => Err(PackageError::Cancelled),
                    _ => Ok(RemovalOutcome::PreservedModified),
                };
            }
            progress.on_progress(OperationProgress::new(
                OperationPhase::Removing,
                removed,
                total,
            ));
            cleanup_known_tree(&trash, &receipt::allowed_tree(delivery))?;
            if let Some(parent) = trash.parent() {
                sync_directory(parent)?;
            }
            removed = removed.saturating_add(delivery.unpacked_size_bytes);
            progress.on_progress(OperationProgress::new(
                OperationPhase::Removing,
                removed,
                total,
            ));
        }
        self.remove_empty_component_layout(component)?;
        Ok(RemovalOutcome::Removed)
    }

    fn resolve_for_launch(
        &self,
        component: K,
        cancellation: &CancellationToken,
    ) -> Result<InstalledPackageRuntime<K>> {
        let lease = self.acquire_lease(component)?;
        require_store(&self.0.root)?;
        let mut selected = None;
        for delivery in self.0.catalog.releases(&component) {
            match receipt::validate_integrity(&self.version_root(delivery), delivery, cancellation)
            {
                Ok(()) => {
                    selected = Some(delivery);
                    break;
                }
                Err(PackageError::Cancelled) => return Err(PackageError::Cancelled),
                Err(_) => {}
            }
        }
        let delivery = selected.ok_or(PackageError::InvalidInstall)?;
        cancellation.check()?;
        let root = self.version_root(delivery);
        let python = resolve_owned(&root, &delivery.python_relative_path)?;
        require_regular_file(&python)?;
        let model = delivery
            .model_relative_path
            .as_deref()
            .map(|relative| resolve_declared_directory(&root, relative))
            .transpose()?;
        let aligner = delivery
            .aligner_relative_path
            .as_deref()
            .map(|relative| resolve_declared_directory(&root, relative))
            .transpose()?;
        Ok(InstalledPackageRuntime {
            _lease: lease,
            id: component,
            version: delivery.version.clone(),
            python,
            model,
            aligner,
        })
    }

    fn begin_operation(&self, component: K) -> Result<OperationGuard<'_, K>> {
        let mut activity = self
            .0
            .activity
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        if !activity.operations.is_empty() || !activity.operations.insert(component) {
            return Err(component.operation_in_progress());
        }
        Ok(OperationGuard {
            activity: &self.0.activity,
            component,
        })
    }

    fn acquire_lease(&self, component: K) -> Result<RuntimeLease<K>> {
        let mut activity = self
            .0
            .activity
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        if activity.operations.contains(&component) {
            return Err(PackageError::RuntimeBusy);
        }
        *activity.leases.entry(component).or_default() += 1;
        Ok(RuntimeLease {
            inner: Arc::clone(&self.0),
            component,
        })
    }

    fn require_no_leases(&self, component: K) -> Result<()> {
        let activity = self
            .0
            .activity
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        if activity.leases.get(&component).copied().unwrap_or(0) > 0 {
            return Err(PackageError::RuntimeBusy);
        }
        Ok(())
    }

    fn ensure_component_layout(&self, id: K) -> Result<(PathBuf, PathBuf)> {
        let component_root = ensure_direct_child(&self.0.root, id.as_str())?;
        let versions = ensure_direct_child(&component_root, "versions")?;
        Ok((component_root, versions))
    }

    fn version_root(&self, delivery: &PackageDelivery) -> PathBuf {
        self.0
            .root
            .join(&delivery.component)
            .join("versions")
            .join(&delivery.version)
    }

    fn staging_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".staging")
    }

    fn download_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".downloads")
    }

    fn trash_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".trash")
    }

    fn quarantine_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".quarantine")
    }

    fn publish_staged(
        &self,
        staging: &Path,
        target: &Path,
        delivery: &PackageDelivery,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<()> {
        cancellation.check()?;
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 0, 1));
        let quarantine = self.quarantine_existing_target(target, delivery)?;
        if fs::rename(staging, target).is_err() {
            Self::restore_quarantine(target, quarantine.as_deref())?;
            return Err(PackageError::StoreUnavailable);
        }
        if let Some(parent) = target.parent() {
            sync_directory(parent)?;
        }
        if let Err(error) = receipt::validate_integrity(target, delivery, cancellation) {
            Self::rollback_publish(staging, target, quarantine.as_deref())?;
            return Err(error);
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 1, 1));
        Ok(())
    }

    fn quarantine_existing_target(
        &self,
        target: &Path,
        delivery: &PackageDelivery,
    ) -> Result<Option<PathBuf>> {
        match fs::symlink_metadata(target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(PackageError::StoreUnavailable),
            Ok(_) => {}
        }
        let quarantine_root = self.quarantine_root()?;
        let quarantine = quarantine_root.join(format!(
            "{}-{}-{}",
            delivery.component,
            delivery.version,
            Uuid::now_v7()
        ));
        fs::rename(target, &quarantine).map_err(|_| PackageError::StoreUnavailable)?;
        sync_directory(&quarantine_root)?;
        if let Some(parent) = target.parent() {
            sync_directory(parent)?;
        }
        Ok(Some(quarantine))
    }

    fn rollback_publish(staging: &Path, target: &Path, quarantine: Option<&Path>) -> Result<()> {
        match fs::symlink_metadata(target) {
            Ok(_) => fs::rename(target, staging).map_err(|_| PackageError::StoreUnavailable)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(PackageError::StoreUnavailable),
        }
        Self::restore_quarantine(target, quarantine)
    }

    fn restore_quarantine(target: &Path, quarantine: Option<&Path>) -> Result<()> {
        if let Some(quarantine) = quarantine {
            fs::rename(quarantine, target).map_err(|_| PackageError::StoreUnavailable)?;
            if let Some(parent) = target.parent() {
                sync_directory(parent)?;
            }
            if let Some(parent) = quarantine.parent() {
                sync_directory(parent)?;
            }
        }
        Ok(())
    }

    fn ensure_disk_capacity(&self, delivery: &PackageDelivery) -> Result<()> {
        let required = delivery
            .size_bytes
            .checked_add(delivery.unpacked_size_bytes)
            .and_then(|value| value.checked_add(MIN_FREE_RESERVE_BYTES))
            .ok_or(PackageError::StorageLimit)?;
        let available =
            fs2::available_space(&self.0.root).map_err(|_| PackageError::StoreUnavailable)?;
        if available < required {
            return Err(PackageError::InsufficientSpace);
        }
        Ok(())
    }

    fn has_unrecognized_component_state(&self, id: K) -> bool {
        let component = self.0.root.join(id.as_str());
        match fs::symlink_metadata(&component) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            Ok(_) => return true,
            Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
        }
        let Ok(entries) = fs::read_dir(&component) else {
            return true;
        };
        let mut saw_versions = false;
        for entry in entries {
            let Ok(entry) = entry else {
                return true;
            };
            if entry.file_name() != "versions" || saw_versions {
                return true;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                return true;
            };
            if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                return true;
            }
            saw_versions = true;
        }
        if !saw_versions {
            return false;
        }
        let versions = component.join("versions");
        let Ok(entries) = fs::read_dir(versions) else {
            return true;
        };
        let known_versions = self
            .0
            .catalog
            .releases(&id)
            .iter()
            .map(|delivery| delivery.version.as_str())
            .collect::<HashSet<_>>();
        for entry in entries {
            let Ok(entry) = entry else {
                return true;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return true;
            };
            if !known_versions.contains(name.as_str()) {
                return true;
            }
        }
        false
    }

    fn remove_empty_component_layout(&self, id: K) -> Result<()> {
        let component = self.0.root.join(id.as_str());
        let versions = component.join("versions");
        if versions.exists() {
            require_directory(&versions)?;
            if fs::read_dir(&versions)
                .map_err(|_| PackageError::StoreUnavailable)?
                .next()
                .is_none()
            {
                fs::remove_dir(&versions).map_err(|_| PackageError::StoreUnavailable)?;
            }
        }
        if component.exists() {
            require_directory(&component)?;
            if fs::read_dir(&component)
                .map_err(|_| PackageError::StoreUnavailable)?
                .next()
                .is_none()
            {
                fs::remove_dir(component).map_err(|_| PackageError::StoreUnavailable)?;
            }
        }
        Ok(())
    }
}

fn recover_interrupted_mutations<K>(root: &Path, catalog: &PackageCatalog<K>) -> Result<()>
where
    K: ManagedPackageKey,
{
    recover_staging(root, catalog)?;
    recover_trash(root, catalog)
}

fn recover_staging<K>(root: &Path, catalog: &PackageCatalog<K>) -> Result<()>
where
    K: ManagedPackageKey,
{
    let staging = ensure_direct_child(root, ".staging")?;
    for entry in fs::read_dir(&staging).map_err(|_| PackageError::StoreUnavailable)? {
        let entry = entry.map_err(|_| PackageError::StoreUnavailable)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| PackageError::StoreUnavailable)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or(PackageError::StoreUnavailable)?;
        if !metadata.is_dir()
            || is_link_or_reparse(&metadata)
            || !catalog
                .releases
                .keys()
                .copied()
                .any(|id| valid_mutation_name(&name, id, true))
        {
            return Err(PackageError::StoreUnavailable);
        }
        let actual = collect_regular_files(&entry.path())?;
        cleanup_known_tree(&entry.path(), &actual)?;
    }
    sync_directory(&staging)
}

fn recover_trash<K>(root: &Path, catalog: &PackageCatalog<K>) -> Result<()>
where
    K: ManagedPackageKey,
{
    let trash = ensure_direct_child(root, ".trash")?;
    let cancellation = CancellationToken::default();
    for entry in fs::read_dir(&trash).map_err(|_| PackageError::StoreUnavailable)? {
        let entry = entry.map_err(|_| PackageError::StoreUnavailable)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| PackageError::StoreUnavailable)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or(PackageError::StoreUnavailable)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(PackageError::StoreUnavailable);
        }
        let delivery = catalog
            .releases
            .iter()
            .flat_map(|(id, releases)| releases.iter().map(move |delivery| (id, delivery)))
            .find_map(|(id, delivery)| {
                (valid_mutation_name(&name, *id, false)
                    && name.starts_with(&format!("{}-{}-", id.as_str(), delivery.version)))
                .then_some(delivery)
            })
            .ok_or(PackageError::StoreUnavailable)?;
        receipt::validate_integrity(&entry.path(), delivery, &cancellation)?;
        cleanup_known_tree(&entry.path(), &receipt::allowed_tree(delivery))?;
    }
    sync_directory(&trash)
}

fn valid_mutation_name<K>(name: &str, id: K, allow_adopt: bool) -> bool
where
    K: ManagedPackageKey,
{
    let direct_prefix = format!("{}-", id.as_str());
    let adopt_prefix = format!("adopt-{}-", id.as_str());
    let remainder = if let Some(value) = name.strip_prefix(&direct_prefix) {
        value
    } else if allow_adopt {
        let Some(value) = name.strip_prefix(&adopt_prefix) else {
            return false;
        };
        value
    } else {
        return false;
    };
    if !remainder.is_ascii() || remainder.len() <= 37 {
        return false;
    }
    let uuid_start = remainder.len() - 36;
    if remainder.as_bytes().get(uuid_start.wrapping_sub(1)) != Some(&b'-') {
        return false;
    }
    let version = &remainder[..uuid_start - 1];
    let uuid = &remainder[uuid_start..];
    !version.is_empty()
        && crate::catalog::validate_identifier(version).is_ok()
        && Uuid::parse_str(uuid).is_ok_and(|value| value.get_version_num() == 7)
}

struct OperationGuard<'a, K: Eq + Hash> {
    activity: &'a Mutex<ActivityState<K>>,
    component: K,
}

impl<K> Drop for OperationGuard<'_, K>
where
    K: Eq + Hash,
{
    fn drop(&mut self) {
        if let Ok(mut activity) = self.activity.lock() {
            activity.operations.remove(&self.component);
        }
    }
}

struct RuntimeLease<K: Eq + Hash + 'static> {
    inner: Arc<ManagerInner<K>>,
    component: K,
}

impl<K> Drop for RuntimeLease<K>
where
    K: Eq + Hash,
{
    fn drop(&mut self) {
        if let Ok(mut activity) = self.inner.activity.lock()
            && let Some(count) = activity.leases.get_mut(&self.component)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                activity.leases.remove(&self.component);
            }
        }
    }
}

pub struct InstalledPackageRuntime<K: Eq + Hash + 'static> {
    _lease: RuntimeLease<K>,
    id: K,
    version: String,
    python: PathBuf,
    model: Option<PathBuf>,
    aligner: Option<PathBuf>,
}

pub type InstalledRuntime = InstalledPackageRuntime<EngineId>;
pub type InstalledSpeechRuntime = InstalledPackageRuntime<SpeechPackageId>;

impl<K> fmt::Debug for InstalledPackageRuntime<K>
where
    K: Eq + Hash + fmt::Debug,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstalledPackageRuntime")
            .field("id", &self.id)
            .field("version", &self.version)
            .field("python", &"<redacted>")
            .field("model", &"<redacted>")
            .field("aligner", &self.aligner.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

impl InstalledPackageRuntime<EngineId> {
    #[must_use]
    pub const fn engine(&self) -> EngineId {
        self.id
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn python(&self) -> &Path {
        &self.python
    }

    #[must_use]
    pub fn model(&self) -> &Path {
        self.model
            .as_deref()
            .expect("validated ASR deliveries always contain a model")
    }

    #[must_use]
    pub fn aligner(&self) -> Option<&Path> {
        self.aligner.as_deref()
    }
}

impl InstalledPackageRuntime<SpeechPackageId> {
    #[must_use]
    pub const fn backend(&self) -> SpeechPackageId {
        self.id
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn python(&self) -> &Path {
        &self.python
    }

    #[must_use]
    pub fn model(&self) -> Option<&Path> {
        self.model.as_deref()
    }
}

#[derive(Clone)]
pub struct LegacyLayout {
    runtime: PathBuf,
    model: PathBuf,
    aligner: Option<PathBuf>,
}

impl fmt::Debug for LegacyLayout {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LegacyLayout")
            .field("runtime", &"<redacted>")
            .field("model", &"<redacted>")
            .field("aligner", &self.aligner.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl LegacyLayout {
    pub fn new(
        runtime: impl AsRef<Path>,
        model: impl AsRef<Path>,
        aligner: Option<&Path>,
    ) -> Result<Self> {
        Ok(Self {
            runtime: canonical_regular_directory(runtime.as_ref())?,
            model: canonical_regular_directory(model.as_ref())?,
            aligner: aligner.map(canonical_regular_directory).transpose()?,
        })
    }

    fn source_for<'a>(
        &'a self,
        role: crate::catalog::FileRole,
        manifest_path: &'a str,
    ) -> Result<(&'a Path, &'a str)> {
        let (root, prefix) = match role {
            crate::catalog::FileRole::Runtime => (self.runtime.as_path(), "runtime/"),
            crate::catalog::FileRole::Model => (self.model.as_path(), "model/"),
            crate::catalog::FileRole::Aligner => (
                self.aligner
                    .as_deref()
                    .ok_or(PackageError::InvalidRequest)?,
                "aligner/",
            ),
            crate::catalog::FileRole::License => (self.runtime.as_path(), "licenses/"),
        };
        let suffix = manifest_path
            .strip_prefix(prefix)
            .filter(|suffix| !suffix.is_empty())
            .ok_or(PackageError::InvalidCatalog)?;
        Ok((root, suffix))
    }
}

fn canonical_regular_directory(path: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|_| PackageError::InvalidRequest)?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|_| PackageError::InvalidRequest)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(PackageError::InvalidRequest);
    }
    Ok(canonical)
}

fn resolve_declared_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    crate::path_security::validate_directory_path(relative)
        .map_err(|_| PackageError::InvalidInstall)?;
    let mut current = root.to_path_buf();
    for segment in relative.split('/') {
        current.push(segment);
        require_directory(&current).map_err(|_| PackageError::InvalidInstall)?;
    }
    Ok(current)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PackageError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn sync_directory(_: &Path) -> Result<()> {
    Ok(())
}

fn copy_verified_legacy_file(
    source: &Path,
    target: &Path,
    expected: &DeliveryFile,
    cancellation: &CancellationToken,
    copied_before: u64,
    total: u64,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let metadata = require_regular_file(source)?;
    if metadata.len() != expected.size_bytes {
        return Err(PackageError::InvalidInstall);
    }
    let mut input = fs::File::open(source).map_err(|_| PackageError::InvalidInstall)?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|_| PackageError::StoreUnavailable)?;
    let mut hasher = Sha256::new();
    let mut written = 0_u64;
    let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
    loop {
        cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| PackageError::InvalidInstall)?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .filter(|value| *value <= expected.size_bytes)
            .ok_or(PackageError::InvalidInstall)?;
        output
            .write_all(&buffer[..read])
            .map_err(|_| PackageError::StoreUnavailable)?;
        hasher.update(&buffer[..read]);
        progress.on_progress(OperationProgress::new(
            OperationPhase::Verifying,
            copied_before.saturating_add(written),
            total,
        ));
    }
    if written != expected.size_bytes || format!("{:x}", hasher.finalize()) != expected.sha256 {
        return Err(PackageError::InvalidInstall);
    }
    output.flush().map_err(|_| PackageError::StoreUnavailable)?;
    output
        .sync_all()
        .map_err(|_| PackageError::StoreUnavailable)?;
    set_adopted_permissions(target, expected.executable)?;
    let copied = require_regular_file(target)?;
    if copied.len() != expected.size_bytes {
        return Err(PackageError::InvalidInstall);
    }
    Ok(())
}

#[cfg(unix)]
fn set_adopted_permissions(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| PackageError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn set_adopted_permissions(_: &Path, _: bool) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write as _};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use serde_json::json;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::catalog::parse_for_test;
    use crate::speech_catalog::parse_for_test as parse_speech_for_test;

    const PLATFORM: &str = "windows-x86_64";
    const TEST_PLATFORMS: [&str; 4] = [
        "linux-x86_64",
        "macos-aarch64",
        "macos-x86_64",
        "windows-x86_64",
    ];
    const PYTHON_PATH: &str = "runtime/python.exe";
    const MODEL_PATH: &str = "model/config.json";
    const PYTHON_BYTES: &[u8] = b"python-runtime";
    const MODEL_BYTES: &[u8] = b"model";
    const LICENSE_PATH: &str = "licenses/NOTICE.txt";
    const LICENSE_BYTES: &[u8] = b"license";

    struct Fixture {
        catalog: DeliveryCatalog,
        archive: Vec<u8>,
    }

    struct SpeechFixture {
        catalog: SpeechDeliveryCatalog,
        archive: Vec<u8>,
    }

    #[derive(Debug, Default)]
    struct TestCoordinator {
        calls: AtomicUsize,
    }

    impl RuntimeCoordinator for TestCoordinator {
        fn quiesce(&self, _: EngineId) -> Result<()> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    impl SpeechRuntimeCoordinator for TestCoordinator {
        fn quiesce(&self, _: SpeechPackageId) -> Result<()> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    #[derive(Debug)]
    struct MemoryFetcher {
        archive: Vec<u8>,
        interrupt_once: AtomicBool,
        offsets: Mutex<Vec<u64>>,
    }

    impl MemoryFetcher {
        fn new(archive: Vec<u8>, interrupt_once: bool) -> Self {
            Self {
                archive,
                interrupt_once: AtomicBool::new(interrupt_once),
                offsets: Mutex::new(Vec::new()),
            }
        }

        fn offsets(&self) -> Vec<u64> {
            self.offsets.lock().unwrap().clone()
        }
    }

    impl ArchiveFetcher for MemoryFetcher {
        fn fetch(
            &self,
            delivery: &PackageDelivery,
            target: &Path,
            resume_from: u64,
            _: Option<&str>,
            cancellation: &CancellationToken,
            progress: &dyn ProgressSink,
        ) -> Result<Option<String>> {
            assert_eq!(delivery.size_bytes, self.archive.len() as u64);
            self.offsets.lock().unwrap().push(resume_from);
            let start = usize::try_from(resume_from).unwrap();
            let mut output = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(resume_from > 0)
                .truncate(resume_from == 0)
                .open(target)
                .unwrap();
            if self.interrupt_once.swap(false, Ordering::AcqRel) {
                let remaining = self.archive.len() - start;
                let end = start + (remaining / 2).max(1);
                output.write_all(&self.archive[start..end]).unwrap();
                output.sync_all().unwrap();
                cancellation.cancel();
                return Err(PackageError::Cancelled);
            }
            output.write_all(&self.archive[start..]).unwrap();
            output.sync_all().unwrap();
            progress.on_progress(OperationProgress::new(
                OperationPhase::Downloading,
                delivery.size_bytes,
                delivery.size_bytes,
            ));
            Ok(Some("\"fixture-v1\"".to_string()))
        }
    }

    #[derive(Debug)]
    struct PanicFetcher;

    impl ArchiveFetcher for PanicFetcher {
        fn fetch(
            &self,
            _: &PackageDelivery,
            _: &Path,
            _: u64,
            _: Option<&str>,
            _: &CancellationToken,
            _: &dyn ProgressSink,
        ) -> Result<Option<String>> {
            panic!("legacy adoption must not download an archive")
        }
    }

    #[derive(Debug, Default)]
    struct RecordedProgress(Mutex<Vec<OperationProgress>>);

    impl ProgressSink for RecordedProgress {
        fn on_progress(&self, progress: OperationProgress) {
            self.0.lock().unwrap().push(progress);
        }
    }

    fn digest(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    fn fixture() -> Fixture {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (path, bytes, executable) in [
            (PYTHON_PATH, PYTHON_BYTES, true),
            (MODEL_PATH, MODEL_BYTES, false),
        ] {
            let permissions = if executable { 0o755 } else { 0o644 };
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(permissions);
            writer.start_file(path, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        let archive = writer.finish().unwrap().into_inner();
        let archive_sha = digest(&archive);
        let unpacked = (PYTHON_BYTES.len() + MODEL_BYTES.len()) as u64;
        let mut platforms = serde_json::Map::new();
        for platform in TEST_PLATFORMS {
            let release = json!({
                "version": "1.0.0",
                "asset": format!("parakeet-{platform}-1.0.0-{}.zip", &archive_sha[..16]),
                "sizeBytes": archive.len(),
                "sha256": archive_sha,
                "unpackedSizeBytes": unpacked,
                "pythonRelativePath": PYTHON_PATH,
                "modelRelativePath": "model",
                "alignerRelativePath": null,
                "files": [
                    {
                        "path": PYTHON_PATH,
                        "sizeBytes": PYTHON_BYTES.len(),
                        "sha256": digest(PYTHON_BYTES),
                        "executable": true,
                        "role": "runtime"
                    },
                    {
                        "path": MODEL_PATH,
                        "sizeBytes": MODEL_BYTES.len(),
                        "sha256": digest(MODEL_BYTES),
                        "executable": false,
                        "role": "model"
                    }
                ]
            });
            let engines = EngineId::ALL
                .into_iter()
                .map(|engine| {
                    json!({
                        "id": engine,
                        "releases": if engine == EngineId::Parakeet && platform == PLATFORM {
                            vec![release.clone()]
                        } else {
                            Vec::new()
                        }
                    })
                })
                .collect::<Vec<_>>();
            platforms.insert(platform.to_string(), json!({ "engines": engines }));
        }
        let raw = json!({
            "schemaVersion": 1,
            "platforms": platforms,
        })
        .to_string();
        Fixture {
            catalog: parse_for_test(&raw, PLATFORM).unwrap(),
            archive,
        }
    }

    fn speech_fixture() -> SpeechFixture {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (path, bytes, executable) in [
            (PYTHON_PATH, PYTHON_BYTES, true),
            (LICENSE_PATH, LICENSE_BYTES, false),
        ] {
            let permissions = if executable { 0o755 } else { 0o644 };
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(permissions);
            writer.start_file(path, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        let archive = writer.finish().unwrap().into_inner();
        let archive_sha = digest(&archive);
        let unpacked = (PYTHON_BYTES.len() + LICENSE_BYTES.len()) as u64;
        let mut platforms = serde_json::Map::new();
        for platform in TEST_PLATFORMS {
            let asset = format!("edge-tts-{platform}-1.0.0-{}.zip", &archive_sha[..16]);
            let release = json!({
                "version": "1.0.0",
                "asset": asset,
                "sourceUrl": format!(
                    "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/speech-packs-v1/{asset}"
                ),
                "sizeBytes": archive.len(),
                "sha256": archive_sha,
                "unpackedSizeBytes": unpacked,
                "pythonRelativePath": PYTHON_PATH,
                "files": [
                    {
                        "path": PYTHON_PATH,
                        "sizeBytes": PYTHON_BYTES.len(),
                        "sha256": digest(PYTHON_BYTES),
                        "executable": true,
                        "role": "runtime"
                    },
                    {
                        "path": LICENSE_PATH,
                        "sizeBytes": LICENSE_BYTES.len(),
                        "sha256": digest(LICENSE_BYTES),
                        "executable": false,
                        "role": "license"
                    }
                ]
            });
            let backends = SpeechPackageId::ALL
                .into_iter()
                .map(|backend| {
                    json!({
                        "id": backend,
                        "releases": if backend == SpeechPackageId::EdgeTts && platform == PLATFORM {
                            vec![release.clone()]
                        } else {
                            Vec::new()
                        }
                    })
                })
                .collect::<Vec<_>>();
            platforms.insert(platform.to_string(), json!({ "backends": backends }));
        }
        let raw = json!({
            "schemaVersion": 1,
            "commands": {
                "status": "speech_packages_status",
                "install": "speech_package_install",
                "remove": "speech_package_remove"
            },
            "platforms": platforms,
        })
        .to_string();
        SpeechFixture {
            catalog: parse_speech_for_test(&raw, PLATFORM).unwrap(),
            archive,
        }
    }

    fn manager(
        temp: &TempDir,
        catalog: DeliveryCatalog,
        fetcher: Arc<dyn ArchiveFetcher>,
        coordinator: Arc<dyn RuntimeCoordinator>,
    ) -> EnginePackageManager {
        let root = initialize_store(&temp.path().join("packages")).unwrap();
        let store_lock = acquire_store_lock(&root).unwrap();
        let catalog = Box::leak(Box::new(catalog));
        recover_interrupted_mutations(&root, catalog).unwrap();
        let quiesce = Arc::new(move |engine| coordinator.quiesce(engine));
        EnginePackageManager(ManagedPackageManager(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            catalog,
            fetcher,
            quiesce,
            activity: Mutex::new(ActivityState::default()),
        })))
    }

    fn speech_manager(
        temp: &TempDir,
        catalog: SpeechDeliveryCatalog,
        fetcher: Arc<dyn ArchiveFetcher>,
        coordinator: Arc<dyn SpeechRuntimeCoordinator>,
    ) -> SpeechPackageManager {
        let root = initialize_store(&temp.path().join("speech-packages")).unwrap();
        let store_lock = acquire_store_lock(&root).unwrap();
        let catalog = Box::leak(Box::new(catalog));
        recover_interrupted_mutations(&root, catalog).unwrap();
        let quiesce = Arc::new(move |backend| coordinator.quiesce(backend));
        SpeechPackageManager(ManagedPackageManager(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            catalog,
            fetcher,
            quiesce,
            activity: Mutex::new(ActivityState::default()),
        })))
    }

    #[test]
    fn install_launch_lease_and_remove_form_one_safe_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = fixture();
        let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, false));
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = manager(&temp, fixture.catalog, fetcher, coordinator.clone());
        let progress = RecordedProgress::default();

        assert_eq!(
            manager.status(EngineId::Parakeet).state,
            EnginePackageState::Missing
        );
        let status = manager
            .install(EngineId::Parakeet, &CancellationToken::default(), &progress)
            .unwrap();
        assert_eq!(status.state, EnginePackageState::Installed);
        assert!(status.installed);
        assert_eq!(status.installed_bytes, 19);
        let phases = progress
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|entry| entry.phase)
            .collect::<Vec<_>>();
        assert!(phases.contains(&OperationPhase::Downloading));
        assert!(phases.contains(&OperationPhase::Verifying));
        assert!(phases.contains(&OperationPhase::Extracting));
        assert!(phases.contains(&OperationPhase::Publishing));

        let runtime = manager
            .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
            .unwrap();
        assert!(runtime.python().ends_with("python.exe"));
        assert!(runtime.model().ends_with("model"));
        assert_eq!(
            manager.remove(EngineId::Parakeet, &CancellationToken::default(), &progress,),
            Err(PackageError::RuntimeBusy)
        );
        drop(runtime);
        assert_eq!(
            manager
                .remove(EngineId::Parakeet, &CancellationToken::default(), &progress,)
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(
            manager.status(EngineId::Parakeet).state,
            EnginePackageState::Missing
        );
        assert_eq!(coordinator.calls.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn interrupted_download_is_resumed_from_the_verified_partial() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = fixture();
        let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, true));
        let manager = manager(
            &temp,
            fixture.catalog,
            fetcher.clone(),
            Arc::new(TestCoordinator::default()),
        );
        let first = CancellationToken::default();
        assert_eq!(
            manager.install(EngineId::Parakeet, &first, &|_| {}),
            Err(PackageError::Cancelled)
        );
        assert_eq!(
            manager.status(EngineId::Parakeet).state,
            EnginePackageState::Missing
        );
        manager
            .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
            .unwrap();
        let offsets = fetcher.offsets();
        assert_eq!(offsets.len(), 2);
        assert_eq!(offsets[0], 0);
        assert!(offsets[1] > 0);
        assert!(offsets[1] < fetcher.archive.len() as u64);
    }

    #[test]
    fn same_size_tamper_is_not_ready_is_preserved_and_can_be_repaired() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = fixture();
        let fetcher = Arc::new(MemoryFetcher::new(fixture.archive, false));
        let manager = manager(
            &temp,
            fixture.catalog,
            fetcher,
            Arc::new(TestCoordinator::default()),
        );
        manager
            .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
            .unwrap();
        let runtime = manager
            .resolve_for_launch(EngineId::Parakeet, &CancellationToken::default())
            .unwrap();
        let model_file = runtime.model().join("config.json");
        drop(runtime);
        fs::write(&model_file, b"other").unwrap();
        let corrupt = manager.status(EngineId::Parakeet);
        assert_eq!(corrupt.state, EnginePackageState::Corrupt);
        assert!(!corrupt.installed);
        assert_eq!(
            manager
                .remove(EngineId::Parakeet, &CancellationToken::default(), &|_| {},)
                .unwrap(),
            RemovalOutcome::PreservedModified
        );
        manager
            .install(EngineId::Parakeet, &CancellationToken::default(), &|_| {})
            .unwrap();
        assert_eq!(
            manager.status(EngineId::Parakeet).state,
            EnginePackageState::Installed
        );
        let quarantine = manager.0.0.root.join(".quarantine");
        let preserved = fs::read_dir(quarantine).unwrap().next().unwrap().unwrap();
        assert_eq!(
            fs::read(preserved.path().join(MODEL_PATH)).unwrap(),
            b"other"
        );
    }

    #[test]
    fn verified_legacy_install_is_adopted_without_network_access() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("legacy-runtime");
        let model = temp.path().join("legacy-model");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&model).unwrap();
        fs::write(runtime.join("python.exe"), PYTHON_BYTES).unwrap();
        fs::write(model.join("config.json"), MODEL_BYTES).unwrap();
        let layout = LegacyLayout::new(&runtime, &model, None).unwrap();
        let fixture = fixture();
        let manager = manager(
            &temp,
            fixture.catalog,
            Arc::new(PanicFetcher),
            Arc::new(TestCoordinator::default()),
        );
        let adopted = manager
            .adopt_legacy(
                EngineId::Parakeet,
                &layout,
                &CancellationToken::default(),
                &|_| {},
            )
            .unwrap();
        assert_eq!(adopted.state, EnginePackageState::Installed);
    }

    #[test]
    fn modified_legacy_install_is_rejected_without_partial_readiness() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("legacy-runtime");
        let model = temp.path().join("legacy-model");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&model).unwrap();
        fs::write(runtime.join("python.exe"), PYTHON_BYTES).unwrap();
        fs::write(model.join("config.json"), b"other").unwrap();
        let layout = LegacyLayout::new(&runtime, &model, None).unwrap();
        let fixture = fixture();
        let manager = manager(
            &temp,
            fixture.catalog,
            Arc::new(PanicFetcher),
            Arc::new(TestCoordinator::default()),
        );
        assert_eq!(
            manager.adopt_legacy(
                EngineId::Parakeet,
                &layout,
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(PackageError::InvalidInstall)
        );
        assert_eq!(
            manager.status(EngineId::Parakeet).state,
            EnginePackageState::Missing
        );
    }

    #[test]
    fn store_lock_and_global_mutation_gate_prevent_competing_writers() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = fixture();
        let manager = manager(
            &temp,
            fixture.catalog,
            Arc::new(MemoryFetcher::new(fixture.archive, false)),
            Arc::new(TestCoordinator::default()),
        );
        assert!(
            EnginePackageManager::new(
                temp.path().join("packages"),
                Arc::new(TestCoordinator::default())
            )
            .is_err()
        );
        let operation = manager.0.begin_operation(EngineId::Parakeet).unwrap();
        assert_eq!(
            manager
                .0
                .begin_operation(EngineId::FasterWhisperTurbo)
                .err(),
            Some(PackageError::OperationInProgress(
                EngineId::FasterWhisperTurbo
            ))
        );
        drop(operation);
        assert!(
            manager
                .0
                .begin_operation(EngineId::FasterWhisperTurbo)
                .is_ok()
        );
    }

    #[test]
    fn speech_install_holds_a_runtime_lease_and_never_invents_a_model() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = speech_fixture();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = speech_manager(
            &temp,
            fixture.catalog,
            Arc::new(MemoryFetcher::new(fixture.archive, false)),
            coordinator.clone(),
        );
        assert_eq!(
            manager.status(SpeechPackageId::EdgeTts).state,
            SpeechPackageState::Missing
        );
        manager
            .install(
                SpeechPackageId::EdgeTts,
                &CancellationToken::default(),
                &|_| {},
            )
            .unwrap();
        let runtime = manager
            .resolve_for_launch(SpeechPackageId::EdgeTts, &CancellationToken::default())
            .unwrap();
        assert_eq!(runtime.backend(), SpeechPackageId::EdgeTts);
        assert_eq!(runtime.version(), "1.0.0");
        assert!(runtime.python().ends_with("python.exe"));
        assert!(runtime.model().is_none());
        assert_eq!(
            manager.remove(
                SpeechPackageId::EdgeTts,
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(PackageError::RuntimeBusy)
        );
        drop(runtime);
        assert_eq!(
            manager
                .remove(
                    SpeechPackageId::EdgeTts,
                    &CancellationToken::default(),
                    &|_| {},
                )
                .unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(coordinator.calls.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn restart_finishes_verified_trash_and_discards_safe_partial_staging() {
        let temp = tempfile::tempdir().unwrap();
        let first_fixture = speech_fixture();
        let manager = speech_manager(
            &temp,
            first_fixture.catalog,
            Arc::new(MemoryFetcher::new(first_fixture.archive, false)),
            Arc::new(TestCoordinator::default()),
        );
        manager
            .install(
                SpeechPackageId::EdgeTts,
                &CancellationToken::default(),
                &|_| {},
            )
            .unwrap();
        let store = manager.0.0.root.clone();
        let target = store.join("edge-tts/versions/1.0.0");
        let trash = store.join(format!(".trash/edge-tts-1.0.0-{}", Uuid::now_v7()));
        fs::rename(&target, &trash).unwrap();
        let staging = store.join(format!(".staging/edge-tts-1.0.0-{}", Uuid::now_v7()));
        fs::create_dir_all(staging.join("runtime")).unwrap();
        fs::write(staging.join(PYTHON_PATH), PYTHON_BYTES).unwrap();
        drop(manager);

        let second_fixture = speech_fixture();
        let restarted = speech_manager(
            &temp,
            second_fixture.catalog,
            Arc::new(MemoryFetcher::new(second_fixture.archive, false)),
            Arc::new(TestCoordinator::default()),
        );
        assert!(!trash.exists());
        assert!(!staging.exists());
        assert_eq!(
            restarted.status(SpeechPackageId::EdgeTts).state,
            SpeechPackageState::Missing
        );
        restarted
            .install(
                SpeechPackageId::EdgeTts,
                &CancellationToken::default(),
                &|_| {},
            )
            .unwrap();
        assert_eq!(
            restarted.status(SpeechPackageId::EdgeTts).state,
            SpeechPackageState::Installed
        );
    }

    #[test]
    fn unpublished_speech_catalog_never_quiesces_or_exposes_a_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = SpeechPackageManager::new(temp.path(), coordinator.clone()).unwrap();
        for status in manager.statuses() {
            assert_eq!(status.state, SpeechPackageState::Unavailable);
            assert!(!status.delivery_available);
        }
        assert_eq!(
            manager.install(
                SpeechPackageId::Chatterbox,
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(PackageError::DeliveryUnavailable)
        );
        assert_eq!(
            manager.remove(
                SpeechPackageId::Chatterbox,
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(PackageError::DeliveryUnavailable)
        );
        assert!(matches!(
            manager.resolve_for_launch(SpeechPackageId::Chatterbox, &CancellationToken::default(),),
            Err(PackageError::InvalidInstall)
        ));
        assert_eq!(coordinator.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn unavailable_catalog_never_quiesces_or_invents_an_install() {
        let temp = tempfile::tempdir().unwrap();
        let coordinator = Arc::new(TestCoordinator::default());
        let manager = EnginePackageManager::new(temp.path(), coordinator.clone()).unwrap();
        for status in manager.statuses() {
            assert_eq!(status.state, EnginePackageState::Unavailable);
            assert!(!status.delivery_available);
        }
        assert_eq!(
            manager.install(EngineId::Parakeet, &CancellationToken::default(), &|_| {},),
            Err(PackageError::DeliveryUnavailable)
        );
        assert_eq!(
            manager.remove(EngineId::Parakeet, &CancellationToken::default(), &|_| {},),
            Err(PackageError::DeliveryUnavailable)
        );
        assert_eq!(coordinator.calls.load(Ordering::Relaxed), 0);
    }
}
