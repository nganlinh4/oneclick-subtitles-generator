use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use osg_domain::{AssetId, JobId, JobKind, JobSnapshot, JobUpdate};
use osg_gemini::{
    ApiKey, GeminiClient, GenerateRequest, GenerationConfig, MediaInput, MediaResolution, Model,
    ThinkingLevel, TokenUsage, UploadRequest,
};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, ipc::Channel};

use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::{DesktopState, LocalMedia};

const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 1_048_576;
const MAX_SCHEMA_BYTES: usize = 1_048_576;

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
    response_json_schema: Option<Value>,
    media_asset_id: Option<AssetId>,
}

impl GeminiStartRequest {
    fn validate(&self) -> CommandResult<()> {
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
            .is_some_and(|limit| limit == 0 || limit > self.model.spec().output_token_limit)
        {
            return Err(CommandError::invalid_input(
                "The Gemini output-token limit is outside the selected model's bounds.",
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
        Ok(())
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
    let local_media = resolve_media(&state, &media_blobs, request.media_asset_id).await?;
    let jobs = Arc::clone(&state.jobs);
    let kind = request.task.job_kind();
    let task_name = request.task.diagnostic_name();
    let model_name = request.model.api_id();
    let has_media = local_media.is_some();
    let ticket = background::register_running(&jobs, kind).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let started = Instant::now();
    diagnostics::record(
        "gemini.started",
        &[
            ("job", job_id.to_string()),
            ("task", task_name.to_owned()),
            ("model", model_name.to_owned()),
            ("media", if has_media { "yes" } else { "no" }.to_owned()),
        ],
    );
    let cancellation = ticket.cancellation().clone();
    let credentials = state.credentials.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_gemini(
            &jobs,
            &credentials,
            request,
            local_media,
            &cancellation,
            &on_event,
            job_id,
            started,
        )
        .await;

        match result {
            Ok(output) => match background::apply(&jobs, job_id, JobUpdate::Succeed).await {
                Ok(job) => {
                    diagnostics::record(
                        "gemini.completed",
                        &[
                            ("job", job_id.to_string()),
                            ("task", task_name.to_owned()),
                            ("elapsedMs", elapsed_millis(started)),
                            ("outputBytes", output.text.len().to_string()),
                        ],
                    );
                    let _ = on_event.send(GeminiJobEvent::Completed {
                        job,
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
            },
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
) -> CommandResult<Option<LocalMedia>> {
    let Some(asset_id) = asset_id else {
        return Ok(None);
    };
    if let Some(media) = media_blobs.resolve(asset_id)? {
        return Ok(Some(media));
    }
    let database = state.database.clone();
    let media = tauri::async_runtime::spawn_blocking(move || {
        let resolved = database
            .resolve_media(asset_id)?
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

#[allow(
    clippy::too_many_arguments,
    reason = "the bounded provider run needs the durable job, credential, media, cancellation, channel, and timing boundaries"
)]
async fn run_gemini(
    jobs: &background::DesktopJobs,
    credentials: &osg_infrastructure::secrets::CredentialService<
        osg_infrastructure::secrets::KeyringCredentialBackend,
    >,
    request: GeminiStartRequest,
    local_media: Option<LocalMedia>,
    cancellation: &osg_gemini::CancellationToken,
    channel: &Channel<GeminiJobEvent>,
    job_id: JobId,
    started: Instant,
) -> CommandResult<GeminiOutput> {
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
        let mut next_progress_bytes = 512 * 1024;
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
            if channel
                .send(GeminiJobEvent::Chunk {
                    job_id,
                    text: chunk,
                })
                .is_err()
            {
                background::request_cancellation(jobs, job_id).await;
                return Err(CommandError::channel_closed());
            }
        }
        if text.is_empty() {
            return Err(osg_gemini::Error::NoTextOutput.into());
        }
        Ok(GeminiOutput { text, usage })
    }
    .await;

    if let Some(name) = provider_file_name {
        record_gemini_phase(job_id, "providerCleanup", started);
        let cleanup = osg_gemini::CancellationToken::new();
        let _ = client.delete_file(&name, &cleanup).await;
    }
    operation
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
    use serde_json::json;

    use super::{GeminiJobEvent, GeminiStartRequest, GeminiTask};

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
    }
}
