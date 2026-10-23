//! Track-history rows: per-project header, zstd-encoded revision blobs, pruning, and parent links.

use std::io::{Cursor, Read};

use osg_application::ProjectTrackSelector;
use osg_domain::{ProjectId, RevisionId, RevisionReason, SubtitleTrack, TrackOrigin};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use super::{
    EncodedTrack, MAX_COMPRESSED_TRACK_BYTES, MAX_RAW_TRACK_BYTES, MAX_TRACK_REDO_JSON_BYTES,
    MAX_TRACK_REDO_JSON_BYTES_SQL, MAX_TRACK_REVISIONS, TRACK_COMPRESSION_LEVEL, TrackHeader,
    TrackRevision,
};
use crate::storage::actor::now_ms;
use crate::storage::error::DatabaseError;

pub(super) fn read_header(
    connection: &Connection,
    id: ProjectId,
) -> Result<Option<TrackHeader>, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT track_label, track_origin, current_revision_id,
                    CASE WHEN length(CAST(redo_stack_json AS BLOB)) <= ?2
                         THEN redo_stack_json END,
                    history_version
             FROM editor_track_navigation WHERE project_id = ?1",
            params![id.as_uuid(), MAX_TRACK_REDO_JSON_BYTES_SQL],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Uuid>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((label, origin, current, redo_json, history_version)) = row else {
        return Ok(None);
    };
    let redo_json = redo_json.ok_or(DatabaseError::CorruptProjectTrackHistory(id))?;
    if history_version < 0 || redo_json.len() > MAX_TRACK_REDO_JSON_BYTES {
        return Err(DatabaseError::CorruptProjectTrackHistory(id));
    }
    let origin = parse_origin(&origin).ok_or(DatabaseError::CorruptProjectTrackHistory(id))?;
    let selector = ProjectTrackSelector::new(label, origin)
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?;
    let current_revision = RevisionId::from_uuid(current)
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?;
    let redo: Vec<RevisionId> = serde_json::from_str(&redo_json)
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?;
    if redo.len() > MAX_TRACK_REVISIONS {
        return Err(DatabaseError::CorruptProjectTrackHistory(id));
    }
    Ok(Some(TrackHeader {
        selector,
        history_version: u64::try_from(history_version)
            .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?,
        current_revision,
        redo,
    }))
}

pub(super) fn write_header(
    transaction: &Transaction<'_>,
    id: ProjectId,
    header: &TrackHeader,
) -> Result<(), DatabaseError> {
    if header.redo.len() > MAX_TRACK_REVISIONS {
        return Err(DatabaseError::CorruptProjectTrackHistory(id));
    }
    let redo = serde_json::to_string(&header.redo)
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?;
    let history_version = i64::try_from(header.history_version)
        .map_err(|_| DatabaseError::ProjectTrackHistoryVersionOverflow(id))?;
    transaction.execute(
        "INSERT INTO editor_track_navigation(
           project_id, track_label, track_origin, current_revision_id, redo_stack_json,
           history_version, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_id) DO UPDATE SET
           track_label = excluded.track_label,
           track_origin = excluded.track_origin,
           current_revision_id = excluded.current_revision_id,
           redo_stack_json = excluded.redo_stack_json,
           history_version = excluded.history_version,
           updated_at_ms = excluded.updated_at_ms",
        params![
            id.as_uuid(),
            header.selector.label(),
            origin_name(header.selector.origin()),
            header.current_revision.as_uuid(),
            redo,
            history_version,
            now_ms(),
        ],
    )?;
    Ok(())
}

pub(super) fn insert_revision(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    parent: Option<RevisionId>,
    reason: Option<&RevisionReason>,
    track: Option<&SubtitleTrack>,
) -> Result<RevisionId, DatabaseError> {
    let encoded = encode_track(track)?;
    let id = RevisionId::new();
    transaction.execute(
        "INSERT INTO editor_track_revisions(
           id, project_id, parent_id, reason, track_zstd, track_hash, cue_count, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id.as_uuid(),
            project_id.as_uuid(),
            parent.map(RevisionId::into_uuid),
            reason.map(RevisionReason::as_str),
            encoded.compressed,
            encoded.hash.as_slice(),
            encoded.cue_count,
            now_ms(),
        ],
    )?;
    Ok(id)
}

pub(super) fn load_revision(
    connection: &Connection,
    project_id: ProjectId,
    revision_id: RevisionId,
    selector: &ProjectTrackSelector,
) -> Result<TrackRevision, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT project_id, parent_id, reason, track_zstd, track_hash, cue_count
             FROM editor_track_revisions WHERE id = ?1",
            [revision_id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, Uuid>(0)?,
                    row.get::<_, Option<Uuid>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or(DatabaseError::CorruptProjectTrackHistory(project_id))?;
    if row.0 != *project_id.as_uuid() || row.5 < 0 {
        return Err(DatabaseError::CorruptProjectTrackHistory(project_id));
    }
    let parent = row
        .1
        .map(RevisionId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))?;
    let reason = row
        .2
        .map(RevisionReason::new)
        .transpose()
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))?;
    let track = decode_track(project_id, &row.3, &row.4)?;
    if track.as_ref().is_some_and(|value| !selector.matches(value))
        || track.as_ref().map_or(0, |value| value.cues().len())
            != usize::try_from(row.5)
                .map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))?
    {
        return Err(DatabaseError::CorruptProjectTrackHistory(project_id));
    }
    Ok(TrackRevision {
        id: revision_id,
        parent,
        reason,
        track,
    })
}

fn encode_track(track: Option<&SubtitleTrack>) -> Result<EncodedTrack, DatabaseError> {
    let raw = serde_json::to_vec(&track).map_err(|error| {
        DatabaseError::InvalidProjectSnapshot(format!("could not serialize editor track: {error}"))
    })?;
    if raw.len() > MAX_RAW_TRACK_BYTES {
        return Err(DatabaseError::ProjectSnapshotTooLarge {
            limit: MAX_RAW_TRACK_BYTES,
            actual: raw.len(),
        });
    }
    let hash = *blake3::hash(&raw).as_bytes();
    let compressed = zstd::stream::encode_all(raw.as_slice(), TRACK_COMPRESSION_LEVEL)?;
    if compressed.len() > MAX_COMPRESSED_TRACK_BYTES {
        return Err(DatabaseError::CompressedProjectSnapshotTooLarge {
            limit: MAX_COMPRESSED_TRACK_BYTES,
            actual: compressed.len(),
        });
    }
    let cue_count = i64::try_from(track.map_or(0, |value| value.cues().len())).map_err(|_| {
        DatabaseError::InvalidProjectSnapshot("editor cue count exceeds SQLite".to_owned())
    })?;
    Ok(EncodedTrack {
        compressed,
        hash,
        cue_count,
    })
}

fn decode_track(
    project_id: ProjectId,
    compressed: &[u8],
    expected_hash: &[u8],
) -> Result<Option<SubtitleTrack>, DatabaseError> {
    if compressed.len() > MAX_COMPRESSED_TRACK_BYTES {
        return Err(DatabaseError::CorruptProjectTrackHistory(project_id));
    }
    let expected_hash: [u8; 32] = expected_hash
        .try_into()
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))?;
    let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed))
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))?;
    let mut raw = Vec::new();
    decoder
        .take(u64::try_from(MAX_RAW_TRACK_BYTES).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut raw)
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))?;
    if raw.len() > MAX_RAW_TRACK_BYTES || blake3::hash(&raw).as_bytes() != &expected_hash {
        return Err(DatabaseError::CorruptProjectTrackHistory(project_id));
    }
    serde_json::from_slice(&raw).map_err(|_| DatabaseError::CorruptProjectTrackHistory(project_id))
}

pub(super) fn delete_revisions(
    transaction: &Transaction<'_>,
    id: ProjectId,
    revisions: &[RevisionId],
) -> Result<(), DatabaseError> {
    if revisions.len() > MAX_TRACK_REVISIONS {
        return Err(DatabaseError::CorruptProjectTrackHistory(id));
    }
    for revision in revisions {
        let deleted = transaction.execute(
            "DELETE FROM editor_track_revisions WHERE id = ?1 AND project_id = ?2",
            params![revision.as_uuid(), id.as_uuid()],
        )?;
        if deleted != 1 {
            return Err(DatabaseError::CorruptProjectTrackHistory(id));
        }
    }
    Ok(())
}

pub(super) fn prune_current_chain(
    transaction: &Transaction<'_>,
    id: ProjectId,
    current: RevisionId,
) -> Result<(), DatabaseError> {
    let mut cursor = current;
    for depth in 0..MAX_TRACK_REVISIONS {
        let parent = revision_parent(transaction, id, cursor)?;
        let Some(parent) = parent else { return Ok(()) };
        if depth + 1 == MAX_TRACK_REVISIONS {
            return Err(DatabaseError::CorruptProjectTrackHistory(id));
        }
        if depth + 2 == MAX_TRACK_REVISIONS {
            let removed_parent = revision_parent(transaction, id, parent)?;
            if let Some(removed) = removed_parent {
                if revision_parent(transaction, id, removed)?.is_some() {
                    return Err(DatabaseError::CorruptProjectTrackHistory(id));
                }
                transaction.execute(
                    "UPDATE editor_track_revisions SET parent_id = NULL WHERE id = ?1",
                    [parent.as_uuid()],
                )?;
                let deleted = transaction.execute(
                    "DELETE FROM editor_track_revisions WHERE id = ?1 AND project_id = ?2",
                    params![removed.as_uuid(), id.as_uuid()],
                )?;
                if deleted != 1 {
                    return Err(DatabaseError::CorruptProjectTrackHistory(id));
                }
            }
            return Ok(());
        }
        cursor = parent;
    }
    Err(DatabaseError::CorruptProjectTrackHistory(id))
}

fn revision_parent(
    connection: &Connection,
    id: ProjectId,
    revision: RevisionId,
) -> Result<Option<RevisionId>, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT project_id, parent_id FROM editor_track_revisions WHERE id = ?1",
            [revision.as_uuid()],
            |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, Option<Uuid>>(1)?)),
        )
        .optional()?
        .ok_or(DatabaseError::CorruptProjectTrackHistory(id))?;
    if row.0 != *id.as_uuid() {
        return Err(DatabaseError::CorruptProjectTrackHistory(id));
    }
    row.1
        .map(RevisionId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))
}

pub(super) fn next_history_version(id: ProjectId, version: u64) -> Result<u64, DatabaseError> {
    version
        .checked_add(1)
        .filter(|next| i64::try_from(*next).is_ok())
        .ok_or(DatabaseError::ProjectTrackHistoryVersionOverflow(id))
}

pub(super) fn stale(id: ProjectId, expected: u64, actual: u64) -> DatabaseError {
    DatabaseError::StaleProjectTrackHistory {
        project_id: id,
        expected,
        actual,
    }
}

const fn origin_name(origin: TrackOrigin) -> &'static str {
    match origin {
        TrackOrigin::LegacyJson => "legacyJson",
        TrackOrigin::Srt => "srt",
    }
}

fn parse_origin(value: &str) -> Option<TrackOrigin> {
    match value {
        "legacyJson" => Some(TrackOrigin::LegacyJson),
        "srt" => Some(TrackOrigin::Srt),
        _ => None,
    }
}
