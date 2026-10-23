//! Install, status, and removal of F5-TTS language checkpoints through the reviewed pipeline.
//!
//! Each model lives at `<store>/<model id>/` as its checkpoint, its vocabulary, and a
//! `receipt.json`, which is the layout the speech worker loads. Downloads are resumable and
//! digest-verified; files are assembled in journal-owned staging and published by rename, so a
//! model directory is only ever absent, the previous complete tree, or the new complete tree.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, TryLockError};

use osg_delivery_core::files::{read_bounded, sync_directory, write_new_synced};
use osg_delivery_core::store::{self, StoreSpec};
use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority, StagingKind};
use serde::{Deserialize, Serialize};

use crate::download::{
    ArchiveFetcher, DownloadOwner, DownloadedArchive, HttpArchiveFetcher, cache_key,
    discard_partial, obtain_asset, partial_bytes, prune_downloads, report_asset_download_progress,
};
use crate::f5_catalog::{F5Catalog, F5Model, RECEIPT_NAME};
use crate::path_security::{
    collect_regular_file_metadata, ensure_direct_child, is_link_or_reparse, prepare_target,
    require_directory, require_regular_file,
};
use crate::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, ProgressSink,
    RemovalOutcome, Result,
};

#[cfg(test)]
mod tests;

const STORE: StoreSpec = StoreSpec {
    marker: ".osg-f5-models-v1",
    marker_bytes: b"OSG F5 model store v1\n",
    lock: ".osg-f5-models.lock",
    lock_bytes: b"OSG F5 model lock v1\n",
    children: &[".downloads", ".staging", ".quarantine"],
};
const MAX_RECEIPT_BYTES: u64 = 4 * 1024;
const MIN_FREE_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
/// F5 checkpoints are platform-independent; resume records still name an owner platform.
const PLATFORM: &str = "any";

#[derive(Clone)]
pub struct F5ModelManager(Arc<Inner>);

struct Inner {
    root: PathBuf,
    _store_lock: fs::File,
    staging_authority: RuntimeStagingAuthority,
    catalog: &'static F5Catalog,
    fetcher: Arc<dyn ArchiveFetcher>,
    operation: Mutex<()>,
}

impl std::fmt::Debug for F5ModelManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("F5ModelManager")
            .field("root", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// The receipt the speech worker requires next to a published model. Its shape predates this
/// manager, so models installed by earlier builds stay recognized.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    id: String,
    revision: String,
    checkpoint_sha256: String,
    vocabulary_sha256: String,
}

impl Receipt {
    fn for_model(model: &F5Model) -> Self {
        Self {
            id: model.id.clone(),
            revision: model.revision.clone(),
            checkpoint_sha256: model.checkpoint.asset.sha256.clone(),
            vocabulary_sha256: model.vocabulary.asset.sha256.clone(),
        }
    }

    fn matches(&self, model: &F5Model) -> bool {
        self.id == model.id
            && self.revision == model.revision
            && self.checkpoint_sha256 == model.checkpoint.asset.sha256
            && self.vocabulary_sha256 == model.vocabulary.asset.sha256
    }
}

impl F5ModelManager {
    pub fn new(root: &Path) -> Result<Self> {
        Self::with_fetcher(
            root,
            F5Catalog::builtin()?,
            Arc::new(HttpArchiveFetcher::new()?),
        )
    }

    pub(crate) fn with_fetcher(
        root: &Path,
        catalog: &'static F5Catalog,
        fetcher: Arc<dyn ArchiveFetcher>,
    ) -> Result<Self> {
        let root = store::initialize_store(root, &STORE)?;
        let store_lock = store::acquire_store_lock(&root, &STORE)?;
        let staging_authority =
            RuntimeStagingAuthority::prepare(&root.join(".runtime-staging-authority"))
                .map_err(|_| PackageError::StoreUnavailable)?;
        let allowed = catalog
            .models
            .iter()
            .flat_map(F5Model::files)
            .map(|file| cache_key(&file.asset.sha256, &file.asset.asset))
            .collect::<HashSet<_>>();
        prune_downloads(&root.join(".downloads"), &allowed)?;
        remove_legacy_staging(&root, catalog);
        Ok(Self(Arc::new(Inner {
            root,
            _store_lock: store_lock,
            staging_authority,
            catalog,
            fetcher,
            operation: Mutex::new(()),
        })))
    }

    /// A metadata-only check: the published directory holds exactly the catalog's two files at
    /// their exact sizes plus a matching receipt. Content was verified before publication.
    #[must_use]
    pub fn is_installed(&self, id: &str) -> bool {
        self.0
            .catalog
            .model(id)
            .is_ok_and(|model| tree_matches(&self.0.root.join(&model.id), model))
    }

    pub fn install(
        &self,
        id: &str,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<()> {
        let model = self.0.catalog.model(id)?;
        let _operation = self.begin_operation()?;
        store::require_store(&self.0.root, &STORE)?;
        if self.is_installed(id) {
            return Ok(());
        }
        cancellation.check()?;
        let downloads = ensure_direct_child(&self.0.root, ".downloads")?;
        self.ensure_capacity(model, &downloads)?;
        let fetched = self.download(model, &downloads, cancellation, progress)?;

        let staging = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &ensure_direct_child(&self.0.root, ".staging")?,
            StagingKind::EnginePackageInstall,
        )
        .map_err(|_| PackageError::StoreUnavailable)?;
        let staged = stage(model, staging.path(), &fetched);
        let published = staged.and_then(|()| {
            cancellation.check()?;
            progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 0, 1));
            self.publish(model, staging.path())
        });
        if let Err(error) = published {
            // Keep the verified bytes resumable rather than losing a multi-gigabyte download.
            for (file, downloaded) in model.files().into_iter().zip(&fetched) {
                let _ = fs::rename(staging.path().join(&file.path), &downloaded.path);
            }
            return Err(error);
        }
        for downloaded in &fetched {
            let _ = downloaded.remove_after_success();
        }
        progress.on_progress(OperationProgress::new(OperationPhase::Publishing, 1, 1));
        Ok(())
    }

    /// Removes a published model. A directory holding anything but the model's own files is
    /// preserved and reported as `PreservedModified`.
    pub fn remove(&self, id: &str, cancellation: &CancellationToken) -> Result<RemovalOutcome> {
        let model = self.0.catalog.model(id)?;
        let _operation = self.begin_operation()?;
        store::require_store(&self.0.root, &STORE)?;
        let downloads = ensure_direct_child(&self.0.root, ".downloads")?;
        for file in model.files() {
            discard_partial(&downloads, &file.asset)?;
        }
        let target = self.0.root.join(&model.id);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RemovalOutcome::Missing);
            }
            Err(_) => return Err(PackageError::StoreUnavailable),
            Ok(metadata) if !metadata.is_dir() || is_link_or_reparse(&metadata) => {
                return Ok(RemovalOutcome::PreservedModified);
            }
            Ok(_) => {}
        }
        let allowed = allowed_files(model);
        if !collect_regular_file_metadata(&target, |_, _| Ok(()))
            .is_ok_and(|files| files.keys().all(|path| allowed.contains(path.as_str())))
        {
            return Ok(RemovalOutcome::PreservedModified);
        }
        cancellation.check()?;
        let retired = self.retire(&target)?;
        retired
            .remove()
            .map_err(|_| PackageError::StoreUnavailable)?;
        Ok(RemovalOutcome::Removed)
    }

    fn begin_operation(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        match self.0.operation.try_lock() {
            Ok(guard) => Ok(guard),
            Err(TryLockError::WouldBlock) => Err(PackageError::RuntimeBusy),
            Err(TryLockError::Poisoned(_)) => Err(PackageError::StoreUnavailable),
        }
    }

    fn ensure_capacity(&self, model: &F5Model, downloads: &Path) -> Result<()> {
        let remaining = model
            .files()
            .into_iter()
            .map(|file| file.asset.size_bytes - partial_bytes(downloads, &file.asset))
            .sum::<u64>();
        let available =
            fs2::available_space(&self.0.root).map_err(|_| PackageError::StoreUnavailable)?;
        if available < remaining.saturating_add(MIN_FREE_RESERVE_BYTES) {
            return Err(PackageError::InsufficientSpace);
        }
        Ok(())
    }

    fn download(
        &self,
        model: &F5Model,
        downloads: &Path,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<Vec<DownloadedArchive>> {
        let owner = DownloadOwner {
            component: &model.id,
            platform: PLATFORM,
            version: &model.revision,
        };
        let total = model.download_bytes();
        let mut completed = 0_u64;
        let mut fetched = Vec::with_capacity(2);
        for file in model.files() {
            let size = file.asset.size_bytes;
            let report = |value| {
                report_asset_download_progress(progress, value, completed, size, total);
            };
            fetched.push(obtain_asset(
                self.0.fetcher.as_ref(),
                downloads,
                owner,
                &file.asset,
                cancellation,
                &report,
            )?);
            completed += size;
        }
        Ok(fetched)
    }

    /// Swaps the staged tree into place. On any failure the previous tree (if any) is restored.
    fn publish(&self, model: &F5Model, staging: &Path) -> Result<()> {
        let target = self.0.root.join(&model.id);
        let previous = match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(PackageError::StoreUnavailable),
            Ok(_) => Some(self.retire(&target)?),
        };
        let restore = |previous: Option<OwnedStagingDirectory>| {
            if let Some(previous) = previous {
                fs::rename(previous.path().join("previous"), &target)
                    .map_err(|_| PackageError::StoreUnavailable)?;
            }
            Ok::<(), PackageError>(())
        };
        if fs::rename(staging, &target).is_err() {
            restore(previous)?;
            return Err(PackageError::StoreUnavailable);
        }
        sync_directory(&self.0.root)?;
        if !tree_matches(&target, model) {
            fs::rename(&target, staging).map_err(|_| PackageError::StoreUnavailable)?;
            restore(previous)?;
            return Err(PackageError::InvalidInstall);
        }
        if let Some(previous) = previous {
            // The new model is live; a stale copy left behind is reclaimed by its journal.
            let _ = previous.remove();
        }
        Ok(())
    }

    /// Moves a published tree into journal-owned quarantine at `<entry>/previous`.
    fn retire(&self, target: &Path) -> Result<OwnedStagingDirectory> {
        require_directory(target)?;
        let quarantine = OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &ensure_direct_child(&self.0.root, ".quarantine")?,
            StagingKind::EnginePackageQuarantine,
        )
        .map_err(|_| PackageError::StoreUnavailable)?;
        fs::rename(target, quarantine.path().join("previous"))
            .map_err(|_| PackageError::StoreUnavailable)?;
        sync_directory(&self.0.root)?;
        Ok(quarantine)
    }
}

/// Moves verified downloads into staging under the worker's file names and writes the receipt.
fn stage(model: &F5Model, staging: &Path, fetched: &[DownloadedArchive]) -> Result<()> {
    for (file, downloaded) in model.files().into_iter().zip(fetched) {
        let target = prepare_target(staging, &file.path)?;
        fs::rename(&downloaded.path, &target).map_err(|_| PackageError::StoreUnavailable)?;
        if require_regular_file(&target)?.len() != file.asset.size_bytes {
            return Err(PackageError::ArchiveIntegrity);
        }
    }
    let receipt =
        serde_json::to_vec(&Receipt::for_model(model)).map_err(|_| PackageError::InvalidInstall)?;
    Ok(write_new_synced(&staging.join(RECEIPT_NAME), &receipt)?)
}

fn allowed_files(model: &F5Model) -> HashSet<&str> {
    model
        .files()
        .into_iter()
        .map(|file| file.path.as_str())
        .chain([RECEIPT_NAME])
        .collect()
}

fn tree_matches(directory: &Path, model: &F5Model) -> bool {
    let Ok(sizes) = collect_regular_file_metadata(directory, |_, metadata| Ok(metadata.len()))
    else {
        return false;
    };
    let expected = model
        .files()
        .into_iter()
        .map(|file| (file.path.as_str(), file.asset.size_bytes))
        .collect::<HashMap<_, _>>();
    sizes.len() == expected.len() + 1
        && expected
            .iter()
            .all(|(path, size)| sizes.get(*path) == Some(size))
        && read_bounded(&directory.join(RECEIPT_NAME), MAX_RECEIPT_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Receipt>(&bytes).ok())
            .is_some_and(|receipt| receipt.matches(model))
}

/// Builds before this manager staged at `<store>/.<model id>.<uuid>`; a crash could strand one.
/// Only a plain directory holding nothing but that model's own files is removed.
fn remove_legacy_staging(root: &Path, catalog: &F5Catalog) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(model) = name.to_str().and_then(|name| {
            let (id, operation) = name.strip_prefix('.')?.split_once('.')?;
            uuid::Uuid::parse_str(operation).ok()?;
            catalog.model(id).ok()
        }) else {
            continue;
        };
        let allowed = allowed_files(model)
            .into_iter()
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        let _ = crate::path_security::cleanup_known_tree(&entry.path(), &allowed);
    }
}
