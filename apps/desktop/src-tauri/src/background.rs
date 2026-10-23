use std::sync::Arc;

use osg_application::{JobRegistry, JobTicket};
use osg_domain::{JobId, JobKind, JobSnapshot, JobState, JobUpdate};
use osg_infrastructure::storage::Database;
use osg_infrastructure::storage::JobResultDeliveryDraft;

use crate::error::{CommandError, CommandResult};

pub(crate) type DesktopJobs = Arc<JobRegistry<Database>>;

/// Runs blocking storage or credential work off the async runtime and maps its error into a
/// command error. `operation` names the work in the path-free failure message.
pub(crate) async fn run_blocking<T, E>(
    operation: &'static str,
    task: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> CommandResult<T>
where
    T: Send + 'static,
    E: Into<CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| CommandError::internal(format!("the {operation} task stopped unexpectedly")))?
        .map_err(Into::into)
}

pub(crate) async fn register_running(
    jobs: &DesktopJobs,
    kind: JobKind,
) -> CommandResult<JobTicket> {
    let jobs = Arc::clone(jobs);
    run_blocking("job start", move || {
        let queued = jobs.register(kind)?;
        jobs.apply(queued.snapshot().id(), JobUpdate::Start)
    })
    .await
}

pub(crate) async fn apply(
    jobs: &DesktopJobs,
    id: JobId,
    update: JobUpdate,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    run_blocking("job update", move || jobs.apply(id, update))
        .await
        .map(|ticket| ticket.snapshot().clone())
}

pub(crate) async fn apply_if_sequence(
    jobs: &DesktopJobs,
    id: JobId,
    expected_sequence: u64,
    update: JobUpdate,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    run_blocking("guarded job update", move || {
        jobs.apply_if_sequence(id, expected_sequence, update)
    })
    .await
    .map(|ticket| ticket.snapshot().clone())
}

/// Commits a terminal success and its recoverable result payload as one `SQLite` transaction.
/// A delivery insertion failure leaves both the durable and resident job in the running state.
pub(crate) async fn succeed_with_result(
    jobs: &DesktopJobs,
    id: JobId,
    delivery: JobResultDeliveryDraft,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    run_blocking("durable job result", move || {
        jobs.apply_with_store(id, JobUpdate::Succeed, |database, sequence, snapshot| {
            database.complete_job_with_result(sequence, snapshot, &delivery)
        })
    })
    .await
    .map(|ticket| ticket.snapshot().clone())
}

pub(crate) async fn snapshot(jobs: &DesktopJobs, id: JobId) -> Option<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    run_blocking("job lookup", move || jobs.get(id))
        .await
        .ok()
        .map(|ticket| ticket.snapshot().clone())
}

pub(crate) async fn finish_cancellation(
    jobs: &DesktopJobs,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(jobs);
    run_blocking("cancellation", move || {
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
    .map(|ticket| ticket.snapshot().clone())
}

/// Settles a package or tool operation's job as cancelled from any pre-terminal state. A job that
/// already reached a terminal outcome cannot be cancelled; `too_late` is the caller's refusal.
pub(crate) fn confirm_cancelled(
    jobs: &JobRegistry<Database>,
    job_id: JobId,
    too_late: &'static str,
) -> CommandResult<JobSnapshot> {
    let current = jobs.get(job_id)?;
    let ticket = match current.snapshot().state() {
        JobState::Queued | JobState::Running => {
            jobs.apply(job_id, JobUpdate::RequestCancellation)?;
            jobs.apply(job_id, JobUpdate::ConfirmCancelled)?
        }
        JobState::Cancelling => jobs.apply(job_id, JobUpdate::ConfirmCancelled)?,
        JobState::Cancelled => current,
        JobState::Succeeded | JobState::Failed | JobState::Interrupted => {
            return Err(CommandError::internal(too_late));
        }
    };
    Ok(ticket.snapshot().clone())
}

pub(crate) async fn finish_failure(jobs: &DesktopJobs, id: JobId) -> Option<JobSnapshot> {
    match apply(jobs, id, JobUpdate::Fail).await {
        Ok(job) => Some(job),
        Err(_) => snapshot(jobs, id).await,
    }
}
