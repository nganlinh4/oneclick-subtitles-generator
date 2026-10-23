//! Content-addressed cache entries: writes, lookups, leases, info, and clearing.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use super::reconcile::{
    artifact_has_media_owner, publish_existing_stage, repair_media_owned_cache_retention,
};
use super::root::{final_path, remove_if_regular, seal_file, staging_name, validate_file};
use super::rows::{
    ensure_cache_capacity, ensure_cache_lease_capacity, transition_failed, validate_owner,
};
use super::{
    ArtifactFailureCode, ArtifactId, ArtifactRetention, ArtifactRoot, ArtifactState, CacheCategory,
    CacheCategoryInfo, CacheClearOutcome, CacheClearResult, CacheInfo, CacheKey, CacheLease,
    CacheLeaseId, CacheWrite, LeasedArtifact, MAX_CACHE_LEASE_MS, ResolvedArtifact, get, reconcile,
    remove, resolve,
};
use crate::storage::DatabaseError;
use crate::storage::actor::now_ms;

pub(in crate::storage) fn put_cache(
    connection: &Connection,
    write: &CacheWrite,
) -> Result<(), DatabaseError> {
    let artifact = get(connection, write.artifact_id)?
        .ok_or(DatabaseError::ArtifactNotFound(write.artifact_id))?;
    if artifact.state != ArtifactState::Ready {
        return Err(DatabaseError::ArtifactNotCacheable(write.artifact_id));
    }
    let existing = connection.query_row(
        "SELECT artifact_id, category, algorithm_version FROM cache_entries WHERE cache_key = ?1",
        [write.key.as_bytes().as_slice()],
        |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
    ).optional()?;
    if let Some((artifact_id, category, version)) = existing {
        if artifact_id != *write.artifact_id.as_uuid()
            || category != write.category.as_str()
            || version != i64::from(write.algorithm_version)
        {
            return Err(DatabaseError::CacheKeyConflict);
        }
        connection.execute(
            "UPDATE cache_entries SET last_accessed_at_ms = ?1, expires_at_ms = ?2
             WHERE cache_key = ?3",
            params![
                now_ms(),
                write
                    .expires_at_ms
                    .map(i64::try_from)
                    .transpose()
                    .map_err(|_| DatabaseError::InvalidCacheEntry)?,
                write.key.as_bytes().as_slice()
            ],
        )?;
        return Ok(());
    }
    let count: i64 =
        connection.query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))?;
    ensure_cache_capacity(count)?;
    connection.execute(
        "INSERT INTO cache_entries(
           cache_key, artifact_id, category, algorithm_version, last_accessed_at_ms, expires_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            write.key.as_bytes().as_slice(),
            write.artifact_id.as_uuid(),
            write.category.as_str(),
            write.algorithm_version,
            now_ms(),
            write
                .expires_at_ms
                .map(i64::try_from)
                .transpose()
                .map_err(|_| DatabaseError::InvalidCacheEntry)?,
        ],
    )?;
    Ok(())
}

/// Makes staged cache bytes and their lookup key visible together.
///
/// Filesystem publication necessarily precedes the `SQLite` transaction. A crash in that narrow
/// interval leaves a pending, unreferenced artifact which reconciliation removes; it cannot yield
/// a cache hit. The ready transition and cache row themselves are committed atomically.
pub(in crate::storage) fn commit_cache_artifact(
    connection: &mut Connection,
    root: &ArtifactRoot,
    write: &CacheWrite,
) -> Result<ResolvedArtifact, DatabaseError> {
    root.verify()?;
    let record = get(connection, write.artifact_id)?
        .ok_or(DatabaseError::ArtifactNotFound(write.artifact_id))?;
    if record.state == ArtifactState::Failed
        || record.retention != ArtifactRetention::Cache
        || record.project_id.is_some()
        || artifact_has_media_owner(connection, record.id)?
    {
        return Err(DatabaseError::ArtifactNotCacheable(record.id));
    }

    let final_path = final_path(root, &record)?;
    let staging_path = root.child(&staging_name(record.id))?;
    match record.state {
        ArtifactState::Ready => validate_file(&final_path, &record)?,
        ArtifactState::Pending => {
            validate_file(&staging_path, &record)?;
            publish_existing_stage(&staging_path, &final_path, &record)?;
            seal_file(&final_path)?;
            root.verify()?;
        }
        ArtifactState::Failed => unreachable!("failed artifacts were rejected above"),
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if record.state == ArtifactState::Pending {
        let changed = transaction.execute(
            "UPDATE artifacts
             SET state = 'ready', failure_code = NULL, updated_at_ms = ?1
             WHERE id = ?2 AND state = 'pending'",
            params![now_ms(), record.id.as_uuid()],
        )?;
        if changed != 1 {
            return Err(DatabaseError::InvalidArtifactTransition(record.id));
        }
    }
    put_cache(&transaction, write)?;
    transaction.commit()?;

    // The final content-addressed link is authoritative after commit. A leftover staging link is
    // harmless and bounded; reconciliation removes it if this best-effort cleanup is interrupted.
    let _ = remove_if_regular(&staging_path);
    let record = get(connection, record.id)?.ok_or(DatabaseError::ArtifactNotFound(record.id))?;
    Ok(ResolvedArtifact {
        record,
        path: final_path,
    })
}

pub(in crate::storage) fn lookup_cache(
    connection: &Connection,
    root: &ArtifactRoot,
    key: CacheKey,
) -> Result<Option<ResolvedArtifact>, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT artifact_id, expires_at_ms FROM cache_entries WHERE cache_key = ?1",
            [key.as_bytes().as_slice()],
            |row| Ok((row.get::<_, Uuid>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let Some((artifact_id, expires_at_ms)) = row else {
        return Ok(None);
    };
    let id = ArtifactId::from_uuid(artifact_id)?;
    if expires_at_ms.is_some_and(|expiry| expiry <= now_ms()) {
        let leased: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM cache_leases
               WHERE cache_key = ?1 AND expires_at_ms > ?2
             )",
            params![key.as_bytes().as_slice(), now_ms()],
            |row| row.get(0),
        )?;
        if !leased {
            connection.execute(
                "DELETE FROM cache_entries WHERE cache_key = ?1",
                [key.as_bytes().as_slice()],
            )?;
            remove_unreferenced_cache_artifact(connection, root, id)?;
        }
        return Ok(None);
    }
    let Some(resolved) = resolve(connection, root, id)? else {
        connection.execute(
            "DELETE FROM cache_entries WHERE cache_key = ?1",
            [key.as_bytes().as_slice()],
        )?;
        remove_unreferenced_cache_artifact(connection, root, id)?;
        return Ok(None);
    };
    connection.execute(
        "UPDATE cache_entries SET last_accessed_at_ms = ?1 WHERE cache_key = ?2",
        params![now_ms(), key.as_bytes().as_slice()],
    )?;
    Ok(Some(resolved))
}

pub(in crate::storage) fn invalidate_cache(
    connection: &Connection,
    root: &ArtifactRoot,
    key: CacheKey,
) -> Result<bool, DatabaseError> {
    let artifact_id = connection
        .query_row(
            "SELECT artifact_id FROM cache_entries WHERE cache_key = ?1",
            [key.as_bytes().as_slice()],
            |row| row.get::<_, Uuid>(0),
        )
        .optional()?;
    let Some(artifact_id) = artifact_id else {
        return Ok(false);
    };
    connection.execute(
        "DELETE FROM cache_entries WHERE cache_key = ?1",
        [key.as_bytes().as_slice()],
    )?;
    remove_unreferenced_cache_artifact(connection, root, ArtifactId::from_uuid(artifact_id)?)?;
    Ok(true)
}

pub(in crate::storage) fn lease_cache(
    connection: &Connection,
    root: &ArtifactRoot,
    key: CacheKey,
    owner: &str,
    ttl_ms: u64,
) -> Result<Option<LeasedArtifact>, DatabaseError> {
    if !validate_owner(owner) || ttl_ms == 0 || ttl_ms > MAX_CACHE_LEASE_MS {
        return Err(DatabaseError::InvalidCacheLease);
    }
    let Some(artifact) = lookup_cache(connection, root, key)? else {
        return Ok(None);
    };
    let timestamp = now_ms();
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [timestamp],
    )?;
    let count: i64 =
        connection.query_row("SELECT COUNT(*) FROM cache_leases", [], |row| row.get(0))?;
    ensure_cache_lease_capacity(count)?;
    let ttl_ms = i64::try_from(ttl_ms).map_err(|_| DatabaseError::InvalidCacheLease)?;
    let expires_at_ms = timestamp
        .checked_add(ttl_ms)
        .ok_or(DatabaseError::InvalidCacheLease)?;
    let id = CacheLeaseId::new();
    connection.execute(
        "INSERT INTO cache_leases(id, cache_key, owner, expires_at_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            id.as_uuid(),
            key.as_bytes().as_slice(),
            owner,
            expires_at_ms
        ],
    )?;
    Ok(Some(LeasedArtifact {
        artifact,
        lease: CacheLease {
            id,
            key,
            owner: owner.to_owned(),
            expires_at_ms: u64::try_from(expires_at_ms)
                .map_err(|_| DatabaseError::InvalidCacheLease)?,
        },
    }))
}

pub(in crate::storage) fn release_cache_lease(
    connection: &Connection,
    id: CacheLeaseId,
) -> Result<bool, DatabaseError> {
    Ok(connection.execute("DELETE FROM cache_leases WHERE id = ?1", [id.as_uuid()])? != 0)
}

pub(in crate::storage) fn cache_info(
    connection: &Connection,
    root: &ArtifactRoot,
) -> Result<CacheInfo, DatabaseError> {
    reconcile(connection, root)?;
    let mut statement = connection.prepare(
        "SELECT category, COUNT(*), COALESCE(SUM(size_bytes), 0)
         FROM (
           SELECT ce.category AS category, a.id AS artifact_id, a.size_bytes AS size_bytes
           FROM cache_entries ce JOIN artifacts a ON a.id = ce.artifact_id
           WHERE a.state = 'ready'
           GROUP BY ce.category, a.id
         )
         GROUP BY category ORDER BY category",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(CacheCategoryInfo {
            category: row.get(0)?,
            count: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(u64::MAX),
            size_bytes: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(u64::MAX),
        })
    })?;
    let mut categories = Vec::new();
    for row in rows {
        categories.push(row?);
    }
    let (count, size): (i64, i64) = connection.query_row(
        "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0)
         FROM (
           SELECT a.id, a.size_bytes FROM cache_entries ce
           JOIN artifacts a ON a.id = ce.artifact_id
           WHERE a.state = 'ready' GROUP BY a.id
         )",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(CacheInfo {
        categories,
        total_count: u64::try_from(count).map_err(|_| DatabaseError::InvalidCacheEntry)?,
        total_size_bytes: u64::try_from(size).map_err(|_| DatabaseError::InvalidCacheEntry)?,
    })
}

pub(in crate::storage) fn clear_cache(
    connection: &mut Connection,
    root: &ArtifactRoot,
    category: Option<&CacheCategory>,
) -> Result<CacheClearResult, DatabaseError> {
    root.verify()?;
    repair_media_owned_cache_retention(connection)?;
    let timestamp = now_ms();
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [timestamp],
    )?;
    let mut statement = connection.prepare(
        "SELECT ce.cache_key, ce.artifact_id,
                EXISTS(SELECT 1 FROM cache_leases cl
                       WHERE cl.cache_key = ce.cache_key AND cl.expires_at_ms > ?1)
         FROM cache_entries ce WHERE ?2 IS NULL OR ce.category = ?2
         ORDER BY ce.cache_key",
    )?;
    let rows = statement.query_map(
        params![timestamp, category.map(CacheCategory::as_str)],
        |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Uuid>(1)?,
                row.get::<_, bool>(2)?,
            ))
        },
    )?;
    let mut selected = Vec::new();
    for row in rows {
        selected.push(row?);
    }
    drop(statement);

    let leased_count = selected.iter().filter(|(_, _, leased)| *leased).count() as u64;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut candidates = HashSet::new();
    for (key, artifact_id, leased) in &selected {
        if !leased {
            transaction.execute("DELETE FROM cache_entries WHERE cache_key = ?1", [key])?;
            candidates.insert(ArtifactId::from_uuid(*artifact_id)?);
        }
    }
    transaction.commit()?;

    let mut removed_count = 0_u64;
    let mut removed_size_bytes = 0_u64;
    let mut retained_shared_count = 0_u64;
    let mut cleanup_failed_count = 0_u64;
    for id in candidates {
        let referenced: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM cache_entries WHERE artifact_id = ?1)",
            [id.as_uuid()],
            |row| row.get(0),
        )?;
        let Some(record) = get(connection, id)? else {
            continue;
        };
        // Retention is the primary contract.  The media edge is an independent fail-safe for a
        // legacy or externally repaired database that predates the `registry::register_media`
        // invariant:
        // cache clearing may remove the cache key, but never bytes owned by a media identity.
        let media_owned = artifact_has_media_owner(connection, id)?;
        if referenced || record.retention != ArtifactRetention::Cache || media_owned {
            retained_shared_count = retained_shared_count.saturating_add(1);
        } else {
            match remove(connection, root, id) {
                Ok(Some(removed)) => {
                    removed_count = removed_count.saturating_add(1);
                    removed_size_bytes = removed_size_bytes.saturating_add(removed.size_bytes);
                }
                Ok(None) => {}
                Err(_) => {
                    let _ = transition_failed(
                        connection,
                        id,
                        &ArtifactFailureCode::new("cacheCleanup")?,
                    );
                    cleanup_failed_count = cleanup_failed_count.saturating_add(1);
                }
            }
        }
    }
    Ok(CacheClearResult {
        category: category.map(|value| value.as_str().to_owned()),
        removed_count,
        removed_size_bytes,
        retained_shared_count,
        leased_count,
        cleanup_failed_count,
    })
}

pub(in crate::storage) fn clear_cache_with_info(
    connection: &mut Connection,
    root: &ArtifactRoot,
    category: Option<&CacheCategory>,
) -> Result<CacheClearOutcome, DatabaseError> {
    let before = cache_info(connection, root)?;
    let clear = clear_cache(connection, root, category)?;
    let after = cache_info(connection, root)?;
    Ok(CacheClearOutcome {
        before,
        clear,
        after,
    })
}

pub(super) fn purge_expired_cache(
    connection: &Connection,
    root: &ArtifactRoot,
) -> Result<(), DatabaseError> {
    let timestamp = now_ms();
    connection.execute(
        "DELETE FROM cache_leases WHERE expires_at_ms <= ?1",
        [timestamp],
    )?;
    let mut statement = connection.prepare(
        "SELECT DISTINCT ce.artifact_id FROM cache_entries ce
         WHERE ce.expires_at_ms IS NOT NULL AND ce.expires_at_ms <= ?1
           AND NOT EXISTS(
             SELECT 1 FROM cache_leases cl
             WHERE cl.cache_key = ce.cache_key AND cl.expires_at_ms > ?1
           )",
    )?;
    let rows = statement.query_map([timestamp], |row| row.get::<_, Uuid>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(ArtifactId::from_uuid(row?)?);
    }
    drop(statement);
    connection.execute(
        "DELETE FROM cache_entries
         WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?1
           AND NOT EXISTS(
             SELECT 1 FROM cache_leases cl
             WHERE cl.cache_key = cache_entries.cache_key AND cl.expires_at_ms > ?1
           )",
        [timestamp],
    )?;
    for id in ids {
        remove_unreferenced_cache_artifact(connection, root, id)?;
    }
    Ok(())
}

fn remove_unreferenced_cache_artifact(
    connection: &Connection,
    root: &ArtifactRoot,
    id: ArtifactId,
) -> Result<(), DatabaseError> {
    let referenced: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM cache_entries WHERE artifact_id = ?1)",
        [id.as_uuid()],
        |row| row.get(0),
    )?;
    if !referenced
        && get(connection, id)?.is_some_and(|record| record.retention == ArtifactRetention::Cache)
    {
        let _ = remove(connection, root, id)?;
    }
    Ok(())
}
