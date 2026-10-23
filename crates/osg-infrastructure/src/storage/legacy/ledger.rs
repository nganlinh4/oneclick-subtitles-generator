//! `SQLite` ledger for legacy-import runs: prepare, per-item state, finish, and listing.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use uuid::{Uuid, Variant, Version};

use super::{
    LegacyImportCandidate, LegacyImportCounts, LegacyImportId, LegacyImportItemKind,
    LegacyImportItemOutcome, LegacyImportItemState, LegacyImportSourceKind, LegacyImportState,
    LegacyImportSummary, MAX_DETAIL_CODE_BYTES, MAX_LEGACY_IMPORT_ITEMS,
};
use crate::storage::actor::now_ms;
use crate::storage::{ContentHash, DatabaseError};

pub(in crate::storage) fn prepare(
    connection: &mut Connection,
    source_kind: LegacyImportSourceKind,
    fingerprint: ContentHash,
    candidates: &[LegacyImportCandidate],
) -> Result<LegacyImportSummary, DatabaseError> {
    validate_candidates(candidates)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(Uuid, String)> = transaction
        .query_row(
            "SELECT id, status FROM legacy_import_sources
             WHERE source_kind = ?1 AND source_fingerprint = ?2",
            params![source_kind.as_str(), fingerprint.as_bytes().as_slice()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let had_existing = existing.is_some();
    let (source_id, existing_state) = if let Some((id, state)) = existing {
        (
            LegacyImportId::from_uuid(id)?,
            LegacyImportState::parse(&state)?,
        )
    } else {
        let id = LegacyImportId::new();
        transaction.execute(
            "INSERT INTO legacy_import_sources (
               id, source_kind, source_fingerprint, status, discovered_at_ms, completed_at_ms
             ) VALUES (?1, ?2, ?3, 'pending', ?4, NULL)",
            params![
                id.as_uuid(),
                source_kind.as_str(),
                fingerprint.as_bytes().as_slice(),
                now_ms()
            ],
        )?;
        (id, LegacyImportState::Running)
    };

    if had_existing && !stored_candidates_match(&transaction, source_id, candidates)? {
        return Err(DatabaseError::InvalidLegacyImport);
    }
    if had_existing && existing_state == LegacyImportState::Running {
        return Err(DatabaseError::LegacyImportBusy);
    }

    if existing_state != LegacyImportState::Complete {
        transaction.execute(
            "UPDATE legacy_import_sources
             SET status = 'running', completed_at_ms = NULL WHERE id = ?1",
            [source_id.as_uuid()],
        )?;
        {
            let mut statement = transaction.prepare(
                "INSERT OR IGNORE INTO legacy_import_items (
                   source_id, legacy_key, item_kind, status, target_id, error_message, imported_at_ms
                 ) VALUES (?1, ?2, ?3, 'pending', NULL, NULL, NULL)",
            )?;
            for candidate in candidates {
                statement.execute(params![
                    source_id.as_uuid(),
                    candidate.key.as_str(),
                    candidate.kind.as_str()
                ])?;
            }
        }
    }
    transaction.commit()?;
    summary(connection, source_id)
}

pub(in crate::storage) fn item_state(
    connection: &Connection,
    source_id: LegacyImportId,
    candidate: &LegacyImportCandidate,
) -> Result<Option<LegacyImportItemState>, DatabaseError> {
    connection
        .query_row(
            "SELECT status FROM legacy_import_items
             WHERE source_id = ?1 AND legacy_key = ?2 AND item_kind = ?3",
            params![
                source_id.as_uuid(),
                candidate.key.as_str(),
                candidate.kind.as_str()
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|state| LegacyImportItemState::parse(&state))
        .transpose()
}

pub(in crate::storage) fn record_item(
    connection: &Connection,
    source_id: LegacyImportId,
    candidate: &LegacyImportCandidate,
    outcome: &LegacyImportItemOutcome,
) -> Result<(), DatabaseError> {
    validate_outcome(outcome)?;
    let source_state: String = connection
        .query_row(
            "SELECT status FROM legacy_import_sources WHERE id = ?1",
            [source_id.as_uuid()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(DatabaseError::LegacyImportNotFound)?;
    if LegacyImportState::parse(&source_state)? != LegacyImportState::Running {
        return Err(DatabaseError::InvalidLegacyImport);
    }
    let current =
        item_state(connection, source_id, candidate)?.ok_or(DatabaseError::LegacyImportNotFound)?;
    if current.is_terminal() {
        return Ok(());
    }
    let changed = connection.execute(
        "UPDATE legacy_import_items
         SET status = ?4, target_id = ?5, error_message = ?6, imported_at_ms = ?7
         WHERE source_id = ?1 AND legacy_key = ?2 AND item_kind = ?3
           AND status IN ('pending', 'failed')
           AND EXISTS (
             SELECT 1 FROM legacy_import_sources
             WHERE id = ?1 AND status = 'running'
           )",
        params![
            source_id.as_uuid(),
            candidate.key.as_str(),
            candidate.kind.as_str(),
            outcome.state.as_str(),
            outcome.target_id,
            outcome.detail_code,
            now_ms()
        ],
    )?;
    if changed == 1 {
        return Ok(());
    }
    match item_state(connection, source_id, candidate)? {
        Some(state) if state.is_terminal() => Ok(()),
        Some(_) => Err(DatabaseError::InvalidLegacyImport),
        None => Err(DatabaseError::LegacyImportNotFound),
    }
}

pub(in crate::storage) fn finish(
    connection: &Connection,
    source_id: LegacyImportId,
) -> Result<LegacyImportSummary, DatabaseError> {
    let current = summary(connection, source_id)?;
    if current.state == LegacyImportState::Complete {
        return Ok(current);
    }
    let counts = [
        current.settings,
        current.credentials,
        current.artifacts,
        current.ignored,
    ];
    let state = if counts
        .iter()
        .any(|count| count.pending != 0 || count.failed != 0)
    {
        LegacyImportState::Failed
    } else {
        LegacyImportState::Complete
    };
    let changed = connection.execute(
        "UPDATE legacy_import_sources SET status = ?2, completed_at_ms = ?3 WHERE id = ?1",
        params![source_id.as_uuid(), state.as_str(), now_ms()],
    )?;
    if changed != 1 {
        return Err(DatabaseError::LegacyImportNotFound);
    }
    summary(connection, source_id)
}

pub(in crate::storage) fn list(
    connection: &Connection,
) -> Result<Vec<LegacyImportSummary>, DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id FROM legacy_import_sources ORDER BY discovered_at_ms DESC, id DESC LIMIT 64",
    )?;
    let ids = statement
        .query_map([], |row| row.get::<_, Uuid>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| LegacyImportId::from_uuid(id).and_then(|id| summary(connection, id)))
        .collect()
}

pub(in crate::storage) fn interrupt_running(connection: &Connection) -> Result<u64, DatabaseError> {
    let changed = connection.execute(
        "UPDATE legacy_import_sources SET status = 'failed', completed_at_ms = ?1
         WHERE status IN ('pending', 'running')",
        [now_ms()],
    )?;
    u64::try_from(changed).map_err(|_| DatabaseError::InvalidLegacyImport)
}

pub(super) fn summary(
    connection: &Connection,
    source_id: LegacyImportId,
) -> Result<LegacyImportSummary, DatabaseError> {
    let (source_kind, state): (String, String) = connection
        .query_row(
            "SELECT source_kind, status FROM legacy_import_sources WHERE id = ?1",
            [source_id.as_uuid()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(DatabaseError::LegacyImportNotFound)?;
    let _ = LegacyImportSourceKind::parse(&source_kind)?;
    let mut result = LegacyImportSummary {
        source_id,
        state: LegacyImportState::parse(&state)?,
        settings: LegacyImportCounts::default(),
        credentials: LegacyImportCounts::default(),
        artifacts: LegacyImportCounts::default(),
        ignored: LegacyImportCounts::default(),
    };
    let mut statement = connection.prepare(
        "SELECT item_kind, status, COUNT(*) FROM legacy_import_items
         WHERE source_id = ?1 GROUP BY item_kind, status",
    )?;
    let mut rows = statement.query([source_id.as_uuid()])?;
    while let Some(row) = rows.next()? {
        let kind = LegacyImportItemKind::parse(&row.get::<_, String>(0)?)?;
        let item_state = LegacyImportItemState::parse(&row.get::<_, String>(1)?)?;
        let count =
            u64::try_from(row.get::<_, i64>(2)?).map_err(|_| DatabaseError::InvalidLegacyImport)?;
        match kind {
            LegacyImportItemKind::Setting => result.settings.increment(item_state, count),
            LegacyImportItemKind::Credential => result.credentials.increment(item_state, count),
            LegacyImportItemKind::Artifact => result.artifacts.increment(item_state, count),
            LegacyImportItemKind::Ignored => result.ignored.increment(item_state, count),
        }
    }
    Ok(result)
}

pub(super) fn validate_candidates(
    candidates: &[LegacyImportCandidate],
) -> Result<(), DatabaseError> {
    if candidates.len() > MAX_LEGACY_IMPORT_ITEMS {
        return Err(DatabaseError::InvalidLegacyImport);
    }
    let mut unique = HashSet::with_capacity(candidates.len());
    for candidate in candidates {
        if !unique.insert((candidate.kind, candidate.key.as_str())) {
            return Err(DatabaseError::InvalidLegacyImport);
        }
    }
    Ok(())
}

fn stored_candidates_match(
    connection: &Connection,
    source_id: LegacyImportId,
    candidates: &[LegacyImportCandidate],
) -> Result<bool, DatabaseError> {
    let stored_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM legacy_import_items WHERE source_id = ?1",
        [source_id.as_uuid()],
        |row| row.get(0),
    )?;
    if usize::try_from(stored_count).ok() != Some(candidates.len()) {
        return Ok(false);
    }
    let mut statement = connection.prepare(
        "SELECT EXISTS(
           SELECT 1 FROM legacy_import_items
           WHERE source_id = ?1 AND legacy_key = ?2 AND item_kind = ?3
         )",
    )?;
    for candidate in candidates {
        let exists = statement.query_row(
            params![
                source_id.as_uuid(),
                candidate.key.as_str(),
                candidate.kind.as_str()
            ],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn validate_outcome(outcome: &LegacyImportItemOutcome) -> Result<(), DatabaseError> {
    if outcome.state == LegacyImportItemState::Pending
        || outcome.target_id.is_some_and(|id| {
            id.get_version() != Some(Version::SortRand) || id.get_variant() != Variant::RFC4122
        })
        || outcome.detail_code.is_some_and(|code| {
            code.is_empty()
                || code.len() > MAX_DETAIL_CODE_BYTES
                || !code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        })
        || (outcome.state == LegacyImportItemState::Imported && outcome.detail_code.is_some())
        || (outcome.state != LegacyImportItemState::Imported && outcome.target_id.is_some())
        || (matches!(
            outcome.state,
            LegacyImportItemState::Skipped | LegacyImportItemState::Failed
        ) && outcome.detail_code.is_none())
    {
        Err(DatabaseError::InvalidLegacyImport)
    } else {
        Ok(())
    }
}
