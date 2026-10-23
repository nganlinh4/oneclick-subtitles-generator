//! Operation/lease admission, on-disk component layout, and publication with rollback.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use osg_runtime_staging::{OwnedStagingDirectory, StagingKind};

use crate::catalog::PackageDelivery;
use crate::path_security::{ensure_direct_child, is_link_or_reparse, require_directory};
use crate::receipt;
use crate::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, ProgressSink, Result,
};

use super::MIN_FREE_RESERVE_BYTES;
use super::files::sync_directory;
use super::key::ManagedPackageKey;
use super::state::{ManagedPackageManager, OperationGuard, QuarantinedPackage, RuntimeLease};
impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    pub(super) fn begin_operation(&self, component: K) -> Result<OperationGuard<'_, K>> {
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

    pub(super) fn acquire_lease(&self, component: K) -> Result<RuntimeLease<K>> {
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

    pub(super) fn require_no_leases(&self, component: K) -> Result<()> {
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

    pub(super) fn ensure_component_layout(&self, id: K) -> Result<(PathBuf, PathBuf)> {
        let component_root = ensure_direct_child(&self.0.root, id.as_str())?;
        let versions = ensure_direct_child(&component_root, "versions")?;
        Ok((component_root, versions))
    }

    pub(super) fn version_root(&self, delivery: &PackageDelivery) -> PathBuf {
        self.0
            .root
            .join(&delivery.component)
            .join("versions")
            .join(&delivery.version)
    }

    pub(super) fn staging_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".staging")
    }

    pub(super) fn download_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".downloads")
    }

    pub(super) fn trash_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".trash")
    }

    pub(super) fn quarantine_root(&self) -> Result<PathBuf> {
        ensure_direct_child(&self.0.root, ".quarantine")
    }

    pub(super) fn publish_staged(
        &self,
        component: K,
        staging: &Path,
        target: &Path,
        delivery: &PackageDelivery,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<()> {
        cancellation.check()?;
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 0, 1));
        let mut quarantine = self.quarantine_existing_target(target)?;
        if fs::rename(staging, target).is_err() {
            Self::restore_quarantine(target, &mut quarantine)?;
            return Err(PackageError::StoreUnavailable);
        }
        if let Some(parent) = target.parent() {
            sync_directory(parent)?;
        }
        if let Err(error) = receipt::validate_integrity(target, delivery, cancellation) {
            Self::rollback_publish(staging, target, &mut quarantine)?;
            return Err(error);
        }
        self.record_verified_receipt(component, delivery);
        if let Some(quarantine) = quarantine.take() {
            quarantine
                .owner
                .remove()
                .map_err(|_| PackageError::StoreUnavailable)?;
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 1, 1));
        Ok(())
    }

    pub(super) fn quarantine_existing_target(
        &self,
        target: &Path,
    ) -> Result<Option<QuarantinedPackage>> {
        match fs::symlink_metadata(target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(PackageError::StoreUnavailable),
            Ok(_) => {}
        }
        require_directory(target)?;
        let quarantine_root = self.quarantine_root()?;
        let owner = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &quarantine_root,
            StagingKind::EnginePackageQuarantine,
        )
        .map_err(|_| PackageError::StoreUnavailable)?;
        let previous = owner.path().join("previous");
        fs::rename(target, &previous).map_err(|_| PackageError::StoreUnavailable)?;
        sync_directory(&quarantine_root)?;
        if let Some(parent) = target.parent() {
            sync_directory(parent)?;
        }
        Ok(Some(QuarantinedPackage { owner, previous }))
    }

    pub(super) fn rollback_publish(
        staging: &Path,
        target: &Path,
        quarantine: &mut Option<QuarantinedPackage>,
    ) -> Result<()> {
        match fs::symlink_metadata(target) {
            Ok(_) => fs::rename(target, staging).map_err(|_| PackageError::StoreUnavailable)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(PackageError::StoreUnavailable),
        }
        Self::restore_quarantine(target, quarantine)
    }

    pub(super) fn restore_quarantine(
        target: &Path,
        quarantine: &mut Option<QuarantinedPackage>,
    ) -> Result<()> {
        if let Some(quarantine) = quarantine.take() {
            fs::rename(&quarantine.previous, target).map_err(|_| PackageError::StoreUnavailable)?;
            if let Some(parent) = target.parent() {
                sync_directory(parent)?;
            }
            if let Some(parent) = quarantine.owner.path().parent() {
                sync_directory(parent)?;
            }
            quarantine
                .owner
                .remove()
                .map_err(|_| PackageError::StoreUnavailable)?;
        }
        Ok(())
    }

    pub(super) fn ensure_disk_capacity(&self, delivery: &PackageDelivery) -> Result<()> {
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

    pub(super) fn has_unrecognized_component_state(&self, id: K) -> bool {
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

    pub(super) fn remove_empty_component_layout(&self, id: K) -> Result<()> {
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
