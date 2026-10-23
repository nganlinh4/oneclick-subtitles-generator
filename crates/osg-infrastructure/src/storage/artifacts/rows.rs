//! Artifact row mapping and input validation: decoding stored rows, capacity bounds, and names.

use osg_domain::{JobId, ProjectId};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use super::root::final_name;
use super::{
    ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRecord, ArtifactRetention,
    ArtifactState, ContentHash, MAX_ARTIFACT_METADATA_BYTES, MAX_ARTIFACT_SIZE_BYTES,
    MAX_ARTIFACTS, MAX_CACHE_ENTRIES, MAX_CACHE_LEASES, get,
};
use crate::storage::DatabaseError;
use crate::storage::actor::now_ms;

type RawArtifact = (
    Uuid,
    Option<Uuid>,
    Option<Uuid>,
    String,
    String,
    Vec<u8>,
    i64,
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
);

pub(super) fn list(connection: &Connection) -> Result<Vec<ArtifactRecord>, DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts ORDER BY created_at_ms, id LIMIT ?1",
    )?;
    let rows = statement.query_map(
        [i64::try_from(MAX_ARTIFACTS + 1).unwrap_or(i64::MAX)],
        raw_artifact,
    )?;
    let mut records = Vec::new();
    for row in rows {
        records.push(decode_artifact(row?)?);
    }
    Ok(records)
}

pub(super) fn find_by_content(
    connection: &Connection,
    kind: &ArtifactKind,
    content_hash: ContentHash,
) -> Result<Option<ArtifactRecord>, DatabaseError> {
    connection
        .query_row(
            "SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes,
                retention, state, failure_code, metadata_json, created_at_ms, updated_at_ms
         FROM artifacts WHERE kind = ?1 AND content_hash = ?2",
            params![kind.as_str(), content_hash.as_bytes().as_slice()],
            raw_artifact,
        )
        .optional()?
        .map(decode_artifact)
        .transpose()
}

pub(super) fn raw_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawArtifact> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
    ))
}

pub(super) fn decode_artifact(raw: RawArtifact) -> Result<ArtifactRecord, DatabaseError> {
    let (
        id,
        project_id,
        job_id,
        kind,
        relative_path,
        hash,
        size,
        retention,
        state,
        failure_code,
        metadata_json,
        created,
        updated,
    ) = raw;
    let id = ArtifactId::from_uuid(id)?;
    let project_id = project_id
        .map(ProjectId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let job_id = job_id
        .map(JobId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let kind = ArtifactKind::new(kind).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let content_hash = ContentHash::from_bytes(
        hash.try_into()
            .map_err(|_| DatabaseError::InvalidArtifactMetadata)?,
    );
    if relative_path != final_name(&kind, content_hash) {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let size_bytes = u64::try_from(size).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    validate_size(size_bytes).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let retention = match retention.as_str() {
        "durable" => ArtifactRetention::Durable,
        "cache" => ArtifactRetention::Cache,
        _ => return Err(DatabaseError::InvalidArtifactMetadata),
    };
    let state = match state.as_str() {
        "pending" => ArtifactState::Pending,
        "ready" => ArtifactState::Ready,
        "failed" => ArtifactState::Failed,
        _ => return Err(DatabaseError::InvalidArtifactMetadata),
    };
    let failure_code = failure_code
        .map(ArtifactFailureCode::new)
        .transpose()
        .map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    if (state == ArtifactState::Failed) != failure_code.is_some() {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let metadata = serde_json::from_str(&metadata_json)?;
    validate_metadata(&metadata).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let created_at_ms =
        u64::try_from(created).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    let updated_at_ms =
        u64::try_from(updated).map_err(|_| DatabaseError::InvalidArtifactMetadata)?;
    if updated_at_ms < created_at_ms {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    Ok(ArtifactRecord {
        id,
        project_id,
        job_id,
        kind,
        relative_path,
        content_hash,
        size_bytes,
        retention,
        state,
        failure_code,
        metadata,
        created_at_ms,
        updated_at_ms,
    })
}

pub(super) fn transition_failed(
    connection: &Connection,
    id: ArtifactId,
    failure_code: &ArtifactFailureCode,
) -> Result<(), DatabaseError> {
    let changed = connection.execute(
        "UPDATE artifacts SET state = 'failed', failure_code = ?1, updated_at_ms = ?2
         WHERE id = ?3 AND state != 'failed'",
        params![failure_code.as_str(), now_ms(), id.as_uuid()],
    )?;
    if changed == 0 && get(connection, id)?.is_none() {
        return Err(DatabaseError::ArtifactNotFound(id));
    }
    Ok(())
}

pub(super) fn validate_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub(super) fn validate_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub(super) fn ensure_artifact_capacity(count: i64) -> Result<(), DatabaseError> {
    if u64::try_from(count).unwrap_or(u64::MAX) < MAX_ARTIFACTS {
        Ok(())
    } else {
        Err(DatabaseError::ArtifactLimitReached)
    }
}

pub(super) fn ensure_cache_capacity(count: i64) -> Result<(), DatabaseError> {
    if u64::try_from(count).unwrap_or(u64::MAX) < MAX_CACHE_ENTRIES {
        Ok(())
    } else {
        Err(DatabaseError::CacheLimitReached)
    }
}

pub(super) fn ensure_cache_lease_capacity(count: i64) -> Result<(), DatabaseError> {
    if u64::try_from(count).unwrap_or(u64::MAX) < MAX_CACHE_LEASES {
        Ok(())
    } else {
        Err(DatabaseError::CacheLeaseLimitReached)
    }
}

pub(super) const fn retention_name(retention: ArtifactRetention) -> &'static str {
    match retention {
        ArtifactRetention::Durable => "durable",
        ArtifactRetention::Cache => "cache",
    }
}

pub(super) fn validate_size(size: u64) -> Result<(), DatabaseError> {
    if size <= MAX_ARTIFACT_SIZE_BYTES && i64::try_from(size).is_ok() {
        Ok(())
    } else {
        Err(DatabaseError::InvalidArtifactSize)
    }
}

pub(super) fn validate_metadata(metadata: &Value) -> Result<(), DatabaseError> {
    let encoded = serde_json::to_vec(metadata)?;
    if encoded.len() <= MAX_ARTIFACT_METADATA_BYTES {
        Ok(())
    } else {
        Err(DatabaseError::ArtifactMetadataTooLarge)
    }
}

pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(DIGITS[usize::from(byte >> 4)]));
        result.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    result
}
