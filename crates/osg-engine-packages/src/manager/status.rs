//! Status projection and verified launch resolution.

use std::fs;

use crate::path_security::{require_regular_file, require_store, resolve_owned};
use crate::{CancellationToken, PackageError, Result};

use super::files::resolve_declared_directory;
use super::key::ManagedPackageKey;
use super::runtime::InstalledPackageRuntime;
use super::state::ManagedPackageManager;
use super::{PackageState, PackageStatus};
impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    #[must_use]
    pub(super) fn status(&self, component: K) -> PackageStatus<K> {
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

        let (operation_in_progress, verified_version, activity_available) =
            self.status_activity(component);

        let mut first_valid = None;
        let mut installed_bytes = 0_u64;
        let mut corrupt = !activity_available;
        let verification = CancellationToken::default();
        for (index, delivery) in releases.iter().enumerate() {
            if operation_in_progress {
                if verified_version.as_deref() == Some(delivery.version.as_str()) {
                    if first_valid.is_none() {
                        first_valid = Some((index, delivery));
                    }
                    installed_bytes = installed_bytes.saturating_add(delivery.unpacked_size_bytes);
                }
                continue;
            }
            let root = self.version_root(delivery);
            match fs::symlink_metadata(&root) {
                Ok(_) if verified_version.as_deref() == Some(delivery.version.as_str()) => {
                    if first_valid.is_none() {
                        first_valid = Some((index, delivery));
                    }
                    installed_bytes = installed_bytes.saturating_add(delivery.unpacked_size_bytes);
                }
                Ok(_) => match self.verify_once(component, delivery, &verification) {
                    Ok(()) => {
                        if first_valid.is_none() {
                            first_valid = Some((index, delivery));
                        }
                        installed_bytes =
                            installed_bytes.saturating_add(delivery.unpacked_size_bytes);
                    }
                    Err(PackageError::RuntimeBusy) => {}
                    Err(_) => corrupt = true,
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => corrupt = true,
            }
        }
        if !operation_in_progress
            && first_valid.is_none()
            && self.has_unrecognized_component_state(component)
        {
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

    pub(super) fn status_activity(&self, component: K) -> (bool, Option<String>, bool) {
        // A mutating operation owns the component's filesystem layout. Publication renames a fully
        // populated staging tree into `versions/<version>` before its final digest pass completes.
        // A status probe of that visible target would start another multi-gigabyte verification on
        // every UI poll. The durable operation record owns progress; status preserves only the last
        // still-current version already verified in this manager lifetime until the mutation
        // commits. An expired version is never presented as verified, even though the mutator
        // means its deep recheck must wait until the operation commits.
        let now_unix_seconds = self.now_unix_seconds();
        match self.0.activity.lock() {
            Ok(activity) => {
                let operation_in_progress = activity.operations.contains(&component);
                let verified_version =
                    activity
                        .verified_versions
                        .get(&component)
                        .and_then(|entry| {
                            (entry.verified_at_unix_seconds != 0
                                && entry.verified_at_unix_seconds <= now_unix_seconds
                                && now_unix_seconds < entry.deep_verify_after_unix_seconds)
                                .then(|| entry.version.clone())
                        });
                (operation_in_progress, verified_version, true)
            }
            Err(_) => (true, None, false),
        }
    }

    pub(super) fn resolve_for_launch(
        &self,
        component: K,
        cancellation: &CancellationToken,
    ) -> Result<InstalledPackageRuntime<K>> {
        let lease = self.acquire_lease(component)?;
        require_store(&self.0.root)?;
        let mut selected = None;
        for delivery in self.0.catalog.releases(&component) {
            if self.is_verified(component, delivery) {
                selected = Some(delivery);
                break;
            }
            match self.verify_once(component, delivery, cancellation) {
                Ok(()) => {
                    selected = Some(delivery);
                    break;
                }
                Err(error @ (PackageError::Cancelled | PackageError::RuntimeBusy)) => {
                    return Err(error);
                }
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
            root,
            python,
            model,
            aligner,
        })
    }
}
