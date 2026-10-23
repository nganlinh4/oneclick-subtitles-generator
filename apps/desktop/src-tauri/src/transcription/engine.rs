//! Starts a native word-level transcription job for one owned media asset.

mod credentials;
mod executor;
mod run_loop;
mod store;

use std::sync::Arc;
use std::time::Duration;

use osg_domain::{AssetId, JobKind, JobSnapshot, ProjectId, TranscriptRevisionId};
use osg_gemini::AudioTranscriptionConfig;
use osg_infrastructure::secrets::CredentialId;
use osg_infrastructure::storage::{TranscriptRevisionRecord, TranscriptRevisionState};
use osg_media::{MediaInput as NativeMediaInput, RunControl};
use osg_media_pipeline::MediaPipeline;
use serde::Deserialize;
use tauri::State;
use tauri::ipc::Channel;

use self::executor::GeminiWindowExecutor;
use self::run_loop::{EngineRun, run_engine_loop};
use super::concurrency::ConcurrencyPlan;
use super::events::WordNativeTranscriptionEvent;
use super::planner::{WindowRange, plan_live_windows, plan_windows};
use super::worker::WorkerPool;
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::{DesktopState, LocalMedia};

const MEDIA_INSPECTION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WordNativeTranscriptionConfig {
    pub(crate) model: Option<TranscriptionModel>,
    pub(crate) credential_id: Option<CredentialId>,
    pub(crate) language_hints: Option<Vec<String>>,
    pub(crate) diarization: Option<bool>,
    pub(crate) window_duration_secs: Option<u32>,
    pub(crate) window_duration_ms: Option<u64>,
    pub(crate) range_start_ms: Option<i64>,
    pub(crate) range_end_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Default, PartialEq, Eq)]
pub(crate) enum TranscriptionModel {
    #[default]
    #[serde(rename = "gemini-3.5-transcribe")]
    Transcribe,
    #[serde(rename = "gemini-3.5-transcribe-live")]
    Live,
}

impl TranscriptionModel {
    /// The wire and stored model name; matches the serde names above.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Transcribe => "gemini-3.5-transcribe",
            Self::Live => "gemini-3.5-transcribe-live",
        }
    }
}

/// The `WebView` names media only by its owned asset ID. Unknown fields, including a native
/// `filePath`, are refused rather than ignored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartWordNativeTranscriptionRequest {
    pub(crate) project_id: ProjectId,
    pub(crate) expected_project_state_version: Option<u64>,
    pub(crate) media_asset_id: AssetId,
    pub(crate) config: Option<WordNativeTranscriptionConfig>,
    pub(crate) credential_id: Option<CredentialId>,
    pub(crate) language_hints: Option<Vec<String>>,
    pub(crate) diarization: Option<bool>,
    pub(crate) window_duration_secs: Option<u32>,
    pub(crate) window_duration_ms: Option<u64>,
    pub(crate) range_start_ms: Option<i64>,
    pub(crate) range_end_ms: Option<i64>,
}

impl StartWordNativeTranscriptionRequest {
    #[must_use]
    pub(crate) fn model(&self) -> TranscriptionModel {
        self.config
            .as_ref()
            .and_then(|config| config.model)
            .unwrap_or_default()
    }

    #[must_use]
    pub(crate) fn credential_id(&self) -> Option<CredentialId> {
        self.credential_id
            .or_else(|| self.config.as_ref().and_then(|c| c.credential_id))
    }

    #[must_use]
    pub(crate) fn language_hints(&self) -> Vec<String> {
        self.language_hints
            .clone()
            .or_else(|| self.config.as_ref().and_then(|c| c.language_hints.clone()))
            .unwrap_or_default()
    }

    #[must_use]
    pub(crate) fn diarization(&self) -> bool {
        self.diarization
            .or_else(|| self.config.as_ref().and_then(|c| c.diarization))
            .unwrap_or(false)
    }

    #[must_use]
    pub(crate) fn window_duration_ms(&self) -> Option<u64> {
        self.window_duration_ms
            .or_else(|| self.window_duration_secs.map(|s| u64::from(s) * 1_000))
            .or_else(|| {
                self.config.as_ref().and_then(|c| {
                    c.window_duration_ms
                        .or_else(|| c.window_duration_secs.map(|s| u64::from(s) * 1_000))
                })
            })
    }

    #[must_use]
    pub(crate) fn range_start_ms(&self) -> Option<i64> {
        self.range_start_ms
            .or_else(|| self.config.as_ref().and_then(|c| c.range_start_ms))
    }

    #[must_use]
    pub(crate) fn range_end_ms(&self) -> Option<i64> {
        self.range_end_ms
            .or_else(|| self.config.as_ref().and_then(|c| c.range_end_ms))
    }
}

pub(crate) async fn start_transcription_engine(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    request: StartWordNativeTranscriptionRequest,
    on_event: Channel<WordNativeTranscriptionEvent>,
) -> CommandResult<JobSnapshot> {
    let local_media = resolve_transcription_media(state, media_blobs, &request).await?;
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let pipeline = MediaPipeline::new(media_engine);
    let native_input = NativeMediaInput::from_native_selection(local_media.path())?;

    // ffprobe can take up to the inspection timeout; keep it off the async runtime.
    let inspection = {
        let pipeline = pipeline.clone();
        let input = native_input.clone();
        background::run_blocking("media inspection", move || {
            let control = RunControl::new(MEDIA_INSPECTION_TIMEOUT)?;
            pipeline
                .inspect(&input, &control)
                .map_err(CommandError::from)
        })
        .await?
    };
    if inspection.metadata.primary_audio().is_none() {
        return Err(CommandError::invalid_input(
            "the selected media has no audio track",
        ));
    }

    let duration_us = inspection.metadata.duration_us().unwrap_or(0);
    let media_duration_ms = (duration_us / 1_000).cast_signed();
    let range_start_ms = request.range_start_ms().unwrap_or(0).max(0);
    let range_end_ms = request
        .range_end_ms()
        .unwrap_or(media_duration_ms)
        .min(media_duration_ms);
    if range_end_ms <= range_start_ms {
        return Err(CommandError::invalid_input(format!(
            "invalid transcription range: start ({range_start_ms}ms) must be less than end ({range_end_ms}ms)"
        )));
    }

    // Live receives bounded prefix context at every internal boundary so server VAD can finish a
    // sentence that began in the preceding owned range.
    let model = request.model();
    let windows = if model == TranscriptionModel::Live {
        plan_live_windows(range_start_ms, range_end_ms, request.window_duration_ms())
    } else {
        plan_windows(range_start_ms, range_end_ms, request.window_duration_ms())
    }
    .map_err(|e| CommandError::invalid_input(e.to_string()))?;

    let secrets = credentials::ready_gemini_secrets(state, request.credential_id()).await?;
    let concurrency = ConcurrencyPlan::for_host(windows.len(), secrets.len());
    let clients = credentials::gemini_clients(secrets, concurrency.sessions_per_credential)?;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::Transcribe).await?;
    let initial_snapshot = ticket.snapshot().clone();

    let revision = initial_revision(&request, model, range_start_ms, range_end_ms, &windows);
    let revision_id = revision.id;
    let database = state.database.clone();
    if let Err(error) = background::run_blocking("transcript revision insert", move || {
        database.transcript_insert_revision(&revision)
    })
    .await
    {
        let _ = background::finish_failure(&jobs, initial_snapshot.id()).await;
        return Err(error);
    }

    let mut asr_config = AudioTranscriptionConfig::new();
    if request.diarization() {
        asr_config = asr_config.with_diarization(true);
    }
    let language_hints = request.language_hints();
    if !language_hints.is_empty() {
        asr_config = asr_config.with_language_hints(language_hints);
    }

    let run = EngineRun {
        jobs,
        store: Arc::new(state.database.clone()),
        executor: Arc::new(GeminiWindowExecutor {
            clients,
            pipeline: Arc::new(pipeline),
            input: Arc::new(native_input),
            config: Arc::new(asr_config),
            live: model == TranscriptionModel::Live,
            extraction: WorkerPool::new(concurrency.extraction_slots),
        }),
        job_id: initial_snapshot.id(),
        revision_id,
        windows,
        provider_sessions: concurrency.provider_sessions,
        cancellation: ticket.cancellation().clone(),
        events: on_event,
    };
    tauri::async_runtime::spawn(run_engine_loop(run));
    Ok(initial_snapshot)
}

fn initial_revision(
    request: &StartWordNativeTranscriptionRequest,
    model: TranscriptionModel,
    range_start_ms: i64,
    range_end_ms: i64,
    windows: &[WindowRange],
) -> TranscriptRevisionRecord {
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(0);
    let metadata_json = serde_json::json!({
        "model": model.as_str(),
        "plannedWindows": windows.iter().map(|w| serde_json::json!({
            "index": w.index,
            "startMs": w.start_ms,
            "endMs": w.end_ms,
        })).collect::<Vec<_>>(),
        "totalWindows": windows.len(),
        "windowDurationMs": request.window_duration_ms(),
    })
    .to_string();
    TranscriptRevisionRecord {
        id: TranscriptRevisionId::new(),
        project_id: request.project_id,
        media_id: Some(request.media_asset_id),
        provider: "gemini".to_owned(),
        model: model.as_str().to_owned(),
        source_range_start_ms: range_start_ms,
        source_range_end_ms: range_end_ms,
        state: TranscriptRevisionState::InProgress,
        fingerprint: format!("{}_{}_{}", request.project_id, range_start_ms, range_end_ms),
        word_count: 0,
        metadata_json,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    }
}

/// Resolves the owned media asset: the import blob cache first, then the project database.
async fn resolve_transcription_media(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    request: &StartWordNativeTranscriptionRequest,
) -> CommandResult<LocalMedia> {
    let asset_id = request.media_asset_id;
    if let Some(media) = media_blobs.resolve(asset_id)? {
        return Ok(media);
    }
    let database = state.database.clone();
    let expected_version = request.expected_project_state_version;
    let project_id = request.project_id;
    background::run_blocking("media resolution", move || {
        let resolved = match expected_version {
            Some(version) => {
                database.resolve_project_media_revision(project_id, version, asset_id)?
            }
            None => database.resolve_media(asset_id)?,
        }
        .ok_or_else(CommandError::media_unavailable)?;
        Ok::<_, CommandError>(LocalMedia::new(
            resolved.asset().id(),
            resolved.path().to_owned(),
            resolved.asset().kind(),
            resolved.asset().extension(),
        ))
    })
    .await
}

#[cfg(test)]
mod tests;
