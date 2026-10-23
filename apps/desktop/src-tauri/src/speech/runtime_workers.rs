//! Speech worker acquisition, voice inventory, status reporting and shutdown.

use std::fmt;
use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use osg_engine_packages::{PackageError, SpeechPackageId, SpeechRuntimeCoordinator};
use osg_speech::{LazySpeechWorker, SecretValue, SpeechError, WorkerProgram, WorkerStatus};

use super::WORKER_BYTES;
use super::requests::{
    SpeechBackendRequest, SpeechBackendStatus, SpeechInventoryResponse, SpeechVoiceResponse,
    package_to_speech,
};
use super::runtime::{
    CachedWorker, ManagedSpeechWorker, SpeechPackageCoordinator, SpeechRuntime, WorkerPaths,
};
use crate::error::{CommandError, CommandResult};

impl SpeechRuntime {
    pub(super) fn worker_for_probe<F>(
        &self,
        backend: SpeechBackendRequest,
        mut expected_epoch: u64,
        mut publish_epoch: F,
    ) -> Result<(Arc<ManagedSpeechWorker>, u64), SpeechError>
    where
        F: FnMut(u64),
    {
        publish_epoch(expected_epoch);
        let resolution = self.resolve_runtime(backend)?;
        let mut workers = self
            .0
            .workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        let current = self.lifecycle(backend)?;
        if current.epoch != expected_epoch {
            return Err(SpeechError::Cancelled);
        }
        if let Some(cached) = workers.get(&backend)
            && cached.paths == resolution.paths
        {
            let worker = Arc::clone(&cached.worker);
            let epoch = if current.enabled && worker.status() == WorkerStatus::Stopped {
                let epoch = self.invalidate_lifecycle(backend, Some(expected_epoch))?;
                publish_epoch(epoch);
                epoch
            } else {
                expected_epoch
            };
            return Ok((worker, epoch));
        }
        if let Some(previous) = workers.remove(&backend) {
            expected_epoch = self.invalidate_lifecycle(backend, Some(expected_epoch))?;
            publish_epoch(expected_epoch);
            previous.worker.shutdown();
        }
        let paths = resolution.paths;
        let mut program = if resolution.managed_runtime.is_some() {
            WorkerProgram::managed_bootstrap(
                &paths.python,
                &paths.bootstrap,
                paths.model.as_deref(),
            )?
        } else {
            WorkerProgram::bootstrap(&paths.python, &paths.bootstrap)?
        };
        if let Some(store) = paths.model_store.as_deref() {
            program = program.with_model_store(store)?;
        }
        let worker = Arc::new(ManagedSpeechWorker {
            worker: LazySpeechWorker::new(program, backend.native())
                .with_staging_authority(self.0.staging_authority.clone(), &self.0.work_root),
            managed_runtime: resolution.managed_runtime,
        });
        workers.insert(
            backend,
            CachedWorker {
                paths,
                worker: Arc::clone(&worker),
            },
        );
        Ok((worker, expected_epoch))
    }

    pub(super) fn enabled_worker_for_epoch(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: u64,
    ) -> Result<Arc<ManagedSpeechWorker>, SpeechError> {
        self.require_enabled_lifecycle(backend, expected_epoch)?;
        let resolution = self.resolve_runtime(backend)?;
        let worker = self
            .0
            .workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?
            .get(&backend)
            .filter(|cached| cached.paths == resolution.paths)
            .map(|cached| Arc::clone(&cached.worker))
            .ok_or(SpeechError::StateUnavailable)?;
        match worker.status() {
            WorkerStatus::Stopped => {
                let _ = self.invalidate_lifecycle(backend, Some(expected_epoch));
                Err(SpeechError::StateUnavailable)
            }
            WorkerStatus::Ready | WorkerStatus::Unavailable => {
                self.require_enabled_lifecycle(backend, expected_epoch)?;
                Ok(worker)
            }
        }
    }

    pub(super) fn provider_worker_for_epoch(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: u64,
        secret: SecretValue,
    ) -> Result<Arc<ManagedSpeechWorker>, SpeechError> {
        self.enabled_worker_for_epoch(backend, expected_epoch)?;
        let resolution = self.resolve_runtime(backend)?;
        let paths = resolution.paths;
        let mut program = if resolution.managed_runtime.is_some() {
            WorkerProgram::managed_bootstrap(
                &paths.python,
                &paths.bootstrap,
                paths.model.as_deref(),
            )?
        } else {
            WorkerProgram::bootstrap(&paths.python, &paths.bootstrap)?
        };
        if let Some(store) = paths.model_store.as_deref() {
            program = program.with_model_store(store)?;
        }
        let worker = Arc::new(ManagedSpeechWorker {
            worker: LazySpeechWorker::new(program, backend.native())
                .with_provider_secret(secret)
                .with_staging_authority(self.0.staging_authority.clone(), &self.0.work_root),
            managed_runtime: resolution.managed_runtime,
        });
        let mut transient = self
            .0
            .transient_workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        let entries = transient.entry(backend).or_default();
        entries.retain(|entry| entry.strong_count() != 0);
        self.require_enabled_lifecycle(backend, expected_epoch)?;
        entries.push(Arc::downgrade(&worker));
        Ok(worker)
    }

    pub(super) fn commit_voice_inventory_for_epoch(
        &self,
        backend: SpeechBackendRequest,
        epoch: u64,
        voices: Vec<SpeechVoiceResponse>,
    ) -> bool {
        let Ok(slot) = self.lifecycle_slot(backend) else {
            return false;
        };
        let Ok(_commit) = slot.commit_gate.lock() else {
            return false;
        };
        let Ok(mut lifecycle) = slot.state.lock() else {
            return false;
        };
        if lifecycle.epoch != epoch {
            return false;
        }
        lifecycle.enabled = true;
        lifecycle.voices = Some(voices);
        true
    }

    fn detach_backend_runtime(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: Option<u64>,
    ) -> Result<(u64, Vec<Arc<ManagedSpeechWorker>>), SpeechError> {
        let epoch = self.invalidate_lifecycle(backend, expected_epoch)?;
        let mut detached = Vec::new();
        if let Some(cached) = self
            .0
            .workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?
            .remove(&backend)
        {
            detached.push(cached.worker);
        }
        let transient = self
            .0
            .transient_workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?
            .remove(&backend)
            .unwrap_or_default();
        detached.extend(transient.into_iter().filter_map(|worker| worker.upgrade()));
        Ok((epoch, detached))
    }

    pub(super) fn invalidate_backend_runtime(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: Option<u64>,
    ) -> Result<u64, SpeechError> {
        let (epoch, detached) = self.detach_backend_runtime(backend, expected_epoch)?;
        for worker in detached {
            worker.shutdown();
        }
        Ok(epoch)
    }

    /// Returns only inventory captured by an explicit successful Start/probe. This path never
    /// resolves, creates, starts, or transacts with a worker. The generation and live worker checks
    /// make a completed Stop authoritative even when the `WebView` still holds a stale warm snapshot.
    pub(super) fn voice_inventory(
        &self,
        backend: SpeechBackendRequest,
        expected_epoch: u64,
    ) -> Result<SpeechInventoryResponse, SpeechError> {
        if !backend.supports_voice_inventory() {
            return Err(SpeechError::InvalidOption(
                "speech backend does not expose a voice inventory",
            ));
        }
        self.enabled_worker_for_epoch(backend, expected_epoch)?;
        let lifecycle = self.lifecycle(backend)?;
        if lifecycle.epoch != expected_epoch || !lifecycle.enabled {
            return Err(SpeechError::Cancelled);
        }
        let voices = lifecycle.voices.ok_or(SpeechError::StateUnavailable)?;
        self.require_enabled_lifecycle(backend, expected_epoch)?;
        Ok(SpeechInventoryResponse {
            backend,
            epoch: expected_epoch,
            enabled: true,
            warm: true,
            voices,
        })
    }

    pub(super) fn status(&self, backend: SpeechBackendRequest) -> SpeechBackendStatus {
        let resolution = self.resolve_runtime(backend).ok();
        let installed = resolution.is_some();
        let cached = self.0.workers.lock().ok().and_then(|workers| {
            workers
                .get(&backend)
                .map(|cached| (cached.paths.clone(), Arc::clone(&cached.worker)))
        });
        let paths_match = resolution.as_ref().is_some_and(|resolution| {
            cached
                .as_ref()
                .is_some_and(|(paths, _)| *paths == resolution.paths)
        });
        let worker_status = cached.as_ref().map(|(_, worker)| worker.status());
        let lifecycle = self.lifecycle(backend).unwrap_or_default();
        let replacement = cached.is_some() && (!installed || !paths_match);
        let dead =
            lifecycle.enabled && (cached.is_none() || worker_status == Some(WorkerStatus::Stopped));
        let lifecycle = if replacement || dead {
            let _ = self.invalidate_backend_runtime(backend, Some(lifecycle.epoch));
            self.lifecycle(backend).unwrap_or_default()
        } else {
            lifecycle
        };
        let ready = installed && lifecycle.enabled;
        let warm = ready
            && paths_match
            && matches!(
                worker_status,
                Some(WorkerStatus::Ready | WorkerStatus::Unavailable)
            );
        SpeechBackendStatus {
            backend,
            epoch: lifecycle.epoch,
            enabled: lifecycle.enabled,
            installed,
            ready,
            warm,
            requires_reference: backend.requires_reference(),
            supports_voice_inventory: backend.supports_voice_inventory(),
            supports_voice_conversion: backend == SpeechBackendRequest::Chatterbox,
            requires_credential: backend == SpeechBackendRequest::GeminiTts,
        }
    }

    pub(super) fn statuses(&self) -> Vec<SpeechBackendStatus> {
        SpeechBackendRequest::ALL
            .into_iter()
            .map(|backend| self.status(backend))
            .collect()
    }

    pub(super) fn shutdown(&self, backend: SpeechBackendRequest) -> CommandResult<()> {
        self.invalidate_backend_runtime(backend, None)
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?;
        Ok(())
    }

    pub(super) fn begin_shutdown(
        &self,
        backend: SpeechBackendRequest,
    ) -> CommandResult<(SpeechBackendStatus, Vec<Arc<ManagedSpeechWorker>>)> {
        let (_, detached) = self
            .detach_backend_runtime(backend, None)
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?;
        Ok((self.status(backend), detached))
    }

    pub(crate) fn reload_f5_models(&self) -> CommandResult<()> {
        let (_, detached) = self
            .detach_backend_runtime(SpeechBackendRequest::F5Tts, None)
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?;
        tauri::async_runtime::spawn_blocking(move || {
            for worker in detached {
                worker.shutdown();
            }
        });
        Ok(())
    }

    fn quiesce_package(&self, backend: SpeechPackageId) -> Result<(), PackageError> {
        self.shutdown(package_to_speech(backend))
            .map_err(|_| PackageError::StoreUnavailable)
    }
}

impl Deref for ManagedSpeechWorker {
    type Target = LazySpeechWorker;

    fn deref(&self) -> &Self::Target {
        &self.worker
    }
}

impl fmt::Debug for ManagedSpeechWorker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedSpeechWorker")
            .field("worker", &self.worker)
            .field("managed", &self.managed_runtime.is_some())
            .finish()
    }
}

impl fmt::Debug for SpeechPackageCoordinator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechPackageCoordinator")
            .field("runtime", &"<weak-managed>")
            .finish()
    }
}

impl SpeechRuntimeCoordinator for SpeechPackageCoordinator {
    fn quiesce(&self, backend: SpeechPackageId) -> osg_engine_packages::Result<()> {
        let runtime = self.0.upgrade().ok_or(PackageError::StoreUnavailable)?;
        SpeechRuntime(runtime).quiesce_package(backend)
    }
}

impl fmt::Debug for SpeechRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Status resolves managed runtimes and may invalidate workers; Debug must stay inert.
        formatter
            .debug_struct("SpeechRuntime")
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for WorkerPaths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerPaths")
            .field("python", &"<redacted>")
            .field("bootstrap", &"<redacted>")
            .field("model", &self.model.as_ref().map(|_| "<redacted>"))
            .field(
                "model_store",
                &self.model_store.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

pub(super) fn canonical_directory(value: Option<PathBuf>) -> Option<PathBuf> {
    value
        .and_then(|path| fs::canonicalize(path).ok())
        .filter(|path| path.is_dir())
}

fn canonical_regular_file(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?;
    let path = fs::canonicalize(path.parent()?).ok()?.join(name);
    path.is_file().then_some(path)
}

pub(super) fn verified_worker(path: &Path) -> Option<PathBuf> {
    let canonical = canonical_regular_file(path)?;
    let bytes = fs::read(&canonical).ok()?;
    (bytes.as_slice() == WORKER_BYTES).then_some(canonical)
}
