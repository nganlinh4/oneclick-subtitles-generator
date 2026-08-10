use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_application::ImportedMedia;
use osg_domain::{
    JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate, MediaAsset,
    media_kind_for_extension,
};
use osg_download::{
    AudioDownloadFormat, AudioQuality, BrowserCookieSource, CancellationToken, DownloadDestination,
    DownloadEngine, DownloadError, DownloadPhase, DownloadPlan, DownloadProgress, DownloadResult,
    DownloadSummary, FfmpegDirectory, InventoryId, InventoryRegistration, InventoryRegistry,
    JsRuntimeResolver, JsRuntimeSearch, MediaInventory, MediaSelection, ProgressSink, RunControl,
    SubtitleSelection, SubtitleSource, UrlPolicy, VideoHeight, VideoQuality, YtDlpSearch,
};
use osg_infrastructure::storage::{
    ArtifactKind, Database, publish_durable_media as publish_media_artifact,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use uuid::Uuid;

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::{DesktopSessionSnapshot, DesktopState, LocalMedia};

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const INSPECTION_TIMEOUT: Duration = Duration::from_mins(2);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_hours(6);
const MAX_CONCURRENT_INSPECTIONS: usize = 4;
const MAX_CONCURRENT_DOWNLOADS: usize = 4;
const MAX_SUBTITLE_IPC_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DownloadUnavailableReason {
    DownloaderUnavailable,
    DownloaderHealthCheckFailed,
    JavaScriptRuntimeUnavailable,
    MediaToolsUnavailable,
    CacheUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadStatusResponse {
    available: bool,
    inspect_available: bool,
    version: Option<String>,
    reason: Option<DownloadUnavailableReason>,
    max_concurrent_downloads: usize,
    inventory_ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadInspectionResponse {
    capability: InventoryRegistration,
    inventory: MediaInventory,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CookieSourceRequest {
    #[default]
    None,
    Chrome,
    Chromium,
    Edge,
    Firefox,
    Brave,
    Safari,
    Vivaldi,
    Opera,
    Whale,
}

impl From<CookieSourceRequest> for BrowserCookieSource {
    fn from(value: CookieSourceRequest) -> Self {
        match value {
            CookieSourceRequest::None => Self::None,
            CookieSourceRequest::Chrome => Self::Chrome,
            CookieSourceRequest::Chromium => Self::Chromium,
            CookieSourceRequest::Edge => Self::Edge,
            CookieSourceRequest::Firefox => Self::Firefox,
            CookieSourceRequest::Brave => Self::Brave,
            CookieSourceRequest::Safari => Self::Safari,
            CookieSourceRequest::Vivaldi => Self::Vivaldi,
            CookieSourceRequest::Opera => Self::Opera,
            CookieSourceRequest::Whale => Self::Whale,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadInspectRequest {
    url: String,
    #[serde(default)]
    cookie_source: CookieSourceRequest,
}

impl fmt::Debug for DownloadInspectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadInspectRequest")
            .field("url", &"<redacted>")
            .field("cookie_source", &self.cookie_source)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
enum VideoQualityRequest {
    Best,
    AtMost { height: u16 },
    Exact { format_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
enum AudioQualityRequest {
    Best,
    Exact { format_id: String },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AudioFormatRequest {
    Mp3,
    M4a,
    Flac,
    Wav,
}

impl From<AudioFormatRequest> for AudioDownloadFormat {
    fn from(value: AudioFormatRequest) -> Self {
        match value {
            AudioFormatRequest::Mp3 => Self::Mp3,
            AudioFormatRequest::M4a => Self::M4a,
            AudioFormatRequest::Flac => Self::Flac,
            AudioFormatRequest::Wav => Self::Wav,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum MediaSelectionRequest {
    Video {
        quality: VideoQualityRequest,
    },
    Audio {
        quality: AudioQualityRequest,
        format: AudioFormatRequest,
    },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SubtitleSourceRequest {
    Manual,
    Automatic,
}

impl From<SubtitleSourceRequest> for SubtitleSource {
    fn from(value: SubtitleSourceRequest) -> Self {
        match value {
            SubtitleSourceRequest::Manual => Self::Manual,
            SubtitleSourceRequest::Automatic => Self::Automatic,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubtitleSelectionRequest {
    language: String,
    source: SubtitleSourceRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadStartRequest {
    inventory_id: InventoryId,
    media: MediaSelectionRequest,
    subtitle: Option<SubtitleSelectionRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DownloadPhaseResponse {
    Downloading,
    DownloadFinished,
    PostProcessing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgressResponse {
    phase: DownloadPhaseResponse,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    eta_seconds: Option<u64>,
    fraction: Option<f64>,
}

impl From<&DownloadProgress> for DownloadProgressResponse {
    fn from(value: &DownloadProgress) -> Self {
        Self {
            phase: match value.phase {
                DownloadPhase::Downloading => DownloadPhaseResponse::Downloading,
                DownloadPhase::DownloadFinished => DownloadPhaseResponse::DownloadFinished,
                DownloadPhase::PostProcessing => DownloadPhaseResponse::PostProcessing,
            },
            downloaded_bytes: value.downloaded_bytes,
            total_bytes: value.total_bytes,
            bytes_per_second: value.bytes_per_second,
            eta_seconds: value.eta_seconds,
            fraction: value.fraction,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedSubtitleResponse {
    filename: String,
    language: String,
    content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedMediaResponse {
    asset: MediaAsset,
    playback: RegisteredMedia,
}

impl DownloadedMediaResponse {
    fn from_snapshot(snapshot: DesktopSessionSnapshot) -> CommandResult<Self> {
        let asset = snapshot
            .session
            .media
            .ok_or_else(|| CommandError::internal("The downloaded media was not imported."))?;
        let playback = snapshot
            .playback
            .ok_or_else(|| CommandError::internal("The downloaded media is unavailable."))?;
        if playback.byte_length != asset.size_bytes() {
            return Err(CommandError::internal(
                "The downloaded media metadata is inconsistent.",
            ));
        }
        Ok(Self { asset, playback })
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum DownloadJobEvent {
    Progress {
        job: JobSnapshot,
        progress: DownloadProgressResponse,
    },
    Completed {
        job: JobSnapshot,
        media: Box<DownloadedMediaResponse>,
        summary: DownloadSummary,
        subtitle: Option<DownloadedSubtitleResponse>,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

#[derive(Clone)]
struct DownloadCacheRoot(PathBuf);

impl DownloadCacheRoot {
    fn prepare(cache_directory: &Path) -> Option<Self> {
        let root = cache_directory.join("downloads").join("v1");
        fs::create_dir_all(&root).ok()?;
        let root = fs::canonicalize(root).ok()?;
        root.is_dir().then_some(Self(root))
    }

    fn destination(
        &self,
        output_id: Uuid,
        suggested_name: &str,
    ) -> Result<(DownloadDestination, OutputDirectory), DownloadError> {
        let directory = self.0.join(output_id.simple().to_string());
        fs::create_dir(&directory).map_err(|_| {
            DownloadError::InvalidDestination("output directory could not be created")
        })?;
        let destination = DownloadDestination::within_root(&directory, &self.0, suggested_name)
            .inspect_err(|_| {
                let _ = fs::remove_dir(&directory);
            })?;
        Ok((destination, OutputDirectory(directory)))
    }
}

impl fmt::Debug for DownloadCacheRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DownloadCacheRoot")
            .field(&"<redacted>")
            .finish()
    }
}

struct OutputDirectory(PathBuf);

impl OutputDirectory {
    fn remove_if_empty(&self) {
        let _ = fs::remove_dir(&self.0);
    }
}

impl fmt::Debug for OutputDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("OutputDirectory")
            .field(&"<redacted>")
            .finish()
    }
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

#[derive(Debug, Default)]
struct FinalizationRegistry {
    jobs: Mutex<HashSet<JobId>>,
}

impl FinalizationRegistry {
    fn begin(self: &Arc<Self>, job_id: JobId) -> CommandResult<FinalizationPermit> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| CommandError::internal("The download finalizer is unavailable."))?;
        if !jobs.insert(job_id) {
            return Err(CommandError::internal(
                "The media download is already being finalized.",
            ));
        }
        Ok(FinalizationPermit {
            registry: Arc::clone(self),
            job_id,
        })
    }

    fn run_if_cancellable<T>(
        &self,
        job_id: JobId,
        operation: impl FnOnce() -> CommandResult<T>,
    ) -> CommandResult<T> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| CommandError::internal("The download finalizer is unavailable."))?;
        if jobs.contains(&job_id) {
            return Err(CommandError::invalid_input(
                "The media download is already being finalized.",
            ));
        }
        let result = operation();
        drop(jobs);
        result
    }
}

struct FinalizationPermit {
    registry: Arc<FinalizationRegistry>,
    job_id: JobId,
}

impl Drop for FinalizationPermit {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.registry.jobs.lock() {
            jobs.remove(&self.job_id);
        }
    }
}

impl Drop for SlotPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct DownloadRuntime {
    engine: Option<DownloadEngine>,
    cache_root: Option<DownloadCacheRoot>,
    ffmpeg_available: bool,
    js_runtime_available: bool,
    inventories: InventoryRegistry,
    inspection_slots: Arc<SlotLimiter>,
    download_slots: Arc<SlotLimiter>,
    finalizing: Arc<FinalizationRegistry>,
}

impl DownloadRuntime {
    #[must_use]
    pub(crate) fn resolve(
        cache_directory: &Path,
        search: YtDlpSearch,
        js_search: JsRuntimeSearch,
        ffmpeg: Option<FfmpegDirectory>,
    ) -> Self {
        let ffmpeg_available = ffmpeg.is_some();
        let js_runtime = JsRuntimeResolver::new(js_search).resolve().ok();
        let js_runtime_available = js_runtime.is_some();
        let engine = DownloadEngine::resolve(search, UrlPolicy::SupportedSitesOnly)
            .ok()
            .map(|mut engine| {
                if let Some(ffmpeg) = ffmpeg {
                    engine = engine.with_ffmpeg(ffmpeg);
                }
                if let Some(js_runtime) = js_runtime {
                    engine = engine.with_js_runtime(js_runtime);
                }
                engine
            });
        Self {
            engine,
            cache_root: DownloadCacheRoot::prepare(cache_directory),
            ffmpeg_available,
            js_runtime_available,
            inventories: InventoryRegistry::new(),
            inspection_slots: SlotLimiter::new(MAX_CONCURRENT_INSPECTIONS),
            download_slots: SlotLimiter::new(MAX_CONCURRENT_DOWNLOADS),
            finalizing: Arc::new(FinalizationRegistry::default()),
        }
    }

    fn engine(&self) -> CommandResult<DownloadEngine> {
        if !self.js_runtime_available {
            return Err(CommandError::media_tools_unavailable());
        }
        self.engine
            .clone()
            .ok_or_else(CommandError::media_tools_unavailable)
    }

    fn download_parts(&self) -> CommandResult<(DownloadEngine, DownloadCacheRoot)> {
        if !self.ffmpeg_available {
            return Err(CommandError::media_tools_unavailable());
        }
        let engine = self.engine()?;
        let root = self
            .cache_root
            .clone()
            .ok_or_else(|| CommandError::internal("The native download cache is unavailable."))?;
        Ok((engine, root))
    }
}

impl fmt::Debug for DownloadRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadRuntime")
            .field("engine_available", &self.engine.is_some())
            .field("cache_available", &self.cache_root.is_some())
            .field("ffmpeg_available", &self.ffmpeg_available)
            .field("js_runtime_available", &self.js_runtime_available)
            .field("inventories", &self.inventories)
            .finish_non_exhaustive()
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn download_status(
    runtime: State<'_, DownloadRuntime>,
) -> CommandResult<DownloadStatusResponse> {
    let Some(engine) = runtime.engine.clone() else {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::DownloaderUnavailable),
        ));
    };
    if !runtime.js_runtime_available {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::JavaScriptRuntimeUnavailable),
        ));
    }
    let js_engine = engine.clone();
    let js_runtime_health = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(STATUS_TIMEOUT)?;
        js_engine.javascript_runtime_version(&control)
    })
    .await
    .map_err(|_| {
        CommandError::internal("The JavaScript runtime health task stopped unexpectedly.")
    })?;
    if js_runtime_health.is_err() {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::JavaScriptRuntimeUnavailable),
        ));
    }
    let version = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(STATUS_TIMEOUT)?;
        engine.version(&control)
    })
    .await
    .map_err(|_| CommandError::internal("The downloader health task stopped unexpectedly."))?;
    let Ok(version) = version else {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::DownloaderHealthCheckFailed),
        ));
    };
    let inspect_available = true;
    let (available, reason) = if !runtime.ffmpeg_available {
        (
            false,
            Some(DownloadUnavailableReason::MediaToolsUnavailable),
        )
    } else if runtime.cache_root.is_none() {
        (false, Some(DownloadUnavailableReason::CacheUnavailable))
    } else {
        (true, None)
    };
    Ok(status_response(
        available,
        inspect_available,
        Some(version.as_str().to_owned()),
        reason,
    ))
}

fn status_response(
    available: bool,
    inspect_available: bool,
    version: Option<String>,
    reason: Option<DownloadUnavailableReason>,
) -> DownloadStatusResponse {
    DownloadStatusResponse {
        available,
        inspect_available,
        version,
        reason,
        max_concurrent_downloads: MAX_CONCURRENT_DOWNLOADS,
        inventory_ttl_seconds: 15 * 60,
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn download_inspect(
    runtime: State<'_, DownloadRuntime>,
    request: DownloadInspectRequest,
) -> CommandResult<DownloadInspectionResponse> {
    let engine = runtime.engine()?;
    let _permit = runtime
        .inspection_slots
        .acquire()
        .ok_or_else(|| CommandError::internal("Too many media inspections are already running."))?;
    let cookies = BrowserCookieSource::from(request.cookie_source);
    let (url, inventory) = tauri::async_runtime::spawn_blocking(move || {
        let url = engine.validate_url(&request.url)?;
        let control = RunControl::new(INSPECTION_TIMEOUT)?;
        let inventory = engine.inspect(&url, cookies, &control)?;
        Ok::<_, DownloadError>((url, inventory))
    })
    .await
    .map_err(|_| CommandError::internal("The media inspection task stopped unexpectedly."))?
    .map_err(|error| map_download_error(&error))?;
    let capability = runtime
        .inventories
        .insert(url, inventory.clone(), cookies)
        .map_err(|error| map_download_error(&error))?;
    Ok(DownloadInspectionResponse {
        capability,
        inventory,
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle, State, and Channel as owned command extractors"
)]
pub(crate) async fn download_start(
    app: AppHandle,
    state: State<'_, DesktopState>,
    runtime: State<'_, DownloadRuntime>,
    request: DownloadStartRequest,
    on_event: Channel<DownloadJobEvent>,
) -> CommandResult<JobSnapshot> {
    let (engine, cache_root) = runtime.download_parts()?;
    let capability = runtime
        .inventories
        .resolve(request.inventory_id)
        .map_err(|error| map_download_error(&error))?;
    let output_id = Uuid::now_v7();
    let (destination, output_directory) = cache_root
        .destination(output_id, capability.inventory().title.as_str())
        .map_err(|error| map_download_error(&error))?;
    let plan = match create_plan(&capability, destination, request) {
        Ok(plan) => plan,
        Err(error) => {
            output_directory.remove_if_empty();
            return Err(map_download_error(&error));
        }
    };
    let permit = runtime.download_slots.acquire().ok_or_else(|| {
        output_directory.remove_if_empty();
        CommandError::internal("Too many media downloads are already running.")
    })?;
    let jobs = Arc::clone(&state.jobs);
    let ticket = match background::register_running(&jobs, JobKind::DownloadMedia).await {
        Ok(ticket) => ticket,
        Err(error) => {
            output_directory.remove_if_empty();
            return Err(error);
        }
    };
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let job_cancellation = ticket.cancellation().clone();
    let finalizing = Arc::clone(&runtime.finalizing);

    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let process_cancellation = CancellationToken::default();
        let cancellation_bridge = process_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            cancellation_bridge.cancel();
        });
        let reporter = DownloadProgressReporter {
            jobs: Arc::clone(&jobs),
            job_id,
            channel: on_event.clone(),
        };
        let control = match RunControl::new(DOWNLOAD_TIMEOUT) {
            Ok(control) => control
                .with_cancellation(process_cancellation)
                .with_progress(reporter),
            Err(error) => {
                watcher.abort();
                output_directory.remove_if_empty();
                finish_download(
                    &app,
                    &jobs,
                    job_id,
                    Err(DownloadTaskError::Download(error)),
                    &on_event,
                    &finalizing,
                )
                .await;
                return;
            }
        };
        let result = tauri::async_runtime::spawn_blocking(move || {
            engine
                .download(&plan, &control)
                .and_then(|result| NativeDownloadOutput::from_result(&result))
                .map_err(DownloadTaskError::Download)
        })
        .await
        .map_err(|_| {
            DownloadTaskError::Command(CommandError::internal(
                "The media download task stopped unexpectedly.",
            ))
        })
        .and_then(|result| result);
        watcher.abort();
        if result.is_err() {
            output_directory.remove_if_empty();
        }
        finish_download(&app, &jobs, job_id, result, &on_event, &finalizing).await;
    });

    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn download_cancel(
    state: State<'_, DesktopState>,
    runtime: State<'_, DownloadRuntime>,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    let finalizing = Arc::clone(&runtime.finalizing);
    tauri::async_runtime::spawn_blocking(move || {
        finalizing.run_if_cancellable(job_id, || {
            let current = jobs.get(job_id)?;
            if current.snapshot().kind() != JobKind::DownloadMedia {
                return Err(CommandError::invalid_input(
                    "The job is not a media download.",
                ));
            }
            if current.snapshot().state().is_terminal() {
                return Ok(current.snapshot().clone());
            }
            jobs.apply(job_id, JobUpdate::RequestCancellation)
                .map(|ticket| ticket.snapshot().clone())
                .map_err(Into::into)
        })
    })
    .await
    .map_err(|_| CommandError::internal("The download cancellation task stopped unexpectedly."))?
}

fn create_plan(
    capability: &osg_download::InventoryCapability,
    destination: DownloadDestination,
    request: DownloadStartRequest,
) -> Result<DownloadPlan, DownloadError> {
    let inventory = capability.inventory();
    let media = match request.media {
        MediaSelectionRequest::Video { quality } => MediaSelection::Video {
            quality: match quality {
                VideoQualityRequest::Best => VideoQuality::Best,
                VideoQualityRequest::AtMost { height } => {
                    VideoQuality::AtMost(VideoHeight::new(height)?)
                }
                VideoQualityRequest::Exact { format_id } => {
                    VideoQuality::Exact(inventory.select_format(&format_id)?)
                }
            },
        },
        MediaSelectionRequest::Audio { quality, format } => MediaSelection::Audio {
            quality: match quality {
                AudioQualityRequest::Best => AudioQuality::Best,
                AudioQualityRequest::Exact { format_id } => {
                    AudioQuality::Exact(inventory.select_format(&format_id)?)
                }
            },
            format: format.into(),
        },
    };
    let subtitle = request
        .subtitle
        .map_or(Ok(SubtitleSelection::None), |selection| {
            inventory
                .select_subtitle(&selection.language, selection.source.into())
                .map(SubtitleSelection::Selected)
        })?;
    DownloadPlan::new(
        capability.url().clone(),
        inventory,
        destination,
        media,
        subtitle,
        capability.cookies(),
    )
}

struct DownloadProgressReporter {
    jobs: background::DesktopJobs,
    job_id: JobId,
    channel: Channel<DownloadJobEvent>,
}

impl ProgressSink for DownloadProgressReporter {
    fn on_progress(&self, progress: &DownloadProgress) {
        let Ok(current) = self.jobs.get(self.job_id) else {
            return;
        };
        if current.snapshot().state().is_terminal() {
            return;
        }
        let snapshot = progress_for_job(progress)
            .filter(|candidate| {
                current.snapshot().state() == JobState::Running
                    && *candidate > current.snapshot().progress()
            })
            .and_then(|candidate| {
                self.jobs
                    .apply(self.job_id, JobUpdate::ReportProgress(candidate))
                    .ok()
            })
            .map_or_else(
                || current.snapshot().clone(),
                |ticket| ticket.snapshot().clone(),
            );
        let _ = self.channel.send(DownloadJobEvent::Progress {
            job: snapshot,
            progress: DownloadProgressResponse::from(progress),
        });
    }
}

fn progress_for_job(progress: &DownloadProgress) -> Option<JobProgress> {
    if matches!(
        progress.phase,
        DownloadPhase::DownloadFinished | DownloadPhase::PostProcessing
    ) {
        return JobProgress::from_basis_points(9_900).ok();
    }
    let (downloaded, total) = progress.downloaded_bytes.zip(progress.total_bytes)?;
    JobProgress::from_units(downloaded.min(total), total).ok()
}

enum DownloadTaskError {
    Download(DownloadError),
    Command(CommandError),
}

struct NativeDownloadOutput {
    summary: DownloadSummary,
    media_path: PathBuf,
    subtitle_path: Option<PathBuf>,
    subtitle: Option<DownloadedSubtitleResponse>,
}

impl NativeDownloadOutput {
    fn from_result(result: &DownloadResult) -> Result<Self, DownloadError> {
        let summary = result.summary().clone();
        let subtitle_path = result.subtitle_path().map(Path::to_owned);
        let subtitle = match read_downloaded_subtitle(
            subtitle_path.as_deref(),
            summary.subtitle_filename.as_ref(),
            summary.subtitle_language.as_ref(),
        ) {
            Ok(subtitle) => subtitle,
            Err(error) => {
                remove_regular_file(result.media_path());
                if let Some(path) = result.subtitle_path() {
                    remove_regular_file(path);
                }
                if let Some(directory) = result.media_path().parent() {
                    let _ = fs::remove_dir(directory);
                }
                return Err(error);
            }
        };
        Ok(Self {
            summary,
            media_path: result.media_path().to_owned(),
            subtitle_path,
            subtitle,
        })
    }

    fn cleanup(&self) {
        remove_regular_file(&self.media_path);
        if let Some(path) = &self.subtitle_path {
            remove_regular_file(path);
        }
        if let Some(directory) = self.media_path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

struct DurableMedia {
    asset: MediaAsset,
    path: PathBuf,
}

impl fmt::Debug for DurableMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableMedia")
            .field("asset", &self.asset)
            .field("path", &"<redacted>")
            .finish()
    }
}

fn publish_durable_media(
    database: &Database,
    job_id: JobId,
    source_path: &Path,
    size_bytes: u64,
    media_filename: &str,
) -> CommandResult<DurableMedia> {
    let kind = ArtifactKind::new("downloadedMedia").map_err(|_| durable_storage_error())?;
    let asset = downloaded_media_asset(media_filename, size_bytes)?;
    let published = publish_media_artifact(
        database,
        job_id,
        kind,
        asset,
        source_path,
        serde_json::json!({
            "source": "urlDownload",
            "filename": media_filename,
        }),
    )
    .map_err(|_| durable_storage_error())?;
    Ok(DurableMedia {
        asset: published.asset().clone(),
        path: published.path().to_owned(),
    })
}

fn durable_storage_error() -> CommandError {
    CommandError::internal("The downloaded media could not be stored durably.")
}

fn downloaded_media_asset(filename: &str, size_bytes: u64) -> CommandResult<MediaAsset> {
    let filename_path = Path::new(filename);
    if filename_path.file_name().and_then(|value| value.to_str()) != Some(filename) {
        return Err(durable_storage_error());
    }
    let extension = filename_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(durable_storage_error)?;
    let kind = media_kind_for_extension(&extension).ok_or_else(durable_storage_error)?;
    MediaAsset::new(filename, extension, size_bytes, kind).map_err(|_| durable_storage_error())
}

struct PreparedDownloadedMedia {
    media: ImportedMedia,
    playback: RegisteredMedia,
    local_media: LocalMedia,
}

impl fmt::Debug for PreparedDownloadedMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedDownloadedMedia")
            .field("asset", self.media.asset())
            .field("playback", &self.playback)
            .field("local_media", &self.local_media)
            .finish()
    }
}

fn prepare_durable_download(
    database: &Database,
    media_server: &MediaServer,
    path: &Path,
    asset: MediaAsset,
) -> CommandResult<PreparedDownloadedMedia> {
    let media =
        ImportedMedia::from_native_asset(asset, path).map_err(|_| durable_storage_error())?;
    database
        .remember_media(media.asset(), media.canonical_path())
        .map_err(|_| durable_storage_error())?;
    let playback = media_server
        .register_with_extension(media.canonical_path(), media.asset().extension())
        .map_err(|_| durable_storage_error())?;
    let local_media = LocalMedia::new(
        media.asset().id(),
        media.canonical_path().to_owned(),
        media.asset().kind(),
        media.asset().extension(),
    );
    Ok(PreparedDownloadedMedia {
        media,
        playback,
        local_media,
    })
}

async fn activate_durable_download(
    state: &DesktopState,
    durable: DurableMedia,
) -> CommandResult<DesktopSessionSnapshot> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_durable_download(&database, &media_server, &durable.path, durable.asset)
    })
    .await
    .map_err(|_| {
        CommandError::internal("the downloaded media import task stopped unexpectedly")
    })??;

    let Ok(mut editor) = state.editor.write() else {
        let _ = state.media_server.unregister(prepared.playback.id);
        return Err(CommandError::internal("the editing session is unavailable"));
    };
    let previous = editor.playback.replace(prepared.playback);
    editor.local_media = Some(prepared.local_media);
    editor.session.set_media(prepared.media);
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous {
        let _ = state.media_server.unregister(previous.id);
    }
    Ok(snapshot)
}

fn read_downloaded_subtitle(
    path: Option<&Path>,
    filename: Option<&String>,
    language: Option<&String>,
) -> Result<Option<DownloadedSubtitleResponse>, DownloadError> {
    match (path, filename, language) {
        (Some(path), Some(filename), Some(language)) => {
            let metadata =
                fs::symlink_metadata(path).map_err(|_| DownloadError::InvalidSubtitleArtifact)?;
            if !metadata.file_type().is_file() || metadata.len() == 0 {
                return Err(DownloadError::InvalidSubtitleArtifact);
            }
            if metadata.len() > MAX_SUBTITLE_IPC_BYTES {
                return Err(DownloadError::SubtitleArtifactTooLarge);
            }
            let content =
                fs::read_to_string(path).map_err(|_| DownloadError::InvalidSubtitleArtifact)?;
            Ok(Some(DownloadedSubtitleResponse {
                filename: filename.clone(),
                language: language.clone(),
                content,
            }))
        }
        (None, None, None) => Ok(None),
        _ => Err(DownloadError::InvalidSubtitleArtifact),
    }
}

impl fmt::Debug for NativeDownloadOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeDownloadOutput")
            .field("summary", &self.summary)
            .field("media_path", &"<redacted>")
            .field(
                "subtitle_path",
                &self.subtitle_path.as_ref().map(|_| "<redacted>"),
            )
            .field("subtitle", &self.subtitle)
            .finish()
    }
}

async fn finish_download(
    app: &AppHandle,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    result: Result<NativeDownloadOutput, DownloadTaskError>,
    channel: &Channel<DownloadJobEvent>,
    finalizing: &Arc<FinalizationRegistry>,
) {
    match result {
        Ok(output) => {
            let _finalization = match finalizing.begin(job_id) {
                Ok(finalization) => finalization,
                Err(error) => {
                    output.cleanup();
                    fail_download(jobs, job_id, error, channel).await;
                    return;
                }
            };
            if background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling)
            {
                output.cleanup();
                cancel_download(jobs, job_id, channel).await;
                return;
            }
            let state = app.state::<DesktopState>();
            let database = state.database.clone();
            let source_path = output.media_path.clone();
            let size_bytes = output.summary.media_bytes;
            let media_filename = output.summary.media_filename.clone();
            let durable = tauri::async_runtime::spawn_blocking(move || {
                publish_durable_media(&database, job_id, &source_path, size_bytes, &media_filename)
            })
            .await
            .map_err(|_| durable_storage_error())
            .and_then(|result| result);
            let durable = match durable {
                Ok(durable) => durable,
                Err(error) => {
                    output.cleanup();
                    fail_download(jobs, job_id, error, channel).await;
                    return;
                }
            };
            match activate_durable_download(&state, durable).await {
                Ok(snapshot) => match DownloadedMediaResponse::from_snapshot(snapshot) {
                    Ok(media) => {
                        output.cleanup();
                        match background::apply(jobs, job_id, JobUpdate::Succeed).await {
                            Ok(job) => {
                                let _ = channel.send(DownloadJobEvent::Completed {
                                    job,
                                    media: Box::new(media),
                                    summary: output.summary,
                                    subtitle: output.subtitle,
                                });
                            }
                            Err(error) => {
                                let job = background::snapshot(jobs, job_id).await;
                                let _ = channel.send(DownloadJobEvent::Failed { job, error });
                            }
                        }
                    }
                    Err(error) => {
                        output.cleanup();
                        fail_download(jobs, job_id, error, channel).await;
                    }
                },
                Err(error) => {
                    output.cleanup();
                    fail_download(jobs, job_id, error, channel).await;
                }
            }
        }
        Err(DownloadTaskError::Download(DownloadError::Cancelled)) => {
            cancel_download(jobs, job_id, channel).await;
        }
        Err(DownloadTaskError::Download(error)) => {
            let cancelled = background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling);
            if cancelled {
                cancel_download(jobs, job_id, channel).await;
            } else {
                fail_download(jobs, job_id, map_download_error(&error), channel).await;
            }
        }
        Err(DownloadTaskError::Command(error)) => {
            fail_download(jobs, job_id, error, channel).await;
        }
    }
}

fn remove_regular_file(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file()) {
        let _ = fs::remove_file(path);
    }
}

async fn cancel_download(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    channel: &Channel<DownloadJobEvent>,
) {
    match background::finish_cancellation(jobs, job_id).await {
        Ok(job) => {
            let _ = channel.send(DownloadJobEvent::Cancelled { job });
        }
        Err(error) => {
            let job = background::snapshot(jobs, job_id).await;
            let _ = channel.send(DownloadJobEvent::Failed { job, error });
        }
    }
}

async fn fail_download(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    error: CommandError,
    channel: &Channel<DownloadJobEvent>,
) {
    let job = background::finish_failure(jobs, job_id).await;
    let _ = channel.send(DownloadJobEvent::Failed { job, error });
}

fn map_download_error(error: &DownloadError) -> CommandError {
    match error {
        DownloadError::InvalidUrl(_)
        | DownloadError::UnsupportedSite
        | DownloadError::NonPublicAddress
        | DownloadError::ResolutionFailed => CommandError::invalid_input(
            "The media URL is invalid, unsupported, or does not resolve publicly.",
        ),
        DownloadError::InvalidOption(_)
        | DownloadError::FormatMismatch
        | DownloadError::SubtitleMismatch => {
            CommandError::invalid_input("The selected media format is invalid.")
        }
        DownloadError::InventoryNotFound | DownloadError::InventoryExpired => {
            CommandError::invalid_input("The media inspection expired. Inspect the URL again.")
        }
        DownloadError::InventoryRegistryFull => {
            CommandError::invalid_input("Too many inspected media items are active.")
        }
        DownloadError::BinaryNotFound
        | DownloadError::InvalidBinary(_)
        | DownloadError::JavaScriptRuntimeNotFound
        | DownloadError::InvalidJavaScriptRuntime(_)
        | DownloadError::FfmpegRequired => CommandError::media_tools_unavailable(),
        DownloadError::Cancelled => CommandError::internal("The media download was cancelled."),
        DownloadError::InvalidDestination(_)
        | DownloadError::Spawn(_)
        | DownloadError::ProcessIo(_)
        | DownloadError::ProcessFailed { .. }
        | DownloadError::TimedOut { .. }
        | DownloadError::OutputLimit
        | DownloadError::InventoryJson(_)
        | DownloadError::InvalidInventory(_)
        | DownloadError::InventoryRegistryUnavailable
        | DownloadError::OutputExists
        | DownloadError::MissingArtifact
        | DownloadError::InvalidSubtitleArtifact
        | DownloadError::SubtitleArtifactTooLarge
        | DownloadError::Publish(_) => {
            CommandError::internal("The native media download could not be completed.")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use osg_domain::{JobId, JobKind, JobSnapshot};
    use osg_infrastructure::storage::Database;
    use osg_media_server::MediaServer;
    use uuid::Uuid;

    use super::{
        DownloadError, DownloadInspectRequest, DownloadRuntime, FinalizationRegistry,
        MAX_SUBTITLE_IPC_BYTES, SlotLimiter, prepare_durable_download, publish_durable_media,
        read_downloaded_subtitle, remove_regular_file, status_response,
    };

    #[test]
    fn request_deserialization_rejects_unknown_fields_and_non_v7_capabilities() {
        assert!(
            serde_json::from_str::<DownloadInspectRequest>(
                r#"{"url":"https://youtube.com/watch?v=x","rawArgs":["--exec"]}"#
            )
            .is_err()
        );
        let legacy = Uuid::new_v4();
        let request = format!(
            r#"{{"inventoryId":"{legacy}","media":{{"kind":"video","quality":{{"mode":"best"}}}},"subtitle":null}}"#
        );
        assert!(serde_json::from_str::<super::DownloadStartRequest>(&request).is_err());
        let inventory_id = Uuid::now_v7();
        let path_request = format!(
            r#"{{"inventoryId":"{inventory_id}","media":{{"kind":"video","quality":{{"mode":"best"}},"outputPath":"C:\\private"}},"subtitle":null}}"#
        );
        assert!(serde_json::from_str::<super::DownloadStartRequest>(&path_request).is_err());
    }

    #[test]
    fn inspect_request_debug_redacts_the_url() {
        let request: DownloadInspectRequest = serde_json::from_str(
            r#"{"url":"https://youtube.com/watch?v=private-token","cookieSource":"chrome"}"#,
        )
        .expect("inspect request");
        let debug = format!("{request:?}");
        assert!(!debug.contains("youtube"));
        assert!(!debug.contains("private-token"));
        assert!(debug.contains("Chrome"));
    }

    #[test]
    fn slot_limit_is_atomic_and_reusable() {
        let limiter = SlotLimiter::new(2);
        let first = limiter.acquire().expect("first permit");
        let second = limiter.acquire().expect("second permit");
        assert!(limiter.acquire().is_none());
        drop(first);
        assert!(limiter.acquire().is_some());
        drop(second);
        assert!(Arc::strong_count(&limiter) >= 1);
    }

    #[test]
    fn unavailable_status_is_path_free() {
        let response = status_response(
            false,
            false,
            None,
            Some(super::DownloadUnavailableReason::DownloaderUnavailable),
        );
        let json = serde_json::to_string(&response).expect("serialize status");
        assert!(!json.to_ascii_lowercase().contains("path"));
        assert!(!json.contains("3031"));
        assert!(!format!("{:?}", std::mem::size_of::<DownloadRuntime>()).contains("Users"));
    }

    #[test]
    fn subtitle_reader_rejects_oversized_files_before_reading_them() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let subtitle = directory.path().join("track.srt");
        let file = fs::File::create(&subtitle).expect("subtitle file");
        file.set_len(MAX_SUBTITLE_IPC_BYTES + 1)
            .expect("sparse oversized file");

        assert!(matches!(
            read_downloaded_subtitle(
                Some(&subtitle),
                Some(&"track.srt".to_owned()),
                Some(&"en".to_owned())
            ),
            Err(DownloadError::SubtitleArtifactTooLarge)
        ));
    }

    #[test]
    fn cleanup_removes_only_regular_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let regular = directory.path().join("media.mp4");
        fs::write(&regular, b"media").expect("write regular file");
        remove_regular_file(&regular);
        assert!(!regular.exists());

        let nested = directory.path().join("not-a-file");
        fs::create_dir(&nested).expect("nested directory");
        remove_regular_file(&nested);
        assert!(nested.is_dir());
    }

    #[test]
    fn durable_publication_survives_source_and_cache_removal() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open_with_artifact_root(
            directory.path().join("db/osg.sqlite3"),
            directory.path().join("artifacts"),
        )
        .expect("database");
        let source = directory.path().join("download.mp4");
        let bytes = vec![0x5a; 128 * 1024];
        fs::write(&source, &bytes).expect("downloaded source");

        let job_id = JobId::new();
        database
            .create_job(&JobSnapshot::with_id(job_id, JobKind::DownloadMedia))
            .expect("durable job");
        let durable = publish_durable_media(
            &database,
            job_id,
            &source,
            u64::try_from(bytes.len()).unwrap(),
            "download.mp4",
        )
        .expect("durable media");
        fs::remove_file(&source).expect("remove source cache file");
        database
            .clear_cache_with_info(None)
            .expect("clear cache entries");

        assert_eq!(fs::read(&durable.path).expect("durable bytes"), bytes);
        assert_eq!(database.cache_info().expect("cache info").total_count, 0);
    }

    #[test]
    fn extensionless_durable_download_reopens_from_trusted_media_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open_with_artifact_root(
            directory.path().join("db/osg.sqlite3"),
            directory.path().join("artifacts"),
        )
        .expect("database");
        let source = directory.path().join("download.mp4");
        let bytes = vec![0x5a; 64 * 1024];
        fs::write(&source, &bytes).expect("downloaded source");
        let job_id = JobId::new();
        database
            .create_job(&JobSnapshot::with_id(job_id, JobKind::DownloadMedia))
            .expect("durable job");
        let durable = publish_durable_media(
            &database,
            job_id,
            &source,
            u64::try_from(bytes.len()).expect("fixture size"),
            "download.mp4",
        )
        .expect("durable media");
        assert!(durable.path.extension().is_none());

        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let prepared = prepare_durable_download(
            &database,
            &media_server,
            &durable.path,
            durable.asset.clone(),
        )
        .expect("trusted durable import");
        let asset = prepared.media.asset();
        assert_eq!(asset.display_name(), "download.mp4");
        assert_eq!(asset.extension(), "mp4");
        assert_eq!(prepared.playback.mime_type, "video/mp4");
        assert_eq!(prepared.playback.byte_length, asset.size_bytes());
        assert_eq!(prepared.local_media.mime_type(), Some("video/mp4"));
        assert_eq!(
            database
                .resolve_media(asset.id())
                .expect("resolve remembered media")
                .expect("remembered media")
                .path(),
            durable.path.as_path()
        );
        assert!(!format!("{prepared:?}").contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn finalization_blocks_late_cancellation_until_the_terminal_update() {
        let registry = Arc::new(FinalizationRegistry::default());
        let job_id = JobId::new();
        let finalization = registry.begin(job_id).expect("begin finalization");
        let invoked = AtomicBool::new(false);
        assert!(
            registry
                .run_if_cancellable(job_id, || {
                    invoked.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .is_err()
        );
        assert!(!invoked.load(Ordering::SeqCst));

        drop(finalization);
        registry
            .run_if_cancellable(job_id, || {
                invoked.store(true, Ordering::SeqCst);
                Ok(())
            })
            .expect("cancellable after finalization");
        assert!(invoked.load(Ordering::SeqCst));
    }
}
