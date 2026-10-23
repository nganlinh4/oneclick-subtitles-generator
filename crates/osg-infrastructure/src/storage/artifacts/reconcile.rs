//! Startup reconciliation between artifact rows and the files under the artifact root.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use super::cache::purge_expired_cache;
use super::root::{
    final_path, remove_if_regular, remove_owned_entry, seal_file, staging_name, trash_name,
    validate_file,
};
use super::rows::{list, transition_failed};
use super::{
    ArtifactFailureCode, ArtifactId, ArtifactRecord, ArtifactRoot, ArtifactState,
    COMMIT_ON_JOB_SUCCESS_METADATA_KEY, MAX_ARTIFACTS, MAX_ROOT_ENTRIES,
    MEDIA_ARTIFACT_METADATA_KEY, ROOT_IDENTITY_FILE, ReconciliationReport, get, remove,
};
use crate::storage::DatabaseError;
use crate::storage::actor::now_ms;

#[allow(
    clippy::too_many_lines,
    reason = "startup reconciliation keeps filesystem repair and provisional job-commit recovery in one bounded scan"
)]
pub(in crate::storage) fn reconcile(
    connection: &Connection,
    root: &ArtifactRoot,
) -> Result<ReconciliationReport, DatabaseError> {
    root.verify()?;
    repair_media_owned_cache_retention(connection)?;
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [now_ms()],
    )?;
    let removed_expired_media_candidates =
        crate::storage::media::cleanup_expired_candidates(connection, now_ms())?;
    let records = list(connection)?;
    if u64::try_from(records.len()).unwrap_or(u64::MAX) > MAX_ARTIFACTS {
        return Err(DatabaseError::ArtifactLimitReached);
    }
    let mut report = ReconciliationReport {
        removed_expired_media_candidates,
        ..ReconciliationReport::default()
    };
    let failure = ArtifactFailureCode::new("startupReconciliation")?;
    let mut expected = HashSet::from([ROOT_IDENTITY_FILE.to_owned()]);
    for record in records {
        crate::storage::media::cleanup_failed_artifact_candidates(connection, record.id)?;
        let media_owned = artifact_has_media_owner(connection, record.id)?;
        if artifact_requires_successful_job(&record) && !media_owned {
            match artifact_job_state(connection, &record)?.as_deref() {
                Some("succeeded") => {}
                Some("queued" | "running" | "cancelling")
                    if record.state == ArtifactState::Pending =>
                {
                    expected.insert(staging_name(record.id));
                    if final_path(root, &record)?.is_file() {
                        expected.insert(record.relative_path.clone());
                    }
                    continue;
                }
                _ => {
                    let _ = remove(connection, root, record.id)?;
                    continue;
                }
            }
        }
        let final_path = final_path(root, &record)?;
        let staging_path = root.child(&staging_name(record.id))?;
        let trash_path = root.child(&trash_name(record.id))?;
        match record.state {
            ArtifactState::Pending => {
                if validate_file(&final_path, &record).is_ok()
                    || (validate_file(&staging_path, &record).is_ok()
                        && publish_existing_stage(&staging_path, &final_path, &record).is_ok())
                {
                    remove_if_regular(&staging_path)?;
                    seal_file(&final_path)?;
                    root.verify()?;
                    connection.execute(
                        "UPDATE artifacts SET state = 'ready', failure_code = NULL,
                         updated_at_ms = ?1 WHERE id = ?2 AND state = 'pending'",
                        params![now_ms(), record.id.as_uuid()],
                    )?;
                    expected.insert(record.relative_path.clone());
                    report.promoted_pending = report.promoted_pending.saturating_add(1);
                } else {
                    transition_failed(connection, record.id, &failure)?;
                    let _ = remove_if_regular(&staging_path);
                    let _ = remove_if_regular(&final_path);
                    report.marked_failed = report.marked_failed.saturating_add(1);
                }
            }
            ArtifactState::Ready => {
                if validate_file(&final_path, &record).is_ok() {
                    expected.insert(record.relative_path.clone());
                } else if validate_file(&trash_path, &record).is_ok() && !final_path.exists() {
                    fs::rename(&trash_path, &final_path)?;
                    validate_file(&final_path, &record)?;
                    expected.insert(record.relative_path.clone());
                    report.restored_removals = report.restored_removals.saturating_add(1);
                } else {
                    transition_failed(connection, record.id, &failure)?;
                    let _ = remove_if_regular(&final_path);
                    let _ = remove_if_regular(&trash_path);
                    report.marked_failed = report.marked_failed.saturating_add(1);
                }
            }
            ArtifactState::Failed => {
                let _ = remove_if_regular(&staging_path);
                let _ = remove_if_regular(&final_path);
                let _ = remove_if_regular(&trash_path);
            }
        }
        let current_is_ready = get(connection, record.id)?
            .is_some_and(|current| current.state == ArtifactState::Ready);
        if current_is_ready
            && artifact_is_media_publication(&record)
            && !crate::storage::media::artifact_has_persistent_owner(connection, record.id)?
            && !artifact_job_state(connection, &record)?
                .as_deref()
                .is_some_and(|state| matches!(state, "queued" | "running" | "cancelling"))
        {
            let _ = remove(connection, root, record.id)?;
            expected.remove(&record.relative_path);
            report.removed_unowned_media = report.removed_unowned_media.saturating_add(1);
        }
    }

    purge_expired_cache(connection, root)?;

    let mut statement = connection.prepare(
        "SELECT id FROM artifacts a
         WHERE a.retention = 'cache'
           AND NOT EXISTS(SELECT 1 FROM cache_entries ce WHERE ce.artifact_id = a.id)",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, Uuid>(0))?;
    let mut unreferenced = Vec::new();
    for row in rows {
        unreferenced.push(ArtifactId::from_uuid(row?)?);
    }
    drop(statement);
    for id in unreferenced {
        if let Some(record) = remove(connection, root, id)? {
            expected.remove(&record.relative_path);
            report.removed_unreferenced_cache = report.removed_unreferenced_cache.saturating_add(1);
        }
    }

    let mut entries = fs::read_dir(&root.canonical)?;
    for index in 0..=MAX_ROOT_ENTRIES {
        let Some(entry) = entries.next() else {
            break;
        };
        if index == MAX_ROOT_ENTRIES {
            return Err(DatabaseError::ArtifactRootEntryLimitReached);
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            remove_owned_entry(&entry.path())?;
            report.removed_orphans = report.removed_orphans.saturating_add(1);
            continue;
        };
        if !expected.contains(name) {
            remove_owned_entry(&entry.path())?;
            report.removed_orphans = report.removed_orphans.saturating_add(1);
        }
    }
    Ok(report)
}

fn artifact_requires_successful_job(record: &ArtifactRecord) -> bool {
    record
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get(COMMIT_ON_JOB_SUCCESS_METADATA_KEY))
        .and_then(Value::as_bool)
        == Some(true)
}

fn artifact_is_media_publication(record: &ArtifactRecord) -> bool {
    record
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get(MEDIA_ARTIFACT_METADATA_KEY))
        .and_then(Value::as_bool)
        == Some(true)
}

pub(super) fn artifact_has_media_owner(
    connection: &Connection,
    artifact_id: ArtifactId,
) -> Result<bool, DatabaseError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_artifacts WHERE artifact_id = ?1)",
            [artifact_id.as_uuid()],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

/// Repairs the one ownership shape that cache clearing must never accept. Versions predating the
/// registration guard could attach a media identity to a cache-retention artifact. Media ownership
/// is durable, so upgrade those rows before any expiry, clear, or unreferenced-cache pass can select
/// them for deletion.
pub(super) fn repair_media_owned_cache_retention(
    connection: &Connection,
) -> Result<(), DatabaseError> {
    connection.execute(
        "UPDATE artifacts
         SET retention = 'durable', updated_at_ms = ?1
         WHERE retention = 'cache'
           AND EXISTS(
             SELECT 1 FROM media_artifacts owner WHERE owner.artifact_id = artifacts.id
           )",
        [now_ms()],
    )?;
    Ok(())
}

fn artifact_job_state(
    connection: &Connection,
    record: &ArtifactRecord,
) -> Result<Option<String>, DatabaseError> {
    let Some(job_id) = record.job_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT state FROM jobs WHERE id = ?1",
            [job_id.into_uuid()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn publish_existing_stage(
    staging_path: &Path,
    final_path: &Path,
    record: &ArtifactRecord,
) -> Result<(), DatabaseError> {
    if !final_path.exists() {
        match fs::hard_link(staging_path, final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    validate_file(final_path, record)
}
