//! Engine-package runtime state, durable operation records, public DTOs and events.

use std::fmt;
use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobKind, JobSnapshot, JobState};
use osg_engine_packages::{
    CancellationToken, EngineId, EnginePackageManager, EnginePackageStatus, PackageError,
};
use osg_infrastructure::storage::Database;
use serde::{Deserialize, Serialize};

use super::OPERATION_SCHEMA_VERSION;
use super::durable::phase_allowed;
use crate::error::CommandError;

#[derive(Clone)]
pub(crate) struct EnginePackageRuntime(pub(super) Arc<EnginePackageRuntimeInner>);

pub(super) struct EnginePackageRuntimeInner {
    pub(super) manager: EnginePackageManager,
    pub(super) database: Database,
    pub(super) jobs: Arc<JobRegistry<Database>>,
    pub(super) operation: Mutex<OperationSlot>,
}

#[derive(Debug, Default)]
pub(super) enum OperationSlot {
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
pub(super) struct DurableOperation {
    pub(super) schema_version: u32,
    pub(super) job_id: JobId,
    pub(super) engine: EngineId,
    pub(super) action: EnginePackageAction,
    pub(super) phase: EnginePackagePhase,
    pub(super) basis_points: u16,
    pub(super) bytes_done: u64,
    pub(super) total_bytes: u64,
}

impl DurableOperation {
    pub(super) fn preparing(
        job: &JobSnapshot,
        engine: EngineId,
        action: EnginePackageAction,
    ) -> Self {
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

    pub(super) fn is_valid_for(&self, key: &str, job: &JobSnapshot) -> bool {
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
    pub(super) job: JobSnapshot,
    pub(super) engine: EngineId,
    pub(super) action: EnginePackageAction,
    pub(super) phase: EnginePackagePhase,
    pub(super) basis_points: u16,
    pub(super) bytes_done: u64,
    pub(super) total_bytes: u64,
}

impl EnginePackageOperation {
    pub(super) fn from_record(record: &DurableOperation, job: JobSnapshot) -> Self {
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
    pub(super) schema_version: u32,
    pub(super) engines: Vec<EnginePackageStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EnginePackageStatusEntry {
    #[serde(flatten)]
    pub(super) package: EnginePackageStatus,
    pub(super) operation: Option<EnginePackageOperation>,
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

pub(super) struct OperationReservation {
    pub(super) runtime: EnginePackageRuntime,
    pub(super) engine: EngineId,
    pub(super) activated: bool,
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
pub(super) enum ExecutionFailure {
    Package(PackageError),
    Internal,
}
