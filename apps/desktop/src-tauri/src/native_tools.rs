use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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

#[derive(Debug)]
struct LeaseRuntimeCoordinator;

impl RuntimeCoordinator for LeaseRuntimeCoordinator {
    fn quiesce(&self, _: NativeToolId) -> osg_native_tools::Result<()> {
        // Every managed executable consumer holds a ToolLease for the entire
        // process lifetime. NativeToolManager rejects mutation while any lease
        // remains, so no separate process registry is needed here.
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct NativeToolRuntime(Arc<NativeToolRuntimeInner>);

struct NativeToolRuntimeInner {
    manager: NativeToolManager,
    database: Database,
    jobs: Arc<JobRegistry<Database>>,
    startup_leases: HashMap<NativeToolId, ToolLease>,
    operation: Mutex<OperationSlot>,
}

impl fmt::Debug for NativeToolRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let active = self
            .0
            .operation
            .lock()
            .ok()
            .is_some_and(|slot| !matches!(*slot, OperationSlot::Idle));
        formatter
            .debug_struct("NativeToolRuntime")
            .field("manager", &self.0.manager)
            .field("startup_lease_count", &self.0.startup_leases.len())
            .field("active", &active)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
enum OperationSlot {
    #[default]
    Idle,
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
#[serde(tag = "event", rename_all = "camelCase")]
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
        if let Ok(mut slot) = self.runtime.0.operation.lock()
            && matches!(*slot, OperationSlot::Reserved { tool } if tool == self.tool)
        {
            *slot = OperationSlot::Idle;
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
        clear_recovered_operations(&database)?;
        apply_pending_removals(&manager, &database)?;
        let startup_leases = NativeToolId::ALL
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
            startup_leases,
            operation: Mutex::new(OperationSlot::Idle),
        })))
    }

    #[must_use]
    pub(crate) fn executable(&self, tool: NativeToolId, role: ExecutableRole) -> Option<PathBuf> {
        self.0
            .startup_leases
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
        let operation = self.active_operation()?;
        Ok(NativeToolsStatus {
            schema_version: SCHEMA_VERSION,
            tools: self
                .0
                .manager
                .statuses()
                .into_iter()
                .map(|tool| {
                    let active_version =
                        self.0.startup_leases.get(&tool.id).map(ToolLease::version);
                    let active_runtime = active_version.is_some();
                    let pending_removal = pending.contains(&tool.id);
                    let restart_required = pending_removal
                        || (tool.installed && active_version != tool.version.as_deref());
                    let entry_operation = operation
                        .as_ref()
                        .filter(|operation| operation.tool == tool.id)
                        .cloned();
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

    fn active_operation(&self) -> CommandResult<Option<NativeToolOperation>> {
        let slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        let OperationSlot::Active { record, .. } = &*slot else {
            return Ok(None);
        };
        let job = self.0.jobs.get(record.job_id)?.snapshot().clone();
        Ok(Some(NativeToolOperation::from_record(record, job)))
    }

    fn reserve(&self, tool: NativeToolId) -> CommandResult<OperationReservation> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        if !matches!(*slot, OperationSlot::Idle) {
            return Err(NativeToolError::OperationInProgress(tool).into());
        }
        *slot = OperationSlot::Reserved { tool };
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
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        if !matches!(*slot, OperationSlot::Reserved { tool } if tool == record.tool)
            || reservation.tool != record.tool
        {
            return Err(CommandError::internal(
                "the native tool reservation is unavailable",
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

    fn report_progress(
        &self,
        job_id: JobId,
        action: NativeToolAction,
        progress: OperationProgress,
        on_event: &Channel<NativeToolEvent>,
    ) -> CommandResult<()> {
        let mut slot =
            self.0.operation.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
        let OperationSlot::Active {
            record,
            cancellation,
        } = &mut *slot
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
        drop(slot);
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
                .report_progress(job_id, action, value, &progress_channel)
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
        if progress_failed.load(Ordering::Acquire) {
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
        if tool == NativeToolId::YtDlp || !self.0.manager.status(tool).installed {
            self.0
                .manager
                .install(tool, cancellation, progress)
                .map_err(ExecutionFailure::Tool)?;
        }
        let installed_version = self.0.manager.status(tool).version;
        let active_version = self.0.startup_leases.get(&tool).map(ToolLease::version);
        Ok(OperationOutcome {
            restart_required: active_version != installed_version.as_deref(),
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
        if self.0.startup_leases.contains_key(&tool) {
            self.0
                .database
                .put_setting(
                    PENDING_REMOVAL_SCOPE,
                    tool.as_str(),
                    &json!({ "schemaVersion": PENDING_REMOVAL_VALUE }),
                )
                .map_err(ExecutionFailure::Database)?;
            return Ok(OperationOutcome {
                restart_required: true,
                deferred: true,
            });
        }
        match self
            .0
            .manager
            .remove(tool, cancellation, progress)
            .map_err(ExecutionFailure::Tool)?
        {
            RemovalOutcome::Missing | RemovalOutcome::Removed => {
                self.0
                    .database
                    .delete_setting(PENDING_REMOVAL_SCOPE, tool.as_str())
                    .map_err(ExecutionFailure::Database)?;
                Ok(OperationOutcome {
                    restart_required: false,
                    deferred: false,
                })
            }
            RemovalOutcome::PreservedModified => {
                Err(ExecutionFailure::Tool(NativeToolError::InvalidInstall))
            }
        }
    }

    fn finish(
        &self,
        job_id: JobId,
        tool: NativeToolId,
        action: NativeToolAction,
        result: Result<OperationOutcome, ExecutionFailure>,
        on_event: &Channel<NativeToolEvent>,
    ) {
        let Ok(mut slot) = self.0.operation.lock() else {
            let _ = on_event.send(NativeToolEvent::Failed {
                job: None,
                tool,
                action,
                error: CommandError::internal("the native tool coordinator is unavailable"),
            });
            return;
        };
        if !matches!(&*slot, OperationSlot::Active { record, .. } if record.job_id == job_id) {
            let _ = on_event.send(NativeToolEvent::Failed {
                job: self
                    .0
                    .jobs
                    .get(job_id)
                    .ok()
                    .map(|ticket| ticket.snapshot().clone()),
                tool,
                action,
                error: CommandError::internal("the native tool operation is unavailable"),
            });
            return;
        }
        let event = self.terminal_event(job_id, tool, action, result);
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
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(tool))
        .await
        .map_err(|_| CommandError::internal("the native tool check stopped unexpectedly"))?;
    if !status.delivery_available {
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
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(tool))
        .await
        .map_err(|_| CommandError::internal("the native tool check stopped unexpectedly"))?;
    if !status.delivery_available {
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
            let slot = runtime.0.operation.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
            let OperationSlot::Active {
                record,
                cancellation,
            } = &*slot
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

    use osg_application::JobRegistry;
    use osg_native_tools::{OperationPhase, OperationProgress};

    use super::{
        NativeToolAction, NativeToolPhase, NativeToolRuntime, SCHEMA_VERSION, map_progress,
    };

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
    fn runtime_debug_never_exposes_its_store_path() {
        let (temporary, runtime) = runtime_fixture();
        let debug = format!("{runtime:?}");
        assert!(!debug.contains(temporary.path().to_string_lossy().as_ref()));
    }
}
