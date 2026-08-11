use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use osg_domain::{AssetId, JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, InstalledSpeechRuntime, PackageError,
    SpeechPackageId, SpeechPackageManager, SpeechRuntimeCoordinator,
};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
    ContentHash, Database,
};
use osg_media::{
    AudioBitrate, AudioExtractionPlan, AudioOutput, AudioSampleRate,
    CancellationToken as MediaCancellationToken, ChannelCount, FfmpegProgress,
    MAX_NARRATION_MIX_INPUTS, MediaError, MediaInput, MediaOperation, MediaOutput, MediaTimeRange,
    NarrationAudioEditPlan as MediaAudioEditPlan, NarrationMixClip as MediaMixClip,
    NarrationMixPlan as MediaMixPlan, ProgressSink, RunControl as MediaRunControl,
};
use osg_media_server::RegisteredMedia;
use osg_speech::{
    AlignmentPlan, AlignmentPolicy, AudioAsset, AudioEditPlan as SpeechAudioEditPlan, AudioFilter,
    AudioFormat, CancellationToken, ChatterboxSettings, EdgeSettings, F5Settings, GeminiSettings,
    GttsDomain, GttsSettings, LanguageTag, LazySpeechWorker, ModelId, NarrationBatch,
    NarrationClip, NormalizedPoint, NormalizedTrim, ReferencePreparationPlan, RunControl,
    SecretValue, SegmentId, SpeechBackend, SpeechError, SpeechOutput, SpeechPhase, SpeechProgress,
    SpeechText, SpeedFactor, SynthesisRequest, SynthesisSettings, TimeMicros,
    VoiceConversionRequest, VoiceGender, VoiceId, WorkerProgram, WorkerStatus,
};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;
use zip::write::SimpleFileOptions;

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::media_export::copy_export;
use crate::state::DesktopState;

const WORKER_BYTES: &[u8] =
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
const ALIGNMENT_MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_F5_REFERENCE_MS: u64 = 12_000;
const MAX_CHATTERBOX_REFERENCE_MS: u64 = 60_000;
const MANIFEST_SCOPE: &str = "speechJobs";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const CHATTERBOX_LANGUAGES: &[&str] = &[
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no",
    "pl", "pt", "ru", "sv", "sw", "tr", "zh",
];

#[derive(Clone)]
pub(crate) struct SpeechRuntime(Arc<SpeechRuntimeInner>);

#[derive(Clone)]
pub(crate) struct SpeechPackageCoordinator(Weak<SpeechRuntimeInner>);

struct SpeechRuntimeInner {
    install_root: PathBuf,
    work_root: PathBuf,
    resource_root: Option<PathBuf>,
    package_manager: RwLock<Option<SpeechPackageManager>>,
    workers: Mutex<HashMap<SpeechBackendRequest, CachedWorker>>,
    transient_workers: Mutex<HashMap<SpeechBackendRequest, Vec<Weak<ManagedSpeechWorker>>>>,
    health: Mutex<HashMap<SpeechBackendRequest, bool>>,
}

#[derive(Clone, PartialEq, Eq)]
struct WorkerPaths {
    python: PathBuf,
    bootstrap: PathBuf,
    model: Option<PathBuf>,
}

struct CachedWorker {
    paths: WorkerPaths,
    worker: Arc<ManagedSpeechWorker>,
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
    pub(crate) fn new(
        install_root: impl AsRef<Path>,
        work_root: impl AsRef<Path>,
        resource_root: Option<PathBuf>,
    ) -> io::Result<Self> {
        fs::create_dir_all(install_root.as_ref())?;
        fs::create_dir_all(work_root.as_ref())?;
        let runtime = Self(Arc::new(SpeechRuntimeInner {
            install_root: fs::canonicalize(install_root)?,
            work_root: fs::canonicalize(work_root)?,
            resource_root: canonical_directory(resource_root),
            package_manager: RwLock::new(None),
            workers: Mutex::new(HashMap::new()),
            transient_workers: Mutex::new(HashMap::new()),
            health: Mutex::new(HashMap::new()),
        }));
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

    fn work_directory(&self) -> io::Result<TempDir> {
        tempfile::Builder::new()
            .prefix(".osg-speech-job-")
            .tempdir_in(&self.0.work_root)
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
            match package_manager
                .resolve_for_launch(backend.package(), &PackageCancellationToken::default())
            {
                Ok(runtime) => {
                    let bootstrap = self.resolve_worker()?;
                    let paths = WorkerPaths {
                        python: runtime.python().to_owned(),
                        bootstrap,
                        model: runtime.model().map(Path::to_owned),
                    };
                    WorkerProgram::managed_bootstrap(
                        &paths.python,
                        &paths.bootstrap,
                        paths.model.as_deref(),
                    )?;
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

    fn worker(
        &self,
        backend: SpeechBackendRequest,
    ) -> Result<Arc<ManagedSpeechWorker>, SpeechError> {
        let resolution = self.resolve_runtime(backend)?;
        let mut workers = self
            .0
            .workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        if let Some(cached) = workers.get(&backend)
            && cached.paths == resolution.paths
        {
            return Ok(Arc::clone(&cached.worker));
        }
        if let Some(previous) = workers.remove(&backend) {
            previous.worker.shutdown();
        }
        let paths = resolution.paths;
        let program = if resolution.managed_runtime.is_some() {
            WorkerProgram::managed_bootstrap(
                &paths.python,
                &paths.bootstrap,
                paths.model.as_deref(),
            )?
        } else {
            WorkerProgram::bootstrap(&paths.python, &paths.bootstrap)?
        };
        let worker = Arc::new(ManagedSpeechWorker {
            worker: LazySpeechWorker::new(program, backend.native()),
            managed_runtime: resolution.managed_runtime,
        });
        workers.insert(
            backend,
            CachedWorker {
                paths,
                worker: Arc::clone(&worker),
            },
        );
        Ok(worker)
    }

    fn provider_worker(
        &self,
        backend: SpeechBackendRequest,
        secret: SecretValue,
    ) -> Result<Arc<ManagedSpeechWorker>, SpeechError> {
        let resolution = self.resolve_runtime(backend)?;
        let paths = resolution.paths;
        let program = if resolution.managed_runtime.is_some() {
            WorkerProgram::managed_bootstrap(
                &paths.python,
                &paths.bootstrap,
                paths.model.as_deref(),
            )?
        } else {
            WorkerProgram::bootstrap(&paths.python, &paths.bootstrap)?
        };
        let worker = Arc::new(ManagedSpeechWorker {
            worker: LazySpeechWorker::new(program, backend.native()).with_provider_secret(secret),
            managed_runtime: resolution.managed_runtime,
        });
        let mut transient = self
            .0
            .transient_workers
            .lock()
            .map_err(|_| SpeechError::StateUnavailable)?;
        let entries = transient.entry(backend).or_default();
        entries.retain(|entry| entry.strong_count() != 0);
        entries.push(Arc::downgrade(&worker));
        Ok(worker)
    }

    fn mark_health(&self, backend: SpeechBackendRequest, healthy: bool) {
        if let Ok(mut health) = self.0.health.lock() {
            health.insert(backend, healthy);
        }
    }

    fn statuses(&self) -> Vec<SpeechBackendStatus> {
        let health = self.0.health.lock().ok();
        let workers = self.0.workers.lock().ok();
        SpeechBackendRequest::ALL
            .into_iter()
            .map(|backend| {
                let installed = self.resolve_runtime(backend).is_ok();
                let ready = installed
                    && health
                        .as_ref()
                        .and_then(|health| health.get(&backend).copied())
                        .unwrap_or(false);
                let warm = ready
                    && workers.as_ref().is_some_and(|workers| {
                        workers
                            .get(&backend)
                            .is_some_and(|cached| cached.worker.status() == WorkerStatus::Ready)
                    });
                SpeechBackendStatus {
                    backend,
                    installed,
                    ready,
                    warm,
                    requires_reference: backend.requires_reference(),
                    supports_voice_inventory: backend.supports_voice_inventory(),
                    supports_voice_conversion: backend == SpeechBackendRequest::Chatterbox,
                    requires_credential: backend == SpeechBackendRequest::GeminiTts,
                }
            })
            .collect()
    }

    fn shutdown(&self, backend: SpeechBackendRequest) -> CommandResult<()> {
        let cached = self
            .0
            .workers
            .lock()
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?
            .remove(&backend);
        if let Some(cached) = cached {
            cached.worker.shutdown();
        }
        let transient = self
            .0
            .transient_workers
            .lock()
            .map_err(|_| CommandError::internal("The native speech runtime is unavailable."))?
            .remove(&backend)
            .unwrap_or_default();
        for worker in transient.into_iter().filter_map(|worker| worker.upgrade()) {
            worker.shutdown();
        }
        self.mark_health(backend, false);
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
                    .is_some_and(|model| !matches!(model, "f5tts-v1-base" | "F5TTS_v1_Base"))
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
    segments: Vec<SpeechSegmentRequest>,
    profile: SpeechProfileRequest,
    reference_artifact_id: Option<String>,
}

impl fmt::Debug for SpeechStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechStartRequest")
            .field("segment_count", &self.segments.len())
            .field("profile", &self.profile)
            .field(
                "reference_artifact_id",
                &self.reference_artifact_id.as_ref().map(|_| "<opaque>"),
            )
            .finish()
    }
}

struct ValidatedSpeechStart {
    backend: SpeechBackendRequest,
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
            backend,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceSelectRequest {
    backend: SpeechReferenceBackend,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceImportRequest {
    backend: SpeechReferenceBackend,
    asset_id: AssetId,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactEditRequest {
    artifact_id: String,
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
    clips: Vec<SpeechAlignmentClipRequest>,
}

impl fmt::Debug for SpeechAlignmentStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechAlignmentStartRequest")
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
pub(crate) struct SpeechPlayableArtifact {
    artifact: SpeechArtifactDescriptor,
    playback: RegisteredMedia,
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechAlignmentFailureCode {
    Cancelled,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechAlignmentManifest {
    schema_version: u32,
    result: Option<SpeechAlignmentResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechAlignmentResultResponse {
    job: JobSnapshot,
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
    clips: Vec<AlignmentRenderClip>,
    stats: AlignmentResultStats,
}

fn validate_alignment_start(
    database: &Database,
    request: SpeechAlignmentStartRequest,
) -> CommandResult<ValidatedAlignmentStart> {
    if request.clips.is_empty() || request.clips.len() > MAX_SEGMENTS {
        return Err(CommandError::invalid_input(
            "Alignment requires between one and 1000 narration clips.",
        ));
    }

    let mut input_bytes = 0_u64;
    let mut native_clips = Vec::with_capacity(request.clips.len());
    let mut media_inputs = HashMap::with_capacity(request.clips.len());
    for request_clip in request.clips {
        let id = SegmentId::new(request_clip.id).map_err(|_| {
            CommandError::invalid_input("The alignment segment identifier is invalid.")
        })?;
        if request_clip.start_micros > MAX_ALIGNMENT_DURATION_MICROS
            || request_clip.cue_end_micros > MAX_ALIGNMENT_DURATION_MICROS
            || request_clip.cue_end_micros < request_clip.start_micros
        {
            return Err(CommandError::invalid_input(
                "The alignment timing is invalid or exceeds four hours.",
            ));
        }
        let (asset, media_input, descriptor) =
            resolve_alignment_audio(database, &request_clip.artifact_id)?;
        let measured_duration = descriptor.duration_micros.ok_or_else(|| {
            CommandError::invalid_input("The narration clip has no measured duration.")
        })?;
        if measured_duration == 0 || measured_duration > MAX_ALIGNMENT_DURATION_MICROS {
            return Err(CommandError::invalid_input(
                "The narration clip duration is invalid or exceeds four hours.",
            ));
        }
        input_bytes = input_bytes
            .checked_add(descriptor.bytes)
            .filter(|bytes| *bytes <= MAX_ALIGNMENT_INPUT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The alignment audio exceeds the safe input limit.")
            })?;
        let id_key = id.as_str().to_owned();
        if media_inputs.insert(id_key, media_input).is_some() {
            return Err(CommandError::invalid_input(
                "The alignment contains a duplicate segment identifier.",
            ));
        }
        native_clips.push(
            NarrationClip::new(
                id,
                asset,
                TimeMicros::new(request_clip.start_micros).map_err(|_| {
                    CommandError::invalid_input("The alignment start time is invalid.")
                })?,
                TimeMicros::new(request_clip.cue_end_micros).map_err(|_| {
                    CommandError::invalid_input("The alignment cue end is invalid.")
                })?,
                TimeMicros::new(measured_duration).map_err(|_| {
                    CommandError::invalid_input("The narration clip duration is invalid.")
                })?,
            )
            .map_err(|_| CommandError::invalid_input("The alignment clip is invalid."))?,
        );
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
    Ok(ValidatedAlignmentStart { clips, stats })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechFailureCode {
    Cancelled,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    results: Vec<StoredSpeechResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechJobResultsResponse {
    job: JobSnapshot,
    backend: SpeechBackendRequest,
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
    let probe_runtime = runtime.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let worker = probe_runtime.worker(backend)?;
        let control = RunControl::new(PROBE_TIMEOUT)?;
        worker.list_voices(&control)
    })
    .await
    .map_err(|_| CommandError::internal("The speech probe task stopped unexpectedly."))?;
    match result {
        Ok(inventory) => {
            runtime.mark_health(backend, true);
            let status = runtime
                .statuses()
                .into_iter()
                .find(|status| status.backend == backend)
                .ok_or_else(|| {
                    CommandError::internal("The speech backend status is unavailable.")
                })?;
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
                .collect();
            Ok(SpeechProbeResponse { status, voices })
        }
        Err(error) => {
            runtime.mark_health(backend, false);
            Err(speech_command_error(&error))
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_runtime_stop(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
) -> CommandResult<()> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.shutdown(backend))
        .await
        .map_err(|_| CommandError::internal("The speech shutdown task stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn speech_reference_select(
    app: AppHandle,
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechReferenceSelectRequest,
) -> CommandResult<Option<SpeechPlayableArtifact>> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app.dialog().file().blocking_pick_file() else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| {
            CommandError::invalid_path("The selected reference audio is unavailable.")
        })?;
        normalize_and_publish_reference(
            &media_engine,
            &work,
            &database,
            &path,
            request.backend,
            &media_server,
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
) -> CommandResult<SpeechPlayableArtifact> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let imported = blob_store
        .resolve(request.asset_id)?
        .ok_or_else(|| CommandError::invalid_input("The imported reference audio expired."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        normalize_and_publish_reference(
            &media_engine,
            &work,
            &database,
            imported.path(),
            request.backend,
            &media_server,
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
) -> CommandResult<SpeechPlayableArtifact> {
    let duration_ms = request
        .end_ms
        .checked_sub(request.start_ms)
        .filter(|duration| *duration > 0 && *duration <= request.backend.maximum_duration_ms())
        .ok_or_else(|| CommandError::invalid_input("The reference-audio range is invalid."))?;
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let media_path = state
        .editor
        .read()
        .map_err(|_| CommandError::internal("The editing session is unavailable."))?
        .local_media
        .clone()
        .ok_or_else(|| CommandError::invalid_input("Select media before extracting a reference."))?
        .path()
        .to_owned();
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
        let published = publish_durable_artifact(
            &database,
            None,
            "speechReference",
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
        let playback = register_speech_playback(
            &media_server,
            &published.path,
            SpeechArtifactFormatResponse::Wav,
        )?;
        Ok(SpeechPlayableArtifact {
            artifact: published.descriptor,
            playback,
        })
    })
    .await
    .map_err(|_| CommandError::internal("The reference extraction task stopped unexpectedly."))?
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
) -> CommandResult<SpeechArtifactDescriptor> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (audio, media, descriptor) = resolve_alignment_audio(&database, &request.artifact_id)?;
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
        let output_path = work.path().join("edited.wav");
        let output = MediaOutput::within_root(&output_path, work.path())?;
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
        let duration_micros = metadata.duration_us().ok_or_else(|| {
            CommandError::internal("The edited narration duration is unavailable.")
        })?;
        let published = publish_durable_artifact(
            &database,
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
        Ok(published.descriptor)
    })
    .await
    .map_err(|_| CommandError::internal("The narration edit task stopped unexpectedly."))?
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
    let reference_id = request.reference_artifact_id.clone();
    let reference_database = state.database.clone();
    let reference = tauri::async_runtime::spawn_blocking(move || match reference_id.as_deref() {
        Some(id) => resolve_audio_artifact(&reference_database, id, true).map(Some),
        None => Ok(None),
    })
    .await
    .map_err(|_| CommandError::internal("The reference lookup task stopped unexpectedly."))??;
    let validated = request
        .validate(reference)
        .map_err(|error| speech_command_error(&error))?;
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::SynthesizeNarration).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    if let Err(error) = initialize_manifest(&state.database, job_id, validated.backend).await {
        let _ = background::finish_failure(&jobs, job_id).await;
        return Err(error);
    }
    let runtime = runtime.inner().clone();
    let database = state.database.clone();
    let credentials = state.credentials.clone();
    let cancellation = ticket.cancellation().clone();

    tauri::async_runtime::spawn(async move {
        let speech_cancellation = CancellationToken::default();
        let cancellation_bridge = speech_cancellation.clone();
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
            channel: &on_event,
        };
        let mut outcome = run_speech_batch(&context, validated, speech_cancellation).await;
        watcher.abort();
        if cancellation.is_cancelled() {
            outcome = Err(SpeechFailureCode::Cancelled);
        }
        finish_speech_job(&jobs, &database, job_id, outcome, &on_event).await;
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
    let artifact_database = state.database.clone();
    let (input, target) = tauri::async_runtime::spawn_blocking(move || {
        let input = resolve_audio_artifact(&artifact_database, &request.input_artifact_id, false)?;
        let target =
            resolve_audio_artifact(&artifact_database, &request.target_voice_artifact_id, true)?;
        Ok::<_, CommandError>((input, target))
    })
    .await
    .map_err(|_| CommandError::internal("The speech audio lookup task stopped unexpectedly."))??;
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::SynthesizeNarration).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    if let Err(error) =
        initialize_manifest(&state.database, job_id, SpeechBackendRequest::Chatterbox).await
    {
        let _ = background::finish_failure(&jobs, job_id).await;
        return Err(error);
    }
    let runtime = runtime.inner().clone();
    let database = state.database.clone();
    let cancellation = ticket.cancellation().clone();

    tauri::async_runtime::spawn(async move {
        let speech_cancellation = CancellationToken::default();
        let cancellation_bridge = speech_cancellation.clone();
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
            speech_cancellation,
            job_id,
            &on_event,
        )
        .await;
        watcher.abort();
        if cancellation.is_cancelled() {
            result = Err(SpeechFailureCode::Cancelled);
        }
        finish_speech_job(&jobs, &database, job_id, result, &on_event).await;
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
    if let Err(error) = initialize_alignment_manifest(&state.database, job_id).await {
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
        finish_alignment_job(&jobs, job_id, outcome, &on_event).await;
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

    let selected = app
        .dialog()
        .file()
        .set_title("Export narration audio")
        .set_file_name(plan.selected_file_name())
        .add_filter("Narration audio", &[plan.selected_extension()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| CommandError::media_export_unsafe())?;

    tauri::async_runtime::spawn_blocking(move || export_speech_plan(&plan, &destination))
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

fn export_speech_plan(plan: &SpeechExportPlan, destination: &Path) -> CommandResult<()> {
    if plan.archive_name.is_none() {
        let source = plan
            .sources
            .first()
            .ok_or_else(CommandError::speech_export_failed)?;
        let mut staging = speech_export_staging(source)?;
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        write_verified_speech_source(source, staging.as_file_mut(), &mut buffer)?;
        staging
            .as_file()
            .sync_all()
            .map_err(|_| CommandError::speech_export_failed())?;
        return copy_export(
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
    let mut staging = speech_export_staging(source)?;
    write_speech_archive(plan, &mut staging)?;
    let archive_bytes = staging
        .as_file()
        .metadata()
        .map_err(|_| CommandError::speech_export_failed())?
        .len();
    if archive_bytes == 0 || archive_bytes > MAX_EXPORT_ARCHIVE_BYTES {
        return Err(CommandError::speech_export_failed());
    }
    copy_export(
        staging.path(),
        destination,
        archive_bytes,
        || false,
        |_, _| Ok(()),
    )
    .map_err(|_| CommandError::speech_export_failed())
}

fn speech_export_staging(source: &SpeechExportSource) -> CommandResult<NamedTempFile> {
    let directory = source
        .path
        .parent()
        .ok_or_else(CommandError::speech_export_failed)?;
    tempfile::Builder::new()
        .prefix(".osg-speech-export-")
        .suffix(".part")
        .tempfile_in(directory)
        .map_err(|_| CommandError::speech_export_failed())
}

fn write_speech_archive(plan: &SpeechExportPlan, staging: &mut NamedTempFile) -> CommandResult<()> {
    let mut archive = zip::ZipWriter::new(staging.as_file_mut());
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

type NativeCredentialService = osg_infrastructure::secrets::CredentialService<
    osg_infrastructure::secrets::KeyringCredentialBackend,
>;

struct SpeechBatchContext<'a> {
    runtime: &'a SpeechRuntime,
    database: &'a Database,
    credentials: &'a NativeCredentialService,
    jobs: &'a background::DesktopJobs,
    job_id: JobId,
    channel: &'a Channel<SpeechJobEvent>,
}

async fn run_speech_batch(
    context: &SpeechBatchContext<'_>,
    mut validated: ValidatedSpeechStart,
    cancellation: CancellationToken,
) -> Result<Vec<StoredSpeechResult>, SpeechFailureCode> {
    let work = context
        .runtime
        .work_directory()
        .map_err(|_| SpeechFailureCode::RuntimeUnavailable)?;
    let worker =
        match resolve_batch_worker(context, validated.backend, validated.credential_id).await {
            Ok(worker) => worker,
            Err(code) => {
                context.runtime.mark_health(validated.backend, false);
                return Err(code);
            }
        };
    if validated.backend == SpeechBackendRequest::F5Tts {
        validated.requests = match prepare_f5_requests(
            &worker,
            &work,
            validated.requests,
            validated
                .reference
                .take()
                .ok_or(SpeechFailureCode::ReferenceRejected)?,
            cancellation.clone(),
        )
        .await
        {
            Ok(requests) => requests,
            Err(code) => {
                if failure_marks_backend_unhealthy(code) {
                    context.runtime.mark_health(validated.backend, false);
                }
                return Err(code);
            }
        };
    }

    let total = validated.requests.len();
    let mut results = Vec::with_capacity(total);
    for (offset, request) in validated.requests.into_iter().enumerate() {
        if cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        let index = offset + 1;
        let stored = synthesize_segment(
            context,
            &work,
            &worker,
            request,
            cancellation.clone(),
            SegmentRun {
                backend: validated.backend,
                index,
                total,
            },
        )
        .await?;
        append_manifest_async(
            context.database,
            context.job_id,
            validated.backend,
            stored.clone(),
        )
        .await?;
        emit_segment_result(context, &stored, index, total);
        let terminal_failure = match &stored {
            StoredSpeechResult::Failed { code, .. } if batch_terminal_failure(*code) => Some(*code),
            _ => None,
        };
        results.push(stored);
        report_batch_progress(context.jobs, context.job_id, index, total).await;
        if let Some(code) = terminal_failure {
            return Err(code);
        }
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
    index: usize,
    total: usize,
}

async fn resolve_batch_worker(
    context: &SpeechBatchContext<'_>,
    backend: SpeechBackendRequest,
    credential_id: Option<CredentialId>,
) -> Result<Arc<ManagedSpeechWorker>, SpeechFailureCode> {
    let Some(credential_id) = credential_id else {
        let runtime = context.runtime.clone();
        return tauri::async_runtime::spawn_blocking(move || runtime.worker(backend))
            .await
            .map_err(|_| SpeechFailureCode::WorkerFailed)?
            .map_err(|error| speech_failure(&error).0);
    };
    let credentials = context.credentials.clone();
    let secret = tauri::async_runtime::spawn_blocking(move || {
        credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map_err(|_| SpeechFailureCode::AuthenticationFailed)?
    .map_err(|_| SpeechFailureCode::AuthenticationFailed)?;
    let secret = SecretValue::new(secret.expose_secret().to_owned())
        .map_err(|_| SpeechFailureCode::AuthenticationFailed)?;
    let runtime = context.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.provider_worker(backend, secret))
        .await
        .map_err(|_| SpeechFailureCode::WorkerFailed)?
        .map_err(|error| speech_failure(&error).0)
}

async fn prepare_f5_requests(
    worker: &Arc<ManagedSpeechWorker>,
    work: &TempDir,
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
    work: &TempDir,
    worker: &Arc<ManagedSpeechWorker>,
    request: SynthesisRequest,
    cancellation: CancellationToken,
    run: SegmentRun,
) -> Result<StoredSpeechResult, SpeechFailureCode> {
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
    let operation = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(SPEECH_TIMEOUT)?
            .with_cancellation(cancellation)
            .with_progress(move |progress: &SpeechProgress| {
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
            });
        synthesize_with_retry(&progress_worker, &request, &output, &control)
    })
    .await
    .map_err(|_| SpeechFailureCode::WorkerFailed)?;
    match operation {
        Ok(artifact) => {
            context.runtime.mark_health(run.backend, true);
            let database = context.database.clone();
            let published = tauri::async_runtime::spawn_blocking(move || {
                let metadata = SpeechArtifactMetadata::from_summary(artifact.summary());
                publish_durable_artifact(
                    &database,
                    Some(job_id),
                    "narrationOutput",
                    artifact.native_path(),
                    metadata,
                )
            })
            .await
            .map_err(|_| SpeechFailureCode::ArtifactStorage)?
            .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
            Ok(StoredSpeechResult::Completed {
                segment_id,
                artifact: published.descriptor,
            })
        }
        Err(SpeechError::Cancelled) => Err(SpeechFailureCode::Cancelled),
        Err(error) => {
            let (code, retryable) = speech_failure(&error);
            if failure_marks_backend_unhealthy(code) {
                context.runtime.mark_health(run.backend, false);
            }
            Ok(StoredSpeechResult::Failed {
                segment_id,
                code,
                retryable,
            })
        }
    }
}

async fn append_manifest_async(
    database: &Database,
    job_id: JobId,
    backend: SpeechBackendRequest,
    result: StoredSpeechResult,
) -> Result<(), SpeechFailureCode> {
    let database = database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        append_manifest(&database, job_id, backend, result)
    })
    .await
    .map_err(|_| SpeechFailureCode::ArtifactStorage)?
    .map_err(|_| SpeechFailureCode::ArtifactStorage)
}

fn emit_segment_result(
    context: &SpeechBatchContext<'_>,
    result: &StoredSpeechResult,
    index: usize,
    total: usize,
) {
    let event = match result {
        StoredSpeechResult::Completed { .. } => SpeechJobEvent::SegmentCompleted {
            job_id: context.job_id,
            index,
            total,
            result: result.clone(),
        },
        StoredSpeechResult::Failed { .. } => SpeechJobEvent::SegmentFailed {
            job_id: context.job_id,
            index,
            total,
            result: result.clone(),
        },
    };
    let _ = context.channel.send(event);
}

async fn report_batch_progress(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    completed: usize,
    total: usize,
) {
    if let Ok(progress) = JobProgress::from_units(
        u64::try_from(completed).unwrap_or(u64::MAX),
        u64::try_from(total).unwrap_or(u64::MAX),
    ) {
        let _ = background::apply(jobs, job_id, JobUpdate::ReportProgress(progress)).await;
    }
}

async fn run_voice_conversion(
    runtime: &SpeechRuntime,
    database: &Database,
    input: AudioAsset,
    target: AudioAsset,
    cancellation: CancellationToken,
    job_id: JobId,
    channel: &Channel<SpeechJobEvent>,
) -> Result<Vec<StoredSpeechResult>, SpeechFailureCode> {
    let work = runtime
        .work_directory()
        .map_err(|_| SpeechFailureCode::RuntimeUnavailable)?;
    let worker_runtime = runtime.clone();
    let worker = match tauri::async_runtime::spawn_blocking(move || {
        worker_runtime.worker(SpeechBackendRequest::Chatterbox)
    })
    .await
    {
        Ok(Ok(worker)) => worker,
        Ok(Err(error)) => {
            runtime.mark_health(SpeechBackendRequest::Chatterbox, false);
            return Err(speech_failure(&error).0);
        }
        Err(_) => {
            runtime.mark_health(SpeechBackendRequest::Chatterbox, false);
            return Err(SpeechFailureCode::WorkerFailed);
        }
    };
    let request = VoiceConversionRequest::new(input, target);
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        "voice-conversion",
        AudioFormat::Wav,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let progress_channel = channel.clone();
    let operation = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(SPEECH_TIMEOUT)?
            .with_cancellation(cancellation)
            .with_progress(move |progress: &SpeechProgress| {
                let _ = progress_channel.send(SpeechJobEvent::Progress {
                    job_id,
                    segment_id: None,
                    index: 1,
                    total: 1,
                    phase: progress.phase().into(),
                    fraction_millionths: progress.fraction_millionths(),
                });
            });
        worker.convert_voice(&request, &output, &control)
    })
    .await
    .map_err(|_| SpeechFailureCode::WorkerFailed)?;
    let artifact = match operation {
        Ok(artifact) => {
            runtime.mark_health(SpeechBackendRequest::Chatterbox, true);
            artifact
        }
        Err(error) => {
            let (code, _) = speech_failure(&error);
            if failure_marks_backend_unhealthy(code) {
                runtime.mark_health(SpeechBackendRequest::Chatterbox, false);
            }
            return Err(code);
        }
    };
    let artifact_database = database.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let published = publish_durable_artifact(
            &artifact_database,
            Some(job_id),
            "voiceConversion",
            artifact.native_path(),
            SpeechArtifactMetadata::from_summary(artifact.summary()),
        )?;
        let result = StoredSpeechResult::Completed {
            segment_id: "voice-conversion".to_owned(),
            artifact: published.descriptor,
        };
        append_manifest(
            &artifact_database,
            job_id,
            SpeechBackendRequest::Chatterbox,
            result.clone(),
        )?;
        Ok::<_, CommandError>(result)
    })
    .await
    .map_err(|_| SpeechFailureCode::ArtifactStorage)?
    .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    let _ = channel.send(SpeechJobEvent::SegmentCompleted {
        job_id,
        index: 1,
        total: 1,
        result: result.clone(),
    });
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
        job_id,
        channel,
    )?;

    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    report_alignment_progress(
        jobs,
        job_id,
        SpeechAlignmentPhase::Publishing,
        950_000,
        channel,
    );
    let published = publish_durable_artifact(
        database,
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
        artifact: published.descriptor,
        clip_count: validated.stats.clip_count,
        adjusted_count: validated.stats.adjusted_count,
        requested_duration_micros: validated.stats.requested_duration_micros,
        natural_duration_micros: validated.stats.natural_duration_micros,
        rendered_duration_micros: validated.stats.rendered_duration_micros,
        maximum_shift_micros: validated.stats.maximum_shift_micros,
    };
    store_alignment_result(database, job_id, result.clone())
        .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
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
    job_id: JobId,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<Vec<AlignmentRenderClip>, SpeechAlignmentFailureCode> {
    let mut leaf_inputs = Vec::with_capacity(clips.len().div_ceil(MAX_NARRATION_MIX_INPUTS));
    for (leaf_index, clips) in clips.chunks(MAX_NARRATION_MIX_INPUTS).enumerate() {
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
    job_id: JobId,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<(), SpeechAlignmentFailureCode> {
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
    let progress = ProgressSink::new(move |progress: FfmpegProgress| {
        let fraction = progress
            .fraction
            .filter(|fraction| fraction.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        report_alignment_mix_fraction(
            &progress_jobs,
            job_id,
            completed_steps,
            total_steps,
            fraction,
            &progress_channel,
        );
    });
    let control = MediaRunControl::new(remaining)
        .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?
        .with_cancellation(cancellation)
        .with_progress(progress);
    engine
        .execute(&operation, &control)
        .map(|_| ())
        .map_err(|error| alignment_media_failure(&error))
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

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the finite alignment fraction is clamped to 0..=1 before conversion"
)]
fn report_alignment_mix_fraction(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    completed_steps: usize,
    total_steps: usize,
    local_fraction: f64,
    channel: &Channel<SpeechAlignmentEvent>,
) {
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
    job_id: JobId,
    outcome: Result<SpeechAlignmentResult, SpeechAlignmentFailureCode>,
    channel: &Channel<SpeechAlignmentEvent>,
) {
    match outcome {
        Ok(result) => {
            if let Ok(job) = background::apply(jobs, job_id, JobUpdate::Succeed).await {
                let _ = channel.send(SpeechAlignmentEvent::Completed { job, result });
            } else {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(SpeechAlignmentEvent::Failed {
                    job,
                    code: SpeechAlignmentFailureCode::ArtifactStorage,
                });
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
        SpeechFailureCode::InvalidRequest
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

async fn finish_speech_job(
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
            if let Ok(job) = background::apply(jobs, job_id, JobUpdate::Succeed).await {
                let _ = channel.send(SpeechJobEvent::Completed { job, results });
            } else {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(SpeechJobEvent::Failed {
                    job,
                    results: stored,
                    code: SpeechFailureCode::ArtifactStorage,
                });
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

async fn initialize_manifest(
    database: &Database,
    job_id: JobId,
    backend: SpeechBackendRequest,
) -> CommandResult<()> {
    let database = database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = SpeechJobManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            backend,
            results: Vec::new(),
        };
        let value = serde_json::to_value(manifest)
            .map_err(|_| CommandError::internal("The speech manifest is invalid."))?;
        database.put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)?;
        Ok(())
    })
    .await
    .map_err(|_| CommandError::internal("The speech manifest task stopped unexpectedly."))?
}

async fn initialize_alignment_manifest(database: &Database, job_id: JobId) -> CommandResult<()> {
    let database = database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = SpeechAlignmentManifest {
            schema_version: ALIGNMENT_MANIFEST_SCHEMA_VERSION,
            result: None,
        };
        let value = serde_json::to_value(manifest)
            .map_err(|_| CommandError::internal("The alignment manifest is invalid."))?;
        database.put_setting(ALIGNMENT_MANIFEST_SCOPE, &job_id.to_string(), &value)?;
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
    if manifest.schema_version != ALIGNMENT_MANIFEST_SCHEMA_VERSION {
        return Err(invalid_alignment_manifest_error());
    }
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
        if resolved.record().kind().as_str() != "alignedNarration" {
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
    result: SpeechAlignmentResult,
) -> CommandResult<()> {
    let mut manifest = read_alignment_manifest(database, job_id)?;
    if manifest.result.is_some() {
        return Err(CommandError::internal(
            "The alignment result was already committed.",
        ));
    }
    manifest.result = Some(result);
    let value = serde_json::to_value(manifest)
        .map_err(|_| CommandError::internal("The alignment manifest is invalid."))?;
    database.put_setting(ALIGNMENT_MANIFEST_SCOPE, &job_id.to_string(), &value)?;
    Ok(())
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
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION || manifest.results.len() > MAX_SEGMENTS {
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
                ) {
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
    result: StoredSpeechResult,
) -> CommandResult<()> {
    let mut manifest = read_manifest(database, job_id)?;
    if manifest.backend != backend || manifest.results.len() >= MAX_SEGMENTS {
        return Err(CommandError::internal(
            "The stored speech job results are inconsistent.",
        ));
    }
    manifest.results.push(result);
    let value = serde_json::to_value(manifest)
        .map_err(|_| CommandError::internal("The speech manifest is invalid."))?;
    database.put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)?;
    Ok(())
}

fn normalize_and_publish_reference(
    media_engine: &osg_media::MediaEngine,
    work: &TempDir,
    database: &Database,
    source_path: &Path,
    backend: SpeechReferenceBackend,
    media_server: &osg_media_server::MediaServer,
    source_label: &'static str,
) -> CommandResult<SpeechPlayableArtifact> {
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
        .tempfile_in(work.path())
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
    let metadata = media_engine.probe(&source, &control)?;
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

    let output_path = work.path().join("reference.wav");
    let output = MediaOutput::within_root(&output_path, work.path())?;
    let plan = AudioExtractionPlan::new(
        source,
        output,
        AudioOutput::WavPcm16 {
            sample_rate: AudioSampleRate::new(44_100)?,
            channels: ChannelCount::new(2)?,
        },
        MediaTimeRange::new(0, Some(duration_micros))?,
    )?;
    media_engine.execute(&MediaOperation::AudioExtraction(plan), &control)?;
    let normalized =
        AudioAsset::from_native_file(&output_path).map_err(|error| speech_command_error(&error))?;
    let published = publish_durable_artifact(
        database,
        None,
        "speechReference",
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
    let playback = register_speech_playback(
        media_server,
        &published.path,
        SpeechArtifactFormatResponse::Wav,
    )?;
    Ok(SpeechPlayableArtifact {
        artifact: published.descriptor,
        playback,
    })
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
    descriptor: SpeechArtifactDescriptor,
    path: PathBuf,
}

impl fmt::Debug for PublishedSpeechArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedSpeechArtifact")
            .field("descriptor", &self.descriptor)
            .field("path", &"<redacted>")
            .finish()
    }
}

fn publish_durable_artifact(
    database: &Database,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    let source_metadata =
        fs::symlink_metadata(source_path).map_err(|_| artifact_storage_error())?;
    let size_bytes = source_metadata.len();
    let maximum_bytes = match kind {
        "speechReference" | "speechPreparedReference" => MAX_REFERENCE_BYTES,
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
    let draft = match job_id {
        Some(job_id) => draft.with_job(job_id),
        None => draft,
    };
    let id = match database.register_artifact(&draft)? {
        ArtifactRegistration::Existing(record) => record.id(),
        ArtifactRegistration::Staging(staging) => {
            let id = staging.record().id();
            let publication = (|| -> io::Result<()> {
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(staging.path())?;
                let copied = io::copy(&mut source, &mut target)?;
                if copied != size_bytes {
                    return Err(io::Error::other("speech artifact size changed"));
                }
                target.flush()?;
                target.sync_all()
            })();
            if publication.is_err() || database.mark_artifact_ready(id).is_err() {
                fail_artifact_publication(database, id);
                return Err(artifact_storage_error());
            }
            id
        }
    };
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(artifact_storage_error)?;
    let descriptor = descriptor_from_record(resolved.record())?;
    Ok(PublishedSpeechArtifact {
        descriptor,
        path: resolved.path().to_owned(),
    })
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
) -> CommandResult<(AudioAsset, MediaInput, SpeechArtifactDescriptor)> {
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
    Ok((asset, media, descriptor))
}

fn ensure_speech_artifact_kind(kind: &str, reference_only: bool) -> CommandResult<()> {
    let allowed = if reference_only {
        matches!(kind, "speechReference" | "speechPreparedReference")
    } else {
        matches!(
            kind,
            "speechReference"
                | "speechPreparedReference"
                | "narrationOutput"
                | "voiceConversion"
                | "alignedNarration"
        )
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
    let message = match code {
        SpeechFailureCode::Cancelled => "The speech operation was cancelled.",
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
    fn request_debug_redacts_text_and_reference_capability() {
        let request = SpeechStartRequest {
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
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("private narration"));
        assert!(!debug.contains(request.reference_artifact_id.as_deref().unwrap()));
    }

    #[test]
    fn alignment_request_debug_redacts_artifact_capabilities() {
        let artifact_id = ArtifactId::new().to_string();
        let request = SpeechAlignmentStartRequest {
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
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let first_path = directory.path().join("first.wav");
        let second_path = directory.path().join("second.wav");
        fs::write(&first_path, b"first narration bytes").unwrap();
        fs::write(&second_path, b"second narration bytes").unwrap();
        let first = publish_durable_artifact(
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
        export_speech_plan(&plan, &destination).unwrap();

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
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let source_path = directory.path().join("source.wav");
        fs::write(&source_path, b"single narration bytes").unwrap();
        let artifact = publish_durable_artifact(
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

        export_speech_plan(&plan, &destination).unwrap();

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
        assert!(export_speech_plan(&plan, &destination).is_err());
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
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let first_path = directory.path().join("first.wav");
        let second_path = directory.path().join("second.wav");
        std::fs::write(&first_path, b"RIFF-first-WAVEdata").unwrap();
        std::fs::write(&second_path, b"RIFF-second-WAVEdata").unwrap();
        let first = publish_durable_artifact(
            &database,
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
        let second = publish_durable_artifact(
            &database,
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
        std::fs::remove_file(first_path).unwrap();
        std::fs::remove_file(second_path).unwrap();

        let validated = validate_alignment_start(
            &database,
            SpeechAlignmentStartRequest {
                clips: vec![
                    SpeechAlignmentClipRequest {
                        id: "first".to_owned(),
                        artifact_id: first.descriptor.artifact_id,
                        start_micros: 0,
                        cue_end_micros: 1_000_000,
                    },
                    SpeechAlignmentClipRequest {
                        id: "second".to_owned(),
                        artifact_id: second.descriptor.artifact_id,
                        start_micros: 1_000_000,
                        cue_end_micros: 2_000_000,
                    },
                ],
            },
        )
        .unwrap();
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
    fn worker_path_debug_is_redacted() {
        let paths = WorkerPaths {
            python: PathBuf::from("C:/private/python.exe"),
            bootstrap: PathBuf::from("C:/private/osg_speech_worker.py"),
            model: Some(PathBuf::from("C:/private/models")),
        };
        let debug = format!("{paths:?}");
        assert!(!debug.contains("private"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn reference_publication_rechecks_the_size_bound_before_hashing() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let source = directory.path().join("oversized.wav");
        std::fs::File::create(&source)
            .unwrap()
            .set_len(MAX_REFERENCE_BYTES + 1)
            .unwrap();

        let result = publish_durable_artifact(
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
        let database_directory = directory.path().join("database");
        std::fs::create_dir_all(&database_directory).unwrap();
        let database_path = database_directory.join("osg.sqlite3");
        let source = directory.path().join("aligned.m4a");
        std::fs::write(&source, b"aligned-m4a-fixture").unwrap();
        let database = Database::open(&database_path).unwrap();
        let job_id = JobId::new();
        let published = publish_durable_artifact(
            &database,
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
            .put_setting(
                ALIGNMENT_MANIFEST_SCOPE,
                &job_id.to_string(),
                &serde_json::to_value(SpeechAlignmentManifest {
                    schema_version: ALIGNMENT_MANIFEST_SCHEMA_VERSION,
                    result: None,
                })
                .unwrap(),
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
        store_alignment_result(&database, job_id, expected.clone()).unwrap();
        std::fs::remove_file(source).unwrap();
        drop(database);

        let reopened = Database::open(&database_path).unwrap();
        let restored = read_alignment_manifest(&reopened, job_id).unwrap();
        assert_eq!(restored.result, Some(expected.clone()));
        let artifact_id = parse_artifact_id(&expected.artifact.artifact_id).unwrap();
        let resolved = reopened.resolve_artifact(artifact_id).unwrap().unwrap();
        assert!(resolved.path().extension().is_none());
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
