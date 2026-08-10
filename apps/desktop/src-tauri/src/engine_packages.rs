use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken, EngineId, EnginePackageManager, EnginePackageStatus, OperationPhase,
    OperationProgress, PackageError, RemovalOutcome,
};
use osg_infrastructure::storage::{Database, DatabaseError};
use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::asr::package_to_asr;
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const OPERATION_SCOPE: &str = "engine-package-operations";
const OPERATION_SCHEMA_VERSION: u32 = 1;
const MAX_STALE_DELETES_PER_BATCH: usize = 256;

#[derive(Clone)]
pub(crate) struct EnginePackageRuntime(Arc<EnginePackageRuntimeInner>);

struct EnginePackageRuntimeInner {
    manager: EnginePackageManager,
    database: Database,
    jobs: Arc<JobRegistry<Database>>,
    operation: Mutex<OperationSlot>,
}

#[derive(Debug, Default)]
enum OperationSlot {
    #[default]
    Idle,
    Reserved {
        engine: EngineId,
    },
    Active {
        record: DurableOperation,
        cancellation: CancellationToken,
    },
}

impl fmt::Debug for EnginePackageRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let active = self
            .0
            .operation
            .lock()
            .ok()
            .is_some_and(|slot| !matches!(*slot, OperationSlot::Idle));
        formatter
            .debug_struct("EnginePackageRuntime")
            .field("manager", &self.0.manager)
            .field("active", &active)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EnginePackageAction {
    Install,
    Update,
    Remove,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EnginePackagePhase {
    Queued,
    Preparing,
    Downloading,
    Verifying,
    Extracting,
    Publishing,
    Removing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableOperation {
    schema_version: u32,
    job_id: JobId,
    engine: EngineId,
    action: EnginePackageAction,
    phase: EnginePackagePhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

impl DurableOperation {
    fn preparing(job: &JobSnapshot, engine: EngineId, action: EnginePackageAction) -> Self {
        Self {
            schema_version: OPERATION_SCHEMA_VERSION,
            job_id: job.id(),
            engine,
            action,
            phase: EnginePackagePhase::Preparing,
            basis_points: job.progress().basis_points(),
            bytes_done: 0,
            total_bytes: 0,
        }
    }

    fn is_valid_for(&self, key: &str, job: &JobSnapshot) -> bool {
        self.schema_version == OPERATION_SCHEMA_VERSION
            && key == self.job_id.to_string()
            && job.id() == self.job_id
            && job.kind() == JobKind::InstallEngine
            && matches!(
                job.state(),
                JobState::Queued | JobState::Running | JobState::Cancelling
            )
            && self.basis_points == job.progress().basis_points()
            && self.bytes_done <= self.total_bytes
            && (self.total_bytes != 0 || self.bytes_done == 0)
            && phase_allowed(self.action, self.phase)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePackageOperation {
    job: JobSnapshot,
    engine: EngineId,
    action: EnginePackageAction,
    phase: EnginePackagePhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

impl EnginePackageOperation {
    fn from_record(record: &DurableOperation, job: JobSnapshot) -> Self {
        Self {
            job,
            engine: record.engine,
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
pub(crate) struct EnginePackagesStatus {
    schema_version: u32,
    engines: Vec<EnginePackageStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnginePackageStatusEntry {
    #[serde(flatten)]
    package: EnginePackageStatus,
    operation: Option<EnginePackageOperation>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum EnginePackageEvent {
    Progress {
        operation: EnginePackageOperation,
    },
    Completed {
        job: JobSnapshot,
        engine: EngineId,
        action: EnginePackageAction,
    },
    Cancelled {
        job: JobSnapshot,
        engine: EngineId,
        action: EnginePackageAction,
    },
    Failed {
        job: Option<JobSnapshot>,
        engine: EngineId,
        action: EnginePackageAction,
        error: CommandError,
    },
}

struct OperationReservation {
    runtime: EnginePackageRuntime,
    engine: EngineId,
    activated: bool,
}

impl Drop for OperationReservation {
    fn drop(&mut self) {
        if self.activated {
            return;
        }
        if let Ok(mut slot) = self.runtime.0.operation.lock()
            && matches!(*slot, OperationSlot::Reserved { engine } if engine == self.engine)
        {
            *slot = OperationSlot::Idle;
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ExecutionFailure {
    Package(PackageError),
    Internal,
}

impl EnginePackageRuntime {
    pub(crate) fn new(
        manager: EnginePackageManager,
        database: Database,
        jobs: Arc<JobRegistry<Database>>,
    ) -> Result<Self, DatabaseError> {
        let runtime = Self(Arc::new(EnginePackageRuntimeInner {
            manager,
            database,
            jobs,
            operation: Mutex::new(OperationSlot::Idle),
        }));
        runtime.clear_recovered_metadata()?;
        Ok(runtime)
    }

    fn clear_recovered_metadata(&self) -> Result<(), DatabaseError> {
        let stale = self
            .0
            .database
            .list_settings(OPERATION_SCOPE)?
            .into_keys()
            .collect::<Vec<_>>();
        delete_operation_keys(&self.0.database, &stale)
    }

    fn reserve(&self, engine: EngineId) -> CommandResult<OperationReservation> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the engine package coordinator is unavailable")
            })?;
        if !matches!(*slot, OperationSlot::Idle) {
            return Err(PackageError::OperationInProgress(engine).into());
        }
        *slot = OperationSlot::Reserved { engine };
        Ok(OperationReservation {
            runtime: self.clone(),
            engine,
            activated: false,
        })
    }

    fn activate(
        &self,
        reservation: &mut OperationReservation,
        record: DurableOperation,
        cancellation: CancellationToken,
    ) -> CommandResult<()> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the engine package coordinator is unavailable")
            })?;
        if !matches!(*slot, OperationSlot::Reserved { engine } if engine == record.engine)
            || reservation.engine != record.engine
        {
            return Err(CommandError::internal(
                "the engine package reservation is unavailable",
            ));
        }
        persist_operation(&self.0.database, &record)?;
        *slot = OperationSlot::Active {
            record,
            cancellation,
        };
        reservation.activated = true;
        Ok(())
    }

    fn status(&self) -> CommandResult<EnginePackagesStatus> {
        let packages = self.0.manager.statuses();
        let operations = self.read_durable_operations()?;
        Ok(EnginePackagesStatus {
            schema_version: OPERATION_SCHEMA_VERSION,
            engines: packages
                .into_iter()
                .map(|package| EnginePackageStatusEntry {
                    operation: operations.get(&package.id).cloned(),
                    package,
                })
                .collect(),
        })
    }

    fn read_durable_operations(&self) -> CommandResult<HashMap<EngineId, EnginePackageOperation>> {
        let _slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the engine package coordinator is unavailable")
            })?;
        let stored = self.0.database.list_settings(OPERATION_SCOPE)?;
        let mut stale = Vec::new();
        let mut valid = Vec::new();
        for (key, value) in stored {
            let Ok(record) = serde_json::from_value::<DurableOperation>(value) else {
                stale.push(key);
                continue;
            };
            let Ok(ticket) = self.0.jobs.get(record.job_id) else {
                stale.push(key);
                continue;
            };
            let job = ticket.snapshot().clone();
            if !record.is_valid_for(&key, &job) {
                stale.push(key);
                continue;
            }
            valid.push((key, record, job));
        }
        if valid.len() > 1 {
            stale.extend(valid.iter().map(|(key, _, _)| key.clone()));
            valid.clear();
        }
        delete_operation_keys(&self.0.database, &stale)?;
        Ok(valid
            .into_iter()
            .map(|(_, record, job)| {
                (
                    record.engine,
                    EnginePackageOperation::from_record(&record, job),
                )
            })
            .collect())
    }

    fn report_progress(
        &self,
        job_id: JobId,
        action: EnginePackageAction,
        progress: OperationProgress,
        on_event: &Channel<EnginePackageEvent>,
    ) -> CommandResult<()> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the engine package coordinator is unavailable")
            })?;
        let OperationSlot::Active {
            record,
            cancellation,
        } = &mut *slot
        else {
            return Err(CommandError::internal(
                "the engine package operation is unavailable",
            ));
        };
        if record.job_id != job_id || record.action != action {
            return Err(CommandError::internal(
                "the engine package operation identity changed",
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
                "the engine package progress phase regressed",
            ));
        }
        let basis_points = mapped_basis_points.max(current.snapshot().progress().basis_points());
        let before_sequence = current.snapshot().sequence();
        let job = if basis_points > current.snapshot().progress().basis_points() {
            match self.0.jobs.apply(
                job_id,
                JobUpdate::ReportProgress(JobProgress::from_basis_points(basis_points).map_err(
                    |_| CommandError::internal("the engine package progress is invalid"),
                )?),
            ) {
                Ok(ticket) => ticket.snapshot().clone(),
                Err(error) => {
                    let latest = self.0.jobs.get(job_id)?;
                    if matches!(
                        latest.snapshot().state(),
                        JobState::Cancelling | JobState::Cancelled
                    ) {
                        cancellation.cancel();
                        return Ok(());
                    }
                    return Err(error.into());
                }
            }
        } else {
            current.snapshot().clone()
        };
        record.phase = phase;
        record.basis_points = job.progress().basis_points();
        record.bytes_done = progress.bytes_done;
        record.total_bytes = progress.total_bytes;
        persist_operation(&self.0.database, record)?;
        let operation = EnginePackageOperation::from_record(record, job.clone());
        drop(slot);
        if job.sequence() > before_sequence {
            let _ = on_event.send(EnginePackageEvent::Progress { operation });
        }
        Ok(())
    }

    fn finish(
        &self,
        job_id: JobId,
        engine: EngineId,
        action: EnginePackageAction,
        result: Result<(), ExecutionFailure>,
        on_event: &Channel<EnginePackageEvent>,
    ) {
        let Ok(mut slot) = self.0.operation.lock() else {
            let _ = on_event.send(EnginePackageEvent::Failed {
                job: None,
                engine,
                action,
                error: CommandError::internal("the engine package coordinator is unavailable"),
            });
            return;
        };
        let matches_active = matches!(
            &*slot,
            OperationSlot::Active { record, .. } if record.job_id == job_id
        );
        if !matches_active {
            let _ = on_event.send(EnginePackageEvent::Failed {
                job: self
                    .0
                    .jobs
                    .get(job_id)
                    .ok()
                    .map(|ticket| ticket.snapshot().clone()),
                engine,
                action,
                error: CommandError::internal("the engine package operation is unavailable"),
            });
            return;
        }

        let event = self.terminal_event(job_id, engine, action, result);
        let _ = self
            .0
            .database
            .delete_setting(OPERATION_SCOPE, &job_id.to_string());
        *slot = OperationSlot::Idle;
        drop(slot);
        let _ = on_event.send(event);
    }

    fn terminal_event(
        &self,
        job_id: JobId,
        engine: EngineId,
        action: EnginePackageAction,
        result: Result<(), ExecutionFailure>,
    ) -> EnginePackageEvent {
        let package_cancelled = matches!(
            result,
            Err(ExecutionFailure::Package(PackageError::Cancelled))
        );
        if package_cancelled {
            match finish_cancelled_job(&self.0.jobs, job_id) {
                Ok(job) => EnginePackageEvent::Cancelled {
                    job,
                    engine,
                    action,
                },
                Err(error) => EnginePackageEvent::Failed {
                    job: self
                        .0
                        .jobs
                        .get(job_id)
                        .ok()
                        .map(|ticket| ticket.snapshot().clone()),
                    engine,
                    action,
                    error,
                },
            }
        } else {
            match result {
                Ok(()) => match self.0.jobs.apply(job_id, JobUpdate::Succeed) {
                    Ok(ticket) => EnginePackageEvent::Completed {
                        job: ticket.snapshot().clone(),
                        engine,
                        action,
                    },
                    Err(error) => EnginePackageEvent::Failed {
                        job: self
                            .0
                            .jobs
                            .get(job_id)
                            .ok()
                            .map(|ticket| ticket.snapshot().clone()),
                        engine,
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
                    EnginePackageEvent::Failed {
                        job,
                        engine,
                        action,
                        error: execution_error(failure),
                    }
                }
            }
        }
    }
}

fn phase_allowed(action: EnginePackageAction, phase: EnginePackagePhase) -> bool {
    match action {
        EnginePackageAction::Install | EnginePackageAction::Update => matches!(
            phase,
            EnginePackagePhase::Queued
                | EnginePackagePhase::Preparing
                | EnginePackagePhase::Downloading
                | EnginePackagePhase::Verifying
                | EnginePackagePhase::Extracting
                | EnginePackagePhase::Publishing
        ),
        EnginePackageAction::Remove => matches!(
            phase,
            EnginePackagePhase::Queued
                | EnginePackagePhase::Preparing
                | EnginePackagePhase::Removing
        ),
    }
}

fn phase_rank(action: EnginePackageAction, phase: EnginePackagePhase) -> u8 {
    match (action, phase) {
        (_, EnginePackagePhase::Queued) => 0,
        (_, EnginePackagePhase::Preparing) => 1,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Downloading,
        )
        | (EnginePackageAction::Remove, EnginePackagePhase::Removing) => 2,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Verifying,
        ) => 3,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Extracting,
        ) => 4,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Publishing,
        ) => 5,
        _ => u8::MAX,
    }
}

fn map_progress(
    action: EnginePackageAction,
    progress: OperationProgress,
) -> CommandResult<(EnginePackagePhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (EnginePackageAction::Install | EnginePackageAction::Update, OperationPhase::Preparing) => {
            (EnginePackagePhase::Preparing, 0_u32, 0_u32)
        }
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            OperationPhase::Downloading,
        ) => (EnginePackagePhase::Downloading, 0, 5_000),
        (EnginePackageAction::Install | EnginePackageAction::Update, OperationPhase::Verifying) => {
            (EnginePackagePhase::Verifying, 5_000, 1_000)
        }
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            OperationPhase::Extracting,
        ) => (EnginePackagePhase::Extracting, 6_000, 3_000),
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            OperationPhase::Publishing,
        ) => (EnginePackagePhase::Publishing, 9_000, 900),
        (EnginePackageAction::Remove, OperationPhase::Removing) => {
            (EnginePackagePhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "the engine package progress phase is invalid",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("the engine package progress is invalid"))?,
    ))
}

fn persist_operation(database: &Database, record: &DurableOperation) -> CommandResult<()> {
    let value = serde_json::to_value(record)
        .map_err(|_| CommandError::internal("the engine package metadata is invalid"))?;
    database
        .put_setting(OPERATION_SCOPE, &record.job_id.to_string(), &value)
        .map_err(Into::into)
}

fn delete_operation_keys(database: &Database, keys: &[String]) -> Result<(), DatabaseError> {
    for batch in keys.chunks(MAX_STALE_DELETES_PER_BATCH) {
        database.delete_settings(OPERATION_SCOPE, batch)?;
    }
    Ok(())
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
                "the engine package cancellation arrived after finalization",
            ));
        }
    };
    Ok(ticket.snapshot().clone())
}

fn execution_error(failure: ExecutionFailure) -> CommandError {
    match failure {
        ExecutionFailure::Package(error) => error.into(),
        ExecutionFailure::Internal => {
            CommandError::internal("the engine package operation could not be recorded safely")
        }
    }
}

async fn start_operation(
    runtime: EnginePackageRuntime,
    engine: EngineId,
    action: EnginePackageAction,
    on_event: Channel<EnginePackageEvent>,
) -> CommandResult<JobSnapshot> {
    let mut reservation = runtime.reserve(engine)?;
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let package_cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(
        &mut reservation,
        DurableOperation::preparing(&initial, engine, action),
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
                engine,
                action,
                &package_cancellation,
                &worker_channel,
            )
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or(Err(ExecutionFailure::Internal));
        background_runtime.finish(job_id, engine, action, result, &on_event);
    });
    Ok(initial)
}

fn execute_operation(
    runtime: &EnginePackageRuntime,
    job_id: JobId,
    engine: EngineId,
    action: EnginePackageAction,
    cancellation: &CancellationToken,
    on_event: &Channel<EnginePackageEvent>,
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
        EnginePackageAction::Install | EnginePackageAction::Update => runtime
            .0
            .manager
            .install(engine, cancellation, &progress)
            .map(|_| ()),
        EnginePackageAction::Remove => runtime
            .0
            .manager
            .remove(engine, cancellation, &progress)
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

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn engine_packages_status(
    runtime: State<'_, EnginePackageRuntime>,
) -> CommandResult<EnginePackagesStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| {
            CommandError::internal("the engine package status task stopped unexpectedly")
        })?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn engine_package_install(
    runtime: State<'_, EnginePackageRuntime>,
    engine: EngineId,
    on_event: Channel<EnginePackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(engine))
        .await
        .map_err(|_| CommandError::internal("the engine package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    let action = if status.update_available {
        EnginePackageAction::Update
    } else {
        EnginePackageAction::Install
    };
    start_operation(runtime, engine, action, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn engine_package_remove(
    runtime: State<'_, EnginePackageRuntime>,
    engine: EngineId,
    on_event: Channel<EnginePackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(engine))
        .await
        .map_err(|_| CommandError::internal("the engine package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    start_operation(runtime, engine, EnginePackageAction::Remove, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn engine_runtime_start(
    state: State<'_, DesktopState>,
    engine: EngineId,
) -> CommandResult<()> {
    let asr = state.asr.clone();
    tauri::async_runtime::spawn_blocking(move || asr.start(package_to_asr(engine)))
        .await
        .map_err(|_| CommandError::internal("the ASR runtime start task stopped unexpectedly"))??;
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn engine_runtime_stop(
    state: State<'_, DesktopState>,
    engine: EngineId,
) -> CommandResult<()> {
    let asr = state.asr.clone();
    tauri::async_runtime::spawn_blocking(move || asr.stop(package_to_asr(engine)))
        .await
        .map_err(|_| CommandError::internal("the ASR runtime stop task stopped unexpectedly"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use osg_application::JobRegistry;
    use osg_domain::{JobKind, JobUpdate};
    use osg_engine_packages::{
        EngineId, EnginePackageManager, OperationPhase, OperationProgress, RuntimeCoordinator,
    };
    use osg_infrastructure::storage::Database;
    use serde_json::json;

    use super::{
        DurableOperation, EnginePackageAction, EnginePackagePhase, EnginePackageRuntime,
        OPERATION_SCOPE, map_progress,
    };

    #[derive(Debug)]
    struct NoopCoordinator;

    impl RuntimeCoordinator for NoopCoordinator {
        fn quiesce(&self, _: EngineId) -> osg_engine_packages::Result<()> {
            Ok(())
        }
    }

    fn runtime_fixture() -> (tempfile::TempDir, EnginePackageRuntime) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(temporary.path().join("db.sqlite3")).expect("database");
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
        let manager =
            EnginePackageManager::new(temporary.path().join("packages"), Arc::new(NoopCoordinator))
                .expect("package manager");
        let runtime = EnginePackageRuntime::new(manager, database, jobs).expect("runtime");
        (temporary, runtime)
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
                map_progress(EnginePackageAction::Install, progress)
                    .expect("valid progress")
                    .1
            })
            .collect::<Vec<_>>();
        assert!(mapped.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(mapped, vec![5_000, 5_000, 7_500, 9_900]);
    }

    #[test]
    fn status_reconnects_from_durable_path_free_operation_metadata() {
        let (_temporary, runtime) = runtime_fixture();
        let mut reservation = runtime.reserve(EngineId::Parakeet).expect("reservation");
        let queued = runtime
            .0
            .jobs
            .register(JobKind::InstallEngine)
            .expect("job");
        let running = runtime
            .0
            .jobs
            .apply(queued.snapshot().id(), JobUpdate::Start)
            .expect("running");
        runtime
            .activate(
                &mut reservation,
                DurableOperation::preparing(
                    running.snapshot(),
                    EngineId::Parakeet,
                    EnginePackageAction::Install,
                ),
                osg_engine_packages::CancellationToken::default(),
            )
            .expect("activate");

        let status = runtime.status().expect("status");
        let operation = status.engines[0]
            .operation
            .as_ref()
            .expect("durable operation");
        assert_eq!(operation.job.id(), running.snapshot().id());
        assert_eq!(operation.engine, EngineId::Parakeet);
        assert_eq!(operation.phase, EnginePackagePhase::Preparing);
        let encoded = serde_json::to_string(&status).expect("serialize status");
        assert!(!encoded.contains("packages"));
        assert!(!encoded.contains("Users"));
        assert!(!encoded.contains("http"));
    }

    #[test]
    fn startup_removes_stale_or_malformed_operation_metadata() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(temporary.path().join("db.sqlite3")).expect("database");
        database
            .put_setting(
                OPERATION_SCOPE,
                "stale",
                &json!({ "privatePath": "hidden" }),
            )
            .expect("stale metadata");
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
        let manager =
            EnginePackageManager::new(temporary.path().join("packages"), Arc::new(NoopCoordinator))
                .expect("package manager");
        EnginePackageRuntime::new(manager, database.clone(), jobs).expect("runtime");
        assert!(
            database
                .list_settings(OPERATION_SCOPE)
                .expect("operation settings")
                .is_empty()
        );
    }

    #[test]
    fn completed_publication_wins_a_late_cancellation_request() {
        let (_temporary, runtime) = runtime_fixture();
        let queued = runtime
            .0
            .jobs
            .register(JobKind::InstallEngine)
            .expect("job");
        let job_id = queued.snapshot().id();
        runtime
            .0
            .jobs
            .apply(job_id, JobUpdate::Start)
            .expect("running");
        runtime
            .0
            .jobs
            .apply(job_id, JobUpdate::RequestCancellation)
            .expect("cancelling");

        let event = runtime.terminal_event(
            job_id,
            EngineId::Parakeet,
            EnginePackageAction::Install,
            Ok(()),
        );
        let super::EnginePackageEvent::Completed { job, .. } = event else {
            panic!("a published package must complete rather than report a false cancellation");
        };
        assert_eq!(job.state(), osg_domain::JobState::Succeeded);
        assert_eq!(job.progress().basis_points(), 10_000);
    }
}
