use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use osg_domain::{
    AssetId, JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate, ProjectId,
};
use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, InstalledSpeechRuntime, PackageError,
    SpeechPackageId, SpeechPackageManager, SpeechRuntimeCoordinator,
};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
    ContentHash, Database, DatabaseError, ProjectSpeechReference, ProjectSpeechReferenceWrite,
};
use osg_media::{
    AudioBitrate, AudioExtractionPlan, AudioOutput, AudioSampleRate,
    CancellationToken as MediaCancellationToken, ChannelCount, FfmpegProgress,
    MAX_NARRATION_MIX_INPUTS, MediaError, MediaInput, MediaOperation, MediaOutput, MediaTimeRange,
    NarrationAudioEditPlan as MediaAudioEditPlan, NarrationMixClip as MediaMixClip,
    NarrationMixPlan as MediaMixPlan, ProgressSink, RunControl as MediaRunControl,
};
use osg_media_server::RegisteredMedia;
use osg_runtime_staging::{
    OwnedStagingDirectory, OwnedStagingFile, RuntimeStagingAuthority, StagingKind,
};
use osg_speech::{
    AlignmentPlan, AlignmentPolicy, AudioAsset, AudioEditPlan as SpeechAudioEditPlan, AudioFilter,
    AudioFormat, CancellationToken, ChatterboxSettings, EdgeSettings, F5Settings, GeminiSettings,
    GttsDomain, GttsSettings, LanguageTag, LazySpeechWorker, ModelId, NarrationBatch,
    NarrationClip, NormalizedPoint, NormalizedTrim, ReferencePreparationPlan, RunControl,
    SecretValue, SegmentId, SpeechArtifact, SpeechBackend, SpeechError, SpeechOutput, SpeechPhase,
    SpeechProgress, SpeechText, SpeedFactor, SynthesisRequest, SynthesisSettings, TimeMicros,
    VoiceConversionRequest, VoiceGender, VoiceId, WorkerProgram, WorkerStatus,
};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, ipc::Channel};
#[cfg(test)]
use tempfile::TempDir;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

use crate::background;
use crate::diagnostics;
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::media_export::copy_export;
use crate::state::DesktopState;

pub(crate) const WORKER_BYTES: &[u8] =
    include_bytes!("../../../../crates/osg-speech/worker/osg_speech_worker.py");
const SPEECH_TIMEOUT: Duration = Duration::from_hours(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const REFERENCE_PREPARE_TIMEOUT: Duration = Duration::from_mins(10);
const REFERENCE_EXTRACTION_TIMEOUT: Duration = Duration::from_mins(5);
const NARRATION_EDIT_TIMEOUT: Duration = Duration::from_mins(10);
const MAX_SEGMENTS: usize = 1_000;
const MAX_BATCH_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEGMENT_TEXT_CHARACTERS: usize = 8_000;
const MAX_CHATTERBOX_TEXT_CHARACTERS: usize = 300;
const MAX_REFERENCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONVERSION_INPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPORT_ARCHIVE_BYTES: u64 = MAX_CONVERSION_INPUT_BYTES + 16 * 1024 * 1024;
const MAX_EXPORT_FILE_NAME_BYTES: usize = 128;
const MAX_ALIGNMENT_INPUT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ALIGNMENT_DURATION_MICROS: u64 = 4 * 60 * 60 * 1_000_000;
const ALIGNMENT_TIMEOUT: Duration = Duration::from_hours(2);
const ALIGNMENT_MANIFEST_SCOPE: &str = "speechAlignmentJobs";
const ALIGNMENT_MANIFEST_SCHEMA_VERSION: u32 = 2;
const PROJECT_NARRATION_SCOPE: &str = "projectNarration";
const PROJECT_NARRATION_SCHEMA_VERSION: u32 = 1;
const MAX_F5_REFERENCE_MS: u64 = 12_000;
const MAX_CHATTERBOX_REFERENCE_MS: u64 = 60_000;
const MANIFEST_SCOPE: &str = "speechJobs";
const MANIFEST_SCHEMA_VERSION: u32 = 2;
const MAX_LIFECYCLE_EPOCH: u64 = 9_007_199_254_740_991;
const CHATTERBOX_LANGUAGES: &[&str] = &[
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no",
    "pl", "pt", "ru", "sv", "sw", "tr", "zh",
];
pub(crate) const F5_MODEL_IDS: &[&str] = &[
    "f5tts-v1-base", "F5TTS_v1_Base", "f5tts-spanish", "f5tts-russian",
    "f5tts-portuguese-br", "f5tts-italian", "f5tts-vietnamese-vivoice",
    "f5tts-german", "f5tts-finnish", "f5tts-polish",
];

#[derive(Clone)]
pub(crate) struct SpeechRuntime(Arc<SpeechRuntimeInner>);

#[derive(Clone)]
pub(crate) struct SpeechPackageCoordinator(Weak<SpeechRuntimeInner>);

struct SpeechRuntimeInner {
    install_root: PathBuf,
    model_store: PathBuf,
    work_root: PathBuf,
    staging_authority: RuntimeStagingAuthority,
    resource_root: Option<PathBuf>,
    package_manager: RwLock<Option<SpeechPackageManager>>,
    workers: Mutex<HashMap<SpeechBackendRequest, CachedWorker>>,
    transient_workers: Mutex<HashMap<SpeechBackendRequest, Vec<Weak<ManagedSpeechWorker>>>>,
    artifact_publication_gates: Mutex<HashMap<SpeechArtifactPublicationKey, Weak<Mutex<()>>>>,
    lifecycles: Mutex<HashMap<SpeechBackendRequest, Arc<BackendLifecycleSlot>>>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct SpeechArtifactPublicationKey {
    kind: String,
    content_hash: Vec<u8>,
}

#[derive(Default)]
struct BackendLifecycleSlot {
    commit_gate: Mutex<()>,
    state: Mutex<BackendLifecycle>,
}

#[derive(Clone, PartialEq, Eq)]
struct WorkerPaths {
    python: PathBuf,
    bootstrap: PathBuf,
    model: Option<PathBuf>,
    model_store: Option<PathBuf>,
}

struct CachedWorker {
    paths: WorkerPaths,
    worker: Arc<ManagedSpeechWorker>,
}

#[derive(Clone, Default)]
struct BackendLifecycle {
    epoch: u64,
    enabled: bool,
    voices: Option<Vec<SpeechVoiceResponse>>,
    cancellation: CancellationToken,
}

struct ManagedSpeechWorker {
    worker: LazySpeechWorker,
    managed_runtime: Option<Arc<InstalledSpeechRuntime>>,
}

struct RuntimeResolution {
    paths: WorkerPaths,
    managed_runtime: Option<Arc<InstalledSpeechRuntime>>,
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

    fn work_directory(&self) -> io::Result<OwnedStagingDirectory> {
        OwnedStagingDirectory::begin(
            &self.0.staging_authority,
            &self.0.work_root,
            StagingKind::SpeechJob,
        )
    }

    fn resolve_runtime(
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

    fn lifecycle_slot(
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

    fn lifecycle(&self, backend: SpeechBackendRequest) -> Result<BackendLifecycle, SpeechError> {
        self.lifecycle_slot(backend)?
            .state
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)
            .map(|lifecycle| lifecycle.clone())
    }

    fn lifecycle_epoch(&self, backend: SpeechBackendRequest) -> Result<u64, SpeechError> {
        self.lifecycle(backend).map(|lifecycle| lifecycle.epoch)
    }

    fn artifact_publication_gate(
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

    fn invalidate_lifecycle(
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

    fn require_enabled_lifecycle(
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

    fn lifecycle_cancellation(
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
    fn invalidate_replacement_before_shutdown<F>(
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

    fn worker_for_probe<F>(
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

    fn enabled_worker_for_epoch(
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

    fn provider_worker_for_epoch(
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

    fn commit_voice_inventory_for_epoch(
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

    fn invalidate_backend_runtime(
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
    fn voice_inventory(
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

    fn status(&self, backend: SpeechBackendRequest) -> SpeechBackendStatus {
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

    fn statuses(&self) -> Vec<SpeechBackendStatus> {
        SpeechBackendRequest::ALL
            .into_iter()
            .map(|backend| self.status(backend))
            .collect()
    }

    fn shutdown(&self, backend: SpeechBackendRequest) -> CommandResult<()> {
        self.invalidate_backend_runtime(backend, None)
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?;
        Ok(())
    }

    fn begin_shutdown(
        &self,
        backend: SpeechBackendRequest,
    ) -> CommandResult<(SpeechBackendStatus, Vec<Arc<ManagedSpeechWorker>>)> {
        let (_, detached) = self
            .detach_backend_runtime(backend, None)
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?;
        Ok((self.status(backend), detached))
    }

    pub(crate) fn reload_f5_models(&self) -> CommandResult<()> {
        let (_, detached) = self.begin_shutdown(SpeechBackendRequest::F5Tts)?;
        tauri::async_runtime::spawn_blocking(move || {
            for worker in detached { worker.shutdown(); }
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
        formatter
            .debug_struct("SpeechRuntime")
            .field("paths", &"<redacted>")
            .field("statuses", &self.statuses())
            .finish()
    }
}

impl fmt::Debug for WorkerPaths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerPaths")
            .field("python", &"<redacted>")
            .field("bootstrap", &"<redacted>")
            .field("model", &self.model.as_ref().map(|_| "<redacted>"))
            .field("model_store", &self.model_store.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

fn canonical_directory(value: Option<PathBuf>) -> Option<PathBuf> {
    value
        .and_then(|path| fs::canonicalize(path).ok())
        .filter(|path| path.is_dir())
}

fn canonical_regular_file(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?;
    let path = fs::canonicalize(path.parent()?).ok()?.join(name);
    path.is_file().then_some(path)
}

fn verified_worker(path: &Path) -> Option<PathBuf> {
    let canonical = canonical_regular_file(path)?;
    let bytes = fs::read(&canonical).ok()?;
    (bytes.as_slice() == WORKER_BYTES).then_some(canonical)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechBackendRequest {
    F5Tts,
    Chatterbox,
    EdgeTts,
    Gtts,
    GeminiTts,
}

impl SpeechBackendRequest {
    const ALL: [Self; 5] = [
        Self::F5Tts,
        Self::Chatterbox,
        Self::EdgeTts,
        Self::Gtts,
        Self::GeminiTts,
    ];

    const fn native(self) -> SpeechBackend {
        match self {
            Self::F5Tts => SpeechBackend::F5Tts,
            Self::Chatterbox => SpeechBackend::Chatterbox,
            Self::EdgeTts => SpeechBackend::EdgeTts,
            Self::Gtts => SpeechBackend::Gtts,
            Self::GeminiTts => SpeechBackend::GeminiLive,
        }
    }

    const fn package(self) -> SpeechPackageId {
        match self {
            Self::F5Tts => SpeechPackageId::F5Tts,
            Self::Chatterbox => SpeechPackageId::Chatterbox,
            Self::EdgeTts => SpeechPackageId::EdgeTts,
            Self::Gtts => SpeechPackageId::Gtts,
            Self::GeminiTts => SpeechPackageId::GeminiTts,
        }
    }

    const fn requires_reference(self) -> bool {
        matches!(self, Self::F5Tts | Self::Chatterbox)
    }

    const fn supports_voice_inventory(self) -> bool {
        matches!(self, Self::EdgeTts | Self::Gtts | Self::GeminiTts)
    }

    const fn maximum_text_characters(self) -> usize {
        match self {
            Self::Chatterbox => MAX_CHATTERBOX_TEXT_CHARACTERS,
            _ => MAX_SEGMENT_TEXT_CHARACTERS,
        }
    }
}

const fn package_to_speech(backend: SpeechPackageId) -> SpeechBackendRequest {
    match backend {
        SpeechPackageId::F5Tts => SpeechBackendRequest::F5Tts,
        SpeechPackageId::Chatterbox => SpeechBackendRequest::Chatterbox,
        SpeechPackageId::EdgeTts => SpeechBackendRequest::EdgeTts,
        SpeechPackageId::Gtts => SpeechBackendRequest::Gtts,
        SpeechPackageId::GeminiTts => SpeechBackendRequest::GeminiTts,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "these independent capability flags are a stable path-free wire contract"
)]
pub(crate) struct SpeechBackendStatus {
    backend: SpeechBackendRequest,
    epoch: u64,
    enabled: bool,
    installed: bool,
    ready: bool,
    warm: bool,
    requires_reference: bool,
    supports_voice_inventory: bool,
    supports_voice_conversion: bool,
    requires_credential: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechStatusResponse {
    backends: Vec<SpeechBackendStatus>,
    max_segments_per_job: usize,
    max_batch_text_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechVoiceResponse {
    id: String,
    display_name: String,
    language: String,
    gender: SpeechVoiceGenderResponse,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum SpeechVoiceGenderResponse {
    Female,
    Male,
    Neutral,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechProbeResponse {
    status: SpeechBackendStatus,
    voices: Vec<SpeechVoiceResponse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechInventoryResponse {
    backend: SpeechBackendRequest,
    epoch: u64,
    enabled: bool,
    warm: bool,
    voices: Vec<SpeechVoiceResponse>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechSegmentRequest {
    id: String,
    text: String,
}

impl fmt::Debug for SpeechSegmentRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechSegmentRequest")
            .field("id", &self.id)
            .field("text", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "backend",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SpeechProfileRequest {
    F5Tts {
        reference_text: Option<String>,
        model: Option<String>,
        speech_rate_milli: u16,
        nfe_steps: u8,
        sway_milli: i16,
        guidance_milli: u16,
        seed: Option<u64>,
        remove_silence: bool,
    },
    Chatterbox {
        language: String,
        exaggeration_milli: u16,
        cfg_weight_milli: u16,
    },
    EdgeTts {
        voice: String,
        rate_percent: i8,
        volume_percent: i8,
        pitch_hz: i8,
    },
    Gtts {
        language: String,
        domain: GttsDomainRequest,
        slow: bool,
    },
    GeminiTts {
        credential_id: CredentialId,
        model: String,
        voice: String,
        language: String,
    },
}

impl fmt::Debug for SpeechProfileRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechProfileRequest")
            .field("backend", &self.backend())
            .field("settings", &"<redacted>")
            .finish()
    }
}

impl SpeechProfileRequest {
    const fn backend(&self) -> SpeechBackendRequest {
        match self {
            Self::F5Tts { .. } => SpeechBackendRequest::F5Tts,
            Self::Chatterbox { .. } => SpeechBackendRequest::Chatterbox,
            Self::EdgeTts { .. } => SpeechBackendRequest::EdgeTts,
            Self::Gtts { .. } => SpeechBackendRequest::Gtts,
            Self::GeminiTts { .. } => SpeechBackendRequest::GeminiTts,
        }
    }

    fn credential_id(&self) -> Option<CredentialId> {
        match self {
            Self::GeminiTts { credential_id, .. } => Some(*credential_id),
            _ => None,
        }
    }

    fn into_native(self) -> Result<SynthesisSettings, SpeechError> {
        Ok(match self {
            Self::F5Tts {
                reference_text,
                model,
                speech_rate_milli,
                nfe_steps,
                sway_milli,
                guidance_milli,
                seed,
                remove_silence,
            } => {
                if model
                    .as_deref()
                    .is_some_and(|model| !F5_MODEL_IDS.contains(&model))
                {
                    return Err(SpeechError::InvalidOption("unsupported F5 model ID"));
                }
                let settings = match reference_text {
                    Some(text) => F5Settings::new(SpeechText::new(text)?),
                    None => F5Settings::transcribe_reference(),
                };
                let settings = settings
                    .with_speech_rate_milli(speech_rate_milli)?
                    .with_nfe_steps(nfe_steps)?
                    .with_sway_milli(sway_milli)?
                    .with_guidance_milli(guidance_milli)?
                    .with_seed(seed)
                    .with_remove_silence(remove_silence);
                let settings = match model {
                    Some(model) => settings.with_model(ModelId::new(model)?),
                    None => settings,
                };
                SynthesisSettings::F5Tts(settings)
            }
            Self::Chatterbox {
                language,
                exaggeration_milli,
                cfg_weight_milli,
            } => {
                let language = language.to_ascii_lowercase();
                if !CHATTERBOX_LANGUAGES.contains(&language.as_str()) {
                    return Err(SpeechError::InvalidOption(
                        "unsupported Chatterbox language",
                    ));
                }
                SynthesisSettings::Chatterbox(ChatterboxSettings::new(
                    LanguageTag::new(language)?,
                    exaggeration_milli,
                    cfg_weight_milli,
                )?)
            }
            Self::EdgeTts {
                voice,
                rate_percent,
                volume_percent,
                pitch_hz,
            } => SynthesisSettings::EdgeTts(EdgeSettings::new(
                VoiceId::new(voice)?,
                rate_percent,
                volume_percent,
                pitch_hz,
            )?),
            Self::Gtts {
                language,
                domain,
                slow,
            } => SynthesisSettings::Gtts(GttsSettings::new(
                LanguageTag::new(language)?,
                domain.into(),
                slow,
            )),
            Self::GeminiTts {
                model,
                voice,
                language,
                ..
            } => {
                if !matches!(
                    model.as_str(),
                    "gemini-3.1-flash-live-preview"
                        | "gemini-2.5-flash-native-audio-preview-12-2025"
                ) {
                    return Err(SpeechError::InvalidOption(
                        "unsupported Gemini speech model ID",
                    ));
                }
                SynthesisSettings::GeminiLive(GeminiSettings::new(
                    ModelId::new(model)?,
                    VoiceId::new(voice)?,
                    LanguageTag::new(language)?,
                ))
            }
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum GttsDomainRequest {
    #[serde(rename = "com")]
    Com,
    #[serde(rename = "com.au")]
    ComAu,
    #[serde(rename = "co.uk")]
    CoUk,
    #[serde(rename = "us")]
    Us,
    #[serde(rename = "ca")]
    Ca,
    #[serde(rename = "co.in")]
    CoIn,
    #[serde(rename = "ie")]
    Ie,
    #[serde(rename = "co.za")]
    CoZa,
    #[serde(rename = "com.br")]
    ComBr,
    #[serde(rename = "pt")]
    Pt,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "com.mx")]
    ComMx,
    #[serde(rename = "fr")]
    Fr,
}

impl From<GttsDomainRequest> for GttsDomain {
    fn from(value: GttsDomainRequest) -> Self {
        match value {
            GttsDomainRequest::Com => Self::Com,
            GttsDomainRequest::ComAu => Self::ComAu,
            GttsDomainRequest::CoUk => Self::CoUk,
            GttsDomainRequest::Us => Self::Us,
            GttsDomainRequest::Ca => Self::Ca,
            GttsDomainRequest::CoIn => Self::CoIn,
            GttsDomainRequest::Ie => Self::Ie,
            GttsDomainRequest::CoZa => Self::CoZa,
            GttsDomainRequest::ComBr => Self::ComBr,
            GttsDomainRequest::Pt => Self::Pt,
            GttsDomainRequest::Es => Self::Es,
            GttsDomainRequest::ComMx => Self::ComMx,
            GttsDomainRequest::Fr => Self::Fr,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechStartRequest {
    project_id: ProjectId,
    expected_project_state_version: u64,
    segments: Vec<SpeechSegmentRequest>,
    profile: SpeechProfileRequest,
    reference_artifact_id: Option<String>,
    lifecycle_epoch: u64,
}

impl fmt::Debug for SpeechStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechStartRequest")
            .field("project_id", &"<opaque>")
            .field(
                "expected_project_state_version",
                &self.expected_project_state_version,
            )
            .field("segment_count", &self.segments.len())
            .field("profile", &self.profile)
            .field("lifecycle_epoch", &self.lifecycle_epoch)
            .field(
                "reference_artifact_id",
                &self.reference_artifact_id.as_ref().map(|_| "<opaque>"),
            )
            .finish()
    }
}

struct ValidatedSpeechStart {
    project_id: ProjectId,
    expected_project_state_version: u64,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    requests: Vec<SynthesisRequest>,
    reference: Option<AudioAsset>,
    credential_id: Option<CredentialId>,
}

impl SpeechStartRequest {
    fn validate(self, reference: Option<AudioAsset>) -> Result<ValidatedSpeechStart, SpeechError> {
        if self.segments.is_empty() || self.segments.len() > MAX_SEGMENTS {
            return Err(SpeechError::InvalidInput("invalid narration segment count"));
        }
        let backend = self.profile.backend();
        if self.lifecycle_epoch > MAX_LIFECYCLE_EPOCH {
            return Err(SpeechError::InvalidInput(
                "speech lifecycle epoch is invalid",
            ));
        }
        if self.expected_project_state_version > i64::MAX as u64 {
            return Err(SpeechError::InvalidInput(
                "speech project state version is invalid",
            ));
        }
        if backend.requires_reference() != reference.is_some() {
            return Err(SpeechError::InvalidInput(
                "reference capability does not match the speech backend",
            ));
        }
        let credential_id = self.profile.credential_id();
        let settings = self.profile.into_native()?;
        let maximum_characters = backend.maximum_text_characters();
        let mut total_bytes = 0_usize;
        let mut requests = Vec::with_capacity(self.segments.len());
        for segment in self.segments {
            if segment.text.chars().take(maximum_characters + 1).count() > maximum_characters {
                return Err(SpeechError::InvalidInput(
                    "narration segment text is too long",
                ));
            }
            total_bytes = total_bytes
                .checked_add(segment.text.len())
                .ok_or(SpeechError::InvalidInput("narration batch is too large"))?;
            if total_bytes > MAX_BATCH_TEXT_BYTES {
                return Err(SpeechError::InvalidInput("narration batch is too large"));
            }
            requests.push(SynthesisRequest::new(
                SegmentId::new(segment.id)?,
                SpeechText::new(segment.text)?,
                settings.clone(),
                reference.clone(),
            )?);
        }
        let requests = NarrationBatch::new(requests)?.into_requests();
        Ok(ValidatedSpeechStart {
            project_id: self.project_id,
            expected_project_state_version: self.expected_project_state_version,
            backend,
            lifecycle_epoch: self.lifecycle_epoch,
            requests,
            reference,
            credential_id,
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechReferenceBackend {
    F5Tts,
    Chatterbox,
}

impl SpeechReferenceBackend {
    const fn maximum_duration_ms(self) -> u64 {
        match self {
            Self::F5Tts => MAX_F5_REFERENCE_MS,
            Self::Chatterbox => MAX_CHATTERBOX_REFERENCE_MS,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceExtractRequest {
    backend: SpeechReferenceBackend,
    start_ms: u64,
    end_ms: u64,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceSelectRequest {
    backend: SpeechReferenceBackend,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceImportRequest {
    backend: SpeechReferenceBackend,
    asset_id: AssetId,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceProjectRequest {
    project_id: ProjectId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceCommitRequest {
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
    artifact_id: String,
    transcript: String,
    language: String,
    delivery_job_id: Option<JobId>,
    delivery_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceClearRequest {
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactEditRequest {
    artifact_id: String,
    project_id: ProjectId,
    expected_project_state_version: u64,
    normalized_start_millionths: u32,
    normalized_end_millionths: u32,
    speed_milli: u16,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactExportEntry {
    artifact_id: String,
    file_name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactExportRequest {
    entries: Vec<SpeechArtifactExportEntry>,
    archive_name: Option<String>,
}

impl fmt::Debug for SpeechArtifactExportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechArtifactExportRequest")
            .field("entry_count", &self.entries.len())
            .field("archive", &self.archive_name.is_some())
            .finish()
    }
}

impl fmt::Debug for SpeechArtifactEditRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechArtifactEditRequest")
            .field("artifact_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .field(
                "expected_project_state_version",
                &self.expected_project_state_version,
            )
            .field(
                "normalized_start_millionths",
                &self.normalized_start_millionths,
            )
            .field("normalized_end_millionths", &self.normalized_end_millionths)
            .field("speed_milli", &self.speed_milli)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechVoiceConversionStartRequest {
    input_artifact_id: String,
    target_voice_artifact_id: String,
    lifecycle_epoch: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechAlignmentClipRequest {
    id: String,
    artifact_id: String,
    start_micros: u64,
    cue_end_micros: u64,
}

impl fmt::Debug for SpeechAlignmentClipRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechAlignmentClipRequest")
            .field("id", &self.id)
            .field("artifact_id", &"<opaque>")
            .field("start_micros", &self.start_micros)
            .field("cue_end_micros", &self.cue_end_micros)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechAlignmentStartRequest {
    project_id: ProjectId,
    expected_project_state_version: u64,
    clips: Vec<SpeechAlignmentClipRequest>,
}

impl fmt::Debug for SpeechAlignmentStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechAlignmentStartRequest")
            .field("project_id", &"<opaque>")
            .field(
                "expected_project_state_version",
                &self.expected_project_state_version,
            )
            .field("clip_count", &self.clips.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SpeechArtifactFormatResponse {
    Wav,
    Mp3,
    M4a,
}

impl From<AudioFormat> for SpeechArtifactFormatResponse {
    fn from(value: AudioFormat) -> Self {
        match value {
            AudioFormat::Wav => Self::Wav,
            AudioFormat::Mp3 => Self::Mp3,
            AudioFormat::M4a => Self::M4a,
        }
    }
}

impl SpeechArtifactFormatResponse {
    const fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactDescriptor {
    artifact_id: String,
    format: SpeechArtifactFormatResponse,
    bytes: u64,
    duration_micros: Option<u64>,
    sample_rate_hz: Option<u32>,
    channels: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechArtifactEditResponse {
    project_id: ProjectId,
    expected_project_state_version: u64,
    artifact: SpeechArtifactDescriptor,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
enum SpeechNarrationCueId {
    Number(i64),
    Text(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechNarrationSource {
    Original,
    Translated,
    Grouped,
}

impl SpeechNarrationSource {
    const fn storage_key(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Translated => "translated",
            Self::Grouped => "grouped",
        }
    }
}

fn project_narration_storage_key(project_id: ProjectId, source: SpeechNarrationSource) -> String {
    format!("{project_id}:{}", source.storage_key())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechProjectNarrationResultRequest {
    subtitle_id: SpeechNarrationCueId,
    text: String,
    artifact_id: String,
    method: String,
    output_index: Option<u32>,
    original_ids: Vec<SpeechNarrationCueId>,
    start_micros: u64,
    end_micros: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechProjectNarrationPutRequest {
    project_id: ProjectId,
    expected_project_state_version: u64,
    source: SpeechNarrationSource,
    results: Vec<SpeechProjectNarrationResultRequest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProjectNarrationResult {
    subtitle_id: SpeechNarrationCueId,
    text: String,
    artifact_id: String,
    method: String,
    output_index: Option<u32>,
    original_ids: Vec<SpeechNarrationCueId>,
    start_micros: u64,
    end_micros: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProjectNarration {
    schema_version: u32,
    project_id: ProjectId,
    project_state_version: u64,
    source: SpeechNarrationSource,
    results: Vec<StoredProjectNarrationResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechProjectNarrationResultResponse {
    subtitle_id: SpeechNarrationCueId,
    text: String,
    artifact: SpeechArtifactDescriptor,
    method: String,
    output_index: Option<u32>,
    original_ids: Vec<SpeechNarrationCueId>,
    start_micros: u64,
    end_micros: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechProjectNarrationResponse {
    schema_version: u32,
    project_id: ProjectId,
    project_state_version: u64,
    source: SpeechNarrationSource,
    results: Vec<SpeechProjectNarrationResultResponse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechPlayableArtifact {
    artifact: SpeechArtifactDescriptor,
    playback: RegisteredMedia,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechReferenceRecordResponse {
    schema_version: u32,
    project_id: ProjectId,
    project_state_version: u64,
    reference_version: u64,
    artifact_id: String,
    transcript: String,
    language: String,
    pending_delivery: Option<SpeechReferenceDeliveryResponse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechReferenceDeliveryResponse {
    job_id: JobId,
    delivery_id: Uuid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechReferencePlayableResponse {
    reference: SpeechReferenceRecordResponse,
    playable: SpeechPlayableArtifact,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechAlignmentResult {
    artifact: SpeechArtifactDescriptor,
    clip_count: usize,
    adjusted_count: usize,
    requested_duration_micros: u64,
    natural_duration_micros: u64,
    rendered_duration_micros: u64,
    maximum_shift_micros: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechAlignmentFailureCode {
    Cancelled,
    ProjectChanged,
    InvalidRequest,
    RuntimeUnavailable,
    TimedOut,
    MediaFailed,
    ArtifactStorage,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechAlignmentPhase {
    Planning,
    Mixing,
    Publishing,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechAlignmentManifest {
    schema_version: u32,
    project_id: ProjectId,
    expected_project_state_version: u64,
    result: Option<SpeechAlignmentResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechAlignmentResultResponse {
    job: JobSnapshot,
    project_id: ProjectId,
    expected_project_state_version: u64,
    result: Option<SpeechAlignmentResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SpeechAlignmentEvent {
    Progress {
        job_id: JobId,
        phase: SpeechAlignmentPhase,
        fraction_millionths: u32,
    },
    Completed {
        job: JobSnapshot,
        project_id: ProjectId,
        expected_project_state_version: u64,
        result: SpeechAlignmentResult,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        code: SpeechAlignmentFailureCode,
    },
}

#[derive(Clone)]
struct AlignmentRenderClip {
    input: MediaInput,
    start_micros: u64,
    end_micros: u64,
}

#[derive(Clone, Copy)]
struct AlignmentResultStats {
    clip_count: usize,
    adjusted_count: usize,
    requested_duration_micros: u64,
    natural_duration_micros: u64,
    rendered_duration_micros: u64,
    maximum_shift_micros: u64,
}

struct ValidatedAlignmentStart {
    project_id: ProjectId,
    expected_project_state_version: u64,
    clips: Vec<AlignmentRenderClip>,
    stats: AlignmentResultStats,
}

struct ResolvedAlignmentClip {
    id_key: String,
    media_input: MediaInput,
    native_clip: NarrationClip,
    project_id: ProjectId,
    bytes: u64,
}

fn resolve_alignment_request_clip(
    database: &Database,
    request: SpeechAlignmentClipRequest,
) -> CommandResult<ResolvedAlignmentClip> {
    let id = SegmentId::new(request.id)
        .map_err(|_| CommandError::invalid_input("The alignment segment identifier is invalid."))?;
    if request.start_micros > MAX_ALIGNMENT_DURATION_MICROS
        || request.cue_end_micros > MAX_ALIGNMENT_DURATION_MICROS
        || request.cue_end_micros < request.start_micros
    {
        return Err(CommandError::invalid_input(
            "The alignment timing is invalid or exceeds four hours.",
        ));
    }
    let (asset, media_input, descriptor, project_id) =
        resolve_alignment_audio(database, &request.artifact_id)?;
    let project_id = project_id.ok_or_else(|| {
        CommandError::invalid_input("Narration alignment requires project-owned audio.")
    })?;
    let measured_duration = descriptor.duration_micros.ok_or_else(|| {
        CommandError::invalid_input("The narration clip has no measured duration.")
    })?;
    if measured_duration == 0 || measured_duration > MAX_ALIGNMENT_DURATION_MICROS {
        return Err(CommandError::invalid_input(
            "The narration clip duration is invalid or exceeds four hours.",
        ));
    }
    let id_key = id.as_str().to_owned();
    let native_clip = NarrationClip::new(
        id,
        asset,
        TimeMicros::new(request.start_micros)
            .map_err(|_| CommandError::invalid_input("The alignment start time is invalid."))?,
        TimeMicros::new(request.cue_end_micros)
            .map_err(|_| CommandError::invalid_input("The alignment cue end is invalid."))?,
        TimeMicros::new(measured_duration)
            .map_err(|_| CommandError::invalid_input("The narration clip duration is invalid."))?,
    )
    .map_err(|_| CommandError::invalid_input("The alignment clip is invalid."))?;
    Ok(ResolvedAlignmentClip {
        id_key,
        media_input,
        native_clip,
        project_id,
        bytes: descriptor.bytes,
    })
}

fn validate_alignment_start(
    database: &Database,
    request: SpeechAlignmentStartRequest,
) -> CommandResult<ValidatedAlignmentStart> {
    if request.expected_project_state_version > i64::MAX as u64 {
        return Err(CommandError::invalid_input(
            "The narration alignment project state version is invalid.",
        ));
    }
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    if request.clips.is_empty() || request.clips.len() > MAX_SEGMENTS {
        return Err(CommandError::invalid_input(
            "Alignment requires between one and 1000 narration clips.",
        ));
    }

    let mut input_bytes = 0_u64;
    let mut native_clips = Vec::with_capacity(request.clips.len());
    let mut media_inputs = HashMap::with_capacity(request.clips.len());
    let mut project_id = None;
    for request_clip in request.clips {
        let resolved = resolve_alignment_request_clip(database, request_clip)?;
        match project_id {
            None => project_id = Some(resolved.project_id),
            Some(owner) if owner == resolved.project_id => {}
            Some(_) => {
                return Err(CommandError::invalid_input(
                    "Narration alignment cannot combine audio from different projects.",
                ));
            }
        }
        input_bytes = input_bytes
            .checked_add(resolved.bytes)
            .filter(|bytes| *bytes <= MAX_ALIGNMENT_INPUT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The alignment audio exceeds the safe input limit.")
            })?;
        if media_inputs
            .insert(resolved.id_key, resolved.media_input)
            .is_some()
        {
            return Err(CommandError::invalid_input(
                "The alignment contains a duplicate segment identifier.",
            ));
        }
        native_clips.push(resolved.native_clip);
    }

    let plan = AlignmentPlan::build(native_clips, AlignmentPolicy::default())
        .map_err(|_| CommandError::invalid_input("The narration alignment plan is invalid."))?;
    if plan.stats().rendered_duration().get() > MAX_ALIGNMENT_DURATION_MICROS {
        return Err(CommandError::invalid_input(
            "The aligned narration would exceed four hours.",
        ));
    }
    let clips = plan
        .clips()
        .iter()
        .map(|clip| {
            let input = media_inputs.remove(clip.id().as_str()).ok_or_else(|| {
                CommandError::internal("The alignment input plan is inconsistent.")
            })?;
            Ok(AlignmentRenderClip {
                input,
                start_micros: clip.start().get(),
                end_micros: clip.end().get(),
            })
        })
        .collect::<CommandResult<Vec<_>>>()?;
    let stats = AlignmentResultStats {
        clip_count: plan.stats().clip_count(),
        adjusted_count: plan.stats().adjusted_count(),
        requested_duration_micros: plan.stats().requested_duration().get(),
        natural_duration_micros: plan.stats().natural_duration().get(),
        rendered_duration_micros: plan.stats().rendered_duration().get(),
        maximum_shift_micros: plan.stats().maximum_shift().get(),
    };
    let resolved_project_id = project_id.ok_or_else(|| {
        CommandError::invalid_input("Narration alignment requires a durable project.")
    })?;
    if resolved_project_id != request.project_id {
        return Err(CommandError::invalid_input(
            "Narration alignment audio does not belong to the requested project.",
        ));
    }
    Ok(ValidatedAlignmentStart {
        project_id: resolved_project_id,
        expected_project_state_version: request.expected_project_state_version,
        clips,
        stats,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechFailureCode {
    Cancelled,
    ProjectChanged,
    InvalidRequest,
    RuntimeUnavailable,
    ModelUnavailable,
    ProviderUnavailable,
    ProviderRateLimited,
    AuthenticationFailed,
    ReferenceRejected,
    SynthesisFailed,
    EncodingFailed,
    TimedOut,
    WorkerFailed,
    ArtifactStorage,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StoredSpeechResult {
    Completed {
        segment_id: String,
        artifact: SpeechArtifactDescriptor,
    },
    Failed {
        segment_id: String,
        code: SpeechFailureCode,
        retryable: bool,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechJobManifest {
    schema_version: u32,
    backend: SpeechBackendRequest,
    project_id: Option<ProjectId>,
    expected_project_state_version: Option<u64>,
    results: Vec<StoredSpeechResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechJobResultsResponse {
    job: JobSnapshot,
    backend: SpeechBackendRequest,
    project_id: Option<ProjectId>,
    expected_project_state_version: Option<u64>,
    results: Vec<StoredSpeechResult>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechPhaseResponse {
    StartingWorker,
    LoadingModel,
    Synthesizing,
    Encoding,
    Publishing,
}

impl From<SpeechPhase> for SpeechPhaseResponse {
    fn from(value: SpeechPhase) -> Self {
        match value {
            SpeechPhase::StartingWorker => Self::StartingWorker,
            SpeechPhase::LoadingModel => Self::LoadingModel,
            SpeechPhase::Synthesizing => Self::Synthesizing,
            SpeechPhase::Encoding => Self::Encoding,
            SpeechPhase::Publishing => Self::Publishing,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SpeechJobEvent {
    Progress {
        job_id: JobId,
        segment_id: Option<String>,
        index: usize,
        total: usize,
        phase: SpeechPhaseResponse,
        fraction_millionths: u32,
    },
    SegmentCompleted {
        job_id: JobId,
        index: usize,
        total: usize,
        result: StoredSpeechResult,
    },
    SegmentFailed {
        job_id: JobId,
        index: usize,
        total: usize,
        result: StoredSpeechResult,
    },
    Completed {
        job: JobSnapshot,
        results: Vec<StoredSpeechResult>,
    },
    Cancelled {
        job: JobSnapshot,
        results: Vec<StoredSpeechResult>,
    },
    Failed {
        job: Option<JobSnapshot>,
        results: Vec<StoredSpeechResult>,
        code: SpeechFailureCode,
    },
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_status(runtime: State<'_, SpeechRuntime>) -> SpeechStatusResponse {
    SpeechStatusResponse {
        backends: runtime.statuses(),
        max_segments_per_job: MAX_SEGMENTS,
        max_batch_text_bytes: MAX_BATCH_TEXT_BYTES,
    }
}

#[derive(Clone)]
struct ProbeLifecycleOwnership(Arc<AtomicU64>);

impl ProbeLifecycleOwnership {
    fn new(epoch: u64) -> Self {
        Self(Arc::new(AtomicU64::new(epoch)))
    }

    fn update(&self, epoch: u64) {
        self.0.store(epoch, Ordering::Release);
    }

    fn epoch(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}

fn probe_join_result<T, E>(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    ownership: &ProbeLifecycleOwnership,
    result: Result<T, E>,
) -> CommandResult<T> {
    result.map_err(|_| {
        let _ = runtime.invalidate_backend_runtime(backend, Some(ownership.epoch()));
        CommandError::internal("The speech probe task stopped unexpectedly.")
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_probe(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
) -> CommandResult<SpeechProbeResponse> {
    let runtime = runtime.inner().clone();
    let epoch = runtime
        .lifecycle_epoch(backend)
        .map_err(|error| speech_command_error(&error))?;
    let ownership = ProbeLifecycleOwnership::new(epoch);
    let probe_ownership = ownership.clone();
    let probe_runtime = runtime.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (worker, actual_epoch) =
            probe_runtime.worker_for_probe(backend, epoch, |actual_epoch| {
                probe_ownership.update(actual_epoch);
            })?;
        let lifecycle_cancellation = probe_runtime.lifecycle_cancellation(backend, actual_epoch)?;
        let control = RunControl::new(PROBE_TIMEOUT)?.with_cancellation(lifecycle_cancellation);
        match worker.list_voices(&control) {
            Ok(inventory) => Ok((actual_epoch, inventory)),
            Err(error) => {
                let _ = probe_runtime.invalidate_backend_runtime(backend, Some(actual_epoch));
                Err(error)
            }
        }
    })
    .await;
    let result = probe_join_result(&runtime, backend, &ownership, result)?;
    match result {
        Ok((actual_epoch, inventory)) => {
            let voices = inventory
                .voices()
                .iter()
                .map(|voice| SpeechVoiceResponse {
                    id: voice.id().as_str().to_owned(),
                    display_name: voice.display_name().to_owned(),
                    language: voice.language().as_str().to_owned(),
                    gender: match voice.gender() {
                        VoiceGender::Female => SpeechVoiceGenderResponse::Female,
                        VoiceGender::Male => SpeechVoiceGenderResponse::Male,
                        VoiceGender::Neutral => SpeechVoiceGenderResponse::Neutral,
                        VoiceGender::Unknown => SpeechVoiceGenderResponse::Unknown,
                    },
                })
                .collect::<Vec<_>>();
            if !runtime.commit_voice_inventory_for_epoch(backend, actual_epoch, voices.clone()) {
                return Err(speech_command_error(&SpeechError::Cancelled));
            }
            let status = runtime.status(backend);
            if status.epoch != actual_epoch || !status.enabled || !status.warm {
                let _ = runtime.invalidate_backend_runtime(backend, Some(actual_epoch));
                return Err(speech_command_error(&SpeechError::StateUnavailable));
            }
            Ok(SpeechProbeResponse { status, voices })
        }
        Err(error) => Err(speech_command_error(&error)),
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_voice_inventory(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
    epoch: u64,
) -> CommandResult<SpeechInventoryResponse> {
    runtime
        .voice_inventory(backend, epoch)
        .map_err(|error| speech_command_error(&error))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_runtime_stop(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
) -> CommandResult<SpeechBackendStatus> {
    let (status, detached) = runtime.begin_shutdown(backend)?;
    tauri::async_runtime::spawn_blocking(move || {
        for worker in detached {
            worker.shutdown();
        }
    });
    Ok(status)
}

#[tauri::command]
pub(crate) async fn speech_reference_select(
    app: AppHandle,
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechReferenceSelectRequest,
) -> CommandResult<Option<SpeechReferencePlayableResponse>> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let speech_runtime = runtime.inner().clone();
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &database,
            request.project_id,
            request.expected_project_state_version,
        )?;
        let Some(path) = dialog_paths::pick_file(&app)? else {
            return Ok(None);
        };
        normalize_and_publish_reference(
            &ReferencePublicationContext {
                runtime: &speech_runtime,
                media_engine: &media_engine,
                work: &work,
                database: &database,
                media_server: &media_server,
                project_id: request.project_id,
                expected_project_state_version: request.expected_project_state_version,
                expected_reference_version: request.expected_reference_version,
            },
            &path,
            request.backend,
            "nativeSelection",
        )
        .map(Some)
    })
    .await
    .map_err(|_| CommandError::internal("The reference import task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_reference_import(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    blob_store: State<'_, MediaBlobStore>,
    request: SpeechReferenceImportRequest,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let speech_runtime = runtime.inner().clone();
    let imported = blob_store
        .resolve(request.asset_id)?
        .ok_or_else(|| CommandError::invalid_input("The imported reference audio expired."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &database,
            request.project_id,
            request.expected_project_state_version,
        )?;
        normalize_and_publish_reference(
            &ReferencePublicationContext {
                runtime: &speech_runtime,
                media_engine: &media_engine,
                work: &work,
                database: &database,
                media_server: &media_server,
                project_id: request.project_id,
                expected_project_state_version: request.expected_project_state_version,
                expected_reference_version: request.expected_reference_version,
            },
            imported.path(),
            request.backend,
            "nativeBinaryImport",
        )
    })
    .await
    .map_err(|_| CommandError::internal("The reference import task stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn speech_reference_extract(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechReferenceExtractRequest,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let duration_ms = request
        .end_ms
        .checked_sub(request.start_ms)
        .filter(|duration| *duration > 0 && *duration <= request.backend.maximum_duration_ms())
        .ok_or_else(|| CommandError::invalid_input("The reference-audio range is invalid."))?;
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let local_media = state
        .editor
        .read()
        .map_err(|_| CommandError::internal("The editing session is unavailable."))?
        .local_media
        .clone()
        .ok_or_else(|| {
            CommandError::invalid_input("Select media before extracting a reference.")
        })?;
    let media_path = local_media.path().to_owned();
    let media_asset_id = local_media.asset_id();
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let speech_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &database,
            request.project_id,
            request.expected_project_state_version,
        )?;
        if !database.project_media_is_current(
            request.project_id,
            request.expected_project_state_version,
            media_asset_id,
        )? {
            return Err(CommandError::media_unavailable());
        }
        let source = MediaInput::from_native_selection(media_path)?;
        let output_path = work.path().join("reference.wav");
        let output = MediaOutput::within_root(&output_path, work.path())?;
        let range = MediaTimeRange::new(
            request.start_ms.saturating_mul(1_000),
            Some(duration_ms.saturating_mul(1_000)),
        )?;
        let plan = AudioExtractionPlan::new(
            source,
            output,
            AudioOutput::WavPcm16 {
                sample_rate: AudioSampleRate::new(44_100)?,
                channels: ChannelCount::new(2)?,
            },
            range,
        )?;
        let control = MediaRunControl::new(REFERENCE_EXTRACTION_TIMEOUT)?
            .with_cancellation(MediaCancellationToken::default());
        media_engine.execute(&MediaOperation::AudioExtraction(plan), &control)?;
        let asset = AudioAsset::from_native_file(&output_path)
            .map_err(|error| speech_command_error(&error))?;
        let published = publish_project_durable_artifact(
            &speech_runtime,
            &database,
            request.project_id,
            None,
            &reference_artifact_kind(request.project_id),
            &output_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(duration_ms.saturating_mul(1_000)),
                sample_rate_hz: Some(44_100),
                channels: Some(2),
                source: "activeMediaSegment",
            },
        )?;
        drop(asset);
        commit_published_reference(
            &database,
            &media_server,
            &published,
            request.project_id,
            request.expected_project_state_version,
            request.expected_reference_version,
            String::new(),
            "Unknown".to_owned(),
            None,
            None,
        )
    })
    .await
    .map_err(|_| CommandError::internal("The reference extraction task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_reference_get(
    state: State<'_, DesktopState>,
    request: SpeechReferenceProjectRequest,
) -> CommandResult<Option<SpeechReferencePlayableResponse>> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(reference) = database.get_project_speech_reference(request.project_id)? else {
            return Ok(None);
        };
        resolve_reference_record(&database, &media_server, reference).map(Some)
    })
    .await
    .map_err(|_| CommandError::internal("The reference restore task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_reference_commit(
    state: State<'_, DesktopState>,
    request: SpeechReferenceCommitRequest,
) -> CommandResult<SpeechReferenceRecordResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let artifact_id = parse_artifact_id(&request.artifact_id)?;
        let stored = database.put_project_speech_reference(&ProjectSpeechReferenceWrite {
            project_id: request.project_id,
            expected_project_state_version: request.expected_project_state_version,
            expected_reference_version: request.expected_reference_version,
            artifact_id,
            transcript: request.transcript,
            language: request.language,
            delivery_job_id: request.delivery_job_id,
            delivery_id: request.delivery_id,
        })?;
        Ok(reference_record_response(stored))
    })
    .await
    .map_err(|_| CommandError::internal("The reference commit task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_reference_clear(
    state: State<'_, DesktopState>,
    request: SpeechReferenceClearRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .delete_project_speech_reference(
                request.project_id,
                request.expected_project_state_version,
                request.expected_reference_version,
            )
            .map_err(Into::into)
    })
    .await
    .map_err(|_| CommandError::internal("The reference clear task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_artifact_edit(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechArtifactEditRequest,
) -> CommandResult<SpeechArtifactEditResponse> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    let speech_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        edit_project_speech_artifact(
            &speech_runtime,
            &database,
            &media_engine,
            work.path(),
            &request,
        )
    })
    .await
    .map_err(|_| CommandError::internal("The narration edit task stopped unexpectedly."))?
}

fn edit_project_speech_artifact(
    runtime: &SpeechRuntime,
    database: &Database,
    media_engine: &osg_media::MediaEngine,
    work_root: &Path,
    request: &SpeechArtifactEditRequest,
) -> CommandResult<SpeechArtifactEditResponse> {
    if request.expected_project_state_version > i64::MAX as u64 {
        return Err(CommandError::invalid_input(
            "The narration edit project state version is invalid.",
        ));
    }
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    let (audio, media, descriptor, source_project_id) =
        resolve_alignment_audio(database, &request.artifact_id)?;
    if source_project_id != Some(request.project_id) {
        return Err(CommandError::invalid_input(
            "The narration audio does not belong to the requested project.",
        ));
    }
    let duration = descriptor.duration_micros.ok_or_else(|| {
        CommandError::invalid_input("The narration duration is unavailable for editing.")
    })?;
    let trim = NormalizedTrim::new(
        NormalizedPoint::from_millionths(request.normalized_start_millionths)
            .map_err(|error| speech_command_error(&error))?,
        NormalizedPoint::from_millionths(request.normalized_end_millionths)
            .map_err(|error| speech_command_error(&error))?,
    )
    .map_err(|error| speech_command_error(&error))?;
    let speed = SpeedFactor::from_milli(request.speed_milli)
        .map_err(|error| speech_command_error(&error))?;
    let speech_plan = SpeechAudioEditPlan::new(
        audio,
        TimeMicros::new(duration).map_err(|error| speech_command_error(&error))?,
        trim,
        speed,
    )
    .map_err(|error| speech_command_error(&error))?;
    let (start_us, end_us) = match speech_plan.filters().first() {
        Some(AudioFilter::Trim { start, end }) => (start.get(), end.get()),
        _ => {
            return Err(CommandError::internal(
                "The narration edit plan is invalid.",
            ));
        }
    };
    let output_path = work_root.join("edited.wav");
    let output = MediaOutput::within_root(&output_path, work_root)?;
    let media_plan =
        MediaAudioEditPlan::new(media, output, start_us, end_us, speech_plan.speed().milli())?;
    let control = MediaRunControl::new(NARRATION_EDIT_TIMEOUT)?
        .with_cancellation(MediaCancellationToken::default());
    media_engine.execute(&MediaOperation::NarrationAudioEdit(media_plan), &control)?;
    let edited_input = MediaInput::from_native_selection(&output_path)?;
    let metadata = media_engine.probe(&edited_input, &control)?;
    let audio_metadata = metadata
        .primary_audio()
        .and_then(|stream| stream.audio.as_ref())
        .ok_or_else(|| CommandError::internal("The edited narration audio is invalid."))?;
    let duration_micros = metadata
        .duration_us()
        .ok_or_else(|| CommandError::internal("The edited narration duration is unavailable."))?;
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    let published = publish_project_durable_artifact(
        runtime,
        database,
        request.project_id,
        None,
        "narrationOutput",
        &output_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(duration_micros),
            sample_rate_hz: audio_metadata.sample_rate_hz,
            channels: audio_metadata
                .channels
                .and_then(|value| u8::try_from(value).ok()),
            source: "nativeNarrationEdit",
        },
    )?;
    if let Err(error) = require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    ) {
        rollback_published_speech_artifact(database, &published)?;
        return Err(error);
    }
    Ok(SpeechArtifactEditResponse {
        project_id: request.project_id,
        expected_project_state_version: request.expected_project_state_version,
        artifact: published.descriptor,
    })
}

fn validate_narration_cue_id(id: &SpeechNarrationCueId) -> bool {
    match id {
        SpeechNarrationCueId::Number(value) => value.unsigned_abs() <= 9_007_199_254_740_991,
        SpeechNarrationCueId::Text(value) => {
            !value.is_empty()
                && value.chars().count() <= 256
                && !value.chars().any(char::is_control)
        }
    }
}

fn validate_project_narration_result(
    database: &Database,
    project_id: ProjectId,
    request: SpeechProjectNarrationResultRequest,
) -> CommandResult<StoredProjectNarrationResult> {
    if !validate_narration_cue_id(&request.subtitle_id)
        || request.text.is_empty()
        || request.text.chars().count() > MAX_SEGMENT_TEXT_CHARACTERS
        || !matches!(
            request.method.as_str(),
            "f5tts" | "chatterbox" | "edge-tts" | "gtts" | "gemini"
        )
        || request.original_ids.is_empty()
        || request.original_ids.len() > MAX_SEGMENTS
        || request
            .original_ids
            .iter()
            .any(|id| !validate_narration_cue_id(id))
        || request.end_micros <= request.start_micros
        || request.end_micros > MAX_ALIGNMENT_DURATION_MICROS
    {
        return Err(CommandError::invalid_input(
            "The project narration record is invalid.",
        ));
    }
    let artifact_id = parse_artifact_id(&request.artifact_id)?;
    let resolved = database
        .resolve_artifact(artifact_id)?
        .ok_or_else(|| CommandError::invalid_input("The narration audio is unavailable."))?;
    if resolved.record().project_id() != Some(project_id)
        || !matches!(
            resolved.record().kind().as_str(),
            "narrationOutput" | "voiceConversion"
        )
    {
        return Err(CommandError::invalid_input(
            "The narration audio does not belong to this project.",
        ));
    }
    descriptor_from_record(resolved.record())?;
    Ok(StoredProjectNarrationResult {
        subtitle_id: request.subtitle_id,
        text: request.text,
        artifact_id: artifact_id.to_string(),
        method: request.method,
        output_index: request.output_index,
        original_ids: request.original_ids,
        start_micros: request.start_micros,
        end_micros: request.end_micros,
    })
}

fn project_narration_response(
    database: &Database,
    stored: StoredProjectNarration,
) -> CommandResult<SpeechProjectNarrationResponse> {
    let mut text_bytes = 0_usize;
    let mut cue_ids = HashSet::with_capacity(stored.results.len());
    let mut artifact_ids = HashSet::with_capacity(stored.results.len());
    let mut results = Vec::with_capacity(stored.results.len());
    for result in stored.results {
        text_bytes = text_bytes
            .checked_add(result.text.len())
            .filter(|bytes| *bytes <= MAX_BATCH_TEXT_BYTES)
            .ok_or_else(|| CommandError::internal("The stored project narration is invalid."))?;
        if !validate_narration_cue_id(&result.subtitle_id)
            || result.text.is_empty()
            || result.text.chars().count() > MAX_SEGMENT_TEXT_CHARACTERS
            || !matches!(
                result.method.as_str(),
                "f5tts" | "chatterbox" | "edge-tts" | "gtts" | "gemini"
            )
            || result.original_ids.is_empty()
            || result.original_ids.len() > MAX_SEGMENTS
            || result
                .original_ids
                .iter()
                .any(|id| !validate_narration_cue_id(id))
            || result.end_micros <= result.start_micros
            || result.end_micros > MAX_ALIGNMENT_DURATION_MICROS
            || !cue_ids.insert(result.subtitle_id.clone())
            || !artifact_ids.insert(result.artifact_id.clone())
        {
            return Err(CommandError::internal(
                "The stored project narration is invalid.",
            ));
        }
        let artifact_id = parse_artifact_id(&result.artifact_id)
            .map_err(|_| CommandError::internal("The stored project narration is invalid."))?;
        let resolved = database
            .resolve_artifact(artifact_id)?
            .ok_or_else(|| CommandError::internal("The stored project narration is invalid."))?;
        if resolved.record().project_id() != Some(stored.project_id)
            || !matches!(
                resolved.record().kind().as_str(),
                "narrationOutput" | "voiceConversion"
            )
        {
            return Err(CommandError::internal(
                "The stored project narration is invalid.",
            ));
        }
        results.push(SpeechProjectNarrationResultResponse {
            subtitle_id: result.subtitle_id,
            text: result.text,
            artifact: descriptor_from_record(resolved.record())?,
            method: result.method,
            output_index: result.output_index,
            original_ids: result.original_ids,
            start_micros: result.start_micros,
            end_micros: result.end_micros,
        });
    }
    Ok(SpeechProjectNarrationResponse {
        schema_version: stored.schema_version,
        project_id: stored.project_id,
        project_state_version: stored.project_state_version,
        source: stored.source,
        results,
    })
}

fn put_project_narration(
    database: &Database,
    request: SpeechProjectNarrationPutRequest,
) -> CommandResult<SpeechProjectNarrationResponse> {
    if request.expected_project_state_version > i64::MAX as u64
        || request.results.len() > MAX_SEGMENTS
    {
        return Err(CommandError::invalid_input(
            "The project narration record is invalid.",
        ));
    }
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    let mut text_bytes = 0_usize;
    let mut cue_ids = HashSet::with_capacity(request.results.len());
    let mut artifact_ids = HashSet::with_capacity(request.results.len());
    let mut results = Vec::with_capacity(request.results.len());
    for result in request.results {
        text_bytes = text_bytes
            .checked_add(result.text.len())
            .filter(|bytes| *bytes <= MAX_BATCH_TEXT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The project narration record is too large.")
            })?;
        let result = validate_project_narration_result(database, request.project_id, result)?;
        if !cue_ids.insert(result.subtitle_id.clone())
            || !artifact_ids.insert(result.artifact_id.clone())
        {
            return Err(CommandError::invalid_input(
                "The project narration record contains duplicate results.",
            ));
        }
        results.push(result);
    }
    let storage_key = project_narration_storage_key(request.project_id, request.source);
    let stored = StoredProjectNarration {
        schema_version: PROJECT_NARRATION_SCHEMA_VERSION,
        project_id: request.project_id,
        project_state_version: request.expected_project_state_version,
        source: request.source,
        results,
    };
    let value = serde_json::to_value(&stored)
        .map_err(|_| CommandError::internal("The project narration record is invalid."))?;
    database.put_project_setting(
        PROJECT_NARRATION_SCOPE,
        &storage_key,
        &value,
        request.project_id,
        request.expected_project_state_version,
    )?;
    project_narration_response(database, stored)
}

fn get_project_narration(
    database: &Database,
    project_id: ProjectId,
    source: SpeechNarrationSource,
) -> CommandResult<Option<SpeechProjectNarrationResponse>> {
    let Some(project) = database.load_project(project_id)? else {
        return Err(CommandError::invalid_input(
            "The subtitle project is unavailable.",
        ));
    };
    let storage_key = project_narration_storage_key(project_id, source);
    let (value, legacy) = if let Some(value) =
        database.get_setting(PROJECT_NARRATION_SCOPE, &storage_key)?
    {
        (value, false)
    } else {
        let Some(value) = database.get_setting(PROJECT_NARRATION_SCOPE, &project_id.to_string())?
        else {
            return Ok(None);
        };
        (value, true)
    };
    let stored: StoredProjectNarration = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The stored project narration is invalid."))?;
    if stored.schema_version != PROJECT_NARRATION_SCHEMA_VERSION
        || stored.project_id != project_id
        || stored.results.len() > MAX_SEGMENTS
    {
        return Err(CommandError::internal(
            "The stored project narration is invalid.",
        ));
    }
    if stored.source != source {
        if legacy {
            return Ok(None);
        }
        return Err(CommandError::internal(
            "The stored project narration is invalid.",
        ));
    }
    if stored.project_state_version != project.state_version() {
        return Ok(None);
    }
    project_narration_response(database, stored).map(Some)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_project_narration_put(
    state: State<'_, DesktopState>,
    request: SpeechProjectNarrationPutRequest,
) -> CommandResult<SpeechProjectNarrationResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || put_project_narration(&database, request))
        .await
        .map_err(|_| CommandError::internal("The project narration task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_project_narration_get(
    state: State<'_, DesktopState>,
    project_id: ProjectId,
    source: SpeechNarrationSource,
) -> CommandResult<Option<SpeechProjectNarrationResponse>> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_project_narration(&database, project_id, source)
    })
    .await
    .map_err(|_| CommandError::internal("The project narration task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_start(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechStartRequest,
    on_event: Channel<SpeechJobEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let requested_backend = request.profile.backend();
    let requested_epoch = request.lifecycle_epoch;
    let expected_project_state_version = request.expected_project_state_version;
    if expected_project_state_version > i64::MAX as u64 {
        return Err(CommandError::invalid_input(
            "The narration project state version is invalid.",
        ));
    }
    runtime
        .require_enabled_lifecycle(requested_backend, requested_epoch)
        .map_err(|error| speech_command_error(&error))?;
    let reference_id = request.reference_artifact_id.clone();
    let project_id = request.project_id;
    let reference_database = state.database.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &reference_database,
            project_id,
            expected_project_state_version,
        )?;
        match reference_id.as_deref() {
            Some(id) => resolve_audio_artifact(&reference_database, id, true).map(Some),
            None => Ok(None),
        }
    })
    .await;
    let reference = command_join_result(
        &runtime,
        requested_backend,
        requested_epoch,
        joined,
        "The reference lookup task stopped unexpectedly.",
    )??;
    let validated = request
        .validate(reference)
        .map_err(|error| speech_command_error(&error))?;
    let ownership = SpeechLifecycleOwnership::capture_project(
        &runtime,
        validated.backend,
        validated.lifecycle_epoch,
        validated.project_id,
        validated.expected_project_state_version,
    )
    .map_err(|error| speech_command_error(&error))?;
    let jobs = Arc::clone(&state.jobs);
    let ticket =
        register_owned_speech_job_with_hook(&runtime, &ownership, &state.database, &jobs, || {})
            .await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    initialize_registered_speech_job_with_hook(
        &runtime,
        &ownership,
        &state.database,
        &jobs,
        job_id,
        || {},
    )
    .await?;
    let database = state.database.clone();
    let credentials = state.credentials.clone();
    let cancellation = ticket.cancellation().clone();

    tauri::async_runtime::spawn(async move {
        let cancellation_bridge = ownership.cancellation.clone();
        let cancellation_watch = cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation_watch.cancelled().await;
            cancellation_bridge.cancel();
        });
        let context = SpeechBatchContext {
            runtime: &runtime,
            database: &database,
            credentials: &credentials,
            jobs: &jobs,
            job_id,
            project_id: validated.project_id,
            channel: &on_event,
        };
        let mut outcome = run_speech_batch(&context, validated, ownership.clone()).await;
        watcher.abort();
        if cancellation.is_cancelled() {
            outcome = Err(SpeechFailureCode::Cancelled);
        }
        finish_speech_job(
            &runtime, &ownership, &jobs, &database, job_id, outcome, &on_event,
        )
        .await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_voice_conversion_start(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechVoiceConversionStartRequest,
    on_event: Channel<SpeechJobEvent>,
) -> CommandResult<JobSnapshot> {
    if request.lifecycle_epoch > MAX_LIFECYCLE_EPOCH {
        return Err(CommandError::invalid_input(
            "The speech lifecycle epoch is invalid.",
        ));
    }
    let runtime = runtime.inner().clone();
    let lifecycle_epoch = request.lifecycle_epoch;
    runtime
        .require_enabled_lifecycle(SpeechBackendRequest::Chatterbox, lifecycle_epoch)
        .map_err(|error| speech_command_error(&error))?;
    let artifact_database = state.database.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let input = resolve_audio_artifact(&artifact_database, &request.input_artifact_id, false)?;
        let target =
            resolve_audio_artifact(&artifact_database, &request.target_voice_artifact_id, true)?;
        Ok::<_, CommandError>((input, target))
    })
    .await;
    let (input, target) = command_join_result(
        &runtime,
        SpeechBackendRequest::Chatterbox,
        lifecycle_epoch,
        joined,
        "The speech audio lookup task stopped unexpectedly.",
    )??;
    let ownership = SpeechLifecycleOwnership::capture(
        &runtime,
        SpeechBackendRequest::Chatterbox,
        lifecycle_epoch,
    )
    .map_err(|error| speech_command_error(&error))?;
    let jobs = Arc::clone(&state.jobs);
    let ticket =
        register_owned_speech_job_with_hook(&runtime, &ownership, &state.database, &jobs, || {})
            .await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    initialize_registered_speech_job_with_hook(
        &runtime,
        &ownership,
        &state.database,
        &jobs,
        job_id,
        || {},
    )
    .await?;
    let database = state.database.clone();
    let cancellation = ticket.cancellation().clone();

    tauri::async_runtime::spawn(async move {
        let cancellation_bridge = ownership.cancellation.clone();
        let cancellation_watch = cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation_watch.cancelled().await;
            cancellation_bridge.cancel();
        });
        let mut result = run_voice_conversion(
            &runtime,
            &database,
            input,
            target,
            ownership.clone(),
            job_id,
            &on_event,
        )
        .await;
        watcher.abort();
        if cancellation.is_cancelled() {
            result = Err(SpeechFailureCode::Cancelled);
        }
        finish_speech_job(
            &runtime, &ownership, &jobs, &database, job_id, result, &on_event,
        )
        .await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_alignment_start(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechAlignmentStartRequest,
    on_event: Channel<SpeechAlignmentEvent>,
) -> CommandResult<JobSnapshot> {
    let engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let validation_database = state.database.clone();
    let validated = tauri::async_runtime::spawn_blocking(move || {
        validate_alignment_start(&validation_database, request)
    })
    .await
    .map_err(|_| CommandError::internal("The alignment lookup task stopped unexpectedly."))??;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::AlignNarration).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let authority = SpeechProjectAuthority {
        project_id: validated.project_id,
        expected_state_version: validated.expected_project_state_version,
    };
    if let Err(error) = initialize_alignment_manifest(&state.database, job_id, authority).await {
        let _ = background::finish_failure(&jobs, job_id).await;
        return Err(error);
    }
    report_alignment_progress(&jobs, job_id, SpeechAlignmentPhase::Planning, 0, &on_event);

    let runtime = runtime.inner().clone();
    let database = state.database.clone();
    let cancellation = ticket.cancellation().clone();
    tauri::async_runtime::spawn(async move {
        let media_cancellation = MediaCancellationToken::default();
        let cancellation_bridge = media_cancellation.clone();
        let cancellation_watch = cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation_watch.cancelled().await;
            cancellation_bridge.cancel();
        });
        let operation_jobs = Arc::clone(&jobs);
        let operation_database = database.clone();
        let operation_channel = on_event.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            execute_alignment_job(
                &runtime,
                &engine,
                &operation_database,
                &operation_jobs,
                job_id,
                &validated,
                &media_cancellation,
                &operation_channel,
            )
        })
        .await
        .unwrap_or(Err(SpeechAlignmentFailureCode::MediaFailed));
        watcher.abort();
        finish_alignment_job(&jobs, &database, authority, job_id, outcome, &on_event).await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_job_results(
    state: State<'_, DesktopState>,
    job_id: JobId,
) -> CommandResult<SpeechJobResultsResponse> {
    let database = state.database.clone();
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let job = jobs.get(job_id)?.snapshot().clone();
        let manifest = read_manifest(&database, job_id)?;
        Ok(SpeechJobResultsResponse {
            job,
            backend: manifest.backend,
            project_id: manifest.project_id,
            expected_project_state_version: manifest.expected_project_state_version,
            results: manifest.results,
        })
    })
    .await
    .map_err(|_| CommandError::internal("The speech result task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_alignment_result(
    state: State<'_, DesktopState>,
    job_id: JobId,
) -> CommandResult<SpeechAlignmentResultResponse> {
    let database = state.database.clone();
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let job = jobs.get(job_id)?.snapshot().clone();
        if job.kind() != JobKind::AlignNarration {
            return Err(CommandError::invalid_input(
                "The job is not a narration alignment job.",
            ));
        }
        let manifest = read_alignment_manifest(&database, job_id)?;
        Ok(SpeechAlignmentResultResponse {
            job,
            project_id: manifest.project_id,
            expected_project_state_version: manifest.expected_project_state_version,
            result: manifest.result,
        })
    })
    .await
    .map_err(|_| CommandError::internal("The alignment result task stopped unexpectedly."))?
}

struct SpeechExportSource {
    path: PathBuf,
    content_hash: ContentHash,
    expected_bytes: u64,
    file_name: String,
}

struct SpeechExportPlan {
    sources: Vec<SpeechExportSource>,
    archive_name: Option<String>,
}

impl SpeechExportPlan {
    fn selected_file_name(&self) -> &str {
        self.archive_name
            .as_deref()
            .unwrap_or(&self.sources[0].file_name)
    }

    fn selected_extension(&self) -> &str {
        self.archive_name.as_ref().map_or_else(
            || {
                self.sources[0]
                    .file_name
                    .rsplit_once('.')
                    .map_or("wav", |(_, ext)| ext)
            },
            |_| "zip",
        )
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and State as owned command extractors"
)]
pub(crate) async fn speech_artifact_export(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: SpeechArtifactExportRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let plan =
        tauri::async_runtime::spawn_blocking(move || prepare_speech_export(&database, request))
            .await
            .map_err(|_| {
                CommandError::internal("The narration export lookup stopped unexpectedly.")
            })??;

    let selected = dialog_paths::save_file(
        &app,
        "Export narration audio",
        plan.selected_file_name(),
        "Narration audio",
        &[plan.selected_extension()],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };

    let staging_authority = app
        .state::<SpeechRuntime>()
        .inner()
        .0
        .staging_authority
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_speech_plan(&staging_authority, &plan, &destination)
    })
    .await
    .map_err(|_| CommandError::internal("The narration export task stopped unexpectedly."))??;
    Ok(true)
}

fn prepare_speech_export(
    database: &Database,
    request: SpeechArtifactExportRequest,
) -> CommandResult<SpeechExportPlan> {
    if request.entries.is_empty() || request.entries.len() > MAX_SEGMENTS {
        return Err(CommandError::invalid_input(
            "The narration export request is invalid.",
        ));
    }
    if request.entries.len() > 1 && request.archive_name.is_none() {
        return Err(CommandError::invalid_input(
            "Multiple narration files require an archive.",
        ));
    }
    if let Some(archive_name) = request.archive_name.as_deref()
        && !is_safe_export_file_name(archive_name, "zip")
    {
        return Err(CommandError::invalid_input(
            "The narration archive name is invalid.",
        ));
    }

    let mut file_names = HashSet::with_capacity(request.entries.len());
    let mut total_bytes = 0_u64;
    let mut sources = Vec::with_capacity(request.entries.len());
    for entry in request.entries {
        let id = parse_artifact_id(&entry.artifact_id)?;
        let resolved = database
            .resolve_artifact(id)?
            .ok_or_else(|| CommandError::invalid_input("The speech artifact is unavailable."))?;
        ensure_speech_artifact_kind(resolved.record().kind().as_str(), false)?;
        let descriptor = descriptor_from_record(resolved.record())?;
        if !is_safe_export_file_name(&entry.file_name, descriptor.format.extension())
            || !file_names.insert(entry.file_name.clone())
        {
            return Err(CommandError::invalid_input(
                "The narration export file name is invalid.",
            ));
        }
        total_bytes = total_bytes
            .checked_add(descriptor.bytes)
            .filter(|bytes| *bytes <= MAX_CONVERSION_INPUT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The narration export exceeds the safe size limit.")
            })?;
        sources.push(SpeechExportSource {
            path: resolved.path().to_owned(),
            content_hash: resolved.record().content_hash(),
            expected_bytes: descriptor.bytes,
            file_name: entry.file_name,
        });
    }
    Ok(SpeechExportPlan {
        sources,
        archive_name: request.archive_name,
    })
}

fn is_safe_export_file_name(value: &str, expected_extension: &str) -> bool {
    if value.is_empty() || value.len() > MAX_EXPORT_FILE_NAME_BYTES || !value.is_ascii() {
        return false;
    }
    let Some((stem, extension)) = value.rsplit_once('.') else {
        return false;
    };
    if extension != expected_extension || stem.is_empty() || stem.len() > 120 {
        return false;
    }
    let mut characters = stem.bytes();
    characters
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && characters.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn export_speech_plan(
    staging_authority: &RuntimeStagingAuthority,
    plan: &SpeechExportPlan,
    destination: &Path,
) -> CommandResult<()> {
    if plan.archive_name.is_none() {
        let source = plan
            .sources
            .first()
            .ok_or_else(CommandError::speech_export_failed)?;
        let mut staging = speech_export_staging(staging_authority, source)?;
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        write_verified_speech_source(
            source,
            staging
                .file_mut()
                .map_err(|_| CommandError::speech_export_failed())?,
            &mut buffer,
        )?;
        staging
            .sync_all()
            .map_err(|_| CommandError::speech_export_failed())?;
        return copy_export(
            staging_authority,
            staging.path(),
            destination,
            source.expected_bytes,
            || false,
            |_, _| Ok(()),
        )
        .map_err(|_| CommandError::speech_export_failed());
    }

    let source = plan
        .sources
        .first()
        .ok_or_else(CommandError::speech_export_failed)?;
    let mut staging = speech_export_staging(staging_authority, source)?;
    write_speech_archive(plan, &mut staging)?;
    let archive_bytes = fs::metadata(staging.path())
        .map_err(|_| CommandError::speech_export_failed())?
        .len();
    if archive_bytes == 0 || archive_bytes > MAX_EXPORT_ARCHIVE_BYTES {
        return Err(CommandError::speech_export_failed());
    }
    copy_export(
        staging_authority,
        staging.path(),
        destination,
        archive_bytes,
        || false,
        |_, _| Ok(()),
    )
    .map_err(|_| CommandError::speech_export_failed())
}

fn speech_export_staging(
    authority: &RuntimeStagingAuthority,
    source: &SpeechExportSource,
) -> CommandResult<OwnedStagingFile> {
    let directory = source
        .path
        .parent()
        .ok_or_else(CommandError::speech_export_failed)?;
    OwnedStagingFile::begin(authority, directory, StagingKind::MediaExport)
        .map_err(|_| CommandError::speech_export_failed())
}

fn write_speech_archive(
    plan: &SpeechExportPlan,
    staging: &mut OwnedStagingFile,
) -> CommandResult<()> {
    let output = staging
        .file_mut()
        .map_err(|_| CommandError::speech_export_failed())?;
    let mut archive = zip::ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    for source in &plan.sources {
        archive
            .start_file(&source.file_name, options)
            .map_err(|_| CommandError::speech_export_failed())?;
        write_verified_speech_source(source, &mut archive, &mut buffer)?;
    }
    archive
        .finish()
        .map_err(|_| CommandError::speech_export_failed())?
        .sync_all()
        .map_err(|_| CommandError::speech_export_failed())
}

fn write_verified_speech_source(
    source: &SpeechExportSource,
    output: &mut impl Write,
    buffer: &mut [u8],
) -> CommandResult<()> {
    let mut input = fs::File::open(&source.path)
        .map(BufReader::new)
        .map_err(|_| CommandError::speech_export_failed())?;
    let mut hasher = blake3::Hasher::new();
    let mut copied = 0_u64;
    loop {
        let count = input
            .read(buffer)
            .map_err(|_| CommandError::speech_export_failed())?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(count).map_err(|_| CommandError::speech_export_failed())?)
            .filter(|bytes| *bytes <= source.expected_bytes)
            .ok_or_else(CommandError::speech_export_failed)?;
        hasher.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|_| CommandError::speech_export_failed())?;
    }
    if copied != source.expected_bytes
        || hasher.finalize().as_bytes() != source.content_hash.as_bytes()
    {
        return Err(CommandError::speech_export_failed());
    }
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_artifact_resolve(
    state: State<'_, DesktopState>,
    artifact_id: String,
) -> CommandResult<SpeechPlayableArtifact> {
    let id = parse_artifact_id(&artifact_id)?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = database
            .resolve_artifact(id)?
            .ok_or_else(|| CommandError::invalid_input("The speech artifact is unavailable."))?;
        ensure_speech_artifact_kind(resolved.record().kind().as_str(), false)?;
        let artifact = descriptor_from_record(resolved.record())?;
        let playback = register_speech_playback(&media_server, resolved.path(), artifact.format)?;
        Ok(SpeechPlayableArtifact { artifact, playback })
    })
    .await
    .map_err(|_| CommandError::internal("The speech artifact task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_playback_release(
    state: State<'_, DesktopState>,
    playback_id: Uuid,
) -> CommandResult<bool> {
    state
        .media_server
        .unregister(playback_id)
        .map_err(Into::into)
}

type NativeCredentialService =
    osg_infrastructure::secrets::CredentialService<crate::state::DesktopCredentialBackend>;

struct SpeechBatchContext<'a> {
    runtime: &'a SpeechRuntime,
    database: &'a Database,
    credentials: &'a NativeCredentialService,
    jobs: &'a background::DesktopJobs,
    job_id: JobId,
    project_id: ProjectId,
    channel: &'a Channel<SpeechJobEvent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SpeechProjectAuthority {
    project_id: ProjectId,
    expected_state_version: u64,
}

impl SpeechProjectAuthority {
    fn ensure_current(self, database: &Database) -> Result<(), SpeechFailureCode> {
        let project = database
            .load_project(self.project_id)
            .map_err(|_| SpeechFailureCode::ArtifactStorage)?
            .ok_or(SpeechFailureCode::ProjectChanged)?;
        if project.state_version() != self.expected_state_version {
            return Err(SpeechFailureCode::ProjectChanged);
        }
        Ok(())
    }
}

const fn project_write_failure(error: &DatabaseError) -> SpeechFailureCode {
    match error {
        DatabaseError::ProjectNotFound(_) | DatabaseError::StaleProjectVersion { .. } => {
            SpeechFailureCode::ProjectChanged
        }
        _ => SpeechFailureCode::ArtifactStorage,
    }
}

#[derive(Clone)]
struct SpeechLifecycleOwnership {
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    cancellation: CancellationToken,
    project: Option<SpeechProjectAuthority>,
}

impl SpeechLifecycleOwnership {
    fn capture(
        runtime: &SpeechRuntime,
        backend: SpeechBackendRequest,
        lifecycle_epoch: u64,
    ) -> Result<Self, SpeechError> {
        let lifecycle_cancellation = runtime.require_enabled_lifecycle(backend, lifecycle_epoch)?;
        Ok(Self {
            backend,
            lifecycle_epoch,
            cancellation: CancellationToken::linked(&[lifecycle_cancellation]),
            project: None,
        })
    }

    fn capture_project(
        runtime: &SpeechRuntime,
        backend: SpeechBackendRequest,
        lifecycle_epoch: u64,
        project_id: ProjectId,
        expected_state_version: u64,
    ) -> Result<Self, SpeechError> {
        let mut ownership = Self::capture(runtime, backend, lifecycle_epoch)?;
        ownership.project = Some(SpeechProjectAuthority {
            project_id,
            expected_state_version,
        });
        Ok(ownership)
    }

    fn ensure_current(&self, runtime: &SpeechRuntime) -> Result<(), SpeechFailureCode> {
        if self.cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        runtime
            .require_enabled_lifecycle(self.backend, self.lifecycle_epoch)
            .map_err(|error| speech_failure(&error).0)?;
        if self.cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        Ok(())
    }

    fn ensure_owned(
        &self,
        runtime: &SpeechRuntime,
        database: &Database,
    ) -> Result<(), SpeechFailureCode> {
        self.ensure_current(runtime)?;
        if let Some(project) = self.project {
            project.ensure_current(database)?;
        }
        self.ensure_current(runtime)
    }

    fn validate_slot(&self, slot: &BackendLifecycleSlot) -> Result<(), SpeechFailureCode> {
        if self.cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        let lifecycle = slot
            .state
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        if lifecycle.epoch != self.lifecycle_epoch
            || !lifecycle.enabled
            || lifecycle.cancellation.is_cancelled()
            || self.cancellation.is_cancelled()
        {
            return Err(SpeechFailureCode::Cancelled);
        }
        Ok(())
    }

    fn commit_initial_manifest(
        &self,
        runtime: &SpeechRuntime,
        database: &Database,
        job_id: JobId,
    ) -> Result<(), SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        let manifest = SpeechJobManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            backend: self.backend,
            project_id: self.project.map(|authority| authority.project_id),
            expected_project_state_version: self
                .project
                .map(|authority| authority.expected_state_version),
            results: Vec::new(),
        };
        let value =
            serde_json::to_value(manifest).map_err(|_| SpeechFailureCode::ArtifactStorage)?;
        match self.project {
            Some(project) => database
                .put_project_setting(
                    MANIFEST_SCOPE,
                    &job_id.to_string(),
                    &value,
                    project.project_id,
                    project.expected_state_version,
                )
                .map_err(|error| project_write_failure(&error)),
            None => database
                .put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)
                .map_err(|_| SpeechFailureCode::ArtifactStorage),
        }
    }

    fn commit_manifest_result(
        &self,
        runtime: &SpeechRuntime,
        database: &Database,
        job_id: JobId,
        result: StoredSpeechResult,
    ) -> Result<(), SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        append_manifest(database, job_id, self.backend, self.project, result)
    }

    fn commit_job_progress(
        &self,
        runtime: &SpeechRuntime,
        jobs: &background::DesktopJobs,
        job_id: JobId,
        progress: JobProgress,
    ) -> Result<(), SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        jobs.apply(job_id, JobUpdate::ReportProgress(progress))
            .map(|_| ())
            .map_err(|_| SpeechFailureCode::ArtifactStorage)
    }

    fn commit_job_success(
        &self,
        runtime: &SpeechRuntime,
        jobs: &background::DesktopJobs,
        job_id: JobId,
    ) -> Result<JobSnapshot, SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        let ticket = match self.project {
            Some(project) => jobs.apply_with_store(
                job_id,
                JobUpdate::Succeed,
                |database, sequence, snapshot| {
                    database.complete_project_job(
                        sequence,
                        snapshot,
                        project.project_id,
                        project.expected_state_version,
                    )
                },
            ),
            None => jobs.apply(job_id, JobUpdate::Succeed),
        };
        ticket
            .map(|ticket| ticket.snapshot().clone())
            .map_err(|error| match error {
                osg_application::JobRegistryError::Store(store_error) => {
                    project_write_failure(&store_error)
                }
                _ => SpeechFailureCode::ArtifactStorage,
            })
    }
}

async fn register_owned_speech_job_with_hook<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    jobs: &background::DesktopJobs,
    after_registration: F,
) -> CommandResult<osg_application::JobTicket>
where
    F: FnOnce(),
{
    let ticket = background::register_running(jobs, JobKind::SynthesizeNarration).await?;
    after_registration();
    if let Err(code) = ownership.ensure_owned(runtime, database) {
        background::finish_cancellation(jobs, ticket.snapshot().id()).await?;
        return Err(speech_failure_code_command_error(code));
    }
    Ok(ticket)
}

async fn finish_registered_speech_start(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    code: SpeechFailureCode,
) -> CommandResult<()> {
    if code == SpeechFailureCode::Cancelled {
        background::finish_cancellation(jobs, job_id).await?;
    } else if background::finish_failure(jobs, job_id).await.is_none() {
        return Err(CommandError::internal(
            "The speech startup job could not be finalized.",
        ));
    }
    Ok(())
}

async fn initialize_registered_speech_job_with_hook<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    before_manifest_put: F,
) -> CommandResult<()>
where
    F: FnOnce() + Send + 'static,
{
    let worker_runtime = runtime.clone();
    let worker_ownership = ownership.clone();
    let worker_database = database.clone();
    let backend = ownership.backend;
    let lifecycle_epoch = ownership.lifecycle_epoch;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        initialize_manifest_with_hook(
            &worker_runtime,
            &worker_ownership,
            &worker_database,
            job_id,
            before_manifest_put,
        )
    })
    .await;
    let outcome = worker_join_result(runtime, backend, lifecycle_epoch, joined).unwrap_or_else(Err);
    if let Err(code) = outcome {
        finish_registered_speech_start(jobs, job_id, code).await?;
        return Err(speech_failure_code_command_error(code));
    }
    Ok(())
}

fn initialize_manifest_with_hook<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    job_id: JobId,
    before_manifest_put: F,
) -> Result<(), SpeechFailureCode>
where
    F: FnOnce(),
{
    before_manifest_put();
    ownership.commit_initial_manifest(runtime, database, job_id)
}

fn worker_join_result<T, E>(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    result: Result<T, E>,
) -> Result<T, SpeechFailureCode> {
    result.map_err(|_| {
        let _ = runtime.invalidate_backend_runtime(backend, Some(lifecycle_epoch));
        SpeechFailureCode::WorkerFailed
    })
}

fn command_join_result<T, E>(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    result: Result<T, E>,
    message: &'static str,
) -> CommandResult<T> {
    result.map_err(|_| {
        let _ = runtime.invalidate_backend_runtime(backend, Some(lifecycle_epoch));
        CommandError::internal(message)
    })
}

async fn resolve_prepared_batch_worker(
    context: &SpeechBatchContext<'_>,
    validated: &mut ValidatedSpeechStart,
    work: &OwnedStagingDirectory,
    cancellation: &CancellationToken,
) -> Result<Arc<ManagedSpeechWorker>, SpeechFailureCode> {
    let worker = resolve_batch_worker(
        context,
        validated.backend,
        validated.lifecycle_epoch,
        validated.credential_id,
    )
    .await?;
    if validated.backend != SpeechBackendRequest::F5Tts {
        return Ok(worker);
    }
    validated.requests = prepare_f5_requests(
        &worker,
        work,
        std::mem::take(&mut validated.requests),
        validated
            .reference
            .take()
            .ok_or(SpeechFailureCode::ReferenceRejected)?,
        cancellation.clone(),
    )
    .await?;
    Ok(worker)
}

async fn run_speech_batch(
    context: &SpeechBatchContext<'_>,
    mut validated: ValidatedSpeechStart,
    ownership: SpeechLifecycleOwnership,
) -> Result<Vec<StoredSpeechResult>, SpeechFailureCode> {
    ownership.ensure_owned(context.runtime, context.database)?;
    let work = context
        .runtime
        .work_directory()
        .map_err(|_| SpeechFailureCode::RuntimeUnavailable)?;
    let worker = match resolve_prepared_batch_worker(
        context,
        &mut validated,
        &work,
        &ownership.cancellation,
    )
    .await
    {
        Ok(worker) => worker,
        Err(code) => {
            if failure_marks_backend_unhealthy(code) {
                let _ = context
                    .runtime
                    .invalidate_backend_runtime(validated.backend, Some(validated.lifecycle_epoch));
            }
            return Err(code);
        }
    };
    ownership.ensure_owned(context.runtime, context.database)?;

    let total = validated.requests.len();
    let mut results = Vec::with_capacity(total);
    for (offset, request) in validated.requests.into_iter().enumerate() {
        ownership.ensure_owned(context.runtime, context.database)?;
        let index = offset + 1;
        let prepared = synthesize_segment(
            context,
            &work,
            &worker,
            request,
            ownership.clone(),
            SegmentRun {
                backend: validated.backend,
                lifecycle_epoch: validated.lifecycle_epoch,
                index,
                total,
            },
        )
        .await?;
        let (stored, invalidate_backend) = match prepared {
            PreparedSegmentResult::Completed(stored) => (stored, false),
            PreparedSegmentResult::Failed {
                result,
                invalidate_backend,
            } => {
                commit_failed_segment(context, &ownership, result.clone(), index, total).await?;
                (result, invalidate_backend)
            }
        };
        let terminal_failure = match &stored {
            StoredSpeechResult::Failed { code, .. } if batch_terminal_failure(*code) => Some(*code),
            _ => None,
        };
        results.push(stored);
        if let Some(code) = terminal_failure {
            if invalidate_backend {
                let _ = context
                    .runtime
                    .invalidate_backend_runtime(validated.backend, Some(validated.lifecycle_epoch));
            }
            return Err(code);
        }
        report_batch_progress(
            context.runtime,
            &ownership,
            context.database,
            context.jobs,
            context.job_id,
            index,
            total,
        )
        .await?;
    }
    if results
        .iter()
        .all(|result| matches!(result, StoredSpeechResult::Failed { .. }))
    {
        Err(SpeechFailureCode::SynthesisFailed)
    } else {
        Ok(results)
    }
}

#[derive(Clone, Copy)]
struct SegmentRun {
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    index: usize,
    total: usize,
}

enum PreparedSegmentResult {
    Completed(StoredSpeechResult),
    Failed {
        result: StoredSpeechResult,
        invalidate_backend: bool,
    },
}

async fn resolve_batch_worker(
    context: &SpeechBatchContext<'_>,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    credential_id: Option<CredentialId>,
) -> Result<Arc<ManagedSpeechWorker>, SpeechFailureCode> {
    let Some(credential_id) = credential_id else {
        let runtime = context.runtime.clone();
        let joined = tauri::async_runtime::spawn_blocking(move || {
            runtime.enabled_worker_for_epoch(backend, lifecycle_epoch)
        })
        .await;
        return worker_join_result(context.runtime, backend, lifecycle_epoch, joined)?
            .map_err(|error| speech_failure(&error).0);
    };
    let credentials = context.credentials.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
    })
    .await;
    let secret = worker_join_result(context.runtime, backend, lifecycle_epoch, joined)?
        .map_err(|_| SpeechFailureCode::AuthenticationFailed)?;
    let secret = SecretValue::new(secret.expose_secret().to_owned())
        .map_err(|_| SpeechFailureCode::AuthenticationFailed)?;
    let runtime = context.runtime.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        runtime.provider_worker_for_epoch(backend, lifecycle_epoch, secret)
    })
    .await;
    worker_join_result(context.runtime, backend, lifecycle_epoch, joined)?
        .map_err(|error| speech_failure(&error).0)
}

async fn prepare_f5_requests(
    worker: &Arc<ManagedSpeechWorker>,
    work: &OwnedStagingDirectory,
    requests: Vec<SynthesisRequest>,
    reference: AudioAsset,
    cancellation: CancellationToken,
) -> Result<Vec<SynthesisRequest>, SpeechFailureCode> {
    let plan = ReferencePreparationPlan::for_f5(reference)
        .with_segment(
            TimeMicros::ZERO,
            TimeMicros::from_millis(MAX_F5_REFERENCE_MS)
                .map_err(|error| speech_failure(&error).0)?,
        )
        .map_err(|error| speech_failure(&error).0)?;
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        "prepared-reference",
        AudioFormat::Wav,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let prepare_worker = Arc::clone(worker);
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(REFERENCE_PREPARE_TIMEOUT)?.with_cancellation(cancellation);
        prepare_worker.prepare_reference(&plan, &output, &control)
    })
    .await
    .map_err(|_| SpeechFailureCode::WorkerFailed)?
    .map_err(|error| speech_failure(&error).0)?;
    let prepared_asset = AudioAsset::from_native_file(prepared.native_path())
        .map_err(|error| speech_failure(&error).0)?;
    requests
        .into_iter()
        .map(|request| {
            SynthesisRequest::new(
                request.segment_id().clone(),
                request.text().clone(),
                request.settings().clone(),
                Some(prepared_asset.clone()),
            )
            .map_err(|error| speech_failure(&error).0)
        })
        .collect()
}

async fn synthesize_segment(
    context: &SpeechBatchContext<'_>,
    work: &OwnedStagingDirectory,
    worker: &Arc<ManagedSpeechWorker>,
    request: SynthesisRequest,
    ownership: SpeechLifecycleOwnership,
    run: SegmentRun,
) -> Result<PreparedSegmentResult, SpeechFailureCode> {
    let segment_id = request.segment_id().as_str().to_owned();
    let format = request.output_format();
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        &format!("segment-{}", run.index),
        format,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let progress_channel = context.channel.clone();
    let progress_segment = segment_id.clone();
    let progress_worker = Arc::clone(worker);
    let job_id = context.job_id;
    let index = run.index;
    let total = run.total;
    let progress_runtime = context.runtime.clone();
    let progress_database = context.database.clone();
    let progress_ownership = ownership.clone();
    let worker_cancellation = ownership.cancellation.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(SPEECH_TIMEOUT)?
            .with_cancellation(worker_cancellation)
            .with_progress(move |progress: &SpeechProgress| {
                if progress_ownership
                    .ensure_owned(&progress_runtime, &progress_database)
                    .is_ok()
                {
                    let _ = progress_channel.send(SpeechJobEvent::Progress {
                        job_id,
                        segment_id: progress
                            .segment_id()
                            .map(|value| value.as_str().to_owned())
                            .or_else(|| Some(progress_segment.clone())),
                        index,
                        total,
                        phase: progress.phase().into(),
                        fraction_millionths: progress.fraction_millionths(),
                    });
                }
            });
        synthesize_with_retry(&progress_worker, &request, &output, &control)
    })
    .await;
    let operation = worker_join_result(context.runtime, run.backend, run.lifecycle_epoch, joined)?;
    match operation {
        Ok(artifact) => {
            ownership.ensure_owned(context.runtime, context.database)?;
            let database = context.database.clone();
            let runtime = context.runtime.clone();
            let commit_ownership = ownership.clone();
            let completion_channel = context.channel.clone();
            let project_id = context.project_id;
            let joined = tauri::async_runtime::spawn_blocking(move || {
                let metadata = SpeechArtifactMetadata::from_summary(artifact.summary());
                commit_completed_speech_source(
                    &runtime,
                    &commit_ownership,
                    &database,
                    artifact.native_path(),
                    metadata,
                    Some(project_id),
                    job_id,
                    segment_id,
                    "narrationOutput",
                    |result| {
                        let _ = completion_channel.send(SpeechJobEvent::SegmentCompleted {
                            job_id,
                            index,
                            total,
                            result: result.clone(),
                        });
                    },
                )
            })
            .await;
            let committed =
                worker_join_result(context.runtime, run.backend, run.lifecycle_epoch, joined)??;
            Ok(PreparedSegmentResult::Completed(committed))
        }
        Err(SpeechError::Cancelled) => Err(SpeechFailureCode::Cancelled),
        Err(error) => {
            let (code, retryable) = speech_failure(&error);
            Ok(PreparedSegmentResult::Failed {
                result: StoredSpeechResult::Failed {
                    segment_id,
                    code,
                    retryable,
                },
                invalidate_backend: failure_marks_backend_unhealthy(code),
            })
        }
    }
}

async fn commit_failed_segment(
    context: &SpeechBatchContext<'_>,
    ownership: &SpeechLifecycleOwnership,
    result: StoredSpeechResult,
    index: usize,
    total: usize,
) -> Result<(), SpeechFailureCode> {
    let manifest_runtime = context.runtime.clone();
    let manifest_ownership = ownership.clone();
    let database = context.database.clone();
    let channel = context.channel.clone();
    let job_id = context.job_id;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        manifest_ownership
            .commit_manifest_result(&manifest_runtime, &database, job_id, result.clone())
            .map(|()| {
                let _ = channel.send(SpeechJobEvent::SegmentFailed {
                    job_id,
                    index,
                    total,
                    result,
                });
            })
    })
    .await;
    worker_join_result(
        context.runtime,
        ownership.backend,
        ownership.lifecycle_epoch,
        joined,
    )?
}

async fn report_batch_progress(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    completed: usize,
    total: usize,
) -> Result<(), SpeechFailureCode> {
    ownership.ensure_owned(runtime, database)?;
    if let Ok(progress) = JobProgress::from_units(
        u64::try_from(completed).unwrap_or(u64::MAX),
        u64::try_from(total).unwrap_or(u64::MAX),
    ) {
        let progress_runtime = runtime.clone();
        let progress_ownership = ownership.clone();
        let progress_jobs = Arc::clone(jobs);
        let joined = tauri::async_runtime::spawn_blocking(move || {
            progress_ownership.commit_job_progress(
                &progress_runtime,
                &progress_jobs,
                job_id,
                progress,
            )
        })
        .await;
        worker_join_result(
            runtime,
            ownership.backend,
            ownership.lifecycle_epoch,
            joined,
        )??;
    }
    Ok(())
}

async fn resolve_voice_conversion_worker(
    runtime: &SpeechRuntime,
    lifecycle_epoch: u64,
) -> Result<Arc<ManagedSpeechWorker>, SpeechFailureCode> {
    let worker_runtime = runtime.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        worker_runtime.enabled_worker_for_epoch(SpeechBackendRequest::Chatterbox, lifecycle_epoch)
    })
    .await;
    let resolved = worker_join_result(
        runtime,
        SpeechBackendRequest::Chatterbox,
        lifecycle_epoch,
        joined,
    )?;
    resolved.map_err(|error| {
        let code = speech_failure(&error).0;
        if failure_marks_backend_unhealthy(code) {
            let _ = runtime.invalidate_backend_runtime(
                SpeechBackendRequest::Chatterbox,
                Some(lifecycle_epoch),
            );
        }
        code
    })
}

async fn publish_voice_conversion_result(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    artifact: SpeechArtifact,
    job_id: JobId,
    channel: &Channel<SpeechJobEvent>,
) -> Result<StoredSpeechResult, SpeechFailureCode> {
    let publication_runtime = runtime.clone();
    let publication_ownership = ownership.clone();
    let artifact_database = database.clone();
    let completion_channel = channel.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        commit_completed_speech_source(
            &publication_runtime,
            &publication_ownership,
            &artifact_database,
            artifact.native_path(),
            SpeechArtifactMetadata::from_summary(artifact.summary()),
            None,
            job_id,
            "voice-conversion".to_owned(),
            "voiceConversion",
            |result| {
                let _ = completion_channel.send(SpeechJobEvent::SegmentCompleted {
                    job_id,
                    index: 1,
                    total: 1,
                    result: result.clone(),
                });
            },
        )
    })
    .await;
    worker_join_result(
        runtime,
        ownership.backend,
        ownership.lifecycle_epoch,
        joined,
    )?
}

async fn run_voice_conversion(
    runtime: &SpeechRuntime,
    database: &Database,
    input: AudioAsset,
    target: AudioAsset,
    ownership: SpeechLifecycleOwnership,
    job_id: JobId,
    channel: &Channel<SpeechJobEvent>,
) -> Result<Vec<StoredSpeechResult>, SpeechFailureCode> {
    let work = runtime
        .work_directory()
        .map_err(|_| SpeechFailureCode::RuntimeUnavailable)?;
    ownership.ensure_owned(runtime, database)?;
    let worker = resolve_voice_conversion_worker(runtime, ownership.lifecycle_epoch).await?;
    let request = VoiceConversionRequest::new(input, target);
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        "voice-conversion",
        AudioFormat::Wav,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let progress_channel = channel.clone();
    let progress_runtime = runtime.clone();
    let progress_ownership = ownership.clone();
    let worker_cancellation = ownership.cancellation.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(SPEECH_TIMEOUT)?
            .with_cancellation(worker_cancellation)
            .with_progress(move |progress: &SpeechProgress| {
                if progress_ownership.ensure_current(&progress_runtime).is_ok() {
                    let _ = progress_channel.send(SpeechJobEvent::Progress {
                        job_id,
                        segment_id: None,
                        index: 1,
                        total: 1,
                        phase: progress.phase().into(),
                        fraction_millionths: progress.fraction_millionths(),
                    });
                }
            });
        worker.convert_voice(&request, &output, &control)
    })
    .await;
    let operation = worker_join_result(
        runtime,
        SpeechBackendRequest::Chatterbox,
        ownership.lifecycle_epoch,
        joined,
    )?;
    let artifact = match operation {
        Ok(artifact) => artifact,
        Err(error) => {
            let (code, _) = speech_failure(&error);
            if failure_marks_backend_unhealthy(code) {
                let _ = runtime.invalidate_backend_runtime(
                    SpeechBackendRequest::Chatterbox,
                    Some(ownership.lifecycle_epoch),
                );
            }
            return Err(code);
        }
    };
    ownership.ensure_owned(runtime, database)?;
    let result =
        publish_voice_conversion_result(runtime, &ownership, database, artifact, job_id, channel)
            .await?;
    Ok(vec![result])
}

#[allow(clippy::too_many_arguments)]
fn execute_alignment_job(
    runtime: &SpeechRuntime,
    engine: &osg_media::MediaEngine,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    validated: &ValidatedAlignmentStart,
    cancellation: &MediaCancellationToken,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<SpeechAlignmentResult, SpeechAlignmentFailureCode> {
    let authority = SpeechProjectAuthority {
        project_id: validated.project_id,
        expected_state_version: validated.expected_project_state_version,
    };
    ensure_alignment_project_current(database, authority)?;
    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    let work = runtime
        .work_directory()
        .map_err(|_| SpeechAlignmentFailureCode::RuntimeUnavailable)?;
    let started = std::time::Instant::now();
    let leaf_count = validated.clips.len().div_ceil(MAX_NARRATION_MIX_INPUTS);
    let total_steps = if leaf_count == 1 { 1 } else { leaf_count + 1 };
    let final_path = work.path().join("aligned-narration.m4a");
    let (final_inputs, completed_steps) = if leaf_count == 1 {
        (validated.clips.clone(), 0)
    } else {
        (
            render_alignment_leaves(
                engine,
                work.path(),
                &validated.clips,
                total_steps,
                started,
                cancellation,
                jobs,
                database,
                authority,
                job_id,
                channel,
            )?,
            leaf_count,
        )
    };
    execute_alignment_mix(
        engine,
        work.path(),
        &final_inputs,
        &final_path,
        alignment_m4a_output()?,
        validated.stats.rendered_duration_micros,
        completed_steps,
        total_steps,
        started,
        cancellation.clone(),
        jobs,
        database,
        authority,
        job_id,
        channel,
    )?;

    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    ensure_alignment_project_current(database, authority)?;
    report_alignment_progress(
        jobs,
        job_id,
        SpeechAlignmentPhase::Publishing,
        950_000,
        channel,
    );
    let published = publish_project_durable_artifact(
        runtime,
        database,
        validated.project_id,
        Some(job_id),
        "alignedNarration",
        &final_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::M4a,
            duration_micros: Some(validated.stats.rendered_duration_micros),
            sample_rate_hz: Some(48_000),
            channels: Some(2),
            source: "nativeNarrationAlignment",
        },
    )
    .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
    let result = SpeechAlignmentResult {
        artifact: published.descriptor.clone(),
        clip_count: validated.stats.clip_count,
        adjusted_count: validated.stats.adjusted_count,
        requested_duration_micros: validated.stats.requested_duration_micros,
        natural_duration_micros: validated.stats.natural_duration_micros,
        rendered_duration_micros: validated.stats.rendered_duration_micros,
        maximum_shift_micros: validated.stats.maximum_shift_micros,
    };
    if let Err(code) = ensure_alignment_project_current(database, authority) {
        rollback_published_speech_artifact(database, &published)
            .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
        return Err(code);
    }
    if let Err(code) = store_alignment_result(database, job_id, authority, result.clone()) {
        rollback_published_speech_artifact(database, &published)
            .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
        return Err(code);
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn render_alignment_leaves(
    engine: &osg_media::MediaEngine,
    work_root: &Path,
    clips: &[AlignmentRenderClip],
    total_steps: usize,
    started: std::time::Instant,
    cancellation: &MediaCancellationToken,
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<Vec<AlignmentRenderClip>, SpeechAlignmentFailureCode> {
    let mut leaf_inputs = Vec::with_capacity(clips.len().div_ceil(MAX_NARRATION_MIX_INPUTS));
    for (leaf_index, clips) in clips.chunks(MAX_NARRATION_MIX_INPUTS).enumerate() {
        ensure_alignment_project_current(database, authority)?;
        if cancellation.is_cancelled() {
            return Err(SpeechAlignmentFailureCode::Cancelled);
        }
        let origin = clips
            .first()
            .map(|clip| clip.start_micros)
            .ok_or(SpeechAlignmentFailureCode::InvalidRequest)?;
        let end = clips
            .iter()
            .map(|clip| clip.end_micros)
            .max()
            .ok_or(SpeechAlignmentFailureCode::InvalidRequest)?;
        let duration = end
            .checked_sub(origin)
            .filter(|duration| *duration > 0)
            .ok_or(SpeechAlignmentFailureCode::InvalidRequest)?;
        let relative = clips
            .iter()
            .map(|clip| AlignmentRenderClip {
                input: clip.input.clone(),
                start_micros: clip.start_micros.saturating_sub(origin),
                end_micros: clip.end_micros.saturating_sub(origin),
            })
            .collect::<Vec<_>>();
        let leaf_path = work_root.join(format!("alignment-leaf-{leaf_index}.flac"));
        execute_alignment_mix(
            engine,
            work_root,
            &relative,
            &leaf_path,
            alignment_flac_output()?,
            duration,
            leaf_index,
            total_steps,
            started,
            cancellation.clone(),
            jobs,
            database,
            authority,
            job_id,
            channel,
        )?;
        let input = MediaInput::from_native_selection(&leaf_path)
            .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?;
        leaf_inputs.push(AlignmentRenderClip {
            input,
            start_micros: origin,
            end_micros: end,
        });
    }
    Ok(leaf_inputs)
}

#[allow(clippy::too_many_arguments)]
fn execute_alignment_mix(
    engine: &osg_media::MediaEngine,
    work_root: &Path,
    clips: &[AlignmentRenderClip],
    output_path: &Path,
    output_format: AudioOutput,
    duration_micros: u64,
    completed_steps: usize,
    total_steps: usize,
    started: std::time::Instant,
    cancellation: MediaCancellationToken,
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<(), SpeechAlignmentFailureCode> {
    ensure_alignment_project_current(database, authority)?;
    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    let remaining = ALIGNMENT_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or(SpeechAlignmentFailureCode::TimedOut)?;
    let mix_clips = clips
        .iter()
        .map(|clip| MediaMixClip::new(clip.input.clone(), clip.start_micros))
        .collect::<Vec<_>>();
    let output = MediaOutput::within_root(output_path, work_root)
        .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?;
    let operation = MediaOperation::NarrationMix(
        MediaMixPlan::new(mix_clips, output, output_format, duration_micros)
            .map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
    );
    let progress_jobs = Arc::clone(jobs);
    let progress_channel = channel.clone();
    let progress_database = database.clone();
    let progress_cancellation = cancellation.clone();
    let progress = ProgressSink::new(move |progress: FfmpegProgress| {
        let fraction = progress
            .fraction
            .filter(|fraction| fraction.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        report_alignment_mix_fraction(
            &progress_jobs,
            &progress_database,
            authority,
            job_id,
            completed_steps,
            total_steps,
            fraction,
            &progress_channel,
        )
        .unwrap_or_else(|_| progress_cancellation.cancel());
    });
    let control = MediaRunControl::new(remaining)
        .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?
        .with_cancellation(cancellation)
        .with_progress(progress);
    engine
        .execute(&operation, &control)
        .map_err(|error| alignment_media_failure(&error))?;
    ensure_alignment_project_current(database, authority)
}

fn alignment_m4a_output() -> Result<AudioOutput, SpeechAlignmentFailureCode> {
    Ok(AudioOutput::M4aAac {
        bitrate: AudioBitrate::new(192).map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
    })
}

fn alignment_flac_output() -> Result<AudioOutput, SpeechAlignmentFailureCode> {
    Ok(AudioOutput::Flac {
        sample_rate: AudioSampleRate::new(48_000)
            .map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
        channels: ChannelCount::new(2).map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
    })
}

const fn alignment_media_failure(error: &MediaError) -> SpeechAlignmentFailureCode {
    match error {
        MediaError::Cancelled(_) => SpeechAlignmentFailureCode::Cancelled,
        MediaError::TimedOut { .. } => SpeechAlignmentFailureCode::TimedOut,
        MediaError::BinaryNotFound(_) | MediaError::InvalidBinary { .. } => {
            SpeechAlignmentFailureCode::RuntimeUnavailable
        }
        MediaError::InvalidOption(_) | MediaError::UnsupportedConversion => {
            SpeechAlignmentFailureCode::InvalidRequest
        }
        MediaError::InvalidPath { .. }
        | MediaError::Spawn { .. }
        | MediaError::ProcessIo { .. }
        | MediaError::ProcessFailed { .. }
        | MediaError::OutputLimit { .. }
        | MediaError::InvalidProbe(_)
        | MediaError::ProbeJson(_)
        | MediaError::OutputExists
        | MediaError::MissingArtifact
        | MediaError::Finalize(_)
        | MediaError::InvalidWaveform(_) => SpeechAlignmentFailureCode::MediaFailed,
    }
}

fn ensure_alignment_project_current(
    database: &Database,
    authority: SpeechProjectAuthority,
) -> Result<(), SpeechAlignmentFailureCode> {
    let project = database
        .load_project(authority.project_id)
        .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?
        .ok_or(SpeechAlignmentFailureCode::ProjectChanged)?;
    if project.state_version() != authority.expected_state_version {
        return Err(SpeechAlignmentFailureCode::ProjectChanged);
    }
    Ok(())
}

const fn alignment_project_write_failure(error: &DatabaseError) -> SpeechAlignmentFailureCode {
    match error {
        DatabaseError::ProjectNotFound(_) | DatabaseError::StaleProjectVersion { .. } => {
            SpeechAlignmentFailureCode::ProjectChanged
        }
        _ => SpeechAlignmentFailureCode::ArtifactStorage,
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the finite alignment fraction is clamped to 0..=1 before conversion"
)]
#[allow(clippy::too_many_arguments)]
fn report_alignment_mix_fraction(
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    completed_steps: usize,
    total_steps: usize,
    local_fraction: f64,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<(), SpeechAlignmentFailureCode> {
    ensure_alignment_project_current(database, authority)?;
    let local_millionths = (local_fraction * 1_000_000.0).round() as u64;
    let completed_steps = u64::try_from(completed_steps).unwrap_or(u64::MAX);
    let total_steps = u64::try_from(total_steps).unwrap_or(u64::MAX).max(1);
    let overall_millionths = completed_steps
        .saturating_mul(1_000_000)
        .saturating_add(local_millionths)
        .checked_div(total_steps)
        .unwrap_or_default()
        .min(1_000_000);
    let millionths =
        u32::try_from(overall_millionths.saturating_mul(900_000) / 1_000_000).unwrap_or(900_000);
    report_alignment_progress(
        jobs,
        job_id,
        SpeechAlignmentPhase::Mixing,
        millionths,
        channel,
    );
    Ok(())
}

fn report_alignment_progress(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    phase: SpeechAlignmentPhase,
    fraction_millionths: u32,
    channel: &Channel<SpeechAlignmentEvent>,
) {
    let fraction_millionths = fraction_millionths.min(950_000);
    if let Ok(current) = jobs.get(job_id)
        && current.snapshot().state() == JobState::Running
    {
        let basis_points = 100_u32
            .saturating_add(fraction_millionths.saturating_mul(9_400) / 1_000_000)
            .min(9_500);
        if let Ok(progress) = JobProgress::from_basis_points(
            u16::try_from(basis_points).expect("basis points are bounded"),
        ) && progress > current.snapshot().progress()
        {
            let _ = jobs.apply(job_id, JobUpdate::ReportProgress(progress));
        }
        let _ = channel.send(SpeechAlignmentEvent::Progress {
            job_id,
            phase,
            fraction_millionths,
        });
    }
}

async fn finish_alignment_job(
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    outcome: Result<SpeechAlignmentResult, SpeechAlignmentFailureCode>,
    channel: &Channel<SpeechAlignmentEvent>,
) {
    match outcome {
        Ok(result) => {
            let completion_jobs = Arc::clone(jobs);
            let completion_database = database.clone();
            let completed = tauri::async_runtime::spawn_blocking(move || {
                completion_jobs.apply_with_store(
                    job_id,
                    JobUpdate::Succeed,
                    |store, sequence, snapshot| {
                        store.complete_project_job(
                            sequence,
                            snapshot,
                            authority.project_id,
                            authority.expected_state_version,
                        )
                    },
                )
            })
            .await
            .ok()
            .and_then(Result::ok)
            .map(|ticket| ticket.snapshot().clone());
            if let Some(job) = completed {
                let _ = channel.send(SpeechAlignmentEvent::Completed {
                    job,
                    project_id: authority.project_id,
                    expected_project_state_version: authority.expected_state_version,
                    result,
                });
            } else {
                let code = ensure_alignment_project_current(&completion_database, authority)
                    .err()
                    .unwrap_or(SpeechAlignmentFailureCode::ArtifactStorage);
                let job = background::finish_failure(jobs, job_id).await;
                let _ = channel.send(SpeechAlignmentEvent::Failed { job, code });
            }
        }
        Err(SpeechAlignmentFailureCode::Cancelled) => {
            if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                let _ = channel.send(SpeechAlignmentEvent::Cancelled { job });
            } else {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(SpeechAlignmentEvent::Failed {
                    job,
                    code: SpeechAlignmentFailureCode::MediaFailed,
                });
            }
        }
        Err(code) => {
            let job = background::finish_failure(jobs, job_id).await;
            let _ = channel.send(SpeechAlignmentEvent::Failed { job, code });
        }
    }
}

fn synthesize_with_retry(
    worker: &LazySpeechWorker,
    request: &SynthesisRequest,
    output: &SpeechOutput,
    control: &RunControl,
) -> Result<osg_speech::SpeechArtifact, SpeechError> {
    match worker.synthesize(request, output, control) {
        Err(error) if retryable_speech_error(&error) && !control.cancellation().is_cancelled() => {
            worker.synthesize(request, output, control)
        }
        result => result,
    }
}

fn retryable_speech_error(error: &SpeechError) -> bool {
    matches!(
        error,
        SpeechError::WorkerRejected {
            retryable: true,
            ..
        } | SpeechError::WorkerExited { .. }
            | SpeechError::WorkerIo(_)
    )
}

const fn failure_marks_backend_unhealthy(code: SpeechFailureCode) -> bool {
    matches!(
        code,
        SpeechFailureCode::RuntimeUnavailable
            | SpeechFailureCode::ModelUnavailable
            | SpeechFailureCode::WorkerFailed
    )
}

const fn batch_terminal_failure(code: SpeechFailureCode) -> bool {
    matches!(
        code,
        SpeechFailureCode::ProjectChanged
            | SpeechFailureCode::InvalidRequest
            | SpeechFailureCode::RuntimeUnavailable
            | SpeechFailureCode::ModelUnavailable
            | SpeechFailureCode::ProviderUnavailable
            | SpeechFailureCode::ProviderRateLimited
            | SpeechFailureCode::AuthenticationFailed
            | SpeechFailureCode::ReferenceRejected
            | SpeechFailureCode::TimedOut
            | SpeechFailureCode::WorkerFailed
            | SpeechFailureCode::ArtifactStorage
    )
}

async fn commit_speech_job_success(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    results: Vec<StoredSpeechResult>,
    channel: &Channel<SpeechJobEvent>,
) -> Result<(), SpeechFailureCode> {
    let backend = ownership.backend;
    let lifecycle_epoch = ownership.lifecycle_epoch;
    let success_runtime = runtime.clone();
    let success_ownership = ownership.clone();
    let success_jobs = Arc::clone(jobs);
    let success_channel = channel.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        success_ownership
            .commit_job_success(&success_runtime, &success_jobs, job_id)
            .map(|job| {
                let _ = success_channel.send(SpeechJobEvent::Completed { job, results });
            })
    })
    .await;
    worker_join_result(runtime, backend, lifecycle_epoch, joined)?
}

async fn finish_speech_job(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    jobs: &background::DesktopJobs,
    database: &Database,
    job_id: JobId,
    result: Result<Vec<StoredSpeechResult>, SpeechFailureCode>,
    channel: &Channel<SpeechJobEvent>,
) {
    let manifest_database = database.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        read_manifest(&manifest_database, job_id).map(|manifest| manifest.results)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default();
    match result {
        Ok(results) => {
            match commit_speech_job_success(runtime, ownership, jobs, job_id, results, channel)
                .await
            {
                Ok(()) => {}
                Err(SpeechFailureCode::Cancelled) => {
                    if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                        let _ = channel.send(SpeechJobEvent::Cancelled {
                            job,
                            results: stored,
                        });
                    }
                }
                Err(code) => {
                    let job = background::finish_failure(jobs, job_id).await;
                    let _ = channel.send(SpeechJobEvent::Failed {
                        job,
                        results: stored,
                        code,
                    });
                }
            }
        }
        Err(SpeechFailureCode::Cancelled) => {
            if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                let _ = channel.send(SpeechJobEvent::Cancelled {
                    job,
                    results: stored,
                });
            } else {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(SpeechJobEvent::Failed {
                    job,
                    results: stored,
                    code: SpeechFailureCode::WorkerFailed,
                });
            }
        }
        Err(code) => {
            let job = background::finish_failure(jobs, job_id).await;
            let _ = channel.send(SpeechJobEvent::Failed {
                job,
                results: stored,
                code,
            });
        }
    }
}

async fn initialize_alignment_manifest(
    database: &Database,
    job_id: JobId,
    authority: SpeechProjectAuthority,
) -> CommandResult<()> {
    let database = database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = SpeechAlignmentManifest {
            schema_version: ALIGNMENT_MANIFEST_SCHEMA_VERSION,
            project_id: authority.project_id,
            expected_project_state_version: authority.expected_state_version,
            result: None,
        };
        let value = serde_json::to_value(manifest)
            .map_err(|_| CommandError::internal("The alignment manifest is invalid."))?;
        database.put_project_setting(
            ALIGNMENT_MANIFEST_SCOPE,
            &job_id.to_string(),
            &value,
            authority.project_id,
            authority.expected_state_version,
        )?;
        Ok(())
    })
    .await
    .map_err(|_| CommandError::internal("The alignment manifest task stopped unexpectedly."))?
}

fn read_alignment_manifest(
    database: &Database,
    job_id: JobId,
) -> CommandResult<SpeechAlignmentManifest> {
    let value = database
        .get_setting(ALIGNMENT_MANIFEST_SCOPE, &job_id.to_string())?
        .ok_or_else(|| CommandError::invalid_input("The alignment result is unavailable."))?;
    let manifest: SpeechAlignmentManifest = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The stored alignment result is invalid."))?;
    if manifest.schema_version != ALIGNMENT_MANIFEST_SCHEMA_VERSION
        || manifest.expected_project_state_version > i64::MAX as u64
    {
        return Err(invalid_alignment_manifest_error());
    }
    require_reference_project_state(
        database,
        manifest.project_id,
        manifest.expected_project_state_version,
    )
    .map_err(|_| invalid_alignment_manifest_error())?;
    if let Some(result) = &manifest.result {
        if result.clip_count == 0
            || result.clip_count > MAX_SEGMENTS
            || result.adjusted_count > result.clip_count
            || result.rendered_duration_micros == 0
            || result.rendered_duration_micros > MAX_ALIGNMENT_DURATION_MICROS
            || result.requested_duration_micros > result.rendered_duration_micros
            || result.natural_duration_micros > result.rendered_duration_micros
            || result.maximum_shift_micros > result.rendered_duration_micros
            || result.artifact.format != SpeechArtifactFormatResponse::M4a
            || result.artifact.duration_micros != Some(result.rendered_duration_micros)
            || result.artifact.sample_rate_hz != Some(48_000)
            || result.artifact.channels != Some(2)
        {
            return Err(invalid_alignment_manifest_error());
        }
        let id = parse_artifact_id(&result.artifact.artifact_id)
            .map_err(|_| invalid_alignment_manifest_error())?;
        let resolved = database
            .resolve_artifact(id)
            .map_err(|_| invalid_alignment_manifest_error())?
            .ok_or_else(invalid_alignment_manifest_error)?;
        if resolved.record().kind().as_str() != "alignedNarration"
            || resolved.record().project_id() != Some(manifest.project_id)
        {
            return Err(invalid_alignment_manifest_error());
        }
        let descriptor = descriptor_from_record(resolved.record())
            .map_err(|_| invalid_alignment_manifest_error())?;
        if descriptor != result.artifact {
            return Err(invalid_alignment_manifest_error());
        }
    }
    Ok(manifest)
}

fn store_alignment_result(
    database: &Database,
    job_id: JobId,
    authority: SpeechProjectAuthority,
    result: SpeechAlignmentResult,
) -> Result<(), SpeechAlignmentFailureCode> {
    ensure_alignment_project_current(database, authority)?;
    let Ok(mut manifest) = read_alignment_manifest(database, job_id) else {
        ensure_alignment_project_current(database, authority)?;
        return Err(SpeechAlignmentFailureCode::ArtifactStorage);
    };
    if manifest.project_id != authority.project_id
        || manifest.expected_project_state_version != authority.expected_state_version
    {
        return Err(SpeechAlignmentFailureCode::ArtifactStorage);
    }
    if manifest.result.is_some() {
        return Err(SpeechAlignmentFailureCode::ArtifactStorage);
    }
    manifest.result = Some(result);
    let value =
        serde_json::to_value(manifest).map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
    database
        .put_project_setting(
            ALIGNMENT_MANIFEST_SCOPE,
            &job_id.to_string(),
            &value,
            authority.project_id,
            authority.expected_state_version,
        )
        .map_err(|error| alignment_project_write_failure(&error))
}

fn invalid_alignment_manifest_error() -> CommandError {
    CommandError::internal("The stored alignment result is invalid.")
}

fn read_manifest(database: &Database, job_id: JobId) -> CommandResult<SpeechJobManifest> {
    let value = database
        .get_setting(MANIFEST_SCOPE, &job_id.to_string())?
        .ok_or_else(|| CommandError::invalid_input("The speech job results are unavailable."))?;
    let manifest: SpeechJobManifest = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The stored speech job results are invalid."))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.results.len() > MAX_SEGMENTS
        || manifest.project_id.is_some() != manifest.expected_project_state_version.is_some()
        || manifest
            .expected_project_state_version
            .is_some_and(|version| version > i64::MAX as u64)
    {
        return Err(invalid_manifest_error());
    }
    for result in &manifest.results {
        match result {
            StoredSpeechResult::Completed {
                segment_id,
                artifact,
            } => {
                if SegmentId::new(segment_id.clone()).is_err()
                    || artifact.bytes == 0
                    || artifact.bytes > 512 * 1024 * 1024
                {
                    return Err(invalid_manifest_error());
                }
                let id = parse_artifact_id(&artifact.artifact_id)
                    .map_err(|_| invalid_manifest_error())?;
                let resolved = database
                    .resolve_artifact(id)
                    .map_err(|_| invalid_manifest_error())?
                    .ok_or_else(invalid_manifest_error)?;
                if !matches!(
                    resolved.record().kind().as_str(),
                    "narrationOutput" | "voiceConversion"
                ) || resolved.record().project_id() != manifest.project_id
                {
                    return Err(invalid_manifest_error());
                }
                let stored_descriptor = descriptor_from_record(resolved.record())
                    .map_err(|_| invalid_manifest_error())?;
                if &stored_descriptor != artifact {
                    return Err(invalid_manifest_error());
                }
            }
            StoredSpeechResult::Failed { segment_id, .. } => {
                if SegmentId::new(segment_id.clone()).is_err() {
                    return Err(invalid_manifest_error());
                }
            }
        }
    }
    Ok(manifest)
}

fn invalid_manifest_error() -> CommandError {
    CommandError::internal("The stored speech job results are invalid.")
}

fn append_manifest(
    database: &Database,
    job_id: JobId,
    backend: SpeechBackendRequest,
    project: Option<SpeechProjectAuthority>,
    result: StoredSpeechResult,
) -> Result<(), SpeechFailureCode> {
    let mut manifest =
        read_manifest(database, job_id).map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    if manifest.backend != backend
        || manifest.results.len() >= MAX_SEGMENTS
        || manifest.project_id != project.map(|authority| authority.project_id)
        || manifest.expected_project_state_version
            != project.map(|authority| authority.expected_state_version)
    {
        return Err(SpeechFailureCode::ArtifactStorage);
    }
    manifest.results.push(result);
    let value = serde_json::to_value(manifest).map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    match project {
        Some(authority) => database
            .put_project_setting(
                MANIFEST_SCOPE,
                &job_id.to_string(),
                &value,
                authority.project_id,
                authority.expected_state_version,
            )
            .map_err(|error| project_write_failure(&error)),
        None => database
            .put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)
            .map_err(|_| SpeechFailureCode::ArtifactStorage),
    }
}

fn reference_artifact_kind(project_id: ProjectId) -> String {
    format!("speechReference.{project_id}")
}

fn require_reference_project_state(
    database: &Database,
    project_id: ProjectId,
    expected_state_version: u64,
) -> CommandResult<()> {
    let project = database.load_project(project_id)?.ok_or(
        osg_infrastructure::storage::DatabaseError::ProjectNotFound(project_id),
    )?;
    if project.state_version() != expected_state_version {
        return Err(
            osg_infrastructure::storage::DatabaseError::StaleProjectVersion {
                project_id,
                expected: expected_state_version,
                actual: project.state_version(),
            }
            .into(),
        );
    }
    Ok(())
}

fn reference_record_response(reference: ProjectSpeechReference) -> SpeechReferenceRecordResponse {
    let pending_delivery =
        reference
            .delivery_job_id
            .zip(reference.delivery_id)
            .map(|(job_id, delivery_id)| SpeechReferenceDeliveryResponse {
                job_id,
                delivery_id,
            });
    SpeechReferenceRecordResponse {
        schema_version: 1,
        project_id: reference.project_id,
        project_state_version: reference.committed_project_state_version,
        reference_version: reference.reference_version,
        artifact_id: reference.artifact_id.to_string(),
        transcript: reference.transcript,
        language: reference.language,
        pending_delivery,
    }
}

fn resolve_reference_record(
    database: &Database,
    media_server: &osg_media_server::MediaServer,
    reference: ProjectSpeechReference,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let resolved = database
        .resolve_artifact(reference.artifact_id)?
        .ok_or_else(|| CommandError::invalid_input("The reference audio is unavailable."))?;
    if resolved.record().project_id() != Some(reference.project_id)
        || resolved.record().kind().as_str() != reference_artifact_kind(reference.project_id)
    {
        return Err(CommandError::invalid_input(
            "The reference audio does not belong to this project.",
        ));
    }
    let descriptor = descriptor_from_record(resolved.record())?;
    let playback = register_speech_playback(media_server, resolved.path(), descriptor.format)?;
    Ok(SpeechReferencePlayableResponse {
        reference: reference_record_response(reference),
        playable: SpeechPlayableArtifact {
            artifact: descriptor,
            playback,
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn commit_published_reference(
    database: &Database,
    media_server: &osg_media_server::MediaServer,
    published: &PublishedSpeechArtifact,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
    transcript: String,
    language: String,
    delivery_job_id: Option<JobId>,
    delivery_id: Option<Uuid>,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let stored = match database.put_project_speech_reference(&ProjectSpeechReferenceWrite {
        project_id,
        expected_project_state_version,
        expected_reference_version,
        artifact_id: published.id,
        transcript,
        language,
        delivery_job_id,
        delivery_id,
    }) {
        Ok(stored) => stored,
        Err(error) => {
            rollback_published_speech_artifact(database, published)?;
            return Err(error.into());
        }
    };
    resolve_reference_record(database, media_server, stored)
}

struct ReferencePublicationContext<'a> {
    runtime: &'a SpeechRuntime,
    media_engine: &'a osg_media::MediaEngine,
    work: &'a OwnedStagingDirectory,
    database: &'a Database,
    media_server: &'a osg_media_server::MediaServer,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
}

fn normalize_and_publish_reference(
    context: &ReferencePublicationContext<'_>,
    source_path: &Path,
    backend: SpeechReferenceBackend,
    source_label: &'static str,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let mut source_file = fs::File::open(source_path)
        .map_err(|_| CommandError::invalid_input("The reference audio is unavailable."))?;
    let source_metadata = source_file
        .metadata()
        .map_err(|_| CommandError::invalid_input("The reference audio is unavailable."))?;
    if !source_metadata.is_file()
        || source_metadata.len() == 0
        || source_metadata.len() > MAX_REFERENCE_BYTES
    {
        return Err(CommandError::invalid_input(
            "Reference audio must be a nonempty file no larger than 64 MiB.",
        ));
    }
    let mut staged_source = tempfile::Builder::new()
        .prefix("reference-input-")
        .suffix(".media")
        .tempfile_in(context.work.path())
        .map_err(|_| CommandError::internal("The reference staging area is unavailable."))?;
    let copied = io::copy(
        &mut (&mut source_file).take(MAX_REFERENCE_BYTES.saturating_add(1)),
        staged_source.as_file_mut(),
    )
    .map_err(|_| CommandError::invalid_input("The reference audio could not be read safely."))?;
    if copied != source_metadata.len() || copied > MAX_REFERENCE_BYTES {
        return Err(CommandError::invalid_input(
            "The reference audio changed while it was being imported.",
        ));
    }
    staged_source
        .as_file_mut()
        .flush()
        .and_then(|()| staged_source.as_file().sync_all())
        .map_err(|_| CommandError::internal("The reference staging area is unavailable."))?;
    let source = MediaInput::from_native_selection(staged_source.path())?;
    let cancellation = MediaCancellationToken::default();
    let control =
        MediaRunControl::new(REFERENCE_EXTRACTION_TIMEOUT)?.with_cancellation(cancellation);
    let metadata = context.media_engine.probe(&source, &control)?;
    let duration_micros = metadata
        .duration_us()
        .filter(|duration| {
            *duration > 0 && *duration <= backend.maximum_duration_ms().saturating_mul(1_000)
        })
        .ok_or_else(|| {
            CommandError::invalid_input("The reference-audio duration is outside the safe limit.")
        })?;
    if metadata.primary_audio().is_none() {
        return Err(CommandError::invalid_input(
            "The selected reference does not contain usable audio.",
        ));
    }

    let output_path = context.work.path().join("reference.wav");
    let output = MediaOutput::within_root(&output_path, context.work.path())?;
    let plan = AudioExtractionPlan::new(
        source,
        output,
        AudioOutput::WavPcm16 {
            sample_rate: AudioSampleRate::new(44_100)?,
            channels: ChannelCount::new(2)?,
        },
        MediaTimeRange::new(0, Some(duration_micros))?,
    )?;
    context
        .media_engine
        .execute(&MediaOperation::AudioExtraction(plan), &control)?;
    let normalized =
        AudioAsset::from_native_file(&output_path).map_err(|error| speech_command_error(&error))?;
    let published = publish_project_durable_artifact(
        context.runtime,
        context.database,
        context.project_id,
        None,
        &reference_artifact_kind(context.project_id),
        &output_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(duration_micros),
            sample_rate_hz: Some(44_100),
            channels: Some(2),
            source: source_label,
        },
    )?;
    drop(normalized);
    commit_published_reference(
        context.database,
        context.media_server,
        &published,
        context.project_id,
        context.expected_project_state_version,
        context.expected_reference_version,
        String::new(),
        "Unknown".to_owned(),
        None,
        None,
    )
}

#[derive(Clone, Copy)]
struct SpeechArtifactMetadata {
    format: SpeechArtifactFormatResponse,
    duration_micros: Option<u64>,
    sample_rate_hz: Option<u32>,
    channels: Option<u8>,
    source: &'static str,
}

impl SpeechArtifactMetadata {
    fn from_summary(summary: &osg_speech::SpeechArtifactSummary) -> Self {
        Self {
            format: summary.format().into(),
            duration_micros: Some(summary.duration().get()),
            sample_rate_hz: Some(summary.sample_rate_hz()),
            channels: Some(summary.channels()),
            source: "nativeSpeechWorker",
        }
    }
}

struct PublishedSpeechArtifact {
    id: ArtifactId,
    created: bool,
    descriptor: SpeechArtifactDescriptor,
    #[cfg(test)]
    path: PathBuf,
}

struct PreparedSpeechArtifactPublication {
    source: BufReader<fs::File>,
    draft: ArtifactDraft,
    size_bytes: u64,
    key: SpeechArtifactPublicationKey,
}

impl fmt::Debug for PublishedSpeechArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedSpeechArtifact")
            .field("id", &"<redacted>")
            .field("created", &self.created)
            .field("descriptor", &self.descriptor)
            .field("path", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
fn publish_durable_artifact(
    runtime: &SpeechRuntime,
    database: &Database,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    publish_durable_artifact_with_project(
        runtime,
        database,
        None,
        job_id,
        kind,
        source_path,
        metadata,
    )
}

fn publish_project_durable_artifact(
    runtime: &SpeechRuntime,
    database: &Database,
    project_id: ProjectId,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    publish_durable_artifact_with_project(
        runtime,
        database,
        Some(project_id),
        job_id,
        kind,
        source_path,
        metadata,
    )
}

fn publish_durable_artifact_with_project(
    runtime: &SpeechRuntime,
    database: &Database,
    project_id: Option<ProjectId>,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    let prepared =
        prepare_speech_artifact_publication(project_id, job_id, kind, source_path, metadata)?;
    let gate = runtime
        .artifact_publication_gate(prepared.key.clone())
        .map_err(|_| artifact_storage_error())?;
    let _publication = gate.lock().map_err(|_| artifact_storage_error())?;
    publish_prepared_speech_artifact(database, prepared)
}

fn prepare_speech_artifact_publication(
    project_id: Option<ProjectId>,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PreparedSpeechArtifactPublication> {
    let source_metadata =
        fs::symlink_metadata(source_path).map_err(|_| artifact_storage_error())?;
    let size_bytes = source_metadata.len();
    let maximum_bytes = match kind {
        kind if kind == "speechReference"
            || kind == "speechPreparedReference"
            || kind.starts_with("speechReference.") =>
        {
            MAX_REFERENCE_BYTES
        }
        "narrationOutput" | "voiceConversion" | "alignedNarration" => MAX_CONVERSION_INPUT_BYTES,
        _ => return Err(artifact_storage_error()),
    };
    if !source_metadata.file_type().is_file() || size_bytes == 0 || size_bytes > maximum_bytes {
        return Err(artifact_storage_error());
    }
    let source = fs::File::open(source_path).map_err(|_| artifact_storage_error())?;
    let mut source = BufReader::new(source);
    let content_hash =
        ContentHash::digest_reader(&mut source).map_err(|_| artifact_storage_error())?;
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| artifact_storage_error())?;
    let draft = ArtifactDraft::new(
        ArtifactKind::new(kind).map_err(|_| artifact_storage_error())?,
        content_hash,
        size_bytes,
        serde_json::json!({
            "format": metadata.format,
            "durationMicros": metadata.duration_micros,
            "sampleRateHz": metadata.sample_rate_hz,
            "channels": metadata.channels,
            "source": metadata.source,
        }),
    )
    .map_err(|_| artifact_storage_error())?;
    let draft = match project_id {
        Some(project_id) => draft.with_project(project_id),
        None => draft,
    };
    let draft = match job_id {
        Some(job_id) => draft.with_job(job_id),
        None => draft,
    };
    Ok(PreparedSpeechArtifactPublication {
        source,
        draft,
        size_bytes,
        key: SpeechArtifactPublicationKey {
            kind: kind.to_owned(),
            content_hash: content_hash.as_bytes().to_vec(),
        },
    })
}

fn publish_prepared_speech_artifact(
    database: &Database,
    mut prepared: PreparedSpeechArtifactPublication,
) -> CommandResult<PublishedSpeechArtifact> {
    let (id, created) = match database.register_artifact(&prepared.draft)? {
        ArtifactRegistration::Existing(record) => (record.id(), false),
        ArtifactRegistration::Pending(record) => {
            return Err(
                osg_infrastructure::storage::DatabaseError::ArtifactPublicationInProgress(
                    record.id(),
                )
                .into(),
            );
        }
        ArtifactRegistration::Staging(staging) => {
            let id = staging.record().id();
            let publication = (|| -> io::Result<()> {
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(staging.path())?;
                let copied = io::copy(&mut prepared.source, &mut target)?;
                if copied != prepared.size_bytes {
                    return Err(io::Error::other("speech artifact size changed"));
                }
                target.flush()?;
                target.sync_all()
            })();
            if publication.is_err() || database.mark_artifact_ready(id).is_err() {
                fail_artifact_publication(database, id);
                return Err(artifact_storage_error());
            }
            (id, true)
        }
    };
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(artifact_storage_error)?;
    let descriptor = descriptor_from_record(resolved.record())?;
    Ok(PublishedSpeechArtifact {
        id,
        created,
        descriptor,
        #[cfg(test)]
        path: resolved.path().to_owned(),
    })
}

fn rollback_published_speech_artifact(
    database: &Database,
    published: &PublishedSpeechArtifact,
) -> CommandResult<()> {
    if !published.created {
        return Ok(());
    }
    database
        .remove_artifact(published.id)?
        .filter(|record| record.id() == published.id)
        .map(|_| ())
        .ok_or_else(artifact_storage_error)
}

fn rollback_unowned_publication<T>(
    database: &Database,
    published: &PublishedSpeechArtifact,
    code: SpeechFailureCode,
) -> Result<T, SpeechFailureCode> {
    rollback_published_speech_artifact(database, published)
        .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    Err(code)
}

#[allow(clippy::too_many_arguments)]
fn commit_completed_speech_source<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
    project_id: Option<ProjectId>,
    job_id: JobId,
    segment_id: String,
    kind: &'static str,
    publish_event: F,
) -> Result<StoredSpeechResult, SpeechFailureCode>
where
    F: FnOnce(&StoredSpeechResult),
{
    commit_completed_speech_source_with_hook(
        runtime,
        ownership,
        database,
        source_path,
        metadata,
        project_id,
        job_id,
        segment_id,
        kind,
        |_| {},
        publish_event,
    )
}

#[allow(clippy::too_many_arguments)]
fn commit_completed_speech_source_with_hook<F, E>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
    project_id: Option<ProjectId>,
    job_id: JobId,
    segment_id: String,
    kind: &'static str,
    after_publish: F,
    publish_event: E,
) -> Result<StoredSpeechResult, SpeechFailureCode>
where
    F: FnOnce(&PublishedSpeechArtifact),
    E: FnOnce(&StoredSpeechResult),
{
    let prepared =
        prepare_speech_artifact_publication(project_id, Some(job_id), kind, source_path, metadata)
            .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    let publication_gate = runtime
        .artifact_publication_gate(prepared.key.clone())
        .map_err(|_| SpeechFailureCode::WorkerFailed)?;
    let publication = publication_gate
        .lock()
        .map_err(|_| SpeechFailureCode::WorkerFailed)?;
    ownership.ensure_owned(runtime, database)?;
    let published = publish_prepared_speech_artifact(database, prepared)
        .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    after_publish(&published);
    if let Err(code) = ownership.ensure_owned(runtime, database) {
        return rollback_unowned_publication(database, &published, code);
    }
    let result = StoredSpeechResult::Completed {
        segment_id,
        artifact: published.descriptor.clone(),
    };
    match ownership.commit_manifest_result(runtime, database, job_id, result.clone()) {
        Ok(()) => {
            drop(publication);
            publish_event(&result);
            Ok(result)
        }
        Err(SpeechFailureCode::ArtifactStorage) => {
            rollback_unowned_publication(database, &published, SpeechFailureCode::ArtifactStorage)
        }
        Err(code) => rollback_unowned_publication(database, &published, code),
    }
}

fn fail_artifact_publication(database: &Database, id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("speechPublish") {
        let _ = database.mark_artifact_failed(id, &code);
    }
}

fn artifact_storage_error() -> CommandError {
    CommandError::internal("The speech artifact could not be stored durably.")
}

fn register_speech_playback(
    media_server: &osg_media_server::MediaServer,
    path: &Path,
    format: SpeechArtifactFormatResponse,
) -> CommandResult<RegisteredMedia> {
    media_server
        .register_with_extension(path, format.extension())
        .map_err(Into::into)
}

fn descriptor_from_record(
    record: &osg_infrastructure::storage::ArtifactRecord,
) -> CommandResult<SpeechArtifactDescriptor> {
    let metadata = record
        .metadata()
        .as_object()
        .ok_or_else(|| CommandError::internal("The speech artifact metadata is invalid."))?;
    let format = match metadata.get("format").and_then(serde_json::Value::as_str) {
        Some("wav") => SpeechArtifactFormatResponse::Wav,
        Some("mp3") => SpeechArtifactFormatResponse::Mp3,
        Some("m4a") => SpeechArtifactFormatResponse::M4a,
        _ => {
            return Err(CommandError::internal(
                "The speech artifact metadata is invalid.",
            ));
        }
    };
    let optional_u64 = |key: &str| -> CommandResult<Option<u64>> {
        match metadata.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .map(Some)
                .ok_or_else(|| CommandError::internal("The speech artifact metadata is invalid.")),
        }
    };
    let duration_micros = optional_u64("durationMicros")?;
    let sample_rate_hz = optional_u64("sampleRateHz")?
        .map(u32::try_from)
        .transpose()
        .map_err(|_| CommandError::internal("The speech artifact metadata is invalid."))?;
    let channels = optional_u64("channels")?
        .map(u8::try_from)
        .transpose()
        .map_err(|_| CommandError::internal("The speech artifact metadata is invalid."))?;
    if record.size_bytes() == 0
        || duration_micros == Some(0)
        || duration_micros.is_some_and(|duration| duration > 7 * 24 * 60 * 60 * 1_000_000)
        || sample_rate_hz.is_some_and(|rate| !(8_000..=384_000).contains(&rate))
        || channels.is_some_and(|channels| !(1..=8).contains(&channels))
    {
        return Err(CommandError::internal(
            "The speech artifact metadata is invalid.",
        ));
    }
    Ok(SpeechArtifactDescriptor {
        artifact_id: record.id().to_string(),
        format,
        bytes: record.size_bytes(),
        duration_micros,
        sample_rate_hz,
        channels,
    })
}

fn resolve_audio_artifact(
    database: &Database,
    value: &str,
    reference_only: bool,
) -> CommandResult<AudioAsset> {
    let id = parse_artifact_id(value)?;
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(|| CommandError::invalid_input("The speech audio is unavailable."))?;
    ensure_speech_artifact_kind(resolved.record().kind().as_str(), reference_only)?;
    let maximum_bytes = if reference_only {
        MAX_REFERENCE_BYTES
    } else {
        MAX_CONVERSION_INPUT_BYTES
    };
    if resolved.record().size_bytes() > maximum_bytes {
        return Err(CommandError::invalid_input(
            "The speech audio exceeds the safe reference limit.",
        ));
    }
    let descriptor = descriptor_from_record(resolved.record())?;
    let format = match descriptor.format {
        SpeechArtifactFormatResponse::Wav => AudioFormat::Wav,
        SpeechArtifactFormatResponse::Mp3 => AudioFormat::Mp3,
        SpeechArtifactFormatResponse::M4a => AudioFormat::M4a,
    };
    let asset = AudioAsset::from_trusted_native_file(resolved.path(), format)
        .map_err(|error| speech_command_error(&error))?;
    if asset.bytes() != resolved.record().size_bytes() {
        return Err(CommandError::internal(
            "The stored speech audio changed unexpectedly.",
        ));
    }
    Ok(asset)
}

fn resolve_alignment_audio(
    database: &Database,
    value: &str,
) -> CommandResult<(
    AudioAsset,
    MediaInput,
    SpeechArtifactDescriptor,
    Option<ProjectId>,
)> {
    let id = parse_artifact_id(value)?;
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(|| CommandError::invalid_input("The narration audio is unavailable."))?;
    if !matches!(
        resolved.record().kind().as_str(),
        "narrationOutput" | "voiceConversion"
    ) {
        return Err(CommandError::invalid_input(
            "The artifact is not generated narration audio.",
        ));
    }
    if resolved.record().size_bytes() > MAX_CONVERSION_INPUT_BYTES {
        return Err(CommandError::invalid_input(
            "The narration audio exceeds the safe alignment limit.",
        ));
    }
    let descriptor = descriptor_from_record(resolved.record())?;
    let format = match descriptor.format {
        SpeechArtifactFormatResponse::Wav => AudioFormat::Wav,
        SpeechArtifactFormatResponse::Mp3 => AudioFormat::Mp3,
        SpeechArtifactFormatResponse::M4a => AudioFormat::M4a,
    };
    let asset = AudioAsset::from_trusted_native_file(resolved.path(), format)
        .map_err(|error| speech_command_error(&error))?;
    if asset.bytes() != descriptor.bytes {
        return Err(CommandError::internal(
            "The stored narration audio changed unexpectedly.",
        ));
    }
    let media = MediaInput::from_native_selection(resolved.path())?;
    Ok((asset, media, descriptor, resolved.record().project_id()))
}

fn ensure_speech_artifact_kind(kind: &str, reference_only: bool) -> CommandResult<()> {
    let allowed = if reference_only {
        matches!(kind, "speechReference" | "speechPreparedReference")
            || kind.starts_with("speechReference.")
    } else {
        matches!(
            kind,
            "speechReference"
                | "speechPreparedReference"
                | "narrationOutput"
                | "voiceConversion"
                | "alignedNarration"
        ) || kind.starts_with("speechReference.")
    };
    allowed
        .then_some(())
        .ok_or_else(|| CommandError::invalid_input("The artifact is not usable speech audio."))
}

fn parse_artifact_id(value: &str) -> CommandResult<ArtifactId> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| CommandError::invalid_input("The speech artifact identifier is invalid."))?;
    ArtifactId::from_uuid(uuid)
        .map_err(|_| CommandError::invalid_input("The speech artifact identifier is invalid."))
}

fn speech_failure(error: &SpeechError) -> (SpeechFailureCode, bool) {
    match error {
        SpeechError::Cancelled => (SpeechFailureCode::Cancelled, false),
        SpeechError::InvalidInput(_)
        | SpeechError::InvalidOption(_)
        | SpeechError::BackendMismatch => (SpeechFailureCode::InvalidRequest, false),
        SpeechError::InvalidAsset(_) => (SpeechFailureCode::ReferenceRejected, false),
        SpeechError::WorkerNotFound | SpeechError::InvalidWorker(_) => {
            (SpeechFailureCode::RuntimeUnavailable, false)
        }
        SpeechError::WorkerRejected { code, retryable } => {
            let code = match *code {
                "model_unavailable" => SpeechFailureCode::ModelUnavailable,
                "provider_unavailable" => SpeechFailureCode::ProviderUnavailable,
                "provider_rate_limited" => SpeechFailureCode::ProviderRateLimited,
                "authentication_failed" => SpeechFailureCode::AuthenticationFailed,
                "reference_rejected" => SpeechFailureCode::ReferenceRejected,
                "encoding_failed" => SpeechFailureCode::EncodingFailed,
                _ => SpeechFailureCode::SynthesisFailed,
            };
            (code, *retryable)
        }
        SpeechError::TimedOut { .. } => (SpeechFailureCode::TimedOut, true),
        SpeechError::MissingArtifact
        | SpeechError::InvalidArtifact(_)
        | SpeechError::OutputExists
        | SpeechError::Publish(_)
        | SpeechError::InvalidDestination(_) => (SpeechFailureCode::EncodingFailed, false),
        SpeechError::Spawn(_)
        | SpeechError::WorkerIo(_)
        | SpeechError::Protocol(_)
        | SpeechError::FrameLimit
        | SpeechError::WorkerExited { .. }
        | SpeechError::StateUnavailable => (SpeechFailureCode::WorkerFailed, true),
    }
}

fn speech_command_error(error: &SpeechError) -> CommandError {
    let (code, _) = speech_failure(error);
    speech_failure_code_command_error(code)
}

fn speech_failure_code_command_error(code: SpeechFailureCode) -> CommandError {
    let message = match code {
        SpeechFailureCode::Cancelled => "The speech operation was cancelled.",
        SpeechFailureCode::ProjectChanged => {
            "The narration project changed while speech was being generated."
        }
        SpeechFailureCode::InvalidRequest => "The speech request is invalid.",
        SpeechFailureCode::RuntimeUnavailable => {
            "The selected speech runtime is not installed or is incomplete."
        }
        SpeechFailureCode::ModelUnavailable => "The selected speech model is unavailable.",
        SpeechFailureCode::ProviderUnavailable => "The speech provider is unavailable.",
        SpeechFailureCode::ProviderRateLimited => "The speech provider is rate limited.",
        SpeechFailureCode::AuthenticationFailed => "The speech credential was rejected.",
        SpeechFailureCode::ReferenceRejected => "The reference audio is invalid or unsupported.",
        SpeechFailureCode::SynthesisFailed => "Speech synthesis could not be completed.",
        SpeechFailureCode::EncodingFailed => "The speech audio artifact is invalid.",
        SpeechFailureCode::TimedOut => "The speech operation exceeded its safe time limit.",
        SpeechFailureCode::WorkerFailed => "The native speech worker stopped unexpectedly.",
        SpeechFailureCode::ArtifactStorage => "The speech artifact could not be stored.",
    };
    match code {
        SpeechFailureCode::ProjectChanged => CommandError::stale_project_version(),
        SpeechFailureCode::InvalidRequest | SpeechFailureCode::ReferenceRejected => {
            CommandError::invalid_input(message)
        }
        _ => CommandError::internal(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_constructor_creates_the_optional_f5_model_store_before_canonicalizing_it() {
        let directory = tempfile::tempdir().unwrap();
        let work = directory.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let authority = RuntimeStagingAuthority::prepare(&work.join("authority")).unwrap();
        let install = directory.path().join("fresh-install");
        let runtime = SpeechRuntime::new_with_staging_authority(
            &install,
            &work,
            None,
            authority,
        ).unwrap();
        assert!(runtime.0.model_store.is_dir());
    }

    fn standalone_runtime(directory: &TempDir) -> SpeechRuntime {
        SpeechRuntime::new(
            directory.path().join("standalone-install"),
            directory.path().join("standalone-work"),
            None,
        )
        .unwrap()
    }

    struct SpeechTestFixture {
        directory: TempDir,
        runtime: SpeechRuntime,
        database: Database,
        jobs: background::DesktopJobs,
    }

    impl SpeechTestFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let runtime = SpeechRuntime::new(
                directory.path().join("install"),
                directory.path().join("work"),
                None,
            )
            .unwrap();
            let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
            let jobs = Arc::new(
                osg_application::JobRegistry::new(Arc::new(database.clone()), []).unwrap(),
            );
            Self {
                directory,
                runtime,
                database,
                jobs,
            }
        }

        fn enable(&self, backend: SpeechBackendRequest) -> SpeechLifecycleOwnership {
            let epoch = self.runtime.lifecycle_epoch(backend).unwrap();
            assert!(
                self.runtime
                    .commit_voice_inventory_for_epoch(backend, epoch, Vec::new())
            );
            SpeechLifecycleOwnership::capture(&self.runtime, backend, epoch).unwrap()
        }

        fn registered_running_job(&self) -> JobId {
            let queued = self.jobs.register(JobKind::SynthesizeNarration).unwrap();
            let job_id = queued.snapshot().id();
            self.jobs.apply(job_id, JobUpdate::Start).unwrap();
            job_id
        }

        fn running_job(&self, backend: SpeechBackendRequest) -> JobId {
            let job_id = self.registered_running_job();
            self.database
                .put_setting(
                    MANIFEST_SCOPE,
                    &job_id.to_string(),
                    &serde_json::to_value(SpeechJobManifest {
                        schema_version: MANIFEST_SCHEMA_VERSION,
                        backend,
                        project_id: None,
                        expected_project_state_version: None,
                        results: Vec::new(),
                    })
                    .unwrap(),
                )
                .unwrap();
            job_id
        }
    }

    fn test_artifact_metadata(source: &'static str) -> SpeechArtifactMetadata {
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(1_000_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source,
        }
    }

    fn commit_empty_project_revision(
        database: &Database,
        project: &osg_application::ProjectSnapshot,
        reason: &str,
    ) {
        let changed = osg_application::ProjectSnapshot::new(
            project.metadata().clone(),
            project.state_version(),
            Vec::new(),
            Vec::new(),
        )
        .unwrap();
        database
            .commit_project(&changed, &osg_domain::RevisionReason::new(reason).unwrap())
            .unwrap();
    }

    fn publish_project_narration_test_artifact(
        fixture: &SpeechTestFixture,
        project_id: ProjectId,
        name: &str,
    ) -> String {
        let source = fixture.directory.path().join(format!("{name}.wav"));
        fs::write(&source, format!("project narration artifact {name}")).unwrap();
        publish_project_durable_artifact(
            &fixture.runtime,
            &fixture.database,
            project_id,
            None,
            "narrationOutput",
            &source,
            test_artifact_metadata("projectNarrationTest"),
        )
        .unwrap()
        .descriptor
        .artifact_id
    }

    fn project_narration_result(
        subtitle_id: i64,
        artifact_id: String,
    ) -> SpeechProjectNarrationResultRequest {
        SpeechProjectNarrationResultRequest {
            subtitle_id: SpeechNarrationCueId::Number(subtitle_id),
            text: format!("Narration {subtitle_id}"),
            artifact_id,
            method: "gtts".to_owned(),
            output_index: Some(u32::try_from(subtitle_id).unwrap()),
            original_ids: vec![SpeechNarrationCueId::Number(subtitle_id)],
            start_micros: u64::try_from(subtitle_id).unwrap() * 1_000_000,
            end_micros: u64::try_from(subtitle_id + 1).unwrap() * 1_000_000,
        }
    }

    #[test]
    fn project_narration_survives_reopen_and_becomes_inert_after_revision() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database_path = directory.path().join("project-narration.sqlite3");
        let database = Database::open(&database_path).unwrap();
        let project_id = ProjectId::new();
        let project = database
            .create_project(
                &osg_domain::ProjectMetadata::with_id(project_id, "Narration project").unwrap(),
            )
            .unwrap();
        let source = directory.path().join("narration.wav");
        fs::write(&source, b"durable project narration").unwrap();
        let artifact_id = publish_project_durable_artifact(
            &runtime,
            &database,
            project_id,
            None,
            "narrationOutput",
            &source,
            test_artifact_metadata("projectNarrationReopenTest"),
        )
        .unwrap()
        .descriptor
        .artifact_id;
        let response = put_project_narration(
            &database,
            SpeechProjectNarrationPutRequest {
                project_id,
                expected_project_state_version: project.state_version(),
                source: SpeechNarrationSource::Original,
                results: vec![project_narration_result(1, artifact_id.clone())],
            },
        )
        .unwrap();
        assert_eq!(response.project_id, project_id);
        assert_eq!(response.project_state_version, project.state_version());
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].artifact.artifact_id, artifact_id);
        put_project_narration(
            &database,
            SpeechProjectNarrationPutRequest {
                project_id,
                expected_project_state_version: project.state_version(),
                source: SpeechNarrationSource::Translated,
                results: vec![project_narration_result(2, artifact_id)],
            },
        )
        .unwrap();
        drop(database);

        let reopened = Database::open(&database_path).unwrap();
        let restored =
            get_project_narration(&reopened, project_id, SpeechNarrationSource::Original)
                .unwrap()
                .unwrap();
        assert_eq!(restored.source, SpeechNarrationSource::Original);
        assert_eq!(restored.results.len(), 1);
        let translated =
            get_project_narration(&reopened, project_id, SpeechNarrationSource::Translated)
                .unwrap()
                .unwrap();
        assert_eq!(translated.results.len(), 1);
        assert_eq!(
            translated.results[0].subtitle_id,
            SpeechNarrationCueId::Number(2)
        );
        let current = reopened.load_project(project_id).unwrap().unwrap();
        commit_empty_project_revision(&reopened, &current, "invalidate narration");
        assert!(
            get_project_narration(&reopened, project_id, SpeechNarrationSource::Original)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn project_narration_rejects_stale_cross_project_and_duplicate_writes_atomically() {
        let fixture = SpeechTestFixture::new();
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        let snapshot_a = fixture
            .database
            .create_project(&osg_domain::ProjectMetadata::with_id(project_a, "Project A").unwrap())
            .unwrap();
        fixture
            .database
            .create_project(&osg_domain::ProjectMetadata::with_id(project_b, "Project B").unwrap())
            .unwrap();
        let artifact_a = publish_project_narration_test_artifact(&fixture, project_a, "project-a");
        let artifact_b = publish_project_narration_test_artifact(&fixture, project_b, "project-b");
        put_project_narration(
            &fixture.database,
            SpeechProjectNarrationPutRequest {
                project_id: project_a,
                expected_project_state_version: snapshot_a.state_version(),
                source: SpeechNarrationSource::Original,
                results: vec![project_narration_result(1, artifact_a.clone())],
            },
        )
        .unwrap();
        let before = fixture
            .database
            .get_setting(
                PROJECT_NARRATION_SCOPE,
                &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
            )
            .unwrap();

        assert!(
            put_project_narration(
                &fixture.database,
                SpeechProjectNarrationPutRequest {
                    project_id: project_a,
                    expected_project_state_version: snapshot_a.state_version(),
                    source: SpeechNarrationSource::Translated,
                    results: vec![project_narration_result(2, artifact_b)],
                },
            )
            .is_err()
        );
        assert_eq!(
            fixture
                .database
                .get_setting(
                    PROJECT_NARRATION_SCOPE,
                    &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
                )
                .unwrap(),
            before
        );

        assert!(
            put_project_narration(
                &fixture.database,
                SpeechProjectNarrationPutRequest {
                    project_id: project_a,
                    expected_project_state_version: snapshot_a.state_version(),
                    source: SpeechNarrationSource::Grouped,
                    results: vec![
                        project_narration_result(2, artifact_a.clone()),
                        project_narration_result(2, artifact_a),
                    ],
                },
            )
            .is_err()
        );
        assert_eq!(
            fixture
                .database
                .get_setting(
                    PROJECT_NARRATION_SCOPE,
                    &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
                )
                .unwrap(),
            before
        );

        commit_empty_project_revision(&fixture.database, &snapshot_a, "stale write");
        assert!(
            put_project_narration(
                &fixture.database,
                SpeechProjectNarrationPutRequest {
                    project_id: project_a,
                    expected_project_state_version: snapshot_a.state_version(),
                    source: SpeechNarrationSource::Original,
                    results: Vec::new(),
                },
            )
            .is_err()
        );
        assert_eq!(
            fixture
                .database
                .get_setting(
                    PROJECT_NARRATION_SCOPE,
                    &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
                )
                .unwrap(),
            before
        );
    }

    #[test]
    fn project_narration_refuses_malformed_current_storage() {
        let fixture = SpeechTestFixture::new();
        let project_id = ProjectId::new();
        fixture
            .database
            .create_project(
                &osg_domain::ProjectMetadata::with_id(project_id, "Corrupt narration").unwrap(),
            )
            .unwrap();
        fixture
            .database
            .put_setting(
                PROJECT_NARRATION_SCOPE,
                &project_narration_storage_key(project_id, SpeechNarrationSource::Original),
                &serde_json::json!({
                    "schemaVersion": PROJECT_NARRATION_SCHEMA_VERSION,
                    "projectId": project_id,
                    "projectStateVersion": 0,
                    "source": "original",
                    "results": [{
                        "subtitleId": 1,
                        "text": "bad timing",
                        "artifactId": "not-an-artifact",
                        "method": "gtts",
                        "outputIndex": 0,
                        "originalIds": [1],
                        "startMicros": 2,
                        "endMicros": 1
                    }]
                }),
            )
            .unwrap();
        assert!(
            get_project_narration(
                &fixture.database,
                project_id,
                SpeechNarrationSource::Original,
            )
            .is_err()
        );
    }

    #[test]
    fn completed_narration_artifact_is_bound_to_its_project() {
        let fixture = SpeechTestFixture::new();
        let backend = SpeechBackendRequest::Gtts;
        let lifecycle = fixture.enable(backend);
        let project_id = ProjectId::new();
        let metadata = osg_domain::ProjectMetadata::with_id(project_id, "Narration owner").unwrap();
        let project = fixture.database.create_project(&metadata).unwrap();
        let ownership = SpeechLifecycleOwnership::capture_project(
            &fixture.runtime,
            backend,
            lifecycle.lifecycle_epoch,
            project_id,
            project.state_version(),
        )
        .unwrap();
        let job_id = fixture.registered_running_job();
        initialize_manifest_with_hook(
            &fixture.runtime,
            &ownership,
            &fixture.database,
            job_id,
            || {},
        )
        .unwrap();
        let source = fixture.directory.path().join("project-owned.wav");
        fs::write(&source, b"project-owned narration").unwrap();

        let result = commit_completed_speech_source(
            &fixture.runtime,
            &ownership,
            &fixture.database,
            &source,
            test_artifact_metadata("projectOwnershipTest"),
            Some(project_id),
            job_id,
            "one".to_owned(),
            "narrationOutput",
            |_| {},
        )
        .unwrap();
        let StoredSpeechResult::Completed { artifact, .. } = result else {
            panic!("completed speech was not published");
        };
        let artifact_id = parse_artifact_id(&artifact.artifact_id).unwrap();
        let stored = fixture
            .database
            .resolve_artifact(artifact_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.record().project_id(), Some(project_id));
        let manifest = read_manifest(&fixture.database, job_id).unwrap();
        assert_eq!(manifest.project_id, Some(project_id));
        assert_eq!(
            manifest.expected_project_state_version,
            Some(project.state_version())
        );
    }

    #[test]
    fn project_change_after_artifact_copy_rolls_back_publication_and_terminal_success() {
        let fixture = SpeechTestFixture::new();
        let backend = SpeechBackendRequest::Gtts;
        let lifecycle = fixture.enable(backend);
        let project_id = ProjectId::new();
        let metadata =
            osg_domain::ProjectMetadata::with_id(project_id, "Revision-bound narration").unwrap();
        let project = fixture.database.create_project(&metadata).unwrap();
        let ownership = SpeechLifecycleOwnership::capture_project(
            &fixture.runtime,
            backend,
            lifecycle.lifecycle_epoch,
            project_id,
            project.state_version(),
        )
        .unwrap();
        let job_id = fixture.registered_running_job();
        initialize_manifest_with_hook(
            &fixture.runtime,
            &ownership,
            &fixture.database,
            job_id,
            || {},
        )
        .unwrap();
        let source = fixture.directory.path().join("stale-project.wav");
        fs::write(&source, b"stale project narration").unwrap();
        let published_id = std::cell::Cell::new(None);

        let result = commit_completed_speech_source_with_hook(
            &fixture.runtime,
            &ownership,
            &fixture.database,
            &source,
            test_artifact_metadata("staleProjectTest"),
            Some(project_id),
            job_id,
            "one".to_owned(),
            "narrationOutput",
            |published| {
                assert!(published.created);
                published_id.set(Some(published.id));
                commit_empty_project_revision(
                    &fixture.database,
                    &project,
                    "concurrent narration edit",
                );
            },
            |_| panic!("a stale narration result was published"),
        );

        assert_eq!(result.unwrap_err(), SpeechFailureCode::ProjectChanged);
        assert!(
            fixture
                .database
                .resolve_artifact(published_id.get().unwrap())
                .unwrap()
                .is_none()
        );
        assert!(
            read_manifest(&fixture.database, job_id)
                .unwrap()
                .results
                .is_empty()
        );
        assert_eq!(
            ownership
                .commit_manifest_result(
                    &fixture.runtime,
                    &fixture.database,
                    job_id,
                    StoredSpeechResult::Failed {
                        segment_id: "late".to_owned(),
                        code: SpeechFailureCode::SynthesisFailed,
                        retryable: true,
                    },
                )
                .unwrap_err(),
            SpeechFailureCode::ProjectChanged
        );
        assert!(
            read_manifest(&fixture.database, job_id)
                .unwrap()
                .results
                .is_empty()
        );
        assert_eq!(
            ownership
                .commit_job_success(&fixture.runtime, &fixture.jobs, job_id)
                .unwrap_err(),
            SpeechFailureCode::ProjectChanged
        );
        assert_eq!(
            fixture.jobs.get(job_id).unwrap().snapshot().state(),
            JobState::Running
        );
    }

    struct BlockedSpeechPublication {
        artifact: std::sync::mpsc::Receiver<ArtifactId>,
        release: std::sync::mpsc::Sender<()>,
        event: std::sync::mpsc::Receiver<()>,
        handle: std::thread::JoinHandle<Result<StoredSpeechResult, SpeechFailureCode>>,
    }

    fn spawn_blocked_speech_publication(
        runtime: SpeechRuntime,
        ownership: SpeechLifecycleOwnership,
        database: Database,
        source: PathBuf,
        job_id: JobId,
    ) -> BlockedSpeechPublication {
        let (artifact_tx, artifact) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let (event_tx, event) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            commit_completed_speech_source_with_hook(
                &runtime,
                &ownership,
                &database,
                &source,
                test_artifact_metadata("crossBackendStopTest"),
                None,
                job_id,
                "stopped".to_owned(),
                "narrationOutput",
                |published| {
                    artifact_tx.send(published.id).unwrap();
                    release_rx.recv().unwrap();
                },
                |_| event_tx.send(()).unwrap(),
            )
        });
        BlockedSpeechPublication {
            artifact,
            release,
            event,
            handle,
        }
    }

    struct LiveSpeechPublication {
        attempted: std::sync::mpsc::Receiver<()>,
        event: std::sync::mpsc::Receiver<()>,
        handle: std::thread::JoinHandle<Result<StoredSpeechResult, SpeechFailureCode>>,
    }

    fn spawn_live_speech_publication(
        runtime: SpeechRuntime,
        ownership: SpeechLifecycleOwnership,
        database: Database,
        source: PathBuf,
        job_id: JobId,
    ) -> LiveSpeechPublication {
        let (attempted_tx, attempted) = std::sync::mpsc::channel();
        let (event_tx, event) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            attempted_tx.send(()).unwrap();
            commit_completed_speech_source(
                &runtime,
                &ownership,
                &database,
                &source,
                test_artifact_metadata("crossBackendStopTest"),
                None,
                job_id,
                "live".to_owned(),
                "narrationOutput",
                |_| event_tx.send(()).unwrap(),
            )
        });
        LiveSpeechPublication {
            attempted,
            event,
            handle,
        }
    }

    async fn assert_stop_during_registration_is_rejected(
        fixture: &SpeechTestFixture,
        backend: SpeechBackendRequest,
    ) {
        let ownership = fixture.enable(backend);
        let stop_runtime = fixture.runtime.clone();
        let result = register_owned_speech_job_with_hook(
            &fixture.runtime,
            &ownership,
            &fixture.database,
            &fixture.jobs,
            move || stop_runtime.shutdown(backend).unwrap(),
        )
        .await;

        assert_eq!(result.unwrap_err().code(), "internal");
        let jobs = fixture.jobs.list().unwrap();
        assert_eq!(jobs.len(), 1);
        let snapshot = jobs[0].snapshot();
        assert_eq!(snapshot.state(), JobState::Cancelled);
        assert!(
            fixture
                .database
                .get_setting(MANIFEST_SCOPE, &snapshot.id().to_string())
                .unwrap()
                .is_none()
        );
    }

    async fn assert_manifest_precommit_stall_is_backend_isolated(
        fixture: &SpeechTestFixture,
        backend: SpeechBackendRequest,
    ) {
        let ownership = fixture.enable(backend);
        let other_backend = SpeechBackendRequest::EdgeTts;
        let other_ownership = fixture.enable(other_backend);
        let job_id = fixture.registered_running_job();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let init_runtime = fixture.runtime.clone();
        let reentry_runtime = fixture.runtime.clone();
        let init_ownership = ownership.clone();
        let init_database = fixture.database.clone();
        let init_jobs = Arc::clone(&fixture.jobs);
        let initializer = tokio::spawn(async move {
            initialize_registered_speech_job_with_hook(
                &init_runtime,
                &init_ownership,
                &init_database,
                &init_jobs,
                job_id,
                move || {
                    let _ = reentry_runtime.status(other_backend);
                    reentry_runtime.shutdown(other_backend).unwrap();
                    let restarted_epoch = reentry_runtime.lifecycle_epoch(other_backend).unwrap();
                    assert!(reentry_runtime.commit_voice_inventory_for_epoch(
                        other_backend,
                        restarted_epoch,
                        Vec::new(),
                    ));
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(other_ownership.ensure_current(&fixture.runtime).is_err());
        let restarted_other_epoch = fixture.runtime.lifecycle_epoch(other_backend).unwrap();
        assert!(
            SpeechLifecycleOwnership::capture(
                &fixture.runtime,
                other_backend,
                restarted_other_epoch,
            )
            .is_ok()
        );
        fixture.runtime.shutdown(backend).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(initializer.await.unwrap().unwrap_err().code(), "internal");
        assert!(
            fixture
                .database
                .get_setting(MANIFEST_SCOPE, &job_id.to_string())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fixture.jobs.get(job_id).unwrap().snapshot().state(),
            JobState::Cancelled
        );
    }

    fn run_async_speech_test(future: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future);
    }

    fn insert_cached_test_worker(
        runtime: &SpeechRuntime,
        backend: SpeechBackendRequest,
        marker: &Path,
    ) {
        let executable = std::env::current_exe().unwrap();
        let worker = Arc::new(ManagedSpeechWorker {
            worker: LazySpeechWorker::new(
                WorkerProgram::native(&executable).unwrap(),
                backend.native(),
            ),
            managed_runtime: None,
        });
        runtime.0.workers.lock().unwrap().insert(
            backend,
            CachedWorker {
                paths: WorkerPaths {
                    python: executable,
                    bootstrap: marker.to_owned(),
                    model: None,
                    model_store: None,
                },
                worker,
            },
        );
    }

    #[test]
    fn runtime_stop_invalidates_in_flight_probe_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::EdgeTts;
        let before_stop = runtime.lifecycle_epoch(backend).unwrap();
        let voices = vec![SpeechVoiceResponse {
            id: "en-US-Test".to_owned(),
            display_name: "Test voice".to_owned(),
            language: "en-US".to_owned(),
            gender: SpeechVoiceGenderResponse::Neutral,
        }];
        assert!(runtime.commit_voice_inventory_for_epoch(backend, before_stop, voices.clone()));
        let lifecycle_cancellation = runtime
            .require_enabled_lifecycle(backend, before_stop)
            .unwrap();

        runtime.shutdown(backend).unwrap();

        let after_stop = runtime.lifecycle_epoch(backend).unwrap();
        assert_ne!(before_stop, after_stop);
        assert!(lifecycle_cancellation.is_cancelled());
        assert!(!runtime.commit_voice_inventory_for_epoch(backend, before_stop, voices));
        let lifecycle = runtime.lifecycle(backend).unwrap();
        assert!(!lifecycle.enabled);
        assert!(lifecycle.voices.is_none());
        assert!(matches!(
            runtime.require_enabled_lifecycle(backend, before_stop),
            Err(SpeechError::Cancelled)
        ));
        assert!(
            runtime
                .enabled_worker_for_epoch(backend, before_stop)
                .is_err()
        );
        assert!(runtime.0.workers.lock().unwrap().is_empty());
    }

    #[test]
    fn replacement_cancels_epoch_before_waiting_for_busy_worker_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::EdgeTts;
        let epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
        let old_cancellation = runtime.require_enabled_lifecycle(backend, epoch).unwrap();
        let (shutdown_started_tx, shutdown_started_rx) = std::sync::mpsc::channel();
        let (release_shutdown_tx, release_shutdown_rx) = std::sync::mpsc::channel();
        let replacement_runtime = runtime.clone();
        let replacement = std::thread::spawn(move || {
            replacement_runtime.invalidate_replacement_before_shutdown(backend, epoch, || {
                shutdown_started_tx.send(()).unwrap();
                release_shutdown_rx.recv().unwrap();
            })
        });

        shutdown_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(old_cancellation.is_cancelled());
        let invalidated = runtime.lifecycle(backend).unwrap();
        assert!(invalidated.epoch > epoch);
        assert!(!invalidated.enabled);
        assert!(invalidated.voices.is_none());
        release_shutdown_tx.send(()).unwrap();
        assert_eq!(replacement.join().unwrap().unwrap(), invalidated.epoch);
    }

    #[test]
    fn delayed_conversion_owner_cannot_cross_stop_and_restart() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::Chatterbox;
        let original_epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, original_epoch, Vec::new()));
        let captured = runtime
            .require_enabled_lifecycle(backend, original_epoch)
            .unwrap();

        runtime.shutdown(backend).unwrap();
        let restarted_epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, restarted_epoch, Vec::new()));

        assert!(captured.is_cancelled());
        assert_ne!(original_epoch, restarted_epoch);
        assert!(
            runtime
                .require_enabled_lifecycle(backend, original_epoch)
                .is_err()
        );
        assert!(
            runtime
                .require_enabled_lifecycle(backend, restarted_epoch)
                .is_ok()
        );
    }

    #[test]
    fn speech_and_conversion_stop_during_registration_never_return_running() {
        for backend in [SpeechBackendRequest::Gtts, SpeechBackendRequest::Chatterbox] {
            let fixture = SpeechTestFixture::new();
            run_async_speech_test(assert_stop_during_registration_is_rejected(
                &fixture, backend,
            ));
        }
    }

    #[test]
    fn manifest_precommit_stalls_allow_cross_backend_reentry_and_stop() {
        for backend in [SpeechBackendRequest::Gtts, SpeechBackendRequest::Chatterbox] {
            let fixture = SpeechTestFixture::new();
            run_async_speech_test(assert_manifest_precommit_stall_is_backend_isolated(
                &fixture, backend,
            ));
        }
    }

    #[test]
    fn same_backend_stop_waits_for_the_exact_commit_gate() {
        let fixture = SpeechTestFixture::new();
        let backend = SpeechBackendRequest::Gtts;
        let ownership = fixture.enable(backend);
        let slot = fixture.runtime.lifecycle_slot(backend).unwrap();
        let commit = slot.commit_gate.lock().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let stop_runtime = fixture.runtime.clone();
        let stopper = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            stop_runtime.shutdown(backend).unwrap();
            finished_tx.send(()).unwrap();
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(finished_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(ownership.ensure_current(&fixture.runtime).is_ok());
        drop(commit);
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        stopper.join().unwrap();
        assert!(ownership.ensure_current(&fixture.runtime).is_err());
    }

    #[test]
    fn stop_after_durable_copy_rolls_back_artifact_and_manifest_before_restart_publication() {
        let fixture = SpeechTestFixture::new();
        let runtime = &fixture.runtime;
        let database = &fixture.database;
        let jobs = &fixture.jobs;
        let backend = SpeechBackendRequest::Gtts;
        let ownership = fixture.enable(backend);
        let job_id = fixture.running_job(backend);
        let source = fixture.directory.path().join("completed.wav");
        fs::write(&source, b"completed worker output").unwrap();
        let restarted_epoch = std::cell::Cell::new(None);
        let event_published = std::cell::Cell::new(false);

        let result = commit_completed_speech_source_with_hook(
            runtime,
            &ownership,
            database,
            &source,
            test_artifact_metadata("hostileStopTest"),
            None,
            job_id,
            "one".to_owned(),
            "narrationOutput",
            |published| {
                assert!(published.created);
                assert!(database.resolve_artifact(published.id).unwrap().is_some());
                runtime.shutdown(backend).unwrap();
                let epoch = runtime.lifecycle_epoch(backend).unwrap();
                assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
                assert!(database.resolve_artifact(published.id).unwrap().is_some());
                restarted_epoch.set(Some(epoch));
            },
            |_| event_published.set(true),
        );

        assert!(
            restarted_epoch.get().is_some(),
            "the publication hook did not run"
        );
        match result {
            Err(code) => assert_eq!(code, SpeechFailureCode::Cancelled),
            Ok(_) => panic!("the stale publication unexpectedly committed"),
        }
        assert!(!event_published.get());
        assert!(read_manifest(database, job_id).unwrap().results.is_empty());
        let fresh = publish_durable_artifact(
            runtime,
            database,
            Some(job_id),
            "narrationOutput",
            &source,
            test_artifact_metadata("hostileStopTest"),
        )
        .unwrap();
        assert!(fresh.created);
        rollback_published_speech_artifact(database, &fresh).unwrap();
        let epoch = restarted_epoch.get().unwrap();
        let restarted = runtime.require_enabled_lifecycle(backend, epoch).unwrap();
        assert!(!restarted.is_cancelled());
        assert!(matches!(
            ownership.commit_job_success(runtime, jobs, job_id),
            Err(SpeechFailureCode::Cancelled)
        ));
        assert_eq!(
            jobs.get(job_id).unwrap().snapshot().state(),
            JobState::Running
        );
    }

    #[test]
    fn stopped_backend_rollback_cannot_delete_another_backends_identical_publication() {
        let fixture = SpeechTestFixture::new();
        let runtime = &fixture.runtime;
        let database = &fixture.database;
        let stopped_backend = SpeechBackendRequest::Gtts;
        let live_backend = SpeechBackendRequest::EdgeTts;
        let stopped_ownership = fixture.enable(stopped_backend);
        let live_ownership = fixture.enable(live_backend);
        let live_epoch = live_ownership.lifecycle_epoch;
        let stopped_job = fixture.running_job(stopped_backend);
        let live_job = fixture.running_job(live_backend);
        let source = fixture.directory.path().join("identical.wav");
        fs::write(&source, b"identical cross-backend speech output").unwrap();
        let blocked = spawn_blocked_speech_publication(
            runtime.clone(),
            stopped_ownership,
            database.clone(),
            source.clone(),
            stopped_job,
        );
        let stopped_artifact = blocked
            .artifact
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        runtime.shutdown(stopped_backend).unwrap();

        let live = spawn_live_speech_publication(
            runtime.clone(),
            live_ownership,
            database.clone(),
            source,
            live_job,
        );
        live.attempted.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            live.event.recv_timeout(Duration::from_millis(50)).is_err(),
            "the second backend crossed the first publication transaction"
        );

        blocked.release.send(()).unwrap();
        assert_eq!(
            blocked.handle.join().unwrap(),
            Err(SpeechFailureCode::Cancelled)
        );
        assert!(blocked.event.try_recv().is_err());
        assert!(
            read_manifest(database, stopped_job)
                .unwrap()
                .results
                .is_empty()
        );
        let live_result = live.handle.join().unwrap().unwrap();
        live.event.recv_timeout(Duration::from_secs(1)).unwrap();
        let StoredSpeechResult::Completed { artifact, .. } = &live_result else {
            panic!("the live backend did not publish its artifact");
        };
        assert_ne!(artifact.artifact_id, stopped_artifact.to_string());
        let live_artifact = parse_artifact_id(&artifact.artifact_id).unwrap();
        assert!(database.resolve_artifact(live_artifact).unwrap().is_some());
        assert_eq!(
            read_manifest(database, live_job).unwrap().results,
            vec![live_result]
        );
        assert!(
            runtime
                .require_enabled_lifecycle(live_backend, live_epoch)
                .is_ok()
        );
    }

    #[test]
    fn different_content_publications_do_not_share_a_cross_backend_gate() {
        let fixture = SpeechTestFixture::new();
        let stopped_backend = SpeechBackendRequest::Gtts;
        let live_backend = SpeechBackendRequest::EdgeTts;
        let stopped_ownership = fixture.enable(stopped_backend);
        let live_ownership = fixture.enable(live_backend);
        let stopped_job = fixture.running_job(stopped_backend);
        let live_job = fixture.running_job(live_backend);
        let blocked_source = fixture.directory.path().join("blocked.wav");
        let live_source = fixture.directory.path().join("live.wav");
        fs::write(&blocked_source, b"blocked speech publication").unwrap();
        fs::write(&live_source, b"independent speech publication").unwrap();
        let blocked = spawn_blocked_speech_publication(
            fixture.runtime.clone(),
            stopped_ownership,
            fixture.database.clone(),
            blocked_source,
            stopped_job,
        );
        blocked
            .artifact
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let live = spawn_live_speech_publication(
            fixture.runtime.clone(),
            live_ownership,
            fixture.database.clone(),
            live_source,
            live_job,
        );
        live.attempted.recv_timeout(Duration::from_secs(1)).unwrap();
        live.event.recv_timeout(Duration::from_secs(1)).unwrap();
        let live_result = live.handle.join().unwrap().unwrap();
        assert_eq!(
            read_manifest(&fixture.database, live_job).unwrap().results,
            vec![live_result]
        );

        fixture.runtime.shutdown(stopped_backend).unwrap();
        blocked.release.send(()).unwrap();
        assert_eq!(
            blocked.handle.join().unwrap(),
            Err(SpeechFailureCode::Cancelled)
        );
        assert!(blocked.event.try_recv().is_err());
        assert!(
            read_manifest(&fixture.database, stopped_job)
                .unwrap()
                .results
                .is_empty()
        );
    }

    #[test]
    fn lifecycle_cancellation_is_isolated_by_backend() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let chatterbox = SpeechBackendRequest::Chatterbox;
        let edge = SpeechBackendRequest::EdgeTts;
        let chatterbox_epoch = runtime.lifecycle_epoch(chatterbox).unwrap();
        let edge_epoch = runtime.lifecycle_epoch(edge).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(chatterbox, chatterbox_epoch, Vec::new()));
        assert!(runtime.commit_voice_inventory_for_epoch(edge, edge_epoch, Vec::new()));
        let chatterbox_owner = runtime
            .require_enabled_lifecycle(chatterbox, chatterbox_epoch)
            .unwrap();
        let edge_owner = runtime.require_enabled_lifecycle(edge, edge_epoch).unwrap();

        runtime.shutdown(edge).unwrap();

        assert!(edge_owner.is_cancelled());
        assert!(!chatterbox_owner.is_cancelled());
        assert!(
            runtime
                .require_enabled_lifecycle(chatterbox, chatterbox_epoch)
                .is_ok()
        );
    }

    #[test]
    fn worker_join_failure_invalidates_batch_and_conversion_owners() {
        for backend in [SpeechBackendRequest::Gtts, SpeechBackendRequest::Chatterbox] {
            let directory = tempfile::tempdir().unwrap();
            let runtime = SpeechRuntime::new(
                directory.path().join("install"),
                directory.path().join("work"),
                None,
            )
            .unwrap();
            let epoch = runtime.lifecycle_epoch(backend).unwrap();
            assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
            let owner = runtime.require_enabled_lifecycle(backend, epoch).unwrap();

            let result = worker_join_result::<(), _>(&runtime, backend, epoch, Err("join failed"));

            assert!(matches!(result, Err(SpeechFailureCode::WorkerFailed)));
            assert!(owner.is_cancelled());
            let lifecycle = runtime.lifecycle(backend).unwrap();
            assert!(lifecycle.epoch > epoch);
            assert!(!lifecycle.enabled);
            assert!(lifecycle.voices.is_none());
        }
    }

    #[test]
    fn probe_join_failure_invalidates_the_actual_epoch_but_not_a_restarted_epoch() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::EdgeTts;
        let other_backend = SpeechBackendRequest::Gtts;
        let requested_epoch = runtime.lifecycle_epoch(backend).unwrap();
        let actual_epoch = runtime
            .invalidate_lifecycle(backend, Some(requested_epoch))
            .unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, actual_epoch, Vec::new()));
        let actual_owner = runtime
            .require_enabled_lifecycle(backend, actual_epoch)
            .unwrap();
        let other_epoch = runtime.lifecycle_epoch(other_backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(other_backend, other_epoch, Vec::new()));
        let other_owner = runtime
            .require_enabled_lifecycle(other_backend, other_epoch)
            .unwrap();
        insert_cached_test_worker(&runtime, backend, &directory.path().join("actual.py"));
        let ownership = ProbeLifecycleOwnership::new(requested_epoch);
        ownership.update(actual_epoch);

        let result = probe_join_result::<(), _>(&runtime, backend, &ownership, Err("join"));

        assert!(result.is_err());
        assert!(actual_owner.is_cancelled());
        assert!(!other_owner.is_cancelled());
        assert!(!runtime.0.workers.lock().unwrap().contains_key(&backend));
        let invalidated_epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(invalidated_epoch > actual_epoch);

        assert!(runtime.commit_voice_inventory_for_epoch(backend, invalidated_epoch, Vec::new()));
        let restarted_owner = runtime
            .require_enabled_lifecycle(backend, invalidated_epoch)
            .unwrap();
        insert_cached_test_worker(&runtime, backend, &directory.path().join("restarted.py"));
        ownership.update(actual_epoch);

        let stale_result =
            probe_join_result::<(), _>(&runtime, backend, &ownership, Err("stale join"));

        assert!(stale_result.is_err());
        assert!(!restarted_owner.is_cancelled());
        assert_eq!(runtime.lifecycle_epoch(backend).unwrap(), invalidated_epoch);
        assert!(runtime.0.workers.lock().unwrap().contains_key(&backend));
    }

    #[test]
    fn voice_inventory_never_creates_or_starts_a_stopped_worker() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::Gtts;
        let epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(
            backend,
            epoch,
            vec![SpeechVoiceResponse {
                id: "en".to_owned(),
                display_name: "English".to_owned(),
                language: "en".to_owned(),
                gender: SpeechVoiceGenderResponse::Unknown,
            }],
        ));
        assert!(runtime.0.workers.lock().unwrap().is_empty());

        assert!(runtime.voice_inventory(backend, epoch).is_err());
        assert!(runtime.0.workers.lock().unwrap().is_empty());

        runtime.shutdown(backend).unwrap();
        assert!(runtime.voice_inventory(backend, epoch).is_err());
        assert!(runtime.0.workers.lock().unwrap().is_empty());
    }

    #[test]
    fn unhealthy_worker_invalidation_advances_epoch_and_drops_inventory() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::Chatterbox;
        let epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
        let lifecycle_cancellation = runtime.require_enabled_lifecycle(backend, epoch).unwrap();

        let next_epoch = runtime
            .invalidate_backend_runtime(backend, Some(epoch))
            .unwrap();

        assert_ne!(epoch, next_epoch);
        assert!(lifecycle_cancellation.is_cancelled());
        let lifecycle = runtime.lifecycle(backend).unwrap();
        assert_eq!(lifecycle.epoch, next_epoch);
        assert!(!lifecycle.enabled);
        assert!(lifecycle.voices.is_none());
    }

    #[test]
    fn cached_worker_replacement_invalidates_the_owned_epoch() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let backend = SpeechBackendRequest::F5Tts;
        let epoch = runtime.lifecycle_epoch(backend).unwrap();
        assert!(runtime.commit_voice_inventory_for_epoch(backend, epoch, Vec::new()));
        let lifecycle_cancellation = runtime.require_enabled_lifecycle(backend, epoch).unwrap();
        let executable = std::env::current_exe().unwrap();
        let worker = Arc::new(ManagedSpeechWorker {
            worker: LazySpeechWorker::new(
                WorkerProgram::native(&executable).unwrap(),
                backend.native(),
            ),
            managed_runtime: None,
        });
        runtime.0.workers.lock().unwrap().insert(
            backend,
            CachedWorker {
                paths: WorkerPaths {
                    python: executable,
                    bootstrap: directory.path().join("replaced-worker.py"),
                    model: None,
                    model_store: None,
                },
                worker,
            },
        );

        let status = runtime.status(backend);

        assert!(status.epoch > epoch);
        assert!(!status.enabled);
        assert!(!status.ready);
        assert!(!status.warm);
        assert!(lifecycle_cancellation.is_cancelled());
        assert!(runtime.0.workers.lock().unwrap().is_empty());
    }

    #[test]
    fn request_debug_redacts_text_and_reference_capability() {
        let request = SpeechStartRequest {
            project_id: ProjectId::new(),
            expected_project_state_version: 0,
            segments: vec![SpeechSegmentRequest {
                id: "one".to_owned(),
                text: "private narration words".to_owned(),
            }],
            profile: SpeechProfileRequest::EdgeTts {
                voice: "en-US-AriaNeural".to_owned(),
                rate_percent: 0,
                volume_percent: 0,
                pitch_hz: 0,
            },
            reference_artifact_id: Some(ArtifactId::new().to_string()),
            lifecycle_epoch: 7,
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("private narration"));
        assert!(!debug.contains(request.reference_artifact_id.as_deref().unwrap()));
    }

    #[test]
    fn alignment_request_debug_redacts_artifact_capabilities() {
        let artifact_id = ArtifactId::new().to_string();
        let project_id = ProjectId::new();
        let request = SpeechAlignmentStartRequest {
            project_id,
            expected_project_state_version: 7,
            clips: vec![SpeechAlignmentClipRequest {
                id: "segment-1".to_owned(),
                artifact_id: artifact_id.clone(),
                start_micros: 0,
                cue_end_micros: 1_000_000,
            }],
        };
        let clip_debug = format!("{:?}", request.clips[0]);
        assert!(!clip_debug.contains(&artifact_id));
        assert!(!format!("{request:?}").contains(&artifact_id));
        assert!(!format!("{request:?}").contains(&project_id.to_string()));
    }

    #[test]
    fn export_request_debug_redacts_artifact_capabilities_and_file_names() {
        let artifact_id = ArtifactId::new().to_string();
        let request = SpeechArtifactExportRequest {
            entries: vec![SpeechArtifactExportEntry {
                artifact_id: artifact_id.clone(),
                file_name: "private_narration.wav".to_owned(),
            }],
            archive_name: None,
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains(&artifact_id));
        assert!(!debug.contains("private_narration"));
        assert!(debug.contains("entry_count: 1"));
    }

    #[test]
    fn speech_export_resolves_opaque_artifacts_and_writes_a_bounded_archive() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let first_path = directory.path().join("first.wav");
        let second_path = directory.path().join("second.wav");
        fs::write(&first_path, b"first narration bytes").unwrap();
        fs::write(&second_path, b"second narration bytes").unwrap();
        let first = publish_durable_artifact(
            &runtime,
            &database,
            None,
            "narrationOutput",
            &first_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(1_000_000),
                sample_rate_hz: Some(24_000),
                channels: Some(1),
                source: "test",
            },
        )
        .unwrap();
        let second = publish_durable_artifact(
            &runtime,
            &database,
            None,
            "narrationOutput",
            &second_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(1_000_000),
                sample_rate_hz: Some(24_000),
                channels: Some(1),
                source: "test",
            },
        )
        .unwrap();
        let first_id = first.descriptor.artifact_id;
        let second_id = second.descriptor.artifact_id;
        let plan = prepare_speech_export(
            &database,
            SpeechArtifactExportRequest {
                entries: vec![
                    SpeechArtifactExportEntry {
                        artifact_id: first_id.clone(),
                        file_name: "narration_1.wav".to_owned(),
                    },
                    SpeechArtifactExportEntry {
                        artifact_id: second_id.clone(),
                        file_name: "narration_2.wav".to_owned(),
                    },
                ],
                archive_name: Some("narration_audio.zip".to_owned()),
            },
        )
        .unwrap();
        let destination = directory.path().join("export.zip");
        export_speech_plan(&runtime.0.staging_authority, &plan, &destination).unwrap();

        let mut archive = zip::ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        let mut first_bytes = Vec::new();
        archive
            .by_name("narration_1.wav")
            .unwrap()
            .read_to_end(&mut first_bytes)
            .unwrap();
        assert_eq!(first_bytes, b"first narration bytes");
        let mut second_bytes = Vec::new();
        archive
            .by_name("narration_2.wav")
            .unwrap()
            .read_to_end(&mut second_bytes)
            .unwrap();
        assert_eq!(second_bytes, b"second narration bytes");

        assert!(
            prepare_speech_export(
                &database,
                SpeechArtifactExportRequest {
                    entries: vec![
                        SpeechArtifactExportEntry {
                            artifact_id: first_id,
                            file_name: "duplicate.wav".to_owned(),
                        },
                        SpeechArtifactExportEntry {
                            artifact_id: second_id,
                            file_name: "duplicate.wav".to_owned(),
                        },
                    ],
                    archive_name: Some("narration_audio.zip".to_owned()),
                },
            )
            .is_err()
        );
    }

    #[test]
    fn speech_export_writes_a_verified_single_artifact() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let source_path = directory.path().join("source.wav");
        fs::write(&source_path, b"single narration bytes").unwrap();
        let artifact = publish_durable_artifact(
            &runtime,
            &database,
            None,
            "narrationOutput",
            &source_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(1_000_000),
                sample_rate_hz: Some(24_000),
                channels: Some(1),
                source: "test",
            },
        )
        .unwrap();
        let plan = prepare_speech_export(
            &database,
            SpeechArtifactExportRequest {
                entries: vec![SpeechArtifactExportEntry {
                    artifact_id: artifact.descriptor.artifact_id,
                    file_name: "narration.wav".to_owned(),
                }],
                archive_name: None,
            },
        )
        .unwrap();
        let destination = directory.path().join("narration.wav");

        export_speech_plan(&runtime.0.staging_authority, &plan, &destination).unwrap();

        assert_eq!(fs::read(destination).unwrap(), b"single narration bytes");
    }

    #[test]
    fn speech_export_rejects_paths_duplicates_and_changed_source_bytes() {
        assert!(!is_safe_export_file_name("../private.wav", "wav"));
        assert!(!is_safe_export_file_name("C_private.wav.exe", "wav"));
        assert!(is_safe_export_file_name("aligned_narration.m4a", "m4a"));

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.wav");
        fs::write(&source, b"changed").unwrap();
        let plan = SpeechExportPlan {
            sources: vec![SpeechExportSource {
                path: source,
                content_hash: ContentHash::digest(b"expected"),
                expected_bytes: 7,
                file_name: "narration_1.wav".to_owned(),
            }],
            archive_name: None,
        };
        let destination = directory.path().join("changed.wav");
        let authority_directory = tempfile::tempdir().unwrap();
        let authority = RuntimeStagingAuthority::prepare(authority_directory.path()).unwrap();
        assert!(export_speech_plan(&authority, &plan, &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn events_and_artifact_descriptors_are_path_and_secret_free() {
        let event = SpeechJobEvent::Progress {
            job_id: JobId::new(),
            segment_id: Some("segment-1".to_owned()),
            index: 1,
            total: 2,
            phase: SpeechPhaseResponse::Synthesizing,
            fraction_millionths: 500_000,
        };
        let encoded = serde_json::to_string(&event).unwrap();
        assert!(!encoded.to_ascii_lowercase().contains("path"));
        assert!(!encoded.to_ascii_lowercase().contains("secret"));
        assert!(!encoded.contains("C:\\"));
    }

    #[test]
    fn gemini_models_are_closed_to_the_synced_audio_catalog() {
        let valid = SpeechProfileRequest::GeminiTts {
            credential_id: CredentialId::new(),
            model: "gemini-3.1-flash-live-preview".to_owned(),
            voice: "Aoede".to_owned(),
            language: "en-US".to_owned(),
        };
        assert!(valid.into_native().is_ok());

        let invalid = SpeechProfileRequest::GeminiTts {
            credential_id: CredentialId::new(),
            model: "text-only-model".to_owned(),
            voice: "Aoede".to_owned(),
            language: "en-US".to_owned(),
        };
        assert!(invalid.into_native().is_err());
    }

    #[test]
    fn reference_ranges_are_backend_bounded() {
        assert_eq!(SpeechReferenceBackend::F5Tts.maximum_duration_ms(), 12_000);
        assert_eq!(
            SpeechReferenceBackend::Chatterbox.maximum_duration_ms(),
            60_000
        );
    }

    #[test]
    fn backend_text_limits_match_the_frontend_contract() {
        assert_eq!(
            SpeechBackendRequest::Chatterbox.maximum_text_characters(),
            300
        );
        for backend in [
            SpeechBackendRequest::F5Tts,
            SpeechBackendRequest::EdgeTts,
            SpeechBackendRequest::Gtts,
            SpeechBackendRequest::GeminiTts,
        ] {
            assert_eq!(backend.maximum_text_characters(), 8_000);
        }
    }

    #[test]
    fn backend_wide_failures_stop_a_batch_without_suppressing_segment_failures() {
        for code in [
            SpeechFailureCode::InvalidRequest,
            SpeechFailureCode::RuntimeUnavailable,
            SpeechFailureCode::ModelUnavailable,
            SpeechFailureCode::ProviderUnavailable,
            SpeechFailureCode::ProviderRateLimited,
            SpeechFailureCode::AuthenticationFailed,
            SpeechFailureCode::ReferenceRejected,
            SpeechFailureCode::TimedOut,
            SpeechFailureCode::WorkerFailed,
            SpeechFailureCode::ArtifactStorage,
        ] {
            assert!(batch_terminal_failure(code));
        }
        for code in [
            SpeechFailureCode::Cancelled,
            SpeechFailureCode::SynthesisFailed,
            SpeechFailureCode::EncodingFailed,
        ] {
            assert!(!batch_terminal_failure(code));
        }
    }

    #[test]
    fn alignment_validation_uses_durable_artifacts_and_bounded_native_timing() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let project_id = ProjectId::new();
        database
            .create_project(
                &osg_domain::ProjectMetadata::with_id(project_id, "Alignment owner").unwrap(),
            )
            .unwrap();
        let first_path = directory.path().join("first.wav");
        let second_path = directory.path().join("second.wav");
        std::fs::write(&first_path, b"RIFF-first-WAVEdata").unwrap();
        std::fs::write(&second_path, b"RIFF-second-WAVEdata").unwrap();
        let first = publish_project_durable_artifact(
            &runtime,
            &database,
            project_id,
            None,
            "narrationOutput",
            &first_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(2_000_000),
                sample_rate_hz: Some(24_000),
                channels: Some(1),
                source: "test",
            },
        )
        .unwrap();
        let second = publish_project_durable_artifact(
            &runtime,
            &database,
            project_id,
            None,
            "narrationOutput",
            &second_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(800_000),
                sample_rate_hz: Some(24_000),
                channels: Some(1),
                source: "test",
            },
        )
        .unwrap();
        let first_artifact_id = first.descriptor.artifact_id.clone();
        let second_artifact_id = second.descriptor.artifact_id.clone();
        std::fs::remove_file(first_path).unwrap();
        std::fs::remove_file(second_path).unwrap();

        let validated = validate_alignment_start(
            &database,
            SpeechAlignmentStartRequest {
                project_id,
                expected_project_state_version: 0,
                clips: vec![
                    SpeechAlignmentClipRequest {
                        id: "first".to_owned(),
                        artifact_id: first_artifact_id,
                        start_micros: 0,
                        cue_end_micros: 1_000_000,
                    },
                    SpeechAlignmentClipRequest {
                        id: "second".to_owned(),
                        artifact_id: second_artifact_id,
                        start_micros: 1_000_000,
                        cue_end_micros: 2_000_000,
                    },
                ],
            },
        )
        .unwrap();
        assert_eq!(validated.project_id, project_id);
        assert_eq!(validated.stats.clip_count, 2);
        assert_eq!(validated.stats.adjusted_count, 1);
        assert_eq!(validated.clips[1].start_micros, 1_800_000);
        assert_eq!(validated.stats.rendered_duration_micros, 2_850_000);
        assert_eq!(
            format!("{:?}", validated.clips[0].input),
            "MediaInput(<redacted>)"
        );
    }

    #[test]
    fn alignment_validation_rejects_unowned_or_cross_project_audio() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        for (id, name) in [(project_a, "Project A"), (project_b, "Project B")] {
            database
                .create_project(&osg_domain::ProjectMetadata::with_id(id, name).unwrap())
                .unwrap();
        }
        let metadata = || SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(1_000_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "alignmentOwnershipTest",
        };
        let source_a = directory.path().join("a.wav");
        let source_b = directory.path().join("b.wav");
        let source_unowned = directory.path().join("unowned.wav");
        fs::write(&source_a, b"owned by a").unwrap();
        fs::write(&source_b, b"owned by b").unwrap();
        fs::write(&source_unowned, b"unowned").unwrap();
        let artifact_a = publish_project_durable_artifact(
            &runtime,
            &database,
            project_a,
            None,
            "narrationOutput",
            &source_a,
            metadata(),
        )
        .unwrap()
        .descriptor
        .artifact_id;
        let artifact_b = publish_project_durable_artifact(
            &runtime,
            &database,
            project_b,
            None,
            "narrationOutput",
            &source_b,
            metadata(),
        )
        .unwrap()
        .descriptor
        .artifact_id;
        let unowned = publish_durable_artifact(
            &runtime,
            &database,
            None,
            "narrationOutput",
            &source_unowned,
            metadata(),
        )
        .unwrap()
        .descriptor
        .artifact_id;
        let clip = |id: &str, artifact_id: String| SpeechAlignmentClipRequest {
            id: id.to_owned(),
            artifact_id,
            start_micros: 0,
            cue_end_micros: 1_000_000,
        };

        assert!(
            validate_alignment_start(
                &database,
                SpeechAlignmentStartRequest {
                    project_id: project_a,
                    expected_project_state_version: 0,
                    clips: vec![clip("unowned", unowned)],
                },
            )
            .is_err()
        );
        assert!(
            validate_alignment_start(
                &database,
                SpeechAlignmentStartRequest {
                    project_id: project_a,
                    expected_project_state_version: 0,
                    clips: vec![clip("a", artifact_a), clip("b", artifact_b)],
                },
            )
            .is_err()
        );
    }

    #[test]
    fn worker_path_debug_is_redacted() {
        let paths = WorkerPaths {
            python: PathBuf::from("C:/private/python.exe"),
            bootstrap: PathBuf::from("C:/private/osg_speech_worker.py"),
            model: Some(PathBuf::from("C:/private/models")),
            model_store: Some(PathBuf::from("C:/private/variants")),
        };
        let debug = format!("{paths:?}");
        assert!(!debug.contains("private"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn reference_publication_rechecks_the_size_bound_before_hashing() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let source = directory.path().join("oversized.wav");
        std::fs::File::create(&source)
            .unwrap()
            .set_len(MAX_REFERENCE_BYTES + 1)
            .unwrap();

        let result = publish_durable_artifact(
            &runtime,
            &database,
            None,
            "speechReference",
            &source,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: None,
                sample_rate_hz: None,
                channels: None,
                source: "nativeSelection",
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn published_speech_artifact_survives_source_removal_and_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database_directory = directory.path().join("database");
        std::fs::create_dir_all(&database_directory).unwrap();
        let database_path = database_directory.join("osg.sqlite3");
        let source = directory.path().join("source.wav");
        let mut wav = Vec::with_capacity(46);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&24_000_u32.to_le_bytes());
        wav.extend_from_slice(&48_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2_u32.to_le_bytes());
        wav.extend_from_slice(&[0, 0]);
        std::fs::write(&source, &wav).unwrap();

        let database = Database::open(&database_path).unwrap();
        let published = publish_durable_artifact(
            &runtime,
            &database,
            None,
            "narrationOutput",
            &source,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(42),
                sample_rate_hz: Some(24_000),
                channels: Some(1),
                source: "speechWorker",
            },
        )
        .unwrap();
        let artifact_id = parse_artifact_id(&published.descriptor.artifact_id).unwrap();
        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read(&published.path).unwrap(), wav);
        assert!(published.path.extension().is_none());
        let media_server = osg_media_server::MediaServer::start(std::iter::empty()).unwrap();
        let playback = register_speech_playback(
            &media_server,
            &published.path,
            SpeechArtifactFormatResponse::Wav,
        )
        .unwrap();
        assert!(playback.mime_type.starts_with("audio/"));
        assert!(media_server.unregister(playback.id).unwrap());
        drop(database);

        let reopened = Database::open(&database_path).unwrap();
        let resolved = reopened.resolve_artifact(artifact_id).unwrap().unwrap();
        assert_eq!(std::fs::read(resolved.path()).unwrap(), wav);
        assert_eq!(resolved.record().kind().as_str(), "narrationOutput");
        let reopened_asset =
            resolve_audio_artifact(&reopened, &published.descriptor.artifact_id, false).unwrap();
        assert_eq!(reopened_asset.format(), AudioFormat::Wav);
        assert_eq!(reopened_asset.bytes(), u64::try_from(wav.len()).unwrap());
    }

    #[test]
    fn aligned_result_manifest_and_playback_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = standalone_runtime(&directory);
        let database_directory = directory.path().join("database");
        std::fs::create_dir_all(&database_directory).unwrap();
        let database_path = database_directory.join("osg.sqlite3");
        let source = directory.path().join("aligned.m4a");
        std::fs::write(&source, b"aligned-m4a-fixture").unwrap();
        let database = Database::open(&database_path).unwrap();
        let project_id = ProjectId::new();
        database
            .create_project(&osg_domain::ProjectMetadata::with_id(project_id, "Project").unwrap())
            .unwrap();
        let authority = SpeechProjectAuthority {
            project_id,
            expected_state_version: 0,
        };
        let job_id = JobId::new();
        let published = publish_project_durable_artifact(
            &runtime,
            &database,
            project_id,
            None,
            "alignedNarration",
            &source,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::M4a,
                duration_micros: Some(3_250_000),
                sample_rate_hz: Some(48_000),
                channels: Some(2),
                source: "nativeNarrationAlignment",
            },
        )
        .unwrap();
        database
            .put_project_setting(
                ALIGNMENT_MANIFEST_SCOPE,
                &job_id.to_string(),
                &serde_json::to_value(SpeechAlignmentManifest {
                    schema_version: ALIGNMENT_MANIFEST_SCHEMA_VERSION,
                    project_id,
                    expected_project_state_version: 0,
                    result: None,
                })
                .unwrap(),
                project_id,
                0,
            )
            .unwrap();
        let expected = SpeechAlignmentResult {
            artifact: published.descriptor,
            clip_count: 3,
            adjusted_count: 1,
            requested_duration_micros: 3_000_000,
            natural_duration_micros: 3_000_000,
            rendered_duration_micros: 3_250_000,
            maximum_shift_micros: 800_000,
        };
        store_alignment_result(&database, job_id, authority, expected.clone()).unwrap();
        std::fs::remove_file(source).unwrap();
        drop(database);

        let reopened = Database::open(&database_path).unwrap();
        let restored = read_alignment_manifest(&reopened, job_id).unwrap();
        assert_eq!(restored.result, Some(expected.clone()));
        let artifact_id = parse_artifact_id(&expected.artifact.artifact_id).unwrap();
        let resolved = reopened.resolve_artifact(artifact_id).unwrap().unwrap();
        assert!(resolved.path().extension().is_none());
        let project = reopened.load_project(project_id).unwrap().unwrap();
        let changed = osg_application::ProjectSnapshot::new(
            project.metadata().clone(),
            project.state_version(),
            Vec::new(),
            Vec::new(),
        )
        .unwrap();
        reopened
            .commit_project(
                &changed,
                &osg_domain::RevisionReason::new("change after alignment").unwrap(),
            )
            .unwrap();
        assert!(read_alignment_manifest(&reopened, job_id).is_err());
        let media_server = osg_media_server::MediaServer::start(std::iter::empty()).unwrap();
        let playback = register_speech_playback(
            &media_server,
            resolved.path(),
            SpeechArtifactFormatResponse::M4a,
        )
        .unwrap();
        assert_eq!(playback.mime_type, "audio/m4a");
        assert!(media_server.unregister(playback.id).unwrap());
    }
}
