//! Media candidate lifecycle: remembering locations, committing artifacts, promoting candidates to
//! project ownership, and discarding or expiring detached candidates.

use std::path::Path;

use osg_application::ProjectSnapshot;
use osg_domain::{AssetId, JobId, MediaAsset};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use super::files::{encode_path, media_kind_name, path_encoding, platform_name};
use super::{
    MAX_EXPIRED_CANDIDATE_CLEANUP, MAX_MEDIA_LOCATION_CANDIDATES, MEDIA_CANDIDATE_EXPIRY_KEY,
    MEDIA_CANDIDATE_LIFECYCLE, MEDIA_CANDIDATE_TTL_MS, MEDIA_LIFECYCLE_KEY,
    MEDIA_PROJECT_LIFECYCLE,
};
use crate::storage::DatabaseError;
use crate::storage::artifacts::{self, ArtifactId, ArtifactRoot, ContentHash, ResolvedArtifact};

#[allow(
    clippy::too_many_lines,
    reason = "media identity validation, lifecycle refresh, and bounded location publication must remain one transaction-local operation"
)]
pub(super) fn remember_in_transaction(
    connection: &Connection,
    asset: &MediaAsset,
    canonical_path: &Path,
    content_hash: ContentHash,
    candidate: bool,
) -> Result<Uuid, DatabaseError> {
    if !canonical_path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let path_bytes = encode_path(canonical_path)?;
    let size_bytes =
        i64::try_from(asset.size_bytes()).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let timestamp = crate::storage::actor::now_ms();
    let existing = connection
        .query_row(
            "SELECT kind, display_name, extension, size_bytes, content_hash, metadata_json
             FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    if existing.as_ref().is_some_and(|existing| {
        existing.0 != media_kind_name(asset.kind())
            || existing.1 != asset.display_name()
            || existing.2 != asset.extension()
            || existing.3 != size_bytes
            || existing
                .4
                .as_ref()
                .is_some_and(|stored| stored.as_slice() != content_hash.as_bytes())
            || (candidate && !metadata_has_lifecycle(&existing.5, MEDIA_CANDIDATE_LIFECYCLE))
    }) {
        return Err(DatabaseError::MediaAssetMismatch(asset.id()));
    }
    let metadata_json = if candidate {
        metadata_with_candidate_lease(
            existing.as_ref().map_or("{}", |stored| stored.5.as_str()),
            timestamp,
        )?
    } else {
        "{}".to_owned()
    };
    connection.execute(
        "INSERT OR IGNORE INTO media_assets(
           id, kind, display_name, extension, size_bytes, content_hash,
           metadata_json, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            asset.id().as_uuid(),
            media_kind_name(asset.kind()),
            asset.display_name(),
            asset.extension(),
            size_bytes,
            content_hash.as_bytes().as_slice(),
            &metadata_json,
            timestamp,
        ],
    )?;
    if candidate && existing.is_some() {
        connection.execute(
            "UPDATE media_assets SET metadata_json = ?1 WHERE id = ?2",
            params![&metadata_json, asset.id().as_uuid()],
        )?;
    }
    connection.execute(
        "UPDATE media_assets SET content_hash = ?1
         WHERE id = ?2 AND content_hash IS NULL",
        params![content_hash.as_bytes().as_slice(), asset.id().as_uuid()],
    )?;
    let proposed_location_id = Uuid::now_v7();
    let location_id = connection.query_row(
        "INSERT INTO media_locations(
           id, media_id, path_bytes, path_encoding, platform, available,
           last_verified_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
         ON CONFLICT(media_id, path_bytes, path_encoding) DO UPDATE SET
           platform = excluded.platform,
           available = 1,
           last_verified_at_ms = excluded.last_verified_at_ms
         RETURNING id",
        params![
            proposed_location_id,
            asset.id().as_uuid(),
            path_bytes,
            path_encoding(),
            platform_name(),
            timestamp,
        ],
        |row| row.get(0),
    )?;
    let offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    connection.execute(
        "DELETE FROM media_locations
         WHERE id IN (
           SELECT id FROM media_locations
           WHERE media_id = ?1
           ORDER BY (id = ?2) DESC, available DESC, last_verified_at_ms DESC, id
           LIMIT -1 OFFSET ?3
         )",
        params![asset.id().as_uuid(), location_id, offset],
    )?;
    Ok(location_id)
}

pub(in crate::storage) fn commit_media_artifact(
    connection: &mut Connection,
    artifact_root: &ArtifactRoot,
    asset: &MediaAsset,
    artifact_id: ArtifactId,
    job_id: Option<JobId>,
    candidate: bool,
) -> Result<ResolvedArtifact, DatabaseError> {
    let transaction = connection.transaction()?;
    let record = artifacts::ready(&transaction, artifact_root, artifact_id)?;
    if record.size_bytes() != asset.size_bytes()
        || record
            .metadata()
            .as_object()
            .and_then(|metadata| metadata.get("osgMediaArtifact"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    let resolved = artifacts::resolve(&transaction, artifact_root, artifact_id)?
        .ok_or(DatabaseError::ArtifactNotFound(artifact_id))?;
    remember_in_transaction(
        &transaction,
        asset,
        resolved.path(),
        record.content_hash(),
        candidate,
    )?;
    let timestamp = crate::storage::actor::now_ms();
    transaction.execute(
        "INSERT INTO media_artifacts(media_id, artifact_id, created_at_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(media_id, artifact_id) DO NOTHING",
        params![asset.id().as_uuid(), artifact_id.as_uuid(), timestamp,],
    )?;
    if let Some(job_id) = job_id {
        transaction.execute(
            "INSERT OR IGNORE INTO media_artifact_job_claims(
               media_id, artifact_id, job_id, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                asset.id().as_uuid(),
                artifact_id.as_uuid(),
                job_id.as_uuid(),
                timestamp,
            ],
        )?;
    }
    transaction.commit()?;
    Ok(resolved)
}

pub(in crate::storage) fn promote_project_candidates(
    connection: &Connection,
    snapshot: &ProjectSnapshot,
) -> Result<(), DatabaseError> {
    let project_id = snapshot.metadata().id();
    for asset in snapshot.media() {
        connection.execute(
            "INSERT OR IGNORE INTO media_project_owners(media_id, project_id, created_at_ms)
             VALUES (?1, ?2, ?3)",
            params![
                asset.id().as_uuid(),
                project_id.as_uuid(),
                crate::storage::actor::now_ms(),
            ],
        )?;
        let owner: Uuid = connection.query_row(
            "SELECT project_id FROM media_project_owners WHERE media_id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )?;
        if owner != *project_id.as_uuid() {
            return Err(DatabaseError::CrossProjectIdentifier {
                project_id,
                entity: "media asset",
            });
        }
        let metadata_json: String = connection.query_row(
            "SELECT metadata_json FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )?;
        if metadata_has_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE) {
            continue;
        }
        let promoted_metadata = metadata_with_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE)?;
        let changed = connection.execute(
            "UPDATE media_assets SET metadata_json = ?1
             WHERE id = ?2 AND metadata_json = ?3",
            params![promoted_metadata, asset.id().as_uuid(), metadata_json],
        )?;
        if changed != 1 {
            return Err(DatabaseError::InvalidMediaLocation);
        }
    }
    Ok(())
}

pub(in crate::storage) fn discard_candidate_in_transaction(
    connection: &Connection,
    media_id: AssetId,
) -> Result<Option<Vec<ArtifactId>>, DatabaseError> {
    let Some(metadata_json) = connection
        .query_row(
            "SELECT metadata_json FROM media_assets WHERE id = ?1",
            [media_id.as_uuid()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    if !metadata_has_lifecycle(&metadata_json, MEDIA_CANDIDATE_LIFECYCLE) {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT artifact_id FROM media_artifacts
         WHERE media_id = ?1 ORDER BY artifact_id",
    )?;
    let rows = statement.query_map([media_id.as_uuid()], |row| row.get::<_, Uuid>(0))?;
    let mut artifacts = Vec::new();
    for row in rows {
        artifacts.push(ArtifactId::from_uuid(row?)?);
    }
    drop(statement);
    let changed = connection.execute(
        "DELETE FROM media_assets
         WHERE id = ?1 AND metadata_json = ?2
           AND NOT EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)
           AND NOT EXISTS(SELECT 1 FROM media_aliases WHERE media_id = ?1)
           AND NOT EXISTS(
             SELECT 1
              FROM media_artifact_job_claims AS claim
              JOIN jobs AS job ON job.id = claim.job_id
              WHERE claim.media_id = ?1
               AND job.state IN ('queued', 'running', 'cancelling')
           )",
        params![media_id.as_uuid(), metadata_json],
    )?;
    Ok((changed == 1).then_some(artifacts))
}

pub(in crate::storage) fn artifact_has_persistent_owner(
    connection: &Connection,
    artifact_id: ArtifactId,
) -> Result<bool, DatabaseError> {
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM media_artifacts WHERE artifact_id = ?1
               UNION ALL
               SELECT 1 FROM cache_entries WHERE artifact_id = ?1
               UNION ALL
               SELECT 1 FROM artifacts WHERE id = ?1 AND project_id IS NOT NULL
             )",
            [artifact_id.as_uuid()],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub(in crate::storage) fn cleanup_failed_artifact_candidates(
    connection: &Connection,
    artifact_id: ArtifactId,
) -> Result<usize, DatabaseError> {
    connection
        .execute(
            "DELETE FROM media_assets
             WHERE json_extract(metadata_json, '$.osgMediaLifecycle') = 'candidate'
               AND NOT EXISTS(
                 SELECT 1 FROM project_media WHERE media_id = media_assets.id
               )
               AND NOT EXISTS(
                 SELECT 1 FROM media_aliases WHERE media_id = media_assets.id
               )
               AND id IN (
                 SELECT claim.media_id
                  FROM media_artifact_job_claims AS claim
                  JOIN jobs AS job ON job.id = claim.job_id
                  WHERE claim.artifact_id = ?1
                   AND job.state IN ('failed', 'cancelled', 'interrupted')
               )
               AND NOT EXISTS(
                 SELECT 1
                  FROM media_artifacts AS keep
                  WHERE keep.media_id = media_assets.id
                    AND (
                      NOT EXISTS(
                        SELECT 1 FROM media_artifact_job_claims AS any_claim
                        WHERE any_claim.media_id = keep.media_id
                          AND any_claim.artifact_id = keep.artifact_id
                      )
                      OR EXISTS(
                        SELECT 1
                        FROM media_artifact_job_claims AS keep_claim
                        JOIN jobs AS keep_job ON keep_job.id = keep_claim.job_id
                        WHERE keep_claim.media_id = keep.media_id
                          AND keep_claim.artifact_id = keep.artifact_id
                          AND keep_job.state IN (
                            'queued', 'running', 'cancelling', 'succeeded'
                          )
                      )
                    )
               )",
            [artifact_id.as_uuid()],
        )
        .map_err(Into::into)
}

pub(in crate::storage) fn promote_candidate(
    connection: &mut Connection,
    media_id: AssetId,
) -> Result<bool, DatabaseError> {
    let transaction = connection.transaction()?;
    let Some((metadata_json, referenced)) = transaction
        .query_row(
            "SELECT metadata_json,
                    EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)
             FROM media_assets WHERE id = ?1",
            [media_id.as_uuid()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
    else {
        transaction.commit()?;
        return Ok(false);
    };
    if metadata_has_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE) {
        transaction.commit()?;
        return Ok(false);
    }
    if metadata_has_lifecycle(&metadata_json, MEDIA_CANDIDATE_LIFECYCLE) {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    if referenced {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    transaction.commit()?;
    Ok(false)
}

pub(super) fn metadata_has_lifecycle(metadata_json: &str, lifecycle: &str) -> bool {
    serde_json::from_str::<Value>(metadata_json)
        .ok()
        .is_some_and(|metadata| {
            metadata
                .get(MEDIA_LIFECYCLE_KEY)
                .and_then(Value::as_str)
                .is_some_and(|value| value == lifecycle)
        })
}

fn metadata_with_lifecycle(metadata_json: &str, lifecycle: &str) -> Result<String, DatabaseError> {
    let mut metadata = serde_json::from_str::<Value>(metadata_json)?;
    let object = metadata
        .as_object_mut()
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    object.insert(
        MEDIA_LIFECYCLE_KEY.to_owned(),
        Value::String(lifecycle.to_owned()),
    );
    if lifecycle == MEDIA_PROJECT_LIFECYCLE {
        object.remove(MEDIA_CANDIDATE_EXPIRY_KEY);
    }
    serde_json::to_string(&metadata).map_err(Into::into)
}

fn metadata_with_candidate_lease(
    metadata_json: &str,
    timestamp: i64,
) -> Result<String, DatabaseError> {
    let mut metadata = serde_json::from_str::<Value>(metadata_json)?;
    let object = metadata
        .as_object_mut()
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    let expires_at = timestamp
        .checked_add(MEDIA_CANDIDATE_TTL_MS)
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    object.insert(
        MEDIA_LIFECYCLE_KEY.to_owned(),
        Value::String(MEDIA_CANDIDATE_LIFECYCLE.to_owned()),
    );
    object.insert(
        MEDIA_CANDIDATE_EXPIRY_KEY.to_owned(),
        Value::from(expires_at),
    );
    serde_json::to_string(&metadata).map_err(Into::into)
}

pub(in crate::storage) fn cleanup_expired_candidates(
    connection: &Connection,
    timestamp: i64,
) -> Result<u64, DatabaseError> {
    let removed = connection.execute(
        "DELETE FROM media_assets
         WHERE id IN (
           SELECT candidate.id
           FROM media_assets AS candidate
           WHERE json_extract(candidate.metadata_json, '$.osgMediaLifecycle') = 'candidate'
             AND json_type(
               candidate.metadata_json, '$.osgMediaCandidateExpiresAtMs'
             ) = 'integer'
             AND json_extract(
               candidate.metadata_json, '$.osgMediaCandidateExpiresAtMs'
             ) <= ?1
             AND NOT EXISTS(
               SELECT 1 FROM project_media WHERE media_id = candidate.id
             )
             AND NOT EXISTS(
               SELECT 1 FROM media_aliases WHERE media_id = candidate.id
             )
             AND NOT EXISTS(
               SELECT 1
                FROM media_artifact_job_claims AS claim
                JOIN jobs AS job ON job.id = claim.job_id
                WHERE claim.media_id = candidate.id
                 AND job.state IN ('queued', 'running', 'cancelling')
             )
           ORDER BY candidate.created_at_ms, candidate.id
           LIMIT ?2
         )",
        params![timestamp, MAX_EXPIRED_CANDIDATE_CLEANUP],
    )?;
    u64::try_from(removed).map_err(|_| DatabaseError::InvalidMediaLocation)
}
