//! Gemini job execution, empty-speech detection, result delivery and error mapping.

use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use osg_domain::{AssetId, JobId, JobSnapshot, JobUpdate};
use osg_gemini::{ApiKey, GeminiClient, UploadRequest};
use osg_infrastructure::secrets::CredentialPurpose;
use osg_infrastructure::storage::{DatabaseError, JobResultDeliveryDraft, JobResultKind};
use osg_media::{
    CancellationToken as MediaCancellationToken, MediaInput as NativeMediaInput, RunControl,
};
use secrecy::ExposeSecret;
use serde_json::json;
use tauri::ipc::Channel;

use super::request::{
    EmptySpeechPolicy, GeminiJobEvent, GeminiOutput, GeminiProjectAuthority, GeminiStartRequest,
    GeminiTask,
};
use super::{MAX_RESULT_BYTES, SPEECH_CHECK_TIMEOUT};
use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::state::LocalMedia;

pub(super) fn gemini_result_delivery(
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

pub(super) async fn succeed_with_result(
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
pub(super) async fn run_gemini(
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
            .await
            .map_err(|error| gemini_command_error(job_id, "streamOpen", error))?;
        let mut text = String::new();
        let mut usage = None;
        let mut first_chunk = true;
        let mut chunk_count = 0_usize;
        let mut next_progress_bytes = 512 * 1024;
        let mut channel_open = true;
        let mut completion = osg_gemini::TextStreamCompletion::default();
        let record_completion_failure = |error: &osg_gemini::Error| {
            let reason = match error {
                osg_gemini::Error::IncompleteTextOutput { reason } => *reason,
                _ => "unexpected",
            };
            diagnostics::record(
                "gemini.termination",
                &[("job", job_id.to_string()), ("reason", reason.to_owned())],
            );
        };
        while let Some(response) = stream.next().await {
            let response =
                response.map_err(|error| gemini_command_error(job_id, "streamRead", error))?;
            if let Err(error) = completion.observe(&response) {
                record_completion_failure(&error);
                return Err(error.into());
            }
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
        if let Err(error) = completion.finish() {
            record_completion_failure(&error);
            return Err(error.into());
        }
        diagnostics::record(
            "gemini.termination",
            &[("job", job_id.to_string()), ("reason", "STOP".to_owned())],
        );
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

pub(super) fn send_chunk_advisory(
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

fn gemini_command_error(
    job_id: JobId,
    phase: &'static str,
    error: osg_gemini::Error,
) -> CommandError {
    use osg_gemini::Error;

    let kind = match &error {
        Error::Cancelled => "cancelled",
        Error::InvalidConfig(_) => "localConfig",
        Error::InvalidRequest(_) => "localRequest",
        Error::UnsupportedMimeType(_) => "unsupportedMime",
        Error::InlineRequestTooLarge { .. } | Error::UploadTooLarge { .. } => "sizeLimit",
        Error::Io { .. } => "localIo",
        Error::Transport(_) => "transport",
        Error::Timeout { .. } => "timeout",
        Error::Provider(_) => "provider",
        Error::CooldownActive { .. } => "cooldown",
        Error::UploadProtocol(_) | Error::FileProcessingFailed { .. } => "upload",
        Error::UploadOutcomeUnknown => "uploadOutcomeUnknown",
        Error::ResponseTooLarge { .. } => "responseLimit",
        Error::NoTextOutput => "noText",
        Error::IncompleteTextOutput { .. } => "incompleteText",
        Error::NoImageOutput | Error::InvalidImageOutput | Error::ImageOutputBlocked => "image",
    };
    let mut fields = vec![
        ("job", job_id.to_string()),
        ("phase", phase.to_owned()),
        ("kind", kind.to_owned()),
    ];
    if let Error::Provider(provider) = &error {
        fields.push(("httpStatus", provider.http_status.to_string()));
        if let Some(api_status) = provider.api_status.as_deref().filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }) {
            fields.push(("apiStatus", api_status.to_owned()));
        }
    }
    // Never record provider messages: providers may echo prompts or subtitle content. The
    // bounded phase/kind/status tuple is enough to distinguish product, transport and API faults.
    diagnostics::record("gemini.failure_detail", &fields);
    error.into()
}

pub(super) fn elapsed_millis(started: Instant) -> String {
    started.elapsed().as_millis().to_string()
}
