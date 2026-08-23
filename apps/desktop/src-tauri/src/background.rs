use std::sync::Arc;

use osg_application::{JobRegistry, JobTicket};
use osg_domain::{JobId, JobKind, JobSnapshot, JobState, JobUpdate};
use osg_infrastructure::storage::Database;
use osg_infrastructure::storage::JobResultDeliveryDraft;

use crate::error::{CommandError, CommandResult};

pub(crate) type DesktopJobs = Arc<JobRegistry<Database>>;

pub(crate) async fn register_running(
    jobs: &DesktopJobs,
    kind: JobKind,
) -> CommandResult<JobTicket> {
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let queued = jobs.register(kind)?;
        jobs.apply(queued.snapshot().id(), JobUpdate::Start)
    })
    .await
    .map_err(|_| CommandError::internal("the background job could not be started"))?
    .map_err(Into::into)
}

pub(crate) async fn apply(
    jobs: &DesktopJobs,
    id: JobId,
    update: JobUpdate,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || jobs.apply(id, update))
        .await
        .map_err(|_| CommandError::internal("the job update task stopped unexpectedly"))?
        .map(|ticket| ticket.snapshot().clone())
        .map_err(Into::into)
}

pub(crate) async fn apply_if_sequence(
    jobs: &DesktopJobs,
    id: JobId,
    expected_sequence: u64,
    update: JobUpdate,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || {
        jobs.apply_if_sequence(id, expected_sequence, update)
    })
    .await
    .map_err(|_| CommandError::internal("the guarded job update task stopped unexpectedly"))?
    .map(|ticket| ticket.snapshot().clone())
    .map_err(Into::into)
}

/// Commits a terminal success and its recoverable result payload as one `SQLite` transaction.
/// A delivery insertion failure leaves both the durable and resident job in the running state.
pub(crate) async fn succeed_with_result(
    jobs: &DesktopJobs,
    id: JobId,
    delivery: JobResultDeliveryDraft,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || {
        jobs.apply_with_store(id, JobUpdate::Succeed, |database, sequence, snapshot| {
            database.complete_job_with_result(sequence, snapshot, &delivery)
        })
    })
    .await
    .map_err(|_| CommandError::internal("the durable job result task stopped unexpectedly"))?
    .map(|ticket| ticket.snapshot().clone())
    .map_err(Into::into)
}

pub(crate) async fn snapshot(jobs: &DesktopJobs, id: JobId) -> Option<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || jobs.get(id))
        .await
        .ok()
        .and_then(Result::ok)
        .map(|ticket| ticket.snapshot().clone())
}

pub(crate) async fn finish_cancellation(
    jobs: &DesktopJobs,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let current = jobs.get(id)?;
        match current.snapshot().state() {
            JobState::Queued => jobs.apply(id, JobUpdate::RequestCancellation),
            JobState::Running => {
                jobs.apply(id, JobUpdate::RequestCancellation)?;
                jobs.apply(id, JobUpdate::ConfirmCancelled)
            }
            JobState::Cancelling => jobs.apply(id, JobUpdate::ConfirmCancelled),
            JobState::Succeeded
            | JobState::Failed
            | JobState::Cancelled
            | JobState::Interrupted => Ok(current),
        }
    })
    .await
    .map_err(|_| CommandError::internal("the cancellation task stopped unexpectedly"))?
    .map(|ticket| ticket.snapshot().clone())
    .map_err(Into::into)
}

pub(crate) async fn finish_failure(jobs: &DesktopJobs, id: JobId) -> Option<JobSnapshot> {
    match apply(jobs, id, JobUpdate::Fail).await {
        Ok(job) => Some(job),
        Err(_) => snapshot(jobs, id).await,
    }
}
