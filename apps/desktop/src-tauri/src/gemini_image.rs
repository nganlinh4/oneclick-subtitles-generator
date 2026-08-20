use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_domain::{AssetId, JobId, JobKind, JobSnapshot, JobState, JobUpdate, ProjectId};
use osg_gemini::{
    ApiKey, GeminiClient, ImageAspectRatio, ImageGenerateRequest, ImageModel, ImageSize,
    ReferenceImage,
};
use osg_infrastructure::secrets::{
    CredentialId, CredentialPurpose, CredentialService, KeyringCredentialBackend,
};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRecord,
    ArtifactRegistration, ArtifactRetention, ArtifactState, ContentHash, Database,
    ResolvedArtifact,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::background;
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::image_blob::ImageBlobStore;
use crate::media_export::copy_export;
use crate::state::DesktopState;

const MAX_GENERATED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROJECT_IMAGES: usize = 64;
const MAX_EXPORT_NAME_BYTES: usize = 240;
const ARTIFACT_KIND_PREFIX: &str = "generatedBackgroundImage:";
const COMPLETION_ACK_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETION_ACK_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_COMPLETED_IMAGE_RECEIPTS: usize = 128;
const COMMIT_ON_JOB_SUCCESS_METADATA_KEY: &str = "commitOnJobSuccess";

#[derive(Debug)]
struct ProjectPlaybacks {
    project_id: ProjectId,
    playback_ids: BTreeSet<Uuid>,
}

#[derive(Debug, Clone)]
struct PendingGeneratedImage {
    published: PublishedGeneratedImage,
    expected_job_sequence: u64,
}

#[derive(Debug, Clone)]
struct CompletedGeneratedImage {
    published: PublishedGeneratedImage,
    job: JobSnapshot,
}

#[derive(Debug, Default)]
struct GeneratedImageRegistry {
    by_artifact: BTreeMap<ArtifactId, ProjectPlaybacks>,
    pending_by_job: BTreeMap<JobId, PendingGeneratedImage>,
    completed_by_job: BTreeMap<JobId, CompletedGeneratedImage>,
}

#[derive(Clone, Default)]
pub(crate) struct GeneratedImageRuntime(Arc<Mutex<GeneratedImageRegistry>>);

impl fmt::Debug for GeneratedImageRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let artifact_count = self
            .0
            .lock()
            .map_or(0, |registry| registry.by_artifact.len());
        formatter
            .debug_struct("GeneratedImageRuntime")
            .field("artifact_count", &artifact_count)
            .finish_non_exhaustive()
    }
}

impl GeneratedImageRuntime {
    fn access<T>(
        &self,
        operation: impl FnOnce(&mut GeneratedImageRegistry) -> CommandResult<T>,
    ) -> CommandResult<T> {
        let mut registry = self.0.lock().map_err(|_| generated_image_storage_error())?;
        operation(&mut registry)
    }
}

#[derive(Clone)]
struct GeneratedImageServices {
    credentials: CredentialService<KeyringCredentialBackend>,
    database: Database,
    media_server: MediaServer,
    runtime: GeneratedImageRuntime,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "the prompt is private user content"
)]
pub(crate) struct GeminiImageStartRequest {
    credential_id: CredentialId,
    model: ImageModel,
    prompt: String,
    reference_asset_id: AssetId,
    project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageDescriptor {
    artifact_id: ArtifactId,
    project_id: ProjectId,
    mime_type: &'static str,
    size_bytes: u64,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayableGeneratedImage {
    artifact: GeneratedImageDescriptor,
    playback: RegisteredMedia,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GeminiImageEvent {
    Prepared {
        job: JobSnapshot,
        image: PlayableGeneratedImage,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_field_names,
    reason = "the explicit ID suffixes are part of the audited cross-boundary request schema"
)]
pub(crate) struct GeminiImageCompleteRequest {
    job_id: JobId,
    project_id: ProjectId,
    artifact_id: String,
    playback_id: Uuid,
}

impl fmt::Debug for GeminiImageCompleteRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiImageCompleteRequest")
            .field("job_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .field("playback_id", &"<opaque>")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedImageProjectRequest {
    project_id: ProjectId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedImageArtifactRequest {
    project_id: ProjectId,
    artifact_id: String,
}

impl fmt::Debug for GeneratedImageArtifactRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImageArtifactRequest")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedImageExportRequest {
    project_id: ProjectId,
    artifact_id: String,
    suggested_name: String,
}

impl fmt::Debug for GeneratedImageExportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImageExportRequest")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .field("suggested_name", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_field_names,
    reason = "the explicit ID suffixes are part of the audited cross-boundary request schema"
)]
pub(crate) struct GeneratedImagePlaybackReleaseRequest {
    project_id: ProjectId,
    artifact_id: String,
    playback_id: Uuid,
}

impl fmt::Debug for GeneratedImagePlaybackReleaseRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImagePlaybackReleaseRequest")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .field("playback_id", &"<opaque>")
            .finish()
    }
}

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

fn pending_completion(
    runtime: &GeneratedImageRuntime,
    job_id: JobId,
) -> Option<PendingGeneratedImage> {
    runtime
        .access(|registry| Ok(registry.pending_by_job.get(&job_id).cloned()))
        .ok()
        .flatten()
}

fn take_pending_completion(
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

async fn fail_pending_completion_parts(
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
struct PublishedGeneratedImage {
    image: PlayableGeneratedImage,
    newly_created: bool,
}

#[derive(Clone)]
struct PreparedGeneratedArtifact {
    record: ArtifactRecord,
    path: PathBuf,
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
    const fn record(&self) -> &ArtifactRecord {
        &self.record
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

enum CompletionLookup {
    Pending(PendingGeneratedImage),
    Completed(JobSnapshot),
    Missing,
}

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

async fn finalize_pending_completion(
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

async fn finalize_pending_completion_parts(
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

async fn invalidate_pending_completion(
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

async fn invalidate_pending_completion_parts(
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

async fn recover_completed_image(
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

async fn run_image(
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

async fn rollback_published_image(
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

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_list(
    state: State<'_, DesktopState>,
    request: GeneratedImageProjectRequest,
) -> CommandResult<Vec<GeneratedImageDescriptor>> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_generated_images(&database, request.project_id)
    })
    .await
    .map_err(|_| CommandError::internal("The generated-image list task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_resolve(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageArtifactRequest,
) -> CommandResult<PlayableGeneratedImage> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            let artifact_id = parse_artifact_id(&request.artifact_id)?;
            let resolved = resolve_owned_image(&database, request.project_id, artifact_id)?
                .ok_or_else(generated_image_unavailable)?;
            register_playable_image_record(
                &media_server,
                registry,
                resolved.record(),
                resolved.path(),
                false,
            )
        })
    })
    .await
    .map_err(|_| CommandError::internal("The generated-image resolve task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and State as owned command extractors"
)]
pub(crate) async fn generated_image_export(
    app: AppHandle,
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageExportRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let runtime = runtime.inner().clone();
    let plan = tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|_| prepare_image_export(&database, request))
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image export lookup stopped unexpectedly.")
    })??;

    let selected = dialog_paths::save_file(
        &app,
        "Export generated image",
        &plan.suggested_name,
        plan.format.label(),
        &[plan.format.extension()],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case(plan.format.extension()))
    {
        return Err(CommandError::invalid_input(
            "The generated-image export file type is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        copy_export(
            plan.staging.path(),
            &destination,
            plan.size_bytes,
            || false,
            |_, _| Ok(()),
        )
        .map_err(|_| generated_image_export_error())
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image export task stopped unexpectedly.")
    })??;
    Ok(true)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_delete(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageArtifactRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            let artifact_id = parse_artifact_id(&request.artifact_id)?;
            delete_generated_image(
                &database,
                &media_server,
                registry,
                request.project_id,
                artifact_id,
            )
        })
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image deletion task stopped unexpectedly.")
    })?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_clear(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageProjectRequest,
) -> CommandResult<u64> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            clear_generated_images(&database, &media_server, registry, request.project_id)
        })
    })
    .await
    .map_err(|_| CommandError::internal("The generated-image clear task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn generated_image_playback_release(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImagePlaybackReleaseRequest,
) -> CommandResult<bool> {
    runtime.access(|registry| {
        let artifact_id = parse_artifact_id(&request.artifact_id)?;
        release_generated_image_playback(
            registry,
            &state.media_server,
            request.project_id,
            artifact_id,
            request.playback_id,
        )
    })
}

fn ensure_project_exists(database: &Database, project_id: ProjectId) -> CommandResult<()> {
    database
        .load_project(project_id)?
        .map(|_| ())
        .ok_or_else(|| CommandError::invalid_input("The generated-image project is unavailable."))
}

fn ensure_project_accepts_generated_image(
    database: &Database,
    project_id: ProjectId,
    provisional_count: usize,
) -> CommandResult<ArtifactKind> {
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let committed_count = database
        .list_ready_artifacts(project_id, &kind, MAX_PROJECT_IMAGES)?
        .len();
    if committed_count.saturating_add(provisional_count) >= MAX_PROJECT_IMAGES {
        return Err(generated_image_project_full());
    }
    Ok(kind)
}

fn pending_new_image_count(registry: &GeneratedImageRegistry, project_id: ProjectId) -> usize {
    registry
        .pending_by_job
        .values()
        .filter(|pending| {
            pending.published.newly_created
                && pending.published.image.artifact.project_id == project_id
        })
        .count()
}

fn list_generated_images(
    database: &Database,
    project_id: ProjectId,
) -> CommandResult<Vec<GeneratedImageDescriptor>> {
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let records = database.list_ready_artifacts(project_id, &kind, MAX_PROJECT_IMAGES)?;
    let mut images = Vec::with_capacity(records.len());
    for record in records {
        let Some(resolved) = database.resolve_artifact(record.id())? else {
            continue;
        };
        images.push(descriptor_from_record(resolved.record(), project_id)?);
    }
    Ok(images)
}

fn resolve_owned_image(
    database: &Database,
    project_id: ProjectId,
    artifact_id: ArtifactId,
) -> CommandResult<Option<ResolvedArtifact>> {
    let Some(record) = database.get_artifact(artifact_id)? else {
        return Ok(None);
    };
    descriptor_from_record(&record, project_id)?;
    database.resolve_artifact(artifact_id).map_err(Into::into)
}

fn publish_and_register_image(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
    job_id: JobId,
    mime_type: &'static str,
    bytes: &[u8],
) -> CommandResult<PublishedGeneratedImage> {
    let provisional_count = pending_new_image_count(registry, project_id);
    let (prepared, newly_created) = publish_generated_image_with_pending_count(
        database,
        project_id,
        job_id,
        mime_type,
        bytes,
        provisional_count,
        write_staged_image,
    )?;
    let artifact_id = prepared.record().id();
    match register_playable_image_record(
        media_server,
        registry,
        prepared.record(),
        prepared.path(),
        newly_created,
    ) {
        Ok(image) => Ok(PublishedGeneratedImage {
            image,
            newly_created,
        }),
        Err(error) => {
            if newly_created {
                rollback_artifact(database, artifact_id)?;
            }
            Err(error)
        }
    }
}

#[cfg(test)]
fn publish_generated_image(
    database: &Database,
    project_id: ProjectId,
    job_id: JobId,
    mime_type: &'static str,
    bytes: &[u8],
    writer: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> CommandResult<(PreparedGeneratedArtifact, bool)> {
    publish_generated_image_with_pending_count(
        database, project_id, job_id, mime_type, bytes, 0, writer,
    )
}

#[allow(
    clippy::too_many_lines,
    reason = "the provisional publication transaction keeps validation, dedup ownership, and rollback adjacent"
)]
fn publish_generated_image_with_pending_count(
    database: &Database,
    project_id: ProjectId,
    job_id: JobId,
    mime_type: &'static str,
    bytes: &[u8],
    provisional_count: usize,
    writer: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> CommandResult<(PreparedGeneratedArtifact, bool)> {
    validate_generated_image(mime_type, bytes)?;
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let content_hash = ContentHash::digest(bytes);
    let size_bytes = u64::try_from(bytes.len()).map_err(|_| generated_image_storage_error())?;
    let draft = ArtifactDraft::new(
        kind.clone(),
        content_hash,
        size_bytes,
        serde_json::json!({
            "mimeType": mime_type,
            COMMIT_ON_JOB_SUCCESS_METADATA_KEY: true,
        }),
    )?
    .with_project(project_id)
    .with_job(job_id);

    for attempt in 0..2 {
        let registration = match database.register_artifact(&draft)? {
            ArtifactRegistration::Pending(record) => ArtifactRegistration::Existing(record),
            registration => registration,
        };
        match registration {
            ArtifactRegistration::Existing(record) => {
                if !is_owned_generated_image_record(
                    &record,
                    project_id,
                    &kind,
                    content_hash,
                    size_bytes,
                ) {
                    return Err(generated_image_ownership_error());
                }
                match record.state() {
                    ArtifactState::Ready => {
                        descriptor_from_record(&record, project_id)?;
                        let resolved = database
                            .resolve_artifact(record.id())?
                            .ok_or_else(generated_image_storage_error)?;
                        return Ok((
                            PreparedGeneratedArtifact {
                                record: resolved.record().clone(),
                                path: resolved.path().to_path_buf(),
                            },
                            false,
                        ));
                    }
                    ArtifactState::Pending => {
                        descriptor_from_prepared_record(&record, project_id)?;
                        let owner = record.job_id().ok_or_else(generated_image_storage_error)?;
                        let owner_job = database.get_job(owner)?;
                        if owner_job
                            .as_ref()
                            .is_some_and(|job| job.state() == JobState::Succeeded)
                        {
                            let ready = database
                                .mark_artifact_ready(record.id())
                                .map_err(|_| generated_image_storage_error())?;
                            descriptor_from_record(&ready, project_id)?;
                            let resolved = database
                                .resolve_artifact(record.id())?
                                .ok_or_else(generated_image_storage_error)?;
                            return Ok((
                                PreparedGeneratedArtifact {
                                    record: resolved.record().clone(),
                                    path: resolved.path().to_path_buf(),
                                },
                                false,
                            ));
                        }
                        let owner_terminal = owner_job
                            .as_ref()
                            .is_none_or(|job| job.state().is_terminal());
                        if owner_terminal && attempt == 0 {
                            let _ = database.remove_artifact(record.id())?;
                            continue;
                        }
                        return Err(generated_image_in_progress());
                    }
                    // Storage recycles a failed row into a fresh staging reservation, so
                    // a registration that reports an existing record is never failed.
                    ArtifactState::Failed => return Err(generated_image_storage_error()),
                }
            }
            ArtifactRegistration::Staging(staging) => {
                let artifact_id = staging.record().id();
                if let Err(error) =
                    ensure_project_accepts_generated_image(database, project_id, provisional_count)
                {
                    rollback_artifact(database, artifact_id)?;
                    return Err(error);
                }
                let publication = finish_generated_image_preparation(
                    staging.record(),
                    staging.path(),
                    project_id,
                    bytes,
                    writer,
                );
                if let Ok(prepared) = publication {
                    return Ok((prepared, true));
                }
                rollback_artifact(database, artifact_id)?;
                return Err(generated_image_storage_error());
            }
            ArtifactRegistration::Pending(_) => {
                unreachable!("pending registrations are normalized above")
            }
        }
    }
    Err(generated_image_storage_error())
}

fn is_owned_generated_image_record(
    record: &ArtifactRecord,
    project_id: ProjectId,
    kind: &ArtifactKind,
    content_hash: ContentHash,
    size_bytes: u64,
) -> bool {
    record.project_id() == Some(project_id)
        && record.kind() == kind
        && record.content_hash() == content_hash
        && record.size_bytes() == size_bytes
        && record.retention() == ArtifactRetention::Durable
}

fn finish_generated_image_preparation(
    record: &ArtifactRecord,
    staging_path: &Path,
    project_id: ProjectId,
    bytes: &[u8],
    writer: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> CommandResult<PreparedGeneratedArtifact> {
    writer(staging_path, bytes).map_err(|_| generated_image_storage_error())?;
    validate_prepared_image_file(staging_path, record)?;
    descriptor_from_prepared_record(record, project_id)?;
    Ok(PreparedGeneratedArtifact {
        record: record.clone(),
        path: staging_path.to_path_buf(),
    })
}

fn validate_prepared_image_file(path: &Path, record: &ArtifactRecord) -> CommandResult<()> {
    let file = fs::File::open(path).map_err(|_| generated_image_storage_error())?;
    let metadata = file
        .metadata()
        .map_err(|_| generated_image_storage_error())?;
    if metadata.len() != record.size_bytes()
        || ContentHash::digest_reader(BufReader::new(file))
            .map_err(|_| generated_image_storage_error())?
            != record.content_hash()
    {
        return Err(generated_image_storage_error());
    }
    Ok(())
}

fn write_staged_image(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut target = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)?;
    target.write_all(bytes)?;
    target.flush()?;
    target.sync_all()
}

fn rollback_artifact(database: &Database, artifact_id: ArtifactId) -> CommandResult<()> {
    if let Some(record) = database.get_artifact(artifact_id)? {
        if record.state() == ArtifactState::Pending
            && let Ok(code) = ArtifactFailureCode::new("generatedImagePublish")
        {
            database.mark_artifact_failed(artifact_id, &code)?;
        }
        let _ = database.remove_artifact(artifact_id)?;
    }
    Ok(())
}

#[cfg(test)]
fn register_playable_image(
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    resolved: &ResolvedArtifact,
) -> CommandResult<PlayableGeneratedImage> {
    register_playable_image_record(
        media_server,
        registry,
        resolved.record(),
        resolved.path(),
        false,
    )
}

fn register_playable_image_record(
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    record: &ArtifactRecord,
    path: &Path,
    allow_pending: bool,
) -> CommandResult<PlayableGeneratedImage> {
    let project_id = record
        .project_id()
        .ok_or_else(generated_image_storage_error)?;
    let artifact = if allow_pending {
        descriptor_from_prepared_record(record, project_id)?
    } else {
        descriptor_from_record(record, project_id)?
    };
    let playback = media_server.register_owned_image_file(
        path,
        artifact.mime_type,
        project_id.into_uuid(),
        MAX_GENERATED_IMAGE_BYTES,
    )?;
    if playback.byte_length != artifact.size_bytes || playback.mime_type != artifact.mime_type {
        let _ = media_server.unregister_owned_image(playback.id, project_id.into_uuid());
        return Err(generated_image_storage_error());
    }
    let entry = registry
        .by_artifact
        .entry(artifact.artifact_id)
        .or_insert_with(|| ProjectPlaybacks {
            project_id,
            playback_ids: BTreeSet::new(),
        });
    if entry.project_id != project_id {
        let _ = media_server.unregister_owned_image(playback.id, project_id.into_uuid());
        return Err(generated_image_ownership_error());
    }
    entry.playback_ids.insert(playback.id);
    Ok(PlayableGeneratedImage { artifact, playback })
}

fn release_artifact_playbacks(
    registry: &mut GeneratedImageRegistry,
    media_server: &MediaServer,
    artifact_id: ArtifactId,
) -> CommandResult<()> {
    let Some(entry) = registry.by_artifact.get(&artifact_id) else {
        return Ok(());
    };
    for playback_id in &entry.playback_ids {
        let _ = media_server.unregister_owned_image(*playback_id, entry.project_id.into_uuid())?;
    }
    registry.by_artifact.remove(&artifact_id);
    Ok(())
}

fn release_generated_image_playback(
    registry: &mut GeneratedImageRegistry,
    media_server: &MediaServer,
    project_id: ProjectId,
    artifact_id: ArtifactId,
    playback_id: Uuid,
) -> CommandResult<bool> {
    let Some(entry) = registry.by_artifact.get_mut(&artifact_id) else {
        return Ok(false);
    };
    if entry.project_id != project_id {
        return Err(generated_image_ownership_error());
    }
    if !entry.playback_ids.contains(&playback_id) {
        return Ok(false);
    }
    let released = media_server.unregister_owned_image(playback_id, project_id.into_uuid())?;
    entry.playback_ids.remove(&playback_id);
    if entry.playback_ids.is_empty() {
        registry.by_artifact.remove(&artifact_id);
    }
    Ok(released)
}

fn delete_generated_image(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
    artifact_id: ArtifactId,
) -> CommandResult<bool> {
    let Some(resolved) = resolve_owned_image(database, project_id, artifact_id)? else {
        return Ok(false);
    };
    drop(resolved);
    release_artifact_playbacks(registry, media_server, artifact_id)?;
    database
        .remove_artifact(artifact_id)
        .map(|record| record.is_some())
        .map_err(Into::into)
}

fn clear_generated_images(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
) -> CommandResult<u64> {
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let records = database.list_ready_artifacts(project_id, &kind, MAX_PROJECT_IMAGES)?;
    let mut removed = 0_u64;
    for record in records {
        descriptor_from_record(&record, project_id)?;
        release_artifact_playbacks(registry, media_server, record.id())?;
        if database.remove_artifact(record.id())?.is_some() {
            removed = removed.saturating_add(1);
        }
    }
    Ok(removed)
}

fn artifact_kind(project_id: ProjectId) -> CommandResult<ArtifactKind> {
    let compact = project_id.to_string().replace('-', "");
    ArtifactKind::new(format!("{ARTIFACT_KIND_PREFIX}{compact}"))
        .map_err(|_| generated_image_storage_error())
}

fn descriptor_from_record(
    record: &ArtifactRecord,
    expected_project_id: ProjectId,
) -> CommandResult<GeneratedImageDescriptor> {
    descriptor_from_record_in_state(record, expected_project_id, ArtifactState::Ready)
}

fn descriptor_from_prepared_record(
    record: &ArtifactRecord,
    expected_project_id: ProjectId,
) -> CommandResult<GeneratedImageDescriptor> {
    descriptor_from_record_in_state(record, expected_project_id, ArtifactState::Pending)
}

fn descriptor_from_record_in_state(
    record: &ArtifactRecord,
    expected_project_id: ProjectId,
    expected_state: ArtifactState,
) -> CommandResult<GeneratedImageDescriptor> {
    if record.project_id() != Some(expected_project_id)
        || record.kind() != &artifact_kind(expected_project_id)?
        || record.state() != expected_state
        || record.size_bytes() == 0
        || record.size_bytes() > MAX_GENERATED_IMAGE_BYTES as u64
    {
        return Err(generated_image_ownership_error());
    }
    let metadata = record
        .metadata()
        .as_object()
        .ok_or_else(generated_image_storage_error)?;
    let commit_on_job_success = metadata
        .get(COMMIT_ON_JOB_SUCCESS_METADATA_KEY)
        .and_then(serde_json::Value::as_bool);
    let metadata_is_valid = match expected_state {
        ArtifactState::Pending => {
            metadata.len() == 2 && commit_on_job_success == Some(true) && record.job_id().is_some()
        }
        ArtifactState::Ready => {
            (metadata.len() == 1 && commit_on_job_success.is_none())
                || (metadata.len() == 2
                    && commit_on_job_success == Some(true)
                    && record.job_id().is_some())
        }
        ArtifactState::Failed => false,
    };
    if !metadata_is_valid {
        return Err(generated_image_storage_error());
    }
    let mime_type = metadata
        .get("mimeType")
        .and_then(serde_json::Value::as_str)
        .and_then(canonical_image_mime)
        .ok_or_else(generated_image_storage_error)?;
    Ok(GeneratedImageDescriptor {
        artifact_id: record.id(),
        project_id: expected_project_id,
        mime_type,
        size_bytes: record.size_bytes(),
        created_at_ms: record.created_at_ms(),
    })
}

fn validate_generated_image(mime_type: &str, bytes: &[u8]) -> CommandResult<()> {
    if bytes.is_empty()
        || bytes.len() > MAX_GENERATED_IMAGE_BYTES
        || canonical_image_mime(mime_type).is_none()
        || !matches_image_signature(mime_type, bytes)
    {
        return Err(CommandError::invalid_input(
            "The generated image is empty, unsupported, or malformed.",
        ));
    }
    Ok(())
}

fn canonical_image_mime(value: &str) -> Option<&'static str> {
    match value {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn matches_image_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[derive(Debug, Clone, Copy)]
enum GeneratedImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl GeneratedImageFormat {
    fn from_mime_type(value: &str) -> Option<Self> {
        match value {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG image",
            Self::Jpeg => "JPEG image",
            Self::Webp => "WebP image",
        }
    }
}

struct GeneratedImageExportPlan {
    staging: tempfile::NamedTempFile,
    suggested_name: String,
    format: GeneratedImageFormat,
    size_bytes: u64,
}

impl fmt::Debug for GeneratedImageExportPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImageExportPlan")
            .field("staging", &"<redacted>")
            .field("suggested_name", &"<redacted>")
            .field("format", &self.format)
            .field("size_bytes", &self.size_bytes)
            .finish()
    }
}

fn prepare_image_export(
    database: &Database,
    request: GeneratedImageExportRequest,
) -> CommandResult<GeneratedImageExportPlan> {
    let artifact_id = parse_artifact_id(&request.artifact_id)?;
    let resolved = resolve_owned_image(database, request.project_id, artifact_id)?
        .ok_or_else(generated_image_unavailable)?;
    let descriptor = descriptor_from_record(resolved.record(), request.project_id)?;
    let format = GeneratedImageFormat::from_mime_type(descriptor.mime_type)
        .ok_or_else(generated_image_storage_error)?;
    if !is_safe_export_name(&request.suggested_name, format.extension()) {
        return Err(CommandError::invalid_input(
            "The generated-image export name is invalid.",
        ));
    }
    let directory = resolved
        .path()
        .parent()
        .ok_or_else(generated_image_export_error)?;
    let mut staging = tempfile::Builder::new()
        .prefix(".osg-image-export-")
        .suffix(".part")
        .tempfile_in(directory)
        .map_err(|_| generated_image_export_error())?;
    copy_verified_image(
        resolved.path(),
        staging.as_file_mut(),
        descriptor.size_bytes,
        resolved.record().content_hash(),
    )?;
    staging
        .as_file()
        .sync_all()
        .map_err(|_| generated_image_export_error())?;
    Ok(GeneratedImageExportPlan {
        staging,
        suggested_name: request.suggested_name,
        format,
        size_bytes: descriptor.size_bytes,
    })
}

fn copy_verified_image(
    source_path: &Path,
    output: &mut impl Write,
    expected_bytes: u64,
    expected_hash: ContentHash,
) -> CommandResult<()> {
    let mut source = fs::File::open(source_path)
        .map(BufReader::new)
        .map_err(|_| generated_image_export_error())?;
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let mut hasher = blake3::Hasher::new();
    let mut copied = 0_u64;
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|_| generated_image_export_error())?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(count).map_err(|_| generated_image_export_error())?)
            .filter(|bytes| *bytes <= expected_bytes)
            .ok_or_else(generated_image_export_error)?;
        hasher.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|_| generated_image_export_error())?;
    }
    if copied != expected_bytes || hasher.finalize().as_bytes() != expected_hash.as_bytes() {
        return Err(generated_image_export_error());
    }
    Ok(())
}

fn is_safe_export_name(value: &str, expected_extension: &str) -> bool {
    if value.is_empty() || value.len() > MAX_EXPORT_NAME_BYTES || !value.is_ascii() {
        return false;
    }
    value.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty()
            && !stem.ends_with('.')
            && extension.eq_ignore_ascii_case(expected_extension)
            && stem
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    })
}

fn reference_unavailable() -> CommandError {
    CommandError::invalid_input("The reference image is no longer available.")
}

fn parse_artifact_id(value: &str) -> CommandResult<ArtifactId> {
    let uuid = Uuid::parse_str(value).map_err(|_| {
        CommandError::invalid_input("The generated-image artifact identifier is invalid.")
    })?;
    ArtifactId::from_uuid(uuid).map_err(|_| {
        CommandError::invalid_input("The generated-image artifact identifier is invalid.")
    })
}

fn generated_image_unavailable() -> CommandError {
    CommandError::invalid_input("The generated image is unavailable.")
}

fn generated_image_ownership_error() -> CommandError {
    CommandError::invalid_input("The generated image does not belong to this project.")
}

fn generated_image_storage_error() -> CommandError {
    CommandError::internal("The generated image could not be stored durably.")
}

fn generated_image_project_full() -> CommandError {
    CommandError::invalid_input(
        "This project already contains the maximum number of generated images.",
    )
}

fn generated_image_in_progress() -> CommandError {
    CommandError::invalid_input("An identical generated image is still awaiting acknowledgement.")
}

fn generated_image_export_error() -> CommandError {
    CommandError::internal("The generated image could not be exported.")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use osg_application::JobRegistry;
    use osg_domain::{JobKind, JobSnapshot, JobState, ProjectMetadata};
    use serde_json::json;

    use super::*;

    fn png(label: &[u8]) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(label);
        bytes
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, Database, ProjectId, JobId) {
        let directory = tempfile::tempdir().expect("temporary data");
        let database_path = directory.path().join("db/osg.sqlite3");
        let database = Database::open(&database_path).expect("database");
        let project = ProjectMetadata::new("image project").expect("project");
        let project_id = project.id();
        database.create_project(&project).expect("create project");
        let mut job = JobSnapshot::new(JobKind::GenerateImage);
        job.start().expect("running job");
        let job_id = job.id();
        database
            .create_job(&JobSnapshot::with_id(job_id, JobKind::GenerateImage))
            .expect("job");
        (directory, database_path, database, project_id, job_id)
    }

    fn succeed_job(database: &Database, job_id: JobId) -> JobSnapshot {
        let registry = JobRegistry::restore(Arc::new(database.clone())).expect("job registry");
        let current = registry.get(job_id).expect("job lookup");
        let running = match current.snapshot().state() {
            JobState::Queued => registry.apply(job_id, JobUpdate::Start).expect("start job"),
            JobState::Running => current,
            JobState::Succeeded => return current.snapshot().clone(),
            state => panic!("job cannot succeed from {state:?}"),
        };
        registry
            .apply_if_sequence(job_id, running.snapshot().sequence(), JobUpdate::Succeed)
            .expect("succeed job")
            .snapshot()
            .clone()
    }

    fn commit_prepared(
        database: &Database,
        prepared: &PreparedGeneratedArtifact,
    ) -> ResolvedArtifact {
        database
            .mark_artifact_ready(prepared.record().id())
            .expect("commit artifact");
        database
            .resolve_artifact(prepared.record().id())
            .expect("resolve committed artifact")
            .expect("committed artifact")
    }

    fn stage_pending_image(
        database: &Database,
        media_server: &MediaServer,
        runtime: &GeneratedImageRuntime,
        project_id: ProjectId,
        job_id: JobId,
        expected_job_sequence: u64,
        bytes: &[u8],
    ) -> PublishedGeneratedImage {
        runtime
            .access(|registry| {
                let published = publish_and_register_image(
                    database,
                    media_server,
                    registry,
                    project_id,
                    job_id,
                    "image/png",
                    bytes,
                )?;
                registry.pending_by_job.insert(
                    job_id,
                    PendingGeneratedImage {
                        published: published.clone(),
                        expected_job_sequence,
                    },
                );
                Ok(published)
            })
            .expect("stage pending image")
    }

    #[test]
    fn request_accepts_only_the_stable_model_and_requires_a_project() {
        let credential_id = osg_infrastructure::secrets::CredentialId::new();
        let reference_asset_id = osg_domain::AssetId::new();
        let project_id = ProjectId::new();
        assert!(
            serde_json::from_value::<GeminiImageStartRequest>(json!({
                "credentialId": credential_id,
                "model": "gemini-3.1-flash-image",
                "prompt": "generate",
                "referenceAssetId": reference_asset_id,
                "projectId": project_id,
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<GeminiImageStartRequest>(json!({
                "credentialId": credential_id,
                "model": "gemini-3.1-flash-image",
                "prompt": "generate",
                "referenceAssetId": reference_asset_id,
            }))
            .is_err()
        );
    }

    #[test]
    fn prepared_metadata_contains_no_image_bytes_paths_or_private_prompt() {
        let mut running = JobSnapshot::new(JobKind::GenerateImage);
        running.start().expect("start");
        assert_eq!(running.state(), JobState::Running);
        let project_id = ProjectId::new();
        let playback_id = Uuid::new_v4();
        let value = serde_json::to_value(GeminiImageEvent::Prepared {
            job: running,
            image: PlayableGeneratedImage {
                artifact: GeneratedImageDescriptor {
                    artifact_id: ArtifactId::new(),
                    project_id,
                    mime_type: "image/png",
                    size_bytes: 1024,
                    created_at_ms: 1,
                },
                playback: RegisteredMedia {
                    id: playback_id,
                    playback_url: format!(
                        "http://127.0.0.1:43210/asset/{}?token={}",
                        playback_id,
                        "a".repeat(64)
                    ),
                    mime_type: "image/png".to_owned(),
                    byte_length: 1024,
                },
            },
        })
        .expect("serialize");
        let serialized = value.to_string();
        for forbidden in [
            "base64",
            "bytes\":\"",
            "data:image",
            "private prompt",
            "path",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
        assert_eq!(value["image"]["artifact"]["projectId"], json!(project_id));
    }

    #[test]
    fn generated_images_survive_restart_and_wrong_projects_cannot_resolve_or_delete() {
        let (directory, database_path, database, project_id, job_id) = fixture();
        let other = ProjectMetadata::new("other project").expect("other project");
        let other_id = other.id();
        database.create_project(&other).expect("create other");
        let bytes = png(b"durable image");
        let (published, created) = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &bytes,
            write_staged_image,
        )
        .expect("publish");
        assert!(created);
        let artifact_id = published.record().id();
        let (other_published, other_created) = publish_generated_image(
            &database,
            other_id,
            job_id,
            "image/png",
            &bytes,
            write_staged_image,
        )
        .expect("publish identical content for other project");
        assert!(other_created);
        assert_ne!(other_published.record().id(), artifact_id);
        assert!(resolve_owned_image(&database, other_id, artifact_id).is_err());
        succeed_job(&database, job_id);
        let published = commit_prepared(&database, &published);
        let other_published = commit_prepared(&database, &other_published);
        drop(published);
        drop(other_published);
        drop(database);

        let reopened = Database::open(&database_path).expect("reopen database");
        let listed = list_generated_images(&reopened, project_id).expect("list after restart");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].artifact_id, artifact_id);
        assert_eq!(
            list_generated_images(&reopened, other_id)
                .expect("list other project after restart")
                .len(),
            1
        );
        assert!(resolve_owned_image(&reopened, other_id, artifact_id).is_err());
        assert!(
            resolve_owned_image(&reopened, project_id, artifact_id)
                .expect("resolve owned")
                .is_some()
        );
        let export = prepare_image_export(
            &reopened,
            GeneratedImageExportRequest {
                project_id,
                artifact_id: artifact_id.to_string(),
                suggested_name: "background-1.png".to_owned(),
            },
        )
        .expect("prepare export after restart");
        assert_eq!(fs::read(export.staging.path()).expect("read export"), bytes);
        assert!(!format!("{export:?}").contains(directory.path().to_string_lossy().as_ref()));
        assert!(
            prepare_image_export(
                &reopened,
                GeneratedImageExportRequest {
                    project_id: other_id,
                    artifact_id: artifact_id.to_string(),
                    suggested_name: "background-1.png".to_owned(),
                },
            )
            .is_err()
        );
        drop(reopened);
        drop(directory);
    }

    #[test]
    fn a_real_restart_before_ack_interrupts_the_job_and_removes_the_provisional_image() {
        let (_directory, database_path, database, project_id, job_id) = fixture();
        let jobs = JobRegistry::restore(Arc::new(database.clone())).expect("jobs");
        jobs.apply(job_id, JobUpdate::Start).expect("running job");
        drop(jobs);
        let prepared = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &png(b"crash before acknowledgement"),
            write_staged_image,
        )
        .expect("provisional publication")
        .0;
        let artifact_id = prepared.record().id();
        let staging_path = prepared.path().to_path_buf();
        assert_eq!(
            database
                .get_artifact(artifact_id)
                .unwrap()
                .expect("provisional row")
                .state(),
            ArtifactState::Pending
        );
        assert!(
            list_generated_images(&database, project_id)
                .unwrap()
                .is_empty()
        );
        assert!(resolve_owned_image(&database, project_id, artifact_id).is_err());
        assert!(
            prepare_image_export(
                &database,
                GeneratedImageExportRequest {
                    project_id,
                    artifact_id: artifact_id.to_string(),
                    suggested_name: "provisional.png".to_owned(),
                },
            )
            .is_err()
        );
        drop(prepared);
        drop(database);

        let reopened = Database::open(&database_path).expect("restart database");
        assert!(reopened.get_artifact(artifact_id).unwrap().is_none());
        assert!(!staging_path.exists());
        assert!(
            list_generated_images(&reopened, project_id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reopened
                .get_job(job_id)
                .unwrap()
                .expect("interrupted job")
                .state(),
            JobState::Interrupted
        );
    }

    #[tokio::test]
    async fn completion_is_idempotently_recovered_after_its_response_is_lost() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
        let running = background::apply(&jobs, job_id, JobUpdate::Start)
            .await
            .expect("running job");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let runtime = GeneratedImageRuntime::default();
        let published = stage_pending_image(
            &database,
            &media_server,
            &runtime,
            project_id,
            job_id,
            running.sequence(),
            &png(b"lost acknowledgement response"),
        );
        let artifact_id = published.image.artifact.artifact_id;
        let playback_id = published.image.playback.id;
        let succeeded =
            background::apply_if_sequence(&jobs, job_id, running.sequence(), JobUpdate::Succeed)
                .await
                .expect("acknowledgement wins");

        finalize_pending_completion_parts(&database, &runtime, job_id, &succeeded)
            .await
            .expect("first completion response is lost");
        finalize_pending_completion_parts(&database, &runtime, job_id, &succeeded)
            .await
            .expect("duplicate completion is idempotent");
        runtime
            .access(|registry| {
                registry.completed_by_job.clear();
                Ok(())
            })
            .expect("simulate receipt loss");
        let recovered = recover_completed_image(
            &database,
            &jobs,
            &GeneratedImageRuntime::default(),
            job_id,
            project_id,
            artifact_id,
            playback_id,
        )
        .await
        .expect("durable completion recovery");
        assert_eq!(recovered, succeeded);
        assert_eq!(
            list_generated_images(&database, project_id).unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn cancellation_and_completion_have_one_winner_and_cleanup_matches_that_winner() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
        let running = background::apply(&jobs, job_id, JobUpdate::Start)
            .await
            .expect("running job");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let runtime = GeneratedImageRuntime::default();
        let cancelled_publication = stage_pending_image(
            &database,
            &media_server,
            &runtime,
            project_id,
            job_id,
            running.sequence(),
            &png(b"cancellation wins"),
        );
        background::apply(&jobs, job_id, JobUpdate::RequestCancellation)
            .await
            .expect("persist cancellation");
        assert!(
            background::apply_if_sequence(&jobs, job_id, running.sequence(), JobUpdate::Succeed,)
                .await
                .is_err()
        );
        let cancelled =
            invalidate_pending_completion_parts(&jobs, &database, &media_server, &runtime, job_id)
                .await
                .expect("cancelled snapshot");
        assert_eq!(cancelled.state(), JobState::Cancelled);
        assert!(
            database
                .get_artifact(cancelled_publication.image.artifact.artifact_id)
                .unwrap()
                .is_none()
        );
        assert!(
            !media_server
                .unregister(cancelled_publication.image.playback.id)
                .unwrap()
        );

        let second = JobSnapshot::new(JobKind::GenerateImage);
        let second_id = second.id();
        database.create_job(&second).expect("second job");
        let second_running = background::apply(&jobs, second_id, JobUpdate::Start)
            .await
            .expect("second running job");
        let completed_publication = stage_pending_image(
            &database,
            &media_server,
            &runtime,
            project_id,
            second_id,
            second_running.sequence(),
            &png(b"completion wins"),
        );
        let succeeded = background::apply_if_sequence(
            &jobs,
            second_id,
            second_running.sequence(),
            JobUpdate::Succeed,
        )
        .await
        .expect("completion wins");
        assert!(
            background::apply(&jobs, second_id, JobUpdate::RequestCancellation)
                .await
                .is_err()
        );
        let observed = invalidate_pending_completion_parts(
            &jobs,
            &database,
            &media_server,
            &runtime,
            second_id,
        )
        .await
        .expect("successful snapshot");
        assert_eq!(observed, succeeded);
        assert!(
            resolve_owned_image(
                &database,
                project_id,
                completed_publication.image.artifact.artifact_id,
            )
            .unwrap()
            .is_some()
        );
        assert!(
            media_server
                .unregister_owned_image(
                    completed_publication.image.playback.id,
                    project_id.into_uuid(),
                )
                .unwrap()
        );
    }

    #[tokio::test]
    async fn identical_provisional_jobs_never_share_and_a_late_rollback_cannot_delete_the_retry() {
        let (_directory, _database_path, database, project_id, first_id) = fixture();
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
        let first_running = background::apply(&jobs, first_id, JobUpdate::Start)
            .await
            .expect("first running job");
        let second = JobSnapshot::new(JobKind::GenerateImage);
        let second_id = second.id();
        database.create_job(&second).expect("second job");
        let second_running = background::apply(&jobs, second_id, JobUpdate::Start)
            .await
            .expect("second running job");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let runtime = GeneratedImageRuntime::default();
        let bytes = png(b"concurrent identical result");
        let first = stage_pending_image(
            &database,
            &media_server,
            &runtime,
            project_id,
            first_id,
            first_running.sequence(),
            &bytes,
        );
        let duplicate_error = runtime
            .access(|registry| {
                publish_and_register_image(
                    &database,
                    &media_server,
                    registry,
                    project_id,
                    second_id,
                    "image/png",
                    &bytes,
                )
            })
            .expect_err("unacknowledged ownership is never shared");
        assert_eq!(duplicate_error.code(), "invalidInput");

        background::apply(&jobs, first_id, JobUpdate::RequestCancellation)
            .await
            .expect("cancel first");
        invalidate_pending_completion_parts(&jobs, &database, &media_server, &runtime, first_id)
            .await;
        let second_publication = stage_pending_image(
            &database,
            &media_server,
            &runtime,
            project_id,
            second_id,
            second_running.sequence(),
            &bytes,
        );
        let second_success = background::apply_if_sequence(
            &jobs,
            second_id,
            second_running.sequence(),
            JobUpdate::Succeed,
        )
        .await
        .expect("retry succeeds");
        finalize_pending_completion_parts(&database, &runtime, second_id, &second_success)
            .await
            .expect("commit retry");

        rollback_published_image(&database, &media_server, &runtime, &first)
            .await
            .expect("late first rollback is idempotent");
        assert_ne!(
            first.image.artifact.artifact_id,
            second_publication.image.artifact.artifact_id
        );
        assert!(
            resolve_owned_image(
                &database,
                project_id,
                second_publication.image.artifact.artifact_id,
            )
            .unwrap()
            .is_some()
        );
        assert!(
            media_server
                .unregister_owned_image(
                    second_publication.image.playback.id,
                    project_id.into_uuid(),
                )
                .unwrap()
        );
    }

    #[test]
    fn partial_publication_is_rolled_back_and_can_be_retried_without_an_orphan() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        let bytes = png(b"partial failure");
        let failed = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &bytes,
            |path, bytes| {
                fs::write(path, &bytes[..8])?;
                Err(io::Error::other("injected write failure"))
            },
        );
        assert!(failed.is_err());
        assert!(
            list_generated_images(&database, project_id)
                .expect("list after failure")
                .is_empty()
        );

        let (retried, created) = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &bytes,
            write_staged_image,
        )
        .expect("retry publication");
        assert!(created);
        assert_eq!(fs::read(retried.path()).expect("read retry"), bytes);
    }

    #[test]
    fn a_failed_legacy_publication_record_cannot_poison_a_retry() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        let bytes = png(b"recover failed record");
        let draft = ArtifactDraft::new(
            artifact_kind(project_id).expect("artifact kind"),
            ContentHash::digest(&bytes),
            u64::try_from(bytes.len()).expect("bounded image size"),
            json!({"mimeType": "image/png"}),
        )
        .expect("draft")
        .with_project(project_id)
        .with_job(job_id);
        let ArtifactRegistration::Staging(staging) =
            database.register_artifact(&draft).expect("failed staging")
        else {
            panic!("new content must stage");
        };
        let failed_id = staging.record().id();
        database
            .mark_artifact_failed(
                failed_id,
                &ArtifactFailureCode::new("injectedFailure").expect("failure code"),
            )
            .expect("mark failed");

        let (retried, created) = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &bytes,
            write_staged_image,
        )
        .expect("retry failed record");
        assert!(created);
        // Storage recycles the failed row into a fresh staging reservation instead of
        // stranding it, so the retry keeps the identifier. What must not survive is the
        // failed attempt's residue: state, failure code, job binding, metadata, and the
        // staged bytes all belong to the retry.
        assert_eq!(retried.record().id(), failed_id);
        assert_eq!(retried.record().state(), ArtifactState::Pending);
        assert_eq!(retried.record().failure_code(), None);
        assert_eq!(retried.record().job_id(), Some(job_id));
        assert_eq!(
            retried.record().metadata()[COMMIT_ON_JOB_SUCCESS_METADATA_KEY],
            json!(true)
        );
        assert_eq!(fs::read(retried.path()).expect("staged retry"), bytes);

        succeed_job(&database, job_id);
        let committed = commit_prepared(&database, &retried);
        assert_eq!(committed.record().state(), ArtifactState::Ready);
        assert_eq!(committed.record().failure_code(), None);
        assert_eq!(fs::read(committed.path()).expect("committed retry"), bytes);
        assert_eq!(
            list_generated_images(&database, project_id).expect("recovered image"),
            vec![descriptor_from_record(committed.record(), project_id).expect("descriptor")]
        );
    }

    #[test]
    fn playback_registration_failure_rolls_back_the_new_durable_artifact() {
        let (directory, _database_path, database, project_id, job_id) = fixture();
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let filler = directory.path().join("filler-image");
        fs::write(&filler, png(b"filler")).expect("filler image");
        let mut registered = 0_usize;
        while registered < 300
            && media_server
                .register_image_file(&filler, "image/png")
                .is_ok()
        {
            registered += 1;
        }
        assert!(
            registered > 0 && registered < 300,
            "media registry must fill"
        );

        let mut registry = GeneratedImageRegistry::default();
        assert!(
            publish_and_register_image(
                &database,
                &media_server,
                &mut registry,
                project_id,
                job_id,
                "image/png",
                &png(b"must roll back"),
            )
            .is_err()
        );
        assert!(
            list_generated_images(&database, project_id)
                .expect("list after registration failure")
                .is_empty()
        );
        assert!(registry.by_artifact.is_empty());
    }

    #[tokio::test]
    async fn unreported_prepared_image_rolls_back_artifact_playback_and_job_across_restart() {
        let (_directory, database_path, database, project_id, job_id) = fixture();
        let jobs = Arc::new(
            JobRegistry::restore(Arc::new(database.clone())).expect("restore job registry"),
        );
        background::apply(&jobs, job_id, JobUpdate::Start)
            .await
            .expect("start job");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let runtime = GeneratedImageRuntime::default();
        let published = runtime
            .access(|registry| {
                publish_and_register_image(
                    &database,
                    &media_server,
                    registry,
                    project_id,
                    job_id,
                    "image/png",
                    &png(b"unreported completion"),
                )
            })
            .expect("publish prepared image");
        let artifact_id = published.image.artifact.artifact_id;
        let playback_id = published.image.playback.id;
        assert!(published.newly_created);
        runtime
            .access(|registry| {
                registry.pending_by_job.insert(
                    job_id,
                    PendingGeneratedImage {
                        published: published.clone(),
                        expected_job_sequence: 1,
                    },
                );
                Ok(())
            })
            .expect("stage pending completion");

        fail_pending_completion_parts(&jobs, &database, &media_server, &runtime, job_id).await;

        assert!(database.get_artifact(artifact_id).unwrap().is_none());
        assert!(
            !media_server
                .unregister(playback_id)
                .expect("playback revoked")
        );
        drop(jobs);
        drop(database);
        let reopened = Database::open(&database_path).expect("restart database");
        assert!(
            list_generated_images(&reopened, project_id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reopened
                .get_job(job_id)
                .unwrap()
                .expect("durable job")
                .state(),
            JobState::Failed
        );
    }

    #[tokio::test]
    async fn unreported_deduplicated_image_releases_only_its_playback() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        let jobs = Arc::new(
            JobRegistry::restore(Arc::new(database.clone())).expect("restore job registry"),
        );
        background::apply(&jobs, job_id, JobUpdate::Start)
            .await
            .expect("start job");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let runtime = GeneratedImageRuntime::default();
        let bytes = png(b"deduplicated completion");
        let owner = JobSnapshot::new(JobKind::GenerateImage);
        let owner_id = owner.id();
        database.create_job(&owner).expect("owner job");
        let original = publish_generated_image(
            &database,
            project_id,
            owner_id,
            "image/png",
            &bytes,
            write_staged_image,
        )
        .expect("publish original")
        .0;
        succeed_job(&database, owner_id);
        let original = commit_prepared(&database, &original);
        let artifact_id = original.record().id();
        let duplicate = runtime
            .access(|registry| {
                publish_and_register_image(
                    &database,
                    &media_server,
                    registry,
                    project_id,
                    job_id,
                    "image/png",
                    &bytes,
                )
            })
            .expect("reuse original");
        let playback_id = duplicate.image.playback.id;
        assert!(!duplicate.newly_created);
        runtime
            .access(|registry| {
                registry.pending_by_job.insert(
                    job_id,
                    PendingGeneratedImage {
                        published: duplicate,
                        expected_job_sequence: 1,
                    },
                );
                Ok(())
            })
            .expect("stage deduplicated completion");

        fail_pending_completion_parts(&jobs, &database, &media_server, &runtime, job_id).await;

        assert!(database.get_artifact(artifact_id).unwrap().is_some());
        assert!(
            resolve_owned_image(&database, project_id, artifact_id)
                .unwrap()
                .is_some()
        );
        assert!(
            !media_server
                .unregister(playback_id)
                .expect("playback revoked")
        );
        assert_eq!(
            database
                .get_job(job_id)
                .unwrap()
                .expect("durable job")
                .state(),
            JobState::Failed
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "the ownership lifecycle is intentionally exercised as one ordered end-to-end scenario"
    )]
    fn delete_clear_and_playback_registry_enforce_project_ownership() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let mut registry = GeneratedImageRegistry::default();
        let other = ProjectMetadata::new("other project").expect("other project");
        let other_id = other.id();
        database.create_project(&other).expect("create other");
        let first = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &png(b"first"),
            write_staged_image,
        )
        .expect("first")
        .0;
        let second = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &png(b"second"),
            write_staged_image,
        )
        .expect("second")
        .0;
        succeed_job(&database, job_id);
        let first = commit_prepared(&database, &first);
        let second = commit_prepared(&database, &second);
        let first_id = first.record().id();
        let second_id = second.record().id();
        let first_playable =
            register_playable_image(&media_server, &mut registry, &first).expect("first playback");
        let duplicate_playable = register_playable_image(&media_server, &mut registry, &first)
            .expect("duplicate playback");
        let second_playable = register_playable_image(&media_server, &mut registry, &second)
            .expect("second playback");
        assert!(resolve_owned_image(&database, other_id, first_id).is_err());
        assert_eq!(
            list_generated_images(&database, project_id).unwrap().len(),
            2
        );
        assert_eq!(list_generated_images(&database, other_id).unwrap().len(), 0);

        assert!(
            release_generated_image_playback(
                &mut registry,
                &media_server,
                project_id,
                first_id,
                duplicate_playable.playback.id,
            )
            .expect("release only duplicate")
        );
        let first_entry = registry
            .by_artifact
            .get(&first_id)
            .expect("first playback remains");
        assert!(
            first_entry
                .playback_ids
                .contains(&first_playable.playback.id)
        );
        assert!(
            !first_entry
                .playback_ids
                .contains(&duplicate_playable.playback.id)
        );

        assert!(
            release_generated_image_playback(
                &mut registry,
                &media_server,
                other_id,
                first_id,
                first_playable.playback.id,
            )
            .is_err()
        );
        assert!(registry.by_artifact.contains_key(&first_id));
        assert!(
            delete_generated_image(&database, &media_server, &mut registry, other_id, first_id,)
                .is_err()
        );
        assert!(database.get_artifact(first_id).unwrap().is_some());

        assert!(
            delete_generated_image(
                &database,
                &media_server,
                &mut registry,
                project_id,
                first_id,
            )
            .expect("delete first")
        );
        assert!(!registry.by_artifact.contains_key(&first_id));
        assert_eq!(
            list_generated_images(&database, project_id).unwrap().len(),
            1
        );
        assert_eq!(
            clear_generated_images(&database, &media_server, &mut registry, other_id,)
                .expect("clear other"),
            0
        );
        assert!(database.get_artifact(second_id).unwrap().is_some());
        assert_eq!(
            clear_generated_images(&database, &media_server, &mut registry, project_id,)
                .expect("clear project"),
            1
        );
        assert!(!registry.by_artifact.contains_key(&second_id));
        assert!(
            !media_server
                .unregister(second_playable.playback.id)
                .expect("already released")
        );
        assert!(
            list_generated_images(&database, project_id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn malformed_metadata_and_export_names_fail_closed() {
        assert!(validate_generated_image("image/png", b"not png").is_err());
        assert!(validate_generated_image("image/gif", &png(b"wrong mime")).is_err());
        assert!(is_safe_export_name("background-1.png", "png"));
        assert!(!is_safe_export_name("../background.png", "png"));
        assert!(!is_safe_export_name("background.jpg", "png"));
        assert!(!is_safe_export_name("background..png", "png"));
    }

    #[test]
    fn project_image_limit_is_enforced_without_publishing_an_invisible_artifact() {
        let (_directory, _database_path, database, project_id, job_id) = fixture();
        succeed_job(&database, job_id);
        for index in 0..MAX_PROJECT_IMAGES {
            let prepared = publish_generated_image(
                &database,
                project_id,
                job_id,
                "image/png",
                &png(index.to_string().as_bytes()),
                write_staged_image,
            )
            .expect("within project limit");
            commit_prepared(&database, &prepared.0);
        }
        assert_eq!(
            list_generated_images(&database, project_id)
                .expect("bounded list")
                .len(),
            MAX_PROJECT_IMAGES
        );
        assert_eq!(
            publish_generated_image(
                &database,
                project_id,
                job_id,
                "image/png",
                &png(b"one too many"),
                write_staged_image,
            )
            .expect_err("project limit must fail")
            .code(),
            "invalidInput"
        );
        assert_eq!(
            list_generated_images(&database, project_id)
                .expect("unchanged list")
                .len(),
            MAX_PROJECT_IMAGES
        );
    }
}
