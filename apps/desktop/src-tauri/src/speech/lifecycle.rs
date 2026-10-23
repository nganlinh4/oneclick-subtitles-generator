//! Speech job registration, project authority and lifecycle ownership.

use std::sync::Arc;

use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobUpdate, ProjectId};
use osg_infrastructure::storage::{Database, DatabaseError};
use osg_runtime_staging::OwnedStagingDirectory;
use osg_speech::{CancellationToken, SpeechError};
use tauri::ipc::Channel;

use super::batch::{prepare_f5_requests, resolve_batch_workers};
use super::jobs::{
    SpeechFailureCode, SpeechJobEvent, SpeechJobManifest, StoredSpeechResult, append_manifest,
    speech_failure, speech_failure_code_command_error,
};
use super::requests::{SpeechBackendRequest, ValidatedSpeechStart};
use super::runtime::{BackendLifecycleSlot, ManagedSpeechWorker, SpeechRuntime};
use super::{MANIFEST_SCHEMA_VERSION, MANIFEST_SCOPE};
use crate::background;
use crate::error::{CommandError, CommandResult};

pub(super) type NativeCredentialService =
    osg_infrastructure::secrets::CredentialService<crate::state::DesktopCredentialBackend>;

pub(super) struct SpeechBatchContext<'a> {
    pub(super) runtime: &'a SpeechRuntime,
    pub(super) database: &'a Database,
    pub(super) credentials: &'a NativeCredentialService,
    pub(super) jobs: &'a background::DesktopJobs,
    pub(super) job_id: JobId,
    pub(super) project_id: ProjectId,
    pub(super) channel: &'a Channel<SpeechJobEvent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct SpeechProjectAuthority {
    pub(super) project_id: ProjectId,
    pub(super) expected_state_version: u64,
}

impl SpeechProjectAuthority {
    pub(super) fn ensure_current(self, database: &Database) -> Result<(), SpeechFailureCode> {
        let project = database
            .load_project(self.project_id)
            .map_err(|_| SpeechFailureCode::ArtifactStorage)?
            .ok_or(SpeechFailureCode::ProjectChanged)?;
        if project.state_version() != self.expected_state_version {
            return Err(SpeechFailureCode::ProjectChanged);
        }
        Ok(())
    }
}

pub(super) const fn project_write_failure(error: &DatabaseError) -> SpeechFailureCode {
    match error {
        DatabaseError::ProjectNotFound(_) | DatabaseError::StaleProjectVersion { .. } => {
            SpeechFailureCode::ProjectChanged
        }
        _ => SpeechFailureCode::ArtifactStorage,
    }
}

#[derive(Clone)]
pub(super) struct SpeechLifecycleOwnership {
    pub(super) backend: SpeechBackendRequest,
    pub(super) lifecycle_epoch: u64,
    pub(super) cancellation: CancellationToken,
    pub(super) project: Option<SpeechProjectAuthority>,
}

impl SpeechLifecycleOwnership {
    pub(super) fn capture(
        runtime: &SpeechRuntime,
        backend: SpeechBackendRequest,
        lifecycle_epoch: u64,
    ) -> Result<Self, SpeechError> {
        let lifecycle_cancellation = runtime.require_enabled_lifecycle(backend, lifecycle_epoch)?;
        Ok(Self {
            backend,
            lifecycle_epoch,
            cancellation: CancellationToken::linked(&[lifecycle_cancellation]),
            project: None,
        })
    }

    pub(super) fn capture_project(
        runtime: &SpeechRuntime,
        backend: SpeechBackendRequest,
        lifecycle_epoch: u64,
        project_id: ProjectId,
        expected_state_version: u64,
    ) -> Result<Self, SpeechError> {
        let mut ownership = Self::capture(runtime, backend, lifecycle_epoch)?;
        ownership.project = Some(SpeechProjectAuthority {
            project_id,
            expected_state_version,
        });
        Ok(ownership)
    }

    pub(super) fn ensure_current(&self, runtime: &SpeechRuntime) -> Result<(), SpeechFailureCode> {
        if self.cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        runtime
            .require_enabled_lifecycle(self.backend, self.lifecycle_epoch)
            .map_err(|error| speech_failure(&error).0)?;
        if self.cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        Ok(())
    }

    pub(super) fn ensure_owned(
        &self,
        runtime: &SpeechRuntime,
        database: &Database,
    ) -> Result<(), SpeechFailureCode> {
        self.ensure_current(runtime)?;
        if let Some(project) = self.project {
            project.ensure_current(database)?;
        }
        self.ensure_current(runtime)
    }

    fn validate_slot(&self, slot: &BackendLifecycleSlot) -> Result<(), SpeechFailureCode> {
        if self.cancellation.is_cancelled() {
            return Err(SpeechFailureCode::Cancelled);
        }
        let lifecycle = slot
            .state
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        if lifecycle.epoch != self.lifecycle_epoch
            || !lifecycle.enabled
            || lifecycle.cancellation.is_cancelled()
            || self.cancellation.is_cancelled()
        {
            return Err(SpeechFailureCode::Cancelled);
        }
        Ok(())
    }

    fn commit_initial_manifest(
        &self,
        runtime: &SpeechRuntime,
        database: &Database,
        job_id: JobId,
    ) -> Result<(), SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        let manifest = SpeechJobManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            backend: self.backend,
            project_id: self.project.map(|authority| authority.project_id),
            expected_project_state_version: self
                .project
                .map(|authority| authority.expected_state_version),
            results: Vec::new(),
        };
        let value =
            serde_json::to_value(manifest).map_err(|_| SpeechFailureCode::ArtifactStorage)?;
        match self.project {
            Some(project) => database
                .put_project_setting(
                    MANIFEST_SCOPE,
                    &job_id.to_string(),
                    &value,
                    project.project_id,
                    project.expected_state_version,
                )
                .map_err(|error| project_write_failure(&error)),
            None => database
                .put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)
                .map_err(|_| SpeechFailureCode::ArtifactStorage),
        }
    }

    pub(super) fn commit_manifest_result(
        &self,
        runtime: &SpeechRuntime,
        database: &Database,
        job_id: JobId,
        result: StoredSpeechResult,
    ) -> Result<(), SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        append_manifest(database, job_id, self.backend, self.project, result)
    }

    pub(super) fn commit_job_progress(
        &self,
        runtime: &SpeechRuntime,
        jobs: &background::DesktopJobs,
        job_id: JobId,
        progress: JobProgress,
    ) -> Result<(), SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        jobs.apply(job_id, JobUpdate::ReportProgress(progress))
            .map(|_| ())
            .map_err(|_| SpeechFailureCode::ArtifactStorage)
    }

    pub(super) fn commit_job_success(
        &self,
        runtime: &SpeechRuntime,
        jobs: &background::DesktopJobs,
        job_id: JobId,
    ) -> Result<JobSnapshot, SpeechFailureCode> {
        let slot = runtime
            .lifecycle_slot(self.backend)
            .map_err(|error| speech_failure(&error).0)?;
        let _commit = slot
            .commit_gate
            .lock()
            .map_err(|_| SpeechFailureCode::WorkerFailed)?;
        self.validate_slot(&slot)?;
        let ticket = match self.project {
            Some(project) => jobs.apply_with_store(
                job_id,
                JobUpdate::Succeed,
                |database, sequence, snapshot| {
                    database.complete_project_job(
                        sequence,
                        snapshot,
                        project.project_id,
                        project.expected_state_version,
                    )
                },
            ),
            None => jobs.apply(job_id, JobUpdate::Succeed),
        };
        ticket
            .map(|ticket| ticket.snapshot().clone())
            .map_err(|error| match error {
                osg_application::JobRegistryError::Store(store_error) => {
                    project_write_failure(&store_error)
                }
                _ => SpeechFailureCode::ArtifactStorage,
            })
    }
}

pub(super) async fn register_owned_speech_job_with_hook<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    jobs: &background::DesktopJobs,
    after_registration: F,
) -> CommandResult<osg_application::JobTicket>
where
    F: FnOnce(),
{
    let ticket = background::register_running(jobs, JobKind::SynthesizeNarration).await?;
    after_registration();
    if let Err(code) = ownership.ensure_owned(runtime, database) {
        background::finish_cancellation(jobs, ticket.snapshot().id()).await?;
        return Err(speech_failure_code_command_error(code));
    }
    Ok(ticket)
}

async fn finish_registered_speech_start(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    code: SpeechFailureCode,
) -> CommandResult<()> {
    if code == SpeechFailureCode::Cancelled {
        background::finish_cancellation(jobs, job_id).await?;
    } else if background::finish_failure(jobs, job_id).await.is_none() {
        return Err(CommandError::internal(
            "The speech startup job could not be finalized.",
        ));
    }
    Ok(())
}

pub(super) async fn initialize_registered_speech_job_with_hook<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    before_manifest_put: F,
) -> CommandResult<()>
where
    F: FnOnce() + Send + 'static,
{
    let worker_runtime = runtime.clone();
    let worker_ownership = ownership.clone();
    let worker_database = database.clone();
    let backend = ownership.backend;
    let lifecycle_epoch = ownership.lifecycle_epoch;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        initialize_manifest_with_hook(
            &worker_runtime,
            &worker_ownership,
            &worker_database,
            job_id,
            before_manifest_put,
        )
    })
    .await;
    let outcome = worker_join_result(runtime, backend, lifecycle_epoch, joined).unwrap_or_else(Err);
    if let Err(code) = outcome {
        finish_registered_speech_start(jobs, job_id, code).await?;
        return Err(speech_failure_code_command_error(code));
    }
    Ok(())
}

pub(super) fn initialize_manifest_with_hook<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    job_id: JobId,
    before_manifest_put: F,
) -> Result<(), SpeechFailureCode>
where
    F: FnOnce(),
{
    before_manifest_put();
    ownership.commit_initial_manifest(runtime, database, job_id)
}

pub(super) fn worker_join_result<T, E>(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    result: Result<T, E>,
) -> Result<T, SpeechFailureCode> {
    result.map_err(|_| {
        let _ = runtime.invalidate_backend_runtime(backend, Some(lifecycle_epoch));
        SpeechFailureCode::WorkerFailed
    })
}

pub(super) fn command_join_result<T, E>(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    result: Result<T, E>,
    message: &'static str,
) -> CommandResult<T> {
    result.map_err(|_| {
        let _ = runtime.invalidate_backend_runtime(backend, Some(lifecycle_epoch));
        CommandError::internal(message)
    })
}

pub(super) async fn resolve_prepared_batch_workers(
    context: &SpeechBatchContext<'_>,
    validated: &mut ValidatedSpeechStart,
    work: &OwnedStagingDirectory,
    cancellation: &CancellationToken,
) -> Result<Vec<Arc<ManagedSpeechWorker>>, SpeechFailureCode> {
    let workers = resolve_batch_workers(
        context,
        validated.backend,
        validated.lifecycle_epoch,
        &validated.credential_ids,
    )
    .await?;
    if validated.backend != SpeechBackendRequest::F5Tts {
        return Ok(workers);
    }
    validated.requests = prepare_f5_requests(
        &workers[0],
        work,
        std::mem::take(&mut validated.requests),
        validated
            .reference
            .take()
            .ok_or(SpeechFailureCode::ReferenceRejected)?,
        cancellation.clone(),
    )
    .await?;
    Ok(workers)
}
