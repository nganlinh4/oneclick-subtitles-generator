//! Adoption of a verified pre-manager install without network access.

use std::fmt;
use std::path::{Path, PathBuf};

use osg_runtime_staging::{OwnedStagingDirectory, StagingKind};

use crate::path_security::{cleanup_known_tree, require_directory, require_store, resolve_owned};
use crate::progress::{OperationPhase, ProgressSink};
use crate::receipt;
use crate::{CancellationToken, PackageError, Result};

use super::PackageStatus;
use super::files::{CopyProgress, canonical_regular_directory, copy_verified_legacy_file};
use super::key::ManagedPackageKey;
use super::state::ManagedPackageManager;
impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    pub(super) fn adopt_legacy(
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
        if delivery.manifest.is_some() {
            return Err(PackageError::InvalidRequest);
        }
        if component.requires_aligner() != layout.aligner.is_some() {
            return Err(PackageError::InvalidRequest);
        }
        let target = self.version_root(delivery);
        match receipt::validate_integrity(&target, delivery, cancellation) {
            Ok(()) => {
                self.record_verified_receipt(component, delivery);
                return Ok(self.status(component));
            }
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
        let staging_parent = self.staging_root()?;
        let staging = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &staging_parent,
            StagingKind::EnginePackageAdoption,
        )
        .map_err(|_| PackageError::StoreUnavailable)?;
        let staging = staging.path();
        require_directory(staging)?;

        let result: Result<()> = (|| {
            let total = delivery.unpacked_size_bytes;
            let mut copied = 0_u64;
            for expected in &delivery.files {
                cancellation.check()?;
                let (source_root, suffix) = layout.source_for(expected.role, &expected.path)?;
                let source = resolve_owned(source_root, suffix)?;
                let target_file = crate::path_security::prepare_target(staging, &expected.path)?;
                copy_verified_legacy_file(
                    &source,
                    &target_file,
                    expected,
                    CopyProgress {
                        cancellation,
                        completed_before: copied,
                        total,
                        progress,
                        phase: OperationPhase::Verifying,
                    },
                )?;
                copied = copied.saturating_add(expected.size_bytes);
            }
            receipt::write(staging, delivery)?;
            receipt::validate_structure(staging, delivery)?;
            self.publish_staged(
                component,
                staging,
                &target,
                delivery,
                cancellation,
                progress,
            )?;
            Ok(())
        })();
        if staging.exists() {
            let _ = cleanup_known_tree(staging, &receipt::allowed_tree(delivery));
        }
        if result.is_err() {
            let _ = self.remove_empty_component_layout(component);
        }
        result?;
        Ok(self.status(component))
    }
}

#[derive(Clone)]
pub struct LegacyLayout {
    pub(super) runtime: PathBuf,
    pub(super) model: PathBuf,
    pub(super) aligner: Option<PathBuf>,
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

    pub(super) fn source_for<'a>(
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
