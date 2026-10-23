//! Job snapshot and job-result delivery requests.

use std::sync::mpsc::SyncSender;

use osg_application::JobWrite;
use osg_domain::{AssetId, JobId, JobSnapshot, ProjectId};
use rusqlite::Connection;
use uuid::Uuid;

use super::{Database, Request};
use crate::storage::error::DatabaseError;
use crate::storage::job_results;
use crate::storage::jobs;
use crate::storage::{
    JobResultDelivery, JobResultDeliveryDraft, JobResultDeliveryHeader, JobResultKind,
};

pub(super) enum JobRequest {
    CreateJob {
        snapshot: JobSnapshot,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    GetJob {
        id: JobId,
        reply: SyncSender<Result<Option<JobSnapshot>, DatabaseError>>,
    },
    ListJobs {
        reply: SyncSender<Result<Vec<JobSnapshot>, DatabaseError>>,
    },
    CompareAndSwapJob {
        expected_sequence: u64,
        snapshot: JobSnapshot,
        reply: SyncSender<Result<JobWrite, DatabaseError>>,
    },
    CompleteJobWithResult {
        expected_sequence: u64,
        snapshot: JobSnapshot,
        delivery: JobResultDeliveryDraft,
        reply: SyncSender<Result<JobWrite, DatabaseError>>,
    },
    CompleteProjectJobWithResult {
        expected_sequence: u64,
        snapshot: JobSnapshot,
        delivery: JobResultDeliveryDraft,
        project_id: ProjectId,
        expected_state_version: u64,
        asset_id: Option<AssetId>,
        reply: SyncSender<Result<JobWrite, DatabaseError>>,
    },
    CompleteProjectJob {
        expected_sequence: u64,
        snapshot: JobSnapshot,
        project_id: ProjectId,
        expected_state_version: u64,
        reply: SyncSender<Result<JobWrite, DatabaseError>>,
    },
    ListPendingJobResults {
        kind: Option<JobResultKind>,
        after_delivery_id: Option<uuid::Uuid>,
        reply: SyncSender<Result<Vec<JobResultDeliveryHeader>, DatabaseError>>,
    },
    ClaimJobResult {
        job_id: JobId,
        reply: SyncSender<Result<Option<JobResultDelivery>, DatabaseError>>,
    },
    AcknowledgeJobResult {
        job_id: JobId,
        delivery_id: Uuid,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
}

impl std::fmt::Debug for JobRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::CreateJob { .. } => "CreateJob",
            Self::GetJob { .. } => "GetJob",
            Self::ListJobs { .. } => "ListJobs",
            Self::CompareAndSwapJob { .. } => "CompareAndSwapJob",
            Self::CompleteJobWithResult { .. } => "CompleteJobWithResult",
            Self::CompleteProjectJobWithResult { .. } => "CompleteProjectJobWithResult",
            Self::CompleteProjectJob { .. } => "CompleteProjectJob",
            Self::ListPendingJobResults { .. } => "ListPendingJobResults",
            Self::ClaimJobResult { .. } => "ClaimJobResult",
            Self::AcknowledgeJobResult { .. } => "AcknowledgeJobResult",
        })
    }
}

impl From<JobRequest> for Request {
    fn from(request: JobRequest) -> Self {
        Self::Jobs(request)
    }
}

impl JobRequest {
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::CreateJob { snapshot, reply } => {
                let _ = reply.send(jobs::create(connection, &snapshot));
            }
            Self::GetJob { id, reply } => {
                let _ = reply.send(jobs::get(connection, id));
            }
            Self::ListJobs { reply } => {
                let _ = reply.send(jobs::list(connection));
            }
            Self::CompareAndSwapJob {
                expected_sequence,
                snapshot,
                reply,
            } => {
                let _ = reply.send(jobs::compare_and_swap(
                    connection,
                    expected_sequence,
                    &snapshot,
                ));
            }
            Self::CompleteJobWithResult {
                expected_sequence,
                snapshot,
                delivery,
                reply,
            } => {
                let _ = reply.send(job_results::complete_job_with_result(
                    connection,
                    expected_sequence,
                    &snapshot,
                    &delivery,
                ));
            }
            Self::CompleteProjectJobWithResult {
                expected_sequence,
                snapshot,
                delivery,
                project_id,
                expected_state_version,
                asset_id,
                reply,
            } => {
                let _ = reply.send(job_results::complete_project_job_with_result(
                    connection,
                    expected_sequence,
                    &snapshot,
                    &delivery,
                    project_id,
                    expected_state_version,
                    asset_id,
                ));
            }
            Self::CompleteProjectJob {
                expected_sequence,
                snapshot,
                project_id,
                expected_state_version,
                reply,
            } => {
                let _ = reply.send(job_results::complete_project_job(
                    connection,
                    expected_sequence,
                    &snapshot,
                    project_id,
                    expected_state_version,
                ));
            }
            Self::ListPendingJobResults {
                kind,
                after_delivery_id,
                reply,
            } => {
                let _ = reply.send(job_results::list_pending(
                    connection,
                    kind,
                    after_delivery_id,
                ));
            }
            Self::ClaimJobResult { job_id, reply } => {
                let _ = reply.send(job_results::claim(connection, job_id));
            }
            Self::AcknowledgeJobResult {
                job_id,
                delivery_id,
                reply,
            } => {
                let _ = reply.send(job_results::acknowledge(connection, job_id, delivery_id));
            }
        }
    }
}

impl Database {
    pub fn create_job(&self, snapshot: &JobSnapshot) -> Result<(), DatabaseError> {
        self.request(|reply| JobRequest::CreateJob {
            snapshot: snapshot.clone(),
            reply,
        })
    }

    pub fn get_job(&self, id: JobId) -> Result<Option<JobSnapshot>, DatabaseError> {
        self.request(|reply| JobRequest::GetJob { id, reply })
    }

    pub fn list_jobs(&self) -> Result<Vec<JobSnapshot>, DatabaseError> {
        self.request(|reply| JobRequest::ListJobs { reply })
    }

    pub fn compare_and_swap_job(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
    ) -> Result<JobWrite, DatabaseError> {
        self.request(|reply| JobRequest::CompareAndSwapJob {
            expected_sequence,
            snapshot: snapshot.clone(),
            reply,
        })
    }

    pub fn complete_job_with_result(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
        delivery: &JobResultDeliveryDraft,
    ) -> Result<JobWrite, DatabaseError> {
        self.request(|reply| JobRequest::CompleteJobWithResult {
            expected_sequence,
            snapshot: snapshot.clone(),
            delivery: delivery.clone(),
            reply,
        })
    }

    pub fn complete_project_job_with_result(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
        delivery: &JobResultDeliveryDraft,
        project_id: ProjectId,
        expected_state_version: u64,
        asset_id: Option<AssetId>,
    ) -> Result<JobWrite, DatabaseError> {
        self.request(|reply| JobRequest::CompleteProjectJobWithResult {
            expected_sequence,
            snapshot: snapshot.clone(),
            delivery: delivery.clone(),
            project_id,
            expected_state_version,
            asset_id,
            reply,
        })
    }

    /// Commits a terminal job transition only while its exact project revision is current.
    pub fn complete_project_job(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
        project_id: ProjectId,
        expected_state_version: u64,
    ) -> Result<JobWrite, DatabaseError> {
        self.request(|reply| JobRequest::CompleteProjectJob {
            expected_sequence,
            snapshot: snapshot.clone(),
            project_id,
            expected_state_version,
            reply,
        })
    }

    pub fn list_pending_job_results(&self) -> Result<Vec<JobResultDeliveryHeader>, DatabaseError> {
        self.list_pending_job_results_by_kind_after(None, None)
    }

    pub fn list_pending_job_results_by_kind(
        &self,
        kind: Option<JobResultKind>,
    ) -> Result<Vec<JobResultDeliveryHeader>, DatabaseError> {
        self.list_pending_job_results_by_kind_after(kind, None)
    }

    pub fn list_pending_job_results_by_kind_after(
        &self,
        kind: Option<JobResultKind>,
        after_delivery_id: Option<uuid::Uuid>,
    ) -> Result<Vec<JobResultDeliveryHeader>, DatabaseError> {
        self.request(|reply| JobRequest::ListPendingJobResults {
            kind,
            after_delivery_id,
            reply,
        })
    }

    pub fn claim_job_result(
        &self,
        job_id: JobId,
    ) -> Result<Option<JobResultDelivery>, DatabaseError> {
        self.request(|reply| JobRequest::ClaimJobResult { job_id, reply })
    }

    pub fn acknowledge_job_result(
        &self,
        job_id: JobId,
        delivery_id: Uuid,
    ) -> Result<bool, DatabaseError> {
        self.request(|reply| JobRequest::AcknowledgeJobResult {
            job_id,
            delivery_id,
            reply,
        })
    }
}
