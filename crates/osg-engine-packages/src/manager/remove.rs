//! Exact removal of a published package, preserving anything modified.

use std::fs;

use uuid::Uuid;

use crate::path_security::{cleanup_known_tree, require_store, scrub_generated_python_cache};
use crate::receipt;
use crate::verified_install;
use crate::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, ProgressSink, Result,
};

use super::RemovalOutcome;
use super::files::sync_directory;
use super::key::ManagedPackageKey;
use super::state::ManagedPackageManager;
impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    pub(super) fn remove(
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
            let root = self.version_root(delivery);
            let Ok(allowed) = receipt::allowed_tree_at(&root, delivery) else {
                return Ok(RemovalOutcome::PreservedModified);
            };
            scrub_generated_python_cache(&root, &allowed, &delivery.python_relative_path)?;
            if self.is_verified(component, delivery) {
                if receipt::validate_structure(&root, delivery).is_err() {
                    return Ok(RemovalOutcome::PreservedModified);
                }
                continue;
            }
            match receipt::validate_integrity(&root, delivery, cancellation) {
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
            if !self.is_verified(component, delivery)
                && let Err(error) = receipt::validate_integrity(&trash, delivery, cancellation)
            {
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
            let allowed = receipt::allowed_tree_at(&trash, delivery)?;
            cleanup_known_tree(&trash, &allowed)?;
            if let Some(parent) = trash.parent() {
                sync_directory(parent)?;
            }
            // Best-effort: an orphaned fast-path receipt for a version that no longer exists is
            // never trusted (its metadata walk would simply fail against a missing tree), so a
            // failure here does not affect the removal that already committed above.
            let _ = verified_install::remove(&self.0.root, delivery);
            removed = removed.saturating_add(delivery.unpacked_size_bytes);
            progress.on_progress(OperationProgress::new(
                OperationPhase::Removing,
                removed,
                total,
            ));
        }
        self.remove_empty_component_layout(component)?;
        self.clear_verified(component);
        Ok(RemovalOutcome::Removed)
    }
}
