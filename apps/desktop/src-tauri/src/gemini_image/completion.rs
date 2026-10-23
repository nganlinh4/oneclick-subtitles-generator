//! Completion handshake: finalize, invalidate, recover and roll back generated images.

use osg_domain::{JobId, JobKind, JobSnapshot, JobState, JobUpdate, ProjectId};
use osg_gemini::{
    ApiKey, GeminiClient, ImageAspectRatio, ImageGenerateRequest, ImageSize, ReferenceImage,
};
use osg_infrastructure::secrets::CredentialPurpose;
use osg_infrastructure::storage::{ArtifactId, Database};
use osg_media_server::MediaServer;
use secrecy::ExposeSecret;
use tauri::State;
use uuid::Uuid;

use super::MAX_COMPLETED_IMAGE_RECEIPTS;
use super::format::{
    descriptor_from_record, generated_image_ownership_error, generated_image_storage_error,
    generated_image_unavailable, parse_artifact_id,
};
use super::generation::{
    CompletionLookup, PublishedGeneratedImage, pending_completion, take_pending_completion,
};
use super::publication::{
    publish_and_register_image, release_generated_image_playback, rollback_artifact,
};
use super::types::{
    CompletedGeneratedImage, GeminiImageCompleteRequest, GeminiImageStartRequest,
    GeneratedImageRegistry, GeneratedImageRuntime, GeneratedImageServices, PendingGeneratedImage,
};
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn gemini_image_complete(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeminiImageCompleteRequest,
) -> CommandResult<JobSnapshot> {
    let artifact_id = parse_artifact_id(&request.artifact_id)?;
    let runtime = runtime.inner().clone();
    let lookup = runtime.access(|registry| {
        if let Some(pending) = registry.pending_by_job.get(&request.job_id) {
            require_completion_ownership(
                &pending.published,
                request.project_id,
                artifact_id,
                request.playback_id,
            )?;
            return Ok(CompletionLookup::Pending(pending.clone()));
        }
        if let Some(completed) = registry.completed_by_job.get(&request.job_id) {
            require_completion_ownership(
                &completed.published,
                request.project_id,
                artifact_id,
                request.playback_id,
            )?;
            return Ok(CompletionLookup::Completed(completed.job.clone()));
        }
        Ok(CompletionLookup::Missing)
    })?;

    let pending = match lookup {
        CompletionLookup::Completed(job) => return Ok(job),
        CompletionLookup::Missing => {
            return recover_completed_image(
                &state.database,
                &state.jobs,
                &runtime,
                request.job_id,
                request.project_id,
                artifact_id,
                request.playback_id,
            )
            .await;
        }
        CompletionLookup::Pending(pending) => pending,
    };

    match background::apply_if_sequence(
        &state.jobs,
        request.job_id,
        pending.expected_job_sequence,
        JobUpdate::Succeed,
    )
    .await
    {
        Ok(job) => {
            finalize_pending_completion_parts(&state.database, &runtime, request.job_id, &job)
                .await?;
            Ok(job)
        }
        Err(error) => {
            if let Some(job) = background::snapshot(&state.jobs, request.job_id).await
                && job.state() == JobState::Succeeded
            {
                finalize_pending_completion_parts(&state.database, &runtime, request.job_id, &job)
                    .await?;
                return Ok(job);
            }
            if let Some(job) = invalidate_pending_completion_parts(
                &state.jobs,
                &state.database,
                &state.media_server,
                &runtime,
                request.job_id,
            )
            .await
                && job.state() == JobState::Succeeded
            {
                return Ok(job);
            }
            Err(error)
        }
    }
}

fn require_completion_ownership(
    published: &PublishedGeneratedImage,
    project_id: ProjectId,
    artifact_id: ArtifactId,
    playback_id: Uuid,
) -> CommandResult<()> {
    if published.image.artifact.project_id != project_id
        || published.image.artifact.artifact_id != artifact_id
        || published.image.playback.id != playback_id
    {
        return Err(generated_image_ownership_error());
    }
    Ok(())
}

pub(super) async fn finalize_pending_completion(
    jobs: &background::DesktopJobs,
    services: &GeneratedImageServices,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let job = background::snapshot(jobs, job_id)
        .await
        .filter(|job| job.state() == JobState::Succeeded)
        .ok_or_else(generated_image_unavailable)?;
    finalize_pending_completion_parts(&services.database, &services.runtime, job_id, &job).await?;
    Ok(job)
}

pub(super) async fn finalize_pending_completion_parts(
    database: &Database,
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
    job: &JobSnapshot,
) -> CommandResult<()> {
    if job.id() != job_id
        || job.kind() != JobKind::GenerateImage
        || job.state() != JobState::Succeeded
    {
        return Err(generated_image_unavailable());
    }
    let Some(pending) = pending_completion(runtime, job_id) else {
        return runtime.access(|registry| {
            registry
                .completed_by_job
                .get(&job_id)
                .filter(|completed| completed.job == *job)
                .map(|_| ())
                .ok_or_else(generated_image_unavailable)
        });
    };

    if pending.published.newly_created {
        let database = database.clone();
        let artifact_id = pending.published.image.artifact.artifact_id;
        let project_id = pending.published.image.artifact.project_id;
        tauri::async_runtime::spawn_blocking(move || {
            let record = database
                .mark_artifact_ready(artifact_id)
                .map_err(|_| generated_image_storage_error())?;
            descriptor_from_record(&record, project_id)?;
            Ok::<(), CommandError>(())
        })
        .await
        .map_err(|_| {
            CommandError::internal("The generated-image commit task stopped unexpectedly.")
        })??;
    }

    runtime.access(|registry| {
        if let Some(current) = registry.pending_by_job.get(&job_id)
            && !same_publication(&current.published, &pending.published)
        {
            return Err(generated_image_ownership_error());
        }
        registry.pending_by_job.remove(&job_id);
        registry.completed_by_job.insert(
            job_id,
            CompletedGeneratedImage {
                published: pending.published,
                job: job.clone(),
            },
        );
        while registry.completed_by_job.len() > MAX_COMPLETED_IMAGE_RECEIPTS {
            registry.completed_by_job.pop_first();
        }
        Ok(())
    })
}

pub(super) async fn invalidate_pending_completion(
    jobs: &background::DesktopJobs,
    services: &GeneratedImageServices,
    job_id: JobId,
) -> Option<JobSnapshot> {
    invalidate_pending_completion_parts(
        jobs,
        &services.database,
        &services.media_server,
        &services.runtime,
        job_id,
    )
    .await
}

pub(super) async fn invalidate_pending_completion_parts(
    jobs: &background::DesktopJobs,
    database: &Database,
    media_server: &MediaServer,
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
) -> Option<JobSnapshot> {
    let Some(pending) = pending_completion(runtime, job_id) else {
        return background::snapshot(jobs, job_id).await;
    };
    let mut job = background::snapshot(jobs, job_id).await;
    if let Some(current) = &job {
        match current.state() {
            JobState::Succeeded => {
                let _ = finalize_pending_completion_parts(database, runtime, job_id, current).await;
                return Some(current.clone());
            }
            JobState::Running if current.sequence() == pending.expected_job_sequence => {
                job = match background::apply_if_sequence(
                    jobs,
                    job_id,
                    pending.expected_job_sequence,
                    JobUpdate::Fail,
                )
                .await
                {
                    Ok(failed) => Some(failed),
                    Err(_) => background::snapshot(jobs, job_id).await,
                };
            }
            JobState::Cancelling => {
                job = background::finish_cancellation(jobs, job_id).await.ok();
                if job.is_none() {
                    job = background::snapshot(jobs, job_id).await;
                }
            }
            JobState::Queued
            | JobState::Running
            | JobState::Failed
            | JobState::Cancelled
            | JobState::Interrupted => {}
        }
    }

    if let Some(current) = &job
        && current.state() == JobState::Succeeded
    {
        let _ = finalize_pending_completion_parts(database, runtime, job_id, current).await;
        return Some(current.clone());
    }
    if job.as_ref().is_some_and(|current| {
        matches!(
            current.state(),
            JobState::Queued | JobState::Running | JobState::Succeeded
        )
    }) {
        return job;
    }

    if let Some(published) = take_pending_completion(runtime, job_id) {
        let _ = rollback_published_image(database, media_server, runtime, &published).await;
    }
    job
}

pub(super) async fn recover_completed_image(
    database: &Database,
    jobs: &background::DesktopJobs,
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
    project_id: ProjectId,
    artifact_id: ArtifactId,
    playback_id: Uuid,
) -> CommandResult<JobSnapshot> {
    let job = background::snapshot(jobs, job_id)
        .await
        .filter(|job| job.kind() == JobKind::GenerateImage && job.state() == JobState::Succeeded)
        .ok_or_else(generated_image_unavailable)?;
    let record = database
        .get_artifact(artifact_id)?
        .ok_or_else(generated_image_unavailable)?;
    descriptor_from_record(&record, project_id)?;
    let process_owns_playback = runtime.access(|registry| {
        Ok(registry.by_artifact.get(&artifact_id).is_some_and(|entry| {
            entry.project_id == project_id && entry.playback_ids.contains(&playback_id)
        }))
    })?;
    if record.job_id() != Some(job_id) && !process_owns_playback {
        return Err(generated_image_ownership_error());
    }
    Ok(job)
}

fn same_publication(left: &PublishedGeneratedImage, right: &PublishedGeneratedImage) -> bool {
    left.image.artifact.artifact_id == right.image.artifact.artifact_id
        && left.image.artifact.project_id == right.image.artifact.project_id
        && left.image.playback.id == right.image.playback.id
        && left.newly_created == right.newly_created
}

pub(super) async fn run_image(
    services: &GeneratedImageServices,
    request: GeminiImageStartRequest,
    reference: ReferenceImage,
    job_id: JobId,
    expected_job_sequence: u64,
    cancellation: &osg_gemini::CancellationToken,
) -> CommandResult<PublishedGeneratedImage> {
    let credential_id = request.credential_id;
    let credentials = services.credentials.clone();
    let secret = tauri::async_runtime::spawn_blocking(move || {
        credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map_err(|_| CommandError::internal("The credential task stopped unexpectedly."))??;
    if cancellation.is_cancelled() {
        return Err(osg_gemini::Error::Cancelled.into());
    }

    let client = GeminiClient::new(ApiKey::new(secret.expose_secret().to_owned())?)?;
    let image = client
        .generate_image(
            ImageGenerateRequest {
                model: request.model,
                prompt: request.prompt,
                reference,
                aspect_ratio: ImageAspectRatio::Landscape16By9,
                image_size: ImageSize::OneK,
            },
            cancellation,
        )
        .await?;
    if cancellation.is_cancelled() {
        return Err(osg_gemini::Error::Cancelled.into());
    }

    let mime_type = image.mime_type();
    let bytes = image.bytes().clone();
    let project_id = request.project_id;
    let publish_database = services.database.clone();
    let publish_media_server = services.media_server.clone();
    let publish_runtime = services.runtime.clone();
    let publication_cancellation = cancellation.clone();
    let published = tauri::async_runtime::spawn_blocking(move || {
        publish_runtime.access(|registry| {
            if registry.pending_by_job.contains_key(&job_id)
                || registry.completed_by_job.contains_key(&job_id)
            {
                return Err(generated_image_storage_error());
            }
            let published = publish_and_register_image(
                &publish_database,
                &publish_media_server,
                registry,
                project_id,
                job_id,
                mime_type,
                &bytes,
            )?;
            if publication_cancellation.is_cancelled() {
                rollback_published_image_locked(
                    &publish_database,
                    &publish_media_server,
                    registry,
                    &published,
                )?;
                return Err(osg_gemini::Error::Cancelled.into());
            }
            registry.pending_by_job.insert(
                job_id,
                PendingGeneratedImage {
                    published: published.clone(),
                    expected_job_sequence,
                },
            );
            Ok(published)
        })
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image storage task stopped unexpectedly.")
    })??;

    Ok(published)
}

pub(super) async fn rollback_published_image(
    database: &Database,
    media_server: &MediaServer,
    runtime: &GeneratedImageRuntime,
    published: &PublishedGeneratedImage,
) -> CommandResult<()> {
    let database = database.clone();
    let media_server = media_server.clone();
    let runtime = runtime.clone();
    let artifact_id = published.image.artifact.artifact_id;
    let project_id = published.image.artifact.project_id;
    let playback_id = published.image.playback.id;
    let newly_created = published.newly_created;
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            rollback_published_image_locked_parts(
                &database,
                &media_server,
                registry,
                project_id,
                artifact_id,
                playback_id,
                newly_created,
            )
        })
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image rollback task stopped unexpectedly.")
    })?
}

fn rollback_published_image_locked(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    published: &PublishedGeneratedImage,
) -> CommandResult<()> {
    rollback_published_image_locked_parts(
        database,
        media_server,
        registry,
        published.image.artifact.project_id,
        published.image.artifact.artifact_id,
        published.image.playback.id,
        published.newly_created,
    )
}

fn rollback_published_image_locked_parts(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
    artifact_id: ArtifactId,
    playback_id: Uuid,
    newly_created: bool,
) -> CommandResult<()> {
    let _ = release_generated_image_playback(
        registry,
        media_server,
        project_id,
        artifact_id,
        playback_id,
    )?;
    if newly_created {
        rollback_artifact(database, artifact_id)?;
    }
    Ok(())
}
