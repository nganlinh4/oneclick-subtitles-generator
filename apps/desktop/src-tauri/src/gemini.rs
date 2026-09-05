use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use futures_util::StreamExt;
use osg_domain::{AssetId, JobId, JobKind, JobSnapshot, JobUpdate, ProjectId};
use osg_gemini::{
    ApiKey, GeminiClient, GenerateRequest, GenerationConfig, MediaInput, MediaResolution, Model,
    ThinkingLevel, TokenUsage, UploadRequest,
};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use osg_infrastructure::storage::{Database, DatabaseError, JobResultDeliveryDraft, JobResultKind};
use osg_media::{
    CancellationToken as MediaCancellationToken, MediaInput as NativeMediaInput, RunControl,
};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{State, ipc::Channel};
use uuid::Uuid;

use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::{DesktopState, LocalMedia};

const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 1_048_576;
const MAX_SCHEMA_BYTES: usize = 1_048_576;
const SPEECH_CHECK_TIMEOUT: Duration = Duration::from_hours(24);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum EmptySpeechPolicy {
    ProvenSilence,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GeminiTask {
    Transcribe,
    Translate,
    AnalyzeSubtitles,
}

impl GeminiTask {
    const fn job_kind(self) -> JobKind {
        match self {
            Self::Transcribe => JobKind::Transcribe,
            Self::Translate => JobKind::Translate,
            Self::AnalyzeSubtitles => JobKind::AnalyzeSubtitles,
        }
    }

    const fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Transcribe => "transcribe",
            Self::Translate => "translate",
            Self::AnalyzeSubtitles => "analyzeSubtitles",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "prompts and response schemas are private user content"
)]
pub(crate) struct GeminiStartRequest {
    credential_id: CredentialId,
    task: GeminiTask,
    model: Model,
    prompt: String,
    system_instruction: Option<String>,
    max_output_tokens: Option<u32>,
    thinking_level: Option<ThinkingLevel>,
    media_resolution: Option<MediaResolution>,
    video_fps: Option<f64>,
    response_json_schema: Option<Value>,
    media_asset_id: Option<AssetId>,
    empty_speech_policy: Option<EmptySpeechPolicy>,
    project_id: Option<ProjectId>,
    expected_project_state_version: Option<u64>,
    recovery_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GeminiProjectAuthority {
    project_id: ProjectId,
    expected_state_version: u64,
}

impl GeminiStartRequest {
    fn validate(&self) -> CommandResult<()> {
        if self
            .video_fps
            .is_some_and(|fps| !fps.is_finite() || fps <= 0.0 || fps > 24.0)
            || (self.video_fps.is_some() && self.media_asset_id.is_none())
        {
            return Err(CommandError::invalid_input(
                "Video FPS requires media and must be within (0, 24].",
            ));
        }
        let prompt_chars = self.prompt.chars().count();
        if self.prompt.trim().is_empty() || prompt_chars > MAX_PROMPT_CHARS {
            return Err(CommandError::invalid_input(
                "A Gemini prompt must contain 1 to 1,048,576 characters.",
            ));
        }
        if self
            .system_instruction
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_PROMPT_CHARS)
        {
            return Err(CommandError::invalid_input(
                "The Gemini system instruction is too large.",
            ));
        }
        if self
            .max_output_tokens
            .is_some_and(|limit| limit == 0 || limit > self.model.output_token_limit())
        {
            return Err(CommandError::invalid_input(
                "The Gemini output-token limit is outside the selected model's bounds.",
            ));
        }
        if self
            .thinking_level
            .is_some_and(|level| !self.model.supports_thinking_level(level))
        {
            return Err(CommandError::invalid_input(
                "The selected Gemini model does not support that thinking level.",
            ));
        }
        if let Some(schema) = &self.response_json_schema {
            let size = serde_json::to_vec(schema)
                .map_err(|_| CommandError::invalid_input("The response schema is invalid."))?
                .len();
            if size > MAX_SCHEMA_BYTES {
                return Err(CommandError::invalid_input(
                    "The Gemini response schema exceeds 1 MiB.",
                ));
            }
        }
        if matches!(self.task, GeminiTask::Transcribe) && self.media_asset_id.is_none() {
            return Err(CommandError::invalid_input(
                "A transcription request must identify its media asset.",
            ));
        }
        if self.model.is_custom()
            && (matches!(self.task, GeminiTask::Transcribe)
                || self.media_asset_id.is_some()
                || self.video_fps.is_some()
                || self.media_resolution.is_some())
        {
            return Err(CommandError::invalid_input(
                "Custom Gemini models are available only for text processing.",
            ));
        }
        if self.empty_speech_policy.is_some()
            && (!matches!(self.task, GeminiTask::Transcribe) || self.media_asset_id.is_none())
        {
            return Err(CommandError::invalid_input(
                "The empty-speech policy is only valid for media transcription.",
            ));
        }
        if self.project_id.is_some() != self.expected_project_state_version.is_some()
            || self
                .expected_project_state_version
                .is_some_and(|version| version > i64::MAX as u64)
        {
            return Err(CommandError::invalid_input(
                "Gemini project ownership requires an exact project and state version.",
            ));
        }
        if self.recovery_key.as_ref().is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(CommandError::invalid_input(
                "The Gemini recovery key is invalid.",
            ));
        }
        Ok(())
    }

    const fn project_authority(&self) -> Option<GeminiProjectAuthority> {
        match (self.project_id, self.expected_project_state_version) {
            (Some(project_id), Some(expected_state_version)) => Some(GeminiProjectAuthority {
                project_id,
                expected_state_version,
            }),
            (None | Some(_), None) | (None, Some(_)) => None,
        }
    }

    fn into_native(self, media: Option<osg_gemini::UploadedFile>) -> GenerateRequest {
        GenerateRequest {
            model: self.model,
            prompt: self.prompt,
            system_instruction: self.system_instruction,
            media: media
                .map(MediaInput::Uploaded)
                .into_iter()
                .collect::<Vec<_>>(),
            generation: GenerationConfig {
                video_fps: self.video_fps,
                max_output_tokens: self.max_output_tokens,
                thinking_level: self.thinking_level,
                media_resolution: self.media_resolution,
                response_json_schema: self.response_json_schema,
            },
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct GeminiUsage {
    #[serde(rename = "promptTokenCount")]
    prompt: Option<u64>,
    #[serde(rename = "candidatesTokenCount")]
    candidates: Option<u64>,
    #[serde(rename = "totalTokenCount")]
    total: Option<u64>,
    #[serde(rename = "thoughtsTokenCount")]
    thoughts: Option<u64>,
    #[serde(rename = "cachedContentTokenCount")]
    cached_content: Option<u64>,
}

impl From<&TokenUsage> for GeminiUsage {
    fn from(usage: &TokenUsage) -> Self {
        Self {
            prompt: usage.prompt_token_count,
            candidates: usage.candidates_token_count,
            total: usage.total_token_count,
            thoughts: usage.thoughts_token_count,
            cached_content: usage.cached_content_token_count,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GeminiJobEvent {
    Chunk {
        job_id: JobId,
        text: String,
    },
    Completed {
        job: JobSnapshot,
        delivery_id: Uuid,
        text: String,
        usage: Option<GeminiUsage>,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

struct GeminiOutput {
    text: String,
    usage: Option<GeminiUsage>,
    chunk_count: usize,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    reason = "Tauri injects owned extractors and the job/log/channel terminal transitions must stay ordered"
)]
pub(crate) async fn gemini_start(
    state: State<'_, DesktopState>,
    media_blobs: State<'_, MediaBlobStore>,
    request: GeminiStartRequest,
    on_event: Channel<GeminiJobEvent>,
) -> CommandResult<JobSnapshot> {
    request.validate()?;
    let project_authority = request.project_authority();
    let task = request.task;
    let recovery_key = request.recovery_key.clone();
    verify_project_authority_async(state.database.clone(), project_authority, None).await?;
    let local_media = resolve_media(
        &state,
        &media_blobs,
        request.media_asset_id,
        project_authority,
    )
    .await?;
    let jobs = Arc::clone(&state.jobs);
    let kind = request.task.job_kind();
    let task_name = request.task.diagnostic_name();
    let model_name = request.model.api_id().to_owned();
    let has_media = local_media.is_some();
    let durable_asset_id = local_media.as_ref().and_then(LocalMedia::durable_asset_id);
    verify_project_authority_async(state.database.clone(), project_authority, durable_asset_id)
        .await?;
    let ticket = background::register_running(&jobs, kind).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let started = Instant::now();
    diagnostics::record(
        "gemini.started",
        &[
            ("job", job_id.to_string()),
            ("task", task_name.to_owned()),
            ("model", model_name),
            ("media", if has_media { "yes" } else { "no" }.to_owned()),
        ],
    );
    let cancellation = ticket.cancellation().clone();
    let credentials = state.credentials.clone();
    let media_engine = state.media_engine();
    let database = state.database.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_gemini(
            &credentials,
            request,
            local_media,
            media_engine,
            &cancellation,
            &on_event,
            job_id,
            started,
        )
        .await;

        match result {
            Ok(output) => {
                if let Err(error) =
                    verify_project_authority_async(database, project_authority, durable_asset_id)
                        .await
                {
                    let job = background::finish_failure(&jobs, job_id).await;
                    let _ = on_event.send(GeminiJobEvent::Failed { job, error });
                    return;
                }
                let delivery = gemini_result_delivery(
                    job_id,
                    task,
                    project_authority,
                    durable_asset_id,
                    recovery_key.as_deref(),
                    &output,
                );
                let delivery = match delivery {
                    Ok(delivery) => delivery,
                    Err(error) => {
                        let error = CommandError::from(error);
                        let job = background::finish_failure(&jobs, job_id).await;
                        let _ = on_event.send(GeminiJobEvent::Failed { job, error });
                        return;
                    }
                };
                let delivery_id = delivery.delivery_id();
                match succeed_with_result(
                    &jobs,
                    job_id,
                    delivery,
                    project_authority,
                    durable_asset_id,
                )
                .await
                {
                    Ok(job) => {
                        diagnostics::record(
                            "gemini.completed",
                            &[
                                ("job", job_id.to_string()),
                                ("task", task_name.to_owned()),
                                ("elapsedMs", elapsed_millis(started)),
                                ("outputBytes", output.text.len().to_string()),
                                ("chunkCount", output.chunk_count.to_string()),
                            ],
                        );
                        let _ = on_event.send(GeminiJobEvent::Completed {
                            job,
                            delivery_id,
                            text: output.text,
                            usage: output.usage,
                        });
                    }
                    Err(error) => {
                        diagnostics::record(
                            "gemini.failed",
                            &[
                                ("job", job_id.to_string()),
                                ("task", task_name.to_owned()),
                                ("elapsedMs", elapsed_millis(started)),
                                ("code", error.code().to_owned()),
                            ],
                        );
                        let job = background::snapshot(&jobs, job_id).await;
                        let _ = on_event.send(GeminiJobEvent::Failed { job, error });
                    }
                }
            }
            Err(error) if cancellation.is_cancelled() => {
                match background::finish_cancellation(&jobs, job_id).await {
                    Ok(job) => {
                        diagnostics::record(
                            "gemini.cancelled",
                            &[
                                ("job", job_id.to_string()),
                                ("task", task_name.to_owned()),
                                ("elapsedMs", elapsed_millis(started)),
                            ],
                        );
                        let _ = on_event.send(GeminiJobEvent::Cancelled { job });
                    }
                    Err(job_error) => {
                        diagnostics::record(
                            "gemini.failed",
                            &[
                                ("job", job_id.to_string()),
                                ("task", task_name.to_owned()),
                                ("elapsedMs", elapsed_millis(started)),
                                ("code", job_error.code().to_owned()),
                            ],
                        );
                        let job = background::snapshot(&jobs, job_id).await;
                        let _ = on_event.send(GeminiJobEvent::Failed {
                            job,
                            error: job_error,
                        });
                    }
                }
                drop(error);
            }
            Err(error) => {
                diagnostics::record(
                    "gemini.failed",
                    &[
                        ("job", job_id.to_string()),
                        ("task", task_name.to_owned()),
                        ("elapsedMs", elapsed_millis(started)),
                        ("code", error.code().to_owned()),
                    ],
                );
                let job = background::finish_failure(&jobs, job_id).await;
                let _ = on_event.send(GeminiJobEvent::Failed { job, error });
            }
        }
    });

    Ok(initial)
}

async fn resolve_media(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    asset_id: Option<AssetId>,
    project_authority: Option<GeminiProjectAuthority>,
) -> CommandResult<Option<LocalMedia>> {
    let Some(asset_id) = asset_id else {
        return Ok(None);
    };
    if let Some(media) = media_blobs.resolve(asset_id)? {
        return Ok(Some(media));
    }
    let database = state.database.clone();
    let media = tauri::async_runtime::spawn_blocking(move || {
        let resolved = match project_authority {
            Some(authority) => database.resolve_project_media_revision(
                authority.project_id,
                authority.expected_state_version,
                asset_id,
            )?,
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
    .map_err(|_| CommandError::internal("the media resolution task stopped unexpectedly"))??;
    if media.mime_type().is_none() {
        return Err(CommandError::media_conversion_required());
    }
    Ok(Some(media))
}

fn verify_project_authority(
    database: &Database,
    authority: Option<GeminiProjectAuthority>,
    durable_asset_id: Option<AssetId>,
) -> CommandResult<()> {
    let Some(authority) = authority else {
        return Ok(());
    };
    let project = database
        .load_project(authority.project_id)?
        .ok_or(DatabaseError::ProjectNotFound(authority.project_id))?;
    if project.state_version() != authority.expected_state_version {
        return Err(DatabaseError::StaleProjectVersion {
            project_id: authority.project_id,
            expected: authority.expected_state_version,
            actual: project.state_version(),
        }
        .into());
    }
    if let Some(asset_id) = durable_asset_id
        && !database.project_media_is_current(
            authority.project_id,
            authority.expected_state_version,
            asset_id,
        )?
    {
        return Err(CommandError::media_unavailable());
    }
    Ok(())
}

async fn verify_project_authority_async(
    database: Database,
    authority: Option<GeminiProjectAuthority>,
    durable_asset_id: Option<AssetId>,
) -> CommandResult<()> {
    if authority.is_none() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        verify_project_authority(&database, authority, durable_asset_id)
    })
    .await
    .map_err(|_| CommandError::internal("the project authorization task stopped unexpectedly"))?
}

fn gemini_result_delivery(
    job_id: JobId,
    task: GeminiTask,
    project_authority: Option<GeminiProjectAuthority>,
    durable_asset_id: Option<AssetId>,
    recovery_key: Option<&str>,
    output: &GeminiOutput,
) -> Result<JobResultDeliveryDraft, DatabaseError> {
    JobResultDeliveryDraft::new(
        job_id,
        JobResultKind::GeminiText,
        project_authority.map(|authority| authority.project_id),
        durable_asset_id,
        &json!({
            "schemaVersion": 2,
            "task": task.diagnostic_name(),
            "expectedProjectStateVersion": project_authority.map(|authority| authority.expected_state_version),
            "recoveryKey": recovery_key,
            "text": &output.text,
            "usage": &output.usage,
        }),
    )
}

async fn succeed_with_result(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    delivery: JobResultDeliveryDraft,
    project_authority: Option<GeminiProjectAuthority>,
    durable_asset_id: Option<AssetId>,
) -> CommandResult<JobSnapshot> {
    let Some(authority) = project_authority else {
        return background::succeed_with_result(jobs, job_id, delivery).await;
    };
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || {
        jobs.apply_with_store(
            job_id,
            JobUpdate::Succeed,
            |database, sequence, snapshot| {
                database.complete_project_job_with_result(
                    sequence,
                    snapshot,
                    &delivery,
                    authority.project_id,
                    authority.expected_state_version,
                    durable_asset_id,
                )
            },
        )
    })
    .await
    .map_err(|_| CommandError::internal("the durable Gemini result task stopped unexpectedly"))?
    .map(|ticket| ticket.snapshot().clone())
    .map_err(Into::into)
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "the bounded provider run keeps speech preflight, credential, upload, streaming, cleanup, and durable job boundaries visibly ordered"
)]
async fn run_gemini(
    credentials: &osg_infrastructure::secrets::CredentialService<
        crate::state::DesktopCredentialBackend,
    >,
    request: GeminiStartRequest,
    local_media: Option<LocalMedia>,
    media_engine: Option<osg_media::MediaEngine>,
    cancellation: &osg_gemini::CancellationToken,
    channel: &Channel<GeminiJobEvent>,
    job_id: JobId,
    started: Instant,
) -> CommandResult<GeminiOutput> {
    if let Some(output) = empty_speech_output(
        request.empty_speech_policy,
        local_media.as_ref(),
        media_engine,
        cancellation,
        job_id,
        started,
    )
    .await?
    {
        return Ok(output);
    }

    record_gemini_phase(job_id, "credentialResolve", started);
    let credential_id = request.credential_id;
    let credentials = credentials.clone();
    let secret = tauri::async_runtime::spawn_blocking(move || {
        credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map_err(|_| CommandError::internal("the credential task stopped unexpectedly"))??;
    if cancellation.is_cancelled() {
        return Err(osg_gemini::Error::Cancelled.into());
    }
    let api_key = ApiKey::new(secret.expose_secret().to_owned())?;
    let client = GeminiClient::new(api_key)?;
    record_gemini_phase(job_id, "credentialReady", started);

    let mut provider_file_name = None;
    let operation = async {
        let uploaded = if let Some(media) = local_media {
            record_gemini_phase(job_id, "uploadStarted", started);
            let mime_type = media
                .mime_type()
                .ok_or_else(CommandError::media_conversion_required)?;
            let upload = UploadRequest::new(media.path(), mime_type)?.with_display_name("media")?;
            let file = client.upload_file(upload, cancellation).await?;
            provider_file_name = Some(file.name().to_owned());
            let active = client.wait_until_active(file, cancellation).await?;
            record_gemini_phase(job_id, "uploadReady", started);
            Some(active)
        } else {
            None
        };

        record_gemini_phase(job_id, "generationStarted", started);
        let mut stream = client
            .generate_stream(request.into_native(uploaded), cancellation)
            .await?;
        let mut text = String::new();
        let mut usage = None;
        let mut first_chunk = true;
        let mut chunk_count = 0_usize;
        let mut next_progress_bytes = 512 * 1024;
        let mut channel_open = true;
        while let Some(response) = stream.next().await {
            let response = response?;
            if let Some(next_usage) = &response.usage_metadata {
                usage = Some(next_usage.into());
            }
            let Some(chunk) = response.text() else {
                continue;
            };
            if text.len().saturating_add(chunk.len()) > MAX_RESULT_BYTES {
                return Err(CommandError::from(osg_gemini::Error::ResponseTooLarge {
                    limit_bytes: MAX_RESULT_BYTES,
                }));
            }
            text.push_str(&chunk);
            chunk_count = chunk_count.saturating_add(1);
            if first_chunk {
                record_gemini_phase(job_id, "firstChunk", started);
                first_chunk = false;
            }
            if text.len() >= next_progress_bytes {
                diagnostics::record(
                    "gemini.progress",
                    &[
                        ("job", job_id.to_string()),
                        ("elapsedMs", elapsed_millis(started)),
                        ("outputBytes", text.len().to_string()),
                    ],
                );
                next_progress_bytes = next_progress_bytes.saturating_add(512 * 1024);
            }
            send_chunk_advisory(channel, &mut channel_open, job_id, chunk);
        }
        if text.is_empty() {
            return Err(osg_gemini::Error::NoTextOutput.into());
        }
        Ok(GeminiOutput {
            text,
            usage,
            chunk_count,
        })
    }
    .await;

    if let Some(name) = provider_file_name {
        record_gemini_phase(job_id, "providerCleanup", started);
        let cleanup = osg_gemini::CancellationToken::new();
        let _ = client.delete_file(&name, &cleanup).await;
    }
    operation
}

fn send_chunk_advisory(
    channel: &Channel<GeminiJobEvent>,
    channel_open: &mut bool,
    job_id: JobId,
    text: String,
) {
    if *channel_open
        && channel
            .send(GeminiJobEvent::Chunk { job_id, text })
            .is_err()
    {
        *channel_open = false;
    }
}

async fn empty_speech_output(
    policy: Option<EmptySpeechPolicy>,
    local_media: Option<&LocalMedia>,
    media_engine: Option<osg_media::MediaEngine>,
    cancellation: &osg_gemini::CancellationToken,
    job_id: JobId,
    started: Instant,
) -> CommandResult<Option<GeminiOutput>> {
    if policy != Some(EmptySpeechPolicy::ProvenSilence)
        || !media_proves_empty_speech(local_media, media_engine, cancellation, job_id, started)
            .await?
    {
        return Ok(None);
    }
    Ok(Some(GeminiOutput {
        text: "[]".to_owned(),
        usage: None,
        chunk_count: 0,
    }))
}

async fn media_proves_empty_speech(
    local_media: Option<&LocalMedia>,
    media_engine: Option<osg_media::MediaEngine>,
    cancellation: &osg_gemini::CancellationToken,
    job_id: JobId,
    started: Instant,
) -> CommandResult<bool> {
    record_gemini_phase(job_id, "speechCheckStarted", started);
    let (Some(media), Some(engine)) = (local_media, media_engine) else {
        record_gemini_phase(job_id, "speechCheckUnavailable", started);
        return Ok(false);
    };
    let path = media.path().to_owned();
    let media_cancellation = MediaCancellationToken::default();
    let cancellation_bridge = media_cancellation.clone();
    let provider_cancellation = cancellation.clone();
    let watcher = tauri::async_runtime::spawn(async move {
        provider_cancellation.cancelled().await;
        cancellation_bridge.cancel();
    });
    let speech_check = tauri::async_runtime::spawn_blocking(move || {
        let input = NativeMediaInput::from_native_selection(path)?;
        let control = RunControl::new(SPEECH_CHECK_TIMEOUT)?.with_cancellation(media_cancellation);
        let metadata = engine.probe(&input, &control)?;
        if metadata.primary_audio().is_none() {
            return Ok::<_, osg_media::MediaError>(true);
        }
        engine.audio_is_exactly_silent(&input, &control)
    })
    .await;
    watcher.abort();
    if cancellation.is_cancelled() {
        return Err(osg_gemini::Error::Cancelled.into());
    }
    match speech_check {
        Ok(Ok(true)) => {
            record_gemini_phase(job_id, "speechAbsent", started);
            Ok(true)
        }
        Ok(Ok(false)) => {
            record_gemini_phase(job_id, "speechPresent", started);
            Ok(false)
        }
        Ok(Err(_)) | Err(_) => {
            record_gemini_phase(job_id, "speechCheckUnavailable", started);
            Ok(false)
        }
    }
}

fn record_gemini_phase(job_id: JobId, phase: &'static str, started: Instant) {
    diagnostics::record(
        "gemini.phase",
        &[
            ("job", job_id.to_string()),
            ("phase", phase.to_owned()),
            ("elapsedMs", elapsed_millis(started)),
        ],
    );
}

fn elapsed_millis(started: Instant) -> String {
    started.elapsed().as_millis().to_string()
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use osg_application::{JobRegistry, ProjectSnapshot};
    use osg_domain::{
        JobKind, JobState, JobUpdate, MediaAsset, MediaKind, ProjectMetadata, RevisionReason,
    };
    use osg_infrastructure::storage::Database;
    use serde_json::json;
    use tauri::ipc::Channel;

    use super::{
        EmptySpeechPolicy, GeminiJobEvent, GeminiOutput, GeminiProjectAuthority,
        GeminiStartRequest, GeminiTask, gemini_result_delivery, send_chunk_advisory,
        verify_project_authority,
    };

    #[test]
    fn a_closed_webview_channel_does_not_abort_gemini_result_collection() {
        let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
        let mut channel_open = true;
        send_chunk_advisory(
            &channel,
            &mut channel_open,
            osg_domain::JobId::new(),
            "result text".to_owned(),
        );
        assert!(!channel_open);

        // Once transport closes, further chunks are deliberately ignored instead of re-sent or
        // converted into provider cancellation. The producer can finish and publish its outbox.
        send_chunk_advisory(
            &channel,
            &mut channel_open,
            osg_domain::JobId::new(),
            "more text".to_owned(),
        );
        assert!(!channel_open);
    }

    #[test]
    fn tasks_map_to_their_durable_job_kinds() {
        assert_eq!(
            GeminiTask::Transcribe.job_kind(),
            osg_domain::JobKind::Transcribe
        );
        assert_eq!(
            GeminiTask::Translate.job_kind(),
            osg_domain::JobKind::Translate
        );
        assert_eq!(
            GeminiTask::AnalyzeSubtitles.job_kind(),
            osg_domain::JobKind::AnalyzeSubtitles
        );
        assert_eq!(GeminiTask::Transcribe.diagnostic_name(), "transcribe");
        assert_eq!(GeminiTask::Translate.diagnostic_name(), "translate");
        assert_eq!(
            GeminiTask::AnalyzeSubtitles.diagnostic_name(),
            "analyzeSubtitles"
        );
    }

    #[test]
    fn streamed_chunk_uses_the_frontend_camel_case_contract() {
        let job_id = osg_domain::JobId::new();
        let value = serde_json::to_value(GeminiJobEvent::Chunk {
            job_id,
            text: "bounded".to_owned(),
        })
        .expect("event serializes");

        assert_eq!(
            value,
            json!({
                "event": "chunk",
                "jobId": job_id,
                "text": "bounded"
            })
        );
        assert!(value.get("job_id").is_none());
    }

    #[test]
    fn start_request_rejects_blank_prompt_and_unknown_fields() {
        let credential_id = osg_infrastructure::secrets::CredentialId::new();
        let blank = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.5-flash-lite",
            "prompt": "   ",
            "mediaAssetId": osg_domain::AssetId::new()
        }))
        .expect("shape is valid");
        assert!(blank.validate().is_err());

        let missing_media = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.5-flash-lite",
            "prompt": "transcribe"
        }))
        .expect("optional media ID has a valid wire shape");
        assert!(missing_media.validate().is_err());

        let unsupported_thinking = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.7-flash",
            "prompt": "transcribe",
            "mediaAssetId": osg_domain::AssetId::new(),
            "thinkingLevel": "MINIMAL"
        }))
        .expect("the provider-rejected level has a valid wire shape");
        assert!(unsupported_thinking.validate().is_err());

        let supported_thinking = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.7-flash",
            "prompt": "transcribe",
            "mediaAssetId": osg_domain::AssetId::new(),
            "thinkingLevel": "LOW"
        }))
        .expect("the verified level has a valid wire shape");
        assert!(supported_thinking.validate().is_ok());

        assert!(
            serde_json::from_value::<GeminiStartRequest>(json!({
                "credentialId": credential_id,
                "task": "transcribe",
                "model": "gemini-3.5-flash-lite",
                "prompt": "transcribe",
                "temperature": 0.7
            }))
            .is_err()
        );

        let speech_only = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.5-flash-lite",
            "prompt": "transcribe",
            "mediaAssetId": osg_domain::AssetId::new(),
            "emptySpeechPolicy": "provenSilence"
        }))
        .expect("the explicit speech-only policy has a valid wire shape");
        assert_eq!(
            speech_only.empty_speech_policy,
            Some(EmptySpeechPolicy::ProvenSilence)
        );
        assert!(speech_only.validate().is_ok());

        let non_transcription = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "gemini-3.5-flash-lite",
            "prompt": "translate",
            "emptySpeechPolicy": "provenSilence"
        }))
        .expect("the policy is rejected semantically rather than by shape");
        assert!(non_transcription.validate().is_err());

        let custom_text = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "gemini-3.8-flash",
            "prompt": "translate"
        }))
        .expect("a bounded custom model ID has a valid wire shape");
        assert!(custom_text.model.is_custom());
        assert!(custom_text.validate().is_ok());

        let custom_media = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.8-flash",
            "prompt": "transcribe",
            "mediaAssetId": osg_domain::AssetId::new()
        }))
        .expect("custom media is rejected semantically");
        assert!(custom_media.validate().is_err());

        assert!(
            serde_json::from_value::<GeminiStartRequest>(json!({
                "credentialId": credential_id,
                "task": "translate",
                "model": "models/gemini-3.8-flash",
                "prompt": "translate"
            }))
            .is_err()
        );
    }

    #[test]
    fn project_ownership_is_an_inseparable_exact_revision_pair() {
        let credential_id = osg_infrastructure::secrets::CredentialId::new();
        let project_id = osg_domain::ProjectId::new();
        let owned = serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "gemini-3.5-flash-lite",
            "prompt": "translate",
            "projectId": project_id,
            "expectedProjectStateVersion": 7
        }))
        .expect("owned request shape");
        assert!(owned.validate().is_ok());
        assert_eq!(
            owned.project_authority(),
            Some(GeminiProjectAuthority {
                project_id,
                expected_state_version: 7,
            })
        );

        for invalid in [
            json!({
                "credentialId": credential_id,
                "task": "translate",
                "model": "gemini-3.5-flash-lite",
                "prompt": "translate",
                "projectId": project_id
            }),
            json!({
                "credentialId": credential_id,
                "task": "translate",
                "model": "gemini-3.5-flash-lite",
                "prompt": "translate",
                "expectedProjectStateVersion": 7
            }),
            json!({
                "credentialId": credential_id,
                "task": "translate",
                "model": "gemini-3.5-flash-lite",
                "prompt": "translate",
                "projectId": project_id,
                "expectedProjectStateVersion": u64::MAX
            }),
        ] {
            let request = serde_json::from_value::<GeminiStartRequest>(invalid)
                .expect("invalid authority still has a valid wire shape");
            assert!(request.validate().is_err());
        }
    }

    #[test]
    fn project_authority_rejects_stale_and_cross_project_media() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("db.sqlite3")).expect("database");
        let media_path = directory.path().join("owned.mp4");
        fs::write(&media_path, vec![0x45; 32 * 1024]).expect("media fixture");
        let asset =
            MediaAsset::new("owned.mp4", "mp4", 32 * 1024, MediaKind::Video).expect("media asset");
        database
            .remember_media(&asset, &media_path)
            .expect("remember media");

        let owner = ProjectMetadata::new("owner").expect("owner metadata");
        let base = database.create_project(&owner).expect("create owner");
        let attached = ProjectSnapshot::new(
            owner.clone(),
            base.state_version(),
            vec![asset.clone()],
            Vec::new(),
        )
        .expect("project snapshot");
        let commit = database
            .commit_project(
                &attached,
                &RevisionReason::new("attach media").expect("revision reason"),
            )
            .expect("attach media");
        let authority = GeminiProjectAuthority {
            project_id: owner.id(),
            expected_state_version: commit.state_version,
        };
        verify_project_authority(&database, Some(authority), Some(asset.id()))
            .expect("current owner authorizes media");

        let stale = verify_project_authority(
            &database,
            Some(GeminiProjectAuthority {
                expected_state_version: commit.state_version - 1,
                ..authority
            }),
            Some(asset.id()),
        )
        .expect_err("stale revision");
        assert_eq!(stale.code(), "staleProjectVersion");

        let other = ProjectMetadata::new("other").expect("other metadata");
        let other_snapshot = database.create_project(&other).expect("create other");
        let cross_project = verify_project_authority(
            &database,
            Some(GeminiProjectAuthority {
                project_id: other.id(),
                expected_state_version: other_snapshot.state_version(),
            }),
            Some(asset.id()),
        )
        .expect_err("cross-project media");
        assert_eq!(cross_project.code(), "mediaUnavailable");
    }

    #[test]
    fn gemini_delivery_persists_its_project_owner() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("db.sqlite3")).expect("database");
        let registry = JobRegistry::restore(Arc::new(database.clone())).expect("registry");
        let queued = registry.register(JobKind::Translate).expect("job");
        let job_id = queued.snapshot().id();
        registry.apply(job_id, JobUpdate::Start).expect("start");
        let project = ProjectMetadata::new("delivery owner").expect("project metadata");
        let project_snapshot = database.create_project(&project).expect("create project");
        let project_id = project.id();
        let draft = gemini_result_delivery(
            job_id,
            GeminiTask::Translate,
            Some(GeminiProjectAuthority {
                project_id,
                expected_state_version: project_snapshot.state_version(),
            }),
            None,
            Some(&"a".repeat(64)),
            &GeminiOutput {
                text: "translated".to_owned(),
                usage: None,
                chunk_count: 1,
            },
        )
        .expect("delivery");
        registry
            .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                store.complete_project_job_with_result(
                    sequence,
                    snapshot,
                    &draft,
                    project_id,
                    project_snapshot.state_version(),
                    None,
                )
            })
            .expect("persist result");

        let delivery = database
            .claim_job_result(job_id)
            .expect("claim")
            .expect("delivery");
        assert_eq!(delivery.project_id, Some(project_id));
        assert_eq!(delivery.payload["schemaVersion"], 2);
        assert_eq!(delivery.payload["task"], "translate");
        assert_eq!(
            delivery.payload["expectedProjectStateVersion"],
            project_snapshot.state_version()
        );
        assert_eq!(delivery.payload["recoveryKey"], "a".repeat(64));
    }

    #[test]
    fn stale_project_rolls_back_terminal_success_and_outbox_together() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("db.sqlite3")).expect("database");
        let registry = JobRegistry::restore(Arc::new(database.clone())).expect("registry");
        let queued = registry.register(JobKind::Translate).expect("job");
        let job_id = queued.snapshot().id();
        registry.apply(job_id, JobUpdate::Start).expect("start");
        let project = ProjectMetadata::new("stale owner").expect("project metadata");
        let original = database.create_project(&project).expect("create project");
        let authority = GeminiProjectAuthority {
            project_id: project.id(),
            expected_state_version: original.state_version(),
        };
        let changed =
            ProjectSnapshot::new(project, original.state_version(), Vec::new(), Vec::new())
                .expect("changed snapshot");
        database
            .commit_project(
                &changed,
                &RevisionReason::new("concurrent change").expect("reason"),
            )
            .expect("change project");
        let draft = gemini_result_delivery(
            job_id,
            GeminiTask::Translate,
            Some(authority),
            None,
            None,
            &GeminiOutput {
                text: "must not publish".to_owned(),
                usage: None,
                chunk_count: 1,
            },
        )
        .expect("delivery");

        let result =
            registry.apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                store.complete_project_job_with_result(
                    sequence,
                    snapshot,
                    &draft,
                    authority.project_id,
                    authority.expected_state_version,
                    None,
                )
            });
        assert!(result.is_err());
        assert_eq!(
            registry
                .get(job_id)
                .expect("job remains")
                .snapshot()
                .state(),
            JobState::Running
        );
        assert!(database.claim_job_result(job_id).expect("claim").is_none());
    }
}
