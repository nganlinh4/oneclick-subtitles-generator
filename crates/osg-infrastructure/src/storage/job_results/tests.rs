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
    let database =
        Database::open(directory.path().join("db/osg.sqlite3")).expect("open migrated database");
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
    for index in 0..=MAX_PENDING_JOB_RESULT_DELIVERIES {
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
            |store, sequence, snapshot| store.complete_job_with_result(sequence, snapshot, &asr),
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

    let first_gemini = database
        .list_pending_job_results_by_kind(Some(JobResultKind::GeminiText))
        .expect("first exact Gemini page");
    assert_eq!(first_gemini.len(), MAX_PENDING_JOB_RESULT_DELIVERIES);
    let second_gemini = database
        .list_pending_job_results_by_kind_after(
            Some(JobResultKind::GeminiText),
            Some(first_gemini.last().expect("cursor row").delivery_id),
        )
        .expect("second exact Gemini page");
    assert_eq!(second_gemini.len(), 1);
    assert!(first_gemini.iter().all(|left| {
        second_gemini
            .iter()
            .all(|right| left.delivery_id != right.delivery_id)
    }));
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
