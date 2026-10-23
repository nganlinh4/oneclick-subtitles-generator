//! Gemini transcription, translation and analysis jobs over project-owned media.

mod request;
mod run;

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use osg_domain::{AssetId, JobSnapshot};
use osg_infrastructure::storage::{Database, DatabaseError};
use tauri::{State, ipc::Channel};

use self::request::{GeminiJobEvent, GeminiProjectAuthority, GeminiStartRequest};
use self::run::{elapsed_millis, gemini_result_delivery, run_gemini, succeed_with_result};
use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::{DesktopState, LocalMedia};

const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 1_048_576;
const MAX_SCHEMA_BYTES: usize = 1_048_576;
const SPEECH_CHECK_TIMEOUT: Duration = Duration::from_hours(24);

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

#[cfg(test)]
mod tests;
