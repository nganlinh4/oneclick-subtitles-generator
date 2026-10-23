//! ASR runtime manager: package resolution, cached worker services and lifecycle.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};

use osg_asr::{
    AsrEngineId, AsrError, AsrService, ModelAssets, RunControl as AsrRunControl, Transcription,
    TranscriptionRequest, WorkerProgram, catalog,
};
use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, EngineId as PackageEngineId,
    EnginePackageManager, InstalledRuntime, PackageError, RuntimeCoordinator,
};
use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority, StagingKind};

use super::request::{AsrEngineAvailability, AsrEngineRuntimeStatus, AsrEngineStatus, AsrStatus};
use super::{ASR_START_TIMEOUT, WORKER_BYTES};
use crate::diagnostics;

#[derive(Clone)]
pub(crate) struct AsrRuntimeManager(pub(super) Arc<RuntimeManagerInner>);

#[derive(Clone)]
pub(crate) struct AsrPackageCoordinator(Weak<RuntimeManagerInner>);

pub(super) struct RuntimeManagerInner {
    work_root: PathBuf,
    staging_authority: RuntimeStagingAuthority,
    resource_root: Option<PathBuf>,
    package_manager: RwLock<Option<EnginePackageManager>>,
    pub(super) runtime: Mutex<RuntimeState>,
}

#[derive(Default)]
pub(super) struct RuntimeState {
    services: HashMap<AsrEngineId, CachedService>,
    generations: HashMap<AsrEngineId, u64>,
    pub(super) starting: HashMap<AsrEngineId, StartingService>,
}

pub(super) struct StartingService {
    generation: u64,
    pub(super) service: AsrService,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct RuntimePaths {
    python: PathBuf,
    pub(super) worker: PathBuf,
    model: PathBuf,
    aligner: Option<PathBuf>,
}

pub(super) struct CachedService {
    paths: RuntimePaths,
    pub(super) service: AsrService,
    managed_runtime: Option<Arc<InstalledRuntime>>,
}

#[derive(Clone)]
pub(super) struct ManagedAsrService {
    pub(super) service: AsrService,
    _managed_runtime: Option<Arc<InstalledRuntime>>,
}

pub(super) struct RuntimeResolution {
    paths: RuntimePaths,
    managed_runtime: Option<Arc<InstalledRuntime>>,
}

impl AsrRuntimeManager {
    #[cfg(test)]
    pub(crate) fn new(
        work_root: impl AsRef<Path>,
        resource_root: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(work_root.as_ref())?;
        let work_root = std::fs::canonicalize(work_root)?;
        let staging_authority =
            RuntimeStagingAuthority::prepare(&work_root.join(".runtime-staging-authority"))?;
        Self::new_with_staging_authority(work_root, resource_root, staging_authority)
    }

    pub(crate) fn new_with_staging_authority(
        work_root: impl AsRef<Path>,
        resource_root: Option<PathBuf>,
        staging_authority: RuntimeStagingAuthority,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(work_root.as_ref())?;
        let work_root = std::fs::canonicalize(work_root)?;
        staging_authority.reconcile_all()?;
        let resource_root = canonical_directory(resource_root);
        Ok(Self(Arc::new(RuntimeManagerInner {
            work_root,
            staging_authority,
            resource_root,
            package_manager: RwLock::new(None),
            runtime: Mutex::new(RuntimeState::default()),
        })))
    }

    pub(crate) fn attach_package_manager(
        &self,
        manager: EnginePackageManager,
    ) -> Result<(), AsrError> {
        let mut package_manager = self
            .0
            .package_manager
            .write()
            .map_err(|_| AsrError::Synchronization)?;
        if package_manager.is_some() {
            return Err(AsrError::Synchronization);
        }
        *package_manager = Some(manager);
        Ok(())
    }

    #[must_use]
    pub(crate) fn package_coordinator(&self) -> AsrPackageCoordinator {
        AsrPackageCoordinator(Arc::downgrade(&self.0))
    }

    pub(super) fn service(&self, engine: AsrEngineId) -> Result<ManagedAsrService, AsrError> {
        let resolution = self.resolve_runtime(engine)?;
        let stale = {
            let mut runtime = self
                .0
                .runtime
                .lock()
                .map_err(|_| AsrError::Synchronization)?;
            let valid = runtime
                .services
                .get(&engine)
                .is_some_and(|cached| cached.paths == resolution.paths && cached.service.is_warm());
            if valid {
                let cached = runtime
                    .services
                    .get(&engine)
                    .ok_or(AsrError::Synchronization)?;
                return Ok(ManagedAsrService {
                    service: cached.service.clone(),
                    _managed_runtime: cached.managed_runtime.clone(),
                });
            }
            runtime.services.remove(&engine)
        };
        if let Some(stale) = stale {
            let _ = stale.service.shutdown();
        }
        Err(AsrError::InvalidRuntime)
    }

    fn create_service(
        &self,
        engine: AsrEngineId,
        resolution: RuntimeResolution,
    ) -> Result<CachedService, AsrError> {
        let paths = resolution.paths;
        let program = WorkerProgram::python(&paths.python, &paths.worker)?;
        let assets = ModelAssets::new(engine, &paths.model, paths.aligner.as_deref())?;
        Ok(CachedService {
            paths,
            service: AsrService::new_with_staging_authority(
                program,
                assets,
                self.0.staging_authority.clone(),
                &self.0.work_root,
            ),
            managed_runtime: resolution.managed_runtime,
        })
    }

    pub(crate) fn start(&self, engine: AsrEngineId) -> Result<(), AsrError> {
        let resolution = self.resolve_runtime(engine)?;
        let resolved_paths = resolution.paths.clone();
        let candidate = self.create_service(engine, resolution)?;
        let (generation, previous, superseded_start) =
            {
                let mut runtime = self
                    .0
                    .runtime
                    .lock()
                    .map_err(|_| AsrError::Synchronization)?;
                if runtime.services.get(&engine).is_some_and(|cached| {
                    cached.paths == resolved_paths && cached.service.is_warm()
                }) {
                    return Ok(());
                }
                let generation = runtime
                    .generations
                    .entry(engine)
                    .and_modify(|value| *value = value.wrapping_add(1).max(1))
                    .or_insert(1);
                let generation = *generation;
                let superseded_start = runtime.starting.insert(
                    engine,
                    StartingService {
                        generation,
                        service: candidate.service.clone(),
                    },
                );
                (
                    generation,
                    runtime.services.remove(&engine),
                    superseded_start,
                )
            };
        if let Some(previous) = previous {
            let _ = previous.service.shutdown();
        }
        if let Some(superseded_start) = superseded_start {
            let _ = superseded_start.service.shutdown();
        }
        if let Err(error) = candidate
            .service
            .warm_up(&AsrRunControl::new(ASR_START_TIMEOUT)?)
        {
            self.clear_start(engine, generation)?;
            return Err(error);
        }

        let mut runtime = self
            .0
            .runtime
            .lock()
            .map_err(|_| AsrError::Synchronization)?;
        if runtime.generations.get(&engine).copied() != Some(generation)
            || runtime
                .starting
                .get(&engine)
                .is_none_or(|starting| starting.generation != generation)
        {
            drop(runtime);
            let _ = candidate.service.shutdown();
            return Err(AsrError::Cancelled);
        }
        runtime.starting.remove(&engine);
        runtime.services.insert(engine, candidate);
        Ok(())
    }

    fn clear_start(&self, engine: AsrEngineId, generation: u64) -> Result<(), AsrError> {
        let mut runtime = self
            .0
            .runtime
            .lock()
            .map_err(|_| AsrError::Synchronization)?;
        if runtime
            .starting
            .get(&engine)
            .is_some_and(|starting| starting.generation == generation)
        {
            runtime.starting.remove(&engine);
        }
        Ok(())
    }

    pub(crate) fn stop(&self, engine: AsrEngineId) -> Result<(), AsrError> {
        let (removed, starting) = {
            let mut runtime = self
                .0
                .runtime
                .lock()
                .map_err(|_| AsrError::Synchronization)?;
            runtime
                .generations
                .entry(engine)
                .and_modify(|value| *value = value.wrapping_add(1).max(1))
                .or_insert(1);
            (
                runtime.services.remove(&engine),
                runtime.starting.remove(&engine),
            )
        };
        if let Some(removed) = removed {
            removed.service.shutdown()?;
        }
        if let Some(starting) = starting {
            starting.service.shutdown()?;
        }
        Ok(())
    }

    pub(crate) fn quiesce_package(&self, engine: PackageEngineId) -> Result<(), PackageError> {
        self.stop(package_to_asr(engine))
            .map_err(|_| PackageError::StoreUnavailable)
    }

    pub(super) fn status(&self) -> AsrStatus {
        let runtime = self.0.runtime.lock().ok();
        let worker_available = self.resolve_worker().is_ok();
        let engines = catalog()
            .iter()
            .copied()
            .map(|info| {
                let paths = self
                    .resolve_runtime(info.id)
                    .ok()
                    .map(|resolved| resolved.paths);
                let warm = paths.as_ref().is_some_and(|paths| {
                    runtime.as_ref().is_some_and(|runtime| {
                        runtime.services.get(&info.id).is_some_and(|cached| {
                            cached.paths == *paths && cached.service.is_warm()
                        })
                    })
                });
                AsrEngineStatus {
                    info,
                    availability: AsrEngineAvailability {
                        installed: paths.is_some(),
                        ready: paths.is_some(),
                    },
                    runtime: AsrEngineRuntimeStatus {
                        warm,
                        starting: runtime
                            .as_ref()
                            .is_some_and(|runtime| runtime.starting.contains_key(&info.id)),
                    },
                }
            })
            .collect();
        AsrStatus {
            worker_available,
            engines,
        }
    }

    pub(super) fn work_directory(&self) -> std::io::Result<OwnedStagingDirectory> {
        OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &self.0.work_root,
            StagingKind::AsrJob,
        )
    }

    fn resolve_runtime(&self, engine: AsrEngineId) -> Result<RuntimeResolution, AsrError> {
        let package_manager = self
            .0
            .package_manager
            .read()
            .map_err(|_| AsrError::Synchronization)?
            .clone();
        if let Some(package_manager) = package_manager {
            let component = asr_to_package(engine);
            let resolved =
                package_manager.resolve_for_launch(component, &PackageCancellationToken::default());
            diagnostics::record_receipt_write_degraded(
                component.as_str(),
                package_manager.receipt_write_degraded(component),
            );
            match resolved {
                Ok(runtime) => {
                    let worker = self.resolve_worker()?;
                    let paths = RuntimePaths {
                        python: runtime.python().to_owned(),
                        worker,
                        model: runtime.model().to_owned(),
                        aligner: runtime.aligner().map(Path::to_owned),
                    };
                    WorkerProgram::python(&paths.python, &paths.worker)?;
                    ModelAssets::new(engine, &paths.model, paths.aligner.as_deref())?;
                    return Ok(RuntimeResolution {
                        paths,
                        managed_runtime: Some(Arc::new(runtime)),
                    });
                }
                Err(PackageError::InvalidInstall | PackageError::DeliveryUnavailable) => {
                    return Err(AsrError::InvalidRuntime);
                }
                Err(_) => return Err(AsrError::InvalidRuntime),
            }
        }
        Err(AsrError::InvalidRuntime)
    }

    fn resolve_worker(&self) -> Result<PathBuf, AsrError> {
        let mut candidates = Vec::new();
        if let Some(root) = &self.0.resource_root {
            candidates.push(root.join("workers/osg_asr_worker.py"));
        }
        candidates
            .iter()
            .find_map(|path| resolve_verified_worker(path))
            .ok_or(AsrError::InvalidRuntime)
    }
}

impl ManagedAsrService {
    pub(super) fn transcribe(
        &self,
        request: &TranscriptionRequest,
        control: &AsrRunControl,
    ) -> Result<Transcription, AsrError> {
        self.service.transcribe(request, control)
    }
}

const fn asr_to_package(engine: AsrEngineId) -> PackageEngineId {
    match engine {
        AsrEngineId::Parakeet => PackageEngineId::Parakeet,
        AsrEngineId::FasterWhisperTurbo => PackageEngineId::FasterWhisperTurbo,
        AsrEngineId::FasterWhisperLargeV3 => PackageEngineId::FasterWhisperLargeV3,
        AsrEngineId::Qwen3Asr1_7b => PackageEngineId::Qwen3Asr1_7b,
        AsrEngineId::Qwen3Asr0_6b => PackageEngineId::Qwen3Asr0_6b,
    }
}

pub(crate) const fn package_to_asr(engine: PackageEngineId) -> AsrEngineId {
    match engine {
        PackageEngineId::Parakeet => AsrEngineId::Parakeet,
        PackageEngineId::FasterWhisperTurbo => AsrEngineId::FasterWhisperTurbo,
        PackageEngineId::FasterWhisperLargeV3 => AsrEngineId::FasterWhisperLargeV3,
        PackageEngineId::Qwen3Asr1_7b => AsrEngineId::Qwen3Asr1_7b,
        PackageEngineId::Qwen3Asr0_6b => AsrEngineId::Qwen3Asr0_6b,
    }
}

impl fmt::Debug for AsrRuntimeManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsrRuntimeManager")
            .field("paths", &"<redacted>")
            .field("status", &self.status())
            .finish()
    }
}

impl fmt::Debug for AsrPackageCoordinator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsrPackageCoordinator")
            .field("runtime", &"<weak-managed>")
            .finish()
    }
}

impl RuntimeCoordinator for AsrPackageCoordinator {
    fn quiesce(&self, engine: PackageEngineId) -> osg_engine_packages::Result<()> {
        let runtime = self.0.upgrade().ok_or(PackageError::StoreUnavailable)?;
        AsrRuntimeManager(runtime).quiesce_package(engine)
    }
}

impl fmt::Debug for RuntimePaths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimePaths")
            .field("python", &"<redacted>")
            .field("worker", &"<redacted>")
            .field("model", &"<redacted>")
            .field("aligner", &self.aligner.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

fn canonical_directory(path: Option<PathBuf>) -> Option<PathBuf> {
    path.and_then(|path| std::fs::canonicalize(path).ok())
        .filter(|path| path.is_dir())
}

fn resolve_verified_worker(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let metadata = std::fs::metadata(&canonical).ok()?;
    if !metadata.is_file() || metadata.len() != u64::try_from(WORKER_BYTES.len()).ok()? {
        return None;
    }
    let actual = std::fs::read(&canonical).ok()?;
    (actual.as_slice() == WORKER_BYTES).then_some(canonical)
}
