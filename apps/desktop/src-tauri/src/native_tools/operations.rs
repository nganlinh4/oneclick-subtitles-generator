//! Install/remove execution, consumer refresh and terminal outcomes.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use osg_domain::{JobId, JobKind, JobUpdate};
use osg_native_tools::{
    CancellationToken, NativeToolError, NativeToolId, RemovalOutcome, ToolLease,
};
use tauri::ipc::Channel;

use super::durable::{execution_error, record_native_tool_terminal};
use super::types::{
    ExecutionFailure, NativeToolAction, NativeToolEvent, NativeToolRuntime, OperationOutcome,
    OperationSlot,
};
use super::{OPERATION_SCOPE, PENDING_REMOVAL_SCOPE};
use crate::background;
use crate::error::{CommandError, CommandResult};

impl NativeToolRuntime {
    pub(super) fn execute(
        &self,
        job_id: JobId,
        tool: NativeToolId,
        action: NativeToolAction,
        cancellation: &CancellationToken,
        on_event: &Channel<NativeToolEvent>,
    ) -> Result<OperationOutcome, ExecutionFailure> {
        let progress_failed = Arc::new(AtomicBool::new(false));
        let progress_runtime = self.clone();
        let progress_channel = on_event.clone();
        let progress_cancellation = cancellation.clone();
        let progress_failure = Arc::clone(&progress_failed);
        let progress = move |value| {
            if progress_runtime
                .report_progress(job_id, tool, action, value, &progress_channel)
                .is_err()
            {
                progress_failure.store(true, Ordering::Release);
                progress_cancellation.cancel();
            }
        };
        let result = match action {
            NativeToolAction::Install => self.install(tool, cancellation, &progress),
            NativeToolAction::Remove => self.remove(tool, cancellation, &progress),
        };
        if progress_failed.load(Ordering::Acquire)
            && !(action == NativeToolAction::Remove && result.is_ok())
        {
            Err(ExecutionFailure::Internal)
        } else {
            result
        }
    }

    pub(super) fn install(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        progress: &dyn osg_native_tools::ProgressSink,
    ) -> Result<OperationOutcome, ExecutionFailure> {
        if cancellation.is_cancelled() {
            return Err(ExecutionFailure::Tool(NativeToolError::Cancelled));
        }
        self.0
            .database
            .delete_setting(PENDING_REMOVAL_SCOPE, tool.as_str())
            .map_err(ExecutionFailure::Database)?;
        let has_active_lease = tool != NativeToolId::YtDlp
            && self
                .0
                .active_leases
                .read()
                .map_err(|_| ExecutionFailure::Internal)?
                .contains_key(&tool);
        if !has_active_lease {
            self.0
                .manager
                .install(tool, cancellation, progress)
                .map_err(ExecutionFailure::Tool)?;
        }
        let lease = self
            .0
            .manager
            .resolve(tool, cancellation)
            .map_err(ExecutionFailure::Tool)?;
        let installed_version = Some(lease.version().to_owned());
        let previous_lease = self
            .0
            .active_leases
            .write()
            .map_err(|_| ExecutionFailure::Internal)?
            .insert(tool, lease);
        let activator = self
            .0
            .activator
            .read()
            .map_err(|_| ExecutionFailure::Internal)?
            .clone();
        if let Some(activator) = activator
            && activator.refresh(self).is_err()
        {
            return self.restore_lease_after_refresh_failure(tool, previous_lease);
        }
        let active_version = self
            .0
            .active_leases
            .read()
            .map_err(|_| ExecutionFailure::Internal)?
            .get(&tool)
            .map(|lease| lease.version().to_owned());
        Ok(OperationOutcome {
            restart_required: active_version.as_deref() != installed_version.as_deref(),
            deferred: false,
        })
    }

    pub(super) fn remove(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        progress: &dyn osg_native_tools::ProgressSink,
    ) -> Result<OperationOutcome, ExecutionFailure> {
        if cancellation.is_cancelled() {
            return Err(ExecutionFailure::Tool(NativeToolError::Cancelled));
        }
        self.0
            .database
            .delete_setting(PENDING_REMOVAL_SCOPE, tool.as_str())
            .map_err(ExecutionFailure::Database)?;
        if self.has_active_consumer_jobs()? || !self.consumers_idle(tool)? {
            return Err(ExecutionFailure::Tool(NativeToolError::RuntimeBusy));
        }
        let previous_version = self.deactivate_for_removal(tool)?;
        let removal = self
            .0
            .manager
            .remove(tool, cancellation, progress)
            .map_err(ExecutionFailure::Tool);
        match removal {
            Ok(RemovalOutcome::Missing | RemovalOutcome::Removed) => Ok(OperationOutcome {
                restart_required: false,
                deferred: false,
            }),
            Ok(RemovalOutcome::PreservedModified) => {
                let _ = self.restore_after_failed_removal(tool, previous_version.as_deref());
                Err(ExecutionFailure::Tool(NativeToolError::InvalidInstall))
            }
            Err(error) => {
                let _ = self.restore_after_failed_removal(tool, previous_version.as_deref());
                Err(error)
            }
        }
    }

    fn deactivate_for_removal(
        &self,
        tool: NativeToolId,
    ) -> Result<Option<String>, ExecutionFailure> {
        let previous = self
            .0
            .active_leases
            .write()
            .map_err(|_| ExecutionFailure::Internal)?
            .remove(&tool);
        let previous_version = previous.as_ref().map(|lease| lease.version().to_owned());
        if previous.is_some() && self.refresh_consumers().is_err() {
            return self.restore_lease_after_refresh_failure(tool, previous);
        }
        drop(previous);
        Ok(previous_version)
    }

    fn restore_after_failed_removal(
        &self,
        tool: NativeToolId,
        previous_version: Option<&str>,
    ) -> Result<(), ExecutionFailure> {
        let Some(previous_version) = previous_version else {
            return Ok(());
        };
        let lease = match self.0.manager.resolve_version(
            tool,
            previous_version,
            &CancellationToken::default(),
        ) {
            Ok(lease) => lease,
            Err(error) => {
                self.fail_closed(tool);
                return Err(ExecutionFailure::Tool(error));
            }
        };
        self.0
            .active_leases
            .write()
            .map_err(|_| ExecutionFailure::Internal)?
            .insert(tool, lease);
        if self.refresh_consumers().is_ok() {
            return Ok(());
        }
        self.fail_closed(tool);
        Err(ExecutionFailure::Internal)
    }

    pub(super) fn restore_lease_after_refresh_failure<T>(
        &self,
        tool: NativeToolId,
        previous: Option<ToolLease>,
    ) -> Result<T, ExecutionFailure> {
        {
            let mut leases = self
                .0
                .active_leases
                .write()
                .map_err(|_| ExecutionFailure::Internal)?;
            if let Some(previous) = previous {
                leases.insert(tool, previous);
            } else {
                leases.remove(&tool);
            }
        }
        if self.refresh_consumers().is_err() {
            self.fail_closed(tool);
        }
        Err(ExecutionFailure::Internal)
    }

    fn fail_closed(&self, tool: NativeToolId) {
        if let Ok(mut leases) = self.0.active_leases.write() {
            leases.remove(&tool);
        }
        let _ = self.refresh_consumers();
    }

    fn refresh_consumers(&self) -> CommandResult<()> {
        let activator = self
            .0
            .activator
            .read()
            .map_err(|_| CommandError::internal("the native tool activator is unavailable"))?
            .clone();
        if let Some(activator) = activator {
            activator.refresh(self)?;
        }
        Ok(())
    }

    pub(super) fn consumers_idle(&self, tool: NativeToolId) -> Result<bool, ExecutionFailure> {
        let activator = self
            .0
            .activator
            .read()
            .map_err(|_| ExecutionFailure::Internal)?
            .clone();
        activator.map_or(Ok(true), |activator| {
            activator
                .consumers_idle(tool)
                .map_err(|_| ExecutionFailure::Internal)
        })
    }

    fn has_active_consumer_jobs(&self) -> Result<bool, ExecutionFailure> {
        self.0
            .jobs
            .list()
            .map(|jobs| {
                jobs.into_iter().any(|ticket| {
                    ticket.snapshot().kind() != JobKind::InstallEngine
                        && !ticket.snapshot().state().is_terminal()
                })
            })
            .map_err(|_| ExecutionFailure::Internal)
    }

    pub(super) fn finish(
        &self,
        job_id: JobId,
        tool: NativeToolId,
        action: NativeToolAction,
        result: Result<OperationOutcome, ExecutionFailure>,
        on_event: &Channel<NativeToolEvent>,
    ) {
        let Ok(mut operations) = self.0.operations.lock() else {
            let error = CommandError::internal("the native tool coordinator is unavailable");
            record_native_tool_terminal(
                "native-tool.failed",
                action,
                job_id,
                tool,
                Some(error.code()),
            );
            let _ = on_event.send(NativeToolEvent::Failed {
                job: None,
                tool,
                action,
                error,
            });
            return;
        };
        if !matches!(operations.get(&tool), Some(OperationSlot::Active { record, .. }) if record.job_id == job_id)
        {
            let error = CommandError::internal("the native tool operation is unavailable");
            record_native_tool_terminal(
                "native-tool.failed",
                action,
                job_id,
                tool,
                Some(error.code()),
            );
            let _ = on_event.send(NativeToolEvent::Failed {
                job: self
                    .0
                    .jobs
                    .get(job_id)
                    .ok()
                    .map(|ticket| ticket.snapshot().clone()),
                tool,
                action,
                error,
            });
            return;
        }
        let event = self.terminal_event(job_id, tool, action, result);
        let _ = self
            .0
            .database
            .delete_setting(OPERATION_SCOPE, &job_id.to_string());
        operations.remove(&tool);
        drop(operations);
        let (event_name, failure_code) = match &event {
            NativeToolEvent::Completed { .. } => ("native-tool.completed", None),
            NativeToolEvent::Cancelled { .. } => ("native-tool.cancelled", None),
            NativeToolEvent::Failed { error, .. } => {
                ("native-tool.failed", Some(error.code().to_owned()))
            }
            NativeToolEvent::Progress { .. } => ("native-tool.invalid-terminal", None),
        };
        record_native_tool_terminal(event_name, action, job_id, tool, failure_code.as_deref());
        let _ = on_event.send(event);
    }

    fn terminal_event(
        &self,
        job_id: JobId,
        tool: NativeToolId,
        action: NativeToolAction,
        result: Result<OperationOutcome, ExecutionFailure>,
    ) -> NativeToolEvent {
        if matches!(
            result,
            Err(ExecutionFailure::Tool(NativeToolError::Cancelled))
        ) {
            return match background::confirm_cancelled(
                &self.0.jobs,
                job_id,
                "the native tool cancellation arrived after finalization",
            ) {
                Ok(job) => NativeToolEvent::Cancelled { job, tool, action },
                Err(error) => NativeToolEvent::Failed {
                    job: self
                        .0
                        .jobs
                        .get(job_id)
                        .ok()
                        .map(|ticket| ticket.snapshot().clone()),
                    tool,
                    action,
                    error,
                },
            };
        }
        match result {
            Ok(outcome) => match self.0.jobs.apply(job_id, JobUpdate::Succeed) {
                Ok(ticket) => NativeToolEvent::Completed {
                    job: ticket.snapshot().clone(),
                    tool,
                    action,
                    restart_required: outcome.restart_required,
                    deferred: outcome.deferred,
                },
                Err(error) => NativeToolEvent::Failed {
                    job: self
                        .0
                        .jobs
                        .get(job_id)
                        .ok()
                        .map(|ticket| ticket.snapshot().clone()),
                    tool,
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
                NativeToolEvent::Failed {
                    job,
                    tool,
                    action,
                    error: execution_error(failure),
                }
            }
        }
    }
}
