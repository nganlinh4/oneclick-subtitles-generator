//! Engine-package runtime: reservation, install/remove execution and status.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobProgress, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken, EngineId, EnginePackageManager, OperationProgress, PackageError,
};
use osg_infrastructure::storage::{Database, DatabaseError};
use tauri::ipc::Channel;

use super::durable::{
    delete_operation_keys, execution_error, map_progress, persist_operation, phase_rank,
};
use super::types::{
    DurableOperation, EnginePackageAction, EnginePackageEvent, EnginePackageOperation,
    EnginePackageRuntime, EnginePackageRuntimeInner, EnginePackageStatusEntry,
    EnginePackagesStatus, ExecutionFailure, OperationReservation, OperationSlot,
};
use super::{OPERATION_SCHEMA_VERSION, OPERATION_SCOPE};
use crate::background;
use crate::error::{CommandError, CommandResult};

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

    pub(super) fn reserve(&self, engine: EngineId) -> CommandResult<OperationReservation> {
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

    pub(super) fn activate(
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

    pub(super) fn status(&self) -> CommandResult<EnginePackagesStatus> {
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

    pub(super) fn report_progress(
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

    pub(super) fn finish(
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

    pub(super) fn terminal_event(
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
            match background::confirm_cancelled(
                &self.0.jobs,
                job_id,
                "the engine package cancellation arrived after finalization",
            ) {
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
