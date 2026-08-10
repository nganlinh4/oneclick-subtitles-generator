use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, RemovalOutcome,
    SpeechPackageId, SpeechPackageManager, SpeechPackageStatus,
};
use osg_infrastructure::storage::Database;
use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::background;
use crate::error::{CommandError, CommandResult};

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone)]
pub(crate) struct SpeechPackageRuntime(Arc<RuntimeInner>);

struct RuntimeInner {
    manager: SpeechPackageManager,
    jobs: Arc<JobRegistry<Database>>,
    operation: Mutex<OperationSlot>,
}

#[derive(Debug, Default)]
enum OperationSlot {
    #[default]
    Idle,
    Reserved {
        backend: SpeechPackageId,
    },
    Active {
        record: OperationRecord,
        cancellation: CancellationToken,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechPackageAction {
    Install,
    Update,
    Remove,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechPackagePhase {
    Preparing,
    Downloading,
    Verifying,
    Extracting,
    Publishing,
    Removing,
}

#[derive(Clone, Debug)]
struct OperationRecord {
    job_id: JobId,
    backend: SpeechPackageId,
    action: SpeechPackageAction,
    phase: SpeechPackagePhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechPackageOperation {
    job: JobSnapshot,
    backend: SpeechPackageId,
    action: SpeechPackageAction,
    phase: SpeechPackagePhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

impl SpeechPackageOperation {
    fn from_record(record: &OperationRecord, job: JobSnapshot) -> Self {
        Self {
            job,
            backend: record.backend,
            action: record.action,
            phase: record.phase,
            basis_points: record.basis_points,
            bytes_done: record.bytes_done,
            total_bytes: record.total_bytes,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechPackagesStatus {
    schema_version: u32,
    packages: Vec<SpeechPackageStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechPackageStatusEntry {
    #[serde(flatten)]
    package: SpeechPackageStatus,
    operation: Option<SpeechPackageOperation>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum SpeechPackageEvent {
    Progress {
        operation: SpeechPackageOperation,
    },
    Completed {
        job: JobSnapshot,
        backend: SpeechPackageId,
        action: SpeechPackageAction,
    },
    Cancelled {
        job: JobSnapshot,
        backend: SpeechPackageId,
        action: SpeechPackageAction,
    },
    Failed {
        job: Option<JobSnapshot>,
        backend: SpeechPackageId,
        action: SpeechPackageAction,
        error: CommandError,
    },
}

struct OperationReservation {
    runtime: SpeechPackageRuntime,
    backend: SpeechPackageId,
    activated: bool,
}

impl Drop for OperationReservation {
    fn drop(&mut self) {
        if self.activated {
            return;
        }
        if let Ok(mut slot) = self.runtime.0.operation.lock()
            && matches!(*slot, OperationSlot::Reserved { backend } if backend == self.backend)
        {
            *slot = OperationSlot::Idle;
        }
    }
}

#[derive(Debug)]
enum ExecutionFailure {
    Package(PackageError),
    Internal,
}

impl SpeechPackageRuntime {
    #[must_use]
    pub(crate) fn new(manager: SpeechPackageManager, jobs: Arc<JobRegistry<Database>>) -> Self {
        Self(Arc::new(RuntimeInner {
            manager,
            jobs,
            operation: Mutex::new(OperationSlot::Idle),
        }))
    }

    fn reserve(&self, backend: SpeechPackageId) -> CommandResult<OperationReservation> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the speech package coordinator is unavailable")
            })?;
        if !matches!(*slot, OperationSlot::Idle) {
            return Err(PackageError::SpeechOperationInProgress(backend).into());
        }
        *slot = OperationSlot::Reserved { backend };
        Ok(OperationReservation {
            runtime: self.clone(),
            backend,
            activated: false,
        })
    }

    fn activate(
        &self,
        reservation: &mut OperationReservation,
        job: &JobSnapshot,
        action: SpeechPackageAction,
        cancellation: CancellationToken,
    ) -> CommandResult<()> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the speech package coordinator is unavailable")
            })?;
        if !matches!(*slot, OperationSlot::Reserved { backend } if backend == reservation.backend) {
            return Err(CommandError::internal(
                "the speech package reservation is unavailable",
            ));
        }
        *slot = OperationSlot::Active {
            record: OperationRecord {
                job_id: job.id(),
                backend: reservation.backend,
                action,
                phase: SpeechPackagePhase::Preparing,
                basis_points: job.progress().basis_points(),
                bytes_done: 0,
                total_bytes: 0,
            },
            cancellation,
        };
        reservation.activated = true;
        Ok(())
    }

    fn status(&self) -> CommandResult<SpeechPackagesStatus> {
        let operation = {
            let slot = self.0.operation.lock().map_err(|_| {
                CommandError::internal("the speech package coordinator is unavailable")
            })?;
            if let OperationSlot::Active { record, .. } = &*slot {
                let job = self.0.jobs.get(record.job_id)?.snapshot().clone();
                Some(SpeechPackageOperation::from_record(record, job))
            } else {
                None
            }
        };
        Ok(SpeechPackagesStatus {
            schema_version: SCHEMA_VERSION,
            packages: self
                .0
                .manager
                .statuses()
                .into_iter()
                .map(|package| SpeechPackageStatusEntry {
                    operation: operation
                        .as_ref()
                        .filter(|active| active.backend == package.id)
                        .cloned(),
                    package,
                })
                .collect(),
        })
    }

    fn report_progress(
        &self,
        job_id: JobId,
        action: SpeechPackageAction,
        progress: OperationProgress,
        on_event: &Channel<SpeechPackageEvent>,
    ) -> CommandResult<()> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the speech package coordinator is unavailable")
            })?;
        let OperationSlot::Active {
            record,
            cancellation,
        } = &mut *slot
        else {
            return Err(CommandError::internal(
                "the speech package operation is unavailable",
            ));
        };
        if record.job_id != job_id || record.action != action {
            return Err(CommandError::internal(
                "the speech package operation identity changed",
            ));
        }
        let current = self.0.jobs.get(job_id)?;
        if matches!(
            current.snapshot().state(),
            JobState::Cancelling | JobState::Cancelled
        ) {
            cancellation.cancel();
            return Ok(());
        }
        let (phase, mapped_basis_points) = map_progress(action, progress)?;
        if phase_rank(action, phase) < phase_rank(action, record.phase) {
            return Err(CommandError::internal(
                "the speech package progress phase regressed",
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
                            CommandError::internal("the speech package progress is invalid")
                        })?,
                    ),
                )?
                .snapshot()
                .clone()
        } else {
            current.snapshot().clone()
        };
        record.phase = phase;
        record.basis_points = job.progress().basis_points();
        record.bytes_done = progress.bytes_done;
        record.total_bytes = progress.total_bytes;
        let operation = SpeechPackageOperation::from_record(record, job);
        drop(slot);
        let _ = on_event.send(SpeechPackageEvent::Progress { operation });
        Ok(())
    }

    fn finish(
        &self,
        job_id: JobId,
        backend: SpeechPackageId,
        action: SpeechPackageAction,
        result: Result<(), ExecutionFailure>,
        on_event: &Channel<SpeechPackageEvent>,
    ) {
        let Ok(mut slot) = self.0.operation.lock() else {
            let _ = on_event.send(SpeechPackageEvent::Failed {
                job: None,
                backend,
                action,
                error: CommandError::internal("the speech package coordinator is unavailable"),
            });
            return;
        };
        if !matches!(&*slot, OperationSlot::Active { record, .. } if record.job_id == job_id) {
            let _ = on_event.send(SpeechPackageEvent::Failed {
                job: self
                    .0
                    .jobs
                    .get(job_id)
                    .ok()
                    .map(|ticket| ticket.snapshot().clone()),
                backend,
                action,
                error: CommandError::internal("the speech package operation is unavailable"),
            });
            return;
        }
        let event = self.terminal_event(job_id, backend, action, result);
        *slot = OperationSlot::Idle;
        drop(slot);
        let _ = on_event.send(event);
    }

    fn terminal_event(
        &self,
        job_id: JobId,
        backend: SpeechPackageId,
        action: SpeechPackageAction,
        result: Result<(), ExecutionFailure>,
    ) -> SpeechPackageEvent {
        if matches!(
            result,
            Err(ExecutionFailure::Package(PackageError::Cancelled))
        ) {
            return match finish_cancelled_job(&self.0.jobs, job_id) {
                Ok(job) => SpeechPackageEvent::Cancelled {
                    job,
                    backend,
                    action,
                },
                Err(error) => SpeechPackageEvent::Failed {
                    job: self
                        .0
                        .jobs
                        .get(job_id)
                        .ok()
                        .map(|ticket| ticket.snapshot().clone()),
                    backend,
                    action,
                    error,
                },
            };
        }
        match result {
            Ok(()) => match self.0.jobs.apply(job_id, JobUpdate::Succeed) {
                Ok(ticket) => SpeechPackageEvent::Completed {
                    job: ticket.snapshot().clone(),
                    backend,
                    action,
                },
                Err(error) => SpeechPackageEvent::Failed {
                    job: self
                        .0
                        .jobs
                        .get(job_id)
                        .ok()
                        .map(|ticket| ticket.snapshot().clone()),
                    backend,
                    action,
                    error: error.into(),
                },
            },
            Err(failure) => {
                let job = self
                    .0
                    .jobs
                    .apply(job_id, JobUpdate::Fail)
                    .ok()
                    .map(|ticket| ticket.snapshot().clone())
                    .or_else(|| {
                        self.0
                            .jobs
                            .get(job_id)
                            .ok()
                            .map(|ticket| ticket.snapshot().clone())
                    });
                SpeechPackageEvent::Failed {
                    job,
                    backend,
                    action,
                    error: execution_error(failure),
                }
            }
        }
    }
}

impl fmt::Debug for SpeechPackageRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let active = self
            .0
            .operation
            .lock()
            .ok()
            .is_some_and(|slot| !matches!(*slot, OperationSlot::Idle));
        formatter
            .debug_struct("SpeechPackageRuntime")
            .field("manager", &self.0.manager)
            .field("active", &active)
            .finish_non_exhaustive()
    }
}

async fn start_operation(
    runtime: SpeechPackageRuntime,
    backend: SpeechPackageId,
    action: SpeechPackageAction,
    on_event: Channel<SpeechPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let mut reservation = runtime.reserve(backend)?;
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let package_cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(
        &mut reservation,
        &initial,
        action,
        package_cancellation.clone(),
    ) {
        let _ = jobs.apply(job_id, JobUpdate::Fail);
        return Err(error);
    }
    let job_cancellation = ticket.cancellation().clone();
    let watcher_cancellation = package_cancellation.clone();
    let background_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_cancellation.cancel();
        });
        let worker_runtime = background_runtime.clone();
        let worker_channel = on_event.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            execute_operation(
                &worker_runtime,
                job_id,
                backend,
                action,
                &package_cancellation,
                &worker_channel,
            )
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or(Err(ExecutionFailure::Internal));
        background_runtime.finish(job_id, backend, action, result, &on_event);
    });
    Ok(initial)
}

fn execute_operation(
    runtime: &SpeechPackageRuntime,
    job_id: JobId,
    backend: SpeechPackageId,
    action: SpeechPackageAction,
    cancellation: &CancellationToken,
    on_event: &Channel<SpeechPackageEvent>,
) -> Result<(), ExecutionFailure> {
    let progress_failed = Arc::new(AtomicBool::new(false));
    let progress_runtime = runtime.clone();
    let progress_channel = on_event.clone();
    let progress_cancellation = cancellation.clone();
    let progress_failure = Arc::clone(&progress_failed);
    let progress = move |value| {
        if progress_runtime
            .report_progress(job_id, action, value, &progress_channel)
            .is_err()
        {
            progress_failure.store(true, Ordering::Release);
            progress_cancellation.cancel();
        }
    };
    let result = match action {
        SpeechPackageAction::Install | SpeechPackageAction::Update => runtime
            .0
            .manager
            .install(backend, cancellation, &progress)
            .map(|_| ()),
        SpeechPackageAction::Remove => runtime
            .0
            .manager
            .remove(backend, cancellation, &progress)
            .and_then(|outcome| match outcome {
                RemovalOutcome::Missing | RemovalOutcome::Removed => Ok(()),
                RemovalOutcome::PreservedModified => Err(PackageError::InvalidInstall),
            }),
    };
    if progress_failed.load(Ordering::Acquire) {
        Err(ExecutionFailure::Internal)
    } else {
        result.map_err(ExecutionFailure::Package)
    }
}

fn map_progress(
    action: SpeechPackageAction,
    progress: OperationProgress,
) -> CommandResult<(SpeechPackagePhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (SpeechPackageAction::Install | SpeechPackageAction::Update, OperationPhase::Preparing) => {
            (SpeechPackagePhase::Preparing, 0_u32, 0_u32)
        }
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            OperationPhase::Downloading,
        ) => (SpeechPackagePhase::Downloading, 0, 5_000),
        (SpeechPackageAction::Install | SpeechPackageAction::Update, OperationPhase::Verifying) => {
            (SpeechPackagePhase::Verifying, 5_000, 1_000)
        }
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            OperationPhase::Extracting,
        ) => (SpeechPackagePhase::Extracting, 6_000, 3_000),
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            OperationPhase::Publishing,
        ) => (SpeechPackagePhase::Publishing, 9_000, 900),
        (SpeechPackageAction::Remove, OperationPhase::Removing) => {
            (SpeechPackagePhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "the speech package progress phase is invalid",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("the speech package progress is invalid"))?,
    ))
}

const fn phase_rank(action: SpeechPackageAction, phase: SpeechPackagePhase) -> u8 {
    match (action, phase) {
        (_, SpeechPackagePhase::Preparing) => 0,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Downloading,
        )
        | (SpeechPackageAction::Remove, SpeechPackagePhase::Removing) => 1,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Verifying,
        ) => 2,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Extracting,
        ) => 3,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Publishing,
        ) => 4,
        _ => u8::MAX,
    }
}

fn finish_cancelled_job(jobs: &JobRegistry<Database>, job_id: JobId) -> CommandResult<JobSnapshot> {
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
                "the speech package cancellation arrived after finalization",
            ));
        }
    };
    Ok(ticket.snapshot().clone())
}

fn execution_error(failure: ExecutionFailure) -> CommandError {
    match failure {
        ExecutionFailure::Package(error) => error.into(),
        ExecutionFailure::Internal => {
            CommandError::internal("the speech package operation could not be recorded safely")
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_packages_status(
    runtime: State<'_, SpeechPackageRuntime>,
) -> CommandResult<SpeechPackagesStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| {
            CommandError::internal("the speech package status task stopped unexpectedly")
        })?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_package_install(
    runtime: State<'_, SpeechPackageRuntime>,
    backend: SpeechPackageId,
    on_event: Channel<SpeechPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(backend))
        .await
        .map_err(|_| CommandError::internal("the speech package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    let action = if status.update_available {
        SpeechPackageAction::Update
    } else {
        SpeechPackageAction::Install
    };
    start_operation(runtime, backend, action, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_package_remove(
    runtime: State<'_, SpeechPackageRuntime>,
    backend: SpeechPackageId,
    on_event: Channel<SpeechPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(backend))
        .await
        .map_err(|_| CommandError::internal("the speech package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    start_operation(runtime, backend, SpeechPackageAction::Remove, on_event).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use osg_application::JobRegistry;
    use osg_engine_packages::{
        OperationPhase, OperationProgress, SpeechPackageId, SpeechPackageManager,
        SpeechRuntimeCoordinator,
    };
    use osg_infrastructure::storage::Database;

    use super::{
        SCHEMA_VERSION, SpeechPackageAction, SpeechPackagePhase, SpeechPackageRuntime, map_progress,
    };

    #[derive(Debug)]
    struct NoopCoordinator;

    impl SpeechRuntimeCoordinator for NoopCoordinator {
        fn quiesce(&self, _: SpeechPackageId) -> osg_engine_packages::Result<()> {
            Ok(())
        }
    }

    fn runtime_fixture() -> (tempfile::TempDir, SpeechPackageRuntime) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(temporary.path().join("db.sqlite3")).expect("database");
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database)).expect("jobs"));
        let manager =
            SpeechPackageManager::new(temporary.path().join("packages"), Arc::new(NoopCoordinator))
                .expect("package manager");
        (temporary, SpeechPackageRuntime::new(manager, jobs))
    }

    #[test]
    fn whole_job_progress_is_monotonic_across_package_phases() {
        let phases = [
            OperationProgress {
                phase: OperationPhase::Downloading,
                basis_points: 10_000,
                bytes_done: 10,
                total_bytes: 10,
            },
            OperationProgress {
                phase: OperationPhase::Verifying,
                basis_points: 0,
                bytes_done: 0,
                total_bytes: 10,
            },
            OperationProgress {
                phase: OperationPhase::Extracting,
                basis_points: 5_000,
                bytes_done: 5,
                total_bytes: 10,
            },
            OperationProgress {
                phase: OperationPhase::Publishing,
                basis_points: 10_000,
                bytes_done: 1,
                total_bytes: 1,
            },
        ];
        let mapped = phases
            .into_iter()
            .map(|progress| {
                map_progress(SpeechPackageAction::Install, progress)
                    .expect("valid progress")
                    .1
            })
            .collect::<Vec<_>>();
        assert_eq!(mapped, vec![5_000, 5_000, 7_500, 9_900]);
        assert!(mapped.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn reviewed_catalog_matches_the_current_platform_without_phantom_state() {
        let (_temporary, runtime) = runtime_fixture();
        let status = runtime.status().expect("status");
        let delivery_expected = cfg!(all(target_os = "windows", target_arch = "x86_64"));

        assert_eq!(status.schema_version, SCHEMA_VERSION);
        assert_eq!(status.packages.len(), 5);
        assert!(status.packages.iter().all(|entry| {
            entry.package.delivery_available == delivery_expected
                && !entry.package.installed
                && entry.operation.is_none()
        }));
    }

    #[test]
    fn invalid_action_phase_pairs_fail_closed() {
        let error = map_progress(
            SpeechPackageAction::Remove,
            OperationProgress {
                phase: OperationPhase::Downloading,
                basis_points: 0,
                bytes_done: 0,
                total_bytes: 1,
            },
        );
        assert!(error.is_err());
        assert_eq!(
            super::phase_rank(SpeechPackageAction::Remove, SpeechPackagePhase::Publishing),
            u8::MAX
        );
    }
}
