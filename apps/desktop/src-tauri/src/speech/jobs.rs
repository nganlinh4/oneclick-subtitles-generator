//! Speech job manifests, events, terminal outcomes and failure mapping.

use std::sync::Arc;

use osg_domain::{JobId, JobSnapshot, ProjectId};
use osg_infrastructure::storage::Database;
use osg_speech::{
    LazySpeechWorker, RunControl, SegmentId, SpeechError, SpeechOutput, SpeechPhase,
    SynthesisRequest,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use super::artifact_types::SpeechArtifactDescriptor;
use super::artifacts::{descriptor_from_record, parse_artifact_id};
use super::lifecycle::{
    SpeechLifecycleOwnership, SpeechProjectAuthority, project_write_failure, worker_join_result,
};
use super::requests::SpeechBackendRequest;
use super::runtime::SpeechRuntime;
use super::{MANIFEST_SCHEMA_VERSION, MANIFEST_SCOPE, MAX_SEGMENTS};
use crate::background;
use crate::error::{CommandError, CommandResult};

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechFailureCode {
    Cancelled,
    ProjectChanged,
    InvalidRequest,
    RuntimeUnavailable,
    ModelUnavailable,
    ProviderUnavailable,
    ProviderRateLimited,
    AuthenticationFailed,
    ReferenceRejected,
    SynthesisFailed,
    EncodingFailed,
    TimedOut,
    WorkerFailed,
    ArtifactStorage,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StoredSpeechResult {
    Completed {
        segment_id: String,
        artifact: SpeechArtifactDescriptor,
    },
    Failed {
        segment_id: String,
        code: SpeechFailureCode,
        retryable: bool,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpeechJobManifest {
    pub(super) schema_version: u32,
    pub(super) backend: SpeechBackendRequest,
    pub(super) project_id: Option<ProjectId>,
    pub(super) expected_project_state_version: Option<u64>,
    pub(super) results: Vec<StoredSpeechResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechJobResultsResponse {
    pub(super) job: JobSnapshot,
    pub(super) backend: SpeechBackendRequest,
    pub(super) project_id: Option<ProjectId>,
    pub(super) expected_project_state_version: Option<u64>,
    pub(super) results: Vec<StoredSpeechResult>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechPhaseResponse {
    StartingWorker,
    LoadingModel,
    Synthesizing,
    Encoding,
    Publishing,
}

impl From<SpeechPhase> for SpeechPhaseResponse {
    fn from(value: SpeechPhase) -> Self {
        match value {
            SpeechPhase::StartingWorker => Self::StartingWorker,
            SpeechPhase::LoadingModel => Self::LoadingModel,
            SpeechPhase::Synthesizing => Self::Synthesizing,
            SpeechPhase::Encoding => Self::Encoding,
            SpeechPhase::Publishing => Self::Publishing,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SpeechJobEvent {
    Progress {
        job_id: JobId,
        segment_id: Option<String>,
        index: usize,
        total: usize,
        phase: SpeechPhaseResponse,
        fraction_millionths: u32,
    },
    SegmentCompleted {
        job_id: JobId,
        index: usize,
        total: usize,
        result: StoredSpeechResult,
    },
    SegmentFailed {
        job_id: JobId,
        index: usize,
        total: usize,
        result: StoredSpeechResult,
    },
    Completed {
        job: JobSnapshot,
        results: Vec<StoredSpeechResult>,
    },
    Cancelled {
        job: JobSnapshot,
        results: Vec<StoredSpeechResult>,
    },
    Failed {
        job: Option<JobSnapshot>,
        results: Vec<StoredSpeechResult>,
        code: SpeechFailureCode,
    },
}

pub(super) fn synthesize_with_retry(
    worker: &LazySpeechWorker,
    request: &SynthesisRequest,
    output: &SpeechOutput,
    control: &RunControl,
) -> Result<osg_speech::SpeechArtifact, SpeechError> {
    match worker.synthesize(request, output, control) {
        Err(error) if retryable_speech_error(&error) && !control.cancellation().is_cancelled() => {
            worker.synthesize(request, output, control)
        }
        result => result,
    }
}

fn retryable_speech_error(error: &SpeechError) -> bool {
    matches!(
        error,
        SpeechError::WorkerRejected {
            retryable: true,
            ..
        } | SpeechError::WorkerExited { .. }
            | SpeechError::WorkerIo(_)
    )
}

pub(super) const fn failure_marks_backend_unhealthy(code: SpeechFailureCode) -> bool {
    matches!(
        code,
        SpeechFailureCode::RuntimeUnavailable
            | SpeechFailureCode::ModelUnavailable
            | SpeechFailureCode::WorkerFailed
    )
}

pub(super) const fn batch_terminal_failure(code: SpeechFailureCode) -> bool {
    matches!(
        code,
        SpeechFailureCode::ProjectChanged
            | SpeechFailureCode::InvalidRequest
            | SpeechFailureCode::RuntimeUnavailable
            | SpeechFailureCode::ModelUnavailable
            | SpeechFailureCode::ProviderUnavailable
            | SpeechFailureCode::ProviderRateLimited
            | SpeechFailureCode::AuthenticationFailed
            | SpeechFailureCode::ReferenceRejected
            | SpeechFailureCode::TimedOut
            | SpeechFailureCode::WorkerFailed
            | SpeechFailureCode::ArtifactStorage
    )
}

async fn commit_speech_job_success(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    results: Vec<StoredSpeechResult>,
    channel: &Channel<SpeechJobEvent>,
) -> Result<(), SpeechFailureCode> {
    let backend = ownership.backend;
    let lifecycle_epoch = ownership.lifecycle_epoch;
    let success_runtime = runtime.clone();
    let success_ownership = ownership.clone();
    let success_jobs = Arc::clone(jobs);
    let success_channel = channel.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        success_ownership
            .commit_job_success(&success_runtime, &success_jobs, job_id)
            .map(|job| {
                let _ = success_channel.send(SpeechJobEvent::Completed { job, results });
            })
    })
    .await;
    worker_join_result(runtime, backend, lifecycle_epoch, joined)?
}

pub(super) async fn finish_speech_job(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    jobs: &background::DesktopJobs,
    database: &Database,
    job_id: JobId,
    result: Result<Vec<StoredSpeechResult>, SpeechFailureCode>,
    channel: &Channel<SpeechJobEvent>,
) {
    let manifest_database = database.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        read_manifest(&manifest_database, job_id).map(|manifest| manifest.results)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default();
    match result {
        Ok(results) => {
            match commit_speech_job_success(runtime, ownership, jobs, job_id, results, channel)
                .await
            {
                Ok(()) => {}
                Err(SpeechFailureCode::Cancelled) => {
                    if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                        let _ = channel.send(SpeechJobEvent::Cancelled {
                            job,
                            results: stored,
                        });
                    }
                }
                Err(code) => {
                    let job = background::finish_failure(jobs, job_id).await;
                    let _ = channel.send(SpeechJobEvent::Failed {
                        job,
                        results: stored,
                        code,
                    });
                }
            }
        }
        Err(SpeechFailureCode::Cancelled) => {
            if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                let _ = channel.send(SpeechJobEvent::Cancelled {
                    job,
                    results: stored,
                });
            } else {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(SpeechJobEvent::Failed {
                    job,
                    results: stored,
                    code: SpeechFailureCode::WorkerFailed,
                });
            }
        }
        Err(code) => {
            let job = background::finish_failure(jobs, job_id).await;
            let _ = channel.send(SpeechJobEvent::Failed {
                job,
                results: stored,
                code,
            });
        }
    }
}

pub(super) fn read_manifest(
    database: &Database,
    job_id: JobId,
) -> CommandResult<SpeechJobManifest> {
    let value = database
        .get_setting(MANIFEST_SCOPE, &job_id.to_string())?
        .ok_or_else(|| CommandError::invalid_input("The speech job results are unavailable."))?;
    let manifest: SpeechJobManifest = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The stored speech job results are invalid."))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.results.len() > MAX_SEGMENTS
        || manifest.project_id.is_some() != manifest.expected_project_state_version.is_some()
        || manifest
            .expected_project_state_version
            .is_some_and(|version| version > i64::MAX as u64)
    {
        return Err(invalid_manifest_error());
    }
    for result in &manifest.results {
        match result {
            StoredSpeechResult::Completed {
                segment_id,
                artifact,
            } => {
                if SegmentId::new(segment_id.clone()).is_err()
                    || artifact.bytes == 0
                    || artifact.bytes > 512 * 1024 * 1024
                {
                    return Err(invalid_manifest_error());
                }
                let id = parse_artifact_id(&artifact.artifact_id)
                    .map_err(|_| invalid_manifest_error())?;
                let resolved = database
                    .resolve_artifact(id)
                    .map_err(|_| invalid_manifest_error())?
                    .ok_or_else(invalid_manifest_error)?;
                if !matches!(
                    resolved.record().kind().as_str(),
                    "narrationOutput" | "voiceConversion"
                ) || resolved.record().project_id() != manifest.project_id
                {
                    return Err(invalid_manifest_error());
                }
                let stored_descriptor = descriptor_from_record(resolved.record())
                    .map_err(|_| invalid_manifest_error())?;
                if &stored_descriptor != artifact {
                    return Err(invalid_manifest_error());
                }
            }
            StoredSpeechResult::Failed { segment_id, .. } => {
                if SegmentId::new(segment_id.clone()).is_err() {
                    return Err(invalid_manifest_error());
                }
            }
        }
    }
    Ok(manifest)
}

fn invalid_manifest_error() -> CommandError {
    CommandError::internal("The stored speech job results are invalid.")
}

pub(super) fn append_manifest(
    database: &Database,
    job_id: JobId,
    backend: SpeechBackendRequest,
    project: Option<SpeechProjectAuthority>,
    result: StoredSpeechResult,
) -> Result<(), SpeechFailureCode> {
    let mut manifest =
        read_manifest(database, job_id).map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    if manifest.backend != backend
        || manifest.results.len() >= MAX_SEGMENTS
        || manifest.project_id != project.map(|authority| authority.project_id)
        || manifest.expected_project_state_version
            != project.map(|authority| authority.expected_state_version)
    {
        return Err(SpeechFailureCode::ArtifactStorage);
    }
    manifest.results.push(result);
    let value = serde_json::to_value(manifest).map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    match project {
        Some(authority) => database
            .put_project_setting(
                MANIFEST_SCOPE,
                &job_id.to_string(),
                &value,
                authority.project_id,
                authority.expected_state_version,
            )
            .map_err(|error| project_write_failure(&error)),
        None => database
            .put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)
            .map_err(|_| SpeechFailureCode::ArtifactStorage),
    }
}

pub(super) fn speech_failure(error: &SpeechError) -> (SpeechFailureCode, bool) {
    match error {
        SpeechError::Cancelled => (SpeechFailureCode::Cancelled, false),
        SpeechError::InvalidInput(_)
        | SpeechError::InvalidOption(_)
        | SpeechError::BackendMismatch => (SpeechFailureCode::InvalidRequest, false),
        SpeechError::InvalidAsset(_) => (SpeechFailureCode::ReferenceRejected, false),
        SpeechError::WorkerNotFound | SpeechError::InvalidWorker(_) => {
            (SpeechFailureCode::RuntimeUnavailable, false)
        }
        SpeechError::WorkerRejected { code, retryable } => {
            let code = match *code {
                "model_unavailable" => SpeechFailureCode::ModelUnavailable,
                "provider_unavailable" => SpeechFailureCode::ProviderUnavailable,
                "provider_rate_limited" => SpeechFailureCode::ProviderRateLimited,
                "authentication_failed" => SpeechFailureCode::AuthenticationFailed,
                "reference_rejected" => SpeechFailureCode::ReferenceRejected,
                "encoding_failed" => SpeechFailureCode::EncodingFailed,
                _ => SpeechFailureCode::SynthesisFailed,
            };
            (code, *retryable)
        }
        SpeechError::TimedOut { .. } => (SpeechFailureCode::TimedOut, true),
        SpeechError::MissingArtifact
        | SpeechError::InvalidArtifact(_)
        | SpeechError::OutputExists
        | SpeechError::Publish(_)
        | SpeechError::InvalidDestination(_) => (SpeechFailureCode::EncodingFailed, false),
        SpeechError::Spawn(_)
        | SpeechError::WorkerIo(_)
        | SpeechError::Protocol(_)
        | SpeechError::FrameLimit
        | SpeechError::WorkerExited { .. }
        | SpeechError::StateUnavailable => (SpeechFailureCode::WorkerFailed, true),
    }
}

pub(super) fn speech_command_error(error: &SpeechError) -> CommandError {
    let (code, _) = speech_failure(error);
    speech_failure_code_command_error(code)
}

pub(super) fn speech_failure_code_command_error(code: SpeechFailureCode) -> CommandError {
    let message = match code {
        SpeechFailureCode::Cancelled => "The speech operation was cancelled.",
        SpeechFailureCode::ProjectChanged => {
            "The narration project changed while speech was being generated."
        }
        SpeechFailureCode::InvalidRequest => "The speech request is invalid.",
        SpeechFailureCode::RuntimeUnavailable => {
            "The selected speech runtime is not installed or is incomplete."
        }
        SpeechFailureCode::ModelUnavailable => "The selected speech model is unavailable.",
        SpeechFailureCode::ProviderUnavailable => "The speech provider is unavailable.",
        SpeechFailureCode::ProviderRateLimited => "The speech provider is rate limited.",
        SpeechFailureCode::AuthenticationFailed => "The speech credential was rejected.",
        SpeechFailureCode::ReferenceRejected => "The reference audio is invalid or unsupported.",
        SpeechFailureCode::SynthesisFailed => "Speech synthesis could not be completed.",
        SpeechFailureCode::EncodingFailed => "The speech audio artifact is invalid.",
        SpeechFailureCode::TimedOut => "The speech operation exceeded its safe time limit.",
        SpeechFailureCode::WorkerFailed => "The native speech worker stopped unexpectedly.",
        SpeechFailureCode::ArtifactStorage => "The speech artifact could not be stored.",
    };
    match code {
        SpeechFailureCode::ProjectChanged => CommandError::stale_project_version(),
        SpeechFailureCode::InvalidRequest | SpeechFailureCode::ReferenceRejected => {
            CommandError::invalid_input(message)
        }
        _ => CommandError::internal(message),
    }
}
