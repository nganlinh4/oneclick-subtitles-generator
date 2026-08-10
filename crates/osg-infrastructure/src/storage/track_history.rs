use std::collections::HashSet;
use std::io::{Cursor, Read};

use osg_application::{
    MAX_PROJECT_STATE_VERSION, ProjectSnapshot, ProjectTrackHistoryMutation,
    ProjectTrackHistoryStatus, ProjectTrackSelector,
};
use osg_domain::{ProjectId, RevisionId, RevisionReason, SubtitleTrack, TrackOrigin};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use super::actor::now_ms;
use super::error::DatabaseError;
use super::projects;

const MAX_RAW_TRACK_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMPRESSED_TRACK_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRACK_REVISIONS: usize = 256;
const MAX_TRACK_REDO_JSON_BYTES: usize = 64 * 1024;
const MAX_TRACK_REDO_JSON_BYTES_SQL: i64 = 65_536;
const TRACK_COMPRESSION_LEVEL: i32 = 3;
const UNDO_PROJECT_REASON: &str = "Undo subtitle editor revision";
const REDO_PROJECT_REASON: &str = "Redo subtitle editor revision";

#[derive(Debug)]
struct EncodedTrack {
    compressed: Vec<u8>,
    hash: [u8; 32],
    cue_count: i64,
}

#[derive(Debug, Clone)]
struct TrackHeader {
    selector: ProjectTrackSelector,
    history_version: u64,
    current_revision: RevisionId,
    redo: Vec<RevisionId>,
}

#[derive(Debug, Clone)]
struct TrackRevision {
    id: RevisionId,
    parent: Option<RevisionId>,
    reason: Option<RevisionReason>,
    track: Option<SubtitleTrack>,
}

#[derive(Debug)]
struct NavigationInspection {
    current: TrackRevision,
    undo_reason: Option<RevisionReason>,
    redo_reason: Option<RevisionReason>,
    diverged: bool,
}

pub(super) fn status(
    connection: &Connection,
    id: ProjectId,
    selector: &ProjectTrackSelector,
) -> Result<ProjectTrackHistoryStatus, DatabaseError> {
    let snapshot =
        projects::load_project(connection, id)?.ok_or(DatabaseError::ProjectNotFound(id))?;
    let header = read_header(connection, id)?;
    status_for(connection, &snapshot, selector, header.as_ref())
}

pub(super) fn commit(
    connection: &mut Connection,
    id: ProjectId,
    selector: &ProjectTrackSelector,
    expected_history_version: u64,
    before: Option<&SubtitleTrack>,
    after: Option<&SubtitleTrack>,
    reason: &RevisionReason,
) -> Result<ProjectTrackHistoryMutation, DatabaseError> {
    validate_input_tracks(id, selector, before, after)?;
    if before == after {
        let snapshot =
            projects::load_project(connection, id)?.ok_or(DatabaseError::ProjectNotFound(id))?;
        let status = status(connection, id, selector)?;
        return Ok(ProjectTrackHistoryMutation { snapshot, status });
    }

    let transaction = connection.transaction()?;
    let mut snapshot =
        projects::load_project(&transaction, id)?.ok_or(DatabaseError::ProjectNotFound(id))?;
    if snapshot.state_version() >= MAX_PROJECT_STATE_VERSION {
        return Err(DatabaseError::ProjectVersionOverflow(id));
    }
    let actual = selected_track(&snapshot, selector)?;
    let mut header = if let Some(mut existing) = read_header(&transaction, id)? {
        let inspection =
            inspect_navigation(&transaction, id, selector, &existing, actual.as_ref())?;
        if existing.history_version != expected_history_version {
            if !inspection.diverged
                && inspection.current.track.as_ref() == after
                && inspection.current.reason.as_ref() == Some(reason)
            {
                let status = status_from_inspection(
                    snapshot.state_version(),
                    existing.history_version,
                    inspection,
                );
                transaction.commit()?;
                return Ok(ProjectTrackHistoryMutation { snapshot, status });
            }
            return Err(stale(
                id,
                expected_history_version,
                existing.history_version,
            ));
        }

        if inspection.diverged {
            if actual.as_ref() != before {
                return Err(DatabaseError::ProjectTrackHistoryDiverged(id));
            }
            existing = rebase(
                &transaction,
                id,
                selector,
                existing.history_version,
                actual.as_ref(),
            )?;
        } else if inspection.current.track.as_ref() != before {
            if inspection.current.track.as_ref() == after
                && inspection.current.reason.as_ref() == Some(reason)
            {
                let status = status_from_inspection(
                    snapshot.state_version(),
                    existing.history_version,
                    inspection,
                );
                transaction.commit()?;
                return Ok(ProjectTrackHistoryMutation { snapshot, status });
            }
            return Err(DatabaseError::ProjectTrackHistoryDiverged(id));
        }
        existing
    } else {
        if expected_history_version != 0 {
            return Err(stale(id, expected_history_version, 0));
        }
        let baseline = if actual.as_ref() == before {
            actual.clone()
        } else if actual.is_none() && before.is_some() {
            before.cloned()
        } else {
            return Err(DatabaseError::ProjectTrackHistoryDiverged(id));
        };
        let root = insert_revision(&transaction, id, None, None, baseline.as_ref())?;
        TrackHeader {
            selector: selector.clone(),
            history_version: 0,
            current_revision: root,
            redo: Vec::new(),
        }
    };

    delete_revisions(&transaction, id, &header.redo)?;
    let revision = insert_revision(
        &transaction,
        id,
        Some(header.current_revision),
        Some(reason),
        after,
    )?;
    snapshot = persist_selected_track(&transaction, &snapshot, selector, after, reason)?;
    header.current_revision = revision;
    header.redo.clear();
    header.history_version = next_history_version(id, header.history_version)?;
    write_header(&transaction, id, &header)?;
    prune_current_chain(&transaction, id, header.current_revision)?;

    let status = status_for(&transaction, &snapshot, selector, Some(&header))?;
    transaction.commit()?;
    Ok(ProjectTrackHistoryMutation { snapshot, status })
}

pub(super) fn undo(
    connection: &mut Connection,
    id: ProjectId,
    selector: &ProjectTrackSelector,
    expected_history_version: u64,
    expected_reason: &RevisionReason,
) -> Result<Option<ProjectTrackHistoryMutation>, DatabaseError> {
    navigate(
        connection,
        id,
        selector,
        expected_history_version,
        expected_reason,
        Direction::Undo,
    )
}

pub(super) fn redo(
    connection: &mut Connection,
    id: ProjectId,
    selector: &ProjectTrackSelector,
    expected_history_version: u64,
    expected_reason: &RevisionReason,
) -> Result<Option<ProjectTrackHistoryMutation>, DatabaseError> {
    navigate(
        connection,
        id,
        selector,
        expected_history_version,
        expected_reason,
        Direction::Redo,
    )
}

#[derive(Debug, Clone, Copy)]
enum Direction {
    Undo,
    Redo,
}

fn navigate(
    connection: &mut Connection,
    id: ProjectId,
    selector: &ProjectTrackSelector,
    expected_history_version: u64,
    expected_reason: &RevisionReason,
    direction: Direction,
) -> Result<Option<ProjectTrackHistoryMutation>, DatabaseError> {
    let transaction = connection.transaction()?;
    let mut snapshot =
        projects::load_project(&transaction, id)?.ok_or(DatabaseError::ProjectNotFound(id))?;
    let Some(mut header) = read_header(&transaction, id)? else {
        return Ok(None);
    };
    if header.history_version != expected_history_version {
        return Err(stale(id, expected_history_version, header.history_version));
    }
    let actual = selected_track(&snapshot, selector)?;
    let inspection = inspect_navigation(&transaction, id, selector, &header, actual.as_ref())?;
    if inspection.diverged {
        return Err(DatabaseError::ProjectTrackHistoryDiverged(id));
    }
    if snapshot.state_version() >= MAX_PROJECT_STATE_VERSION {
        return Err(DatabaseError::ProjectVersionOverflow(id));
    }

    let (target, project_reason) = match direction {
        Direction::Undo => {
            let Some(parent) = inspection.current.parent else {
                return Ok(None);
            };
            if inspection.current.reason.as_ref() != Some(expected_reason) {
                return Ok(None);
            }
            if header.redo.len() >= MAX_TRACK_REVISIONS {
                return Err(DatabaseError::CorruptProjectTrackHistory(id));
            }
            header.redo.push(header.current_revision);
            (
                load_revision(&transaction, id, parent, selector)?,
                RevisionReason::new(UNDO_PROJECT_REASON)
                    .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?,
            )
        }
        Direction::Redo => {
            let Some(target_id) = header.redo.last().copied() else {
                return Ok(None);
            };
            let target = load_revision(&transaction, id, target_id, selector)?;
            if target.parent != Some(header.current_revision) {
                return Err(DatabaseError::CorruptProjectTrackHistory(id));
            }
            if target.reason.as_ref() != Some(expected_reason) {
                return Ok(None);
            }
            header.redo.pop();
            (
                target,
                RevisionReason::new(REDO_PROJECT_REASON)
                    .map_err(|_| DatabaseError::CorruptProjectTrackHistory(id))?,
            )
        }
    };

    snapshot = persist_selected_track(
        &transaction,
        &snapshot,
        selector,
        target.track.as_ref(),
        &project_reason,
    )?;
    header.current_revision = target.id;
    header.history_version = next_history_version(id, header.history_version)?;
    write_header(&transaction, id, &header)?;
    let status = status_for(&transaction, &snapshot, selector, Some(&header))?;
    transaction.commit()?;
    Ok(Some(ProjectTrackHistoryMutation { snapshot, status }))
}

fn validate_input_tracks(
    id: ProjectId,
    selector: &ProjectTrackSelector,
    before: Option<&SubtitleTrack>,
    after: Option<&SubtitleTrack>,
) -> Result<(), DatabaseError> {
    if before.is_some_and(|track| !selector.matches(track))
        || after.is_some_and(|track| !selector.matches(track))
        || matches!((before, after), (Some(left), Some(right)) if left.id() != right.id())
    {
        return Err(DatabaseError::InvalidProjectSnapshot(format!(
            "editor track does not match its selector for project {id}"
        )));
    }
    Ok(())
}

fn status_for(
    connection: &Connection,
    snapshot: &ProjectSnapshot,
    selector: &ProjectTrackSelector,
    header: Option<&TrackHeader>,
) -> Result<ProjectTrackHistoryStatus, DatabaseError> {
    let Some(header) = header else {
        selected_track(snapshot, selector)?;
        return Ok(ProjectTrackHistoryStatus::new(
            snapshot.state_version(),
            0,
            false,
            None,
            None,
        ));
    };
    let actual = selected_track(snapshot, selector)?;
    let inspection = inspect_navigation(
        connection,
        snapshot.metadata().id(),
        selector,
        header,
        actual.as_ref(),
    )?;
    Ok(status_from_inspection(
        snapshot.state_version(),
        header.history_version,
        inspection,
    ))
}

fn status_from_inspection(
    state_version: u64,
    history_version: u64,
    inspection: NavigationInspection,
) -> ProjectTrackHistoryStatus {
    ProjectTrackHistoryStatus::new(
        state_version,
        history_version,
        inspection.diverged,
        inspection.undo_reason,
        inspection.redo_reason,
    )
}

fn inspect_navigation(
    connection: &Connection,
    id: ProjectId,
    selector: &ProjectTrackSelector,
    header: &TrackHeader,
    actual: Option<&SubtitleTrack>,
) -> Result<NavigationInspection, DatabaseError> {
    if &header.selector != selector || header.redo.len() > MAX_TRACK_REVISIONS {
        return Err(DatabaseError::CorruptProjectTrackHistory(id));
    }

    let mut seen = HashSet::new();
    let mut cursor = Some(header.current_revision);
    let mut current = None;
    for depth in 0..=MAX_TRACK_REVISIONS {
        let Some(revision_id) = cursor else { break };
        if depth == MAX_TRACK_REVISIONS || !seen.insert(revision_id) {
            return Err(DatabaseError::CorruptProjectTrackHistory(id));
        }
        let revision = load_revision(connection, id, revision_id, selector)?;
        cursor = revision.parent;
        if current.is_none() {
            current = Some(revision);
        }
    }
    let current = current.ok_or(DatabaseError::CorruptProjectTrackHistory(id))?;
    let undo_reason = if current.parent.is_some() {
        Some(
            current
                .reason
                .clone()
                .ok_or(DatabaseError::CorruptProjectTrackHistory(id))?,
        )
    } else {
        None
    };

    let mut expected_parent = header.current_revision;
    for revision_id in header.redo.iter().rev().copied() {
        if !seen.insert(revision_id) {
            return Err(DatabaseError::CorruptProjectTrackHistory(id));
        }
        let revision = load_revision(connection, id, revision_id, selector)?;
        if revision.parent != Some(expected_parent) || revision.reason.is_none() {
            return Err(DatabaseError::CorruptProjectTrackHistory(id));
        }
        expected_parent = revision_id;
    }
    let redo_reason = header
        .redo
        .last()
        .copied()
        .map(|revision_id| load_revision(connection, id, revision_id, selector))
        .transpose()?
        .and_then(|revision| revision.reason);

    Ok(NavigationInspection {
        diverged: current.track.as_ref() != actual,
        current,
        undo_reason,
        redo_reason,
    })
}

fn selected_track(
    snapshot: &ProjectSnapshot,
    selector: &ProjectTrackSelector,
) -> Result<Option<SubtitleTrack>, DatabaseError> {
    let mut matches = snapshot
        .tracks()
        .iter()
        .filter(|track| selector.matches(track));
    let selected = matches.next().cloned();
    if matches.next().is_some() {
        return Err(DatabaseError::AmbiguousProjectTrackSelector(
            snapshot.metadata().id(),
        ));
    }
    Ok(selected)
}

fn persist_selected_track(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
    selector: &ProjectTrackSelector,
    replacement: Option<&SubtitleTrack>,
    reason: &RevisionReason,
) -> Result<ProjectSnapshot, DatabaseError> {
    let mut tracks = snapshot.tracks().to_vec();
    let matching = tracks
        .iter()
        .enumerate()
        .filter_map(|(index, track)| selector.matches(track).then_some(index))
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(DatabaseError::AmbiguousProjectTrackSelector(
            snapshot.metadata().id(),
        ));
    }
    match (matching.first().copied(), replacement) {
        (Some(index), Some(track)) => tracks[index] = track.clone(),
        (Some(index), None) => {
            tracks.remove(index);
        }
        (None, Some(track)) => tracks.push(track.clone()),
        (None, None) => {}
    }
    let candidate = ProjectSnapshot::new(
        snapshot.metadata().clone(),
        snapshot.state_version(),
        snapshot.media().to_vec(),
        tracks,
    )
    .map_err(|error| DatabaseError::InvalidProjectSnapshot(error.to_string()))?;
    if candidate == *snapshot {
        return Ok(snapshot.clone());
    }
    projects::commit_project_transaction(transaction, &candidate, reason).map(|(_, saved)| saved)
}

fn rebase(
    transaction: &Transaction<'_>,
    id: ProjectId,
    selector: &ProjectTrackSelector,
    history_version: u64,
    actual: Option<&SubtitleTrack>,
) -> Result<TrackHeader, DatabaseError> {
    transaction.execute(
        "DELETE FROM editor_track_navigation WHERE project_id = ?1",
        [id.as_uuid()],
    )?;
    transaction.execute(
        "DELETE FROM editor_track_revisions WHERE project_id = ?1",
        [id.as_uuid()],
    )?;
    let root = insert_revision(transaction, id, None, None, actual)?;
    Ok(TrackHeader {
        selector: selector.clone(),
        history_version,
        current_revision: root,
        redo: Vec::new(),
    })
}

fn read_header(
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

fn write_header(
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

fn insert_revision(
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

fn load_revision(
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

fn delete_revisions(
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

fn prune_current_chain(
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

fn next_history_version(id: ProjectId, version: u64) -> Result<u64, DatabaseError> {
    version
        .checked_add(1)
        .filter(|next| i64::try_from(*next).is_ok())
        .ok_or(DatabaseError::ProjectTrackHistoryVersionOverflow(id))
}

fn stale(id: ProjectId, expected: u64, actual: u64) -> DatabaseError {
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use osg_application::{ProjectSnapshot, ProjectTrackSelector};
    use osg_domain::{
        MediaAsset, MediaKind, ProjectMetadata, RevisionReason, SubtitleCue, SubtitleTrack,
        TrackOrigin,
    };
    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::{MAX_TRACK_REDO_JSON_BYTES, MAX_TRACK_REVISIONS};
    use crate::storage::{Database, DatabaseError};

    fn database() -> (TempDir, PathBuf, Database) {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("db/osg.sqlite3");
        let database = Database::open(&path).expect("open database");
        (directory, path, database)
    }

    fn selector() -> ProjectTrackSelector {
        ProjectTrackSelector::new("Cached subtitles", TrackOrigin::LegacyJson)
            .expect("valid selector")
    }

    fn reason(value: &str) -> RevisionReason {
        RevisionReason::new(value).expect("valid reason")
    }

    fn track(text: &str) -> SubtitleTrack {
        SubtitleTrack::new(
            "Cached subtitles",
            TrackOrigin::LegacyJson,
            vec![SubtitleCue::new(0, 1_000, text.to_owned()).expect("valid cue")],
        )
        .expect("valid track")
    }

    fn revise(base: &SubtitleTrack, text: &str) -> SubtitleTrack {
        let cue = &base.cues()[0];
        SubtitleTrack::restore(
            base.id(),
            base.label(),
            base.origin(),
            vec![
                SubtitleCue::restore(
                    cue.id(),
                    1,
                    cue.start_ms(),
                    cue.end_ms(),
                    text.to_owned(),
                    cue.source_id(),
                )
                .expect("valid revised cue"),
            ],
        )
        .expect("valid revised track")
    }

    fn snapshot_with(
        base: &ProjectSnapshot,
        media: Vec<MediaAsset>,
        track: &SubtitleTrack,
    ) -> ProjectSnapshot {
        ProjectSnapshot::new(
            base.metadata().clone(),
            base.state_version(),
            media,
            vec![track.clone()],
        )
        .expect("valid snapshot")
    }

    fn seeded(database: &Database) -> (ProjectMetadata, SubtitleTrack, ProjectSnapshot) {
        let metadata = ProjectMetadata::new("Editor history").expect("valid project");
        let created = database.create_project(&metadata).expect("create project");
        let initial_track = track("A");
        let seeded = snapshot_with(&created, Vec::new(), &initial_track);
        database
            .commit_project(&seeded, &reason("Initial subtitles"))
            .expect("seed subtitles");
        let loaded = database
            .load_project(metadata.id())
            .expect("load project")
            .expect("project exists");
        (metadata, initial_track, loaded)
    }

    #[test]
    fn track_undo_crosses_unrelated_revisions_without_reverting_media() {
        let (_directory, _path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let edited = revise(&initial, "B");
        let committed = database
            .commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&edited),
                &reason("Editor text"),
            )
            .expect("commit editor track");
        assert_eq!(committed.status.history_version, 1);

        let media =
            MediaAsset::new("movie.mp4", "mp4", 4_096, MediaKind::Video).expect("valid media");
        let with_media = snapshot_with(&committed.snapshot, vec![media.clone()], &edited);
        database
            .commit_project(&with_media, &reason("Attach media"))
            .expect("commit unrelated media");

        let undone = database
            .undo_project_track(metadata.id(), &selector(), 1, &reason("Editor text"))
            .expect("undo editor track")
            .expect("undo target");
        assert_eq!(undone.snapshot.media(), &[media]);
        assert_eq!(undone.snapshot.tracks()[0], initial);
        assert_eq!(undone.status.history_version, 2);
        assert!(undone.status.can_redo);
    }

    #[test]
    fn restart_preserves_track_cursor_and_guarded_navigation() {
        let (_directory, path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let edited = revise(&initial, "B");
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&edited),
                &reason("Editor text"),
            )
            .expect("commit editor track");
        drop(database);

        let reopened = Database::open(path).expect("reopen database");
        let status = reopened
            .project_track_history_status(metadata.id(), &selector())
            .expect("load cursor");
        assert_eq!(status.history_version, 1);
        assert_eq!(status.undo_reason, Some(reason("Editor text")));
        assert!(
            reopened
                .undo_project_track(
                    metadata.id(),
                    &selector(),
                    status.history_version,
                    &reason("Wrong reason"),
                )
                .expect("guard mismatch is safe")
                .is_none()
        );
        assert_eq!(
            reopened
                .project_track_history_status(metadata.id(), &selector())
                .expect("unchanged cursor")
                .history_version,
            1
        );
    }

    #[test]
    fn stale_writer_cannot_overwrite_a_newer_track_revision() {
        let (_directory, _path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let second = revise(&initial, "B");
        let third = revise(&initial, "C");
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&second),
                &reason("First writer"),
            )
            .expect("first writer commits");
        assert!(matches!(
            database.commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&third),
                &reason("Stale writer"),
            ),
            Err(DatabaseError::StaleProjectTrackHistory {
                expected: 0,
                actual: 1,
                ..
            })
        ));
        let loaded = database
            .load_project(metadata.id())
            .expect("load project")
            .expect("project exists");
        assert_eq!(loaded.tracks()[0], second);
    }

    #[test]
    fn branch_after_undo_clears_only_track_redo_and_preserves_latest_media() {
        let (_directory, path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let second = revise(&initial, "B");
        let third = revise(&initial, "C");
        let branch = revise(&initial, "D");
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&second),
                &reason("B"),
            )
            .expect("commit B");
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                1,
                Some(&second),
                Some(&third),
                &reason("C"),
            )
            .expect("commit C");
        database
            .undo_project_track(metadata.id(), &selector(), 2, &reason("C"))
            .expect("undo C")
            .expect("undo target");

        let media =
            MediaAsset::new("latest.mp4", "mp4", 8_192, MediaKind::Video).expect("valid media");
        let current = database
            .load_project(metadata.id())
            .expect("load project")
            .expect("project exists");
        database
            .commit_project(
                &snapshot_with(&current, vec![media.clone()], &second),
                &reason("Unrelated media"),
            )
            .expect("commit media");
        let committed = database
            .commit_project_track(
                metadata.id(),
                &selector(),
                3,
                Some(&second),
                Some(&branch),
                &reason("D"),
            )
            .expect("commit branch");
        assert_eq!(committed.snapshot.media(), &[media]);
        assert_eq!(committed.snapshot.tracks()[0], branch);
        assert!(!committed.status.can_redo);

        drop(database);
        let connection = Connection::open(path).expect("open database directly");
        let revision_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM editor_track_revisions WHERE project_id = ?1",
                [metadata.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("count revisions");
        assert_eq!(revision_count, 3, "the abandoned C branch is deleted");
    }

    #[test]
    fn corrupt_track_hash_is_rejected() {
        let (_directory, path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let edited = revise(&initial, "B");
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&edited),
                &reason("B"),
            )
            .expect("commit B");
        drop(database);

        let connection = Connection::open(&path).expect("open database directly");
        connection
            .execute(
                "UPDATE editor_track_revisions SET track_hash = zeroblob(32)
                 WHERE id = (SELECT current_revision_id FROM editor_track_navigation
                             WHERE project_id = ?1)",
                [metadata.id().as_uuid()],
            )
            .expect("corrupt hash");
        drop(connection);
        let corrupt = Database::open(&path).expect("reopen corrupt database");
        assert!(matches!(
            corrupt.project_track_history_status(metadata.id(), &selector()),
            Err(DatabaseError::CorruptProjectTrackHistory(id)) if id == metadata.id()
        ));
    }

    #[test]
    fn oversized_redo_json_is_rejected_before_parsing() {
        let (_directory, path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let edited = revise(&initial, "B");
        database
            .commit_project_track(
                metadata.id(),
                &selector(),
                0,
                Some(&initial),
                Some(&edited),
                &reason("B"),
            )
            .expect("commit B");
        drop(database);

        let connection = Connection::open(&path).expect("open database directly");
        let current: uuid::Uuid = connection
            .query_row(
                "SELECT current_revision_id FROM editor_track_navigation WHERE project_id = ?1",
                [metadata.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("read current revision");
        let repeated = serde_json::to_string(&vec![current.to_string(); MAX_TRACK_REVISIONS * 8])
            .expect("serialize oversized redo");
        assert!(repeated.len() > MAX_TRACK_REDO_JSON_BYTES);
        connection
            .execute(
                "UPDATE editor_track_navigation SET redo_stack_json = ?1 WHERE project_id = ?2",
                rusqlite::params![repeated, metadata.id().as_uuid()],
            )
            .expect("store oversized redo");
        drop(connection);

        let corrupt = Database::open(path).expect("reopen database");
        assert!(matches!(
            corrupt.project_track_history_status(metadata.id(), &selector()),
            Err(DatabaseError::CorruptProjectTrackHistory(id)) if id == metadata.id()
        ));
    }

    #[test]
    fn retained_track_history_is_bounded() {
        let (_directory, path, database) = database();
        let (metadata, initial, _) = seeded(&database);
        let mut current = initial;
        for index in 0..(MAX_TRACK_REVISIONS + 20) {
            let next = revise(&current, &format!("edit {index}"));
            database
                .commit_project_track(
                    metadata.id(),
                    &selector(),
                    u64::try_from(index).expect("bounded index"),
                    Some(&current),
                    Some(&next),
                    &reason("Editor text"),
                )
                .expect("commit bounded edit");
            current = next;
        }
        drop(database);

        let connection = Connection::open(path).expect("open database directly");
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM editor_track_revisions WHERE project_id = ?1",
                [metadata.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("count retained revisions");
        assert_eq!(
            count,
            i64::try_from(MAX_TRACK_REVISIONS).expect("bounded maximum")
        );
    }
}
