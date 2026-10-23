//! Local ASR transcription through a supervised, package-managed worker.

mod job;
mod request;
mod runtime;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use osg_asr::CancellationToken as AsrCancellationToken;
use osg_domain::{JobKind, JobSnapshot};
use osg_media::{CancellationToken as MediaCancellationToken, MediaInput};
use tauri::{State, ipc::Channel};

use self::job::{AsrExecution, finish_asr, run_asr_job};
use self::request::{AsrJobEvent, AsrStartRequest, AsrStatus};
pub(crate) use self::runtime::{AsrRuntimeManager, package_to_asr};
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const WORKER_BYTES: &[u8] = include_bytes!("../../../../crates/osg-asr/worker/osg_asr_worker.py");
const MAX_TRANSCRIPTION_RANGE_MS: u64 = 24 * 60 * 60 * 1_000;
const RANGE_DURATION_TOLERANCE_US: u64 = 250_000;
const MEDIA_TIMEOUT: Duration = Duration::from_hours(24);
const ASR_TIMEOUT: Duration = Duration::from_hours(24);
const ASR_START_TIMEOUT: Duration = Duration::from_mins(10);

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn asr_status(state: State<'_, DesktopState>) -> CommandResult<AsrStatus> {
    let manager = state.asr.clone();
    tauri::async_runtime::spawn_blocking(move || manager.status())
        .await
        .map_err(|_| CommandError::internal("the ASR status task stopped unexpectedly"))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn asr_start(
    state: State<'_, DesktopState>,
    request: AsrStartRequest,
    on_event: Channel<AsrJobEvent>,
) -> CommandResult<JobSnapshot> {
    let engine_id = request.engine();
    let options = request.options()?;
    let requested_range = request.range_us()?;
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let local_media = state
        .editor
        .read()
        .map_err(|_| CommandError::internal("the editor session is unavailable"))?
        .local_media
        .clone()
        .ok_or_else(|| CommandError::invalid_input("Select a media file first."))?;
    let input = MediaInput::from_native_selection(local_media.path())?;
    let asset_id = local_media.asset_id();
    let manager = state.asr.clone();
    let service = tauri::async_runtime::spawn_blocking(move || manager.service(engine_id))
        .await
        .map_err(|_| CommandError::internal("the ASR runtime task stopped unexpectedly"))??;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::Transcribe).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let job_cancellation = ticket.cancellation().clone();
    let manager = state.asr.clone();

    tauri::async_runtime::spawn(async move {
        let media_cancellation = MediaCancellationToken::default();
        let asr_cancellation = AsrCancellationToken::default();
        let channel_closed = Arc::new(AtomicBool::new(false));
        let watcher_media = media_cancellation.clone();
        let watcher_asr = asr_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_media.cancel();
            watcher_asr.cancel();
        });

        let result = run_asr_job(AsrExecution {
            manager,
            media_engine,
            input,
            service,
            options,
            requested_range,
            media_cancellation: media_cancellation.clone(),
            asr_cancellation: asr_cancellation.clone(),
            channel: on_event.clone(),
            channel_closed: Arc::clone(&channel_closed),
            job_id,
        })
        .await;
        watcher.abort();

        finish_asr(
            &jobs,
            job_id,
            result,
            requested_range.map_or(0, |range| range.timeline_offset_ms),
            asset_id,
            &on_event,
        )
        .await;
    });

    Ok(initial)
}

#[cfg(test)]
mod tests;
