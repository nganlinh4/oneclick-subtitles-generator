use std::collections::HashSet;

use osg_application::{
    MAX_PROJECT_STATE_VERSION, ProjectSnapshot, ProjectTrackHistoryMutation,
    ProjectTrackHistoryStatus, ProjectTrackSelector,
};
use osg_domain::{ProjectId, RevisionId, RevisionReason, SubtitleTrack};
use rusqlite::{Connection, Transaction};

use super::error::DatabaseError;
use super::projects;

mod rows;

use rows::{
    delete_revisions, insert_revision, load_revision, next_history_version, prune_current_chain,
    read_header, stale, write_header,
};

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

#[cfg(test)]
mod tests;
