//! Native-tool runtime state, operation records, public DTOs and events.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, RwLock};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobSnapshot};
use osg_infrastructure::storage::{Database, DatabaseError};
use osg_native_tools::{
    CancellationToken, NativeToolError, NativeToolId, NativeToolInfo, NativeToolManager,
    NativeToolStatus, RuntimeCoordinator, ToolLease,
};
use serde::{Deserialize, Serialize};

use super::SCHEMA_VERSION;
use crate::error::{CommandError, CommandResult};

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
pub(super) struct LeaseRuntimeCoordinator;

impl RuntimeCoordinator for LeaseRuntimeCoordinator {
    fn quiesce(&self, _: NativeToolId) -> osg_native_tools::Result<()> {
        // The desktop runtime removes its verified lease and refreshes every
        // executable consumer before entering NativeToolManager::remove.
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct NativeToolRuntime(pub(super) Arc<NativeToolRuntimeInner>);

pub(super) struct NativeToolRuntimeInner {
    pub(super) manager: NativeToolManager,
    pub(super) database: Database,
    pub(super) jobs: Arc<JobRegistry<Database>>,
    pub(super) active_leases: RwLock<HashMap<NativeToolId, ToolLease>>,
    pub(super) operations: Mutex<HashMap<NativeToolId, OperationSlot>>,
    pub(super) activator: RwLock<Option<Arc<dyn NativeToolActivator>>>,
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
pub(super) enum OperationSlot {
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
    pub(super) const fn as_str(self) -> &'static str {
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
pub(super) struct DurableOperation {
    pub(super) schema_version: u32,
    pub(super) job_id: JobId,
    pub(super) tool: NativeToolId,
    pub(super) action: NativeToolAction,
    pub(super) phase: NativeToolPhase,
    pub(super) basis_points: u16,
    pub(super) bytes_done: u64,
    pub(super) total_bytes: u64,
}

impl DurableOperation {
    pub(super) fn preparing(
        job: &JobSnapshot,
        tool: NativeToolId,
        action: NativeToolAction,
    ) -> Self {
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
    pub(super) job: JobSnapshot,
    pub(super) tool: NativeToolId,
    pub(super) action: NativeToolAction,
    pub(super) phase: NativeToolPhase,
    pub(super) basis_points: u16,
    pub(super) bytes_done: u64,
    pub(super) total_bytes: u64,
}

impl NativeToolOperation {
    pub(super) fn from_record(record: &DurableOperation, job: JobSnapshot) -> Self {
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
    pub(super) schema_version: u32,
    pub(super) tools: Vec<NativeToolInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeToolsStatus {
    pub(super) schema_version: u32,
    pub(super) tools: Vec<NativeToolStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeToolStatusEntry {
    #[serde(flatten)]
    pub(super) tool: NativeToolStatus,
    pub(super) active_runtime: bool,
    pub(super) pending_removal: bool,
    pub(super) restart_required: bool,
    pub(super) operation: Option<NativeToolOperation>,
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
pub(super) struct OperationOutcome {
    pub(super) restart_required: bool,
    pub(super) deferred: bool,
}

#[derive(Debug)]
pub(super) enum ExecutionFailure {
    Tool(NativeToolError),
    Database(DatabaseError),
    Internal,
}

pub(super) struct OperationReservation {
    pub(super) runtime: NativeToolRuntime,
    pub(super) tool: NativeToolId,
    pub(super) activated: bool,
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
