//! Native-tool runtime construction, activation, status and per-tool reservation.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobProgress, JobState, JobUpdate};
use osg_infrastructure::storage::Database;
use osg_native_tools::{
    CancellationToken, ExecutableRole, NativeToolError, NativeToolId, NativeToolManager,
    OperationProgress, catalog,
};
use tauri::ipc::Channel;

use super::SCHEMA_VERSION;
use super::durable::{
    apply_pending_removals, clear_recovered_operations, map_progress, persist_operation,
    phase_rank, read_pending_removals,
};
use super::types::{
    DurableOperation, LeaseRuntimeCoordinator, NativeToolAction, NativeToolActivator,
    NativeToolEvent, NativeToolOperation, NativeToolRuntime, NativeToolRuntimeError,
    NativeToolRuntimeInner, NativeToolStatusEntry, NativeToolsCatalog, NativeToolsStatus,
    OperationReservation, OperationSlot,
};
use crate::error::{CommandError, CommandResult};

impl NativeToolRuntime {
    /// The manager prepares its staging authority inside the store root, so an interrupted
    /// install's journal can never be separated from the `.staging` entry it owns.
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

    pub(super) fn catalog() -> NativeToolsCatalog {
        NativeToolsCatalog {
            schema_version: SCHEMA_VERSION,
            tools: catalog().to_vec(),
        }
    }

    pub(super) fn status(&self) -> CommandResult<NativeToolsStatus> {
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

    pub(super) fn reserve(&self, tool: NativeToolId) -> CommandResult<OperationReservation> {
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

    pub(super) fn activate(
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

    pub(super) fn report_progress(
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
}
