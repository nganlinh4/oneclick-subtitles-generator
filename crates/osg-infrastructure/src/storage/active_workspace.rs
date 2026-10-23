use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use osg_domain::{AssetId, ProjectId, TrackId};

use super::DatabaseError;

const WORKSPACE_SCOPE: &str = "active_workspace";
const WORKSPACE_KEY: &str = "current";
const WORKSPACE_INITIALIZED_KEY: &str = "initialized";
const WORKSPACE_INTENT_KEY: &str = "intent";
const WORKSPACE_SCHEMA_VERSION: u16 = 1;
const PROJECT_ALIAS_INDEX_KEY: &str = "project.subtitleCacheIndex.v1";
const PROJECT_ALIAS_INDEX_SCHEMA_VERSION: u16 = 1;
const APP_SETTINGS_SCOPE: &str = "app";
const MAX_CACHE_ID_CHARACTERS: usize = 8_192;
const MAX_PROJECT_ALIASES: usize = 2_048;
const MAX_PROJECT_ALIAS_INDEX_BYTES: usize = 900 * 1024;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Exact durable identity of the editor workspace which should reopen after a process or `WebView`
/// restart. This is product state, not a user preference: clearing the `app` settings scope must
/// not erase it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkspace {
    pub schema_version: u16,
    pub cache_id: String,
    pub project_id: ProjectId,
    pub media_id: AssetId,
    pub track_id: Option<TrackId>,
    pub project_state_version: u64,
}

/// Atomic read of workspace authority. `initialized && workspace.is_none()` is a durable
/// tombstone: an ordinary user removal has won, so an old browser mirror must never be migrated
/// back into native state after a crash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkspaceState {
    pub schema_version: u16,
    pub initialized: bool,
    pub workspace: Option<ActiveWorkspace>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredActiveWorkspace {
    schema_version: u16,
    cache_id: String,
    project_id: ProjectId,
    media_id: AssetId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::struct_field_names,
    reason = "cache_id, project_id, and media_id are the three distinct product identities"
)]
pub struct ActiveWorkspacePointer {
    cache_id: String,
    project_id: ProjectId,
    media_id: AssetId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAliasEntry {
    pub cache_id: String,
    pub project_id: ProjectId,
    pub last_opened_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAliasIndex {
    pub schema_version: u16,
    pub active_cache_id: Option<String>,
    pub entries: Vec<ProjectAliasEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAliasMutation {
    pub changed: bool,
    pub index: ProjectAliasIndex,
}

impl ActiveWorkspacePointer {
    pub fn new(
        cache_id: impl Into<String>,
        project_id: ProjectId,
        media_id: AssetId,
    ) -> Result<Self, DatabaseError> {
        let cache_id = cache_id.into();
        validate_cache_id(&cache_id)?;
        Ok(Self {
            cache_id,
            project_id,
            media_id,
        })
    }

    #[must_use]
    pub fn cache_id(&self) -> &str {
        &self.cache_id
    }

    #[must_use]
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }

    #[must_use]
    pub const fn media_id(&self) -> AssetId {
        self.media_id
    }
}

pub(super) fn get_active_workspace(
    connection: &Connection,
) -> Result<ActiveWorkspaceState, DatabaseError> {
    let stored = read_stored(connection)?;
    let initialized_marker = read_initialized(connection)?;
    let initialized = stored.is_some() || initialized_marker;
    let workspace = stored
        .as_ref()
        .map(|pointer| current_workspace(connection, pointer))
        .transpose()?
        .flatten();
    Ok(ActiveWorkspaceState {
        schema_version: WORKSPACE_SCHEMA_VERSION,
        initialized,
        workspace,
    })
}

pub(super) fn set_active_workspace(
    connection: &mut Connection,
    pointer: &ActiveWorkspacePointer,
    intent_id: Uuid,
) -> Result<ActiveWorkspace, DatabaseError> {
    let transaction = connection.transaction()?;
    require_current_intent(&transaction, intent_id)?;
    let stored = StoredActiveWorkspace {
        schema_version: WORKSPACE_SCHEMA_VERSION,
        cache_id: pointer.cache_id.clone(),
        project_id: pointer.project_id,
        media_id: pointer.media_id,
    };
    let active =
        current_workspace(&transaction, &stored)?.ok_or(DatabaseError::InvalidActiveWorkspace)?;
    let encoded = serde_json::to_string(&stored)?;
    transaction.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, ?3, unixepoch('subsec') * 1000)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![WORKSPACE_SCOPE, WORKSPACE_KEY, encoded],
    )?;
    write_initialized(&transaction)?;
    transaction.commit()?;
    Ok(active)
}

pub(super) fn clear_active_workspace(
    connection: &mut Connection,
    expected: Option<&ActiveWorkspacePointer>,
    intent_id: Uuid,
) -> Result<bool, DatabaseError> {
    let transaction = connection.transaction()?;
    require_current_intent(&transaction, intent_id)?;
    let stored = read_stored(&transaction)?;
    let owns_clear = match (expected, stored.as_ref()) {
        // No caller may turn "I do not know the owner" into an unconditional delete. `None` is
        // useful only for establishing the initial tombstone while authority is already empty.
        // An ordinary release first reads the exact native tuple and supplies it here.
        (None | Some(_), None) => true,
        (None, Some(_)) => false,
        (Some(expected), Some(current)) => {
            current.cache_id == expected.cache_id
                && current.project_id == expected.project_id
                && current.media_id == expected.media_id
        }
    };
    if owns_clear {
        transaction.execute(
            "DELETE FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![WORKSPACE_SCOPE, WORKSPACE_KEY],
        )?;
    }
    write_initialized(&transaction)?;
    transaction.commit()?;
    Ok(owns_clear)
}

pub(super) fn begin_active_workspace_intent(
    connection: &mut Connection,
    intent_id: Uuid,
) -> Result<(), DatabaseError> {
    let encoded = serde_json::to_string(&intent_id)?;
    connection.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, ?3, unixepoch('subsec') * 1000)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![WORKSPACE_SCOPE, WORKSPACE_INTENT_KEY, encoded],
    )?;
    Ok(())
}

fn require_current_intent(connection: &Connection, intent_id: Uuid) -> Result<(), DatabaseError> {
    let encoded = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![WORKSPACE_SCOPE, WORKSPACE_INTENT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let stored = encoded
        .as_deref()
        .and_then(|value| serde_json::from_str::<Uuid>(value).ok());
    if stored != Some(intent_id) {
        return Err(DatabaseError::StaleActiveWorkspaceIntent);
    }
    Ok(())
}

fn read_initialized(connection: &Connection) -> Result<bool, DatabaseError> {
    let encoded = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![WORKSPACE_SCOPE, WORKSPACE_INITIALIZED_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match encoded.as_deref() {
        None => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err(DatabaseError::InvalidActiveWorkspace),
    }
}

fn write_initialized(connection: &Connection) -> Result<(), DatabaseError> {
    connection.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, 'true', unixepoch('subsec') * 1000)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![WORKSPACE_SCOPE, WORKSPACE_INITIALIZED_KEY],
    )?;
    Ok(())
}

pub(super) fn get_project_alias_index(
    connection: &mut Connection,
) -> Result<Option<ProjectAliasIndex>, DatabaseError> {
    let encoded = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![WORKSPACE_SCOPE, PROJECT_ALIAS_INDEX_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let decoded = decode_project_alias_index(&encoded)?;
    let normalized = prune_missing_projects(connection, decoded)?;
    let normalized_json = serde_json::to_string(&normalized)?;
    if normalized_json != encoded {
        write_project_alias_index(connection, &normalized_json)?;
    }
    Ok(Some(normalized))
}

pub(super) fn set_project_alias_index(
    connection: &mut Connection,
    index: &ProjectAliasIndex,
) -> Result<(), DatabaseError> {
    validate_project_alias_index(index)?;
    for entry in &index.entries {
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [entry.project_id.as_uuid()],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(DatabaseError::InvalidProjectAliasIndex);
        }
    }
    let encoded = serde_json::to_string(index)?;
    if encoded.len() > MAX_PROJECT_ALIAS_INDEX_BYTES {
        return Err(DatabaseError::InvalidProjectAliasIndex);
    }
    write_project_alias_index(connection, &encoded)
}

pub(super) fn activate_project_alias(
    connection: &mut Connection,
    entry: &ProjectAliasEntry,
) -> Result<ProjectAliasIndex, DatabaseError> {
    validate_cache_id(&entry.cache_id).map_err(|_| DatabaseError::InvalidProjectAliasIndex)?;
    if entry.last_opened_at > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Err(DatabaseError::InvalidProjectAliasIndex);
    }
    let project_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [entry.project_id.as_uuid()],
        |row| row.get::<_, bool>(0),
    )?;
    if !project_exists {
        return Err(DatabaseError::InvalidProjectAliasIndex);
    }
    let mut index = get_project_alias_index(connection)?.unwrap_or(ProjectAliasIndex {
        schema_version: PROJECT_ALIAS_INDEX_SCHEMA_VERSION,
        active_cache_id: None,
        entries: Vec::new(),
    });
    activate_alias_in_index(&mut index, entry, MAX_PROJECT_ALIASES);
    set_project_alias_index(connection, &index)?;
    Ok(index)
}

fn activate_alias_in_index(
    index: &mut ProjectAliasIndex,
    entry: &ProjectAliasEntry,
    maximum: usize,
) {
    debug_assert!(maximum > 0);
    index.entries.retain(|existing| {
        existing.cache_id != entry.cache_id && existing.project_id != entry.project_id
    });
    index.entries.sort_by(|left, right| {
        right
            .last_opened_at
            .cmp(&left.last_opened_at)
            .then_with(|| left.cache_id.cmp(&right.cache_id))
    });
    // The activating alias is authority even if the wall clock moved backwards. Reserve its slot
    // before sorting instead of letting an old `last_opened_at` truncate the current project.
    index.entries.truncate(maximum.saturating_sub(1));
    index.entries.push(entry.clone());
    index.entries.sort_by(|left, right| {
        right
            .last_opened_at
            .cmp(&left.last_opened_at)
            .then_with(|| left.cache_id.cmp(&right.cache_id))
    });
    index.active_cache_id = Some(entry.cache_id.clone());
}

pub(super) fn remove_project_alias(
    connection: &mut Connection,
    cache_id: &str,
    expected_project_id: ProjectId,
) -> Result<ProjectAliasMutation, DatabaseError> {
    validate_cache_id(cache_id).map_err(|_| DatabaseError::InvalidProjectAliasIndex)?;
    let Some(mut index) = get_project_alias_index(connection)? else {
        return Ok(ProjectAliasMutation {
            changed: false,
            index: ProjectAliasIndex {
                schema_version: PROJECT_ALIAS_INDEX_SCHEMA_VERSION,
                active_cache_id: None,
                entries: Vec::new(),
            },
        });
    };
    let before = index.entries.len();
    index
        .entries
        .retain(|entry| entry.cache_id != cache_id || entry.project_id != expected_project_id);
    let changed = index.entries.len() != before;
    if changed {
        if index.active_cache_id.as_deref() == Some(cache_id) {
            index.active_cache_id = None;
        }
        set_project_alias_index(connection, &index)?;
    }
    Ok(ProjectAliasMutation { changed, index })
}

fn write_project_alias_index(
    connection: &mut Connection,
    encoded: &str,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, ?3, unixepoch('subsec') * 1000)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![WORKSPACE_SCOPE, PROJECT_ALIAS_INDEX_KEY, encoded],
    )?;
    transaction.execute(
        "DELETE FROM app_settings WHERE scope = ?1 AND key = ?2",
        params![APP_SETTINGS_SCOPE, PROJECT_ALIAS_INDEX_KEY],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Moves the former browser-preference record before the actor accepts commands. A factory reset
/// performed immediately after an upgrade therefore cannot erase inactive project aliases before
/// JavaScript happens to read them.
pub(super) fn migrate_legacy_project_alias_index(
    connection: &mut Connection,
) -> Result<(), DatabaseError> {
    let workspace_exists = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM app_settings WHERE scope = ?1 AND key = ?2
         )",
        params![WORKSPACE_SCOPE, PROJECT_ALIAS_INDEX_KEY],
        |row| row.get::<_, bool>(0),
    )?;
    if workspace_exists {
        connection.execute(
            "DELETE FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![APP_SETTINGS_SCOPE, PROJECT_ALIAS_INDEX_KEY],
        )?;
        return Ok(());
    }
    let legacy = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![APP_SETTINGS_SCOPE, PROJECT_ALIAS_INDEX_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(legacy) = legacy else {
        return Ok(());
    };
    let Ok(index) = decode_project_alias_index(&legacy) else {
        // A damaged legacy preference never becomes native product authority. Leave it in its old
        // scope so the existing reset path can remove it without making database startup fail.
        return Ok(());
    };
    let normalized = prune_missing_projects(connection, index)?;
    set_project_alias_index(connection, &normalized)
}

fn read_stored(connection: &Connection) -> Result<Option<StoredActiveWorkspace>, DatabaseError> {
    let encoded = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![WORKSPACE_SCOPE, WORKSPACE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let stored: StoredActiveWorkspace =
        serde_json::from_str(&encoded).map_err(|_| DatabaseError::InvalidActiveWorkspace)?;
    if stored.schema_version != WORKSPACE_SCHEMA_VERSION {
        return Err(DatabaseError::InvalidActiveWorkspace);
    }
    validate_cache_id(&stored.cache_id)?;
    Ok(Some(stored))
}

fn current_workspace(
    connection: &Connection,
    stored: &StoredActiveWorkspace,
) -> Result<Option<ActiveWorkspace>, DatabaseError> {
    let state = connection
        .query_row(
            "SELECT active_media_id, active_track_id, state_version
             FROM project_state WHERE project_id = ?1",
            [stored.project_id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, Option<uuid::Uuid>>(0)?,
                    row.get::<_, Option<uuid::Uuid>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((media_id, track_id, state_version)) = state else {
        return Ok(None);
    };
    let Some(media_id) = media_id.and_then(|id| AssetId::from_uuid(id).ok()) else {
        return Ok(None);
    };
    if media_id != stored.media_id {
        return Ok(None);
    }
    let track_id = track_id
        .map(TrackId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::InvalidActiveWorkspace)?;
    let project_state_version =
        u64::try_from(state_version).map_err(|_| DatabaseError::InvalidActiveWorkspace)?;
    if project_state_version > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Err(DatabaseError::InvalidActiveWorkspace);
    }
    Ok(Some(ActiveWorkspace {
        schema_version: WORKSPACE_SCHEMA_VERSION,
        cache_id: stored.cache_id.clone(),
        project_id: stored.project_id,
        media_id,
        track_id,
        project_state_version,
    }))
}

fn validate_cache_id(cache_id: &str) -> Result<(), DatabaseError> {
    if cache_id.is_empty()
        || cache_id.encode_utf16().count() > MAX_CACHE_ID_CHARACTERS
        || cache_id.chars().any(char::is_control)
    {
        return Err(DatabaseError::InvalidActiveWorkspace);
    }
    Ok(())
}

fn decode_project_alias_index(encoded: &str) -> Result<ProjectAliasIndex, DatabaseError> {
    if encoded.len() > MAX_PROJECT_ALIAS_INDEX_BYTES {
        return Err(DatabaseError::InvalidProjectAliasIndex);
    }
    let index: ProjectAliasIndex =
        serde_json::from_str(encoded).map_err(|_| DatabaseError::InvalidProjectAliasIndex)?;
    validate_project_alias_index(&index)?;
    Ok(index)
}

fn validate_project_alias_index(index: &ProjectAliasIndex) -> Result<(), DatabaseError> {
    use std::collections::HashSet;

    if index.schema_version != PROJECT_ALIAS_INDEX_SCHEMA_VERSION
        || index.entries.len() > MAX_PROJECT_ALIASES
    {
        return Err(DatabaseError::InvalidProjectAliasIndex);
    }
    let mut cache_ids = HashSet::with_capacity(index.entries.len());
    let mut project_ids = HashSet::with_capacity(index.entries.len());
    for entry in &index.entries {
        validate_cache_id(&entry.cache_id).map_err(|_| DatabaseError::InvalidProjectAliasIndex)?;
        if entry.last_opened_at > MAX_JAVASCRIPT_SAFE_INTEGER
            || !cache_ids.insert(entry.cache_id.as_str())
            || !project_ids.insert(entry.project_id)
        {
            return Err(DatabaseError::InvalidProjectAliasIndex);
        }
    }
    if let Some(active) = index.active_cache_id.as_deref() {
        validate_cache_id(active).map_err(|_| DatabaseError::InvalidProjectAliasIndex)?;
        if !cache_ids.contains(active) {
            return Err(DatabaseError::InvalidProjectAliasIndex);
        }
    }
    Ok(())
}

fn prune_missing_projects(
    connection: &Connection,
    mut index: ProjectAliasIndex,
) -> Result<ProjectAliasIndex, DatabaseError> {
    let mut retained = Vec::with_capacity(index.entries.len());
    for entry in index.entries {
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [entry.project_id.as_uuid()],
            |row| row.get::<_, bool>(0),
        )?;
        if exists {
            retained.push(entry);
        }
    }
    index.entries = retained;
    if index
        .active_cache_id
        .as_ref()
        .is_some_and(|active| !index.entries.iter().any(|entry| &entry.cache_id == active))
    {
        index.active_cache_id = None;
    }
    Ok(index)
}

#[cfg(test)]
mod tests;
