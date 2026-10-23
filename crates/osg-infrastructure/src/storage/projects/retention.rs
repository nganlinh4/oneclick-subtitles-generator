//! Bounded revision retention: startup reconciliation of legacy graphs and pruning of
//! detached or overflowing revisions.

use std::collections::{HashMap, HashSet};

use osg_domain::{ProjectId, RevisionId};
use rusqlite::{Connection, Transaction, params};
use uuid::Uuid;

use super::revisions::{read_header_unbounded, revision_parent};
use super::{
    LEGACY_REVISION_QUERY_LIMIT, MAX_CURRENT_REVISIONS, MAX_LEGACY_PROJECT_REVISIONS,
    MAX_PROJECTS_TO_RECONCILE, MAX_REDO_REVISIONS, PROJECT_RECONCILE_QUERY_LIMIT,
};
use crate::storage::error::DatabaseError;

/// Normalize revision graphs created before whole-project retention became bounded.
///
/// This runs after schema migration and before the database actor accepts requests. It retains the
/// active current/redo graph, trims it to the supported bounds, and removes old detached branches.
/// Invalid active topology is still treated as corruption rather than silently repaired.
pub(in crate::storage) fn reconcile_revision_retention(
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

pub(super) fn delete_revisions(
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

pub(super) fn prune_current_chain(
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

pub(super) fn push_bounded(
    redo: &mut Vec<RevisionId>,
    revision_id: RevisionId,
) -> Option<RevisionId> {
    let dropped = (redo.len() == MAX_REDO_REVISIONS).then(|| redo.remove(0));
    redo.push(revision_id);
    dropped
}
