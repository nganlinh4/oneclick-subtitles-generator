use std::collections::HashSet;
use std::fmt;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use uuid::{Uuid, Variant, Version};

use super::actor::now_ms;
use super::{ContentHash, DatabaseError};

pub const MAX_LEGACY_IMPORT_ITEMS: usize = 20_000;
const MAX_ITEM_KEY_BYTES: usize = 2_048;
const MAX_DETAIL_CODE_BYTES: usize = 128;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct LegacyImportId(Uuid);

impl LegacyImportId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub(crate) fn from_uuid(value: Uuid) -> Result<Self, DatabaseError> {
        if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122
        {
            Ok(Self(value))
        } else {
            Err(DatabaseError::InvalidLegacyImport)
        }
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for LegacyImportId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for LegacyImportId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyImportSourceKind {
    ElectronRootV1,
}

impl LegacyImportSourceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ElectronRootV1 => "electronRootV1",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "electronRootV1" => Ok(Self::ElectronRootV1),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LegacyImportItemKind {
    Setting,
    Credential,
    Artifact,
    Ignored,
}

impl LegacyImportItemKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Setting => "setting",
            Self::Credential => "credential",
            Self::Artifact => "artifact",
            Self::Ignored => "ignored",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "setting" => Ok(Self::Setting),
            "credential" => Ok(Self::Credential),
            "artifact" => Ok(Self::Artifact),
            "ignored" => Ok(Self::Ignored),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyImportState {
    Running,
    Complete,
    Failed,
}

impl LegacyImportState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Complete => "complete",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "pending" | "running" => Ok(Self::Running),
            "complete" => Ok(Self::Complete),
            "failed" => Ok(Self::Failed),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyImportItemState {
    Pending,
    Imported,
    Skipped,
    Failed,
}

impl LegacyImportItemState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Imported => "imported",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "pending" => Ok(Self::Pending),
            "imported" => Ok(Self::Imported),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }

    const fn is_terminal(self) -> bool {
        matches!(self, Self::Imported | Self::Skipped)
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct LegacyImportItemKey(String);

impl LegacyImportItemKey {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_ITEM_KEY_BYTES
            || value.chars().any(char::is_control)
        {
            Err(DatabaseError::InvalidLegacyImport)
        } else {
            Ok(Self(value))
        }
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LegacyImportItemKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted legacy item key>")
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct LegacyImportCandidate {
    key: LegacyImportItemKey,
    kind: LegacyImportItemKind,
}

impl LegacyImportCandidate {
    #[must_use]
    pub const fn new(key: LegacyImportItemKey, kind: LegacyImportItemKind) -> Self {
        Self { key, kind }
    }

    #[must_use]
    pub const fn key(&self) -> &LegacyImportItemKey {
        &self.key
    }

    #[must_use]
    pub const fn kind(&self) -> LegacyImportItemKind {
        self.kind
    }
}

impl fmt::Debug for LegacyImportCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LegacyImportCandidate")
            .field("key", &self.key)
            .field("kind", &self.kind)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportCounts {
    pub pending: u64,
    pub imported: u64,
    pub skipped: u64,
    pub failed: u64,
}

impl LegacyImportCounts {
    fn increment(&mut self, state: LegacyImportItemState, count: u64) {
        match state {
            LegacyImportItemState::Pending => self.pending += count,
            LegacyImportItemState::Imported => self.imported += count,
            LegacyImportItemState::Skipped => self.skipped += count,
            LegacyImportItemState::Failed => self.failed += count,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportSummary {
    pub source_id: LegacyImportId,
    pub state: LegacyImportState,
    pub settings: LegacyImportCounts,
    pub credentials: LegacyImportCounts,
    pub artifacts: LegacyImportCounts,
    pub ignored: LegacyImportCounts,
}

impl LegacyImportSummary {
    #[must_use]
    pub const fn source_id(&self) -> LegacyImportId {
        self.source_id
    }

    #[must_use]
    pub const fn state(&self) -> LegacyImportState {
        self.state
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyImportItemOutcome {
    state: LegacyImportItemState,
    target_id: Option<Uuid>,
    detail_code: Option<&'static str>,
}

impl LegacyImportItemOutcome {
    #[must_use]
    pub const fn imported(target_id: Option<Uuid>) -> Self {
        Self {
            state: LegacyImportItemState::Imported,
            target_id,
            detail_code: None,
        }
    }

    #[must_use]
    pub const fn skipped(detail_code: &'static str) -> Self {
        Self {
            state: LegacyImportItemState::Skipped,
            target_id: None,
            detail_code: Some(detail_code),
        }
    }

    #[must_use]
    pub const fn failed(detail_code: &'static str) -> Self {
        Self {
            state: LegacyImportItemState::Failed,
            target_id: None,
            detail_code: Some(detail_code),
        }
    }
}

pub(super) fn prepare(
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

pub(super) fn item_state(
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

pub(super) fn record_item(
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

pub(super) fn finish(
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

pub(super) fn list(connection: &Connection) -> Result<Vec<LegacyImportSummary>, DatabaseError> {
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

pub(super) fn interrupt_running(connection: &Connection) -> Result<u64, DatabaseError> {
    let changed = connection.execute(
        "UPDATE legacy_import_sources SET status = 'failed', completed_at_ms = ?1
         WHERE status IN ('pending', 'running')",
        [now_ms()],
    )?;
    u64::try_from(changed).map_err(|_| DatabaseError::InvalidLegacyImport)
}

fn summary(
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

fn validate_candidates(candidates: &[LegacyImportCandidate]) -> Result<(), DatabaseError> {
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

fn validate_outcome(outcome: &LegacyImportItemOutcome) -> Result<(), DatabaseError> {
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

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .execute_batch(include_str!("sql/0001_initial.sql"))
            .expect("create schema");
        connection
    }

    fn candidate(key: &str, kind: LegacyImportItemKind) -> LegacyImportCandidate {
        LegacyImportCandidate::new(LegacyImportItemKey::new(key).expect("valid key"), kind)
    }

    #[test]
    fn imports_resume_without_replaying_terminal_items() {
        let mut connection = connection();
        let candidates = vec![
            candidate("setting/theme", LegacyImportItemKind::Setting),
            candidate(
                "artifact/videos/example.mp4",
                LegacyImportItemKind::Artifact,
            ),
        ];
        let fingerprint = ContentHash::digest(b"same source");
        let first = prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            &candidates,
        )
        .expect("prepare import");
        record_item(
            &connection,
            first.source_id,
            &candidates[0],
            &LegacyImportItemOutcome::imported(None),
        )
        .expect("record setting");
        record_item(
            &connection,
            first.source_id,
            &candidates[1],
            &LegacyImportItemOutcome::failed("sourceChanged"),
        )
        .expect("record failure");
        assert_eq!(
            finish(&connection, first.source_id)
                .expect("finish partial import")
                .state,
            LegacyImportState::Failed
        );

        let resumed = prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            &candidates,
        )
        .expect("resume import");
        assert_eq!(resumed.source_id, first.source_id);
        assert_eq!(
            item_state(&connection, resumed.source_id, &candidates[0]).expect("read state"),
            Some(LegacyImportItemState::Imported)
        );
        assert_eq!(
            item_state(&connection, resumed.source_id, &candidates[1]).expect("read state"),
            Some(LegacyImportItemState::Failed)
        );
        record_item(
            &connection,
            resumed.source_id,
            &candidates[1],
            &LegacyImportItemOutcome::imported(Some(Uuid::now_v7())),
        )
        .expect("record retry");
        let complete = finish(&connection, resumed.source_id).expect("finish import");
        assert_eq!(complete.state, LegacyImportState::Complete);
        assert_eq!(complete.settings.imported, 1);
        assert_eq!(complete.artifacts.imported, 1);
    }

    #[test]
    fn completed_fingerprint_is_idempotent() {
        let mut connection = connection();
        let candidate = candidate("ignored/oauth", LegacyImportItemKind::Ignored);
        let fingerprint = ContentHash::digest(b"finished source");
        let first = prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            std::slice::from_ref(&candidate),
        )
        .expect("prepare import");
        record_item(
            &connection,
            first.source_id,
            &candidate,
            &LegacyImportItemOutcome::skipped("unsupportedSecret"),
        )
        .expect("record skip");
        let finished = finish(&connection, first.source_id).expect("finish import");
        assert_eq!(finished.state, LegacyImportState::Complete);

        let repeated = prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            std::slice::from_ref(&candidate),
        )
        .expect("repeat import");
        assert_eq!(repeated, finished);
    }

    #[test]
    fn a_running_fingerprint_cannot_be_prepared_concurrently() {
        let mut connection = connection();
        let candidate = candidate("setting/theme", LegacyImportItemKind::Setting);
        let fingerprint = ContentHash::digest(b"concurrent source");
        prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            std::slice::from_ref(&candidate),
        )
        .expect("prepare first import");

        assert!(matches!(
            prepare(
                &mut connection,
                LegacyImportSourceKind::ElectronRootV1,
                fingerprint,
                std::slice::from_ref(&candidate),
            ),
            Err(DatabaseError::LegacyImportBusy)
        ));
    }

    #[test]
    fn a_fingerprint_cannot_resume_with_a_different_candidate_manifest() {
        let mut connection = connection();
        let first = candidate("setting/theme", LegacyImportItemKind::Setting);
        let fingerprint = ContentHash::digest(b"stable manifest");
        let prepared = prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            std::slice::from_ref(&first),
        )
        .expect("prepare import");
        record_item(
            &connection,
            prepared.source_id,
            &first,
            &LegacyImportItemOutcome::failed("interrupted"),
        )
        .expect("record interruption");
        finish(&connection, prepared.source_id).expect("finish failed import");

        let replacement = candidate("setting/locale", LegacyImportItemKind::Setting);
        assert!(matches!(
            prepare(
                &mut connection,
                LegacyImportSourceKind::ElectronRootV1,
                fingerprint,
                std::slice::from_ref(&replacement),
            ),
            Err(DatabaseError::InvalidLegacyImport)
        ));
    }

    #[test]
    fn candidate_and_outcome_validation_is_strict() {
        assert!(LegacyImportItemKey::new("").is_err());
        assert!(LegacyImportItemKey::new("line\nbreak").is_err());
        let duplicate = candidate("same", LegacyImportItemKind::Setting);
        assert!(validate_candidates(&[duplicate.clone(), duplicate]).is_err());
        assert!(
            validate_outcome(&LegacyImportItemOutcome::failed("contains secret text")).is_err()
        );
        assert!(
            validate_outcome(&LegacyImportItemOutcome {
                state: LegacyImportItemState::Skipped,
                target_id: Some(Uuid::now_v7()),
                detail_code: Some("skip"),
            })
            .is_err()
        );
    }

    #[test]
    fn stale_running_sources_are_interrupted_on_startup() {
        let mut connection = connection();
        let candidate = candidate("setting/theme", LegacyImportItemKind::Setting);
        let prepared = prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            ContentHash::digest(b"crashed source"),
            std::slice::from_ref(&candidate),
        )
        .expect("prepare import");
        assert_eq!(interrupt_running(&connection).expect("interrupt"), 1);
        assert_eq!(
            summary(&connection, prepared.source_id)
                .expect("read summary")
                .state,
            LegacyImportState::Failed
        );
        assert!(matches!(
            record_item(
                &connection,
                prepared.source_id,
                &candidate,
                &LegacyImportItemOutcome::imported(None),
            ),
            Err(DatabaseError::InvalidLegacyImport)
        ));
    }
}
