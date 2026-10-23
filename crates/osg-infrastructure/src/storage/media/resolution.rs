//! Media resolution: bounded location candidates, managed snapshots, and availability marks.

use osg_domain::{AssetId, MediaAsset, MediaKind, ProjectId};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use super::files::{decode_path, platform_name};
use super::lifecycle::metadata_has_lifecycle;
use super::{
    MAX_MEDIA_LOCATION_CANDIDATES, MEDIA_CANDIDATE_LIFECYCLE, MEDIA_PROJECT_LIFECYCLE,
    MediaLocationCandidate, MediaResolutionPlan,
};
use crate::storage::DatabaseError;
use crate::storage::artifacts::{self, ArtifactId, ArtifactRoot, ContentHash};

pub(in crate::storage) fn resolution_plan(
    connection: &Connection,
    artifact_root: &ArtifactRoot,
    id: AssetId,
    require_project_owner: bool,
    project_revision: Option<(ProjectId, u64)>,
) -> Result<Option<MediaResolutionPlan>, DatabaseError> {
    let stored_asset = connection
        .query_row(
            "SELECT display_name, extension, size_bytes, kind, content_hash, metadata_json,
                    EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)
             FROM media_assets WHERE id = ?1",
            [id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((display_name, extension, size_bytes, kind, content_hash, metadata_json, referenced)) =
        stored_asset
    else {
        return Ok(None);
    };
    let lifecycle_is_project = metadata_has_lifecycle(&metadata_json, MEDIA_PROJECT_LIFECYCLE);
    let authorized = if let Some((project_id, expected_state_version)) = project_revision {
        project_media_is_current(connection, project_id, expected_state_version, id)?
    } else {
        referenced && lifecycle_is_project
    };
    if require_project_owner && !authorized {
        return Ok(None);
    }
    compact_media_locations(connection, id)?;
    let size_bytes = u64::try_from(size_bytes).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let kind = match kind.as_str() {
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        _ => return Err(DatabaseError::InvalidMediaLocation),
    };
    let asset = MediaAsset::with_id(id, display_name, extension, size_bytes, kind)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let content_hash = content_hash
        .map(|bytes| {
            <[u8; 32]>::try_from(bytes)
                .map(ContentHash::from_bytes)
                .map_err(|_| DatabaseError::InvalidMediaLocation)
        })
        .transpose()?;
    let candidate_lifecycle = metadata_has_lifecycle(&metadata_json, MEDIA_CANDIDATE_LIFECYCLE);
    let (mut candidates, artifact_has_more) =
        managed_artifact_candidates(connection, artifact_root, id)?;
    let remaining = MAX_MEDIA_LOCATION_CANDIDATES.saturating_sub(candidates.len());
    if remaining == 0 {
        return Ok(Some(MediaResolutionPlan {
            asset,
            content_hash,
            candidate_lifecycle,
            candidates,
            has_more_candidates: artifact_has_more,
        }));
    }
    let (locations, location_has_more) = media_location_candidates(connection, id, remaining)?;
    candidates.extend(locations);
    Ok(Some(MediaResolutionPlan {
        asset,
        content_hash,
        candidate_lifecycle,
        candidates,
        has_more_candidates: artifact_has_more || location_has_more,
    }))
}

fn compact_media_locations(connection: &Connection, id: AssetId) -> Result<(), DatabaseError> {
    let location_offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    connection.execute(
        "DELETE FROM media_locations
         WHERE id IN (
           SELECT id FROM media_locations
           WHERE media_id = ?1
           ORDER BY available DESC,
                    CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                    CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                    id
           LIMIT -1 OFFSET ?2
         )",
        params![id.as_uuid(), location_offset],
    )?;
    Ok(())
}

fn managed_artifact_candidates(
    connection: &Connection,
    artifact_root: &ArtifactRoot,
    id: AssetId,
) -> Result<(Vec<MediaLocationCandidate>, bool), DatabaseError> {
    let candidate_limit = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES + 1)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let mut artifact_statement = connection.prepare(
        "SELECT link.artifact_id
         FROM media_artifacts AS link
         JOIN artifacts AS artifact ON artifact.id = link.artifact_id
         WHERE link.media_id = ?1 AND artifact.state = 'ready'
         ORDER BY artifact.created_at_ms DESC, artifact.id DESC
         LIMIT ?2",
    )?;
    let artifact_rows = artifact_statement
        .query_map(params![id.as_uuid(), candidate_limit], |row| {
            row.get::<_, Uuid>(0)
        })?;
    let mut artifact_ids = Vec::new();
    for row in artifact_rows {
        artifact_ids.push(ArtifactId::from_uuid(row?)?);
    }
    drop(artifact_statement);
    let mut candidates = Vec::new();
    for artifact_id in artifact_ids {
        if let Some(resolved) = artifacts::resolve(connection, artifact_root, artifact_id)? {
            candidates.push(MediaLocationCandidate {
                id: None,
                path: Some(resolved.path().to_owned()),
                managed_snapshot: true,
            });
        }
    }
    let artifact_has_more = candidates.len() > MAX_MEDIA_LOCATION_CANDIDATES;
    candidates.truncate(MAX_MEDIA_LOCATION_CANDIDATES);
    Ok((candidates, artifact_has_more))
}

fn media_location_candidates(
    connection: &Connection,
    id: AssetId,
    limit: usize,
) -> Result<(Vec<MediaLocationCandidate>, bool), DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id, path_bytes, path_encoding
         FROM media_locations
         WHERE media_id = ?1 AND platform = ?2
         ORDER BY available DESC,
                  CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                  CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                  id
         LIMIT ?3",
    )?;
    let location_limit =
        i64::try_from(limit + 1).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let rows = statement.query_map(
        params![id.as_uuid(), platform_name(), location_limit],
        |row| {
            Ok((
                row.get::<_, Uuid>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    let mut locations = Vec::new();
    for row in rows {
        locations.push(row?);
    }
    drop(statement);
    let location_has_more = locations.len() > limit;
    locations.truncate(limit);
    Ok((
        locations
            .into_iter()
            .map(|(location_id, bytes, encoding)| MediaLocationCandidate {
                id: Some(location_id),
                path: decode_path(&bytes, &encoding),
                managed_snapshot: false,
            })
            .collect(),
        location_has_more,
    ))
}

pub(in crate::storage) fn project_media_is_current(
    connection: &Connection,
    project_id: ProjectId,
    expected_state_version: u64,
    id: AssetId,
) -> Result<bool, DatabaseError> {
    let expected_state_version =
        i64::try_from(expected_state_version).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM project_media AS owned
               JOIN projects AS project ON project.id = owned.project_id
               JOIN media_assets AS media ON media.id = owned.media_id
               WHERE owned.project_id = ?1
                 AND owned.media_id = ?2
                 AND project.state_version = ?3
                 AND json_extract(media.metadata_json, '$.osgMediaLifecycle') = 'project'
             )",
            params![project_id.as_uuid(), id.as_uuid(), expected_state_version],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub(in crate::storage) fn mark_location(
    connection: &mut Connection,
    media_id: AssetId,
    location_id: Uuid,
    available: bool,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE media_locations
         SET available = ?1, last_verified_at_ms = ?2
         WHERE id = ?3 AND media_id = ?4",
        params![
            available,
            crate::storage::actor::now_ms(),
            location_id,
            media_id.as_uuid(),
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let location_count: i64 = transaction.query_row(
        "SELECT count(*) FROM media_locations WHERE media_id = ?1",
        [media_id.as_uuid()],
        |row| row.get(0),
    )?;
    if usize::try_from(location_count).map_err(|_| DatabaseError::InvalidMediaLocation)?
        > MAX_MEDIA_LOCATION_CANDIDATES
    {
        if available {
            let offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
                .map_err(|_| DatabaseError::InvalidMediaLocation)?;
            transaction.execute(
                "DELETE FROM media_locations
                 WHERE id IN (
                   SELECT id FROM media_locations
                   WHERE media_id = ?1
                   ORDER BY available DESC,
                            CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                            CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                            id
                   LIMIT -1 OFFSET ?2
                 )",
                params![media_id.as_uuid(), offset],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM media_locations WHERE id = ?1 AND media_id = ?2",
                params![location_id, media_id.as_uuid()],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}
