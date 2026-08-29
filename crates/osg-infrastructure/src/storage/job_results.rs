use osg_application::JobWrite;
use osg_domain::{AssetId, JobId, JobKind, JobSnapshot, JobState, ProjectId};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::{Uuid, Variant, Version};

use super::actor::now_ms;
use super::error::DatabaseError;
use super::jobs;

/// Schema version of the bounded payload stored for a recoverable terminal job.
pub(super) const JOB_RESULT_DELIVERY_SCHEMA_VERSION: u32 = 1;
/// Maximum serialized JSON bytes retained for one unacknowledged result.
pub const MAX_JOB_RESULT_DELIVERY_BYTES: usize = 32 * 1024 * 1024;
/// Maximum pending headers returned by one actor request.
pub const MAX_PENDING_JOB_RESULT_DELIVERIES: usize = 256;

type RawDelivery = (
    Uuid,
    Uuid,
    String,
    i64,
    Option<Uuid>,
    Option<Uuid>,
    String,
    i64,
);

/// Closed vocabulary for result payloads whose producer and consumer contracts are independently
/// validated at the desktop command boundary.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobResultKind {
    AsrTranscription,
    GeminiText,
}

impl JobResultKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AsrTranscription => "asrTranscription",
            Self::GeminiText => "geminiText",
        }
    }

    fn from_str(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "asrTranscription" => Ok(Self::AsrTranscription),
            "geminiText" => Ok(Self::GeminiText),
            _ => Err(DatabaseError::InvalidJobResultDelivery),
        }
    }

    const fn accepts_job(self, kind: JobKind) -> bool {
        match self {
            Self::AsrTranscription => matches!(kind, JobKind::Transcribe),
            Self::GeminiText => matches!(
                kind,
                JobKind::Transcribe | JobKind::Translate | JobKind::AnalyzeSubtitles
            ),
        }
    }
}

/// Immutable write prepared by a worker before its job makes the terminal success transition.
#[derive(Clone, Debug)]
pub struct JobResultDeliveryDraft {
    delivery_id: Uuid,
    job_id: JobId,
    kind: JobResultKind,
    project_id: Option<ProjectId>,
    asset_id: Option<AssetId>,
    payload_json: String,
}

impl JobResultDeliveryDraft {
    /// Validates and snapshots an object payload before any transaction begins.
    pub fn new(
        job_id: JobId,
        kind: JobResultKind,
        project_id: Option<ProjectId>,
        asset_id: Option<AssetId>,
        payload: &Value,
    ) -> Result<Self, DatabaseError> {
        if !payload.is_object() {
            return Err(DatabaseError::InvalidJobResultDelivery);
        }
        let payload_json =
            serde_json::to_string(&payload).map_err(|_| DatabaseError::InvalidJobResultDelivery)?;
        if payload_json.len() > MAX_JOB_RESULT_DELIVERY_BYTES {
            return Err(DatabaseError::JobResultDeliveryTooLarge);
        }
        Ok(Self {
            delivery_id: Uuid::now_v7(),
            job_id,
            kind,
            project_id,
            asset_id,
            payload_json,
        })
    }

    /// Opaque acknowledgement identity minted for this exact payload.
    #[must_use]
    pub const fn delivery_id(&self) -> Uuid {
        self.delivery_id
    }
}

/// Bounded identity returned while discovering results that still need a consumer acknowledgement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResultDeliveryHeader {
    pub delivery_id: Uuid,
    pub job_id: JobId,
    pub kind: JobResultKind,
}

/// One unacknowledged recoverable result. The payload remains native-owned until an exact
/// `(job_id, delivery_id)` acknowledgement clears its bytes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResultDelivery {
    pub delivery_id: Uuid,
    pub job_id: JobId,
    pub kind: JobResultKind,
    pub project_id: Option<ProjectId>,
    pub asset_id: Option<AssetId>,
    pub payload: Value,
    pub created_at_ms: u64,
}

pub(super) fn complete_job_with_result(
    connection: &mut Connection,
    expected_sequence: u64,
    snapshot: &JobSnapshot,
    delivery: &JobResultDeliveryDraft,
) -> Result<JobWrite, DatabaseError> {
    if snapshot.id() != delivery.job_id
        || snapshot.state() != JobState::Succeeded
        || !delivery.kind.accepts_job(snapshot.kind())
    {
        return Err(DatabaseError::InvalidJobResultDelivery);
    }
    jobs::compare_and_swap_with(connection, expected_sequence, snapshot, |transaction| {
        insert(transaction, delivery)
    })
}

/// Commits a project-owned result only while the exact project revision and optional durable media
/// ownership are still current. The authorization and result insertion run inside the same
/// `IMMEDIATE` transaction as the terminal job transition, so a concurrent project mutation cannot
/// publish an unowned success between a check and the outbox write.
pub(super) fn complete_project_job_with_result(
    connection: &mut Connection,
    expected_sequence: u64,
    snapshot: &JobSnapshot,
    delivery: &JobResultDeliveryDraft,
    project_id: ProjectId,
    expected_state_version: u64,
    asset_id: Option<AssetId>,
) -> Result<JobWrite, DatabaseError> {
    if delivery.project_id != Some(project_id) || delivery.asset_id != asset_id {
        return Err(DatabaseError::InvalidJobResultDelivery);
    }
    if snapshot.id() != delivery.job_id
        || snapshot.state() != JobState::Succeeded
        || !delivery.kind.accepts_job(snapshot.kind())
    {
        return Err(DatabaseError::InvalidJobResultDelivery);
    }
    jobs::compare_and_swap_with(connection, expected_sequence, snapshot, |transaction| {
        let project = super::projects::load_project(transaction, project_id)?
            .ok_or(DatabaseError::ProjectNotFound(project_id))?;
        if project.state_version() != expected_state_version {
            return Err(DatabaseError::StaleProjectVersion {
                project_id,
                expected: expected_state_version,
                actual: project.state_version(),
            });
        }
        if let Some(asset_id) = asset_id
            && !super::media::project_media_is_current(
                transaction,
                project_id,
                expected_state_version,
                asset_id,
            )?
        {
            return Err(DatabaseError::CrossProjectIdentifier {
                project_id,
                entity: "media asset",
            });
        }
        insert(transaction, delivery)
    })
}

/// Commits a project-owned terminal job transition only while the exact project revision remains
/// current. The revision check and optimistic job transition share one `IMMEDIATE` transaction.
pub(super) fn complete_project_job(
    connection: &mut Connection,
    expected_sequence: u64,
    snapshot: &JobSnapshot,
    project_id: ProjectId,
    expected_state_version: u64,
) -> Result<JobWrite, DatabaseError> {
    jobs::compare_and_swap_with(connection, expected_sequence, snapshot, |transaction| {
        let project = super::projects::load_project(transaction, project_id)?
            .ok_or(DatabaseError::ProjectNotFound(project_id))?;
        if project.state_version() != expected_state_version {
            return Err(DatabaseError::StaleProjectVersion {
                project_id,
                expected: expected_state_version,
                actual: project.state_version(),
            });
        }
        Ok(())
    })
}

fn insert(
    transaction: &Transaction<'_>,
    delivery: &JobResultDeliveryDraft,
) -> Result<(), DatabaseError> {
    let timestamp = now_ms();
    let changed = transaction.execute(
        "INSERT INTO job_result_deliveries(
           job_id, delivery_id, kind, schema_version, project_id, asset_id,
           payload_json, created_at_ms, acknowledged_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
         ON CONFLICT(job_id) DO NOTHING",
        params![
            delivery.job_id.as_uuid(),
            delivery.delivery_id,
            delivery.kind.as_str(),
            JOB_RESULT_DELIVERY_SCHEMA_VERSION,
            delivery.project_id.map(ProjectId::into_uuid),
            delivery.asset_id.map(AssetId::into_uuid),
            &delivery.payload_json,
            timestamp,
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::JobResultDeliveryConflict(delivery.job_id));
    }
    Ok(())
}

pub(super) fn list_pending(
    connection: &Connection,
    kind: Option<JobResultKind>,
) -> Result<Vec<JobResultDeliveryHeader>, DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT delivery_id, job_id, kind
         FROM job_result_deliveries
         WHERE acknowledged_at_ms IS NULL
           AND (?1 IS NULL OR kind = ?1)
         ORDER BY created_at_ms, job_id
         LIMIT ?2",
    )?;
    let limit = i64::try_from(MAX_PENDING_JOB_RESULT_DELIVERIES)
        .expect("pending delivery limit fits SQLite");
    let rows = statement.query_map(params![kind.map(JobResultKind::as_str), limit], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, Uuid>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut deliveries = Vec::new();
    for row in rows {
        let (delivery_id, job_id, kind) = row?;
        deliveries.push(JobResultDeliveryHeader {
            delivery_id: require_v7(delivery_id)?,
            job_id: JobId::from_uuid(job_id)
                .map_err(|_| DatabaseError::InvalidJobResultDelivery)?,
            kind: JobResultKind::from_str(&kind)?,
        });
    }
    Ok(deliveries)
}

pub(super) fn claim(
    connection: &Connection,
    job_id: JobId,
) -> Result<Option<JobResultDelivery>, DatabaseError> {
    let raw = connection
        .query_row(
            "SELECT delivery_id, job_id, kind, schema_version, project_id, asset_id,
                    payload_json, created_at_ms
             FROM job_result_deliveries
             WHERE job_id = ?1 AND acknowledged_at_ms IS NULL",
            [job_id.as_uuid()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()?;
    raw.map(decode).transpose()
}

fn decode(
    (delivery_id, job_id, kind, schema_version, project_id, asset_id, payload_json, created_at_ms): RawDelivery,
) -> Result<JobResultDelivery, DatabaseError> {
    if schema_version != i64::from(JOB_RESULT_DELIVERY_SCHEMA_VERSION)
        || payload_json.len() > MAX_JOB_RESULT_DELIVERY_BYTES
        || created_at_ms < 0
    {
        return Err(DatabaseError::InvalidJobResultDelivery);
    }
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|_| DatabaseError::InvalidJobResultDelivery)?;
    if !payload.is_object() {
        return Err(DatabaseError::InvalidJobResultDelivery);
    }
    Ok(JobResultDelivery {
        delivery_id: require_v7(delivery_id)?,
        job_id: JobId::from_uuid(job_id).map_err(|_| DatabaseError::InvalidJobResultDelivery)?,
        kind: JobResultKind::from_str(&kind)?,
        project_id: project_id
            .map(ProjectId::from_uuid)
            .transpose()
            .map_err(|_| DatabaseError::InvalidJobResultDelivery)?,
        asset_id: asset_id
            .map(AssetId::from_uuid)
            .transpose()
            .map_err(|_| DatabaseError::InvalidJobResultDelivery)?,
        payload,
        created_at_ms: u64::try_from(created_at_ms)
            .map_err(|_| DatabaseError::InvalidJobResultDelivery)?,
    })
}

pub(super) fn acknowledge(
    connection: &mut Connection,
    job_id: JobId,
    delivery_id: Uuid,
) -> Result<bool, DatabaseError> {
    let delivery_id = require_v7(delivery_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = transaction
        .query_row(
            "SELECT state FROM jobs WHERE id = ?1",
            [job_id.as_uuid()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if state.as_deref() != Some("succeeded") {
        return Ok(false);
    }
    let matching = transaction
        .query_row(
            "SELECT acknowledged_at_ms FROM job_result_deliveries
             WHERE job_id = ?1 AND delivery_id = ?2",
            params![job_id.as_uuid(), delivery_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?;
    let Some(acknowledged_at_ms) = matching else {
        return Ok(false);
    };
    if acknowledged_at_ms.is_none() {
        let changed = transaction.execute(
            "UPDATE job_result_deliveries
             SET payload_json = NULL, acknowledged_at_ms = MAX(created_at_ms, ?3)
             WHERE job_id = ?1 AND delivery_id = ?2 AND acknowledged_at_ms IS NULL",
            params![job_id.as_uuid(), delivery_id, now_ms()],
        )?;
        if changed != 1 {
            return Err(DatabaseError::InvalidJobResultDelivery);
        }
    }
    transaction.commit()?;
    Ok(true)
}

fn require_v7(value: Uuid) -> Result<Uuid, DatabaseError> {
    if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122 {
        Ok(value)
    } else {
        Err(DatabaseError::InvalidJobResultDelivery)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use osg_application::JobRegistry;
    use osg_domain::{AssetId, JobKind, JobState, JobUpdate};
    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{JobResultDeliveryDraft, JobResultKind, MAX_PENDING_JOB_RESULT_DELIVERIES};
    use crate::storage::Database;

    fn database() -> (TempDir, Database) {
        let directory = TempDir::new().expect("temporary directory");
        let database = Database::open(directory.path().join("db/osg.sqlite3"))
            .expect("open migrated database");
        (directory, database)
    }

    fn running_transcription(database: &Database) -> (JobRegistry<Database>, osg_domain::JobId) {
        let registry =
            JobRegistry::restore(Arc::new(database.clone())).expect("restore empty registry");
        let queued = registry
            .register(JobKind::Transcribe)
            .expect("register transcription");
        let id = queued.snapshot().id();
        registry.apply(id, JobUpdate::Start).expect("start job");
        (registry, id)
    }

    #[test]
    fn terminal_success_and_result_survive_reopen_until_exact_acknowledgement() {
        let (directory, database) = database();
        let database_path = directory.path().join("db/osg.sqlite3");
        let (registry, job_id) = running_transcription(&database);
        let draft = JobResultDeliveryDraft::new(
            job_id,
            JobResultKind::AsrTranscription,
            None,
            None,
            &json!({"schemaVersion": 1, "transcription": {"segments": []}, "timelineOffsetMs": 0}),
        )
        .expect("valid delivery");
        let delivery_id = draft.delivery_id();

        let ticket = registry
            .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                store.complete_job_with_result(sequence, snapshot, &draft)
            })
            .expect("atomically complete job");
        assert_eq!(ticket.snapshot().state(), JobState::Succeeded);
        drop(registry);
        drop(database);

        let reopened = Database::open(database_path).expect("reopen database");
        assert_eq!(
            reopened
                .list_pending_job_results()
                .expect("list pending")
                .len(),
            1
        );
        let claimed = reopened
            .claim_job_result(job_id)
            .expect("claim result")
            .expect("pending result");
        assert_eq!(claimed.delivery_id, delivery_id);
        assert_eq!(claimed.payload["schemaVersion"], 1);

        assert!(
            !reopened
                .acknowledge_job_result(job_id, Uuid::now_v7())
                .expect("reject forged acknowledgement")
        );
        assert!(
            reopened
                .claim_job_result(job_id)
                .expect("claim after forged acknowledgement")
                .is_some()
        );
        assert!(
            reopened
                .acknowledge_job_result(job_id, delivery_id)
                .expect("acknowledge exact result")
        );
        assert!(
            reopened
                .acknowledge_job_result(job_id, delivery_id)
                .expect("repeat exact acknowledgement")
        );
        assert!(
            reopened
                .claim_job_result(job_id)
                .expect("claim acknowledged result")
                .is_none()
        );
    }

    #[test]
    fn exact_kind_filter_finds_asr_behind_a_full_older_gemini_page() {
        let (_directory, database) = database();
        let registry =
            JobRegistry::restore(Arc::new(database.clone())).expect("restore empty registry");
        for index in 0..MAX_PENDING_JOB_RESULT_DELIVERIES {
            let queued = registry
                .register(JobKind::Translate)
                .expect("register Gemini text job");
            let job_id = queued.snapshot().id();
            registry
                .apply(job_id, JobUpdate::Start)
                .expect("start Gemini job");
            let draft = JobResultDeliveryDraft::new(
                job_id,
                JobResultKind::GeminiText,
                None,
                None,
                &json!({"schemaVersion": 1, "text": format!("older {index}"), "usage": null}),
            )
            .expect("valid Gemini delivery");
            registry
                .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                    store.complete_job_with_result(sequence, snapshot, &draft)
                })
                .expect("complete Gemini job");
        }
        let queued = registry
            .register(JobKind::Transcribe)
            .expect("register local ASR job");
        let asr_job_id = queued.snapshot().id();
        registry
            .apply(asr_job_id, JobUpdate::Start)
            .expect("start local ASR job");
        let asr = JobResultDeliveryDraft::new(
            asr_job_id,
            JobResultKind::AsrTranscription,
            None,
            None,
            &json!({"schemaVersion": 1, "transcription": {"segments": []}, "timelineOffsetMs": 0}),
        )
        .expect("valid ASR delivery");
        registry
            .apply_with_store(
                asr_job_id,
                JobUpdate::Succeed,
                |store, sequence, snapshot| {
                    store.complete_job_with_result(sequence, snapshot, &asr)
                },
            )
            .expect("complete local ASR job");

        let unfiltered = database
            .list_pending_job_results()
            .expect("list bounded unfiltered page");
        assert_eq!(unfiltered.len(), MAX_PENDING_JOB_RESULT_DELIVERIES);
        assert!(
            unfiltered
                .iter()
                .all(|header| header.kind == JobResultKind::GeminiText)
        );
        let filtered = database
            .list_pending_job_results_by_kind(Some(JobResultKind::AsrTranscription))
            .expect("list exact ASR kind");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].job_id, asr_job_id);
        assert_eq!(filtered[0].kind, JobResultKind::AsrTranscription);
    }

    #[test]
    fn failed_result_insert_rolls_back_terminal_job_transition() {
        let (_directory, database) = database();
        let (registry, job_id) = running_transcription(&database);
        let missing_asset = AssetId::new();
        let draft = JobResultDeliveryDraft::new(
            job_id,
            JobResultKind::AsrTranscription,
            None,
            Some(missing_asset),
            &json!({"schemaVersion": 1}),
        )
        .expect("valid in-memory delivery");

        assert!(
            registry
                .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                    store.complete_job_with_result(sequence, snapshot, &draft)
                })
                .is_err()
        );
        assert_eq!(
            registry
                .get(job_id)
                .expect("resident job")
                .snapshot()
                .state(),
            JobState::Running
        );
        assert_eq!(
            database
                .get_job(job_id)
                .expect("durable job")
                .expect("job row")
                .state(),
            JobState::Running
        );
        assert!(
            database
                .claim_job_result(job_id)
                .expect("claim result")
                .is_none()
        );
    }

    #[test]
    fn result_kind_must_match_the_terminal_job_kind() {
        let (_directory, database) = database();
        let registry =
            JobRegistry::restore(Arc::new(database.clone())).expect("restore empty registry");
        let ticket = registry
            .register(JobKind::RenderVideo)
            .expect("register render job");
        let job_id = ticket.snapshot().id();
        registry.apply(job_id, JobUpdate::Start).expect("start job");
        let draft = JobResultDeliveryDraft::new(
            job_id,
            JobResultKind::GeminiText,
            None,
            None,
            &json!({"schemaVersion": 1, "text": "not a render result", "usage": null}),
        )
        .expect("valid in-memory delivery");

        assert!(
            registry
                .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                    store.complete_job_with_result(sequence, snapshot, &draft)
                })
                .is_err()
        );
        assert_eq!(
            database
                .get_job(job_id)
                .expect("durable job")
                .expect("job row")
                .state(),
            JobState::Running
        );
    }

    #[test]
    fn acknowledgement_survives_a_system_clock_rollback() {
        const FUTURE_TIMESTAMP_MS: i64 = 9_000_000_000_000_000;

        let (directory, database) = database();
        let database_path = directory.path().join("db/osg.sqlite3");
        let (registry, job_id) = running_transcription(&database);
        let draft = JobResultDeliveryDraft::new(
            job_id,
            JobResultKind::AsrTranscription,
            None,
            None,
            &json!({"schemaVersion": 1, "transcription": {"segments": []}, "timelineOffsetMs": 0}),
        )
        .expect("valid delivery");
        let delivery_id = draft.delivery_id();
        registry
            .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                store.complete_job_with_result(sequence, snapshot, &draft)
            })
            .expect("complete atomically");

        // A user can move the system clock backwards after a result is created. Reproduce the
        // equivalent durable state without changing the host clock: the row was created in a
        // future epoch relative to the acknowledgement call. The schema requires acknowledgements
        // to remain monotonic, so blindly writing `now_ms()` would reject the exact acknowledgement
        // and retain a 32 MiB payload forever.
        let connection = Connection::open(database_path).expect("open inspection connection");
        connection
            .execute(
                "UPDATE job_result_deliveries SET created_at_ms = ?1 WHERE job_id = ?2",
                rusqlite::params![FUTURE_TIMESTAMP_MS, job_id.as_uuid()],
            )
            .expect("stage clock rollback state");

        assert!(
            database
                .acknowledge_job_result(job_id, delivery_id)
                .expect("acknowledge despite clock rollback")
        );
        let (payload, acknowledged): (Option<String>, i64) = connection
            .query_row(
                "SELECT payload_json, acknowledged_at_ms FROM job_result_deliveries WHERE job_id = ?1",
                [job_id.as_uuid()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read acknowledgement tombstone");
        assert!(payload.is_none());
        assert_eq!(acknowledged, FUTURE_TIMESTAMP_MS);
    }
}
