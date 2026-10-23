//! Native media pipeline: inspection, compatibility transforms, audio extraction and waveforms.

mod execution;
mod request;
mod runtime;

use std::sync::Arc;
use std::time::Duration;

use osg_domain::{AssetId, JobId, JobSnapshot, JobUpdate};
use osg_media::{CancellationToken, MediaInput, RunControl};
use tauri::{State, ipc::Channel};

use self::execution::{execute_operation, fail_operation, finish_operation, progress_sink};
use self::request::{
    MediaInspectionResponse, MediaPipelineEvent, MediaPipelinePhase, MediaPipelineRequest,
    ValidatedOperation,
};
pub(crate) use self::runtime::MediaPipelineRuntime;
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const INSPECTION_TIMEOUT: Duration = Duration::from_secs(30);
const OPERATION_TIMEOUT: Duration = Duration::from_hours(24);
const MAX_OPERATION_TIME_US: u64 = 7 * 24 * 60 * 60 * 1_000_000;
const MAX_WAVEFORM_POINTS: usize = 1_000_000;
const MAX_CONCURRENT_OPERATIONS: usize = 2;
const MAX_PIPELINE_PLAYBACKS: usize = 64;
const PROCESSING_START_BASIS_POINTS: u16 = 500;
const PROCESSING_END_BASIS_POINTS: u16 = 9_500;
const PUBLISHING_BASIS_POINTS: u16 = 9_700;

#[cfg(feature = "e2e-automation")]
const LONG_MEDIA_RECOVERY_WORKFLOW: &str = "long-media-operation-recovery";
#[cfg(feature = "e2e-automation")]
const LONG_MEDIA_RECOVERY_SEED_PHASE: &str = "seed";

#[cfg(feature = "e2e-automation")]
fn should_hold_waveform_for_recovery(operation: &ValidatedOperation) -> bool {
    matches!(operation, ValidatedOperation::GenerateWaveform { .. })
        && std::env::var("OSG_E2E_WORKFLOW").as_deref() == Ok(LONG_MEDIA_RECOVERY_WORKFLOW)
        && std::env::var("OSG_E2E_PERSISTENCE_PHASE").as_deref()
            == Ok(LONG_MEDIA_RECOVERY_SEED_PHASE)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn media_pipeline_inspect(
    state: State<'_, DesktopState>,
    runtime: State<'_, MediaPipelineRuntime>,
    asset_id: AssetId,
) -> CommandResult<MediaInspectionResponse> {
    let pipeline = runtime.pipeline()?;
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = database
            .resolve_media(asset_id)?
            .ok_or_else(CommandError::media_unavailable)?;
        let input = MediaInput::from_native_selection(resolved.path())?;
        let control = RunControl::new(INSPECTION_TIMEOUT)?;
        let inspection = pipeline.inspect(&input, &control)?;
        Ok(MediaInspectionResponse::from_inspection(
            asset_id,
            &inspection,
        ))
    })
    .await
    .map_err(|_| CommandError::internal("The media inspection task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn media_pipeline_start(
    state: State<'_, DesktopState>,
    runtime: State<'_, MediaPipelineRuntime>,
    request: MediaPipelineRequest,
    on_event: Channel<MediaPipelineEvent>,
) -> CommandResult<JobSnapshot> {
    let request = request.validate()?;
    let operation = request.operation.wire_operation();
    let pipeline = runtime.pipeline()?;
    // Independent Gemini analysis windows must be prepared together: serializing their short
    // clips here silently turns N requested provider calls into batches of two. Other heavyweight
    // media jobs retain the shared resource queue.
    let permit = if matches!(request.operation, ValidatedOperation::AnalysisClip { .. }) {
        None
    } else {
        Some(runtime.slots.acquire().await.ok_or_else(|| {
            CommandError::internal("The native media operation queue is unavailable.")
        })?)
    };
    let database = state.database.clone();
    let resolved = tauri::async_runtime::spawn_blocking({
        let database = database.clone();
        let asset_id = request.asset_id;
        move || {
            database
                .resolve_media(asset_id)?
                .ok_or_else(CommandError::media_unavailable)
        }
    })
    .await
    .map_err(|_| CommandError::internal("The media lookup task stopped unexpectedly."))??;
    let input = MediaInput::from_native_selection(resolved.path())?;
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, request.operation.job_kind()).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    if let Err(error) = runtime.jobs.remember(job_id) {
        let _ = background::apply(&jobs, job_id, JobUpdate::Fail).await;
        return Err(error);
    }
    let cancellation = ticket.cancellation().clone();
    let runtime = runtime.inner().clone();

    let _ = on_event.send(MediaPipelineEvent::Progress {
        job: initial.clone(),
        operation,
        phase: MediaPipelinePhase::Probing,
        fraction: None,
    });
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let process_cancellation = CancellationToken::default();
        let cancellation_bridge = process_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            cancellation.cancelled().await;
            cancellation_bridge.cancel();
        });
        let progress = progress_sink(Arc::clone(&jobs), job_id, operation, on_event.clone());
        let control = match RunControl::new(OPERATION_TIMEOUT) {
            Ok(control) => control
                .with_cancellation(process_cancellation)
                .with_progress(progress),
            Err(error) => {
                watcher.abort();
                fail_operation(&jobs, job_id, operation, error.into(), &on_event).await;
                return;
            }
        };
        let source_asset_id = request.asset_id;
        let publication_metadata = request.operation.publication_metadata(source_asset_id);
        let requested_operation = request.operation;
        #[cfg(feature = "e2e-automation")]
        if should_hold_waveform_for_recovery(&requested_operation) {
            // This channel-only hold starts after the durable job is registered as running. Real
            // two-hour waveform generation is faster than WebDriver screenshot capture on modern
            // machines, so duration alone cannot make a process-death test deterministic. The
            // supervisor tears this process down while the sleep is pending; no release build can
            // compile this branch, and the finite bound prevents a stranded automation process.
            tokio::time::sleep(Duration::from_mins(1)).await;
        }
        let operation_database = database.clone();
        let source_content_hash = resolved.content_hash();
        let native_result = tauri::async_runtime::spawn_blocking(move || {
            execute_operation(
                &pipeline,
                input,
                &requested_operation,
                &control,
                &operation_database,
                source_content_hash,
            )
        })
        .await
        .map_err(|_| CommandError::internal("The native media operation stopped unexpectedly."))
        .and_then(|result| result);
        watcher.abort();
        finish_operation(
            &runtime,
            &database,
            &jobs,
            job_id,
            operation,
            source_asset_id,
            resolved,
            publication_metadata,
            native_result,
            &on_event,
        )
        .await;
    });
    Ok(initial)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn media_pipeline_cancel(
    state: State<'_, DesktopState>,
    runtime: State<'_, MediaPipelineRuntime>,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    let runtime_jobs = Arc::clone(&runtime.jobs);
    tauri::async_runtime::spawn_blocking(move || {
        runtime_jobs.run_if_cancellable(job_id, || {
            let current = jobs.get(job_id)?;
            if current.snapshot().state().is_terminal() {
                return Ok(current.snapshot().clone());
            }
            jobs.apply(job_id, JobUpdate::RequestCancellation)
                .map(|ticket| ticket.snapshot().clone())
                .map_err(Into::into)
        })
    })
    .await
    .map_err(|_| CommandError::internal("The media cancellation task stopped unexpectedly."))?
}

#[cfg(test)]
mod tests;
