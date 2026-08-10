use osg_application::{JobWrite, RESIDENT_TERMINAL_JOB_LIMIT};
use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::actor::now_ms;
use super::error::DatabaseError;

type RawJob = (Uuid, String, String, i64, Vec<u8>);

pub(super) fn create(connection: &Connection, snapshot: &JobSnapshot) -> Result<(), DatabaseError> {
    if snapshot.state() != JobState::Queued
        || snapshot.progress() != JobProgress::ZERO
        || snapshot.sequence() != 0
    {
        return Err(DatabaseError::InvalidNewJob(snapshot.id()));
    }
    let timestamp = now_ms();
    let sequence = encode_sequence(snapshot.sequence());
    let changed = connection.execute(
        "INSERT INTO jobs(
           id, kind, state, sequence, progress_basis_points, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO NOTHING",
        params![
            snapshot.id().as_uuid(),
            kind_as_str(snapshot.kind()),
            state_as_str(snapshot.state()),
            sequence.as_slice(),
            snapshot.progress().basis_points(),
            timestamp,
        ],
    )?;
    if changed == 0 {
        return Err(DatabaseError::JobAlreadyExists(snapshot.id()));
    }
    Ok(())
}

pub(super) fn get(
    connection: &Connection,
    id: JobId,
) -> Result<Option<JobSnapshot>, DatabaseError> {
    get_from(connection, id)
}

pub(super) fn list(connection: &Connection) -> Result<Vec<JobSnapshot>, DatabaseError> {
    list_for_restore_from(connection)
}

pub(super) fn compare_and_swap(
    connection: &mut Connection,
    expected_sequence: u64,
    snapshot: &JobSnapshot,
) -> Result<JobWrite, DatabaseError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current =
        get_from(&transaction, snapshot.id())?.ok_or(DatabaseError::JobNotFound(snapshot.id()))?;
    if current.sequence() != expected_sequence {
        return Ok(JobWrite::Conflict(current));
    }
    validate_successor(&current, snapshot)?;
    let changed = update_snapshot(&transaction, expected_sequence, snapshot, now_ms())?;
    if changed != 1 {
        let actual = get_from(&transaction, snapshot.id())?
            .ok_or(DatabaseError::JobNotFound(snapshot.id()))?;
        return Ok(JobWrite::Conflict(actual));
    }
    transaction.commit()?;
    Ok(JobWrite::Updated)
}

/// Converts jobs which owned process-local work into a durable terminal state.
///
/// The caller owns the startup transaction, so application metadata and every
/// recovered job either commit together or remain untouched.
pub(super) fn interrupt_in_flight(
    transaction: &Transaction<'_>,
    timestamp: i64,
) -> Result<(), DatabaseError> {
    validate_all_from(transaction)?;
    let jobs = {
        let mut statement = transaction.prepare(
            "SELECT id, kind, state, progress_basis_points, sequence
             FROM jobs WHERE state IN ('running', 'cancelling') ORDER BY created_at_ms, id",
        )?;
        let rows = statement.query_map([], raw_job)?;
        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(decode_job(row?)?);
        }
        jobs
    };
    for current in jobs {
        let mut interrupted = current.clone();
        interrupted
            .apply(JobUpdate::Interrupt)
            .map_err(|_| DatabaseError::JobSequenceExhausted(current.id()))?;
        let changed = update_snapshot(transaction, current.sequence(), &interrupted, timestamp)?;
        if changed != 1 {
            return Err(DatabaseError::ConcurrentJobRecovery(current.id()));
        }
    }
    Ok(())
}

fn validate_all_from(connection: &Connection) -> Result<(), DatabaseError> {
    // Stream every row once so old corruption still fails startup without retaining historical
    // snapshots in a temporary vector or in the process-long registry working set.
    let mut statement =
        connection.prepare("SELECT id, kind, state, progress_basis_points, sequence FROM jobs")?;
    let rows = statement.query_map([], raw_job)?;
    for row in rows {
        decode_job(row?)?;
    }
    Ok(())
}

fn get_from(connection: &Connection, id: JobId) -> Result<Option<JobSnapshot>, DatabaseError> {
    let raw = connection
        .query_row(
            "SELECT id, kind, state, progress_basis_points, sequence
             FROM jobs WHERE id = ?1",
            [id.as_uuid()],
            raw_job,
        )
        .optional()?;
    raw.map(decode_job).transpose()
}

fn list_for_restore_from(connection: &Connection) -> Result<Vec<JobSnapshot>, DatabaseError> {
    let mut active_statement = connection.prepare(
        "SELECT id, kind, state, progress_basis_points, sequence
         FROM jobs
         WHERE state IN ('queued', 'running', 'cancelling')
         ORDER BY created_at_ms, id",
    )?;
    let active_rows = active_statement.query_map([], raw_job)?;
    let mut jobs = Vec::new();
    for row in active_rows {
        jobs.push(decode_job(row?)?);
    }

    let mut terminal_statement = connection.prepare(
        "SELECT id, kind, state, progress_basis_points, sequence
         FROM jobs
         WHERE state IN ('succeeded', 'failed', 'cancelled', 'interrupted')
         ORDER BY updated_at_ms DESC, id DESC
         LIMIT ?1",
    )?;
    let terminal_limit =
        i64::try_from(RESIDENT_TERMINAL_JOB_LIMIT).expect("terminal job restore limit fits SQLite");
    let terminal_rows = terminal_statement.query_map([terminal_limit], raw_job)?;
    for row in terminal_rows {
        jobs.push(decode_job(row?)?);
    }
    jobs.sort_unstable_by_key(JobSnapshot::id);
    Ok(jobs)
}

fn raw_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawJob> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn decode_job((id, kind, state, progress, sequence): RawJob) -> Result<JobSnapshot, DatabaseError> {
    let id = JobId::from_uuid(id).map_err(|_| DatabaseError::InvalidJobMetadata)?;
    let kind = parse_kind(&kind).ok_or(DatabaseError::InvalidJobMetadata)?;
    let state = parse_state(&state).ok_or(DatabaseError::InvalidJobMetadata)?;
    let progress = u16::try_from(progress)
        .ok()
        .and_then(|value| JobProgress::from_basis_points(value).ok())
        .ok_or(DatabaseError::InvalidJobMetadata)?;
    let sequence = decode_sequence(&sequence).ok_or(DatabaseError::InvalidJobMetadata)?;
    JobSnapshot::restore(id, kind, state, progress, sequence)
        .map_err(|_| DatabaseError::InvalidJobMetadata)
}

fn update_snapshot(
    connection: &Connection,
    expected_sequence: u64,
    snapshot: &JobSnapshot,
    timestamp: i64,
) -> Result<usize, DatabaseError> {
    let expected = encode_sequence(expected_sequence);
    let next = encode_sequence(snapshot.sequence());
    connection
        .execute(
            "UPDATE jobs
             SET state = ?1, sequence = ?2, progress_basis_points = ?3,
                 updated_at_ms = MAX(updated_at_ms, ?4)
             WHERE id = ?5 AND sequence = ?6 AND kind = ?7",
            params![
                state_as_str(snapshot.state()),
                next.as_slice(),
                snapshot.progress().basis_points(),
                timestamp,
                snapshot.id().as_uuid(),
                expected.as_slice(),
                kind_as_str(snapshot.kind()),
            ],
        )
        .map_err(Into::into)
}

fn validate_successor(current: &JobSnapshot, candidate: &JobSnapshot) -> Result<(), DatabaseError> {
    if current.id() != candidate.id() || current.kind() != candidate.kind() {
        return Err(DatabaseError::InvalidJobSuccessor(current.id()));
    }
    let Some(next_sequence) = current.sequence().checked_add(1) else {
        return Err(DatabaseError::JobSequenceExhausted(current.id()));
    };
    if candidate.sequence() != next_sequence {
        return Err(DatabaseError::InvalidJobSuccessor(current.id()));
    }

    let fixed_updates = [
        JobUpdate::Start,
        JobUpdate::Succeed,
        JobUpdate::Fail,
        JobUpdate::RequestCancellation,
        JobUpdate::ConfirmCancelled,
        JobUpdate::Interrupt,
        JobUpdate::Requeue,
    ];
    if fixed_updates
        .into_iter()
        .any(|update| applying(current, update).as_ref() == Some(candidate))
        || applying(current, JobUpdate::ReportProgress(candidate.progress())).as_ref()
            == Some(candidate)
    {
        Ok(())
    } else {
        Err(DatabaseError::InvalidJobSuccessor(current.id()))
    }
}

fn applying(snapshot: &JobSnapshot, update: JobUpdate) -> Option<JobSnapshot> {
    let mut candidate = snapshot.clone();
    candidate.apply(update).ok()?;
    Some(candidate)
}

const fn encode_sequence(sequence: u64) -> [u8; 8] {
    sequence.to_be_bytes()
}

fn decode_sequence(value: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(value.try_into().ok()?))
}

const fn kind_as_str(kind: JobKind) -> &'static str {
    match kind {
        JobKind::ImportMedia => "importMedia",
        JobKind::ProbeMedia => "probeMedia",
        JobKind::GenerateWaveform => "generateWaveform",
        JobKind::DownloadMedia => "downloadMedia",
        JobKind::ExportMedia => "exportMedia",
        JobKind::Transcribe => "transcribe",
        JobKind::Translate => "translate",
        JobKind::AnalyzeSubtitles => "analyzeSubtitles",
        JobKind::GenerateImage => "generateImage",
        JobKind::SynthesizeNarration => "synthesizeNarration",
        JobKind::AlignNarration => "alignNarration",
        JobKind::RenderVideo => "renderVideo",
        JobKind::InstallEngine => "installEngine",
    }
}

fn parse_kind(value: &str) -> Option<JobKind> {
    match value {
        "importMedia" => Some(JobKind::ImportMedia),
        "probeMedia" => Some(JobKind::ProbeMedia),
        "generateWaveform" => Some(JobKind::GenerateWaveform),
        "downloadMedia" => Some(JobKind::DownloadMedia),
        "exportMedia" => Some(JobKind::ExportMedia),
        "transcribe" => Some(JobKind::Transcribe),
        "translate" => Some(JobKind::Translate),
        "analyzeSubtitles" => Some(JobKind::AnalyzeSubtitles),
        "generateImage" => Some(JobKind::GenerateImage),
        "synthesizeNarration" => Some(JobKind::SynthesizeNarration),
        "alignNarration" => Some(JobKind::AlignNarration),
        "renderVideo" => Some(JobKind::RenderVideo),
        "installEngine" => Some(JobKind::InstallEngine),
        _ => None,
    }
}

const fn state_as_str(state: JobState) -> &'static str {
    match state {
        JobState::Queued => "queued",
        JobState::Running => "running",
        JobState::Cancelling => "cancelling",
        JobState::Succeeded => "succeeded",
        JobState::Failed => "failed",
        JobState::Cancelled => "cancelled",
        JobState::Interrupted => "interrupted",
    }
}

fn parse_state(value: &str) -> Option<JobState> {
    match value {
        "queued" => Some(JobState::Queued),
        "running" => Some(JobState::Running),
        "cancelling" => Some(JobState::Cancelling),
        "succeeded" => Some(JobState::Succeeded),
        "failed" => Some(JobState::Failed),
        "cancelled" => Some(JobState::Cancelled),
        "interrupted" => Some(JobState::Interrupted),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use osg_application::{JobRegistry, JobStore, JobWrite, RESIDENT_TERMINAL_JOB_LIMIT};
    use osg_domain::{JobId, JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
    use rusqlite::params;
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::encode_sequence;
    use crate::storage::{Database, DatabaseError};

    fn database() -> (TempDir, Database) {
        let directory = TempDir::new().expect("temporary directory");
        let database = Database::open(directory.path().join("db/osg.sqlite3"))
            .expect("open migrated database");
        (directory, database)
    }

    fn apply(database: &Database, snapshot: &mut JobSnapshot, update: JobUpdate) {
        let expected = snapshot.sequence();
        snapshot.apply(update).expect("valid job transition");
        assert_eq!(
            database
                .compare_and_swap_job(expected, snapshot)
                .expect("persist transition"),
            JobWrite::Updated
        );
    }

    #[test]
    fn every_kind_and_canonical_snapshot_field_round_trips() {
        let (directory, database) = database();
        let kinds = [
            JobKind::ImportMedia,
            JobKind::ProbeMedia,
            JobKind::GenerateWaveform,
            JobKind::DownloadMedia,
            JobKind::ExportMedia,
            JobKind::Transcribe,
            JobKind::Translate,
            JobKind::AnalyzeSubtitles,
            JobKind::GenerateImage,
            JobKind::SynthesizeNarration,
            JobKind::AlignNarration,
            JobKind::RenderVideo,
            JobKind::InstallEngine,
        ];
        for kind in kinds {
            database
                .create_job(&JobSnapshot::new(kind))
                .expect("persist job kind");
        }

        let mut detailed = JobSnapshot::new(JobKind::Transcribe);
        database
            .create_job(&detailed)
            .expect("persist detailed job");
        apply(&database, &mut detailed, JobUpdate::Start);
        apply(
            &database,
            &mut detailed,
            JobUpdate::ReportProgress(
                JobProgress::from_basis_points(4_321).expect("bounded progress"),
            ),
        );
        apply(&database, &mut detailed, JobUpdate::Fail);

        assert_eq!(
            database.get_job(detailed.id()).expect("get job"),
            Some(detailed.clone())
        );
        assert_eq!(
            database.list_jobs().expect("list jobs").len(),
            kinds.len() + 1
        );
        drop(database);

        let reopened =
            Database::open(directory.path().join("db/osg.sqlite3")).expect("reopen database");
        assert_eq!(
            reopened.get_job(detailed.id()).expect("get reopened job"),
            Some(detailed)
        );
    }

    #[test]
    fn database_implements_the_restore_and_exposure_contract() {
        let (_directory, database) = database();
        let first = JobSnapshot::new(JobKind::GenerateWaveform);
        let second = JobSnapshot::new(JobKind::RenderVideo);
        JobStore::create(&database, &first).expect("create through port");
        JobStore::create(&database, &second).expect("create through port");

        assert_eq!(
            JobStore::get(&database, first.id()).expect("get through port"),
            Some(first)
        );
        let registry = JobRegistry::restore(Arc::new(database)).expect("restore registry");
        let tickets = registry.list().expect("list restored jobs");
        assert_eq!(tickets.len(), 2);
        assert!(
            tickets
                .windows(2)
                .all(|pair| { pair[0].snapshot().id() < pair[1].snapshot().id() })
        );
    }

    #[test]
    fn restore_working_set_bounds_terminal_history_without_deleting_it() {
        let (_directory, database) = database();
        let mut oldest = None;
        for index in 0..(RESIDENT_TERMINAL_JOB_LIMIT + 17) {
            let mut terminal = JobSnapshot::new(JobKind::RenderVideo);
            database.create_job(&terminal).expect("create terminal job");
            apply(&database, &mut terminal, JobUpdate::Start);
            apply(&database, &mut terminal, JobUpdate::Succeed);
            if index == 0 {
                oldest = Some(terminal);
            }
        }
        let queued = JobSnapshot::new(JobKind::SynthesizeNarration);
        database.create_job(&queued).expect("create active job");
        let oldest = oldest.expect("oldest terminal job");

        let restored = database.list_jobs().expect("bounded restore set");
        assert_eq!(restored.len(), RESIDENT_TERMINAL_JOB_LIMIT + 1);
        assert!(restored.iter().any(|job| job.id() == queued.id()));
        assert!(!restored.iter().any(|job| job.id() == oldest.id()));
        assert_eq!(
            database.get_job(oldest.id()).expect("direct old lookup"),
            Some(oldest.clone())
        );

        let registry = JobRegistry::restore(Arc::new(database)).expect("restore registry");
        assert_eq!(
            registry.list().expect("bounded resident jobs").len(),
            RESIDENT_TERMINAL_JOB_LIMIT + 1
        );
        assert_eq!(
            registry
                .get(oldest.id())
                .expect("lazy old lookup")
                .snapshot(),
            &oldest
        );
        assert_eq!(
            registry.list().expect("lazy job becomes resident").len(),
            RESIDENT_TERMINAL_JOB_LIMIT + 1
        );
    }

    #[test]
    fn duplicate_creation_and_invalid_successors_are_rejected() {
        let (_directory, database) = database();
        let queued = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&queued).expect("create job");

        assert!(matches!(
            database.create_job(&queued),
            Err(DatabaseError::JobAlreadyExists(id)) if id == queued.id()
        ));

        let skipped = JobSnapshot::restore(
            queued.id(),
            queued.kind(),
            JobState::Succeeded,
            JobProgress::COMPLETE,
            2,
        )
        .expect("individually valid snapshot");
        assert!(matches!(
            database.compare_and_swap_job(0, &skipped),
            Err(DatabaseError::InvalidJobSuccessor(id)) if id == queued.id()
        ));

        let mut not_new = queued.clone();
        not_new.start().expect("start fixture");
        assert!(matches!(
            database.create_job(&not_new),
            Err(DatabaseError::InvalidNewJob(id)) if id == queued.id()
        ));
    }

    #[test]
    fn stale_writers_receive_the_valid_current_snapshot() {
        let (_directory, database) = database();
        let mut current = JobSnapshot::new(JobKind::Translate);
        database.create_job(&current).expect("create job");
        let stale = current.clone();
        apply(&database, &mut current, JobUpdate::Start);

        let mut stale_candidate = stale;
        stale_candidate.fail().expect("valid from stale view");
        assert_eq!(
            database
                .compare_and_swap_job(0, &stale_candidate)
                .expect("return conflict"),
            JobWrite::Conflict(current)
        );
    }

    #[test]
    fn terminal_and_cancellation_writers_race_atomically() {
        let (_directory, database) = database();
        let mut running = JobSnapshot::new(JobKind::RenderVideo);
        database.create_job(&running).expect("create job");
        apply(&database, &mut running, JobUpdate::Start);

        let mut succeeded = running.clone();
        succeeded.succeed().expect("success candidate");
        let mut cancelling = running.clone();
        cancelling
            .request_cancellation()
            .expect("cancellation candidate");
        let barrier = Arc::new(Barrier::new(3));
        let first_database = database.clone();
        let first_barrier = Arc::clone(&barrier);
        let first = thread::spawn(move || {
            first_barrier.wait();
            first_database.compare_and_swap_job(1, &succeeded)
        });
        let second_database = database.clone();
        let second_barrier = Arc::clone(&barrier);
        let second = thread::spawn(move || {
            second_barrier.wait();
            second_database.compare_and_swap_job(1, &cancelling)
        });
        barrier.wait();

        let results = [
            first
                .join()
                .expect("success writer thread")
                .expect("success writer"),
            second
                .join()
                .expect("cancellation writer thread")
                .expect("cancellation writer"),
        ];
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, JobWrite::Updated))
                .count(),
            1
        );
        let conflict = results
            .iter()
            .find_map(|result| match result {
                JobWrite::Conflict(snapshot) => Some(snapshot),
                JobWrite::Updated => None,
            })
            .expect("one writer conflicts");
        assert_eq!(
            database
                .get_job(running.id())
                .expect("load winner")
                .as_ref(),
            Some(conflict)
        );
        assert!(matches!(
            conflict.state(),
            JobState::Succeeded | JobState::Cancelling
        ));
    }

    #[test]
    fn restart_interrupts_only_in_flight_jobs_and_increments_sequence() {
        let (directory, database) = database();
        let queued = JobSnapshot::new(JobKind::ImportMedia);
        database.create_job(&queued).expect("create queued job");

        let mut running = JobSnapshot::new(JobKind::Transcribe);
        database.create_job(&running).expect("create running job");
        apply(&database, &mut running, JobUpdate::Start);
        apply(
            &database,
            &mut running,
            JobUpdate::ReportProgress(
                JobProgress::from_basis_points(2_500).expect("bounded progress"),
            ),
        );

        let mut cancelling = JobSnapshot::new(JobKind::DownloadMedia);
        database
            .create_job(&cancelling)
            .expect("create cancelling job");
        apply(&database, &mut cancelling, JobUpdate::Start);
        apply(&database, &mut cancelling, JobUpdate::RequestCancellation);

        let mut succeeded = JobSnapshot::new(JobKind::GenerateImage);
        database
            .create_job(&succeeded)
            .expect("create terminal job");
        apply(&database, &mut succeeded, JobUpdate::Start);
        apply(&database, &mut succeeded, JobUpdate::Succeed);
        drop(database);

        let reopened = Database::open(directory.path().join("db/osg.sqlite3"))
            .expect("recover jobs on restart");
        let recovered_running = reopened
            .get_job(running.id())
            .expect("load running job")
            .expect("running job exists");
        assert_eq!(recovered_running.state(), JobState::Interrupted);
        assert_eq!(recovered_running.sequence(), running.sequence() + 1);
        assert_eq!(recovered_running.progress(), running.progress());
        let recovered_cancelling = reopened
            .get_job(cancelling.id())
            .expect("load cancelling job")
            .expect("cancelling job exists");
        assert_eq!(recovered_cancelling.state(), JobState::Interrupted);
        assert_eq!(recovered_cancelling.sequence(), cancelling.sequence() + 1);
        assert_eq!(
            reopened.get_job(queued.id()).expect("load queued"),
            Some(queued)
        );
        assert_eq!(
            reopened.get_job(succeeded.id()).expect("load succeeded"),
            Some(succeeded)
        );
    }

    #[test]
    fn corrupt_rows_are_rejected_during_startup_validation() {
        for corrupt_id in [false, true] {
            let directory = TempDir::new().expect("temporary directory");
            let path = directory.path().join("db/osg.sqlite3");
            let database = Database::open(&path).expect("initialize schema");
            drop(database);
            let connection = rusqlite::Connection::open(&path).expect("open raw database");
            let id = if corrupt_id {
                Uuid::new_v4()
            } else {
                Uuid::now_v7()
            };
            let sequence = encode_sequence(0);
            connection
                .execute(
                    "INSERT INTO jobs(
                       id, kind, state, sequence, progress_basis_points,
                       created_at_ms, updated_at_ms
                     ) VALUES (?1, 'transcribe', 'queued', ?2, ?3, 1, 1)",
                    params![id, sequence.as_slice(), i64::from(!corrupt_id)],
                )
                .expect("inject structurally valid corrupt row");
            drop(connection);

            assert!(matches!(
                Database::open(path),
                Err(DatabaseError::InvalidJobMetadata)
            ));
        }
    }

    #[test]
    fn restart_refuses_to_wrap_an_exhausted_sequence() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("db/osg.sqlite3");
        let database = Database::open(&path).expect("initialize schema");
        drop(database);
        let id = JobId::new();
        let recoverable_id = JobId::new();
        let connection = rusqlite::Connection::open(&path).expect("open raw database");
        let recoverable_sequence = encode_sequence(1);
        connection
            .execute(
                "INSERT INTO jobs(
                   id, kind, state, sequence, progress_basis_points,
                   created_at_ms, updated_at_ms
                 ) VALUES (?1, 'transcribe', 'running', ?2, 1, 1, 1)",
                params![recoverable_id.as_uuid(), recoverable_sequence.as_slice()],
            )
            .expect("inject recoverable running job");
        let sequence = encode_sequence(u64::MAX);
        connection
            .execute(
                "INSERT INTO jobs(
                   id, kind, state, sequence, progress_basis_points,
                   created_at_ms, updated_at_ms
                 ) VALUES (?1, 'installEngine', 'running', ?2, 1, 2, 2)",
                params![id.as_uuid(), sequence.as_slice()],
            )
            .expect("inject exhausted running job");
        drop(connection);

        assert!(matches!(
            Database::open(&path),
            Err(DatabaseError::JobSequenceExhausted(found)) if found == id
        ));
        let connection = rusqlite::Connection::open(path).expect("inspect rolled-back recovery");
        let (state, stored_sequence): (String, Vec<u8>) = connection
            .query_row(
                "SELECT state, sequence FROM jobs WHERE id = ?1",
                [recoverable_id.as_uuid()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read recoverable job");
        assert_eq!(state, "running");
        assert_eq!(stored_sequence, recoverable_sequence);
    }

    #[test]
    fn cas_reports_exhaustion_across_the_full_unsigned_sequence_range() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("db/osg.sqlite3");
        let database = Database::open(&path).expect("initialize schema");
        drop(database);
        let id = JobId::new();
        let sequence = encode_sequence(u64::MAX);
        let connection = rusqlite::Connection::open(&path).expect("open raw database");
        connection
            .execute(
                "INSERT INTO jobs(
                   id, kind, state, sequence, progress_basis_points,
                   created_at_ms, updated_at_ms
                 ) VALUES (?1, 'installEngine', 'interrupted', ?2, 1, 1, 1)",
                params![id.as_uuid(), sequence.as_slice()],
            )
            .expect("inject exhausted terminal job");
        drop(connection);
        let database = Database::open(path).expect("load unsigned maximum sequence");
        let current = database
            .get_job(id)
            .expect("read exhausted job")
            .expect("job exists");

        assert_eq!(current.sequence(), u64::MAX);
        assert!(matches!(
            database.compare_and_swap_job(u64::MAX, &current),
            Err(DatabaseError::JobSequenceExhausted(found)) if found == id
        ));
    }

    #[test]
    fn unreleased_schema_does_not_claim_unimplemented_job_history() {
        let (directory, database) = database();
        drop(database);
        let connection = rusqlite::Connection::open(directory.path().join("db/osg.sqlite3"))
            .expect("open raw database");
        for table in ["job_attempts", "job_events", "job_checkpoints"] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )
                .expect("query schema");
            assert!(!exists, "unexpected placeholder table {table}");
        }
    }
}
