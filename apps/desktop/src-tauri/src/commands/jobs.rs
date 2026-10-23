//! Job listing, cancellation and orphaned-transcription recovery commands.

use std::sync::Arc;

use osg_domain::{JobId, JobKind, JobSnapshot, JobState, JobUpdate};
use tauri::State;

use super::{MAX_EXPOSED_ACTIVE_JOBS, MAX_EXPOSED_TERMINAL_JOBS};
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn jobs_list(state: State<'_, DesktopState>) -> CommandResult<Vec<JobSnapshot>> {
    let jobs = state
        .jobs
        .list()
        .map_err(CommandError::from)?
        .into_iter()
        .map(|ticket| ticket.snapshot().clone())
        .collect();
    bounded_job_list(jobs)
}

pub(super) fn bounded_job_list(jobs: Vec<JobSnapshot>) -> CommandResult<Vec<JobSnapshot>> {
    let (mut active, mut terminal): (Vec<_>, Vec<_>) =
        jobs.into_iter().partition(|job| !job.state().is_terminal());
    if active.len() > MAX_EXPOSED_ACTIVE_JOBS {
        return Err(CommandError::internal(
            "the active durable job registry exceeds the recovery limit",
        ));
    }
    terminal.sort_unstable_by_key(JobSnapshot::id);
    terminal.drain(..terminal.len().saturating_sub(MAX_EXPOSED_TERMINAL_JOBS));
    active.append(&mut terminal);
    active.sort_unstable_by_key(JobSnapshot::id);
    Ok(active)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn job_get(state: State<'_, DesktopState>, id: JobId) -> CommandResult<JobSnapshot> {
    state
        .jobs
        .get(id)
        .map(|ticket| ticket.snapshot().clone())
        .map_err(Into::into)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_cancel(
    state: State<'_, DesktopState>,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || jobs.apply(id, JobUpdate::RequestCancellation))
        .await
        .map_err(|_| CommandError::internal("the job cancellation task stopped unexpectedly"))?
        .map(|ticket| ticket.snapshot().clone())
        .map_err(Into::into)
}

/// Terminates an orphaned transcription after its `WebView` consumer reloads.
///
/// `transcribe` is shared by local ASR and Gemini, so the terminal result delivery kind—not this
/// job kind—decides whether a completed result is discarded or recovered. Active work has no
/// delivery yet and no consumer after reload. Request cancellation using the exact durable
/// sequence, but never forge terminal cancellation before the worker has actually quiesced. A
/// concurrent success wins and is returned for result-kind routing.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_recovery_abandon_transcribe(
    state: State<'_, DesktopState>,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || abandon_orphaned_transcribe(&jobs, id))
        .await
        .map_err(|_| {
            CommandError::internal("the transcription recovery task stopped unexpectedly")
        })?
}

pub(super) fn abandon_orphaned_transcribe(
    jobs: &crate::background::DesktopJobs,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    for _ in 0..4 {
        let current = jobs.get(id).map_err(CommandError::from)?;
        let snapshot = current.snapshot();
        if snapshot.kind() != JobKind::Transcribe {
            return Err(CommandError::invalid_input(
                "Only an orphaned transcription can be abandoned during recovery.",
            ));
        }
        let update = match snapshot.state() {
            JobState::Queued | JobState::Running => JobUpdate::RequestCancellation,
            JobState::Cancelling
            | JobState::Succeeded
            | JobState::Failed
            | JobState::Cancelled
            | JobState::Interrupted => return Ok(snapshot.clone()),
        };
        match jobs.apply_if_sequence(id, snapshot.sequence(), update) {
            Ok(ticket) => return Ok(ticket.snapshot().clone()),
            Err(osg_application::JobRegistryError::Conflict { .. }) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(CommandError::internal(
        "the orphaned transcription changed too often during recovery",
    ))
}
