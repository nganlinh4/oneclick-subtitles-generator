use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, RemovalOutcome,
    RenderPackageId, RenderPackageManager, RenderPackageStatus,
};
use osg_infrastructure::storage::Database;
use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::render::RenderRuntimeHost;

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone)]
pub(crate) struct RenderPackageRuntime(Arc<RuntimeInner>);

struct RuntimeInner {
    manager: RenderPackageManager,
    render: RenderRuntimeHost,
    jobs: Arc<JobRegistry<Database>>,
    operation: Mutex<Option<ActiveOperation>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RenderPackageAction {
    Install,
    Remove,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RenderPackagePhase {
    Preparing,
    Downloading,
    Verifying,
    Extracting,
    Publishing,
    Removing,
}

#[derive(Clone, Debug)]
struct ActiveOperation {
    job_id: JobId,
    action: RenderPackageAction,
    phase: RenderPackagePhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
    cancellation: CancellationToken,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderPackageOperation {
    job: JobSnapshot,
    package: RenderPackageId,
    action: RenderPackageAction,
    phase: RenderPackagePhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

impl RenderPackageOperation {
    fn from_active(active: &ActiveOperation, job: JobSnapshot) -> Self {
        Self {
            job,
            package: RenderPackageId::RemotionRuntime,
            action: active.action,
            phase: active.phase,
            basis_points: active.basis_points,
            bytes_done: active.bytes_done,
            total_bytes: active.total_bytes,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderPackageStatusResponse {
    schema_version: u32,
    #[serde(flatten)]
    package: RenderPackageStatus,
    operation: Option<RenderPackageOperation>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum RenderPackageEvent {
    Progress {
        operation: RenderPackageOperation,
    },
    Completed {
        job: JobSnapshot,
        package: RenderPackageId,
        action: RenderPackageAction,
    },
    Cancelled {
        job: JobSnapshot,
        package: RenderPackageId,
        action: RenderPackageAction,
    },
    Failed {
        job: Option<JobSnapshot>,
        package: RenderPackageId,
        action: RenderPackageAction,
        error: CommandError,
    },
}

#[derive(Debug)]
enum ExecutionFailure {
    Package(PackageError),
    Internal(CommandError),
}

impl RenderPackageRuntime {
    #[must_use]
    pub(crate) fn new(
        manager: RenderPackageManager,
        render: RenderRuntimeHost,
        jobs: Arc<JobRegistry<Database>>,
    ) -> Self {
        Self(Arc::new(RuntimeInner {
            manager,
            render,
            jobs,
            operation: Mutex::new(None),
        }))
    }

    fn status(&self) -> CommandResult<RenderPackageStatusResponse> {
        let operation = {
            let active = self.0.operation.lock().map_err(|_| {
                CommandError::internal("The render package coordinator is unavailable.")
            })?;
            match active.as_ref() {
                Some(operation) => {
                    let job = self.0.jobs.get(operation.job_id)?.snapshot().clone();
                    Some(RenderPackageOperation::from_active(operation, job))
                }
                None => None,
            }
        };
        Ok(RenderPackageStatusResponse {
            schema_version: SCHEMA_VERSION,
            package: self.0.manager.status(),
            operation,
        })
    }

    fn activate(
        &self,
        job: &JobSnapshot,
        action: RenderPackageAction,
        cancellation: CancellationToken,
    ) -> CommandResult<()> {
        let mut active = self.0.operation.lock().map_err(|_| {
            CommandError::internal("The render package coordinator is unavailable.")
        })?;
        if active.is_some() {
            return Err(
                PackageError::RenderOperationInProgress(RenderPackageId::RemotionRuntime).into(),
            );
        }
        *active = Some(ActiveOperation {
            job_id: job.id(),
            action,
            phase: RenderPackagePhase::Preparing,
            basis_points: 0,
            bytes_done: 0,
            total_bytes: 0,
            cancellation,
        });
        Ok(())
    }

    fn report(
        &self,
        job_id: JobId,
        progress: OperationProgress,
        channel: &Channel<RenderPackageEvent>,
    ) -> CommandResult<()> {
        let mut slot = self.0.operation.lock().map_err(|_| {
            CommandError::internal("The render package coordinator is unavailable.")
        })?;
        let active = slot.as_mut().ok_or_else(|| {
            CommandError::internal("The render package operation is unavailable.")
        })?;
        if active.job_id != job_id {
            return Err(CommandError::internal(
                "The render package operation identity changed.",
            ));
        }
        let current = self.0.jobs.get(job_id)?;
        if matches!(
            current.snapshot().state(),
            JobState::Cancelling | JobState::Cancelled
        ) {
            active.cancellation.cancel();
            return Ok(());
        }
        let (phase, mapped_basis_points) = map_progress(active.action, progress)?;
        if phase_rank(phase) < phase_rank(active.phase) {
            return Err(CommandError::internal(
                "The render package progress phase regressed.",
            ));
        }
        let basis_points = mapped_basis_points.max(current.snapshot().progress().basis_points());
        let job = if basis_points > current.snapshot().progress().basis_points() {
            self.0
                .jobs
                .apply(
                    job_id,
                    JobUpdate::ReportProgress(
                        JobProgress::from_basis_points(basis_points).map_err(|_| {
                            CommandError::internal("The render package progress is invalid.")
                        })?,
                    ),
                )?
                .snapshot()
                .clone()
        } else {
            current.snapshot().clone()
        };
        active.phase = phase;
        active.basis_points = job.progress().basis_points();
        active.bytes_done = progress.bytes_done;
        active.total_bytes = progress.total_bytes;
        let operation = RenderPackageOperation::from_active(active, job);
        drop(slot);
        let _ = channel.send(RenderPackageEvent::Progress { operation });
        Ok(())
    }

    fn finish(
        &self,
        job_id: JobId,
        action: RenderPackageAction,
        result: Result<(), ExecutionFailure>,
        channel: &Channel<RenderPackageEvent>,
    ) {
        let event = match result {
            Err(ExecutionFailure::Package(PackageError::Cancelled)) => {
                match finish_cancelled(&self.0.jobs, job_id) {
                    Ok(job) => RenderPackageEvent::Cancelled {
                        job,
                        package: RenderPackageId::RemotionRuntime,
                        action,
                    },
                    Err(error) => self.failed_event(job_id, action, error),
                }
            }
            Ok(()) => match self.0.jobs.apply(job_id, JobUpdate::Succeed) {
                Ok(job) => RenderPackageEvent::Completed {
                    job: job.snapshot().clone(),
                    package: RenderPackageId::RemotionRuntime,
                    action,
                },
                Err(error) => self.failed_event(job_id, action, error.into()),
            },
            Err(ExecutionFailure::Package(error)) => {
                let _ = self.0.jobs.apply(job_id, JobUpdate::Fail);
                self.failed_event(job_id, action, error.into())
            }
            Err(ExecutionFailure::Internal(error)) => {
                let _ = self.0.jobs.apply(job_id, JobUpdate::Fail);
                self.failed_event(job_id, action, error)
            }
        };
        if let Ok(mut active) = self.0.operation.lock() {
            *active = None;
        }
        let _ = channel.send(event);
    }

    fn failed_event(
        &self,
        job_id: JobId,
        action: RenderPackageAction,
        error: CommandError,
    ) -> RenderPackageEvent {
        RenderPackageEvent::Failed {
            job: self
                .0
                .jobs
                .get(job_id)
                .ok()
                .map(|ticket| ticket.snapshot().clone()),
            package: RenderPackageId::RemotionRuntime,
            action,
            error,
        }
    }
}

async fn start_operation(
    runtime: RenderPackageRuntime,
    action: RenderPackageAction,
    channel: Channel<RenderPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let package_cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(&initial, action, package_cancellation.clone()) {
        let _ = jobs.apply(job_id, JobUpdate::Fail);
        return Err(error);
    }
    let watcher_cancellation = package_cancellation.clone();
    let job_cancellation = ticket.cancellation().clone();
    let background_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_cancellation.cancel();
        });
        let worker_runtime = background_runtime.clone();
        let worker_channel = channel.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            execute(
                &worker_runtime,
                job_id,
                action,
                &package_cancellation,
                &worker_channel,
            )
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or_else(|_| {
            Err(ExecutionFailure::Internal(CommandError::internal(
                "The render package task stopped unexpectedly.",
            )))
        });
        background_runtime.finish(job_id, action, result, &channel);
    });
    Ok(initial)
}

fn execute(
    runtime: &RenderPackageRuntime,
    job_id: JobId,
    action: RenderPackageAction,
    cancellation: &CancellationToken,
    channel: &Channel<RenderPackageEvent>,
) -> Result<(), ExecutionFailure> {
    let progress_failed = Arc::new(AtomicBool::new(false));
    let failed = Arc::clone(&progress_failed);
    let report_runtime = runtime.clone();
    let report_channel = channel.clone();
    let report_cancellation = cancellation.clone();
    let progress = move |value| {
        if report_runtime
            .report(job_id, value, &report_channel)
            .is_err()
        {
            failed.store(true, Ordering::Release);
            report_cancellation.cancel();
        }
    };
    let result =
        match action {
            RenderPackageAction::Install => runtime
                .0
                .manager
                .install(cancellation, &progress)
                .map(|_| ()),
            RenderPackageAction::Remove => {
                runtime.0.manager.remove(cancellation, &progress).and_then(
                    |outcome| match outcome {
                        RemovalOutcome::Missing | RemovalOutcome::Removed => Ok(()),
                        RemovalOutcome::PreservedModified => Err(PackageError::InvalidInstall),
                    },
                )
            }
        };
    if progress_failed.load(Ordering::Acquire) {
        return Err(ExecutionFailure::Internal(CommandError::internal(
            "The render package progress could not be recorded safely.",
        )));
    }
    result.map_err(ExecutionFailure::Package)?;
    runtime
        .0
        .render
        .refresh_managed()
        .map_err(ExecutionFailure::Internal)
}

fn map_progress(
    action: RenderPackageAction,
    progress: OperationProgress,
) -> CommandResult<(RenderPackagePhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (RenderPackageAction::Install, OperationPhase::Preparing) => {
            (RenderPackagePhase::Preparing, 0_u32, 0_u32)
        }
        (RenderPackageAction::Install, OperationPhase::Downloading) => {
            (RenderPackagePhase::Downloading, 0, 5_000)
        }
        (RenderPackageAction::Install, OperationPhase::Verifying) => {
            (RenderPackagePhase::Verifying, 5_000, 1_000)
        }
        (RenderPackageAction::Install, OperationPhase::Extracting) => {
            (RenderPackagePhase::Extracting, 6_000, 3_000)
        }
        (RenderPackageAction::Install, OperationPhase::Publishing) => {
            (RenderPackagePhase::Publishing, 9_000, 900)
        }
        (RenderPackageAction::Remove, OperationPhase::Removing) => {
            (RenderPackagePhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "The render package progress phase is invalid.",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("The render package progress is invalid."))?,
    ))
}

const fn phase_rank(phase: RenderPackagePhase) -> u8 {
    match phase {
        RenderPackagePhase::Preparing => 0,
        RenderPackagePhase::Downloading => 1,
        RenderPackagePhase::Verifying => 2,
        RenderPackagePhase::Extracting => 3,
        RenderPackagePhase::Publishing => 4,
        RenderPackagePhase::Removing => 5,
    }
}

fn finish_cancelled(jobs: &JobRegistry<Database>, job_id: JobId) -> CommandResult<JobSnapshot> {
    let current = jobs.get(job_id)?;
    let ticket = match current.snapshot().state() {
        JobState::Queued | JobState::Running => {
            jobs.apply(job_id, JobUpdate::RequestCancellation)?;
            jobs.apply(job_id, JobUpdate::ConfirmCancelled)?
        }
        JobState::Cancelling => jobs.apply(job_id, JobUpdate::ConfirmCancelled)?,
        JobState::Cancelled => current,
        JobState::Succeeded | JobState::Failed | JobState::Interrupted => {
            return Err(CommandError::internal(
                "The render package cancellation arrived after finalization.",
            ));
        }
    };
    Ok(ticket.snapshot().clone())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State by value"
)]
pub(crate) async fn render_package_status(
    runtime: State<'_, RenderPackageRuntime>,
) -> CommandResult<RenderPackageStatusResponse> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| CommandError::internal("The render package status task stopped."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel by value"
)]
pub(crate) async fn render_package_install(
    runtime: State<'_, RenderPackageRuntime>,
    on_event: Channel<RenderPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status())
        .await
        .map_err(|_| CommandError::internal("The render package check stopped."))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    start_operation(runtime, RenderPackageAction::Install, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel by value"
)]
pub(crate) async fn render_package_remove(
    runtime: State<'_, RenderPackageRuntime>,
    on_event: Channel<RenderPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    start_operation(runtime, RenderPackageAction::Remove, on_event).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_order_is_total_and_stable() {
        assert!(
            phase_rank(RenderPackagePhase::Preparing) < phase_rank(RenderPackagePhase::Downloading)
        );
        assert!(
            phase_rank(RenderPackagePhase::Downloading) < phase_rank(RenderPackagePhase::Verifying)
        );
        assert!(
            phase_rank(RenderPackagePhase::Verifying) < phase_rank(RenderPackagePhase::Extracting)
        );
        assert!(
            phase_rank(RenderPackagePhase::Extracting) < phase_rank(RenderPackagePhase::Publishing)
        );
        assert!(
            phase_rank(RenderPackagePhase::Publishing) < phase_rank(RenderPackagePhase::Removing)
        );
    }

    #[test]
    fn whole_job_progress_is_monotonic_across_render_package_phases() {
        let values = [
            (OperationPhase::Downloading, 10_000),
            (OperationPhase::Verifying, 0),
            (OperationPhase::Extracting, 5_000),
            (OperationPhase::Publishing, 10_000),
        ]
        .map(|(phase, basis_points)| {
            map_progress(
                RenderPackageAction::Install,
                OperationProgress {
                    phase,
                    basis_points,
                    bytes_done: 0,
                    total_bytes: 0,
                },
            )
            .unwrap()
            .1
        });
        assert_eq!(values, [5_000, 5_000, 7_500, 9_900]);
    }
}
