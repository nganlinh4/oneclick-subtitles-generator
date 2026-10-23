mod run_loop;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use osg_domain::{AssetId, JobKind, JobSnapshot, ProjectId, TranscriptRevisionId};
use osg_gemini::{ApiKey, AudioTranscriptionConfig};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose, CredentialState};
use osg_infrastructure::storage::TranscriptRevisionRecord;
use osg_media::{MediaInput as NativeMediaInput, RunControl};
use osg_media_pipeline::MediaPipeline;
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;

use self::run_loop::run_engine_loop;
use super::events::WordNativeTranscriptionEvent;
use super::planner::{plan_live_windows, plan_windows};
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::{DesktopState, LocalMedia};

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WordNativeTranscriptionConfig {
    pub(crate) model: Option<TranscriptionModel>,
    pub(crate) credential_id: Option<CredentialId>,
    pub(crate) language_hints: Option<Vec<String>>,
    pub(crate) diarization: Option<bool>,
    pub(crate) window_duration_secs: Option<u32>,
    pub(crate) window_duration_ms: Option<u64>,
    pub(crate) range_start_ms: Option<i64>,
    pub(crate) range_end_ms: Option<i64>,
    #[allow(dead_code)]
    pub(crate) prompt_preset: Option<String>,
    #[allow(dead_code)]
    pub(crate) grouping_policy: Option<Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Default, PartialEq, Eq)]
pub(crate) enum TranscriptionModel {
    #[default]
    #[serde(rename = "gemini-3.5-transcribe")]
    Transcribe,
    #[serde(rename = "gemini-3.5-transcribe-live")]
    Live,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartWordNativeTranscriptionRequest {
    pub(crate) project_id: ProjectId,
    pub(crate) expected_project_state_version: Option<u64>,
    pub(crate) media_asset_id: Option<AssetId>,
    pub(crate) file_path: Option<PathBuf>,
    pub(crate) config: Option<WordNativeTranscriptionConfig>,
    pub(crate) credential_id: Option<CredentialId>,
    pub(crate) language_hints: Option<Vec<String>>,
    pub(crate) diarization: Option<bool>,
    pub(crate) window_duration_secs: Option<u32>,
    pub(crate) window_duration_ms: Option<u64>,
    pub(crate) range_start_ms: Option<i64>,
    pub(crate) range_end_ms: Option<i64>,
    #[allow(dead_code)]
    pub(crate) prompt_preset: Option<String>,
    #[allow(dead_code)]
    pub(crate) grouping_policy: Option<Value>,
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

#[allow(clippy::too_many_lines)]
pub(crate) async fn start_transcription_engine(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    request: StartWordNativeTranscriptionRequest,
    on_event: Channel<WordNativeTranscriptionEvent>,
) -> CommandResult<JobSnapshot> {
    // 1. Resolve media: either from media_asset_id or file_path
    let local_media = resolve_transcription_media(state, media_blobs, &request).await?;

    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let pipeline = MediaPipeline::new(media_engine);

    // 2. Resolve native media input capability
    let native_input = NativeMediaInput::from_native_selection(local_media.path())
        .map_err(|e| CommandError::invalid_input(e.to_string()))?;

    // 3. Inspect media duration
    let inspect_control = RunControl::new(Duration::from_secs(30))
        .map_err(|e| CommandError::internal(e.to_string()))?;
    let inspection = pipeline
        .inspect(&native_input, &inspect_control)
        .map_err(|e| CommandError::internal(format!("media inspection failed: {e}")))?;

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

    // 4. Plan windows. Live receives bounded prefix context at every internal boundary so server
    // VAD can finish a sentence that began in the preceding owned range.
    let transcription_model = request.model();
    let windows = if transcription_model == TranscriptionModel::Live {
        plan_live_windows(range_start_ms, range_end_ms, request.window_duration_ms())
    } else {
        plan_windows(range_start_ms, range_end_ms, request.window_duration_ms())
    }
    .map_err(|e| CommandError::invalid_input(e.to_string()))?;
    let total_windows = windows.len();

    // 5. Resolve Gemini API credential
    let credentials = state.credentials.clone();
    let request_credential_id = request.credential_id();
    let secrets = tauri::async_runtime::spawn_blocking(move || {
        let report = credentials
            .status(Some(CredentialPurpose::GeminiApiKey))
            .map_err(|e| CommandError::internal(e.to_string()))?;
        let mut ready_ids = report
            .credentials
            .into_iter()
            .filter(|credential| credential.state == CredentialState::Ready)
            .map(|credential| credential.id)
            .collect::<Vec<_>>();
        if let Some(preferred) = request_credential_id {
            ready_ids.retain(|id| *id != preferred);
            ready_ids.insert(0, preferred);
        }
        if ready_ids.is_empty() {
            return Err(CommandError::invalid_input(
                "No ready Gemini API key found. Please configure an API key in Settings.",
            ));
        }

        let mut secrets = Vec::with_capacity(ready_ids.len());
        for (index, id) in ready_ids.into_iter().enumerate() {
            match credentials.resolve(id, CredentialPurpose::GeminiApiKey) {
                Ok(secret) => secrets.push(secret),
                Err(error) if index == 0 => {
                    return Err(CommandError::internal(error.to_string()));
                }
                Err(_) => {}
            }
        }
        if secrets.is_empty() {
            return Err(CommandError::invalid_input(
                "No ready Gemini API key found. Please configure an API key in Settings.",
            ));
        }
        Ok(secrets)
    })
    .await
    .map_err(|_| CommandError::internal("credential resolution task failed"))??;

    let credential_count = secrets.len();
    let requests_per_credential = total_windows.div_ceil(credential_count);
    let clients = secrets
        .into_iter()
        .map(|secret| {
            let api_key = ApiKey::new(secret.expose_secret().to_owned())
                .map_err(|e| CommandError::invalid_input(e.to_string()))?;
            // The public window count is an execution contract. Distribute windows across every
            // ready credential and allow that credential's assigned sessions to overlap; provider
            // retries/cooldowns remain responsible for upstream throttling.
            osg_gemini::GeminiClientBuilder::new(api_key)
                .max_concurrent_requests(requests_per_credential)
                .build()
                .map(Arc::new)
                .map_err(|e| CommandError::invalid_input(e.to_string()))
        })
        .collect::<CommandResult<Vec<_>>>()?;

    // 6. Register running background job
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::Transcribe).await?;
    let initial_snapshot = ticket.snapshot().clone();
    let job_id = initial_snapshot.id();
    let cancellation = ticket.cancellation().clone();

    // 7. Insert initial TranscriptRevision into SQLite
    let revision_id = TranscriptRevisionId::new();
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(0);

    let planned_windows_json = serde_json::to_string(&serde_json::json!({
        "model": match request.model() { TranscriptionModel::Transcribe => "gemini-3.5-transcribe", TranscriptionModel::Live => "gemini-3.5-transcribe-live" },
        "plannedWindows": windows.iter().map(|w| serde_json::json!({
            "index": w.index,
            "startMs": w.start_ms,
            "endMs": w.end_ms,
        })).collect::<Vec<_>>(),
        "totalWindows": total_windows,
        "windowDurationMs": request.window_duration_ms(),
    }))
    .unwrap_or_else(|_| "{}".to_owned());

    let initial_revision = TranscriptRevisionRecord {
        id: revision_id,
        project_id: request.project_id,
        media_id: request.media_asset_id,
        provider: "gemini".to_owned(),
        model: match request.model() {
            TranscriptionModel::Transcribe => "gemini-3.5-transcribe",
            TranscriptionModel::Live => "gemini-3.5-transcribe-live",
        }
        .to_owned(),
        source_range_start_ms: range_start_ms,
        source_range_end_ms: range_end_ms,
        state: "in_progress".to_owned(),
        fingerprint: format!("{}_{}_{}", request.project_id, range_start_ms, range_end_ms),
        word_count: 0,
        metadata_json: planned_windows_json,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };

    let database = state.database.clone();
    let db_insert = database.clone();
    let rev_record = initial_revision.clone();
    tauri::async_runtime::spawn_blocking(move || db_insert.transcript_insert_revision(&rev_record))
        .await
        .map_err(|_| CommandError::internal("database task stopped unexpectedly"))?
        .map_err(|e| {
            CommandError::internal(format!("failed to insert transcript revision: {e}"))
        })?;

    // 8. Prepare transcription config
    let mut asr_config = AudioTranscriptionConfig::new();
    if request.diarization() {
        asr_config = asr_config.with_diarization(true);
    }
    let language_hints = request.language_hints();
    if !language_hints.is_empty() {
        asr_config = asr_config.with_language_hints(language_hints);
    }

    // 9. Spawn the native transcription orchestrator task
    let pipeline = Arc::new(pipeline);
    let native_input = Arc::new(native_input);
    let asr_config = Arc::new(asr_config);

    tauri::async_runtime::spawn(async move {
        run_engine_loop(
            jobs,
            database,
            job_id,
            revision_id,
            total_windows,
            windows,
            clients,
            pipeline,
            native_input,
            asr_config,
            transcription_model,
            cancellation,
            on_event,
        )
        .await;
    });

    Ok(initial_snapshot)
}

async fn resolve_transcription_media(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    request: &StartWordNativeTranscriptionRequest,
) -> CommandResult<LocalMedia> {
    if let Some(asset_id) = request.media_asset_id {
        if let Some(media) = media_blobs.resolve(asset_id)? {
            return Ok(media);
        }
        let database = state.database.clone();
        let expected_version = request.expected_project_state_version;
        let project_id = request.project_id;
        let media = tauri::async_runtime::spawn_blocking(move || {
            let resolved = match expected_version {
                Some(ver) => database.resolve_project_media_revision(project_id, ver, asset_id)?,
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
        .map_err(|_| CommandError::internal("media resolution task failed"))??;
        return Ok(media);
    }

    if let Some(file_path) = &request.file_path {
        let extension = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4");
        let media = LocalMedia::new(
            AssetId::new(),
            file_path.clone(),
            osg_domain::media_kind_for_extension(extension).unwrap_or(osg_domain::MediaKind::Audio),
            extension,
        );
        return Ok(media);
    }

    Err(CommandError::invalid_input(
        "transcription requires either mediaAssetId or filePath",
    ))
}

#[cfg(test)]
mod tests;
