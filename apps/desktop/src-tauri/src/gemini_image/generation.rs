//! Image generation start and pending-completion supervision.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use osg_domain::{JobId, JobKind, JobSnapshot, JobState};
use osg_infrastructure::storage::{ArtifactRecord, Database};
use osg_media_server::MediaServer;
use tauri::State;
use tauri::ipc::Channel;

use super::commands::{ensure_project_accepts_generated_image, pending_new_image_count};
use super::completion::{
    finalize_pending_completion, invalidate_pending_completion,
    invalidate_pending_completion_parts, run_image,
};
use super::format::{generated_image_storage_error, reference_unavailable};
use super::types::{
    GeminiImageEvent, GeminiImageStartRequest, GeneratedImageRuntime, GeneratedImageServices,
    PendingGeneratedImage, PlayableGeneratedImage,
};
use super::{COMPLETION_ACK_POLL_INTERVAL, COMPLETION_ACK_TIMEOUT};
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::image_blob::ImageBlobStore;
use crate::state::DesktopState;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn gemini_image_start(
    state: State<'_, DesktopState>,
    images: State<'_, ImageBlobStore>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeminiImageStartRequest,
    on_event: Channel<GeminiImageEvent>,
) -> CommandResult<JobSnapshot> {
    let database = state.database.clone();
    let project_id = request.project_id;
    let preflight_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        preflight_runtime.access(|registry| {
            ensure_project_accepts_generated_image(
                &database,
                project_id,
                pending_new_image_count(registry, project_id),
            )
        })
    })
    .await
    .map_err(|_| CommandError::internal("The image project preflight stopped unexpectedly."))??;
    let reference = images
        .resolve(request.reference_asset_id, request.project_id)?
        .ok_or_else(reference_unavailable)?;
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::GenerateImage).await?;
    let initial = ticket.snapshot().clone();
    let prepared_job = initial.clone();
    let job_id = initial.id();
    let expected_job_sequence = initial.sequence();
    let cancellation = ticket.cancellation().clone();
    let services = GeneratedImageServices {
        credentials: state.credentials.clone(),
        database: state.database.clone(),
        media_server: state.media_server.clone(),
        runtime: runtime.inner().clone(),
    };

    tauri::async_runtime::spawn(async move {
        let result = run_image(
            &services,
            request,
            reference,
            job_id,
            expected_job_sequence,
            &cancellation,
        )
        .await;

        match result {
            Ok(published) => {
                if on_event
                    .send(GeminiImageEvent::Prepared {
                        job: prepared_job,
                        image: published.image.clone(),
                    })
                    .is_err()
                {
                    fail_pending_completion(&jobs, &services, job_id).await;
                    return;
                }

                supervise_pending_completion(&jobs, &services, job_id, &cancellation, &on_event)
                    .await;
            }
            Err(error) if cancellation.is_cancelled() => {
                match background::finish_cancellation(&jobs, job_id).await {
                    Ok(job) => {
                        let _ = on_event.send(GeminiImageEvent::Cancelled { job });
                    }
                    Err(job_error) => {
                        let job = failed_job(&jobs, job_id).await;
                        let _ = on_event.send(GeminiImageEvent::Failed {
                            job,
                            error: job_error,
                        });
                    }
                }
                drop(error);
            }
            Err(error) => {
                let job = failed_job(&jobs, job_id).await;
                let _ = on_event.send(GeminiImageEvent::Failed { job, error });
            }
        }
    });

    Ok(initial)
}

async fn supervise_pending_completion(
    jobs: &background::DesktopJobs,
    services: &GeneratedImageServices,
    job_id: JobId,
    _cancellation: &osg_gemini::CancellationToken,
    on_event: &Channel<GeminiImageEvent>,
) {
    let deadline = tokio::time::Instant::now() + COMPLETION_ACK_TIMEOUT;
    loop {
        let Some(_) = pending_completion(&services.runtime, job_id) else {
            return;
        };
        match background::snapshot(jobs, job_id)
            .await
            .map(|job| job.state())
        {
            Some(JobState::Succeeded) => {
                let _ = finalize_pending_completion(jobs, services, job_id).await;
                return;
            }
            Some(
                JobState::Cancelling
                | JobState::Cancelled
                | JobState::Failed
                | JobState::Interrupted,
            ) => {
                let job = invalidate_pending_completion(jobs, services, job_id).await;
                send_cleanup_event(on_event, job);
                return;
            }
            Some(JobState::Queued | JobState::Running) | None => {}
        }
        if tokio::time::Instant::now() >= deadline {
            let error =
                CommandError::internal("The generated-image completion was not acknowledged.");
            let job = invalidate_pending_completion(jobs, services, job_id).await;
            match job {
                Some(job) if job.state() == JobState::Succeeded => {}
                Some(job) if job.state() == JobState::Cancelled => {
                    let _ = on_event.send(GeminiImageEvent::Cancelled { job });
                }
                job => {
                    let job = job.filter(|job| job.state() == JobState::Failed);
                    let _ = on_event.send(GeminiImageEvent::Failed { job, error });
                }
            }
            return;
        }
        tokio::time::sleep(COMPLETION_ACK_POLL_INTERVAL).await;
    }
}

async fn failed_job(jobs: &background::DesktopJobs, job_id: JobId) -> Option<JobSnapshot> {
    background::finish_failure(jobs, job_id)
        .await
        .filter(|job| job.state() == JobState::Failed)
}

pub(super) fn pending_completion(
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
) -> Option<PendingGeneratedImage> {
    runtime
        .access(|registry| Ok(registry.pending_by_job.get(&job_id).cloned()))
        .ok()
        .flatten()
}

pub(super) fn take_pending_completion(
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
) -> Option<PublishedGeneratedImage> {
    runtime
        .access(|registry| {
            Ok(registry
                .pending_by_job
                .remove(&job_id)
                .map(|pending| pending.published))
        })
        .ok()
        .flatten()
}

async fn fail_pending_completion(
    jobs: &background::DesktopJobs,
    services: &GeneratedImageServices,
    job_id: JobId,
) {
    fail_pending_completion_parts(
        jobs,
        &services.database,
        &services.media_server,
        &services.runtime,
        job_id,
    )
    .await;
}

pub(super) async fn fail_pending_completion_parts(
    jobs: &background::DesktopJobs,
    database: &Database,
    media_server: &MediaServer,
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
) {
    let _ =
        invalidate_pending_completion_parts(jobs, database, media_server, runtime, job_id).await;
}

fn send_cleanup_event(on_event: &Channel<GeminiImageEvent>, job: Option<JobSnapshot>) {
    match job {
        Some(job) if job.state() == JobState::Cancelled => {
            let _ = on_event.send(GeminiImageEvent::Cancelled { job });
        }
        Some(job) if job.state() == JobState::Succeeded => {}
        job => {
            let job = job.filter(|job| job.state() == JobState::Failed);
            let _ = on_event.send(GeminiImageEvent::Failed {
                job,
                error: generated_image_storage_error(),
            });
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct PublishedGeneratedImage {
    pub(super) image: PlayableGeneratedImage,
    pub(super) newly_created: bool,
}

#[derive(Clone)]
pub(super) struct PreparedGeneratedArtifact {
    pub(super) record: ArtifactRecord,
    pub(super) path: PathBuf,
}

impl fmt::Debug for PreparedGeneratedArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedGeneratedArtifact")
            .field("record", &self.record)
            .field("path", &"<redacted>")
            .finish()
    }
}

impl PreparedGeneratedArtifact {
    pub(super) const fn record(&self) -> &ArtifactRecord {
        &self.record
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

pub(super) enum CompletionLookup {
    Pending(PendingGeneratedImage),
    Completed(JobSnapshot),
    Missing,
}
