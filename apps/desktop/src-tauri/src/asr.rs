use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use osg_asr::{
    AsrEngineId, AsrEngineInfo, AsrError, AsrService, CancellationToken as AsrCancellationToken,
    LanguageCode, ModelAssets, ProgressPhase, RunControl as AsrRunControl, SegmentStrategy,
    SegmentationOptions, Transcription, TranscriptionOptions, TranscriptionRequest, WorkerProgram,
    catalog,
};
use osg_domain::{JobId, JobKind, JobSnapshot, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, EngineId as PackageEngineId,
    EnginePackageManager, InstalledRuntime, PackageError, RuntimeCoordinator,
};
use osg_media::{
    AudioExtractionPlan, CancellationToken as MediaCancellationToken, MediaEngine, MediaInput,
    MediaOperation, MediaOutput, MediaTimeRange, ProgressSink as MediaProgressSink,
    RunControl as MediaRunControl,
};
use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const WORKER_BYTES: &[u8] = include_bytes!("../../../../crates/osg-asr/worker/osg_asr_worker.py");
const MAX_TRANSCRIPTION_RANGE_MS: u64 = 24 * 60 * 60 * 1_000;
const RANGE_DURATION_TOLERANCE_US: u64 = 250_000;
const MEDIA_TIMEOUT: Duration = Duration::from_hours(24);
const ASR_TIMEOUT: Duration = Duration::from_hours(24);

#[derive(Clone)]
pub(crate) struct AsrRuntimeManager(Arc<RuntimeManagerInner>);

#[derive(Clone)]
pub(crate) struct AsrPackageCoordinator(Weak<RuntimeManagerInner>);

struct RuntimeManagerInner {
    install_root: PathBuf,
    work_root: PathBuf,
    resource_root: Option<PathBuf>,
    development_root: Option<PathBuf>,
    package_manager: RwLock<Option<EnginePackageManager>>,
    services: Mutex<HashMap<AsrEngineId, CachedService>>,
}

#[derive(Clone, PartialEq, Eq)]
struct RuntimePaths {
    python: PathBuf,
    worker: PathBuf,
    model: PathBuf,
    aligner: Option<PathBuf>,
}

struct CachedService {
    paths: RuntimePaths,
    service: AsrService,
    managed_runtime: Option<Arc<InstalledRuntime>>,
}

#[derive(Clone)]
struct ManagedAsrService {
    service: AsrService,
    _managed_runtime: Option<Arc<InstalledRuntime>>,
}

struct RuntimeResolution {
    paths: RuntimePaths,
    managed_runtime: Option<Arc<InstalledRuntime>>,
}

impl AsrRuntimeManager {
    pub(crate) fn new(
        install_root: impl AsRef<Path>,
        work_root: impl AsRef<Path>,
        resource_root: Option<PathBuf>,
        development_root: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(install_root.as_ref())?;
        std::fs::create_dir_all(work_root.as_ref())?;
        let install_root = std::fs::canonicalize(install_root)?;
        let work_root = std::fs::canonicalize(work_root)?;
        let resource_root = canonical_directory(resource_root);
        let development_root = canonical_directory(development_root);
        Ok(Self(Arc::new(RuntimeManagerInner {
            install_root,
            work_root,
            resource_root,
            development_root,
            package_manager: RwLock::new(None),
            services: Mutex::new(HashMap::new()),
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

    fn service(&self, engine: AsrEngineId) -> Result<ManagedAsrService, AsrError> {
        let resolution = self.resolve_runtime(engine)?;
        let mut services = self
            .0
            .services
            .lock()
            .map_err(|_| AsrError::Synchronization)?;
        if let Some(cached) = services.get(&engine)
            && cached.paths == resolution.paths
        {
            return Ok(ManagedAsrService {
                service: cached.service.clone(),
                _managed_runtime: cached.managed_runtime.clone(),
            });
        }
        services.remove(&engine);
        let paths = resolution.paths;
        let program = WorkerProgram::python(&paths.python, &paths.worker)?;
        let assets = ModelAssets::new(engine, &paths.model, paths.aligner.as_deref())?;
        let service = AsrService::new(program, assets);
        let managed_runtime = resolution.managed_runtime;
        services.insert(
            engine,
            CachedService {
                paths,
                service: service.clone(),
                managed_runtime: managed_runtime.clone(),
            },
        );
        Ok(ManagedAsrService {
            service,
            _managed_runtime: managed_runtime,
        })
    }

    pub(crate) fn start(&self, engine: AsrEngineId) -> Result<(), AsrError> {
        self.service(engine).map(drop)
    }

    pub(crate) fn stop(&self, engine: AsrEngineId) -> Result<(), AsrError> {
        let removed = self
            .0
            .services
            .lock()
            .map_err(|_| AsrError::Synchronization)?
            .remove(&engine);
        drop(removed);
        Ok(())
    }

    pub(crate) fn quiesce_package(&self, engine: PackageEngineId) -> Result<(), PackageError> {
        self.stop(package_to_asr(engine))
            .map_err(|_| PackageError::StoreUnavailable)
    }

    fn status(&self) -> AsrStatus {
        let services = self.0.services.lock().ok();
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
                    services.as_ref().is_some_and(|services| {
                        services.get(&info.id).is_some_and(|cached| {
                            cached.paths == *paths && cached.service.is_warm()
                        })
                    })
                });
                AsrEngineStatus {
                    info,
                    installed: paths.is_some(),
                    ready: paths.is_some(),
                    warm,
                }
            })
            .collect();
        AsrStatus {
            worker_available,
            engines,
        }
    }

    fn work_directory(&self) -> std::io::Result<tempfile::TempDir> {
        tempfile::Builder::new()
            .prefix(".osg-asr-job-")
            .tempdir_in(&self.0.work_root)
    }

    fn resolve_runtime(&self, engine: AsrEngineId) -> Result<RuntimeResolution, AsrError> {
        let package_manager = self
            .0
            .package_manager
            .read()
            .map_err(|_| AsrError::Synchronization)?
            .clone();
        if let Some(package_manager) = package_manager {
            match package_manager
                .resolve_for_launch(asr_to_package(engine), &PackageCancellationToken::default())
            {
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
                Err(PackageError::InvalidInstall | PackageError::DeliveryUnavailable) => {}
                Err(_) => return Err(AsrError::InvalidRuntime),
            }
        }
        Ok(RuntimeResolution {
            paths: self.resolve_legacy_paths(engine)?,
            managed_runtime: None,
        })
    }

    fn resolve_legacy_paths(&self, engine: AsrEngineId) -> Result<RuntimePaths, AsrError> {
        let worker = self.resolve_worker()?;
        let engine_name = engine.as_str();
        let managed_engine = self.0.install_root.join(engine_name);
        let mut runtime_roots = vec![managed_engine.join("venv"), managed_engine.join("runtime")];
        let mut model_roots = vec![managed_engine.join("model"), managed_engine.join("models")];

        if let Some(root) = &self.0.development_root {
            runtime_roots.push(root.join(".venvs").join(engine_name));
            model_roots.push(root.join("models/asr").join(engine_name));
        }

        let python = runtime_roots
            .iter()
            .find_map(|root| resolve_python(root))
            .ok_or(AsrError::InvalidRuntime)?;
        let model = model_roots
            .iter()
            .find_map(|root| resolve_populated_directory(root))
            .ok_or(AsrError::InvalidRuntime)?;
        let aligner = if engine.needs_aligner() {
            let mut candidates = vec![
                self.0.install_root.join("qwen3-forced-aligner/model"),
                self.0.install_root.join("qwen3-forced-aligner"),
            ];
            if let Some(root) = &self.0.development_root {
                candidates.push(root.join("models/asr/qwen3-forced-aligner"));
            }
            Some(
                candidates
                    .iter()
                    .find_map(|root| resolve_populated_directory(root))
                    .ok_or(AsrError::InvalidRuntime)?,
            )
        } else {
            None
        };
        let paths = RuntimePaths {
            python,
            worker,
            model,
            aligner,
        };
        WorkerProgram::python(&paths.python, &paths.worker)?;
        ModelAssets::new(engine, &paths.model, paths.aligner.as_deref())?;
        Ok(paths)
    }

    fn resolve_worker(&self) -> Result<PathBuf, AsrError> {
        let mut candidates = Vec::new();
        if let Some(root) = &self.0.resource_root {
            candidates.push(root.join("workers/osg_asr_worker.py"));
        }
        if let Some(root) = &self.0.development_root {
            candidates.push(root.join("crates/osg-asr/worker/osg_asr_worker.py"));
        }
        candidates
            .iter()
            .find_map(|path| resolve_verified_worker(path))
            .ok_or(AsrError::InvalidRuntime)
    }
}

impl ManagedAsrService {
    fn transcribe(
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

fn resolve_python(root: &Path) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["Scripts/python.exe", "python.exe"]
    } else {
        &["bin/python3", "bin/python"]
    };
    candidates
        .iter()
        .map(|relative| root.join(relative))
        .find_map(|path| {
            std::fs::canonicalize(path)
                .ok()
                .filter(|path| path.is_file())
        })
}

fn resolve_populated_directory(path: &Path) -> Option<PathBuf> {
    let path = std::fs::canonicalize(path).ok()?;
    if !path.is_dir() || std::fs::read_dir(&path).ok()?.next().is_none() {
        return None;
    }
    Some(path)
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsrStatus {
    worker_available: bool,
    engines: Vec<AsrEngineStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsrEngineStatus {
    #[serde(flatten)]
    info: AsrEngineInfo,
    installed: bool,
    ready: bool,
    warm: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum AsrEngineInput {
    #[serde(rename = "parakeet", alias = "nvidia-parakeet")]
    Parakeet,
    #[serde(rename = "faster-whisper-turbo")]
    FasterWhisperTurbo,
    #[serde(rename = "faster-whisper-large-v3")]
    FasterWhisperLargeV3,
    #[serde(rename = "qwen3-asr-1.7b")]
    Qwen3Asr1_7b,
    #[serde(rename = "qwen3-asr-0.6b")]
    Qwen3Asr0_6b,
}

impl From<AsrEngineInput> for AsrEngineId {
    fn from(value: AsrEngineInput) -> Self {
        match value {
            AsrEngineInput::Parakeet => Self::Parakeet,
            AsrEngineInput::FasterWhisperTurbo => Self::FasterWhisperTurbo,
            AsrEngineInput::FasterWhisperLargeV3 => Self::FasterWhisperLargeV3,
            AsrEngineInput::Qwen3Asr1_7b => Self::Qwen3Asr1_7b,
            AsrEngineInput::Qwen3Asr0_6b => Self::Qwen3Asr0_6b,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
enum AsrStrategyInput {
    #[default]
    #[serde(rename = "sentence")]
    Sentence,
    #[serde(rename = "word")]
    Word,
    #[serde(rename = "character", alias = "char")]
    Character,
}

impl From<AsrStrategyInput> for SegmentStrategy {
    fn from(value: AsrStrategyInput) -> Self {
        match value {
            AsrStrategyInput::Sentence => Self::Sentence,
            AsrStrategyInput::Word => Self::Word,
            AsrStrategyInput::Character => Self::Character,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AsrRangeInput {
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsrStartRequest {
    engine: AsrEngineInput,
    #[serde(default, alias = "segmentStrategy")]
    strategy: AsrStrategyInput,
    #[serde(default = "default_max_characters", alias = "maxChars")]
    max_characters: u16,
    #[serde(default = "default_max_words")]
    max_words: Option<u8>,
    #[serde(default = "default_pause_threshold_ms")]
    pause_threshold_ms: u32,
    language: Option<String>,
    range: Option<AsrRangeInput>,
}

const fn default_max_characters() -> u16 {
    60
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "Serde's default hook must distinguish an absent field from an explicit null"
)]
const fn default_max_words() -> Option<u8> {
    Some(7)
}

const fn default_pause_threshold_ms() -> u32 {
    800
}

impl AsrStartRequest {
    fn engine(&self) -> AsrEngineId {
        self.engine.into()
    }

    fn options(&self) -> Result<TranscriptionOptions, AsrError> {
        let segmentation = SegmentationOptions::new(
            self.strategy.into(),
            self.max_characters,
            self.max_words,
            self.pause_threshold_ms,
        )?;
        let mut options = TranscriptionOptions::new(segmentation);
        if let Some(language) = self.language.as_deref()
            && !language.eq_ignore_ascii_case("auto")
        {
            options = options.with_language(LanguageCode::new(language)?);
        }
        Ok(options)
    }

    fn range_us(&self) -> CommandResult<Option<RequestedRange>> {
        self.range
            .map(|range| {
                if range.end_ms <= range.start_ms
                    || range.end_ms - range.start_ms > MAX_TRANSCRIPTION_RANGE_MS
                {
                    return Err(CommandError::invalid_input(
                        "The ASR time range must be positive and no longer than 24 hours.",
                    ));
                }
                let start_us = range.start_ms.checked_mul(1_000).ok_or_else(|| {
                    CommandError::invalid_input("The ASR time range is too large.")
                })?;
                let end_us = range.end_ms.checked_mul(1_000).ok_or_else(|| {
                    CommandError::invalid_input("The ASR time range is too large.")
                })?;
                Ok(RequestedRange {
                    start_us,
                    end_us,
                    timeline_offset_ms: range.start_ms,
                })
            })
            .transpose()
    }
}

#[derive(Clone, Copy, Debug)]
struct RequestedRange {
    start_us: u64,
    end_us: u64,
    timeline_offset_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AsrJobPhase {
    PreparingAudio,
    ModelLoading,
    Transcribing,
    Finalizing,
}

impl From<ProgressPhase> for AsrJobPhase {
    fn from(value: ProgressPhase) -> Self {
        match value {
            ProgressPhase::ModelLoading => Self::ModelLoading,
            ProgressPhase::Transcribing => Self::Transcribing,
            ProgressPhase::Finalizing => Self::Finalizing,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum AsrJobEvent {
    Progress {
        job_id: JobId,
        phase: AsrJobPhase,
        fraction: Option<f64>,
    },
    Completed {
        job: JobSnapshot,
        transcription: Transcription,
        timeline_offset_ms: u64,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn asr_status(state: State<'_, DesktopState>) -> CommandResult<AsrStatus> {
    let manager = state.asr.clone();
    tauri::async_runtime::spawn_blocking(move || manager.status())
        .await
        .map_err(|_| CommandError::internal("the ASR status task stopped unexpectedly"))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn asr_start(
    state: State<'_, DesktopState>,
    request: AsrStartRequest,
    on_event: Channel<AsrJobEvent>,
) -> CommandResult<JobSnapshot> {
    let engine_id = request.engine();
    let options = request.options()?;
    let requested_range = request.range_us()?;
    let media_engine = state
        .media_engine
        .clone()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let local_media = state
        .editor
        .read()
        .map_err(|_| CommandError::internal("the editor session is unavailable"))?
        .local_media
        .clone()
        .ok_or_else(|| CommandError::invalid_input("Select a media file first."))?;
    let input = MediaInput::from_native_selection(local_media.path())?;
    let manager = state.asr.clone();
    let service = tauri::async_runtime::spawn_blocking(move || manager.service(engine_id))
        .await
        .map_err(|_| CommandError::internal("the ASR runtime task stopped unexpectedly"))??;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::Transcribe).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let job_cancellation = ticket.cancellation().clone();
    let manager = state.asr.clone();

    tauri::async_runtime::spawn(async move {
        let media_cancellation = MediaCancellationToken::default();
        let asr_cancellation = AsrCancellationToken::default();
        let channel_closed = Arc::new(AtomicBool::new(false));
        let watcher_media = media_cancellation.clone();
        let watcher_asr = asr_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_media.cancel();
            watcher_asr.cancel();
        });

        let result = run_asr_job(AsrExecution {
            manager,
            media_engine,
            input,
            service,
            options,
            requested_range,
            media_cancellation: media_cancellation.clone(),
            asr_cancellation: asr_cancellation.clone(),
            channel: on_event.clone(),
            channel_closed: Arc::clone(&channel_closed),
            job_id,
        })
        .await;
        watcher.abort();

        if channel_closed.load(Ordering::Acquire) {
            background::request_cancellation(&jobs, job_id).await;
        }
        finish_asr(
            &jobs,
            job_id,
            result,
            requested_range.map_or(0, |range| range.timeline_offset_ms),
            channel_closed.load(Ordering::Acquire),
            &on_event,
        )
        .await;
    });

    Ok(initial)
}

struct AsrExecution {
    manager: AsrRuntimeManager,
    media_engine: MediaEngine,
    input: MediaInput,
    service: ManagedAsrService,
    options: TranscriptionOptions,
    requested_range: Option<RequestedRange>,
    media_cancellation: MediaCancellationToken,
    asr_cancellation: AsrCancellationToken,
    channel: Channel<AsrJobEvent>,
    channel_closed: Arc<AtomicBool>,
    job_id: JobId,
}

async fn run_asr_job(execution: AsrExecution) -> CommandResult<Transcription> {
    tauri::async_runtime::spawn_blocking(move || run_asr_job_blocking(execution))
        .await
        .map_err(|_| CommandError::internal("the ASR task stopped unexpectedly"))?
}

fn run_asr_job_blocking(execution: AsrExecution) -> CommandResult<Transcription> {
    let AsrExecution {
        manager,
        media_engine,
        input,
        service,
        options,
        requested_range,
        media_cancellation,
        asr_cancellation,
        channel,
        channel_closed,
        job_id,
    } = execution;
    send_progress(
        &channel,
        &channel_closed,
        &media_cancellation,
        &asr_cancellation,
        job_id,
        AsrJobPhase::PreparingAudio,
        None,
    );
    let work = manager
        .work_directory()
        .map_err(|_| CommandError::internal("the private ASR working directory is unavailable"))?;
    let metadata = media_engine.probe(
        &input,
        &MediaRunControl::new(Duration::from_secs(30))?
            .with_cancellation(media_cancellation.clone()),
    )?;
    let range = resolve_media_range(metadata.duration_us(), requested_range)?;
    let output_path = work.path().join("normalized.wav");
    let output = MediaOutput::within_root(&output_path, work.path())?;
    let operation =
        MediaOperation::AudioExtraction(AudioExtractionPlan::asr_wav(input, output, range)?);
    let media_channel = channel.clone();
    let media_closed = Arc::clone(&channel_closed);
    let media_cancel_on_close = media_cancellation.clone();
    let asr_cancel_on_close = asr_cancellation.clone();
    let progress = MediaProgressSink::new(move |progress| {
        send_progress(
            &media_channel,
            &media_closed,
            &media_cancel_on_close,
            &asr_cancel_on_close,
            job_id,
            AsrJobPhase::PreparingAudio,
            progress.fraction,
        );
    });
    let media_control = MediaRunControl::new(MEDIA_TIMEOUT)?
        .with_cancellation(media_cancellation)
        .with_progress(progress);
    media_engine.execute(&operation, &media_control)?;
    let audio = osg_asr::NormalizedAudio::open(&output_path)?;
    let asr_channel = channel.clone();
    let asr_closed = Arc::clone(&channel_closed);
    let asr_cancel_on_close = asr_cancellation.clone();
    let media_cancel_on_close = media_control.cancellation();
    let asr_control = AsrRunControl::new(ASR_TIMEOUT)?
        .with_cancellation(asr_cancellation)
        .with_progress(move |progress: &osg_asr::AsrProgress| {
            send_progress(
                &asr_channel,
                &asr_closed,
                &media_cancel_on_close,
                &asr_cancel_on_close,
                job_id,
                progress.phase.into(),
                None,
            );
        });
    service
        .transcribe(&TranscriptionRequest::new(audio, options), &asr_control)
        .map_err(Into::into)
}

fn send_progress(
    channel: &Channel<AsrJobEvent>,
    channel_closed: &AtomicBool,
    media_cancellation: &MediaCancellationToken,
    asr_cancellation: &AsrCancellationToken,
    job_id: JobId,
    phase: AsrJobPhase,
    fraction: Option<f64>,
) {
    if channel_closed.load(Ordering::Acquire) {
        return;
    }
    if channel
        .send(AsrJobEvent::Progress {
            job_id,
            phase,
            fraction,
        })
        .is_err()
    {
        channel_closed.store(true, Ordering::Release);
        media_cancellation.cancel();
        asr_cancellation.cancel();
    }
}

fn resolve_media_range(
    media_duration_us: Option<u64>,
    requested: Option<RequestedRange>,
) -> CommandResult<MediaTimeRange> {
    let media_duration_us = media_duration_us
        .filter(|duration| *duration > 0)
        .ok_or_else(|| {
            CommandError::invalid_input("The selected media duration could not be determined.")
        })?;
    let (start_us, end_us) = if let Some(requested) = requested {
        if requested.start_us >= media_duration_us
            || requested.end_us > media_duration_us.saturating_add(RANGE_DURATION_TOLERANCE_US)
        {
            return Err(CommandError::invalid_input(
                "The requested ASR range is outside the selected media.",
            ));
        }
        (requested.start_us, requested.end_us.min(media_duration_us))
    } else {
        (0, media_duration_us)
    };
    let duration_us = end_us
        .checked_sub(start_us)
        .filter(|value| *value > 0)
        .ok_or_else(|| CommandError::invalid_input("The requested ASR range is empty."))?;
    if duration_us > MAX_TRANSCRIPTION_RANGE_MS * 1_000 {
        return Err(CommandError::invalid_input(
            "The ASR time range cannot exceed 24 hours.",
        ));
    }
    MediaTimeRange::new(start_us, Some(duration_us)).map_err(Into::into)
}

async fn finish_asr(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    result: CommandResult<Transcription>,
    timeline_offset_ms: u64,
    channel_closed: bool,
    channel: &Channel<AsrJobEvent>,
) {
    match result {
        Ok(transcription) if !channel_closed => {
            match background::apply(jobs, job_id, JobUpdate::Succeed).await {
                Ok(job) => {
                    let _ = channel.send(AsrJobEvent::Completed {
                        job,
                        transcription,
                        timeline_offset_ms,
                    });
                }
                Err(error) => {
                    let job = background::snapshot(jobs, job_id).await;
                    let _ = channel.send(AsrJobEvent::Failed { job, error });
                }
            }
        }
        result => {
            let cancelled = channel_closed
                || background::snapshot(jobs, job_id)
                    .await
                    .is_some_and(|job| matches!(job.state(), JobState::Cancelling));
            if cancelled {
                match background::finish_cancellation(jobs, job_id).await {
                    Ok(job) => {
                        let _ = channel.send(AsrJobEvent::Cancelled { job });
                    }
                    Err(error) => {
                        let job = background::snapshot(jobs, job_id).await;
                        let _ = channel.send(AsrJobEvent::Failed { job, error });
                    }
                }
            } else {
                let error = result.err().unwrap_or_else(CommandError::channel_closed);
                let job = background::finish_failure(jobs, job_id).await;
                let _ = channel.send(AsrJobEvent::Failed { job, error });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use osg_engine_packages::RuntimeCoordinator as _;
    use serde_json::json;

    use super::{
        AsrEngineId, AsrRuntimeManager, AsrStartRequest, RequestedRange, resolve_media_range,
    };

    #[test]
    fn request_accepts_the_frozen_ui_aliases_but_rejects_unknown_fields() {
        let request = serde_json::from_value::<AsrStartRequest>(json!({
            "engine": "nvidia-parakeet",
            "strategy": "char",
            "maxChars": 60,
            "maxWords": 7,
            "language": "auto",
            "range": { "startMs": 1_000, "endMs": 2_000 }
        }))
        .expect("legacy-shaped native request");
        assert_eq!(request.engine(), AsrEngineId::Parakeet);
        assert!(request.options().is_ok());
        assert_eq!(
            request.range_us().unwrap().unwrap().timeline_offset_ms,
            1_000
        );

        assert!(
            serde_json::from_value::<AsrStartRequest>(json!({
                "engine": "parakeet",
                "temperature": 0.5
            }))
            .is_err()
        );
    }

    #[test]
    fn media_ranges_are_bounded_and_tolerate_only_rounding_at_the_end() {
        let range = RequestedRange {
            start_us: 1_000_000,
            end_us: 5_100_000,
            timeline_offset_ms: 1_000,
        };
        let resolved = resolve_media_range(Some(5_000_000), Some(range)).unwrap();
        assert_eq!(resolved.start_us, 1_000_000);
        assert_eq!(resolved.duration_us, Some(4_000_000));

        let outside = RequestedRange {
            end_us: 5_300_000,
            ..range
        };
        assert!(resolve_media_range(Some(5_000_000), Some(outside)).is_err());
        assert!(resolve_media_range(None, None).is_err());
    }

    #[test]
    fn manager_reports_all_engines_without_leaking_private_paths() {
        let directory = tempfile::tempdir().unwrap();
        let install = directory.path().join("engines");
        let work = directory.path().join("work");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let manager = AsrRuntimeManager::new(&install, &work, None, Some(root)).unwrap();
        let status = manager.status();
        assert!(status.worker_available);
        assert_eq!(status.engines.len(), 5);
        let debug = format!("{manager:?}");
        assert!(!debug.contains(&directory.path().display().to_string()));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn package_coordinator_is_weak_and_cannot_keep_the_runtime_alive() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AsrRuntimeManager::new(
            directory.path().join("engines"),
            directory.path().join("work"),
            None,
            None,
        )
        .unwrap();
        let strong_before = Arc::strong_count(&manager.0);
        let coordinator = manager.package_coordinator();
        assert_eq!(Arc::strong_count(&manager.0), strong_before);

        drop(manager);
        assert_eq!(
            coordinator.quiesce(osg_engine_packages::EngineId::Parakeet),
            Err(osg_engine_packages::PackageError::StoreUnavailable)
        );
    }
}
