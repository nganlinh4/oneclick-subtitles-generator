//! Revision rows and the project header: snapshot encoding, navigation-graph verification,
//! and optimistic version checks.

use std::io::{Cursor, Read};

use osg_application::ProjectSnapshot;
use osg_domain::{
    AssetId, MediaAsset, ProjectId, RevisionId, RevisionReason, SubtitleTrack, TrackId,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use super::normalized::{invalid_snapshot, load_normalized};
use super::{
    EncodedSnapshot, MAX_COMPRESSED_SNAPSHOT_BYTES, MAX_CURRENT_REVISIONS, MAX_RAW_SNAPSHOT_BYTES,
    MAX_REDO_REVISIONS, MAX_REDO_STACK_JSON_BYTES, MAX_REDO_STACK_JSON_BYTES_SQL, ProjectHeader,
    SNAPSHOT_COMPRESSION_LEVEL,
};
use crate::storage::actor::now_ms;
use crate::storage::error::DatabaseError;

pub(super) fn encode_snapshot(
    snapshot: &ProjectSnapshot,
) -> Result<EncodedSnapshot, DatabaseError> {
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
pub(super) fn insert_revision(
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

pub(super) fn load_revision(
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

pub(super) fn read_header(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<ProjectHeader, DatabaseError> {
    let header = read_header_unbounded(connection, project_id)?;
    if header.redo.len() > MAX_REDO_REVISIONS {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    Ok(header)
}

pub(super) fn read_header_unbounded(
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

pub(super) fn verify_current_state(
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

pub(super) fn revision_parent(
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

pub(super) fn revision_reason(
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

pub(super) fn update_project_row(
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

pub(super) fn write_navigation(
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

pub(super) fn write_project_state(
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

pub(super) fn ensure_expected_version(
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

pub(super) fn next_version(project_id: ProjectId, version: u64) -> Result<u64, DatabaseError> {
    version
        .checked_add(1)
        .filter(|next| i64::try_from(*next).is_ok())
        .ok_or(DatabaseError::ProjectVersionOverflow(project_id))
}

pub(super) fn to_sql_version(project_id: ProjectId, version: u64) -> Result<i64, DatabaseError> {
    i64::try_from(version).map_err(|_| DatabaseError::ProjectVersionOverflow(project_id))
}
