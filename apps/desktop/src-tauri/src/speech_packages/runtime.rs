//! Speech-package runtime: reservation, install/remove execution and status.

use std::fmt;
use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobProgress, JobSnapshot, JobState, JobUpdate};
use osg_engine_packages::{
    CancellationToken, OperationProgress, PackageError, SpeechPackageId, SpeechPackageManager,
};
use osg_infrastructure::storage::Database;
use tauri::ipc::Channel;

use super::types::{
    ExecutionFailure, OperationRecord, OperationReservation, OperationSlot, RuntimeInner,
    SpeechPackageAction, SpeechPackageEvent, SpeechPackageOperation, SpeechPackagePhase,
    SpeechPackageRuntime, SpeechPackageStatusEntry, SpeechPackagesStatus,
};
use super::{SCHEMA_VERSION, execution_error, map_progress, phase_rank};
use crate::background;
use crate::error::{CommandError, CommandResult};

impl SpeechPackageRuntime {
    #[must_use]
    pub(crate) fn new(manager: SpeechPackageManager, jobs: Arc<JobRegistry<Database>>) -> Self {
        Self(Arc::new(RuntimeInner {
            manager,
            jobs,
            operation: Mutex::new(OperationSlot::Idle),
        }))
    }

    pub(super) fn reserve(&self, backend: SpeechPackageId) -> CommandResult<OperationReservation> {
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

    pub(super) fn activate(
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

    pub(super) fn status(&self) -> CommandResult<SpeechPackagesStatus> {
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

    pub(super) fn report_progress(
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
        let before_sequence = current.snapshot().sequence();
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
        // OperationProgress may change phase/byte telemetry without advancing the durable job's
        // rounded basis points. The WebView ledger is sequenced by JobSnapshot, so emitting that
        // unchanged snapshot would look exactly like a duplicated/replayed native event and must
        // not be put on the channel. Status polling still observes the newest phase/byte record.
        if operation.job.sequence() > before_sequence {
            let _ = on_event.send(SpeechPackageEvent::Progress { operation });
        }
        Ok(())
    }

    pub(super) fn finish(
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
            return match background::confirm_cancelled(
                &self.0.jobs,
                job_id,
                "the speech package cancellation arrived after finalization",
            ) {
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
