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
    compare_and_swap_with(connection, expected_sequence, snapshot, |_| Ok(()))
}

/// Commits one optimistic job successor and an additional store-owned write in the same `SQLite`
/// transaction. The additional write runs only after the successor row was accepted; any error
/// rolls the job transition back with it.
pub(super) fn compare_and_swap_with<F>(
    connection: &mut Connection,
    expected_sequence: u64,
    snapshot: &JobSnapshot,
    additional_write: F,
) -> Result<JobWrite, DatabaseError>
where
    F: FnOnce(&Transaction<'_>) -> Result<(), DatabaseError>,
{
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
    additional_write(&transaction)?;
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
        JobKind::ProcessMedia => "processMedia",
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
        "processMedia" => Some(JobKind::ProcessMedia),
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
mod tests;
