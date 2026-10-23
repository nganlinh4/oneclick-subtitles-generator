//! Verified installation: download, extraction into authenticated staging, receipt, and
//! publication of one immutable version directory.

use std::fs;
use std::path::{Path, PathBuf};

use osg_runtime_staging::{OwnedStagingDirectory, StagingKind};

use super::{NativeToolManager, NativeToolStatus};
use crate::archive::{install_artifact, set_permissions};
use crate::catalog::{NativeToolId, ToolDelivery};
use crate::download::RemoteFile;
use crate::path_security::{
    cleanup_empty_work_tree, ensure_direct_child, require_directory, resolve_owned,
};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt;
use crate::{CancellationToken, NativeToolError, Result};

impl NativeToolManager {
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
                        self.quarantine_invalid_install(&target)?;
                    }
                }
            }
            Ok(_) => return Err(NativeToolError::InvalidInstall),
            Err(_) => return Err(NativeToolError::StoreUnavailable),
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Preparing, 0, 1));

        let staging_parent = self.0.root.join(".staging");
        let downloads_parent = self.0.root.join(".downloads");
        require_directory(&staging_parent)?;
        require_directory(&downloads_parent)?;
        let downloads = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &downloads_parent,
            StagingKind::NativeToolDownload,
        )
        .map_err(|_| NativeToolError::StoreUnavailable)?;
        let staging = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &staging_parent,
            StagingKind::NativeToolExtraction,
        )
        .map_err(|_| NativeToolError::StoreUnavailable)?;
        let downloads = downloads.path();
        let staging = staging.path();
        require_directory(staging)?;
        require_directory(downloads)?;

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
            let target = crate::path_security::prepare_target(downloads, &notice.install_path)?;
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
        install_artifact(&artifact_path, staging, &delivery, cancellation, progress)?;
        for notice in &delivery.notices {
            cancellation.check()?;
            let source = resolve_owned(downloads, &notice.install_path)?;
            let target = crate::path_security::prepare_target(staging, &notice.install_path)?;
            fs::rename(source, &target).map_err(|_| NativeToolError::StoreUnavailable)?;
            set_permissions(&target, false)?;
        }
        cleanup_empty_work_tree(downloads)?;
        receipt::write(staging, &delivery)?;
        let _ = receipt::validate_integrity(staging, &delivery, cancellation)?;

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
        fs::rename(staging, &target).map_err(|_| NativeToolError::StoreUnavailable)?;
        let identity = receipt::validate_integrity(&target, &delivery, cancellation)?;
        self.remember_verified(&delivery, identity)?;
        self.activate_dynamic_delivery(&delivery)?;
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 1, 1));
        Ok(self.status(tool))
    }

    fn install_delivery(&self, tool: NativeToolId) -> Result<ToolDelivery> {
        let current = self
            .current_delivery(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        if tool != NativeToolId::YtDlp {
            return Ok(current);
        }
        // An install request is explicit (including failure recovery), so always ask the
        // official release resolver. The caller already coalesces and throttles automatic
        // recovery; a stale process failure must not be hidden behind a status cache.
        let candidate = self
            .0
            .ytdlp_releases
            .latest(self.0.catalog.platform())
            .ok()
            .filter(|latest| latest.version > current.version);
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

    fn ensure_versions_root(&self, tool: NativeToolId) -> Result<PathBuf> {
        let tools = self.0.root.join("tools");
        let tool_root = ensure_direct_child(&tools, tool.as_str())?;
        ensure_direct_child(&tool_root, "versions")
    }

    pub(super) fn quarantine_invalid_install(&self, target: &Path) -> Result<()> {
        require_directory(target).map_err(|_| NativeToolError::InvalidInstall)?;
        let quarantine_root = ensure_direct_child(&self.0.root, ".quarantine")?;
        let quarantine = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &quarantine_root,
            StagingKind::NativeToolQuarantine,
        )
        .map_err(|_| NativeToolError::StoreUnavailable)?;
        let invalid = quarantine.path().join("invalid");
        fs::rename(target, invalid).map_err(|_| NativeToolError::StoreUnavailable)?;
        // Dropping the authenticated owner retires the corrupt managed cache immediately. If the
        // process is killed after the rename, its durable journal reclaims the same tree next run.
        quarantine
            .remove()
            .map_err(|_| NativeToolError::StoreUnavailable)
    }
}
