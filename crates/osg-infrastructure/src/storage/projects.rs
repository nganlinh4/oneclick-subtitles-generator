use osg_application::{ProjectHistoryStatus, ProjectSnapshot, RevisionCommit};
use osg_domain::{ProjectId, ProjectMetadata, RevisionId, RevisionReason};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use super::actor::now_ms;
use super::error::DatabaseError;
use normalized::{invalid_snapshot, write_normalized};
use retention::{delete_revisions, prune_current_chain, push_bounded};
use revisions::{
    encode_snapshot, ensure_expected_version, insert_revision, load_revision, next_version,
    read_header, revision_parent, revision_reason, update_project_row, verify_current_state,
    write_navigation, write_project_state,
};

mod normalized;
mod retention;
mod revisions;

pub(super) use retention::reconcile_revision_retention;

const MAX_RAW_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMPRESSED_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MAX_REDO_REVISIONS: usize = 256;
const MAX_CURRENT_REVISIONS: usize = 256;
const MAX_REDO_STACK_JSON_BYTES: usize = 64 * 1024;
const MAX_LEGACY_PROJECT_REVISIONS: usize = 65_536;
const MAX_PROJECTS_TO_RECONCILE: usize = 100_000;
const MAX_REDO_STACK_JSON_BYTES_SQL: i64 = 65_536;
const LEGACY_REVISION_QUERY_LIMIT: i64 = 65_537;
const PROJECT_RECONCILE_QUERY_LIMIT: i64 = 100_001;
const SNAPSHOT_COMPRESSION_LEVEL: i32 = 3;
const CREATE_REASON: &str = "Project created";
const MAX_PROJECT_CREATE_KEY_UTF16_UNITS: usize = 8_192;

#[derive(Debug)]
struct ProjectHeader {
    version: u64,
    current_revision: RevisionId,
    redo: Vec<RevisionId>,
}

#[derive(Debug)]
struct EncodedSnapshot {
    compressed: Vec<u8>,
    hash: [u8; 32],
    cue_count: i64,
}

pub(super) fn create_project(
    connection: &mut Connection,
    metadata: &ProjectMetadata,
) -> Result<ProjectSnapshot, DatabaseError> {
    let transaction = connection.transaction()?;
    let snapshot = create_project_in_transaction(&transaction, metadata)?;
    transaction.commit()?;
    Ok(snapshot)
}

/// Create one logical project exactly once for a caller-owned durable identity.
///
/// The receipt and the initial project revision commit in one `SQLite` transaction. A lost IPC
/// response can therefore be retried in the same process or after restart: the exact key returns
/// the authoritative project instead of allocating another ID. A key cannot be silently reused
/// for a different requested name.
pub(super) fn create_project_idempotent(
    connection: &mut Connection,
    metadata: &ProjectMetadata,
    idempotency_key: &str,
) -> Result<ProjectSnapshot, DatabaseError> {
    validate_project_create_key(idempotency_key)?;
    let transaction = connection.transaction()?;
    let receipt = transaction
        .query_row(
            "SELECT project_id, requested_name
             FROM project_create_receipts
             WHERE idempotency_key = ?1",
            [idempotency_key],
            |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((project_uuid, requested_name)) = receipt {
        if requested_name != metadata.name() {
            return Err(DatabaseError::ProjectCreateRequestConflict);
        }
        let project_id = ProjectId::from_uuid(project_uuid).map_err(|_| {
            DatabaseError::Integrity(
                "project create receipt contains an invalid project ID".to_owned(),
            )
        })?;
        return load_project(&transaction, project_id)?.ok_or_else(|| {
            DatabaseError::Integrity(
                "project create receipt references a missing project".to_owned(),
            )
        });
    }

    let snapshot = create_project_in_transaction(&transaction, metadata)?;
    transaction.execute(
        "INSERT INTO project_create_receipts(
           idempotency_key, project_id, requested_name, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            idempotency_key,
            metadata.id().as_uuid(),
            metadata.name(),
            now_ms(),
        ],
    )?;
    transaction.commit()?;
    Ok(snapshot)
}

fn validate_project_create_key(idempotency_key: &str) -> Result<(), DatabaseError> {
    if idempotency_key.is_empty()
        || idempotency_key.encode_utf16().count() > MAX_PROJECT_CREATE_KEY_UTF16_UNITS
        || idempotency_key.chars().any(char::is_control)
    {
        return Err(DatabaseError::InvalidProjectCreateKey);
    }
    Ok(())
}

fn create_project_in_transaction(
    transaction: &Transaction<'_>,
    metadata: &ProjectMetadata,
) -> Result<ProjectSnapshot, DatabaseError> {
    let snapshot = ProjectSnapshot::new(metadata.clone(), 0, Vec::new(), Vec::new())
        .map_err(invalid_snapshot)?;
    let encoded = encode_snapshot(&snapshot)?;
    let revision_id = RevisionId::new();
    let timestamp = now_ms();

    if transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [metadata.id().as_uuid()],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(DatabaseError::ProjectAlreadyExists(metadata.id()));
    }

    transaction.execute(
        "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, 0, ?3, ?3)",
        params![metadata.id().as_uuid(), metadata.name(), timestamp],
    )?;
    write_normalized(transaction, &snapshot)?;
    insert_revision(
        transaction,
        revision_id,
        metadata.id(),
        None,
        CREATE_REASON,
        0,
        &encoded,
        timestamp,
    )?;
    transaction.execute(
        "INSERT INTO revision_navigation(
           project_id, current_revision_id, redo_stack_json, updated_at_ms
         ) VALUES (?1, ?2, '[]', ?3)",
        params![metadata.id().as_uuid(), revision_id.as_uuid(), timestamp],
    )?;
    write_project_state(transaction, &snapshot, revision_id, timestamp)?;
    Ok(snapshot)
}

pub(super) fn load_project(
    connection: &Connection,
    id: ProjectId,
) -> Result<Option<ProjectSnapshot>, DatabaseError> {
    let exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [id.as_uuid()],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Ok(None);
    }

    let header = read_header(connection, id)?;
    verify_current_state(connection, id, &header).map(Some)
}

pub(super) fn project_history_status(
    connection: &Connection,
    id: ProjectId,
) -> Result<ProjectHistoryStatus, DatabaseError> {
    let header = read_header(connection, id)?;
    verify_current_state(connection, id, &header)?;

    let undo_reason = if revision_parent(connection, id, header.current_revision)?.is_some() {
        Some(revision_reason(connection, id, header.current_revision)?)
    } else {
        None
    };
    let redo_reason = if let Some(revision_id) = header.redo.last().copied() {
        if revision_parent(connection, id, revision_id)? != Some(header.current_revision) {
            return Err(DatabaseError::CorruptRevisionNavigation(id));
        }
        Some(revision_reason(connection, id, revision_id)?)
    } else {
        None
    };

    Ok(ProjectHistoryStatus::new(
        header.version,
        undo_reason,
        redo_reason,
    ))
}

pub(super) fn commit_project(
    connection: &mut Connection,
    snapshot: &ProjectSnapshot,
    reason: &RevisionReason,
) -> Result<RevisionCommit, DatabaseError> {
    let transaction = connection.transaction()?;
    let (commit, _) = commit_project_transaction(&transaction, snapshot, reason)?;
    transaction.commit()?;
    Ok(commit)
}

/// Append a canonical whole-project revision inside an existing transaction.
///
/// Editor-track history uses this to update its independent cursor and the materialized project
/// snapshot atomically while preserving every field outside the selected track.
pub(super) fn commit_project_transaction(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
    reason: &RevisionReason,
) -> Result<(RevisionCommit, ProjectSnapshot), DatabaseError> {
    let project_id = snapshot.metadata().id();
    let header = read_header(transaction, project_id)?;
    ensure_expected_version(project_id, snapshot.state_version(), header.version)?;
    verify_current_state(transaction, project_id, &header)?;
    let next_version = next_version(project_id, header.version)?;
    let next_snapshot = snapshot
        .with_state_version(next_version)
        .map_err(invalid_snapshot)?;
    let encoded = encode_snapshot(&next_snapshot)?;
    delete_revisions(transaction, project_id, &header.redo)?;
    update_project_row(transaction, &next_snapshot, header.version)?;
    write_normalized(transaction, &next_snapshot)?;

    let revision_id = RevisionId::new();
    let timestamp = now_ms();
    insert_revision(
        transaction,
        revision_id,
        project_id,
        Some(header.current_revision),
        reason.as_str(),
        next_version,
        &encoded,
        timestamp,
    )?;
    write_navigation(transaction, project_id, revision_id, &[], timestamp)?;
    write_project_state(transaction, &next_snapshot, revision_id, timestamp)?;
    prune_current_chain(transaction, project_id, revision_id)?;
    Ok((
        RevisionCommit {
            revision_id,
            state_version: next_version,
        },
        next_snapshot,
    ))
}

pub(super) fn undo_project(
    connection: &mut Connection,
    id: ProjectId,
    expected_version: u64,
    expected_reason: Option<&RevisionReason>,
) -> Result<Option<ProjectSnapshot>, DatabaseError> {
    let transaction = connection.transaction()?;
    let mut header = read_header(&transaction, id)?;
    ensure_expected_version(id, expected_version, header.version)?;
    verify_current_state(&transaction, id, &header)?;
    if let Some(expected) = expected_reason {
        let actual = revision_reason(&transaction, id, header.current_revision)?;
        if &actual != expected {
            return Ok(None);
        }
    }
    let parent = revision_parent(&transaction, id, header.current_revision)?;
    let Some(target_revision) = parent else {
        return Ok(None);
    };

    let next_version = next_version(id, header.version)?;
    let target = load_revision(&transaction, id, target_revision)?
        .with_state_version(next_version)
        .map_err(invalid_snapshot)?;
    update_project_row(&transaction, &target, header.version)?;
    write_normalized(&transaction, &target)?;
    if let Some(dropped) = push_bounded(&mut header.redo, header.current_revision) {
        delete_revisions(&transaction, id, &[dropped])?;
    }
    let timestamp = now_ms();
    write_navigation(&transaction, id, target_revision, &header.redo, timestamp)?;
    write_project_state(&transaction, &target, target_revision, timestamp)?;
    transaction.commit()?;
    Ok(Some(target))
}

pub(super) fn redo_project(
    connection: &mut Connection,
    id: ProjectId,
    expected_version: u64,
    expected_reason: Option<&RevisionReason>,
) -> Result<Option<ProjectSnapshot>, DatabaseError> {
    let transaction = connection.transaction()?;
    let mut header = read_header(&transaction, id)?;
    ensure_expected_version(id, expected_version, header.version)?;
    verify_current_state(&transaction, id, &header)?;
    let Some(target_revision) = header.redo.pop() else {
        return Ok(None);
    };
    if let Some(expected) = expected_reason {
        let actual = revision_reason(&transaction, id, target_revision)?;
        if &actual != expected {
            return Ok(None);
        }
    }
    if revision_parent(&transaction, id, target_revision)? != Some(header.current_revision) {
        return Err(DatabaseError::CorruptRevisionNavigation(id));
    }

    let next_version = next_version(id, header.version)?;
    let target = load_revision(&transaction, id, target_revision)?
        .with_state_version(next_version)
        .map_err(invalid_snapshot)?;
    update_project_row(&transaction, &target, header.version)?;
    write_normalized(&transaction, &target)?;
    let timestamp = now_ms();
    write_navigation(&transaction, id, target_revision, &header.redo, timestamp)?;
    write_project_state(&transaction, &target, target_revision, timestamp)?;
    transaction.commit()?;
    Ok(Some(target))
}

#[cfg(test)]
mod tests;
