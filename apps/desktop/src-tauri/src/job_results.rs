use osg_domain::{JobId, JobSnapshot, JobState};
use osg_infrastructure::storage::{
    Database, DatabaseError, JobResultDelivery, JobResultDeliveryHeader, JobResultKind,
    MAX_PENDING_JOB_RESULT_DELIVERIES,
};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimedJobResult {
    job: JobSnapshot,
    delivery: JobResultDelivery,
}

async fn database_task<T: Send + 'static>(
    task: &'static str,
    operation: impl FnOnce() -> Result<T, osg_infrastructure::storage::DatabaseError> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| CommandError::internal(format!("the {task} task stopped unexpectedly")))?
        .map_err(Into::into)
}

/// Returns only bounded identities. Payload bytes stay in `SQLite` until one result is claimed.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_result_pending(
    state: State<'_, DesktopState>,
    kind: Option<JobResultKind>,
    after_delivery_id: Option<Uuid>,
) -> CommandResult<Vec<JobResultDeliveryHeader>> {
    let database = state.database.clone();
    let pending = database_task("job-result discovery", move || {
        database.list_pending_job_results_by_kind_after(kind, after_delivery_id)
    })
    .await?;
    if pending.len() > MAX_PENDING_JOB_RESULT_DELIVERIES {
        return Err(CommandError::internal(
            "the durable result discovery exceeded its bound",
        ));
    }
    Ok(pending)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_result_claim(
    state: State<'_, DesktopState>,
    job_id: JobId,
) -> CommandResult<Option<ClaimedJobResult>> {
    let database = state.database.clone();
    database_task("job-result claim", move || {
        claim_from_database(&database, job_id)
    })
    .await
}

fn claim_from_database(
    database: &Database,
    job_id: JobId,
) -> Result<Option<ClaimedJobResult>, DatabaseError> {
    let Some(delivery) = database.claim_job_result(job_id)? else {
        return Ok(None);
    };
    let job = database
        .get_job(job_id)?
        .filter(|job| job.state() == JobState::Succeeded)
        .ok_or(DatabaseError::InvalidJobResultDelivery)?;
    if delivery.job_id != job.id() {
        return Err(DatabaseError::InvalidJobResultDelivery);
    }
    Ok(Some(ClaimedJobResult { job, delivery }))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_result_ack(
    state: State<'_, DesktopState>,
    job_id: JobId,
    delivery_id: Uuid,
) -> CommandResult<bool> {
    let database = state.database.clone();
    database_task("job-result acknowledgement", move || {
        database.acknowledge_job_result(job_id, delivery_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use osg_application::JobRegistry;
    use osg_domain::{JobKind, JobUpdate};
    use osg_infrastructure::storage::{Database, JobResultDeliveryDraft, JobResultKind};
    use serde_json::json;
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::claim_from_database;

    #[test]
    fn command_claim_is_read_only_and_exact_ack_controls_payload_release() {
        let directory = TempDir::new().expect("temporary directory");
        let database =
            Database::open(directory.path().join("db/osg.sqlite3")).expect("open database");
        let registry = JobRegistry::restore(Arc::new(database.clone())).expect("restore registry");
        let queued = registry.register(JobKind::Translate).expect("register job");
        let job_id = queued.snapshot().id();
        registry.apply(job_id, JobUpdate::Start).expect("start job");
        let draft = JobResultDeliveryDraft::new(
            job_id,
            JobResultKind::GeminiText,
            None,
            None,
            &json!({"schemaVersion": 1, "text": "translated", "usage": null}),
        )
        .expect("delivery");
        let delivery_id = draft.delivery_id();
        registry
            .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                store.complete_job_with_result(sequence, snapshot, &draft)
            })
            .expect("complete atomically");

        let first = claim_from_database(&database, job_id)
            .expect("claim")
            .expect("pending delivery");
        let second = claim_from_database(&database, job_id)
            .expect("repeat claim")
            .expect("payload remains until ack");
        assert_eq!(first.delivery.delivery_id, delivery_id);
        assert_eq!(second.delivery.payload, first.delivery.payload);
        assert!(
            !database
                .acknowledge_job_result(job_id, Uuid::now_v7())
                .expect("forged ack")
        );
        assert!(
            claim_from_database(&database, job_id)
                .expect("claim after forged ack")
                .is_some()
        );
        assert!(
            database
                .acknowledge_job_result(job_id, delivery_id)
                .expect("exact ack")
        );
        assert!(
            claim_from_database(&database, job_id)
                .expect("claim after ack")
                .is_none()
        );
    }
}
