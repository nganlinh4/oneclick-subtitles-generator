//! Artifact registration and lifecycle: staging, ready/failed transitions, resolution, and removal.

use std::fs::{self, OpenOptions};

use osg_domain::{AssetId, JobId, ProjectId};
use rusqlite::{Connection, OptionalExtension, params};

use super::root::{
    final_name, final_path, remove_if_regular, seal_file, staging_name, trash_name, validate_file,
};
use super::rows::{
    decode_artifact, ensure_artifact_capacity, find_by_content, raw_artifact, retention_name,
    transition_failed, validate_size,
};
use super::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRecord,
    ArtifactRegistration, ArtifactRetention, ArtifactRoot, ArtifactStaging, ArtifactState,
    MAX_ARTIFACT_METADATA_BYTES, ResolvedArtifact, TransactionalArtifactRemoval,
};
use crate::storage::DatabaseError;
use crate::storage::actor::now_ms;

pub(in crate::storage) fn register(
    connection: &mut Connection,
    root: &ArtifactRoot,
    draft: &ArtifactDraft,
) -> Result<ArtifactRegistration, DatabaseError> {
    register_inner(connection, root, draft, None)
}

pub(in crate::storage) fn register_media(
    connection: &mut Connection,
    root: &ArtifactRoot,
    draft: &ArtifactDraft,
    media_id: AssetId,
    job_id: JobId,
) -> Result<ArtifactRegistration, DatabaseError> {
    register_inner(connection, root, draft, Some((media_id, job_id)))
}

fn register_inner(
    connection: &mut Connection,
    root: &ArtifactRoot,
    draft: &ArtifactDraft,
    media_claim: Option<(AssetId, JobId)>,
) -> Result<ArtifactRegistration, DatabaseError> {
    root.verify()?;
    validate_size(draft.size_bytes)?;
    // A media ownership edge is a durable lifetime claim even before a project attaches the
    // asset.  Allowing cache retention here would let an ordinary cache clear invalidate that
    // media identity.  Keep this invariant at registration rather than relying on every caller
    // to choose the right retention class.
    if draft.retention == ArtifactRetention::Cache
        && (draft.project_id.is_some() || media_claim.is_some())
    {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let metadata_json = serde_json::to_string(&draft.metadata)?;
    if metadata_json.len() > MAX_ARTIFACT_METADATA_BYTES {
        return Err(DatabaseError::ArtifactMetadataTooLarge);
    }
    crate::storage::media::validate_media_artifact_draft(&draft.kind, &draft.metadata)?;
    if let Some(existing) = find_by_content(connection, &draft.kind, draft.content_hash)? {
        if existing.size_bytes != draft.size_bytes {
            return Err(DatabaseError::ArtifactContentMismatch(existing.id));
        }
        let reusable = match (draft.retention, existing.retention) {
            (ArtifactRetention::Cache, _) => true,
            (ArtifactRetention::Durable, ArtifactRetention::Durable) => {
                draft.project_id == existing.project_id
            }
            (ArtifactRetention::Durable, ArtifactRetention::Cache) => false,
        };
        if !reusable {
            return Err(DatabaseError::ArtifactReuseConflict(existing.id));
        }
        if !crate::storage::media::artifact_metadata_semantically_compatible(
            &draft.kind,
            existing.metadata(),
            &draft.metadata,
        ) {
            return Err(DatabaseError::ArtifactReuseConflict(existing.id));
        }
        let existing =
            adopt_compatible_legacy_media_metadata(connection, existing, draft, &metadata_json)?;
        match existing.state {
            ArtifactState::Ready => {
                if let Some((media_id, job_id)) = media_claim {
                    claim_existing_media_edge(connection, media_id, existing.id, job_id)?;
                }
                return Ok(ArtifactRegistration::Existing(existing));
            }
            ArtifactState::Pending => return Ok(ArtifactRegistration::Pending(existing)),
            ArtifactState::Failed => {
                if draft.retention != existing.retention || draft.project_id != existing.project_id
                {
                    return Err(DatabaseError::ArtifactReuseConflict(existing.id));
                }
                return reset_failed_for_retry(
                    connection,
                    root,
                    &existing,
                    draft,
                    &metadata_json,
                    media_claim,
                );
            }
        }
    }
    let count: i64 =
        connection.query_row("SELECT COUNT(*) FROM artifacts", [], |row| row.get(0))?;
    ensure_artifact_capacity(count)?;

    let id = ArtifactId::new();
    let relative_path = final_name(&draft.kind, draft.content_hash);
    let timestamp = now_ms();
    connection.execute(
        "INSERT INTO artifacts(
           id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
           retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL, ?9, ?10, ?10)",
        params![
            id.as_uuid(),
            draft.project_id.map(ProjectId::into_uuid),
            draft.job_id.map(JobId::into_uuid),
            draft.kind.as_str(),
            relative_path,
            draft.content_hash.as_bytes().as_slice(),
            i64::try_from(draft.size_bytes).map_err(|_| DatabaseError::InvalidArtifactSize)?,
            retention_name(draft.retention),
            metadata_json,
            timestamp,
        ],
    )?;
    let record = get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))?;
    let path = root.child(&staging_name(id))?;
    if let Err(error) = OpenOptions::new().write(true).create_new(true).open(&path) {
        let failure = ArtifactFailureCode::new("stagingCreate")?;
        let _ = fail(connection, root, id, &failure);
        return Err(DatabaseError::Io(error));
    }
    Ok(ArtifactRegistration::Staging(ArtifactStaging {
        record,
        path,
    }))
}

fn claim_existing_media_edge(
    connection: &Connection,
    media_id: AssetId,
    artifact_id: ArtifactId,
    job_id: JobId,
) -> Result<(), DatabaseError> {
    connection.execute(
        "INSERT OR IGNORE INTO media_artifact_job_claims(
           media_id, artifact_id, job_id, created_at_ms
         )
         SELECT media_id, artifact_id, ?3, ?4
         FROM media_artifacts
         WHERE media_id = ?1 AND artifact_id = ?2",
        params![
            media_id.as_uuid(),
            artifact_id.as_uuid(),
            job_id.as_uuid(),
            now_ms(),
        ],
    )?;
    Ok(())
}

fn adopt_compatible_legacy_media_metadata(
    connection: &Connection,
    existing: ArtifactRecord,
    draft: &ArtifactDraft,
    metadata_json: &str,
) -> Result<ArtifactRecord, DatabaseError> {
    if !crate::storage::media::media_artifact_needs_branding(
        &draft.kind,
        existing.metadata(),
        &draft.metadata,
    ) {
        return Ok(existing);
    }
    let changed = connection.execute(
        "UPDATE artifacts
         SET metadata_json = ?1, updated_at_ms = ?2
         WHERE id = ?3",
        params![metadata_json, now_ms(), existing.id.as_uuid()],
    )?;
    if changed != 1 {
        return Err(DatabaseError::ArtifactPublicationInProgress(existing.id));
    }
    get(connection, existing.id)?.ok_or(DatabaseError::ArtifactNotFound(existing.id))
}

fn reset_failed_for_retry(
    connection: &mut Connection,
    root: &ArtifactRoot,
    existing: &ArtifactRecord,
    draft: &ArtifactDraft,
    metadata_json: &str,
    media_claim: Option<(AssetId, JobId)>,
) -> Result<ArtifactRegistration, DatabaseError> {
    remove_if_regular(&root.child(&staging_name(existing.id))?)?;
    remove_if_regular(&final_path(root, existing)?)?;
    let transaction = connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE artifacts
         SET job_id = ?1, state = 'pending', failure_code = NULL,
             metadata_json = ?2, updated_at_ms = ?3
         WHERE id = ?4 AND state = 'failed'",
        params![
            draft.job_id.map(JobId::into_uuid),
            metadata_json,
            now_ms(),
            existing.id.as_uuid(),
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::ArtifactPublicationInProgress(existing.id));
    }
    if let Some((media_id, job_id)) = media_claim {
        claim_existing_media_edge(&transaction, media_id, existing.id, job_id)?;
    }
    transaction.commit()?;
    let record =
        get(connection, existing.id)?.ok_or(DatabaseError::ArtifactNotFound(existing.id))?;
    let path = root.child(&staging_name(existing.id))?;
    if let Err(error) = OpenOptions::new().write(true).create_new(true).open(&path) {
        let failure = ArtifactFailureCode::new("stagingCreate")?;
        let _ = fail(connection, root, existing.id, &failure);
        return Err(DatabaseError::Io(error));
    }
    Ok(ArtifactRegistration::Staging(ArtifactStaging {
        record,
        path,
    }))
}

pub(in crate::storage) fn get(
    connection: &Connection,
    id: ArtifactId,
) -> Result<Option<ArtifactRecord>, DatabaseError> {
    connection
        .query_row(
            "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts WHERE id = ?1",
            [id.as_uuid()],
            raw_artifact,
        )
        .optional()?
        .map(decode_artifact)
        .transpose()
}

pub(in crate::storage) fn list_ready_for_project(
    connection: &Connection,
    project_id: ProjectId,
    kind: &ArtifactKind,
    limit: usize,
) -> Result<Vec<ArtifactRecord>, DatabaseError> {
    let limit = i64::try_from(limit).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let mut statement = connection.prepare(
        "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts
         WHERE project_id = ?1 AND kind = ?2 AND retention = 'durable' AND state = 'ready'
         ORDER BY created_at_ms DESC, id DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![project_id.as_uuid(), kind.as_str(), limit],
        raw_artifact,
    )?;
    let mut records = Vec::new();
    for row in rows {
        records.push(decode_artifact(row?)?);
    }
    records.reverse();
    Ok(records)
}

pub(in crate::storage) fn ready(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<ArtifactRecord, DatabaseError> {
    root.verify()?;
    let record = get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))?;
    if record.state == ArtifactState::Failed {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    let final_path = final_path(root, &record)?;
    if record.state == ArtifactState::Ready {
        validate_file(&final_path, &record)?;
        return Ok(record);
    }
    let staging_path = root.child(&staging_name(id))?;
    if final_path.exists() {
        validate_file(&final_path, &record)?;
    } else {
        validate_file(&staging_path, &record)?;
        match fs::hard_link(&staging_path, &final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                validate_file(&final_path, &record)?;
            }
            Err(error) => return Err(error.into()),
        }
        validate_file(&final_path, &record)?;
        root.verify()?;
    }
    remove_if_regular(&staging_path)?;
    seal_file(&final_path)?;
    root.verify()?;
    let changed = connection.execute(
        "UPDATE artifacts
         SET state = 'ready', failure_code = NULL, updated_at_ms = ?1
         WHERE id = ?2 AND state = 'pending'",
        params![now_ms(), id.as_uuid()],
    )?;
    if changed != 1 {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))
}

pub(in crate::storage) fn fail(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
    failure_code: &ArtifactFailureCode,
) -> Result<ArtifactRecord, DatabaseError> {
    root.verify()?;
    let record = get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))?;
    if record.state != ArtifactState::Pending {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    transition_failed(connection, id, failure_code)?;
    remove_if_regular(&root.child(&staging_name(id))?)?;
    remove_if_regular(&final_path(root, &record)?)?;
    get(connection, id)?.ok_or(DatabaseError::ArtifactNotFound(id))
}

pub(in crate::storage) fn resolve(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<Option<ResolvedArtifact>, DatabaseError> {
    root.verify()?;
    let Some(record) = get(connection, id)? else {
        return Ok(None);
    };
    if record.state != ArtifactState::Ready {
        return Ok(None);
    }
    let path = final_path(root, &record)?;
    if validate_file(&path, &record).is_err() {
        transition_failed(
            connection,
            id,
            &ArtifactFailureCode::new("missingOrCorrupt")?,
        )?;
        return Ok(None);
    }
    Ok(Some(ResolvedArtifact { record, path }))
}

pub(in crate::storage) fn remove(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<Option<ArtifactRecord>, DatabaseError> {
    root.verify()?;
    let Some(record) = get(connection, id)? else {
        return Ok(None);
    };
    let final_path = final_path(root, &record)?;
    let staging_path = root.child(&staging_name(id))?;
    let trash_path = root.child(&trash_name(id))?;
    let moved = match fs::symlink_metadata(&final_path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(DatabaseError::InvalidArtifactFile);
            }
            if trash_path.exists() {
                return Err(DatabaseError::ArtifactPublicationCollision);
            }
            fs::rename(&final_path, &trash_path)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = connection.execute("DELETE FROM artifacts WHERE id = ?1", [id.as_uuid()]) {
        if moved && !final_path.exists() {
            let _ = fs::rename(&trash_path, &final_path);
        }
        return Err(error.into());
    }
    remove_if_regular(&staging_path)?;
    remove_if_regular(&trash_path)?;
    Ok(Some(record))
}

pub(in crate::storage) fn remove_transactional(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<Option<TransactionalArtifactRemoval>, DatabaseError> {
    root.verify()?;
    let Some(record) = get(connection, id)? else {
        return Ok(None);
    };
    if record.state != ArtifactState::Ready {
        return Err(DatabaseError::InvalidArtifactTransition(id));
    }
    let final_path = final_path(root, &record)?;
    let staging_path = root.child(&staging_name(id))?;
    let trash_path = root.child(&trash_name(id))?;
    let moved = match fs::symlink_metadata(&final_path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() || trash_path.exists() {
                return Err(DatabaseError::InvalidArtifactFile);
            }
            fs::rename(&final_path, &trash_path)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = connection.execute("DELETE FROM artifacts WHERE id = ?1", [id.as_uuid()]) {
        if moved && !final_path.exists() {
            let _ = fs::rename(&trash_path, &final_path);
        }
        return Err(error.into());
    }
    Ok(Some(TransactionalArtifactRemoval {
        final_path,
        staging_path,
        trash_path,
        moved,
        finalized: false,
    }))
}
