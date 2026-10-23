//! Speech runtime, synthesis, conversion and alignment command handlers.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use osg_domain::{JobId, JobKind, JobSnapshot};
use osg_media::CancellationToken as MediaCancellationToken;
use osg_speech::{RunControl, SpeechError, VoiceGender};
use tauri::{State, ipc::Channel};

use super::alignment::{
    SpeechAlignmentEvent, SpeechAlignmentFailureCode, SpeechAlignmentPhase,
    SpeechAlignmentResultResponse, initialize_alignment_manifest, read_alignment_manifest,
    validate_alignment_start,
};
use super::alignment_job::{
    execute_alignment_job, finish_alignment_job, report_alignment_progress,
};
use super::artifact_types::{SpeechAlignmentStartRequest, SpeechVoiceConversionStartRequest};
use super::artifacts::resolve_audio_artifact;
use super::batch::run_speech_batch;
use super::jobs::{
    SpeechFailureCode, SpeechJobEvent, SpeechJobResultsResponse, finish_speech_job, read_manifest,
    speech_command_error,
};
use super::lifecycle::{
    SpeechBatchContext, SpeechLifecycleOwnership, SpeechProjectAuthority, command_join_result,
    initialize_registered_speech_job_with_hook, register_owned_speech_job_with_hook,
};
use super::reference::require_reference_project_state;
use super::requests::{
    SpeechBackendRequest, SpeechBackendStatus, SpeechInventoryResponse, SpeechProbeResponse,
    SpeechStartRequest, SpeechStatusResponse, SpeechVoiceGenderResponse, SpeechVoiceResponse,
};
use super::runtime::SpeechRuntime;
use super::voice_conversion::run_voice_conversion;
use super::{MAX_BATCH_TEXT_BYTES, MAX_LIFECYCLE_EPOCH, MAX_SEGMENTS, PROBE_TIMEOUT};
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_status(runtime: State<'_, SpeechRuntime>) -> SpeechStatusResponse {
    SpeechStatusResponse {
        backends: runtime.statuses(),
        max_segments_per_job: MAX_SEGMENTS,
        max_batch_text_bytes: MAX_BATCH_TEXT_BYTES,
    }
}

#[derive(Clone)]
pub(super) struct ProbeLifecycleOwnership(pub(super) Arc<AtomicU64>);

impl ProbeLifecycleOwnership {
    pub(super) fn new(epoch: u64) -> Self {
        Self(Arc::new(AtomicU64::new(epoch)))
    }

    pub(super) fn update(&self, epoch: u64) {
        self.0.store(epoch, Ordering::Release);
    }

    pub(super) fn epoch(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}

pub(super) fn probe_join_result<T, E>(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    ownership: &ProbeLifecycleOwnership,
    result: Result<T, E>,
) -> CommandResult<T> {
    result.map_err(|_| {
        let _ = runtime.invalidate_backend_runtime(backend, Some(ownership.epoch()));
        CommandError::internal("The speech probe task stopped unexpectedly.")
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_probe(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
) -> CommandResult<SpeechProbeResponse> {
    let runtime = runtime.inner().clone();
    let epoch = runtime
        .lifecycle_epoch(backend)
        .map_err(|error| speech_command_error(&error))?;
    let ownership = ProbeLifecycleOwnership::new(epoch);
    let probe_ownership = ownership.clone();
    let probe_runtime = runtime.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (worker, actual_epoch) =
            probe_runtime.worker_for_probe(backend, epoch, |actual_epoch| {
                probe_ownership.update(actual_epoch);
            })?;
        let lifecycle_cancellation = probe_runtime.lifecycle_cancellation(backend, actual_epoch)?;
        let control = RunControl::new(PROBE_TIMEOUT)?.with_cancellation(lifecycle_cancellation);
        match worker.list_voices(&control) {
            Ok(inventory) => Ok((actual_epoch, inventory)),
            Err(error) => {
                let _ = probe_runtime.invalidate_backend_runtime(backend, Some(actual_epoch));
                Err(error)
            }
        }
    })
    .await;
    let result = probe_join_result(&runtime, backend, &ownership, result)?;
    match result {
        Ok((actual_epoch, inventory)) => {
            let voices = inventory
                .voices()
                .iter()
                .map(|voice| SpeechVoiceResponse {
                    id: voice.id().as_str().to_owned(),
                    display_name: voice.display_name().to_owned(),
                    language: voice.language().as_str().to_owned(),
                    gender: match voice.gender() {
                        VoiceGender::Female => SpeechVoiceGenderResponse::Female,
                        VoiceGender::Male => SpeechVoiceGenderResponse::Male,
                        VoiceGender::Neutral => SpeechVoiceGenderResponse::Neutral,
                        VoiceGender::Unknown => SpeechVoiceGenderResponse::Unknown,
                    },
                })
                .collect::<Vec<_>>();
            if !runtime.commit_voice_inventory_for_epoch(backend, actual_epoch, voices.clone()) {
                return Err(speech_command_error(&SpeechError::Cancelled));
            }
            let status = runtime.status(backend);
            if status.epoch != actual_epoch || !status.enabled || !status.warm {
                let _ = runtime.invalidate_backend_runtime(backend, Some(actual_epoch));
                return Err(speech_command_error(&SpeechError::StateUnavailable));
            }
            Ok(SpeechProbeResponse { status, voices })
        }
        Err(error) => Err(speech_command_error(&error)),
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_voice_inventory(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
    epoch: u64,
) -> CommandResult<SpeechInventoryResponse> {
    runtime
        .voice_inventory(backend, epoch)
        .map_err(|error| speech_command_error(&error))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_runtime_stop(
    runtime: State<'_, SpeechRuntime>,
    backend: SpeechBackendRequest,
) -> CommandResult<SpeechBackendStatus> {
    let (status, detached) = runtime.begin_shutdown(backend)?;
    tauri::async_runtime::spawn_blocking(move || {
        for worker in detached {
            worker.shutdown();
        }
    });
    Ok(status)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_start(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechStartRequest,
    on_event: Channel<SpeechJobEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let requested_backend = request.profile.backend();
    let requested_epoch = request.lifecycle_epoch;
    let expected_project_state_version = request.expected_project_state_version;
    if expected_project_state_version > i64::MAX as u64 {
        return Err(CommandError::invalid_input(
            "The narration project state version is invalid.",
        ));
    }
    runtime
        .require_enabled_lifecycle(requested_backend, requested_epoch)
        .map_err(|error| speech_command_error(&error))?;
    let reference_id = request.reference_artifact_id.clone();
    let project_id = request.project_id;
    let reference_database = state.database.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &reference_database,
            project_id,
            expected_project_state_version,
        )?;
        match reference_id.as_deref() {
            Some(id) => resolve_audio_artifact(&reference_database, id, true).map(Some),
            None => Ok(None),
        }
    })
    .await;
    let reference = command_join_result(
        &runtime,
        requested_backend,
        requested_epoch,
        joined,
        "The reference lookup task stopped unexpectedly.",
    )??;
    let validated = request
        .validate(reference)
        .map_err(|error| speech_command_error(&error))?;
    let ownership = SpeechLifecycleOwnership::capture_project(
        &runtime,
        validated.backend,
        validated.lifecycle_epoch,
        validated.project_id,
        validated.expected_project_state_version,
    )
    .map_err(|error| speech_command_error(&error))?;
    let jobs = Arc::clone(&state.jobs);
    let ticket =
        register_owned_speech_job_with_hook(&runtime, &ownership, &state.database, &jobs, || {})
            .await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    initialize_registered_speech_job_with_hook(
        &runtime,
        &ownership,
        &state.database,
        &jobs,
        job_id,
        || {},
    )
    .await?;
    let database = state.database.clone();
    let credentials = state.credentials.clone();
    let cancellation = ticket.cancellation().clone();

    tauri::async_runtime::spawn(async move {
        let cancellation_bridge = ownership.cancellation.clone();
        let cancellation_watch = cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation_watch.cancelled().await;
            cancellation_bridge.cancel();
        });
        let context = SpeechBatchContext {
            runtime: &runtime,
            database: &database,
            credentials: &credentials,
            jobs: &jobs,
            job_id,
            project_id: validated.project_id,
            channel: &on_event,
        };
        let mut outcome = run_speech_batch(&context, validated, ownership.clone()).await;
        watcher.abort();
        if cancellation.is_cancelled() {
            outcome = Err(SpeechFailureCode::Cancelled);
        }
        finish_speech_job(
            &runtime, &ownership, &jobs, &database, job_id, outcome, &on_event,
        )
        .await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_voice_conversion_start(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechVoiceConversionStartRequest,
    on_event: Channel<SpeechJobEvent>,
) -> CommandResult<JobSnapshot> {
    if request.lifecycle_epoch > MAX_LIFECYCLE_EPOCH {
        return Err(CommandError::invalid_input(
            "The speech lifecycle epoch is invalid.",
        ));
    }
    let runtime = runtime.inner().clone();
    let lifecycle_epoch = request.lifecycle_epoch;
    runtime
        .require_enabled_lifecycle(SpeechBackendRequest::Chatterbox, lifecycle_epoch)
        .map_err(|error| speech_command_error(&error))?;
    let artifact_database = state.database.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let input = resolve_audio_artifact(&artifact_database, &request.input_artifact_id, false)?;
        let target =
            resolve_audio_artifact(&artifact_database, &request.target_voice_artifact_id, true)?;
        Ok::<_, CommandError>((input, target))
    })
    .await;
    let (input, target) = command_join_result(
        &runtime,
        SpeechBackendRequest::Chatterbox,
        lifecycle_epoch,
        joined,
        "The speech audio lookup task stopped unexpectedly.",
    )??;
    let ownership = SpeechLifecycleOwnership::capture(
        &runtime,
        SpeechBackendRequest::Chatterbox,
        lifecycle_epoch,
    )
    .map_err(|error| speech_command_error(&error))?;
    let jobs = Arc::clone(&state.jobs);
    let ticket =
        register_owned_speech_job_with_hook(&runtime, &ownership, &state.database, &jobs, || {})
            .await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    initialize_registered_speech_job_with_hook(
        &runtime,
        &ownership,
        &state.database,
        &jobs,
        job_id,
        || {},
    )
    .await?;
    let database = state.database.clone();
    let cancellation = ticket.cancellation().clone();

    tauri::async_runtime::spawn(async move {
        let cancellation_bridge = ownership.cancellation.clone();
        let cancellation_watch = cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation_watch.cancelled().await;
            cancellation_bridge.cancel();
        });
        let mut result = run_voice_conversion(
            &runtime,
            &database,
            input,
            target,
            ownership.clone(),
            job_id,
            &on_event,
        )
        .await;
        watcher.abort();
        if cancellation.is_cancelled() {
            result = Err(SpeechFailureCode::Cancelled);
        }
        finish_speech_job(
            &runtime, &ownership, &jobs, &database, job_id, result, &on_event,
        )
        .await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_alignment_start(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechAlignmentStartRequest,
    on_event: Channel<SpeechAlignmentEvent>,
) -> CommandResult<JobSnapshot> {
    let engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let validation_database = state.database.clone();
    let validated = tauri::async_runtime::spawn_blocking(move || {
        validate_alignment_start(&validation_database, request)
    })
    .await
    .map_err(|_| CommandError::internal("The alignment lookup task stopped unexpectedly."))??;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::AlignNarration).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let authority = SpeechProjectAuthority {
        project_id: validated.project_id,
        expected_state_version: validated.expected_project_state_version,
    };
    if let Err(error) = initialize_alignment_manifest(&state.database, job_id, authority).await {
        let _ = background::finish_failure(&jobs, job_id).await;
        return Err(error);
    }
    report_alignment_progress(&jobs, job_id, SpeechAlignmentPhase::Planning, 0, &on_event);

    let runtime = runtime.inner().clone();
    let database = state.database.clone();
    let cancellation = ticket.cancellation().clone();
    tauri::async_runtime::spawn(async move {
        let media_cancellation = MediaCancellationToken::default();
        let cancellation_bridge = media_cancellation.clone();
        let cancellation_watch = cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation_watch.cancelled().await;
            cancellation_bridge.cancel();
        });
        let operation_jobs = Arc::clone(&jobs);
        let operation_database = database.clone();
        let operation_channel = on_event.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            execute_alignment_job(
                &runtime,
                &engine,
                &operation_database,
                &operation_jobs,
                job_id,
                &validated,
                &media_cancellation,
                &operation_channel,
            )
        })
        .await
        .unwrap_or(Err(SpeechAlignmentFailureCode::MediaFailed));
        watcher.abort();
        finish_alignment_job(&jobs, &database, authority, job_id, outcome, &on_event).await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_job_results(
    state: State<'_, DesktopState>,
    job_id: JobId,
) -> CommandResult<SpeechJobResultsResponse> {
    let database = state.database.clone();
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let job = jobs.get(job_id)?.snapshot().clone();
        let manifest = read_manifest(&database, job_id)?;
        Ok(SpeechJobResultsResponse {
            job,
            backend: manifest.backend,
            project_id: manifest.project_id,
            expected_project_state_version: manifest.expected_project_state_version,
            results: manifest.results,
        })
    })
    .await
    .map_err(|_| CommandError::internal("The speech result task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_alignment_result(
    state: State<'_, DesktopState>,
    job_id: JobId,
) -> CommandResult<SpeechAlignmentResultResponse> {
    let database = state.database.clone();
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let job = jobs.get(job_id)?.snapshot().clone();
        if job.kind() != JobKind::AlignNarration {
            return Err(CommandError::invalid_input(
                "The job is not a narration alignment job.",
            ));
        }
        let manifest = read_alignment_manifest(&database, job_id)?;
        Ok(SpeechAlignmentResultResponse {
            job,
            project_id: manifest.project_id,
            expected_project_state_version: manifest.expected_project_state_version,
            result: manifest.result,
        })
    })
    .await
    .map_err(|_| CommandError::internal("The alignment result task stopped unexpectedly."))?
}
