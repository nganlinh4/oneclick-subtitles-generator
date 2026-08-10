use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
};

use osg_application::{ProjectHistoryStatus, ProjectSnapshot, RevisionCommit};
use osg_domain::{
    AssetId, CueId, MediaAsset, MediaKind, ProjectId, ProjectMetadata, RevisionId, RevisionReason,
    SubtitleCue, SubtitleTrack, TrackId, TrackOrigin,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use super::actor::now_ms;
use super::error::DatabaseError;

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

/// Normalize revision graphs created before whole-project retention became bounded.
///
/// This runs after schema migration and before the database actor accepts requests. It retains the
/// active current/redo graph, trims it to the supported bounds, and removes old detached branches.
/// Invalid active topology is still treated as corruption rather than silently repaired.
pub(super) fn reconcile_revision_retention(
    connection: &mut Connection,
) -> Result<(), DatabaseError> {
    let project_count: i64 =
        connection.query_row("SELECT count(*) FROM projects", [], |row| row.get(0))?;
    let project_count = usize::try_from(project_count)
        .ok()
        .filter(|count| *count <= MAX_PROJECTS_TO_RECONCILE)
        .ok_or_else(|| {
            DatabaseError::Integrity(
                "project count exceeds the startup reconciliation limit".to_owned(),
            )
        })?;
    let project_ids = {
        let mut statement = connection.prepare("SELECT id FROM projects ORDER BY id LIMIT ?1")?;
        let mut project_ids = Vec::with_capacity(project_count);
        let rows =
            statement.query_map([PROJECT_RECONCILE_QUERY_LIMIT], |row| row.get::<_, Uuid>(0))?;
        for row in rows {
            project_ids.push(row?);
        }
        if project_ids.len() > MAX_PROJECTS_TO_RECONCILE {
            return Err(DatabaseError::Integrity(
                "project count exceeds the startup reconciliation limit".to_owned(),
            ));
        }
        project_ids
    };
    for project_uuid in project_ids {
        let project_id = ProjectId::from_uuid(project_uuid).map_err(|_| {
            DatabaseError::Integrity("projects table contains an invalid project ID".to_owned())
        })?;
        reconcile_project_revision_retention(connection, project_id)?;
    }
    Ok(())
}

fn reconcile_project_revision_retention(
    connection: &mut Connection,
    project_id: ProjectId,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    let header = read_header_unbounded(&transaction, project_id)?;
    if header.redo.len() > MAX_REDO_REVISIONS {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    let parents = revision_parent_map(&transaction, project_id)?;
    let current_chain = current_chain_from_map(project_id, header.current_revision, &parents)?;
    verify_redo_from_map(
        project_id,
        header.current_revision,
        &current_chain,
        &header.redo,
        &parents,
    )?;

    if current_chain.len() > MAX_CURRENT_REVISIONS {
        let oldest_kept = current_chain[MAX_CURRENT_REVISIONS - 1];
        let changed = transaction.execute(
            "UPDATE project_revisions SET parent_id = NULL WHERE id = ?1 AND project_id = ?2",
            params![oldest_kept.as_uuid(), project_id.as_uuid()],
        )?;
        if changed != 1 {
            return Err(DatabaseError::CorruptRevisionNavigation(project_id));
        }
    }
    let retained = current_chain
        .iter()
        .take(MAX_CURRENT_REVISIONS)
        .chain(&header.redo)
        .copied()
        .collect::<HashSet<_>>();
    for revision in parents
        .keys()
        .filter(|revision| !retained.contains(revision))
    {
        delete_revision(&transaction, project_id, *revision)?;
    }
    transaction.commit()?;
    Ok(())
}

fn revision_parent_map(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<HashMap<RevisionId, Option<RevisionId>>, DatabaseError> {
    let revision_count: i64 = connection.query_row(
        "SELECT count(*) FROM project_revisions WHERE project_id = ?1",
        [project_id.as_uuid()],
        |row| row.get(0),
    )?;
    let revision_count = usize::try_from(revision_count)
        .ok()
        .filter(|count| *count <= MAX_LEGACY_PROJECT_REVISIONS)
        .ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    let mut statement = connection.prepare(
        "SELECT id, parent_id FROM project_revisions
         WHERE project_id = ?1 ORDER BY id LIMIT ?2",
    )?;
    let rows = statement.query_map(
        params![project_id.as_uuid(), LEGACY_REVISION_QUERY_LIMIT],
        |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, Option<Uuid>>(1)?)),
    )?;
    let mut parents = HashMap::with_capacity(revision_count);
    for row in rows {
        let (revision, parent) = row?;
        let revision = RevisionId::from_uuid(revision)
            .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?;
        let parent = parent
            .map(RevisionId::from_uuid)
            .transpose()
            .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?;
        parents.insert(revision, parent);
    }
    if parents.len() != revision_count {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    Ok(parents)
}

fn current_chain_from_map(
    project_id: ProjectId,
    current_revision: RevisionId,
    parents: &HashMap<RevisionId, Option<RevisionId>>,
) -> Result<Vec<RevisionId>, DatabaseError> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = Some(current_revision);
    while let Some(revision) = cursor {
        if !seen.insert(revision) {
            return Err(DatabaseError::CorruptRevisionNavigation(project_id));
        }
        chain.push(revision);
        cursor = *parents
            .get(&revision)
            .ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    }
    Ok(chain)
}

fn verify_redo_from_map(
    project_id: ProjectId,
    current_revision: RevisionId,
    current_chain: &[RevisionId],
    redo: &[RevisionId],
    parents: &HashMap<RevisionId, Option<RevisionId>>,
) -> Result<(), DatabaseError> {
    let mut seen = current_chain.iter().copied().collect::<HashSet<_>>();
    let mut expected_parent = current_revision;
    for revision in redo.iter().rev().copied() {
        if !seen.insert(revision)
            || parents.get(&revision).copied().flatten() != Some(expected_parent)
        {
            return Err(DatabaseError::CorruptRevisionNavigation(project_id));
        }
        expected_parent = revision;
    }
    Ok(())
}

pub(super) fn create_project(
    connection: &mut Connection,
    metadata: &ProjectMetadata,
) -> Result<ProjectSnapshot, DatabaseError> {
    let snapshot = ProjectSnapshot::new(metadata.clone(), 0, Vec::new(), Vec::new())
        .map_err(invalid_snapshot)?;
    let encoded = encode_snapshot(&snapshot)?;
    let revision_id = RevisionId::new();
    let timestamp = now_ms();
    let transaction = connection.transaction()?;

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
    write_normalized(&transaction, &snapshot)?;
    insert_revision(
        &transaction,
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
    write_project_state(&transaction, &snapshot, revision_id, timestamp)?;
    transaction.commit()?;
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

fn encode_snapshot(snapshot: &ProjectSnapshot) -> Result<EncodedSnapshot, DatabaseError> {
    let raw = serde_json::to_vec(snapshot).map_err(|error| {
        DatabaseError::InvalidProjectSnapshot(format!("could not serialize snapshot: {error}"))
    })?;
    if raw.len() > MAX_RAW_SNAPSHOT_BYTES {
        return Err(DatabaseError::ProjectSnapshotTooLarge {
            limit: MAX_RAW_SNAPSHOT_BYTES,
            actual: raw.len(),
        });
    }
    let hash = *blake3::hash(&raw).as_bytes();
    let compressed = zstd::stream::encode_all(raw.as_slice(), SNAPSHOT_COMPRESSION_LEVEL)?;
    if compressed.len() > MAX_COMPRESSED_SNAPSHOT_BYTES {
        return Err(DatabaseError::CompressedProjectSnapshotTooLarge {
            limit: MAX_COMPRESSED_SNAPSHOT_BYTES,
            actual: compressed.len(),
        });
    }
    let cue_count = snapshot
        .tracks()
        .iter()
        .try_fold(0_i64, |count, track| {
            i64::try_from(track.cues().len())
                .ok()
                .and_then(|track_count| count.checked_add(track_count))
        })
        .ok_or_else(|| {
            DatabaseError::InvalidProjectSnapshot("cue count exceeds the SQLite range".to_owned())
        })?;
    Ok(EncodedSnapshot {
        compressed,
        hash,
        cue_count,
    })
}

fn decode_snapshot(
    revision_id: RevisionId,
    compressed: &[u8],
    expected_hash: &[u8],
) -> Result<ProjectSnapshot, DatabaseError> {
    if compressed.len() > MAX_COMPRESSED_SNAPSHOT_BYTES {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "compressed snapshot exceeds the configured limit",
        });
    }
    let expected_hash: [u8; 32] =
        expected_hash
            .try_into()
            .map_err(|_| DatabaseError::CorruptProjectRevision {
                revision_id,
                detail: "snapshot hash has the wrong length",
            })?;
    let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed)).map_err(|_| {
        DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "snapshot compression stream is invalid",
        }
    })?;
    let mut raw = Vec::new();
    decoder
        .take(u64::try_from(MAX_RAW_SNAPSHOT_BYTES).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut raw)
        .map_err(|_| DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "snapshot decompression failed",
        })?;
    if raw.len() > MAX_RAW_SNAPSHOT_BYTES {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "raw snapshot exceeds the configured limit",
        });
    }
    if blake3::hash(&raw).as_bytes() != &expected_hash {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "snapshot hash verification failed",
        });
    }
    serde_json::from_slice(&raw).map_err(|_| DatabaseError::CorruptProjectRevision {
        revision_id,
        detail: "snapshot JSON or domain invariants are invalid",
    })
}

#[allow(clippy::too_many_arguments)]
fn insert_revision(
    transaction: &Transaction<'_>,
    revision_id: RevisionId,
    project_id: ProjectId,
    parent_id: Option<RevisionId>,
    reason: &str,
    state_version: u64,
    encoded: &EncodedSnapshot,
    timestamp: i64,
) -> Result<(), DatabaseError> {
    let state_version = to_sql_version(project_id, state_version)?;
    transaction.execute(
        "INSERT INTO project_revisions(
           id, project_id, parent_id, reason, state_version, snapshot_zstd,
           snapshot_hash, cue_count, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            revision_id.as_uuid(),
            project_id.as_uuid(),
            parent_id.map(RevisionId::into_uuid),
            reason,
            state_version,
            &encoded.compressed,
            encoded.hash.as_slice(),
            encoded.cue_count,
            timestamp,
        ],
    )?;
    Ok(())
}

fn load_revision(
    connection: &Connection,
    project_id: ProjectId,
    revision_id: RevisionId,
) -> Result<ProjectSnapshot, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT project_id, state_version, snapshot_zstd, snapshot_hash, cue_count
             FROM project_revisions WHERE id = ?1",
            [revision_id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, Uuid>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    if row.0 != *project_id.as_uuid() || row.1 < 0 || row.4 < 0 {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "revision ownership or numeric metadata is invalid",
        });
    }
    let snapshot = decode_snapshot(revision_id, &row.2, &row.3)?;
    let stored_version =
        u64::try_from(row.1).map_err(|_| DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "revision state version is invalid",
        })?;
    let cue_count = snapshot
        .tracks()
        .iter()
        .map(|track| track.cues().len())
        .sum::<usize>();
    if snapshot.metadata().id() != project_id
        || snapshot.state_version() != stored_version
        || i64::try_from(cue_count).ok() != Some(row.4)
    {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id,
            detail: "revision metadata does not match its canonical snapshot",
        });
    }
    Ok(snapshot)
}

fn read_header(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<ProjectHeader, DatabaseError> {
    let header = read_header_unbounded(connection, project_id)?;
    if header.redo.len() > MAX_REDO_REVISIONS {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    Ok(header)
}

fn read_header_unbounded(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<ProjectHeader, DatabaseError> {
    let project_version = connection
        .query_row(
            "SELECT state_version FROM projects WHERE id = ?1",
            [project_id.as_uuid()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or(DatabaseError::ProjectNotFound(project_id))?;
    let (revision_uuid, redo_json, state_revision_uuid, state_version) = connection
        .query_row(
            "SELECT n.current_revision_id,
                    CASE WHEN length(CAST(n.redo_stack_json AS BLOB)) <= ?2
                         THEN n.redo_stack_json END,
                    s.current_revision_id, s.state_version
             FROM revision_navigation n
             JOIN project_state s ON s.project_id = n.project_id
             WHERE n.project_id = ?1",
            params![project_id.as_uuid(), MAX_REDO_STACK_JSON_BYTES_SQL],
            |row| {
                Ok((
                    row.get::<_, Uuid>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<Uuid>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    let redo_json = redo_json.ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    if project_version < 0
        || state_version != project_version
        || state_revision_uuid != Some(revision_uuid)
        || redo_json.len() > MAX_REDO_STACK_JSON_BYTES
    {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    let current_revision = RevisionId::from_uuid(revision_uuid)
        .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?;
    let redo: Vec<RevisionId> = serde_json::from_str(&redo_json)
        .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?;
    Ok(ProjectHeader {
        version: u64::try_from(project_version)
            .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?,
        current_revision,
        redo,
    })
}

fn verify_current_state(
    connection: &Connection,
    project_id: ProjectId,
    header: &ProjectHeader,
) -> Result<ProjectSnapshot, DatabaseError> {
    verify_navigation_graph(connection, project_id, header)?;
    let revision_snapshot = load_revision(connection, project_id, header.current_revision)?;
    if revision_snapshot.state_version() > header.version {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id: header.current_revision,
            detail: "selected revision is newer than the project state version",
        });
    }
    let current = revision_snapshot
        .with_state_version(header.version)
        .map_err(invalid_snapshot)?;
    let normalized = load_normalized(connection, project_id)?;
    if normalized != current {
        return Err(DatabaseError::CorruptProjectRevision {
            revision_id: header.current_revision,
            detail: "normalized project state differs from the selected revision",
        });
    }
    Ok(current)
}

fn verify_navigation_graph(
    connection: &Connection,
    project_id: ProjectId,
    header: &ProjectHeader,
) -> Result<(), DatabaseError> {
    let mut seen = std::collections::HashSet::new();
    let mut cursor = Some(header.current_revision);
    for depth in 0..=MAX_CURRENT_REVISIONS {
        let Some(revision) = cursor else { break };
        if depth == MAX_CURRENT_REVISIONS || !seen.insert(revision) {
            return Err(DatabaseError::CorruptRevisionNavigation(project_id));
        }
        cursor = revision_parent(connection, project_id, revision)?;
    }

    let mut expected_parent = header.current_revision;
    for revision in header.redo.iter().rev().copied() {
        if !seen.insert(revision)
            || revision_parent(connection, project_id, revision)? != Some(expected_parent)
        {
            return Err(DatabaseError::CorruptRevisionNavigation(project_id));
        }
        expected_parent = revision;
    }
    Ok(())
}

fn revision_parent(
    connection: &Connection,
    project_id: ProjectId,
    revision_id: RevisionId,
) -> Result<Option<RevisionId>, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT project_id, parent_id FROM project_revisions WHERE id = ?1",
            [revision_id.as_uuid()],
            |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, Option<Uuid>>(1)?)),
        )
        .optional()?
        .ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    if row.0 != *project_id.as_uuid() {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    row.1
        .map(|id| {
            RevisionId::from_uuid(id)
                .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))
        })
        .transpose()
}

fn revision_reason(
    connection: &Connection,
    project_id: ProjectId,
    revision_id: RevisionId,
) -> Result<RevisionReason, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT project_id, reason FROM project_revisions WHERE id = ?1",
            [revision_id.as_uuid()],
            |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or(DatabaseError::CorruptRevisionNavigation(project_id))?;
    if row.0 != *project_id.as_uuid() {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    RevisionReason::new(row.1).map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))
}

#[allow(clippy::too_many_lines)]
fn load_normalized(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<ProjectSnapshot, DatabaseError> {
    let (title, state_version) = connection.query_row(
        "SELECT title, state_version FROM projects WHERE id = ?1",
        [project_id.as_uuid()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if state_version < 0 {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    let metadata = ProjectMetadata::with_id(project_id, title).map_err(invalid_snapshot)?;

    let mut media_statement = connection.prepare(
        "SELECT a.id, a.display_name, a.extension, a.size_bytes, a.kind
         FROM project_media p
         JOIN media_assets a ON a.id = p.media_id
         WHERE p.project_id = ?1
         ORDER BY CASE p.role WHEN 'primary' THEN 0 ELSE 1 END, p.ordinal, a.id",
    )?;
    let media_rows = media_statement.query_map([project_id.as_uuid()], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut media = Vec::new();
    for row in media_rows {
        let (id, display_name, extension, size_bytes, kind) = row?;
        let id = AssetId::from_uuid(id).map_err(invalid_snapshot)?;
        let size_bytes = u64::try_from(size_bytes).map_err(|_| {
            DatabaseError::InvalidProjectSnapshot("media size is outside the durable range".into())
        })?;
        let kind = parse_media_kind(&kind)?;
        media.push(
            MediaAsset::with_id(id, display_name, extension, size_bytes, kind)
                .map_err(invalid_snapshot)?,
        );
    }
    drop(media_statement);

    let mut track_statement = connection.prepare(
        "SELECT id, label, origin FROM tracks
         WHERE project_id = ?1 ORDER BY ordinal, id",
    )?;
    let track_rows = track_statement.query_map([project_id.as_uuid()], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut raw_tracks = Vec::new();
    for row in track_rows {
        raw_tracks.push(row?);
    }
    drop(track_statement);

    let mut tracks = Vec::with_capacity(raw_tracks.len());
    for (track_uuid, label, origin) in raw_tracks {
        let track_id = TrackId::from_uuid(track_uuid).map_err(invalid_snapshot)?;
        let mut cue_statement = connection.prepare(
            "SELECT id, ordinal, start_ms, end_ms, text, source_cue_id
             FROM cues WHERE track_id = ?1 ORDER BY ordinal",
        )?;
        let cue_rows = cue_statement.query_map([track_id.as_uuid()], |row| {
            Ok((
                row.get::<_, Uuid>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<Uuid>>(5)?,
            ))
        })?;
        let mut cues = Vec::new();
        for row in cue_rows {
            let (cue_uuid, ordinal, start_ms, end_ms, text, source_uuid) = row?;
            let cue_id = CueId::from_uuid(cue_uuid).map_err(invalid_snapshot)?;
            let ordinal = u32::try_from(ordinal).map_err(|_| {
                DatabaseError::InvalidProjectSnapshot(
                    "cue ordinal is outside the domain range".into(),
                )
            })?;
            let source_id = source_uuid
                .map(CueId::from_uuid)
                .transpose()
                .map_err(invalid_snapshot)?;
            cues.push(
                SubtitleCue::restore(cue_id, ordinal, start_ms, end_ms, text, source_id)
                    .map_err(invalid_snapshot)?,
            );
        }
        tracks.push(
            SubtitleTrack::restore(track_id, label, parse_track_origin(&origin)?, cues)
                .map_err(invalid_snapshot)?,
        );
    }

    ProjectSnapshot::new(
        metadata,
        u64::try_from(state_version)
            .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?,
        media,
        tracks,
    )
    .map_err(invalid_snapshot)
}

fn ensure_identifiers_are_local(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
) -> Result<(), DatabaseError> {
    let project_id = snapshot.metadata().id();
    {
        let mut statement = transaction.prepare(
            "SELECT EXISTS(
               SELECT 1 FROM project_media WHERE media_id = ?1 AND project_id <> ?2
             )",
        )?;
        for asset in snapshot.media() {
            if statement.query_row(params![asset.id().as_uuid(), project_id.as_uuid()], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(DatabaseError::CrossProjectIdentifier {
                    project_id,
                    entity: "media asset",
                });
            }
        }
    }
    {
        let mut statement = transaction
            .prepare("SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1 AND project_id <> ?2)")?;
        for track in snapshot.tracks() {
            if statement.query_row(params![track.id().as_uuid(), project_id.as_uuid()], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(DatabaseError::CrossProjectIdentifier {
                    project_id,
                    entity: "subtitle track",
                });
            }
        }
    }
    {
        let mut statement = transaction.prepare(
            "SELECT EXISTS(
               SELECT 1 FROM cues c JOIN tracks t ON t.id = c.track_id
               WHERE c.id = ?1 AND t.project_id <> ?2
             )",
        )?;
        for cue in snapshot.tracks().iter().flat_map(SubtitleTrack::cues) {
            if statement.query_row(params![cue.id().as_uuid(), project_id.as_uuid()], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(DatabaseError::CrossProjectIdentifier {
                    project_id,
                    entity: "subtitle cue",
                });
            }
        }
    }
    Ok(())
}

fn write_normalized(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
) -> Result<(), DatabaseError> {
    ensure_identifiers_are_local(transaction, snapshot)?;
    let project_id = snapshot.metadata().id();
    let timestamp = now_ms();

    transaction.execute(
        "DELETE FROM project_media WHERE project_id = ?1",
        [project_id.as_uuid()],
    )?;
    for (index, asset) in snapshot.media().iter().enumerate() {
        validate_existing_asset(transaction, asset)?;
        let size_bytes = i64::try_from(asset.size_bytes()).map_err(|_| {
            DatabaseError::InvalidProjectSnapshot("media size exceeds the SQLite range".to_owned())
        })?;
        transaction.execute(
            "INSERT OR IGNORE INTO media_assets(
               id, kind, display_name, extension, size_bytes, metadata_json, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)",
            params![
                asset.id().as_uuid(),
                media_kind_name(asset.kind()),
                asset.display_name(),
                asset.extension(),
                size_bytes,
                timestamp,
            ],
        )?;
        let (role, ordinal) = if index == 0 {
            ("primary", 0_i64)
        } else {
            (
                "source",
                i64::try_from(index - 1).map_err(|_| {
                    DatabaseError::InvalidProjectSnapshot(
                        "media ordinal exceeds the SQLite range".to_owned(),
                    )
                })?,
            )
        };
        transaction.execute(
            "INSERT INTO project_media(project_id, media_id, role, ordinal)
             VALUES (?1, ?2, ?3, ?4)",
            params![project_id.as_uuid(), asset.id().as_uuid(), role, ordinal],
        )?;
    }

    transaction.execute(
        "DELETE FROM tracks WHERE project_id = ?1",
        [project_id.as_uuid()],
    )?;
    let state_version = to_sql_version(project_id, snapshot.state_version())?;
    for (track_index, track) in snapshot.tracks().iter().enumerate() {
        let ordinal = i64::try_from(track_index).map_err(|_| {
            DatabaseError::InvalidProjectSnapshot(
                "track ordinal exceeds the SQLite range".to_owned(),
            )
        })?;
        transaction.execute(
            "INSERT INTO tracks(
               id, project_id, ordinal, role, language, label, origin, state_version,
               created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, 'user', NULL, ?4, ?5, ?6, ?7, ?7)",
            params![
                track.id().as_uuid(),
                project_id.as_uuid(),
                ordinal,
                track.label(),
                track_origin_name(track.origin()),
                state_version,
                timestamp,
            ],
        )?;
        for cue in track.cues() {
            transaction.execute(
                "INSERT INTO cues(
                   track_id, id, ordinal, start_ms, end_ms, text, source_cue_id, metadata_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}')",
                params![
                    track.id().as_uuid(),
                    cue.id().as_uuid(),
                    i64::from(cue.ordinal()),
                    cue.start_ms(),
                    cue.end_ms(),
                    cue.text(),
                    cue.source_id().map(CueId::into_uuid),
                ],
            )?;
        }
    }
    Ok(())
}

fn validate_existing_asset(
    connection: &Connection,
    asset: &MediaAsset,
) -> Result<(), DatabaseError> {
    let existing = connection
        .query_row(
            "SELECT kind, display_name, extension, size_bytes
             FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    if let Some((kind, display_name, extension, size_bytes)) = existing {
        let expected_size = i64::try_from(asset.size_bytes()).map_err(|_| {
            DatabaseError::InvalidProjectSnapshot("media size exceeds the SQLite range".to_owned())
        })?;
        if kind != media_kind_name(asset.kind())
            || display_name != asset.display_name()
            || extension != asset.extension()
            || size_bytes != expected_size
        {
            return Err(DatabaseError::InvalidProjectSnapshot(
                "an existing media identifier has different immutable metadata".to_owned(),
            ));
        }
    }
    Ok(())
}

fn update_project_row(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
    expected_version: u64,
) -> Result<(), DatabaseError> {
    let project_id = snapshot.metadata().id();
    let changed = transaction.execute(
        "UPDATE projects
         SET title = ?1, state_version = ?2, updated_at_ms = ?3
         WHERE id = ?4 AND state_version = ?5",
        params![
            snapshot.metadata().name(),
            to_sql_version(project_id, snapshot.state_version())?,
            now_ms(),
            project_id.as_uuid(),
            to_sql_version(project_id, expected_version)?,
        ],
    )?;
    if changed != 1 {
        let actual = transaction
            .query_row(
                "SELECT state_version FROM projects WHERE id = ?1",
                [project_id.as_uuid()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or(DatabaseError::ProjectNotFound(project_id))?;
        return Err(DatabaseError::StaleProjectVersion {
            project_id,
            expected: expected_version,
            actual: u64::try_from(actual).unwrap_or_default(),
        });
    }
    Ok(())
}

fn write_navigation(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    revision_id: RevisionId,
    redo: &[RevisionId],
    timestamp: i64,
) -> Result<(), DatabaseError> {
    if redo.len() > MAX_REDO_REVISIONS {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    let redo_json = serde_json::to_string(redo).map_err(|_| {
        DatabaseError::InvalidProjectSnapshot("could not encode redo history".to_owned())
    })?;
    let changed = transaction.execute(
        "UPDATE revision_navigation
         SET current_revision_id = ?1, redo_stack_json = ?2, updated_at_ms = ?3
         WHERE project_id = ?4",
        params![
            revision_id.as_uuid(),
            redo_json,
            timestamp,
            project_id.as_uuid()
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    Ok(())
}

fn write_project_state(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
    revision_id: RevisionId,
    timestamp: i64,
) -> Result<(), DatabaseError> {
    let project_id = snapshot.metadata().id();
    transaction.execute(
        "INSERT INTO project_state(
           project_id, active_media_id, active_track_id, current_revision_id,
           state_version, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(project_id) DO UPDATE SET
           active_media_id = excluded.active_media_id,
           active_track_id = excluded.active_track_id,
           current_revision_id = excluded.current_revision_id,
           state_version = excluded.state_version,
           updated_at_ms = excluded.updated_at_ms",
        params![
            project_id.as_uuid(),
            snapshot
                .media()
                .first()
                .map(MediaAsset::id)
                .map(AssetId::into_uuid),
            snapshot
                .tracks()
                .first()
                .map(SubtitleTrack::id)
                .map(TrackId::into_uuid),
            revision_id.as_uuid(),
            to_sql_version(project_id, snapshot.state_version())?,
            timestamp,
        ],
    )?;
    Ok(())
}

fn ensure_expected_version(
    project_id: ProjectId,
    expected: u64,
    actual: u64,
) -> Result<(), DatabaseError> {
    if expected == actual {
        Ok(())
    } else {
        Err(DatabaseError::StaleProjectVersion {
            project_id,
            expected,
            actual,
        })
    }
}

fn next_version(project_id: ProjectId, version: u64) -> Result<u64, DatabaseError> {
    version
        .checked_add(1)
        .filter(|next| i64::try_from(*next).is_ok())
        .ok_or(DatabaseError::ProjectVersionOverflow(project_id))
}

fn to_sql_version(project_id: ProjectId, version: u64) -> Result<i64, DatabaseError> {
    i64::try_from(version).map_err(|_| DatabaseError::ProjectVersionOverflow(project_id))
}

fn delete_revisions(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    revisions: &[RevisionId],
) -> Result<(), DatabaseError> {
    if revisions.len() > MAX_REDO_REVISIONS {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    for revision in revisions {
        delete_revision(transaction, project_id, *revision)?;
    }
    Ok(())
}

fn delete_revision(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    revision: RevisionId,
) -> Result<(), DatabaseError> {
    let deleted = transaction.execute(
        "DELETE FROM project_revisions WHERE id = ?1 AND project_id = ?2",
        params![revision.as_uuid(), project_id.as_uuid()],
    )?;
    if deleted != 1 {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    Ok(())
}

fn prune_current_chain(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    current_revision: RevisionId,
) -> Result<(), DatabaseError> {
    let mut chain = Vec::with_capacity(MAX_CURRENT_REVISIONS + 1);
    let mut seen = std::collections::HashSet::new();
    let mut cursor = Some(current_revision);
    while let Some(revision) = cursor {
        if chain.len() > MAX_CURRENT_REVISIONS || !seen.insert(revision) {
            return Err(DatabaseError::CorruptRevisionNavigation(project_id));
        }
        chain.push(revision);
        cursor = revision_parent(transaction, project_id, revision)?;
    }
    if chain.len() <= MAX_CURRENT_REVISIONS {
        return Ok(());
    }
    if chain.len() != MAX_CURRENT_REVISIONS + 1 {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }

    let oldest_kept = chain[MAX_CURRENT_REVISIONS - 1];
    let removed = chain[MAX_CURRENT_REVISIONS];
    if revision_parent(transaction, project_id, removed)?.is_some() {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    let changed = transaction.execute(
        "UPDATE project_revisions SET parent_id = NULL WHERE id = ?1 AND project_id = ?2",
        params![oldest_kept.as_uuid(), project_id.as_uuid()],
    )?;
    if changed != 1 {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    delete_revisions(transaction, project_id, &[removed])
}

fn push_bounded(redo: &mut Vec<RevisionId>, revision_id: RevisionId) -> Option<RevisionId> {
    let dropped = (redo.len() == MAX_REDO_REVISIONS).then(|| redo.remove(0));
    redo.push(revision_id);
    dropped
}

fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

fn parse_media_kind(value: &str) -> Result<MediaKind, DatabaseError> {
    match value {
        "audio" => Ok(MediaKind::Audio),
        "video" => Ok(MediaKind::Video),
        _ => Err(DatabaseError::InvalidProjectSnapshot(
            "stored media kind is invalid".to_owned(),
        )),
    }
}

fn track_origin_name(origin: TrackOrigin) -> &'static str {
    match origin {
        TrackOrigin::LegacyJson => "legacyJson",
        TrackOrigin::Srt => "srt",
    }
}

fn parse_track_origin(value: &str) -> Result<TrackOrigin, DatabaseError> {
    match value {
        "legacyJson" => Ok(TrackOrigin::LegacyJson),
        "srt" => Ok(TrackOrigin::Srt),
        _ => Err(DatabaseError::InvalidProjectSnapshot(
            "stored subtitle-track origin is invalid".to_owned(),
        )),
    }
}

fn invalid_snapshot(error: impl std::fmt::Display) -> DatabaseError {
    DatabaseError::InvalidProjectSnapshot(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use osg_application::{ProjectRepository, ProjectSnapshot};
    use osg_domain::{
        MediaAsset, MediaKind, ProjectMetadata, RevisionId, RevisionReason, SubtitleCue,
        SubtitleTrack, TrackOrigin,
    };
    use rusqlite::{Connection, params};
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{
        DatabaseError, MAX_CURRENT_REVISIONS, MAX_REDO_REVISIONS, MAX_REDO_STACK_JSON_BYTES,
        encode_snapshot, insert_revision, push_bounded,
    };
    use crate::storage::Database;

    const EXPECTED_RETAINED_REVISIONS: i64 = 256;

    fn database() -> (TempDir, PathBuf, Database) {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("db/osg.sqlite3");
        let database = Database::open(&path).expect("open database");
        (directory, path, database)
    }

    fn reason(value: &str) -> RevisionReason {
        RevisionReason::new(value).expect("valid revision reason")
    }

    fn media() -> MediaAsset {
        MediaAsset::new("movie.mp4", "mp4", 4_096, MediaKind::Video).expect("valid media")
    }

    fn track(label: &str, text: &str) -> SubtitleTrack {
        SubtitleTrack::new(
            label,
            TrackOrigin::Srt,
            vec![SubtitleCue::new(0, 1_000, text.to_owned()).expect("valid cue")],
        )
        .expect("valid track")
    }

    fn edit(
        base: &ProjectSnapshot,
        title: &str,
        media: Vec<MediaAsset>,
        tracks: Vec<SubtitleTrack>,
    ) -> ProjectSnapshot {
        ProjectSnapshot::new(
            ProjectMetadata::with_id(base.metadata().id(), title).expect("valid metadata"),
            base.state_version(),
            media,
            tracks,
        )
        .expect("valid snapshot")
    }

    fn revision_count(path: &Path, project_id: osg_domain::ProjectId) -> i64 {
        Connection::open(path)
            .expect("open database directly")
            .query_row(
                "SELECT count(*) FROM project_revisions WHERE project_id = ?1",
                [project_id.as_uuid()],
                |row| row.get(0),
            )
            .expect("count project revisions")
    }

    fn commit_numbered_revision(
        database: &Database,
        current: &ProjectSnapshot,
        index: usize,
    ) -> ProjectSnapshot {
        let title = format!("Revision {index}");
        let edited = edit(current, &title, Vec::new(), Vec::new());
        let commit = database
            .commit_project(&edited, &reason(&title))
            .expect("commit numbered revision");
        edited
            .with_state_version(commit.state_version)
            .expect("apply committed version")
    }

    fn seed_pre_v4_unbounded_graph(
        path: &Path,
        metadata: &ProjectMetadata,
        current: &ProjectSnapshot,
    ) -> Vec<RevisionId> {
        let mut connection = Connection::open(path).expect("open pre-v4 fixture");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        let (oldest_uuid, oldest_version, current_uuid): (Uuid, i64, Uuid) = connection
            .query_row(
                "SELECT r.id, r.state_version, n.current_revision_id
                 FROM project_revisions r
                 JOIN revision_navigation n ON n.project_id = r.project_id
                 WHERE r.project_id = ?1 AND r.parent_id IS NULL",
                [metadata.id().as_uuid()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("locate retained root");
        let oldest = RevisionId::from_uuid(oldest_uuid).expect("valid oldest revision");
        let current_revision = RevisionId::from_uuid(current_uuid).expect("valid current revision");
        let transaction = connection.transaction().expect("start fixture transaction");
        let mut parent = None;
        for stored_version in 0..oldest_version {
            let version = u64::try_from(stored_version).expect("non-negative version");
            let snapshot = ProjectSnapshot::new(metadata.clone(), version, Vec::new(), Vec::new())
                .expect("valid legacy snapshot");
            let encoded = encode_snapshot(&snapshot).expect("encode legacy snapshot");
            let revision = RevisionId::new();
            insert_revision(
                &transaction,
                revision,
                metadata.id(),
                parent,
                "Legacy ancestor",
                version,
                &encoded,
                stored_version,
            )
            .expect("insert legacy ancestor");
            parent = Some(revision);
        }
        transaction
            .execute(
                "UPDATE project_revisions SET parent_id = ?1 WHERE id = ?2",
                params![
                    parent.expect("legacy ancestors").as_uuid(),
                    oldest.as_uuid()
                ],
            )
            .expect("attach legacy ancestors");

        let mut detached = Vec::new();
        let mut branch_parent = Some(current_revision);
        for offset in 1..=2 {
            let version = current.state_version() + offset;
            let snapshot = ProjectSnapshot::new(metadata.clone(), version, Vec::new(), Vec::new())
                .expect("valid detached snapshot");
            let encoded = encode_snapshot(&snapshot).expect("encode detached snapshot");
            let revision = RevisionId::new();
            insert_revision(
                &transaction,
                revision,
                metadata.id(),
                branch_parent,
                "Detached branch",
                version,
                &encoded,
                i64::try_from(version).expect("SQLite version"),
            )
            .expect("insert detached branch");
            detached.push(revision);
            branch_parent = Some(revision);
        }
        transaction.commit().expect("commit pre-v4 graph");
        connection
            .execute_batch(
                "DROP TABLE editor_track_navigation;
                 DROP TABLE editor_track_revisions;
                 PRAGMA user_version = 3;",
            )
            .expect("downgrade fixture schema marker");
        detached
    }

    #[test]
    fn repository_port_creates_loads_and_reopens_a_project() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Persistent project").expect("valid project");

        let created = ProjectRepository::create(&database, &metadata).expect("create project");
        assert_eq!(created.state_version(), 0);
        assert_eq!(
            ProjectRepository::load(&database, metadata.id()).expect("load project"),
            Some(created.clone())
        );

        drop(database);
        let reopened = Database::open(path).expect("reopen database");
        assert_eq!(
            reopened
                .load_project(metadata.id())
                .expect("load reopened project"),
            Some(created)
        );
    }

    #[test]
    fn commit_atomically_updates_normalized_state_and_the_immutable_snapshot() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Before").expect("valid project");
        let created = database.create_project(&metadata).expect("create project");
        let edited = edit(
            &created,
            "After",
            vec![media()],
            vec![track("English", "Hello")],
        );

        let commit = database
            .commit_project(&edited, &reason("Imported subtitles"))
            .expect("commit project");
        assert_eq!(commit.state_version, 1);
        let expected = edited.with_state_version(1).expect("next version");
        assert_eq!(
            database.load_project(metadata.id()).expect("load project"),
            Some(expected.clone())
        );

        drop(database);
        let connection = Connection::open(path).expect("open database directly");
        let (project_version, revision_version, media_count, track_count, cue_count): (
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = connection
            .query_row(
                "SELECT p.state_version, r.state_version,
                        (SELECT count(*) FROM project_media WHERE project_id = p.id),
                        (SELECT count(*) FROM tracks WHERE project_id = p.id),
                        (SELECT count(*) FROM cues c JOIN tracks t ON t.id = c.track_id
                         WHERE t.project_id = p.id)
                 FROM projects p
                 JOIN revision_navigation n ON n.project_id = p.id
                 JOIN project_revisions r ON r.id = n.current_revision_id
                 WHERE p.id = ?1",
                [metadata.id().as_uuid()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("read normalized state");
        assert_eq!((project_version, revision_version), (1, 1));
        assert_eq!((media_count, track_count, cue_count), (1, 1, 1));
    }

    #[test]
    fn stale_writer_is_rejected_without_changing_the_winning_commit() {
        let (_directory, _path, database) = database();
        let metadata = ProjectMetadata::new("Concurrent").expect("valid project");
        let base = database.create_project(&metadata).expect("create project");
        let winner = edit(&base, "Winner", Vec::new(), vec![track("A", "winner")]);
        let stale = edit(&base, "Stale", Vec::new(), vec![track("B", "stale")]);

        database
            .commit_project(&winner, &reason("Winning write"))
            .expect("commit winner");
        assert!(matches!(
            database.commit_project(&stale, &reason("Stale write")),
            Err(DatabaseError::StaleProjectVersion {
                expected: 0,
                actual: 1,
                ..
            })
        ));
        let loaded = database
            .load_project(metadata.id())
            .expect("load winner")
            .expect("project exists");
        assert_eq!(loaded.metadata().name(), "Winner");
        assert_eq!(loaded.tracks()[0].cues()[0].text(), "winner");
    }

    #[test]
    fn undo_redo_and_branching_keep_monotonic_versions_and_clear_redo() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("History").expect("valid project");
        let base = database.create_project(&metadata).expect("create project");
        let a = edit(&base, "A", Vec::new(), vec![track("A", "first")]);
        let commit_a = database.commit_project(&a, &reason("A")).expect("commit A");
        let at_a = database
            .load_project(metadata.id())
            .expect("load A")
            .expect("project exists");
        let b = edit(&at_a, "B", Vec::new(), vec![track("B", "second")]);
        let commit_b = database.commit_project(&b, &reason("B")).expect("commit B");
        let at_b = database
            .project_history_status(metadata.id())
            .expect("status at B");
        assert_eq!(at_b.state_version, 2);
        assert_eq!(
            at_b.undo_reason.as_ref().map(RevisionReason::as_str),
            Some("B")
        );
        assert!(!at_b.can_redo);

        assert!(
            database
                .undo_project_guarded(metadata.id(), 2, &reason("not B"))
                .expect("mismatched guarded undo")
                .is_none()
        );
        assert_eq!(
            database
                .project_history_status(metadata.id())
                .expect("status after rejected guard")
                .state_version,
            2
        );

        let undone = database
            .undo_project_guarded(metadata.id(), 2, &reason("B"))
            .expect("undo B")
            .expect("parent exists");
        assert_eq!(undone.state_version(), 3);
        assert_eq!(undone.metadata().name(), "A");
        let after_undo = database
            .project_history_status(metadata.id())
            .expect("status after undo");
        assert_eq!(after_undo.state_version, 3);
        assert_eq!(
            after_undo.undo_reason.as_ref().map(RevisionReason::as_str),
            Some("A")
        );
        assert_eq!(
            after_undo.redo_reason.as_ref().map(RevisionReason::as_str),
            Some("B")
        );
        assert!(after_undo.can_undo);
        assert!(after_undo.can_redo);
        assert!(
            database
                .redo_project_guarded(metadata.id(), 3, &reason("not B"))
                .expect("mismatched guarded redo")
                .is_none()
        );
        let redone = database
            .redo_project_guarded(metadata.id(), 3, &reason("B"))
            .expect("redo B")
            .expect("redo exists");
        assert_eq!(redone.state_version(), 4);
        assert_eq!(redone.metadata().name(), "B");

        let branch_base = database
            .undo_project(metadata.id(), 4)
            .expect("undo B again")
            .expect("parent exists");
        let c = edit(&branch_base, "C", Vec::new(), vec![track("C", "branch")]);
        let commit_c = database
            .commit_project(&c, &reason("Branch C"))
            .expect("commit branch C");
        assert_eq!(commit_c.state_version, 6);
        let on_branch = database
            .project_history_status(metadata.id())
            .expect("status on branch");
        assert_eq!(on_branch.state_version, 6);
        assert_eq!(
            on_branch.undo_reason.as_ref().map(RevisionReason::as_str),
            Some("Branch C")
        );
        assert!(!on_branch.can_redo);
        assert!(
            database
                .redo_project(metadata.id(), 6)
                .expect("empty redo")
                .is_none()
        );

        drop(database);
        let connection = Connection::open(path).expect("open database directly");
        let parent: Uuid = connection
            .query_row(
                "SELECT parent_id FROM project_revisions WHERE id = ?1",
                [commit_c.revision_id.as_uuid()],
                |row| row.get(0),
            )
            .expect("read branch parent");
        assert_eq!(parent, commit_a.revision_id.into_uuid());
        assert_ne!(parent, commit_b.revision_id.into_uuid());
    }

    #[test]
    fn long_linear_history_is_pruned_to_the_latest_256_revisions_and_reopens() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Bounded history").expect("valid project");
        let mut current = database.create_project(&metadata).expect("create project");

        for index in 1..=(MAX_CURRENT_REVISIONS + 32) {
            current = commit_numbered_revision(&database, &current, index);
        }
        assert_eq!(
            revision_count(&path, metadata.id()),
            EXPECTED_RETAINED_REVISIONS
        );
        assert_eq!(
            database.load_project(metadata.id()).expect("load latest"),
            Some(current.clone())
        );

        drop(database);
        let reopened = Database::open(&path).expect("reopen bounded database");
        assert_eq!(
            reopened
                .load_project(metadata.id())
                .expect("load latest after restart"),
            Some(current)
        );
        assert_eq!(
            revision_count(&path, metadata.id()),
            EXPECTED_RETAINED_REVISIONS
        );
    }

    #[test]
    fn v4_upgrade_prunes_legacy_ancestors_and_detached_branches_before_load() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Legacy retention").expect("valid project");
        let mut current = database.create_project(&metadata).expect("create project");
        for index in 1..=(MAX_CURRENT_REVISIONS + 32) {
            current = commit_numbered_revision(&database, &current, index);
        }
        drop(database);

        let detached = seed_pre_v4_unbounded_graph(&path, &metadata, &current);
        assert!(revision_count(&path, metadata.id()) > EXPECTED_RETAINED_REVISIONS);

        let upgraded = Database::open(&path).expect("migrate and reconcile v3 database");
        assert_eq!(
            upgraded
                .load_project(metadata.id())
                .expect("load reconciled project"),
            Some(current)
        );
        drop(upgraded);
        assert_eq!(
            revision_count(&path, metadata.id()),
            EXPECTED_RETAINED_REVISIONS
        );

        let connection = Connection::open(path).expect("inspect upgraded database");
        let schema_version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read schema version");
        assert_eq!(schema_version, 4);
        for revision in detached {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM project_revisions WHERE id = ?1)",
                    [revision.as_uuid()],
                    |row| row.get(0),
                )
                .expect("check detached revision");
            assert!(!exists);
        }
    }

    #[test]
    fn startup_reconciliation_rejects_oversized_redo_json_before_parsing() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Oversized navigation").expect("valid project");
        database.create_project(&metadata).expect("create project");
        drop(database);

        let repeated = vec![RevisionId::new(); MAX_REDO_REVISIONS * 8];
        let oversized = serde_json::to_string(&repeated).expect("serialize oversized redo");
        assert!(oversized.len() > MAX_REDO_STACK_JSON_BYTES);
        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute(
                "UPDATE revision_navigation SET redo_stack_json = ?1 WHERE project_id = ?2",
                params![oversized, metadata.id().as_uuid()],
            )
            .expect("store oversized redo JSON");
        drop(connection);

        assert!(matches!(
            Database::open(&path),
            Err(DatabaseError::CorruptRevisionNavigation(id)) if id == metadata.id()
        ));
        assert_eq!(revision_count(&path, metadata.id()), 1);
    }

    #[test]
    fn startup_reconciliation_rejects_an_active_cycle_without_deleting_rows() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Cyclic navigation").expect("valid project");
        let root = database.create_project(&metadata).expect("create project");
        database
            .commit_project(
                &edit(&root, "Second", Vec::new(), Vec::new()),
                &reason("Second"),
            )
            .expect("commit second revision");
        drop(database);

        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute(
                "UPDATE project_revisions
                 SET parent_id = (SELECT current_revision_id FROM revision_navigation
                                  WHERE project_id = ?1)
                 WHERE project_id = ?1 AND parent_id IS NULL",
                [metadata.id().as_uuid()],
            )
            .expect("create active cycle");
        drop(connection);

        assert!(matches!(
            Database::open(&path),
            Err(DatabaseError::CorruptRevisionNavigation(id)) if id == metadata.id()
        ));
        assert_eq!(revision_count(&path, metadata.id()), 2);
    }

    #[test]
    fn undo_stops_at_the_retained_root_and_redo_survives_restart() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Undo retention").expect("valid project");
        let mut current = database.create_project(&metadata).expect("create project");
        for index in 1..=(MAX_CURRENT_REVISIONS + 8) {
            current = commit_numbered_revision(&database, &current, index);
        }

        for _ in 1..MAX_CURRENT_REVISIONS {
            current = database
                .undo_project(metadata.id(), current.state_version())
                .expect("undo retained revision")
                .expect("retained parent exists");
        }
        assert!(
            database
                .undo_project(metadata.id(), current.state_version())
                .expect("undo at retained root")
                .is_none()
        );
        assert_eq!(
            revision_count(&path, metadata.id()),
            EXPECTED_RETAINED_REVISIONS
        );

        drop(database);
        let reopened = Database::open(&path).expect("reopen undone database");
        assert_eq!(
            reopened
                .load_project(metadata.id())
                .expect("load retained root"),
            Some(current.clone())
        );
        let status = reopened
            .project_history_status(metadata.id())
            .expect("load restarted navigation");
        assert!(!status.can_undo);
        assert!(status.can_redo);
        assert!(
            reopened
                .redo_project(metadata.id(), current.state_version())
                .expect("redo after restart")
                .is_some()
        );
        assert_eq!(
            revision_count(&path, metadata.id()),
            EXPECTED_RETAINED_REVISIONS
        );
    }

    #[test]
    fn branch_commit_deletes_abandoned_redo_rows_and_reopens_cleanly() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Bounded branch").expect("valid project");
        let mut current = database.create_project(&metadata).expect("create project");
        let mut commits = Vec::new();
        for index in 1..=4 {
            let edited = edit(
                &current,
                &format!("Revision {index}"),
                Vec::new(),
                Vec::new(),
            );
            let commit = database
                .commit_project(&edited, &reason(&format!("Revision {index}")))
                .expect("commit linear revision");
            current = edited
                .with_state_version(commit.state_version)
                .expect("apply committed version");
            commits.push(commit.revision_id);
        }
        for _ in 0..2 {
            current = database
                .undo_project(metadata.id(), current.state_version())
                .expect("undo before branch")
                .expect("parent exists");
        }

        let branch = edit(&current, "Branch", Vec::new(), Vec::new());
        let branch_commit = database
            .commit_project(&branch, &reason("Branch"))
            .expect("commit branch");
        let expected = branch
            .with_state_version(branch_commit.state_version)
            .expect("apply branch version");
        assert_eq!(revision_count(&path, metadata.id()), 4);
        let connection = Connection::open(&path).expect("inspect branch rows");
        for abandoned in &commits[2..] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM project_revisions WHERE id = ?1)",
                    [abandoned.as_uuid()],
                    |row| row.get(0),
                )
                .expect("check abandoned revision");
            assert!(!exists);
        }
        let redo: String = connection
            .query_row(
                "SELECT redo_stack_json FROM revision_navigation WHERE project_id = ?1",
                [metadata.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("read cleared redo stack");
        assert_eq!(redo, "[]");
        drop(connection);

        drop(database);
        let reopened = Database::open(path).expect("reopen branched database");
        assert_eq!(
            reopened.load_project(metadata.id()).expect("load branch"),
            Some(expected)
        );
    }

    #[test]
    fn bounded_redo_reports_the_oldest_revision_for_deletion() {
        let mut redo = (0..MAX_REDO_REVISIONS)
            .map(|_| RevisionId::new())
            .collect::<Vec<_>>();
        let oldest = redo[0];
        let newest = RevisionId::new();

        assert_eq!(push_bounded(&mut redo, newest), Some(oldest));
        assert_eq!(redo.len(), MAX_REDO_REVISIONS);
        assert_eq!(redo.last(), Some(&newest));
        assert!(!redo.contains(&oldest));
    }

    #[test]
    fn history_status_survives_restart_and_rejects_a_corrupt_reason() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("History status").expect("valid project");
        let root = database.create_project(&metadata).expect("create project");
        let root_status = database
            .project_history_status(metadata.id())
            .expect("root status");
        assert_eq!(root_status.state_version, 0);
        assert!(!root_status.can_undo);
        assert!(!root_status.can_redo);

        database
            .commit_project(
                &edit(&root, "Edited", Vec::new(), vec![track("A", "edited")]),
                &reason("Lyrics edit"),
            )
            .expect("commit edit");
        drop(database);

        let reopened = Database::open(&path).expect("reopen database");
        let reopened_status = reopened
            .project_history_status(metadata.id())
            .expect("reopened status");
        assert_eq!(
            reopened_status
                .undo_reason
                .as_ref()
                .map(RevisionReason::as_str),
            Some("Lyrics edit")
        );
        drop(reopened);

        let connection = Connection::open(&path).expect("open directly");
        connection
            .execute(
                "UPDATE project_revisions SET reason = char(10) WHERE reason = 'Lyrics edit'",
                [],
            )
            .expect("corrupt reason");
        drop(connection);
        let corrupted = Database::open(path).expect("reopen corrupt database");
        assert!(matches!(
            corrupted.project_history_status(metadata.id()),
            Err(DatabaseError::CorruptRevisionNavigation(id)) if id == metadata.id()
        ));
    }

    #[test]
    fn corrupted_snapshot_hash_is_detected_before_deserialization_or_commit() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Corrupt hash").expect("valid project");
        database.create_project(&metadata).expect("create project");
        drop(database);
        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute(
                "UPDATE project_revisions SET snapshot_hash = zeroblob(32)",
                [],
            )
            .expect("corrupt hash");
        drop(connection);

        let reopened = Database::open(path).expect("reopen database");
        assert!(matches!(
            reopened.load_project(metadata.id()),
            Err(DatabaseError::CorruptProjectRevision {
                detail: "snapshot hash verification failed",
                ..
            })
        ));
    }

    #[test]
    fn corrupted_compressed_blob_is_detected_with_bounded_decompression() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Corrupt blob").expect("valid project");
        database.create_project(&metadata).expect("create project");
        drop(database);
        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute("UPDATE project_revisions SET snapshot_zstd = x'00'", [])
            .expect("corrupt blob");
        drop(connection);

        let reopened = Database::open(path).expect("reopen database");
        assert!(matches!(
            reopened.load_project(metadata.id()),
            Err(DatabaseError::CorruptProjectRevision { .. })
        ));
    }

    #[test]
    fn failed_normalized_write_rolls_back_every_row_and_the_revision() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Rollback").expect("valid project");
        let base = database.create_project(&metadata).expect("create project");
        drop(database);
        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_test_cue BEFORE INSERT ON cues
                 BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END;",
            )
            .expect("install failure trigger");
        drop(connection);

        let reopened = Database::open(&path).expect("reopen database");
        let edited = edit(
            &base,
            "Must roll back",
            vec![media()],
            vec![track("English", "Rollback")],
        );
        assert!(
            reopened
                .commit_project(&edited, &reason("Fail atomically"))
                .is_err()
        );
        assert_eq!(
            reopened.load_project(metadata.id()).expect("load original"),
            Some(base)
        );
        drop(reopened);

        let connection = Connection::open(path).expect("open database directly");
        let counts: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT count(*) FROM project_revisions),
                   (SELECT count(*) FROM media_assets),
                   (SELECT count(*) FROM tracks),
                   (SELECT state_version FROM projects WHERE id = ?1)",
                [metadata.id().as_uuid()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read rollback state");
        assert_eq!(counts, (1, 0, 0, 0));
    }

    #[test]
    fn media_locations_are_never_serialized_or_deleted_by_project_history() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Private paths").expect("valid project");
        let base = database.create_project(&metadata).expect("create project");
        let asset = media();
        let with_media = edit(&base, "Private paths", vec![asset.clone()], Vec::new());
        let media_commit = database
            .commit_project(&with_media, &reason("Attach media"))
            .expect("commit media");
        let committed = database
            .load_project(metadata.id())
            .expect("load media project")
            .expect("project exists");

        let private_path = b"/private/user/videos/movie.mp4";
        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute(
                "INSERT INTO media_locations(
                   id, media_id, path_bytes, path_encoding, platform, available
                 ) VALUES (?1, ?2, ?3, 'unix-bytes', 'linux', 1)",
                params![
                    Uuid::now_v7(),
                    asset.id().as_uuid(),
                    private_path.as_slice()
                ],
            )
            .expect("save private media location");
        let compressed: Vec<u8> = connection
            .query_row(
                "SELECT snapshot_zstd FROM project_revisions WHERE id = ?1",
                [media_commit.revision_id.as_uuid()],
                |row| row.get(0),
            )
            .expect("read canonical snapshot");
        let raw = zstd::stream::decode_all(compressed.as_slice()).expect("decode snapshot");
        assert!(
            !raw.windows(private_path.len())
                .any(|window| window == private_path)
        );
        assert!(
            !String::from_utf8(raw)
                .expect("snapshot JSON")
                .contains("pathBytes")
        );
        drop(connection);

        let without_media = edit(&committed, "Private paths", Vec::new(), Vec::new());
        database
            .commit_project(&without_media, &reason("Detach media"))
            .expect("detach media");
        let connection = Connection::open(&path).expect("open database directly");
        let location_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM media_locations WHERE media_id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("count media locations");
        assert_eq!(location_count, 1);
    }

    #[test]
    fn identifiers_owned_by_another_project_are_rejected_at_every_level() {
        let (_directory, _path, database) = database();
        let first = ProjectMetadata::new("First").expect("valid project");
        let second = ProjectMetadata::new("Second").expect("valid project");
        let first_base = database.create_project(&first).expect("create first");
        let second_base = database.create_project(&second).expect("create second");
        let shared_media = media();
        let shared_track = track("Shared", "Shared cue");
        let first_edit = edit(
            &first_base,
            "First",
            vec![shared_media.clone()],
            vec![shared_track.clone()],
        );
        database
            .commit_project(&first_edit, &reason("Own identifiers"))
            .expect("commit first");

        let media_reuse = edit(&second_base, "Second", vec![shared_media], Vec::new());
        assert!(matches!(
            database.commit_project(&media_reuse, &reason("Reuse media")),
            Err(DatabaseError::CrossProjectIdentifier {
                entity: "media asset",
                ..
            })
        ));

        let track_reuse = edit(
            &second_base,
            "Second",
            Vec::new(),
            vec![shared_track.clone()],
        );
        assert!(matches!(
            database.commit_project(&track_reuse, &reason("Reuse track")),
            Err(DatabaseError::CrossProjectIdentifier {
                entity: "subtitle track",
                ..
            })
        ));

        let track_with_reused_cue = SubtitleTrack::new(
            "New track",
            TrackOrigin::Srt,
            vec![shared_track.cues()[0].clone()],
        )
        .expect("valid track with copied cue");
        let cue_reuse = edit(
            &second_base,
            "Second",
            Vec::new(),
            vec![track_with_reused_cue],
        );
        assert!(matches!(
            database.commit_project(&cue_reuse, &reason("Reuse cue")),
            Err(DatabaseError::CrossProjectIdentifier {
                entity: "subtitle cue",
                ..
            })
        ));
    }

    #[test]
    fn version_overflow_is_rejected_without_mutating_the_project() {
        let (_directory, path, database) = database();
        let metadata = ProjectMetadata::new("Version limit").expect("valid project");
        database.create_project(&metadata).expect("create project");
        drop(database);
        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute(
                "UPDATE projects SET state_version = ?1 WHERE id = ?2",
                params![i64::MAX, metadata.id().as_uuid()],
            )
            .expect("set project version");
        connection
            .execute(
                "UPDATE project_state SET state_version = ?1 WHERE project_id = ?2",
                params![i64::MAX, metadata.id().as_uuid()],
            )
            .expect("set state version");
        drop(connection);

        let reopened = Database::open(path).expect("reopen database");
        let at_limit = reopened
            .load_project(metadata.id())
            .expect("load project")
            .expect("project exists");
        assert_eq!(at_limit.state_version(), i64::MAX as u64);
        assert!(matches!(
            reopened.commit_project(&at_limit, &reason("Overflow")),
            Err(DatabaseError::ProjectVersionOverflow(id)) if id == metadata.id()
        ));
        assert_eq!(
            reopened
                .load_project(metadata.id())
                .expect("load unchanged project")
                .expect("project exists")
                .state_version(),
            i64::MAX as u64
        );
    }
}
