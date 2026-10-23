//! Download, staging population, and atomic publication of one catalog release.

use osg_runtime_staging::{OwnedStagingDirectory, StagingKind};

use crate::archive;
use crate::catalog::DeliverySourceKind;
use crate::delivery_manifest;
use crate::download::{obtain, obtain_asset};
use crate::path_security::{cleanup_known_tree, require_directory, require_store};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt;
use crate::{CancellationToken, PackageError, Result};

use super::PackageStatus;
use super::files::{CopyProgress, copy_verified_legacy_file, report_asset_download_progress};
use super::key::ManagedPackageKey;
use super::state::{InstallStaging, ManagedPackageManager, PreparedDelivery};
impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    pub(super) fn install(
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
            Ok(()) => {
                self.record_verified_receipt(component, delivery);
                return Ok(self.status(component));
            }
            Err(PackageError::Cancelled) => return Err(PackageError::Cancelled),
            Err(_) => {}
        }
        (self.0.quiesce)(component)?;
        self.require_no_leases(component)?;
        cancellation.check()?;
        self.ensure_disk_capacity(delivery)?;

        let effective_delivery = if let Some(manifest_asset) = &delivery.manifest {
            let manifest_progress = |value| {
                report_asset_download_progress(
                    progress,
                    value,
                    0,
                    manifest_asset.size_bytes,
                    delivery.size_bytes,
                );
            };
            let downloaded = obtain_asset(
                self.0.fetcher.as_ref(),
                &self.download_root()?,
                delivery,
                manifest_asset,
                cancellation,
                &manifest_progress,
            )?;
            let manifest = delivery_manifest::read(&downloaded.path, delivery)?;
            let mut effective = delivery.clone();
            effective.files = manifest
                .files
                .iter()
                .map(|entry| entry.file.clone())
                .collect();
            Some(PreparedDelivery {
                effective,
                manifest,
                manifest_download: downloaded,
            })
        } else {
            None
        };
        let effective = effective_delivery
            .as_ref()
            .map_or(delivery, |prepared| &prepared.effective);

        let (_, versions) = self.ensure_component_layout(component)?;
        if target.parent() != Some(versions.as_path()) {
            return Err(PackageError::StoreUnavailable);
        }
        let staging_parent = self.staging_root()?;
        let staging = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &staging_parent,
            StagingKind::EnginePackageInstall,
        )
        .map_err(|_| PackageError::StoreUnavailable)?;
        let staging = staging.path();
        require_directory(staging)?;

        let result = self.populate_install_staging(InstallStaging {
            component,
            delivery,
            effective,
            prepared: effective_delivery.as_ref(),
            staging,
            target: &target,
            cancellation,
            progress,
        });
        if result.is_ok()
            && let Some(prepared) = &effective_delivery
        {
            let _ = prepared.manifest_download.remove_after_success();
        }
        if staging.exists() {
            let _ = cleanup_known_tree(staging, &receipt::allowed_tree(effective));
        }
        if result.is_err() {
            let _ = self.remove_empty_component_layout(component);
        }
        result?;
        Ok(self.status(component))
    }

    pub(super) fn populate_install_staging(&self, install: InstallStaging<'_, K>) -> Result<()> {
        if let Some(prepared) = install.prepared {
            self.populate_manifest_staging(&install, prepared)?;
        } else {
            let archive = obtain(
                self.0.fetcher.as_ref(),
                &self.download_root()?,
                install.delivery,
                install.cancellation,
                install.progress,
            )?;
            archive::extract(
                &archive.path,
                install.staging,
                install.delivery,
                install.cancellation,
                install.progress,
            )?;
            let _ = archive.remove_after_success();
        }
        receipt::write(install.staging, install.effective)?;
        receipt::validate_structure(install.staging, install.effective)?;
        self.publish_staged(
            install.component,
            install.staging,
            install.target,
            install.effective,
            install.cancellation,
            install.progress,
        )?;
        Ok(())
    }

    pub(super) fn populate_manifest_staging(
        &self,
        install: &InstallStaging<'_, K>,
        prepared: &PreparedDelivery,
    ) -> Result<()> {
        receipt::install_delivery_manifest(
            install.staging,
            &prepared.manifest_download.path,
            install.effective,
        )?;
        let mut downloaded_bytes = install
            .delivery
            .manifest
            .as_ref()
            .map_or(0, |asset| asset.size_bytes);
        let mut downloaded_sources = Vec::with_capacity(install.delivery.sources.len());
        for source in &install.delivery.sources {
            install.cancellation.check()?;
            let source_progress = |value| {
                report_asset_download_progress(
                    install.progress,
                    value,
                    downloaded_bytes,
                    source.asset.size_bytes,
                    install.delivery.size_bytes,
                );
            };
            let downloaded = obtain_asset(
                self.0.fetcher.as_ref(),
                &self.download_root()?,
                install.delivery,
                &source.asset,
                install.cancellation,
                &source_progress,
            )?;
            downloaded_bytes = downloaded_bytes.saturating_add(source.asset.size_bytes);
            downloaded_sources.push(downloaded);
        }
        if downloaded_bytes != install.delivery.size_bytes {
            return Err(PackageError::InvalidCatalog);
        }
        install.progress.on_progress(OperationProgress::new(
            OperationPhase::Verifying,
            install.delivery.size_bytes,
            install.delivery.size_bytes,
        ));
        Self::extract_manifest_sources(install, prepared, &downloaded_sources)?;
        for downloaded in &downloaded_sources {
            let _ = downloaded.remove_after_success();
        }
        Ok(())
    }

    pub(super) fn extract_manifest_sources(
        install: &InstallStaging<'_, K>,
        prepared: &PreparedDelivery,
        downloaded_sources: &[crate::download::DownloadedArchive],
    ) -> Result<()> {
        let mut expanded = 0_u64;
        for (source_index, (source, downloaded)) in install
            .delivery
            .sources
            .iter()
            .zip(downloaded_sources)
            .enumerate()
        {
            let expected = prepared
                .manifest
                .files
                .iter()
                .filter(|file| file.source_index == source_index)
                .collect::<Vec<_>>();
            if expected.is_empty() {
                return Err(PackageError::InvalidCatalog);
            }
            expanded = expanded.saturating_add(match source.kind {
                DeliverySourceKind::Zip => archive::extract_manifest_source(
                    &downloaded.path,
                    install.staging,
                    &expected,
                    install.cancellation,
                    install.progress,
                    expanded,
                    install.effective.unpacked_size_bytes,
                )?,
                DeliverySourceKind::Raw => {
                    if expected.len() != 1 {
                        return Err(PackageError::InvalidCatalog);
                    }
                    let expected = &expected[0].file;
                    let target =
                        crate::path_security::prepare_target(install.staging, &expected.path)?;
                    copy_verified_legacy_file(
                        &downloaded.path,
                        &target,
                        expected,
                        CopyProgress {
                            cancellation: install.cancellation,
                            completed_before: expanded,
                            total: install.effective.unpacked_size_bytes,
                            progress: install.progress,
                            phase: OperationPhase::Extracting,
                        },
                    )?;
                    expected.size_bytes
                }
            });
        }
        (expanded == install.effective.unpacked_size_bytes)
            .then_some(())
            .ok_or(PackageError::InvalidCatalog)
    }
}
