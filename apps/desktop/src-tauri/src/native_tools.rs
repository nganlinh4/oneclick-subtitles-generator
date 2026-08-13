use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use osg_infrastructure::storage::{Database, DatabaseError};
use osg_native_tools::{
    CancellationToken, ExecutableRole, NativeToolError, NativeToolId, NativeToolInfo,
    NativeToolManager, NativeToolStatus, OperationPhase, OperationProgress, RemovalOutcome,
    RuntimeCoordinator, ToolLease, catalog,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{State, ipc::Channel};

use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

const SCHEMA_VERSION: u32 = 1;
const OPERATION_SCOPE: &str = "native-tool-operations";
const PENDING_REMOVAL_SCOPE: &str = "native-tool-pending-removal";
const PENDING_REMOVAL_VALUE: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub(crate) enum NativeToolRuntimeError {
    #[error("native tool storage is unavailable")]
    Tool(#[from] NativeToolError),
    #[error("native tool metadata is unavailable")]
    Database(#[from] DatabaseError),
}

pub(crate) trait NativeToolActivator: Send + Sync {
    fn refresh(&self, runtime: &NativeToolRuntime) -> CommandResult<()>;
    fn consumers_idle(&self, tool: NativeToolId) -> CommandResult<bool>;
}

#[derive(Debug)]
struct LeaseRuntimeCoordinator;

impl RuntimeCoordinator for LeaseRuntimeCoordinator {
    fn quiesce(&self, _: NativeToolId) -> osg_native_tools::Result<()> {
        // The desktop runtime removes its verified lease and refreshes every
        // executable consumer before entering NativeToolManager::remove.
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct NativeToolRuntime(Arc<NativeToolRuntimeInner>);

struct NativeToolRuntimeInner {
    manager: NativeToolManager,
    database: Database,
    jobs: Arc<JobRegistry<Database>>,
    active_leases: RwLock<HashMap<NativeToolId, ToolLease>>,
    operations: Mutex<HashMap<NativeToolId, OperationSlot>>,
    activator: RwLock<Option<Arc<dyn NativeToolActivator>>>,
}

impl fmt::Debug for NativeToolRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let active = self
            .0
            .operations
            .lock()
            .ok()
            .map_or(0, |operations| operations.len());
        let lease_count = self.0.active_leases.read().map_or(0, |leases| leases.len());
        formatter
            .debug_struct("NativeToolRuntime")
            .field("manager", &self.0.manager)
            .field("active_lease_count", &lease_count)
            .field("active_operation_count", &active)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
enum OperationSlot {
    Reserved {
        tool: NativeToolId,
    },
    Active {
        record: DurableOperation,
        cancellation: CancellationToken,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeToolAction {
    Install,
    Remove,
}

impl NativeToolAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Remove => "remove",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeToolPhase {
    Preparing,
    Downloading,
    Extracting,
    Publishing,
    Removing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableOperation {
    schema_version: u32,
    job_id: JobId,
    tool: NativeToolId,
    action: NativeToolAction,
    phase: NativeToolPhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

impl DurableOperation {
    fn preparing(job: &JobSnapshot, tool: NativeToolId, action: NativeToolAction) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            job_id: job.id(),
            tool,
            action,
            phase: NativeToolPhase::Preparing,
            basis_points: job.progress().basis_points(),
            bytes_done: 0,
            total_bytes: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeToolOperation {
    job: JobSnapshot,
    tool: NativeToolId,
    action: NativeToolAction,
    phase: NativeToolPhase,
    basis_points: u16,
    bytes_done: u64,
    total_bytes: u64,
}

impl NativeToolOperation {
    fn from_record(record: &DurableOperation, job: JobSnapshot) -> Self {
        Self {
            job,
            tool: record.tool,
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
pub(crate) struct NativeToolsCatalog {
    schema_version: u32,
    tools: Vec<NativeToolInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeToolsStatus {
    schema_version: u32,
    tools: Vec<NativeToolStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeToolStatusEntry {
    #[serde(flatten)]
    tool: NativeToolStatus,
    active_runtime: bool,
    pending_removal: bool,
    restart_required: bool,
    operation: Option<NativeToolOperation>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum NativeToolEvent {
    Progress {
        operation: NativeToolOperation,
    },
    Completed {
        job: JobSnapshot,
        tool: NativeToolId,
        action: NativeToolAction,
        restart_required: bool,
        deferred: bool,
    },
    Cancelled {
        job: JobSnapshot,
        tool: NativeToolId,
        action: NativeToolAction,
    },
    Failed {
        job: Option<JobSnapshot>,
        tool: NativeToolId,
        action: NativeToolAction,
        error: CommandError,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OperationOutcome {
    restart_required: bool,
    deferred: bool,
}

#[derive(Debug)]
enum ExecutionFailure {
    Tool(NativeToolError),
    Database(DatabaseError),
    Internal,
}

struct OperationReservation {
    runtime: NativeToolRuntime,
    tool: NativeToolId,
    activated: bool,
}

impl Drop for OperationReservation {
    fn drop(&mut self) {
        if self.activated {
            return;
        }
        if let Ok(mut operations) = self.runtime.0.operations.lock()
            && matches!(operations.get(&self.tool), Some(OperationSlot::Reserved { tool }) if *tool == self.tool)
        {
            operations.remove(&self.tool);
        }
    }
}

impl NativeToolRuntime {
    pub(crate) fn new(
        root: &Path,
        database: Database,
        jobs: Arc<JobRegistry<Database>>,
    ) -> Result<Self, NativeToolRuntimeError> {
        let manager = NativeToolManager::new(root, Arc::new(LeaseRuntimeCoordinator))?;
        Self::with_manager(manager, database, jobs)
    }

    fn with_manager(
        manager: NativeToolManager,
        database: Database,
        jobs: Arc<JobRegistry<Database>>,
    ) -> Result<Self, NativeToolRuntimeError> {
        clear_recovered_operations(&database)?;
        apply_pending_removals(&manager, &database)?;
        let active_leases = NativeToolId::ALL
            .into_iter()
            .filter(|tool| manager.status(*tool).installed)
            .map(|tool| {
                manager
                    .resolve(tool, &CancellationToken::default())
                    .map(|lease| (tool, lease))
            })
            .collect::<osg_native_tools::Result<HashMap<_, _>>>()?;
        Ok(Self(Arc::new(NativeToolRuntimeInner {
            manager,
            database,
            jobs,
            active_leases: RwLock::new(active_leases),
            operations: Mutex::new(HashMap::new()),
            activator: RwLock::new(None),
        })))
    }

    pub(crate) fn attach_activator(
        &self,
        activator: Arc<dyn NativeToolActivator>,
    ) -> CommandResult<()> {
        let mut slot = self
            .0
            .activator
            .write()
            .map_err(|_| CommandError::internal("the native tool activator is unavailable"))?;
        if slot.is_some() {
            return Err(CommandError::internal(
                "the native tool activator is already attached",
            ));
        }
        *slot = Some(activator);
        Ok(())
    }

    #[must_use]
    pub(crate) fn executable(&self, tool: NativeToolId, role: ExecutableRole) -> Option<PathBuf> {
        self.0
            .active_leases
            .read()
            .ok()?
            .get(&tool)
            .and_then(|lease| lease.executable(role))
            .map(Path::to_owned)
    }

    fn catalog() -> NativeToolsCatalog {
        NativeToolsCatalog {
            schema_version: SCHEMA_VERSION,
            tools: catalog().to_vec(),
        }
    }

    fn status(&self) -> CommandResult<NativeToolsStatus> {
        let pending = read_pending_removals(&self.0.database)?;
        let operations = self.active_operations()?;
        let leases = self
            .0
            .active_leases
            .read()
            .map_err(|_| CommandError::internal("the native tool runtime is unavailable"))?;
        Ok(NativeToolsStatus {
            schema_version: SCHEMA_VERSION,
            tools: self
                .0
                .manager
                .statuses()
                .into_iter()
                .map(|tool| {
                    let active_version =
                        leases.get(&tool.id).map(|lease| lease.version().to_owned());
                    let active_runtime = active_version.is_some();
                    let pending_removal = pending.contains(&tool.id);
                    let restart_required = pending_removal
                        || (tool.installed && active_version.as_deref() != tool.version.as_deref());
                    let entry_operation = operations.get(&tool.id).cloned();
                    NativeToolStatusEntry {
                        tool,
                        active_runtime,
                        pending_removal,
                        restart_required,
                        operation: entry_operation,
                    }
                })
                .collect(),
        })
    }

    fn active_operations(&self) -> CommandResult<HashMap<NativeToolId, NativeToolOperation>> {
        let operations =
            self.0.operations.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        operations
            .iter()
            .filter_map(|(tool, slot)| match slot {
                OperationSlot::Reserved { .. } => None,
                OperationSlot::Active { record, .. } => Some((*tool, record)),
            })
            .map(|(tool, record)| {
                let job = self.0.jobs.get(record.job_id)?.snapshot().clone();
                Ok((tool, NativeToolOperation::from_record(record, job)))
            })
            .collect()
    }

    fn reserve(&self, tool: NativeToolId) -> CommandResult<OperationReservation> {
        let mut operations =
            self.0.operations.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        if operations.contains_key(&tool) {
            return Err(NativeToolError::OperationInProgress(tool).into());
        }
        operations.insert(tool, OperationSlot::Reserved { tool });
        Ok(OperationReservation {
            runtime: self.clone(),
            tool,
            activated: false,
        })
    }

    fn activate(
        &self,
        reservation: &mut OperationReservation,
        record: DurableOperation,
        cancellation: CancellationToken,
    ) -> CommandResult<()> {
        let mut operations =
            self.0.operations.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        if !matches!(operations.get(&record.tool), Some(OperationSlot::Reserved { tool }) if *tool == record.tool)
            || reservation.tool != record.tool
        {
            return Err(CommandError::internal(
                "the native tool reservation is unavailable",
            ));
        }
        persist_operation(&self.0.database, &record)?;
        operations.insert(
            record.tool,
            OperationSlot::Active {
                record,
                cancellation,
            },
        );
        reservation.activated = true;
        Ok(())
    }

    fn report_progress(
        &self,
        job_id: JobId,
        tool: NativeToolId,
        action: NativeToolAction,
        progress: OperationProgress,
        on_event: &Channel<NativeToolEvent>,
    ) -> CommandResult<()> {
        let mut operations =
            self.0.operations.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        let Some(OperationSlot::Active {
            record,
            cancellation,
        }) = operations.get_mut(&tool)
        else {
            return Err(CommandError::internal(
                "the native tool operation is unavailable",
            ));
        };
        if record.job_id != job_id || record.action != action {
            return Err(CommandError::internal(
                "the native tool operation identity changed",
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
                "the native tool progress phase regressed",
            ));
        }
        let before_sequence = current.snapshot().sequence();
        let basis_points = mapped_basis_points.max(current.snapshot().progress().basis_points());
        let job = if basis_points > current.snapshot().progress().basis_points() {
            self.0
                .jobs
                .apply(
                    job_id,
                    JobUpdate::ReportProgress(
                        JobProgress::from_basis_points(basis_points).map_err(|_| {
                            CommandError::internal("the native tool progress is invalid")
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
        persist_operation(&self.0.database, record)?;
        let operation = NativeToolOperation::from_record(record, job.clone());
        drop(operations);
        if job.sequence() > before_sequence {
            let _ = on_event.send(NativeToolEvent::Progress { operation });
        }
        Ok(())
    }

    fn execute(
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

    fn install(
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

    fn remove(
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

    fn restore_lease_after_refresh_failure<T>(
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

    fn consumers_idle(&self, tool: NativeToolId) -> Result<bool, ExecutionFailure> {
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

    fn finish(
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
            return match finish_cancelled_job(&self.0.jobs, job_id) {
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

fn clear_recovered_operations(database: &Database) -> Result<(), DatabaseError> {
    let keys = database
        .list_settings(OPERATION_SCOPE)?
        .into_keys()
        .collect::<Vec<_>>();
    for batch in keys.chunks(256) {
        database.delete_settings(OPERATION_SCOPE, batch)?;
    }
    Ok(())
}

fn read_pending_removals(database: &Database) -> Result<HashSet<NativeToolId>, DatabaseError> {
    let mut pending = HashSet::new();
    let mut stale = Vec::new();
    for (key, value) in database.list_settings(PENDING_REMOVAL_SCOPE)? {
        let Ok(tool) = NativeToolId::try_from(key.as_str()) else {
            stale.push(key);
            continue;
        };
        if value == json!({ "schemaVersion": PENDING_REMOVAL_VALUE }) {
            pending.insert(tool);
        } else {
            stale.push(key);
        }
    }
    for batch in stale.chunks(256) {
        database.delete_settings(PENDING_REMOVAL_SCOPE, batch)?;
    }
    Ok(pending)
}

fn apply_pending_removals(
    manager: &NativeToolManager,
    database: &Database,
) -> Result<(), NativeToolRuntimeError> {
    let pending = read_pending_removals(database)?;
    for tool in pending {
        let outcome = manager.remove(tool, &CancellationToken::default(), &|_| {});
        match outcome {
            Ok(
                RemovalOutcome::Missing
                | RemovalOutcome::Removed
                | RemovalOutcome::PreservedModified,
            )
            | Err(NativeToolError::DeliveryUnavailable) => {
                database.delete_setting(PENDING_REMOVAL_SCOPE, tool.as_str())?;
            }
            Err(_) => {}
        }
    }
    Ok(())
}

fn persist_operation(database: &Database, record: &DurableOperation) -> CommandResult<()> {
    let value = serde_json::to_value(record)
        .map_err(|_| CommandError::internal("the native tool metadata is invalid"))?;
    database
        .put_setting(OPERATION_SCOPE, &record.job_id.to_string(), &value)
        .map_err(Into::into)
}

fn map_progress(
    action: NativeToolAction,
    progress: OperationProgress,
) -> CommandResult<(NativeToolPhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (NativeToolAction::Install, OperationPhase::Preparing) => {
            (NativeToolPhase::Preparing, 0_u32, 0_u32)
        }
        (NativeToolAction::Install, OperationPhase::Downloading | OperationPhase::Verifying) => {
            (NativeToolPhase::Downloading, 0, 6_000)
        }
        (NativeToolAction::Install, OperationPhase::Extracting) => {
            (NativeToolPhase::Extracting, 6_000, 3_000)
        }
        (NativeToolAction::Install, OperationPhase::Publishing) => {
            (NativeToolPhase::Publishing, 9_000, 900)
        }
        (NativeToolAction::Remove, OperationPhase::Removing) => {
            (NativeToolPhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "the native tool progress phase is invalid",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("the native tool progress is invalid"))?,
    ))
}

fn record_native_tool_terminal(
    event: &'static str,
    action: NativeToolAction,
    job_id: JobId,
    tool: NativeToolId,
    code: Option<&str>,
) {
    let mut fields = vec![("action", action.as_str().to_owned())];
    if let Some(code) = code {
        fields.push(("code", code.to_owned()));
    }
    fields.extend([
        ("job", job_id.to_string()),
        ("tool", tool.as_str().to_owned()),
    ]);
    diagnostics::record(event, &fields);
}

const fn phase_rank(action: NativeToolAction, phase: NativeToolPhase) -> u8 {
    match (action, phase) {
        (_, NativeToolPhase::Preparing) => 0,
        (NativeToolAction::Install, NativeToolPhase::Downloading)
        | (NativeToolAction::Remove, NativeToolPhase::Removing) => 1,
        (NativeToolAction::Install, NativeToolPhase::Extracting) => 2,
        (NativeToolAction::Install, NativeToolPhase::Publishing) => 3,
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
                "the native tool cancellation arrived after finalization",
            ));
        }
    };
    Ok(ticket.snapshot().clone())
}

fn execution_error(failure: ExecutionFailure) -> CommandError {
    match failure {
        ExecutionFailure::Tool(error) => error.into(),
        ExecutionFailure::Database(error) => error.into(),
        ExecutionFailure::Internal => {
            CommandError::internal("the native tool operation could not be recorded safely")
        }
    }
}

async fn start_operation(
    runtime: NativeToolRuntime,
    tool: NativeToolId,
    action: NativeToolAction,
    on_event: Channel<NativeToolEvent>,
) -> CommandResult<JobSnapshot> {
    let mut reservation = runtime.reserve(tool)?;
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(
        &mut reservation,
        DurableOperation::preparing(&initial, tool, action),
        cancellation.clone(),
    ) {
        let _ = jobs.apply(job_id, JobUpdate::Fail);
        return Err(error);
    }
    diagnostics::record(
        "native-tool.started",
        &[
            ("action", action.as_str().to_owned()),
            ("job", job_id.to_string()),
            ("tool", tool.as_str().to_owned()),
        ],
    );
    let job_cancellation = ticket.cancellation().clone();
    let watcher_cancellation = cancellation.clone();
    let background_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_cancellation.cancel();
        });
        let worker_runtime = background_runtime.clone();
        let worker_channel = on_event.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            worker_runtime.execute(job_id, tool, action, &cancellation, &worker_channel)
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or(Err(ExecutionFailure::Internal));
        background_runtime.finish(job_id, tool, action, result, &on_event);
    });
    Ok(initial)
}

#[tauri::command]
pub(crate) fn native_tools_catalog() -> NativeToolsCatalog {
    NativeToolRuntime::catalog()
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn native_tools_status(
    runtime: State<'_, NativeToolRuntime>,
) -> CommandResult<NativeToolsStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| CommandError::internal("the native tool status task stopped unexpectedly"))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn native_tool_install(
    runtime: State<'_, NativeToolRuntime>,
    tool: NativeToolId,
    on_event: Channel<NativeToolEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    diagnostics::record(
        "native-tool.requested",
        &[
            ("action", NativeToolAction::Install.as_str().to_owned()),
            ("tool", tool.as_str().to_owned()),
        ],
    );
    if !runtime.0.manager.delivery_available(tool) {
        return Err(NativeToolError::DeliveryUnavailable.into());
    }
    start_operation(runtime, tool, NativeToolAction::Install, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn native_tool_remove(
    runtime: State<'_, NativeToolRuntime>,
    tool: NativeToolId,
    on_event: Channel<NativeToolEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    diagnostics::record(
        "native-tool.requested",
        &[
            ("action", NativeToolAction::Remove.as_str().to_owned()),
            ("tool", tool.as_str().to_owned()),
        ],
    );
    if !runtime.0.manager.delivery_available(tool) {
        return Err(NativeToolError::DeliveryUnavailable.into());
    }
    start_operation(runtime, tool, NativeToolAction::Remove, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn native_tool_cancel(
    runtime: State<'_, NativeToolRuntime>,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancellation = {
            let operations = runtime.0.operations.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
            let Some((_, OperationSlot::Active { record, cancellation })) = operations
                .iter()
                .find(|(_, slot)| matches!(slot, OperationSlot::Active { record, .. } if record.job_id == job_id))
            else {
                return Err(CommandError::invalid_input(
                    "The native tool operation is not active.",
                ));
            };
            if record.job_id != job_id {
                return Err(CommandError::invalid_input(
                    "The job is not the active native tool operation.",
                ));
            }
            cancellation.clone()
        };
        let current = runtime.0.jobs.get(job_id)?;
        if current.snapshot().kind() != JobKind::InstallEngine {
            return Err(CommandError::invalid_input(
                "The job is not a native tool operation.",
            ));
        }
        if current.snapshot().state().is_terminal() {
            return Ok(current.snapshot().clone());
        }
        let ticket = if current.snapshot().state() == JobState::Cancelling {
            current
        } else {
            runtime
                .0
                .jobs
                .apply(job_id, JobUpdate::RequestCancellation)?
        };
        cancellation.cancel();
        Ok(ticket.snapshot().clone())
    })
    .await
    .map_err(|_| CommandError::internal("the native tool cancellation task stopped unexpectedly"))?
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use osg_application::JobRegistry;
    use osg_domain::{JobKind, JobUpdate};
    use osg_native_tools::{NativeToolId, OperationPhase, OperationProgress};
    use serde_json::json;

    use super::{
        ExecutionFailure, NativeToolAction, NativeToolActivator, NativeToolEvent, NativeToolPhase,
        NativeToolRuntime, SCHEMA_VERSION, map_progress,
    };
    use crate::error::{CommandError, CommandResult};

    #[derive(Debug)]
    struct CountingActivator {
        failures_remaining: AtomicUsize,
        refreshes: AtomicUsize,
    }

    impl CountingActivator {
        fn new(failures: usize) -> Self {
            Self {
                failures_remaining: AtomicUsize::new(failures),
                refreshes: AtomicUsize::new(0),
            }
        }
    }

    impl NativeToolActivator for CountingActivator {
        fn refresh(&self, _: &NativeToolRuntime) -> CommandResult<()> {
            self.refreshes.fetch_add(1, Ordering::Relaxed);
            if self
                .failures_remaining
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                Err(CommandError::internal("injected activator failure"))
            } else {
                Ok(())
            }
        }

        fn consumers_idle(&self, _: NativeToolId) -> CommandResult<bool> {
            Ok(true)
        }
    }

    fn runtime_fixture() -> (tempfile::TempDir, NativeToolRuntime) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let database =
            osg_infrastructure::storage::Database::open(temporary.path().join("database.sqlite3"))
                .expect("database");
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
        let runtime =
            NativeToolRuntime::new(&temporary.path().join("native-tools"), database, jobs)
                .expect("native tool runtime");
        (temporary, runtime)
    }

    #[test]
    fn catalog_and_status_are_path_free_and_platform_accurate() {
        let (_temporary, runtime) = runtime_fixture();
        let catalog = serde_json::to_string(&NativeToolRuntime::catalog()).expect("catalog");
        let status =
            serde_json::to_string(&runtime.status().expect("status")).expect("status json");

        assert!(!catalog.contains("http"));
        assert!(!catalog.contains("bin/"));
        assert!(!status.contains("http"));
        assert!(!status.contains("bin/"));
        let decoded: serde_json::Value = serde_json::from_str(&status).expect("valid json");
        assert_eq!(decoded["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(decoded["tools"][0]["id"], "media-tools");
        assert_eq!(
            decoded["tools"][0]["state"],
            if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
                "missing"
            } else {
                "unavailable"
            }
        );
        assert_eq!(decoded["tools"][1]["state"], "missing");
        assert_eq!(decoded["tools"][2]["state"], "missing");
    }

    #[test]
    fn progress_mapping_is_monotonic_across_acquisition_and_publication() {
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
            .map(|progress| map_progress(NativeToolAction::Install, progress).expect("progress"))
            .collect::<Vec<_>>();
        assert_eq!(mapped[0], (NativeToolPhase::Downloading, 6_000));
        assert_eq!(mapped[1], (NativeToolPhase::Downloading, 0));
        assert_eq!(mapped[2], (NativeToolPhase::Extracting, 7_500));
        assert_eq!(mapped[3], (NativeToolPhase::Publishing, 9_900));
    }

    #[test]
    fn completed_event_uses_the_exact_camel_case_webview_contract() {
        let (_temporary, runtime) = runtime_fixture();
        let queued = runtime
            .0
            .jobs
            .register(JobKind::InstallEngine)
            .expect("queued job");
        let job_id = queued.snapshot().id();
        runtime
            .0
            .jobs
            .apply(job_id, JobUpdate::Start)
            .expect("running job");
        let succeeded = runtime
            .0
            .jobs
            .apply(job_id, JobUpdate::Succeed)
            .expect("succeeded job");

        let value = serde_json::to_value(NativeToolEvent::Completed {
            job: succeeded.snapshot().clone(),
            tool: NativeToolId::YtDlp,
            action: NativeToolAction::Install,
            restart_required: false,
            deferred: false,
        })
        .expect("serializable event");

        assert_eq!(value["event"], "completed");
        assert_eq!(value["restartRequired"], false);
        assert_eq!(value["deferred"], false);
        assert_eq!(value["tool"], "yt-dlp");
        assert_eq!(value["action"], "install");
        assert_eq!(value["job"]["state"], "succeeded");
        assert_eq!(value.as_object().map(serde_json::Map::len), Some(6));
        assert_eq!(value.get("restart_required"), None);
        assert_ne!(value, json!({ "event": "completed" }));
    }

    #[test]
    fn runtime_debug_never_exposes_its_store_path() {
        let (temporary, runtime) = runtime_fixture();
        let debug = format!("{runtime:?}");
        assert!(!debug.contains(temporary.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn distinct_tools_reserve_concurrently_but_duplicate_tool_work_is_rejected() {
        let (_temporary, runtime) = runtime_fixture();
        let media = runtime
            .reserve(NativeToolId::MediaTools)
            .expect("media reservation");
        let downloader = runtime
            .reserve(NativeToolId::YtDlp)
            .expect("downloader reservation");

        assert_eq!(runtime.0.operations.lock().expect("operations").len(), 2);
        assert!(runtime.reserve(NativeToolId::MediaTools).is_err());

        drop(media);
        drop(downloader);
        assert!(runtime.0.operations.lock().expect("operations").is_empty());
    }

    #[test]
    fn failed_activation_refreshes_restored_state_and_persistent_failure_fails_closed() {
        let (_temporary, runtime) = runtime_fixture();
        let recovers = Arc::new(CountingActivator::new(0));
        runtime
            .attach_activator(recovers.clone())
            .expect("activator");
        let result: Result<(), ExecutionFailure> =
            runtime.restore_lease_after_refresh_failure(NativeToolId::YtDlp, None);
        assert!(matches!(result, Err(ExecutionFailure::Internal)));
        assert_eq!(recovers.refreshes.load(Ordering::Relaxed), 1);
        assert!(runtime.0.active_leases.read().unwrap().is_empty());

        let (_temporary, runtime) = runtime_fixture();
        let persistent = Arc::new(CountingActivator::new(2));
        runtime
            .attach_activator(persistent.clone())
            .expect("activator");
        let result: Result<(), ExecutionFailure> =
            runtime.restore_lease_after_refresh_failure(NativeToolId::YtDlp, None);
        assert!(matches!(result, Err(ExecutionFailure::Internal)));
        assert_eq!(persistent.refreshes.load(Ordering::Relaxed), 2);
        assert!(runtime.0.active_leases.read().unwrap().is_empty());
    }

    #[test]
    fn diagnostic_action_values_are_the_frozen_public_contract() {
        assert_eq!(NativeToolAction::Install.as_str(), "install");
        assert_eq!(NativeToolAction::Remove.as_str(), "remove");
    }
}
