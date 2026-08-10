use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_domain::{
    AssetId, JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate, MediaAsset,
    media_kind_for_extension,
};
use osg_infrastructure::storage::{ArtifactKind, Database, publish_durable_media};
use osg_media::{
    AudioBitrate, AudioOutput, AudioSampleRate, CancellationToken, ChannelCount,
    CompatibilityDecision, ConversionAction, FfmpegProgress, IssueKind, MediaError, MediaInput,
    MediaTimeRange, ProgressSink, RunControl, WaveformPyramid,
};
use osg_media_pipeline::{
    MediaInspection, MediaPipeline, PipelineError, PreparationOutcome, PreparedMedia,
    WaveformOutcome,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{State, ipc::Channel};

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const INSPECTION_TIMEOUT: Duration = Duration::from_secs(30);
const OPERATION_TIMEOUT: Duration = Duration::from_hours(24);
const MAX_OPERATION_TIME_US: u64 = 7 * 24 * 60 * 60 * 1_000_000;
const MAX_WAVEFORM_POINTS: usize = 1_000_000;
const MAX_CONCURRENT_OPERATIONS: usize = 2;
const MAX_PIPELINE_PLAYBACKS: usize = 64;
const PROCESSING_START_BASIS_POINTS: u16 = 500;
const PROCESSING_END_BASIS_POINTS: u16 = 9_500;
const PUBLISHING_BASIS_POINTS: u16 = 9_700;

#[derive(Clone)]
pub(crate) struct MediaPipelineRuntime {
    pipeline: Option<MediaPipeline>,
    media_server: MediaServer,
    slots: Arc<SlotLimiter>,
    jobs: Arc<RuntimeJobs>,
    playbacks: Arc<Mutex<PlaybackRegistry>>,
}

impl MediaPipelineRuntime {
    pub(crate) fn new(
        engine: Option<osg_media::MediaEngine>,
        staging_root: impl AsRef<Path>,
        media_server: MediaServer,
    ) -> Result<Self, PipelineError> {
        let pipeline = engine
            .map(|engine| MediaPipeline::with_staging_root(engine, staging_root))
            .transpose()?;
        Ok(Self {
            pipeline,
            media_server,
            slots: SlotLimiter::new(MAX_CONCURRENT_OPERATIONS),
            jobs: Arc::new(RuntimeJobs::default()),
            playbacks: Arc::new(Mutex::new(PlaybackRegistry::default())),
        })
    }

    fn pipeline(&self) -> CommandResult<MediaPipeline> {
        self.pipeline
            .clone()
            .ok_or_else(CommandError::media_tools_unavailable)
    }

    fn register_playback(&self, asset: &MediaAsset, path: &Path) -> CommandResult<RegisteredMedia> {
        let mut playbacks = self
            .playbacks
            .lock()
            .map_err(|_| CommandError::internal("The media playback registry is unavailable."))?;
        if let Some(existing) = playbacks.by_asset.get(&asset.id()) {
            return Ok(existing.clone());
        }
        while playbacks.by_asset.len() >= MAX_PIPELINE_PLAYBACKS {
            let Some(oldest) = playbacks.order.pop_front() else {
                return Err(CommandError::internal(
                    "The media playback registry is inconsistent.",
                ));
            };
            if let Some(previous) = playbacks.by_asset.remove(&oldest) {
                let _ = self.media_server.unregister(previous.id);
            }
        }
        let registered = self
            .media_server
            .register_with_extension(path, asset.extension())?;
        playbacks.order.push_back(asset.id());
        playbacks.by_asset.insert(asset.id(), registered.clone());
        Ok(registered)
    }
}

impl fmt::Debug for MediaPipelineRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaPipelineRuntime")
            .field("available", &self.pipeline.is_some())
            .field("slots", &self.slots)
            .field("jobs", &self.jobs)
            .field("media_server", &self.media_server)
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

#[derive(Debug, Default)]
struct RuntimeJobs {
    state: Mutex<RuntimeJobState>,
}

#[derive(Debug, Default)]
struct RuntimeJobState {
    owned: HashSet<JobId>,
    finalizing: HashSet<JobId>,
}

impl RuntimeJobs {
    fn remember(&self, job_id: JobId) -> CommandResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("The media job registry is unavailable."))?;
        if !state.owned.insert(job_id) {
            return Err(CommandError::internal(
                "The media job was registered more than once.",
            ));
        }
        Ok(())
    }

    fn begin_finalization(self: &Arc<Self>, job_id: JobId) -> CommandResult<FinalizationPermit> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("The media job registry is unavailable."))?;
        if !state.owned.contains(&job_id) || !state.finalizing.insert(job_id) {
            return Err(CommandError::internal(
                "The media operation cannot enter finalization.",
            ));
        }
        Ok(FinalizationPermit {
            jobs: Arc::clone(self),
            job_id,
        })
    }

    fn run_if_cancellable<T>(
        &self,
        job_id: JobId,
        operation: impl FnOnce() -> CommandResult<T>,
    ) -> CommandResult<T> {
        let state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("The media job registry is unavailable."))?;
        if !state.owned.contains(&job_id) {
            return Err(CommandError::invalid_input(
                "The job is not owned by the native media pipeline.",
            ));
        }
        if state.finalizing.contains(&job_id) {
            return Err(CommandError::invalid_input(
                "The media operation is already being finalized.",
            ));
        }
        let result = operation();
        drop(state);
        result
    }
}

struct FinalizationPermit {
    jobs: Arc<RuntimeJobs>,
    job_id: JobId,
}

impl Drop for FinalizationPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.jobs.state.lock() {
            state.finalizing.remove(&self.job_id);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaPipelineOperation {
    PreparePlayback,
    AnalysisClip,
    ExtractAudio,
    GenerateWaveform,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AudioFormatRequest {
    Wav,
    Mp3,
    Flac,
}

impl AudioFormatRequest {
    fn output(self) -> Result<AudioOutput, MediaError> {
        Ok(match self {
            Self::Wav => AudioOutput::WavPcm16 {
                sample_rate: AudioSampleRate::new(48_000)?,
                channels: ChannelCount::new(2)?,
            },
            Self::Mp3 => AudioOutput::Mp3 {
                bitrate: AudioBitrate::new(192)?,
            },
            Self::Flac => AudioOutput::Flac {
                sample_rate: AudioSampleRate::new(48_000)?,
                channels: ChannelCount::new(2)?,
            },
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MediaPipelineRequest {
    PreparePlayback {
        asset_id: AssetId,
    },
    AnalysisClip {
        asset_id: AssetId,
        start_us: u64,
        end_us: u64,
    },
    ExtractAudio {
        asset_id: AssetId,
        format: AudioFormatRequest,
        start_us: u64,
        end_us: Option<u64>,
    },
    GenerateWaveform {
        asset_id: AssetId,
        points_per_second: u32,
        max_points: usize,
        start_us: u64,
        end_us: Option<u64>,
    },
}

impl MediaPipelineRequest {
    fn validate(self) -> CommandResult<ValidatedRequest> {
        match self {
            Self::PreparePlayback { asset_id } => Ok(ValidatedRequest {
                asset_id,
                operation: ValidatedOperation::PreparePlayback,
            }),
            Self::AnalysisClip {
                asset_id,
                start_us,
                end_us,
            } => Ok(ValidatedRequest {
                asset_id,
                operation: ValidatedOperation::AnalysisClip {
                    range: bounded_range(start_us, Some(end_us), true)?,
                },
            }),
            Self::ExtractAudio {
                asset_id,
                format,
                start_us,
                end_us,
            } => Ok(ValidatedRequest {
                asset_id,
                operation: ValidatedOperation::ExtractAudio {
                    format: format.output()?,
                    range: bounded_range(start_us, end_us, false)?,
                },
            }),
            Self::GenerateWaveform {
                asset_id,
                points_per_second,
                max_points,
                start_us,
                end_us,
            } => {
                if !(1..=400).contains(&points_per_second)
                    || !(1_000..=MAX_WAVEFORM_POINTS).contains(&max_points)
                {
                    return Err(CommandError::invalid_input(
                        "The waveform resolution is outside the supported range.",
                    ));
                }
                Ok(ValidatedRequest {
                    asset_id,
                    operation: ValidatedOperation::GenerateWaveform {
                        points_per_second,
                        max_points,
                        range: bounded_range(start_us, end_us, false)?,
                    },
                })
            }
        }
    }
}

#[derive(Clone, Debug)]
struct ValidatedRequest {
    asset_id: AssetId,
    operation: ValidatedOperation,
}

#[derive(Clone, Debug)]
enum ValidatedOperation {
    PreparePlayback,
    AnalysisClip {
        range: MediaTimeRange,
    },
    ExtractAudio {
        format: AudioOutput,
        range: MediaTimeRange,
    },
    GenerateWaveform {
        points_per_second: u32,
        max_points: usize,
        range: MediaTimeRange,
    },
}

impl ValidatedOperation {
    const fn wire_operation(&self) -> MediaPipelineOperation {
        match self {
            Self::PreparePlayback => MediaPipelineOperation::PreparePlayback,
            Self::AnalysisClip { .. } => MediaPipelineOperation::AnalysisClip,
            Self::ExtractAudio { .. } => MediaPipelineOperation::ExtractAudio,
            Self::GenerateWaveform { .. } => MediaPipelineOperation::GenerateWaveform,
        }
    }

    const fn job_kind(&self) -> JobKind {
        match self {
            Self::GenerateWaveform { .. } => JobKind::GenerateWaveform,
            Self::PreparePlayback | Self::AnalysisClip { .. } | Self::ExtractAudio { .. } => {
                JobKind::RenderVideo
            }
        }
    }

    fn publication_metadata(&self, source_asset_id: AssetId) -> serde_json::Value {
        match self {
            Self::PreparePlayback => json!({
                "operation": "preparePlayback",
                "sourceAssetId": source_asset_id,
            }),
            Self::AnalysisClip { range } => json!({
                "operation": "analysisClip",
                "sourceAssetId": source_asset_id,
                "startUs": range.start_us,
                "endUs": range.duration_us.map(|duration| range.start_us + duration),
            }),
            Self::ExtractAudio { format, range } => json!({
                "operation": "extractAudio",
                "sourceAssetId": source_asset_id,
                "format": audio_output_name(*format),
                "startUs": range.start_us,
                "endUs": range.duration_us.map(|duration| range.start_us + duration),
            }),
            Self::GenerateWaveform {
                points_per_second,
                max_points,
                range,
            } => json!({
                "operation": "generateWaveform",
                "sourceAssetId": source_asset_id,
                "pointsPerSecond": points_per_second,
                "maxPoints": max_points,
                "startUs": range.start_us,
                "endUs": range.duration_us.map(|duration| range.start_us + duration),
            }),
        }
    }
}

const fn audio_output_name(format: AudioOutput) -> &'static str {
    match format {
        AudioOutput::WavPcm16 { .. } => "wav",
        AudioOutput::M4aAac { .. } => "m4a",
        AudioOutput::Mp3 { .. } => "mp3",
        AudioOutput::Flac { .. } => "flac",
    }
}

fn bounded_range(
    start_us: u64,
    end_us: Option<u64>,
    end_required: bool,
) -> CommandResult<MediaTimeRange> {
    if start_us > MAX_OPERATION_TIME_US
        || end_us.is_some_and(|end| end > MAX_OPERATION_TIME_US || end <= start_us)
        || (end_required && end_us.is_none())
        || (end_us.is_none() && start_us != 0)
    {
        return Err(CommandError::invalid_input(
            "The media time range is invalid or too large.",
        ));
    }
    let duration_us = end_us.map(|end| end - start_us);
    MediaTimeRange::new(start_us, duration_us).map_err(Into::into)
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaPipelinePhase {
    Probing,
    Processing,
    Publishing,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum MediaPipelineEvent {
    Progress {
        job: JobSnapshot,
        operation: MediaPipelineOperation,
        phase: MediaPipelinePhase,
        fraction: Option<f64>,
    },
    Completed {
        job: JobSnapshot,
        operation: MediaPipelineOperation,
        result: Box<MediaPipelineResult>,
    },
    Cancelled {
        job: JobSnapshot,
        operation: MediaPipelineOperation,
    },
    Failed {
        job: Option<JobSnapshot>,
        operation: MediaPipelineOperation,
        error: CommandError,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum MediaPipelineResult {
    Media {
        media: Box<MediaDescriptor>,
        inspection: Box<MediaInspectionResponse>,
    },
    Waveform {
        asset_id: AssetId,
        waveform: Box<WaveformPyramid>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaDescriptor {
    asset: MediaAsset,
    playback: RegisteredMedia,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum CompatibilityActionResponse {
    Direct,
    Remux,
    TranscodeAudio,
    TranscodeVideo,
    TranscodeAll,
    Reject,
}

impl From<ConversionAction> for CompatibilityActionResponse {
    fn from(value: ConversionAction) -> Self {
        match value {
            ConversionAction::Direct => Self::Direct,
            ConversionAction::Remux => Self::Remux,
            ConversionAction::TranscodeAudio => Self::TranscodeAudio,
            ConversionAction::TranscodeVideo => Self::TranscodeVideo,
            ConversionAction::TranscodeAll => Self::TranscodeAll,
            ConversionAction::Reject => Self::Reject,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum CompatibilityIssueResponse {
    NoPlayableStream,
    UnsupportedContainer,
    UnsupportedVideoCodec,
    UnsupportedAudioCodec,
    ProblematicAudioProfile,
    UnsupportedPixelFormat,
    AudioPrecedesVideo,
    MissingDuration,
    LegacyHevcAssumption,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaInspectionResponse {
    asset_id: AssetId,
    duration_us: Option<u64>,
    has_video: bool,
    has_audio: bool,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    frame_rate: Option<f64>,
    compatibility_action: CompatibilityActionResponse,
    issues: Vec<CompatibilityIssueResponse>,
}

impl MediaInspectionResponse {
    fn from_inspection(asset_id: AssetId, inspection: &MediaInspection) -> Self {
        let video = inspection.metadata.primary_video();
        let audio = inspection.metadata.primary_audio();
        let video_details = video.and_then(|stream| stream.video.as_ref());
        Self {
            asset_id,
            duration_us: inspection.metadata.duration_us(),
            has_video: video.is_some(),
            has_audio: audio.is_some(),
            video_codec: video.and_then(|stream| stream.codec.clone()),
            audio_codec: audio.and_then(|stream| stream.codec.clone()),
            width: video_details.map(|details| details.width),
            height: video_details.map(|details| details.height),
            frame_rate: video_details
                .and_then(|details| details.frame_rate.map(osg_media::FrameRate::as_f64)),
            compatibility_action: inspection.compatibility.action.into(),
            issues: inspection
                .compatibility
                .issues
                .iter()
                .map(|issue| issue_code(&issue.issue))
                .collect(),
        }
    }
}

const fn issue_code(issue: &IssueKind) -> CompatibilityIssueResponse {
    match issue {
        IssueKind::NoPlayableStream => CompatibilityIssueResponse::NoPlayableStream,
        IssueKind::UnsupportedContainer { .. } => CompatibilityIssueResponse::UnsupportedContainer,
        IssueKind::UnsupportedVideoCodec { .. } => {
            CompatibilityIssueResponse::UnsupportedVideoCodec
        }
        IssueKind::UnsupportedAudioCodec { .. } => {
            CompatibilityIssueResponse::UnsupportedAudioCodec
        }
        IssueKind::ProblematicAudioProfile { .. } => {
            CompatibilityIssueResponse::ProblematicAudioProfile
        }
        IssueKind::UnsupportedPixelFormat { .. } => {
            CompatibilityIssueResponse::UnsupportedPixelFormat
        }
        IssueKind::AudioPrecedesVideo => CompatibilityIssueResponse::AudioPrecedesVideo,
        IssueKind::MissingDuration => CompatibilityIssueResponse::MissingDuration,
        IssueKind::LegacyHevcAssumption => CompatibilityIssueResponse::LegacyHevcAssumption,
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn media_pipeline_inspect(
    state: State<'_, DesktopState>,
    runtime: State<'_, MediaPipelineRuntime>,
    asset_id: AssetId,
) -> CommandResult<MediaInspectionResponse> {
    let pipeline = runtime.pipeline()?;
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = database
            .resolve_media(asset_id)?
            .ok_or_else(CommandError::media_unavailable)?;
        let input = MediaInput::from_native_selection(resolved.path())?;
        let control = RunControl::new(INSPECTION_TIMEOUT)?;
        let inspection = pipeline.inspect(&input, &control)?;
        Ok(MediaInspectionResponse::from_inspection(
            asset_id,
            &inspection,
        ))
    })
    .await
    .map_err(|_| CommandError::internal("The media inspection task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn media_pipeline_start(
    state: State<'_, DesktopState>,
    runtime: State<'_, MediaPipelineRuntime>,
    request: MediaPipelineRequest,
    on_event: Channel<MediaPipelineEvent>,
) -> CommandResult<JobSnapshot> {
    let request = request.validate()?;
    let operation = request.operation.wire_operation();
    let pipeline = runtime.pipeline()?;
    let permit = runtime.slots.acquire().ok_or_else(|| {
        CommandError::invalid_input("Too many native media operations are already running.")
    })?;
    let database = state.database.clone();
    let resolved = tauri::async_runtime::spawn_blocking({
        let database = database.clone();
        let asset_id = request.asset_id;
        move || {
            database
                .resolve_media(asset_id)?
                .ok_or_else(CommandError::media_unavailable)
        }
    })
    .await
    .map_err(|_| CommandError::internal("The media lookup task stopped unexpectedly."))??;
    let input = MediaInput::from_native_selection(resolved.path())?;
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, request.operation.job_kind()).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    if let Err(error) = runtime.jobs.remember(job_id) {
        let _ = background::apply(&jobs, job_id, JobUpdate::Fail).await;
        return Err(error);
    }
    let cancellation = ticket.cancellation().clone();
    let runtime = runtime.inner().clone();

    let _ = on_event.send(MediaPipelineEvent::Progress {
        job: initial.clone(),
        operation,
        phase: MediaPipelinePhase::Probing,
        fraction: None,
    });
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let process_cancellation = CancellationToken::default();
        let cancellation_bridge = process_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation.cancelled().await;
            cancellation_bridge.cancel();
        });
        let progress = progress_sink(Arc::clone(&jobs), job_id, operation, on_event.clone());
        let control = match RunControl::new(OPERATION_TIMEOUT) {
            Ok(control) => control
                .with_cancellation(process_cancellation)
                .with_progress(progress),
            Err(error) => {
                watcher.abort();
                fail_operation(&jobs, job_id, operation, error.into(), &on_event).await;
                return;
            }
        };
        let source_asset_id = request.asset_id;
        let publication_metadata = request.operation.publication_metadata(source_asset_id);
        let requested_operation = request.operation;
        let native_result = tauri::async_runtime::spawn_blocking(move || {
            execute_operation(&pipeline, input, &requested_operation, &control)
        })
        .await
        .map_err(|_| CommandError::internal("The native media operation stopped unexpectedly."))
        .and_then(|result| result.map_err(Into::into));
        watcher.abort();
        finish_operation(
            &runtime,
            &database,
            &jobs,
            job_id,
            operation,
            source_asset_id,
            resolved,
            publication_metadata,
            native_result,
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
pub(crate) async fn media_pipeline_cancel(
    state: State<'_, DesktopState>,
    runtime: State<'_, MediaPipelineRuntime>,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    let runtime_jobs = Arc::clone(&runtime.jobs);
    tauri::async_runtime::spawn_blocking(move || {
        runtime_jobs.run_if_cancellable(job_id, || {
            let current = jobs.get(job_id)?;
            if current.snapshot().state().is_terminal() {
                return Ok(current.snapshot().clone());
            }
            jobs.apply(job_id, JobUpdate::RequestCancellation)
                .map(|ticket| ticket.snapshot().clone())
                .map_err(Into::into)
        })
    })
    .await
    .map_err(|_| CommandError::internal("The media cancellation task stopped unexpectedly."))?
}

enum NativeOperationResult {
    Direct(MediaInspection),
    Prepared(PreparedMedia),
    Waveform(WaveformOutcome),
}

struct PublicationContext {
    job_id: JobId,
    operation: MediaPipelineOperation,
    source_asset_id: AssetId,
    metadata: serde_json::Value,
}

fn execute_operation(
    pipeline: &MediaPipeline,
    input: MediaInput,
    operation: &ValidatedOperation,
    control: &RunControl,
) -> Result<NativeOperationResult, PipelineError> {
    match operation {
        ValidatedOperation::PreparePlayback => {
            pipeline
                .prepare_playback(input, control)
                .map(|outcome| match outcome {
                    PreparationOutcome::Direct(inspection) => {
                        NativeOperationResult::Direct(inspection)
                    }
                    PreparationOutcome::Prepared(prepared) => {
                        NativeOperationResult::Prepared(prepared)
                    }
                })
        }
        ValidatedOperation::AnalysisClip { range } => pipeline
            .clip_for_analysis(input, *range, control)
            .map(NativeOperationResult::Prepared),
        ValidatedOperation::ExtractAudio { format, range } => pipeline
            .extract_audio(input, *format, *range, control)
            .map(NativeOperationResult::Prepared),
        ValidatedOperation::GenerateWaveform {
            points_per_second,
            max_points,
            range,
        } => pipeline
            .generate_waveform(input, *points_per_second, *max_points, *range, control)
            .map(NativeOperationResult::Waveform),
    }
}

fn progress_sink(
    jobs: background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    channel: Channel<MediaPipelineEvent>,
) -> ProgressSink {
    ProgressSink::new(move |progress| {
        report_processing_progress(&jobs, job_id, operation, &channel, &progress);
    })
}

fn report_processing_progress(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    channel: &Channel<MediaPipelineEvent>,
    progress: &FfmpegProgress,
) {
    let Ok(current) = jobs.get(job_id) else {
        return;
    };
    if current.snapshot().state() != JobState::Running {
        return;
    }
    let fraction = progress
        .fraction
        .filter(|fraction| fraction.is_finite())
        .map(|fraction| fraction.clamp(0.0, 1.0));
    let snapshot = fraction
        .and_then(processing_job_progress)
        .filter(|candidate| *candidate > current.snapshot().progress())
        .and_then(|candidate| {
            jobs.apply(job_id, JobUpdate::ReportProgress(candidate))
                .ok()
        })
        .map_or_else(
            || current.snapshot().clone(),
            |ticket| ticket.snapshot().clone(),
        );
    let _ = channel.send(MediaPipelineEvent::Progress {
        job: snapshot,
        operation,
        phase: MediaPipelinePhase::Processing,
        fraction,
    });
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the finite fraction is clamped to 0..=1 before conversion"
)]
fn processing_job_progress(fraction: f64) -> Option<JobProgress> {
    let processing_span = PROCESSING_END_BASIS_POINTS - PROCESSING_START_BASIS_POINTS;
    let scaled = (fraction * f64::from(processing_span)).round() as u16;
    JobProgress::from_basis_points(PROCESSING_START_BASIS_POINTS + scaled).ok()
}

#[allow(clippy::too_many_arguments)]
async fn finish_operation(
    runtime: &MediaPipelineRuntime,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    source_asset_id: AssetId,
    source: osg_infrastructure::storage::ResolvedMedia,
    publication_metadata: serde_json::Value,
    result: CommandResult<NativeOperationResult>,
    channel: &Channel<MediaPipelineEvent>,
) {
    let native = match result {
        Ok(native) => native,
        Err(error) => {
            if background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling)
            {
                cancel_operation(jobs, job_id, operation, channel).await;
            } else {
                fail_operation(jobs, job_id, operation, error, channel).await;
            }
            return;
        }
    };
    let _finalization = match runtime.jobs.begin_finalization(job_id) {
        Ok(finalization) => finalization,
        Err(error) => {
            fail_operation(jobs, job_id, operation, error, channel).await;
            return;
        }
    };
    if background::snapshot(jobs, job_id)
        .await
        .is_some_and(|job| job.state() == JobState::Cancelling)
    {
        cancel_operation(jobs, job_id, operation, channel).await;
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
            fail_operation(jobs, job_id, operation, error, channel).await;
            return;
        }
    };
    let _ = channel.send(MediaPipelineEvent::Progress {
        job: publishing,
        operation,
        phase: MediaPipelinePhase::Publishing,
        fraction: None,
    });
    let runtime = runtime.clone();
    let database = database.clone();
    let context = PublicationContext {
        job_id,
        operation,
        source_asset_id,
        metadata: publication_metadata,
    };
    let finalized = tauri::async_runtime::spawn_blocking(move || {
        finalize_native_result(&runtime, &database, context, &source, native)
    })
    .await
    .map_err(|_| CommandError::internal("The media publication task stopped unexpectedly."))
    .and_then(|result| result);
    match finalized {
        Ok(result) => match background::apply(jobs, job_id, JobUpdate::Succeed).await {
            Ok(job) => {
                let _ = channel.send(MediaPipelineEvent::Completed {
                    job,
                    operation,
                    result: Box::new(result),
                });
            }
            Err(error) => {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(MediaPipelineEvent::Failed {
                    job,
                    operation,
                    error,
                });
            }
        },
        Err(error) => fail_operation(jobs, job_id, operation, error, channel).await,
    }
}

fn finalize_native_result(
    runtime: &MediaPipelineRuntime,
    database: &Database,
    context: PublicationContext,
    source: &osg_infrastructure::storage::ResolvedMedia,
    native: NativeOperationResult,
) -> CommandResult<MediaPipelineResult> {
    let PublicationContext {
        job_id,
        operation,
        source_asset_id,
        metadata,
    } = context;
    match native {
        NativeOperationResult::Direct(inspection) => {
            let asset = source.asset().clone();
            let playback = runtime.register_playback(&asset, source.path())?;
            Ok(MediaPipelineResult::Media {
                inspection: Box::new(MediaInspectionResponse::from_inspection(
                    asset.id(),
                    &inspection,
                )),
                media: Box::new(MediaDescriptor { asset, playback }),
            })
        }
        NativeOperationResult::Prepared(prepared) => {
            let extension = prepared.extension();
            let kind = media_kind_for_extension(extension).ok_or_else(|| {
                CommandError::internal("The prepared media extension is unsupported.")
            })?;
            let display_name = prepared_display_name(operation, extension);
            let size_bytes = prepared.report().output_bytes;
            let asset = MediaAsset::new(display_name, extension, size_bytes, kind)
                .map_err(|_| CommandError::internal("The prepared media metadata is invalid."))?;
            if matches!(
                operation,
                MediaPipelineOperation::AnalysisClip | MediaPipelineOperation::ExtractAudio
            ) && asset.id() == source_asset_id
            {
                return Err(CommandError::internal(
                    "The derived media did not receive a fresh identity.",
                ));
            }
            let artifact_kind = ArtifactKind::new(artifact_kind(operation))?;
            let published = publish_durable_media(
                database,
                job_id,
                artifact_kind,
                asset,
                prepared.path(),
                metadata,
            )?;
            let playback = runtime.register_playback(published.asset(), published.path())?;
            let inspection = MediaInspection {
                metadata: prepared.metadata().clone(),
                compatibility: CompatibilityDecision::analyze(
                    prepared.metadata(),
                    osg_media::CompatibilityProfile::PortableWebView,
                ),
            };
            Ok(MediaPipelineResult::Media {
                inspection: Box::new(MediaInspectionResponse::from_inspection(
                    published.asset().id(),
                    &inspection,
                )),
                media: Box::new(MediaDescriptor {
                    asset: published.asset().clone(),
                    playback,
                }),
            })
        }
        NativeOperationResult::Waveform(outcome) => Ok(MediaPipelineResult::Waveform {
            asset_id: source_asset_id,
            waveform: Box::new(outcome.waveform),
        }),
    }
}

fn prepared_display_name(operation: MediaPipelineOperation, extension: &str) -> String {
    let stem = match operation {
        MediaPipelineOperation::PreparePlayback => "prepared-media",
        MediaPipelineOperation::AnalysisClip => "analysis-clip",
        MediaPipelineOperation::ExtractAudio => "extracted-audio",
        MediaPipelineOperation::GenerateWaveform => "waveform",
    };
    format!("{stem}.{extension}")
}

const fn artifact_kind(operation: MediaPipelineOperation) -> &'static str {
    match operation {
        MediaPipelineOperation::PreparePlayback => "preparedMedia",
        MediaPipelineOperation::AnalysisClip => "analysisClip",
        MediaPipelineOperation::ExtractAudio => "extractedAudio",
        MediaPipelineOperation::GenerateWaveform => "waveform",
    }
}

async fn cancel_operation(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    channel: &Channel<MediaPipelineEvent>,
) {
    match background::finish_cancellation(jobs, job_id).await {
        Ok(job) => {
            let _ = channel.send(MediaPipelineEvent::Cancelled { job, operation });
        }
        Err(error) => {
            let job = background::snapshot(jobs, job_id).await;
            let _ = channel.send(MediaPipelineEvent::Failed {
                job,
                operation,
                error,
            });
        }
    }
}

async fn fail_operation(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    error: CommandError,
    channel: &Channel<MediaPipelineEvent>,
) {
    let job = background::finish_failure(jobs, job_id).await;
    let _ = channel.send(MediaPipelineEvent::Failed {
        job,
        operation,
        error,
    });
}

#[cfg(test)]
mod tests {
    use osg_domain::{AssetId, JobId};
    use serde_json::json;

    use super::{
        MAX_OPERATION_TIME_US, MediaPipelineRequest, RuntimeJobs, ValidatedOperation,
        processing_job_progress,
    };

    #[test]
    fn wire_requests_reject_paths_unknown_fields_and_unbounded_ranges() {
        let asset_id = AssetId::new();
        let valid: MediaPipelineRequest = serde_json::from_value(json!({
            "operation": "analysisClip",
            "assetId": asset_id,
            "startUs": 1_000_000,
            "endUs": 2_000_000,
        }))
        .expect("valid request");
        assert!(matches!(
            valid.validate().expect("validated").operation,
            ValidatedOperation::AnalysisClip { .. }
        ));
        assert!(
            serde_json::from_value::<MediaPipelineRequest>(json!({
                "operation": "analysisClip",
                "assetId": asset_id,
                "startUs": 0,
                "endUs": 1,
                "outputPath": "C:\\private\\clip.mp4",
            }))
            .is_err()
        );
        let too_long: MediaPipelineRequest = serde_json::from_value(json!({
            "operation": "analysisClip",
            "assetId": asset_id,
            "startUs": 0,
            "endUs": MAX_OPERATION_TIME_US + 1,
        }))
        .expect("wire shape");
        assert!(too_long.validate().is_err());
    }

    #[test]
    fn full_range_requires_zero_start_and_clip_requires_an_end() {
        let asset_id = AssetId::new();
        let extract: MediaPipelineRequest = serde_json::from_value(json!({
            "operation": "extractAudio",
            "assetId": asset_id,
            "format": "wav",
            "startUs": 1,
            "endUs": null,
        }))
        .expect("wire shape");
        assert!(extract.validate().is_err());
        assert!(
            serde_json::from_value::<MediaPipelineRequest>(json!({
                "operation": "analysisClip",
                "assetId": asset_id,
                "startUs": 0,
                "endUs": null,
            }))
            .is_err()
        );
    }

    #[test]
    fn processing_progress_is_bounded_and_monotonic() {
        let zero = processing_job_progress(0.0).expect("zero");
        let half = processing_job_progress(0.5).expect("half");
        let complete = processing_job_progress(1.0).expect("complete");
        assert!(zero < half && half < complete);
        assert_eq!(zero.basis_points(), 500);
        assert_eq!(complete.basis_points(), 9_500);
    }

    #[test]
    fn finalization_excludes_cancellation_until_the_permit_drops() {
        let jobs = std::sync::Arc::new(RuntimeJobs::default());
        let job_id = JobId::new();
        jobs.remember(job_id).expect("remember");
        let permit = jobs.begin_finalization(job_id).expect("begin finalization");
        assert!(jobs.run_if_cancellable(job_id, || Ok(())).is_err());
        drop(permit);
        assert!(jobs.run_if_cancellable(job_id, || Ok(())).is_ok());
        assert!(jobs.run_if_cancellable(JobId::new(), || Ok(())).is_err());
    }
}
