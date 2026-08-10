use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use osg_domain::{
    AssetId, JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate, MediaAsset, MediaKind,
    ProjectId,
};
use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, InstalledRenderRuntime, PackageError,
    RenderPackageId, RenderPackageManager, RenderRuntimeCoordinator,
};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
    ContentHash, Database,
};
use osg_media::{MediaEngine, MediaInput, RunControl as MediaRunControl};
use osg_media_server::{MediaServer, RegisteredMedia};
use osg_render::{
    NativeRenderInputs, PreparedRender, REMOTION_VERSION, RenderCancellationToken, RenderEngine,
    RenderError, RenderPhase, RenderPlan, RenderProgress, RenderProgressSink, RenderRequest,
    RenderRunControl, RenderRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{State, ipc::Channel};
use uuid::Uuid;

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const WORKER_BYTES: &[u8] =
    include_bytes!("../../../../video-renderer/worker/osg_render_worker.mjs");
const RENDER_TIMEOUT: Duration = Duration::from_hours(24);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MANIFEST_SCOPE: &str = "renderJobs";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_CONCURRENT_RENDERS: usize = 1;
const MAX_RENDER_PLAYBACKS: usize = 32;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const RENDER_PROGRESS_MAX_BASIS_POINTS: u16 = 9_500;
const PUBLISHING_BASIS_POINTS: u16 = 9_750;
const PROGRESS_STEP_BASIS_POINTS: u16 = 10;

#[derive(Clone)]
pub(crate) struct RenderRuntimeHost {
    inner: Arc<RenderRuntimeInner>,
}

struct RenderRuntimeInner {
    engine: RwLock<Option<LoadedRenderEngine>>,
    unavailable_reason: RwLock<Option<&'static str>>,
    package_manager: RwLock<Option<RenderPackageManager>>,
    worker_candidates: Vec<PathBuf>,
    ffmpeg: Option<PathBuf>,
    staging_root: PathBuf,
    media_server: MediaServer,
    slots: Arc<SlotLimiter>,
    playbacks: Mutex<PlaybackRegistry>,
}

struct LoadedRenderEngine {
    engine: RenderEngine,
    _lease: Option<InstalledRenderRuntime>,
}

#[derive(Clone)]
pub(crate) struct RenderPackageCoordinator(Weak<RenderRuntimeInner>);

impl RenderRuntimeCoordinator for RenderPackageCoordinator {
    fn quiesce(&self, _: RenderPackageId) -> osg_engine_packages::Result<()> {
        let inner = self.upgrade()?;
        if inner.slots.active.load(Ordering::Acquire) != 0 {
            return Err(PackageError::RuntimeBusy);
        }
        *inner
            .engine
            .write()
            .map_err(|_| PackageError::StoreUnavailable)? = None;
        *inner
            .unavailable_reason
            .write()
            .map_err(|_| PackageError::StoreUnavailable)? = Some("runtimePayloadUnavailable");
        Ok(())
    }
}

impl RenderPackageCoordinator {
    fn upgrade(&self) -> osg_engine_packages::Result<Arc<RenderRuntimeInner>> {
        self.0.upgrade().ok_or(PackageError::StoreUnavailable)
    }
}

impl RenderRuntimeHost {
    pub(crate) fn new(
        cache_root: impl AsRef<Path>,
        resource_root: Option<&Path>,
        development_root: Option<&Path>,
        ffmpeg: Option<PathBuf>,
        media_server: MediaServer,
    ) -> std::io::Result<Self> {
        let staging_root = cache_root.as_ref().join("v1/render");
        fs::create_dir_all(&staging_root)?;
        let worker_candidates = worker_candidates(resource_root, development_root);
        let runtime = resolve_runtime(resource_root, development_root);
        let unavailable_reason = if runtime.is_none() {
            Some("runtimePayloadUnavailable")
        } else if ffmpeg.is_none() {
            Some("mediaToolsUnavailable")
        } else {
            None
        };
        let engine = runtime
            .map(|runtime| LoadedRenderEngine {
                engine: RenderEngine::new(runtime),
                _lease: None,
            })
            .filter(|_| ffmpeg.is_some());
        Ok(Self {
            inner: Arc::new(RenderRuntimeInner {
                engine: RwLock::new(engine),
                unavailable_reason: RwLock::new(unavailable_reason),
                package_manager: RwLock::new(None),
                worker_candidates,
                ffmpeg,
                staging_root,
                media_server,
                slots: SlotLimiter::new(MAX_CONCURRENT_RENDERS),
                playbacks: Mutex::new(PlaybackRegistry::default()),
            }),
        })
    }

    fn engine_and_inputs(&self) -> CommandResult<(RenderEngine, PathBuf, PathBuf)> {
        let engine = self
            .inner
            .engine
            .read()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))?
            .as_ref()
            .map(|loaded| loaded.engine.clone())
            .ok_or_else(CommandError::render_runtime_unavailable)?;
        let ffmpeg = self
            .inner
            .ffmpeg
            .clone()
            .ok_or_else(CommandError::media_tools_unavailable)?;
        Ok((engine, ffmpeg, self.inner.staging_root.clone()))
    }

    pub(crate) fn package_coordinator(&self) -> RenderPackageCoordinator {
        RenderPackageCoordinator(Arc::downgrade(&self.inner))
    }

    pub(crate) fn attach_package_manager(
        &self,
        manager: RenderPackageManager,
    ) -> CommandResult<()> {
        let mut slot =
            self.inner.package_manager.write().map_err(|_| {
                CommandError::internal("The render package manager is unavailable.")
            })?;
        if slot.is_some() {
            return Err(CommandError::internal(
                "The render package manager is already attached.",
            ));
        }
        *slot = Some(manager);
        *self
            .inner
            .unavailable_reason
            .write()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))? =
            Some("runtimePayloadVerifying");
        Ok(())
    }

    pub(crate) fn refresh_managed(&self) -> CommandResult<()> {
        let manager = self
            .inner
            .package_manager
            .read()
            .map_err(|_| CommandError::internal("The render package manager is unavailable."))?
            .clone()
            .ok_or_else(|| CommandError::internal("The render package manager is unavailable."))?;
        let installed =
            match manager.resolve_for_launch(&PackageCancellationToken::default()) {
                Ok(runtime) => runtime,
                Err(PackageError::InvalidInstall | PackageError::DeliveryUnavailable) => {
                    *self.inner.engine.write().map_err(|_| {
                        CommandError::internal("The render runtime is unavailable.")
                    })? = None;
                    *self.inner.unavailable_reason.write().map_err(|_| {
                        CommandError::internal("The render runtime is unavailable.")
                    })? = Some("runtimePayloadUnavailable");
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
        let root = installed.package_root().join("runtime");
        let runtime = self
            .inner
            .worker_candidates
            .iter()
            .find_map(|worker| {
                RenderRuntime::load(&root, worker, WORKER_BYTES, runtime_target()).ok()
            })
            .ok_or_else(CommandError::render_runtime_unavailable)?;
        let available = self.inner.ffmpeg.is_some();
        *self
            .inner
            .engine
            .write()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))? = available
            .then_some(LoadedRenderEngine {
                engine: RenderEngine::new(runtime),
                _lease: Some(installed),
            });
        *self
            .inner
            .unavailable_reason
            .write()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))? =
            (!available).then_some("mediaToolsUnavailable");
        Ok(())
    }

    fn register_playback(&self, asset: &MediaAsset, path: &Path) -> CommandResult<RegisteredMedia> {
        let mut playbacks =
            self.inner.playbacks.lock().map_err(|_| {
                CommandError::internal("The render playback registry is unavailable.")
            })?;
        if let Some(existing) = playbacks.by_asset.get(&asset.id()) {
            return Ok(existing.clone());
        }
        while playbacks.by_asset.len() >= MAX_RENDER_PLAYBACKS {
            let Some(oldest) = playbacks.order.pop_front() else {
                return Err(CommandError::internal(
                    "The render playback registry is inconsistent.",
                ));
            };
            if let Some(previous) = playbacks.by_asset.remove(&oldest) {
                let _ = self.inner.media_server.unregister(previous.id);
            }
        }
        let playback = self
            .inner
            .media_server
            .register_with_extension(path, asset.extension())?;
        playbacks.order.push_back(asset.id());
        playbacks.by_asset.insert(asset.id(), playback.clone());
        Ok(playback)
    }

    fn release_playback(&self, playback_id: Uuid) -> CommandResult<bool> {
        let mut playbacks =
            self.inner.playbacks.lock().map_err(|_| {
                CommandError::internal("The render playback registry is unavailable.")
            })?;
        let asset_id = playbacks
            .by_asset
            .iter()
            .find_map(|(asset_id, playback)| (playback.id == playback_id).then_some(*asset_id));
        let Some(asset_id) = asset_id else {
            return Ok(false);
        };
        playbacks.by_asset.remove(&asset_id);
        playbacks.order.retain(|candidate| *candidate != asset_id);
        self.inner
            .media_server
            .unregister(playback_id)
            .map_err(Into::into)
    }
}

impl std::fmt::Debug for RenderRuntimeHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RenderRuntimeHost")
            .field(
                "available",
                &self
                    .inner
                    .engine
                    .read()
                    .is_ok_and(|engine| engine.is_some()),
            )
            .field(
                "reason",
                &self
                    .inner
                    .unavailable_reason
                    .read()
                    .ok()
                    .and_then(|reason| *reason),
            )
            .field("paths", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
struct PlaybackRegistry {
    by_asset: HashMap<AssetId, RegisteredMedia>,
    order: VecDeque<AssetId>,
}

#[derive(Debug)]
struct SlotLimiter {
    active: AtomicUsize,
    maximum: usize,
}

impl SlotLimiter {
    fn new(maximum: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            maximum,
        })
    }

    fn acquire(self: &Arc<Self>) -> Option<SlotPermit> {
        let mut observed = self.active.load(Ordering::Acquire);
        loop {
            if observed >= self.maximum {
                return None;
            }
            match self.active.compare_exchange_weak(
                observed,
                observed + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(SlotPermit {
                        limiter: Arc::clone(self),
                    });
                }
                Err(actual) => observed = actual,
            }
        }
    }
}

#[derive(Debug)]
struct SlotPermit {
    limiter: Arc<SlotLimiter>,
}

impl Drop for SlotPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderRuntimeStatusResponse {
    available: bool,
    remotion_version: &'static str,
    reason: Option<&'static str>,
    max_concurrent_renders: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RenderPhaseResponse {
    Staging,
    ExtractingFrames,
    ExtractingAudio,
    LoadingComposition,
    RenderingFrames,
    Encoding,
    Muxing,
    Publishing,
}

impl From<RenderPhase> for RenderPhaseResponse {
    fn from(value: RenderPhase) -> Self {
        match value {
            RenderPhase::Staging => Self::Staging,
            RenderPhase::ExtractingFrames => Self::ExtractingFrames,
            RenderPhase::ExtractingAudio => Self::ExtractingAudio,
            RenderPhase::LoadingComposition => Self::LoadingComposition,
            RenderPhase::RenderingFrames => Self::RenderingFrames,
            RenderPhase::Encoding => Self::Encoding,
            RenderPhase::Muxing => Self::Muxing,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderManifestResult {
    artifact_id: String,
    asset: MediaAsset,
    source_asset_id: AssetId,
    project_id: ProjectId,
    width: u32,
    height: u32,
    fps: u16,
    duration_in_frames: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderManifest {
    schema_version: u32,
    result: Option<RenderManifestResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderCompletedResult {
    artifact_id: String,
    asset: MediaAsset,
    source_asset_id: AssetId,
    project_id: ProjectId,
    width: u32,
    height: u32,
    fps: u16,
    duration_in_frames: u32,
    playback: RegisteredMedia,
}

impl RenderCompletedResult {
    fn new(manifest: RenderManifestResult, playback: RegisteredMedia) -> Self {
        Self {
            artifact_id: manifest.artifact_id,
            asset: manifest.asset,
            source_asset_id: manifest.source_asset_id,
            project_id: manifest.project_id,
            width: manifest.width,
            height: manifest.height,
            fps: manifest.fps,
            duration_in_frames: manifest.duration_in_frames,
            playback,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderResultResponse {
    job: JobSnapshot,
    result: Option<RenderCompletedResult>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum RenderEvent {
    Progress {
        job: JobSnapshot,
        phase: RenderPhaseResponse,
        fraction_millionths: u32,
        rendered_frames: u32,
        encoded_frames: u32,
        duration_in_frames: u32,
    },
    Completed {
        job: JobSnapshot,
        result: RenderCompletedResult,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

struct ValidatedStart {
    plan: RenderPlan,
    inputs: NativeRenderInputs,
}

struct ProgressState {
    last_basis_points: u16,
    last_phase: Option<RenderPhaseResponse>,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn render_runtime_status(
    runtime: State<'_, RenderRuntimeHost>,
) -> RenderRuntimeStatusResponse {
    RenderRuntimeStatusResponse {
        available: runtime
            .inner
            .engine
            .read()
            .is_ok_and(|engine| engine.is_some()),
        remotion_version: REMOTION_VERSION,
        reason: runtime
            .inner
            .unavailable_reason
            .read()
            .ok()
            .and_then(|reason| *reason),
        max_concurrent_renders: MAX_CONCURRENT_RENDERS,
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn render_start(
    state: State<'_, DesktopState>,
    runtime: State<'_, RenderRuntimeHost>,
    request: RenderRequest,
    on_event: Channel<RenderEvent>,
) -> CommandResult<JobSnapshot> {
    let permit = runtime
        .inner
        .slots
        .acquire()
        .ok_or_else(CommandError::render_busy)?;
    let (render_engine, ffmpeg, staging_root) = runtime.engine_and_inputs()?;
    let media_engine = state
        .media_engine
        .clone()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let database = state.database.clone();
    let validated = tauri::async_runtime::spawn_blocking({
        let database = database.clone();
        move || prepare_start(&database, &media_engine, request, ffmpeg, staging_root)
    })
    .await
    .map_err(|_| CommandError::internal("The render validation task stopped unexpectedly."))??;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::RenderVideo).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    if let Err(error) = initialize_manifest(&database, job_id) {
        let _ = background::finish_failure(&jobs, job_id).await;
        return Err(error);
    }
    let _ = on_event.send(RenderEvent::Progress {
        job: initial.clone(),
        phase: RenderPhaseResponse::Staging,
        fraction_millionths: 0,
        rendered_frames: 0,
        encoded_frames: 0,
        duration_in_frames: validated.plan.duration_frames,
    });

    let runtime = runtime.inner().clone();
    let cancellation = ticket.cancellation().clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let render_cancellation = RenderCancellationToken::default();
        let cancellation_bridge = render_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation.cancelled().await;
            cancellation_bridge.cancel();
        });
        let progress = render_progress_sink(
            Arc::clone(&jobs),
            job_id,
            on_event.clone(),
            render_cancellation.clone(),
        );
        let control = match RenderRunControl::new(RENDER_TIMEOUT) {
            Ok(control) => control
                .with_cancellation(render_cancellation.clone())
                .with_progress(progress),
            Err(error) => {
                watcher.abort();
                fail_render(&jobs, job_id, error.into(), &on_event).await;
                return;
            }
        };
        let plan = validated.plan;
        let source_asset_id = plan.source_asset_id;
        let project_id = plan.project_id;
        let native_result = tauri::async_runtime::spawn_blocking(move || {
            render_engine.render(&plan, &validated.inputs, &control)
        })
        .await
        .map_err(|_| CommandError::internal("The native render task stopped unexpectedly."))
        .and_then(|result| result.map_err(Into::into));
        watcher.abort();
        finish_render(
            &runtime,
            &database,
            &jobs,
            job_id,
            source_asset_id,
            project_id,
            native_result,
            &render_cancellation,
            &on_event,
        )
        .await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn render_result(
    state: State<'_, DesktopState>,
    runtime: State<'_, RenderRuntimeHost>,
    job_id: JobId,
) -> CommandResult<RenderResultResponse> {
    let database = state.database.clone();
    let jobs = Arc::clone(&state.jobs);
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let job = jobs.get(job_id)?.snapshot().clone();
        if job.kind() != JobKind::RenderVideo {
            return Err(CommandError::invalid_input(
                "The job is not a native video render.",
            ));
        }
        let result = read_manifest_result(&database, &job)?;
        let resolved = result
            .map(|result| {
                let media = validate_manifest_result(&database, job_id, &result)?;
                Ok::<_, CommandError>((result, media.path().to_owned()))
            })
            .transpose()?;
        Ok::<_, CommandError>((job, resolved))
    })
    .await
    .map_err(|_| CommandError::internal("The render result task stopped unexpectedly."))??;
    let result = resolved
        .1
        .map(|(manifest, path)| {
            runtime
                .register_playback(&manifest.asset, &path)
                .map(|playback| RenderCompletedResult::new(manifest, playback))
        })
        .transpose()?;
    Ok(RenderResultResponse {
        job: resolved.0,
        result,
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn render_playback_release(
    runtime: State<'_, RenderRuntimeHost>,
    playback_id: Uuid,
) -> CommandResult<bool> {
    runtime.release_playback(playback_id)
}

fn prepare_start(
    database: &Database,
    media_engine: &MediaEngine,
    request: RenderRequest,
    ffmpeg: PathBuf,
    staging_root: PathBuf,
) -> CommandResult<ValidatedStart> {
    let source = database
        .resolve_media(request.source_asset_id)?
        .ok_or_else(CommandError::media_unavailable)?;
    if source.asset().kind() != MediaKind::Video {
        return Err(CommandError::invalid_input(
            "Native rendering requires a video media asset.",
        ));
    }
    let project = database
        .load_project(request.project_id)?
        .ok_or_else(|| CommandError::invalid_input("The render project does not exist."))?;
    if !project
        .media()
        .iter()
        .any(|asset| asset.id() == source.asset().id())
    {
        return Err(CommandError::invalid_input(
            "The video media asset is not part of the render project.",
        ));
    }
    let media_input = MediaInput::from_native_selection(source.path())?;
    let metadata = media_engine.probe(&media_input, &MediaRunControl::new(PROBE_TIMEOUT)?)?;
    let video = metadata
        .primary_video()
        .and_then(|stream| stream.video.as_ref())
        .ok_or_else(|| CommandError::invalid_input("The render source has no video stream."))?;
    let duration_us = metadata
        .duration_us()
        .ok_or_else(|| CommandError::invalid_input("The render source duration is unavailable."))?;
    let (source_width, source_height) = if video.rotation_degrees.rem_euclid(180) == 90 {
        (video.height, video.width)
    } else {
        (video.width, video.height)
    };
    let narration_id = request.narration_artifact_id;
    let plan = request.validate(source_width, source_height, duration_us)?;
    let source_hash = hash_file(source.path())?;
    let mut inputs = NativeRenderInputs::new(
        source.path().to_owned(),
        source.asset().size_bytes(),
        source_hash,
        source.asset().extension(),
        ffmpeg,
        staging_root,
    )?;
    if let Some(narration_id) = narration_id {
        let narration_id = ArtifactId::from_uuid(narration_id)
            .map_err(|_| CommandError::invalid_input("The narration artifact is invalid."))?;
        let narration = database
            .resolve_artifact(narration_id)?
            .ok_or_else(|| CommandError::invalid_input("The narration artifact is unavailable."))?;
        if !matches!(
            narration.record().kind().as_str(),
            "narrationOutput" | "voiceConversion" | "alignedNarration"
        ) {
            return Err(CommandError::invalid_input(
                "The artifact is not a renderable narration output.",
            ));
        }
        let extension = speech_artifact_extension(narration.record().metadata())?;
        inputs = inputs.with_narration(
            narration.path().to_owned(),
            narration.record().size_bytes(),
            *narration.record().content_hash().as_bytes(),
            extension,
        )?;
    }
    Ok(ValidatedStart { plan, inputs })
}

fn speech_artifact_extension(metadata: &serde_json::Value) -> CommandResult<&'static str> {
    match metadata.get("format").and_then(serde_json::Value::as_str) {
        Some("wav") => Ok("wav"),
        Some("mp3") => Ok("mp3"),
        Some("m4a") => Ok("m4a"),
        _ => Err(CommandError::invalid_input(
            "The narration artifact format is unavailable.",
        )),
    }
}

fn hash_file(path: &Path) -> CommandResult<[u8; 32]> {
    let file = File::open(path).map_err(|_| CommandError::media_unavailable())?;
    ContentHash::digest_reader(BufReader::new(file))
        .map(|hash| *hash.as_bytes())
        .map_err(|_| CommandError::media_unavailable())
}

fn render_progress_sink(
    jobs: background::DesktopJobs,
    job_id: JobId,
    channel: Channel<RenderEvent>,
    cancellation: RenderCancellationToken,
) -> RenderProgressSink {
    let state = Mutex::new(ProgressState {
        last_basis_points: 0,
        last_phase: None,
    });
    RenderProgressSink::new(move |progress| {
        report_render_progress(&jobs, job_id, &channel, &cancellation, &state, progress);
    })
}

fn report_render_progress(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    channel: &Channel<RenderEvent>,
    cancellation: &RenderCancellationToken,
    state: &Mutex<ProgressState>,
    progress: RenderProgress,
) {
    let phase = RenderPhaseResponse::from(progress.phase);
    let basis_points = u16::try_from(
        u64::from(RENDER_PROGRESS_MAX_BASIS_POINTS)
            * u64::from(progress.fraction_millionths.min(1_000_000))
            / 1_000_000,
    )
    .unwrap_or(RENDER_PROGRESS_MAX_BASIS_POINTS);
    let Ok(mut reporter) = state.lock() else {
        cancellation.cancel();
        return;
    };
    let phase_changed = reporter.last_phase != Some(phase);
    if !phase_changed
        && basis_points
            < reporter
                .last_basis_points
                .saturating_add(PROGRESS_STEP_BASIS_POINTS)
    {
        return;
    }
    let Ok(current) = jobs.get(job_id) else {
        cancellation.cancel();
        return;
    };
    if current.snapshot().state() != JobState::Running {
        cancellation.cancel();
        return;
    }
    let job = if basis_points > current.snapshot().progress().basis_points() {
        let Ok(progress_value) = JobProgress::from_basis_points(basis_points) else {
            cancellation.cancel();
            return;
        };
        if let Ok(ticket) = jobs.apply(job_id, JobUpdate::ReportProgress(progress_value)) {
            ticket.snapshot().clone()
        } else {
            cancellation.cancel();
            return;
        }
    } else {
        current.snapshot().clone()
    };
    reporter.last_basis_points = reporter.last_basis_points.max(basis_points);
    reporter.last_phase = Some(phase);
    drop(reporter);
    let _ = channel.send(RenderEvent::Progress {
        job,
        phase,
        fraction_millionths: progress.fraction_millionths,
        rendered_frames: progress.rendered_frames,
        encoded_frames: progress.encoded_frames,
        duration_in_frames: progress.duration_in_frames,
    });
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "render publication and the durable job terminal transition form one ordered state machine"
)]
async fn finish_render(
    runtime: &RenderRuntimeHost,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    source_asset_id: AssetId,
    project_id: ProjectId,
    native_result: CommandResult<PreparedRender>,
    cancellation: &RenderCancellationToken,
    channel: &Channel<RenderEvent>,
) {
    let prepared = match native_result {
        Ok(prepared) => prepared,
        Err(error) => {
            if cancellation.is_cancelled()
                || background::snapshot(jobs, job_id)
                    .await
                    .is_some_and(|job| job.state() == JobState::Cancelling)
            {
                cancel_render(jobs, job_id, channel).await;
            } else {
                fail_render(jobs, job_id, error, channel).await;
            }
            return;
        }
    };
    if cancellation.is_cancelled()
        || background::snapshot(jobs, job_id)
            .await
            .is_some_and(|job| job.state() == JobState::Cancelling)
    {
        cancel_render(jobs, job_id, channel).await;
        return;
    }
    let publishing = match background::apply(
        jobs,
        job_id,
        JobUpdate::ReportProgress(
            JobProgress::from_basis_points(PUBLISHING_BASIS_POINTS)
                .expect("publishing progress is bounded"),
        ),
    )
    .await
    {
        Ok(job) => job,
        Err(error) => {
            fail_render(jobs, job_id, error, channel).await;
            return;
        }
    };
    let _ = channel.send(RenderEvent::Progress {
        job: publishing,
        phase: RenderPhaseResponse::Publishing,
        fraction_millionths: 1_000_000,
        rendered_frames: prepared.duration_in_frames(),
        encoded_frames: prepared.duration_in_frames(),
        duration_in_frames: prepared.duration_in_frames(),
    });
    let publication_database = database.clone();
    let publication_cancellation = cancellation.clone();
    let published = tauri::async_runtime::spawn_blocking(move || {
        publish_render(
            &publication_database,
            job_id,
            source_asset_id,
            project_id,
            &prepared,
            &publication_cancellation,
        )
    })
    .await
    .map_err(|_| CommandError::internal("The render publication task stopped unexpectedly."))
    .and_then(|result| result);
    let manifest = match published {
        Ok(manifest) => manifest,
        Err(error) => {
            if cancellation.is_cancelled() {
                cancel_render(jobs, job_id, channel).await;
            } else {
                fail_render(jobs, job_id, error, channel).await;
            }
            return;
        }
    };
    if cancellation.is_cancelled()
        || background::snapshot(jobs, job_id)
            .await
            .is_some_and(|job| job.state() == JobState::Cancelling)
    {
        cancel_render(jobs, job_id, channel).await;
        return;
    }
    if let Err(error) = store_manifest_result(database, job_id, manifest.clone()) {
        fail_render(jobs, job_id, error, channel).await;
        return;
    }
    let job = match background::apply(jobs, job_id, JobUpdate::Succeed).await {
        Ok(job) => job,
        Err(error) => {
            let _ = clear_manifest_result(database, job_id);
            if background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling)
            {
                cancel_render(jobs, job_id, channel).await;
            } else {
                fail_render(jobs, job_id, error, channel).await;
            }
            return;
        }
    };
    let resolved = match validate_manifest_result(database, job_id, &manifest) {
        Ok(resolved) => resolved,
        Err(error) => {
            let _ = channel.send(RenderEvent::Failed {
                job: Some(job),
                error,
            });
            return;
        }
    };
    match runtime.register_playback(&manifest.asset, resolved.path()) {
        Ok(playback) => {
            let _ = channel.send(RenderEvent::Completed {
                job,
                result: RenderCompletedResult::new(manifest, playback),
            });
        }
        Err(error) => {
            let _ = channel.send(RenderEvent::Failed {
                job: Some(job),
                error,
            });
        }
    }
}

fn publish_render(
    database: &Database,
    job_id: JobId,
    source_asset_id: AssetId,
    project_id: ProjectId,
    prepared: &PreparedRender,
    cancellation: &RenderCancellationToken,
) -> CommandResult<RenderManifestResult> {
    if cancellation.is_cancelled() {
        return Err(RenderError::Cancelled.into());
    }
    let asset = MediaAsset::new(
        "rendered-video.mp4",
        "mp4",
        prepared.size_bytes(),
        MediaKind::Video,
    )
    .map_err(|_| CommandError::internal("The rendered media metadata is invalid."))?;
    let metadata = json!({
        "schemaVersion": 1,
        "sourceAssetId": source_asset_id,
        "projectId": project_id,
        "width": prepared.width(),
        "height": prepared.height(),
        "fps": prepared.fps(),
        "durationInFrames": prepared.duration_in_frames(),
        "remotionVersion": REMOTION_VERSION,
    });
    let draft = ArtifactDraft::new(
        ArtifactKind::new("renderedVideo")?,
        ContentHash::from_bytes(*prepared.content_hash()),
        prepared.size_bytes(),
        metadata,
    )?
    .with_project(project_id)
    .with_job(job_id);
    let artifact_id = match database.register_artifact(&draft)? {
        ArtifactRegistration::Existing(record) => record.id(),
        ArtifactRegistration::Staging(staging) => {
            let artifact_id = staging.record().id();
            if let Err(error) = copy_render_artifact(
                prepared.path(),
                staging.path(),
                prepared.size_bytes(),
                prepared.content_hash(),
                cancellation,
            ) {
                fail_artifact_publication(database, artifact_id);
                return Err(error);
            }
            if cancellation.is_cancelled() {
                fail_artifact_publication(database, artifact_id);
                return Err(RenderError::Cancelled.into());
            }
            if database.mark_artifact_ready(artifact_id).is_err() {
                fail_artifact_publication(database, artifact_id);
                return Err(CommandError::render_publication_failed());
            }
            artifact_id
        }
    };
    if cancellation.is_cancelled() {
        return Err(RenderError::Cancelled.into());
    }
    let resolved = database
        .resolve_artifact(artifact_id)?
        .ok_or_else(CommandError::render_publication_failed)?;
    if resolved.record().kind().as_str() != "renderedVideo"
        || resolved.record().job_id() != Some(job_id)
        || resolved.record().project_id() != Some(project_id)
        || resolved.record().size_bytes() != prepared.size_bytes()
        || resolved.record().content_hash() != ContentHash::from_bytes(*prepared.content_hash())
    {
        return Err(CommandError::render_publication_failed());
    }
    database.remember_media(&asset, resolved.path())?;
    Ok(RenderManifestResult {
        artifact_id: artifact_id.to_string(),
        asset,
        source_asset_id,
        project_id,
        width: prepared.width(),
        height: prepared.height(),
        fps: prepared.fps(),
        duration_in_frames: prepared.duration_in_frames(),
    })
}

fn copy_render_artifact(
    source_path: &Path,
    destination_path: &Path,
    expected_bytes: u64,
    expected_hash: &[u8; 32],
    cancellation: &RenderCancellationToken,
) -> CommandResult<()> {
    let mut source =
        File::open(source_path).map_err(|_| CommandError::render_publication_failed())?;
    let source_metadata = source
        .metadata()
        .map_err(|_| CommandError::render_publication_failed())?;
    if !source_metadata.is_file() || source_metadata.len() != expected_bytes {
        return Err(CommandError::render_publication_failed());
    }
    let mut destination = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination_path)
        .map_err(|_| CommandError::render_publication_failed())?;
    let mut copied = 0_u64;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES].into_boxed_slice();
    loop {
        if cancellation.is_cancelled() {
            return Err(RenderError::Cancelled.into());
        }
        let count = source
            .read(&mut buffer)
            .map_err(|_| CommandError::render_publication_failed())?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(
                u64::try_from(count).map_err(|_| CommandError::render_publication_failed())?,
            )
            .filter(|copied| *copied <= expected_bytes)
            .ok_or_else(CommandError::render_publication_failed)?;
        hasher.update(&buffer[..count]);
        destination
            .write_all(&buffer[..count])
            .map_err(|_| CommandError::render_publication_failed())?;
    }
    if copied != expected_bytes || hasher.finalize().as_bytes() != expected_hash {
        return Err(CommandError::render_publication_failed());
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| CommandError::render_publication_failed())?;
    destination
        .flush()
        .and_then(|()| destination.sync_all())
        .map_err(|_| CommandError::render_publication_failed())?;
    Ok(())
}

fn initialize_manifest(database: &Database, job_id: JobId) -> CommandResult<()> {
    store_manifest(
        database,
        job_id,
        &RenderManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            result: None,
        },
    )
}

fn store_manifest_result(
    database: &Database,
    job_id: JobId,
    result: RenderManifestResult,
) -> CommandResult<()> {
    let current = read_manifest(database, job_id)?;
    if current.result.is_some() {
        return Err(CommandError::internal(
            "The render result was already committed.",
        ));
    }
    store_manifest(
        database,
        job_id,
        &RenderManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            result: Some(result),
        },
    )
}

fn clear_manifest_result(database: &Database, job_id: JobId) -> CommandResult<()> {
    initialize_manifest(database, job_id)
}

fn store_manifest(
    database: &Database,
    job_id: JobId,
    manifest: &RenderManifest,
) -> CommandResult<()> {
    let value = serde_json::to_value(manifest)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    database.put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)?;
    Ok(())
}

fn read_manifest(database: &Database, job_id: JobId) -> CommandResult<RenderManifest> {
    let value = database
        .get_setting(MANIFEST_SCOPE, &job_id.to_string())?
        .ok_or_else(|| CommandError::internal("The render result manifest is missing."))?;
    let manifest: RenderManifest = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(CommandError::internal(
            "The render result manifest is invalid.",
        ));
    }
    Ok(manifest)
}

fn read_manifest_result(
    database: &Database,
    job: &JobSnapshot,
) -> CommandResult<Option<RenderManifestResult>> {
    let manifest = read_manifest(database, job.id())?;
    match job.state() {
        JobState::Succeeded => manifest
            .result
            .map(Some)
            .ok_or_else(|| CommandError::internal("The completed render result is missing.")),
        JobState::Queued | JobState::Running | JobState::Cancelling => Ok(None),
        JobState::Failed | JobState::Cancelled | JobState::Interrupted => {
            if manifest.result.is_some() {
                Err(CommandError::internal(
                    "The render result manifest is inconsistent.",
                ))
            } else {
                Ok(None)
            }
        }
    }
}

fn validate_manifest_result(
    database: &Database,
    job_id: JobId,
    result: &RenderManifestResult,
) -> CommandResult<osg_infrastructure::storage::ResolvedMedia> {
    let artifact_uuid = Uuid::parse_str(&result.artifact_id)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    let artifact_id = ArtifactId::from_uuid(artifact_uuid)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    let artifact = database
        .resolve_artifact(artifact_id)?
        .ok_or_else(|| CommandError::internal("The rendered artifact is unavailable."))?;
    let media = database
        .resolve_media(result.asset.id())?
        .ok_or_else(|| CommandError::internal("The rendered media is unavailable."))?;
    if artifact.record().kind().as_str() != "renderedVideo"
        || artifact.record().job_id() != Some(job_id)
        || artifact.record().project_id() != Some(result.project_id)
        || artifact.record().size_bytes() != result.asset.size_bytes()
        || result.asset.kind() != MediaKind::Video
        || result.asset.extension() != "mp4"
        || media.asset() != &result.asset
        || !same_file::is_same_file(artifact.path(), media.path()).unwrap_or(false)
    {
        return Err(CommandError::internal(
            "The render result manifest is invalid.",
        ));
    }
    let metadata = artifact
        .record()
        .metadata()
        .as_object()
        .ok_or_else(|| CommandError::internal("The render result manifest is invalid."))?;
    let metadata_matches = metadata.get("sourceAssetId") == Some(&json!(result.source_asset_id))
        && metadata.get("projectId") == Some(&json!(result.project_id))
        && metadata.get("width").and_then(serde_json::Value::as_u64)
            == Some(u64::from(result.width))
        && metadata.get("height").and_then(serde_json::Value::as_u64)
            == Some(u64::from(result.height))
        && metadata.get("fps").and_then(serde_json::Value::as_u64) == Some(u64::from(result.fps))
        && metadata
            .get("durationInFrames")
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(result.duration_in_frames))
        && metadata
            .get("remotionVersion")
            .and_then(serde_json::Value::as_str)
            == Some(REMOTION_VERSION);
    if result.width == 0
        || result.height == 0
        || result.fps == 0
        || result.duration_in_frames == 0
        || !metadata_matches
    {
        return Err(CommandError::internal(
            "The render result manifest is invalid.",
        ));
    }
    Ok(media)
}

fn fail_artifact_publication(database: &Database, artifact_id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("renderPublish") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}

async fn cancel_render(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    channel: &Channel<RenderEvent>,
) {
    match background::finish_cancellation(jobs, job_id).await {
        Ok(job) => {
            let _ = channel.send(RenderEvent::Cancelled { job });
        }
        Err(error) => {
            let job = background::snapshot(jobs, job_id).await;
            let _ = channel.send(RenderEvent::Failed { job, error });
        }
    }
}

async fn fail_render(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    error: CommandError,
    channel: &Channel<RenderEvent>,
) {
    let job = background::finish_failure(jobs, job_id).await;
    let _ = channel.send(RenderEvent::Failed { job, error });
}

fn resolve_runtime(
    resource_root: Option<&Path>,
    development_root: Option<&Path>,
) -> Option<RenderRuntime> {
    let target = runtime_target();
    let worker_candidates = worker_candidates(resource_root, development_root);
    let mut runtime_candidates = Vec::new();
    if let Some(root) = resource_root {
        runtime_candidates.push(root.join("render-runtime").join(target));
    }
    if let Some(root) = development_root {
        runtime_candidates.push(root.join("local-runtime-bundles/remotion").join(target));
    }
    for runtime_root in runtime_candidates {
        for worker in &worker_candidates {
            if let Ok(runtime) = RenderRuntime::load(&runtime_root, worker, WORKER_BYTES, target) {
                return Some(runtime);
            }
        }
    }
    None
}

fn worker_candidates(
    resource_root: Option<&Path>,
    development_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = resource_root {
        candidates.push(root.join("workers/osg_render_worker.mjs"));
    }
    if let Some(root) = development_root {
        candidates.push(root.join("video-renderer/worker/osg_render_worker.mjs"));
    }
    candidates
}

const fn runtime_target() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_status_fails_closed_without_managed_payloads() {
        let root = tempfile::tempdir().expect("root");
        let media_server = MediaServer::start(["tauri://localhost".to_owned()]).expect("server");
        let runtime = RenderRuntimeHost::new(root.path(), None, None, None, media_server)
            .expect("runtime host");

        assert!(runtime.inner.engine.read().unwrap().is_none());
        assert_eq!(
            *runtime.inner.unavailable_reason.read().unwrap(),
            Some("runtimePayloadUnavailable")
        );
        assert!(format!("{runtime:?}").contains("<redacted>"));
        assert!(!format!("{runtime:?}").contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn manifest_contract_rejects_paths_and_unknown_fields() {
        let asset =
            MediaAsset::new("rendered-video.mp4", "mp4", 32, MediaKind::Video).expect("asset");
        let value = json!({
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "result": {
                "artifactId": ArtifactId::new().to_string(),
                "asset": asset,
                "sourceAssetId": AssetId::new(),
                "projectId": ProjectId::new(),
                "width": 1280,
                "height": 720,
                "fps": 30,
                "durationInFrames": 60,
                "outputPath": "C:\\private\\render.mp4"
            }
        });

        assert!(serde_json::from_value::<RenderManifest>(value).is_err());
    }

    #[test]
    fn slot_limiter_releases_capacity_on_drop() {
        let limiter = SlotLimiter::new(1);
        let permit = limiter.acquire().expect("first permit");
        assert!(limiter.acquire().is_none());
        drop(permit);
        assert!(limiter.acquire().is_some());
    }
}
