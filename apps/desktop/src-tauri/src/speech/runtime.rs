//! Speech runtime state: worker roots, package resolution and per-backend lifecycle epochs.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};

use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, InstalledSpeechRuntime, PackageError,
    SpeechPackageManager,
};
use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority, StagingKind};
use osg_speech::{CancellationToken, LazySpeechWorker, SpeechError, WorkerProgram};

use super::MAX_LIFECYCLE_EPOCH;
use super::requests::{SpeechBackendRequest, SpeechVoiceResponse};
use super::runtime_workers::{canonical_directory, verified_worker};
use crate::diagnostics;

#[derive(Clone)]
pub(crate) struct SpeechRuntime(pub(super) Arc<SpeechRuntimeInner>);

#[derive(Clone)]
pub(crate) struct SpeechPackageCoordinator(pub(super) Weak<SpeechRuntimeInner>);

pub(super) struct SpeechRuntimeInner {
    install_root: PathBuf,
    pub(super) model_store: PathBuf,
    pub(super) work_root: PathBuf,
    pub(super) staging_authority: RuntimeStagingAuthority,
    resource_root: Option<PathBuf>,
    package_manager: RwLock<Option<SpeechPackageManager>>,
    pub(super) workers: Mutex<HashMap<SpeechBackendRequest, CachedWorker>>,
    pub(super) transient_workers:
        Mutex<HashMap<SpeechBackendRequest, Vec<Weak<ManagedSpeechWorker>>>>,
    artifact_publication_gates: Mutex<HashMap<SpeechArtifactPublicationKey, Weak<Mutex<()>>>>,
    lifecycles: Mutex<HashMap<SpeechBackendRequest, Arc<BackendLifecycleSlot>>>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct SpeechArtifactPublicationKey {
    pub(super) kind: String,
    pub(super) content_hash: Vec<u8>,
}

#[derive(Default)]
pub(super) struct BackendLifecycleSlot {
    pub(super) commit_gate: Mutex<()>,
    pub(super) state: Mutex<BackendLifecycle>,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct WorkerPaths {
    pub(super) python: PathBuf,
    pub(super) bootstrap: PathBuf,
    pub(super) model: Option<PathBuf>,
    pub(super) model_store: Option<PathBuf>,
}

pub(super) struct CachedWorker {
    pub(super) paths: WorkerPaths,
    pub(super) worker: Arc<ManagedSpeechWorker>,
}

#[derive(Clone, Default)]
pub(super) struct BackendLifecycle {
    pub(super) epoch: u64,
    pub(super) enabled: bool,
    pub(super) voices: Option<Vec<SpeechVoiceResponse>>,
    pub(super) cancellation: CancellationToken,
}

pub(super) struct ManagedSpeechWorker {
    pub(super) worker: LazySpeechWorker,
    pub(super) managed_runtime: Option<Arc<InstalledSpeechRuntime>>,
}

pub(super) struct RuntimeResolution {
    pub(super) paths: WorkerPaths,
    pub(super) managed_runtime: Option<Arc<InstalledSpeechRuntime>>,
}

impl SpeechRuntime {
    #[cfg(test)]
    pub(crate) fn new(
        install_root: impl AsRef<Path>,
        work_root: impl AsRef<Path>,
        resource_root: Option<PathBuf>,
    ) -> io::Result<Self> {
        fs::create_dir_all(install_root.as_ref())?;
        fs::create_dir_all(install_root.as_ref().join("f5-models-v1"))?;
        fs::create_dir_all(work_root.as_ref())?;
        let work_root = fs::canonicalize(work_root)?;
        let staging_authority =
            RuntimeStagingAuthority::prepare(&work_root.join(".runtime-staging-authority"))?;
        Self::new_with_staging_authority(install_root, work_root, resource_root, staging_authority)
    }

    pub(crate) fn new_with_staging_authority(
        install_root: impl AsRef<Path>,
        work_root: impl AsRef<Path>,
        resource_root: Option<PathBuf>,
        staging_authority: RuntimeStagingAuthority,
    ) -> io::Result<Self> {
        fs::create_dir_all(install_root.as_ref())?;
        fs::create_dir_all(install_root.as_ref().join("f5-models-v1"))?;
        fs::create_dir_all(work_root.as_ref())?;
        let work_root = fs::canonicalize(work_root)?;
        staging_authority.reconcile_all()?;
        let install_root = fs::canonicalize(install_root.as_ref())?;
        let model_store = fs::canonicalize(install_root.join("f5-models-v1"))?;
        let runtime = Self(Arc::new(SpeechRuntimeInner {
            install_root,
            model_store,
            work_root,
            staging_authority,
            resource_root: canonical_directory(resource_root),
            package_manager: RwLock::new(None),
            workers: Mutex::new(HashMap::new()),
            transient_workers: Mutex::new(HashMap::new()),
            artifact_publication_gates: Mutex::new(HashMap::new()),
            lifecycles: Mutex::new(HashMap::new()),
        }));
        // The package store's staging journals live inside the store itself (co-located
        // authority); the shared authority above covers only work staging under the cache root.
        let manager = SpeechPackageManager::new(
            runtime.0.install_root.join("packages-v1"),
            Arc::new(runtime.package_coordinator()),
        )
        .map_err(|_| io::Error::other("the managed speech package store is unavailable"))?;
        runtime
            .attach_package_manager(manager)
            .map_err(|_| io::Error::other("the managed speech runtime is unavailable"))?;
        Ok(runtime)
    }

    fn attach_package_manager(&self, manager: SpeechPackageManager) -> Result<(), SpeechError> {
        let mut package_manager = self
            .0
            .package_manager
            .write()
            .map_err(|_| SpeechError::StateUnavailable)?;
        if package_manager.is_some() {
            return Err(SpeechError::StateUnavailable);
        }
        *package_manager = Some(manager);
        Ok(())
    }

    #[must_use]
    fn package_coordinator(&self) -> SpeechPackageCoordinator {
        SpeechPackageCoordinator(Arc::downgrade(&self.0))
    }

    pub(crate) fn package_manager(&self) -> Result<SpeechPackageManager, SpeechError> {
        self.0
            .package_manager
            .read()
            .map_err(|_| SpeechError::StateUnavailable)?
            .clone()
            .ok_or(SpeechError::StateUnavailable)
    }

    pub(super) fn work_directory(&self) -> io::Result<OwnedStagingDirectory> {
        OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &self.0.work_root,
            StagingKind::SpeechJob,
        )
    }

    pub(super) fn resolve_runtime(
        &self,
        backend: SpeechBackendRequest,
    ) -> Result<RuntimeResolution, SpeechError> {
        let package_manager = self
            .0
            .package_manager
            .read()
            .map_err(|_| SpeechError::StateUnavailable)?
            .clone();
        if let Some(package_manager) = package_manager {
            let component = backend.package();
            let resolved =
                package_manager.resolve_for_launch(component, &PackageCancellationToken::default());
            diagnostics::record_receipt_write_degraded(
                component.as_str(),
                package_manager.receipt_write_degraded(component),
            );
            match resolved {
                Ok(runtime) => {
                    let bootstrap = self.resolve_worker()?;
                    let paths = WorkerPaths {
                        python: runtime.python().to_owned(),
                        bootstrap,
                        model: runtime.model().map(Path::to_owned),
                        model_store: (backend == SpeechBackendRequest::F5Tts)
                            .then(|| self.0.model_store.clone()),
                    };
                    let program = WorkerProgram::managed_bootstrap(
                        &paths.python,
                        &paths.bootstrap,
                        paths.model.as_deref(),
                    )?;
                    if let Some(store) = paths.model_store.as_deref() {
                        program.with_model_store(store)?;
                    }
                    return Ok(RuntimeResolution {
                        paths,
                        managed_runtime: Some(Arc::new(runtime)),
                    });
                }
                Err(PackageError::InvalidInstall | PackageError::DeliveryUnavailable) => {
                    return Err(SpeechError::WorkerNotFound);
                }
                Err(_) => return Err(SpeechError::WorkerNotFound),
            }
        }
        Err(SpeechError::WorkerNotFound)
    }

    fn resolve_worker(&self) -> Result<PathBuf, SpeechError> {
        let mut candidates = Vec::new();
        if let Some(root) = &self.0.resource_root {
            candidates.push(root.join("workers/osg_speech_worker.py"));
            candidates.push(root.join("speech_worker.py"));
        }
        candidates
            .iter()
            .find_map(|candidate| verified_worker(candidate))
            .ok_or(SpeechError::WorkerNotFound)
    }

    pub(super) fn lifecycle_slot(
        &self,
        backend: SpeechBackendRequest,
    ) -> Result<Arc<BackendLifecycleSlot>, SpeechError> {
        let mut lifecycles = self
            .0
            .lifecycles
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        Ok(Arc::clone(lifecycles.entry(backend).or_insert_with(|| {
            Arc::new(BackendLifecycleSlot::default())
        })))
    }

    pub(super) fn lifecycle(
        &self,
        backend: SpeechBackendRequest,
    ) -> Result<BackendLifecycle, SpeechError> {
        self.lifecycle_slot(backend)?
            .state
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)
            .map(|lifecycle| lifecycle.clone())
    }

    pub(super) fn lifecycle_epoch(
        &self,
        backend: SpeechBackendRequest,
    ) -> Result<u64, SpeechError> {
        self.lifecycle(backend).map(|lifecycle| lifecycle.epoch)
    }

    pub(super) fn artifact_publication_gate(
        &self,
        key: SpeechArtifactPublicationKey,
    ) -> Result<Arc<Mutex<()>>, SpeechError> {
        let mut gates = self
            .0
            .artifact_publication_gates
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        gates.retain(|_, gate| gate.strong_count() != 0);
        if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(key, Arc::downgrade(&gate));
        Ok(gate)
    }

    pub(super) fn invalidate_lifecycle(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: Option<u64>,
    ) -> Result<u64, SpeechError> {
        let slot = self.lifecycle_slot(backend)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        let mut lifecycle = slot
            .state
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        if expected_epoch.is_some_and(|expected| expected != lifecycle.epoch) {
            return Err(SpeechError::Cancelled);
        }
        lifecycle.cancellation.cancel();
        lifecycle.epoch = lifecycle
            .epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= MAX_LIFECYCLE_EPOCH)
            .ok_or(SpeechError::StateUnavailable)?;
        lifecycle.enabled = false;
        lifecycle.voices = None;
        lifecycle.cancellation = CancellationToken::default();
        Ok(lifecycle.epoch)
    }

    pub(super) fn require_enabled_lifecycle(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: u64,
    ) -> Result<CancellationToken, SpeechError> {
        let lifecycle = self.lifecycle(backend)?;
        if lifecycle.epoch != expected_epoch || !lifecycle.enabled {
            return Err(SpeechError::Cancelled);
        }
        Ok(lifecycle.cancellation)
    }

    pub(super) fn lifecycle_cancellation(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: u64,
    ) -> Result<CancellationToken, SpeechError> {
        let lifecycle = self.lifecycle(backend)?;
        if lifecycle.epoch != expected_epoch {
            return Err(SpeechError::Cancelled);
        }
        Ok(lifecycle.cancellation)
    }

    #[cfg(test)]
    pub(super) fn invalidate_replacement_before_shutdown<F>(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: u64,
        shutdown: F,
    ) -> Result<u64, SpeechError>
    where
        F: FnOnce(),
    {
        let epoch = self.invalidate_lifecycle(backend, Some(expected_epoch))?;
        shutdown();
        Ok(epoch)
    }
}
