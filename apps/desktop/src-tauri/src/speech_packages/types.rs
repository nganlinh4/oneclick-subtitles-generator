//! Speech-package runtime state, operation records, public DTOs and events.

use std::sync::{Arc, Mutex};

use osg_application::JobRegistry;
use osg_domain::{JobId, JobSnapshot};
use osg_engine_packages::{
    CancellationToken, PackageError, SpeechPackageId, SpeechPackageManager, SpeechPackageStatus,
};
use osg_infrastructure::storage::Database;
use serde::{Deserialize, Serialize};

use crate::error::CommandError;

#[derive(Clone)]
pub(crate) struct SpeechPackageRuntime(pub(super) Arc<RuntimeInner>);

pub(super) struct RuntimeInner {
    pub(super) manager: SpeechPackageManager,
    pub(super) jobs: Arc<JobRegistry<Database>>,
    pub(super) operation: Mutex<OperationSlot>,
}

#[derive(Debug, Default)]
pub(super) enum OperationSlot {
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
pub(super) struct OperationRecord {
    pub(super) job_id: JobId,
    pub(super) backend: SpeechPackageId,
    pub(super) action: SpeechPackageAction,
    pub(super) phase: SpeechPackagePhase,
    pub(super) basis_points: u16,
    pub(super) bytes_done: u64,
    pub(super) total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechPackageOperation {
    pub(super) job: JobSnapshot,
    pub(super) backend: SpeechPackageId,
    pub(super) action: SpeechPackageAction,
    pub(super) phase: SpeechPackagePhase,
    pub(super) basis_points: u16,
    pub(super) bytes_done: u64,
    pub(super) total_bytes: u64,
}

impl SpeechPackageOperation {
    pub(super) fn from_record(record: &OperationRecord, job: JobSnapshot) -> Self {
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
    pub(super) schema_version: u32,
    pub(super) packages: Vec<SpeechPackageStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpeechPackageStatusEntry {
    #[serde(flatten)]
    pub(super) package: SpeechPackageStatus,
    pub(super) operation: Option<SpeechPackageOperation>,
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

pub(super) struct OperationReservation {
    pub(super) runtime: SpeechPackageRuntime,
    pub(super) backend: SpeechPackageId,
    pub(super) activated: bool,
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
pub(super) enum ExecutionFailure {
    Package(PackageError),
    Internal,
}
