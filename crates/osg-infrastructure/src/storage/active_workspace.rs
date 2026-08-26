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
mod tests {
    use rusqlite::{Connection, params};
    use uuid::Uuid;

    use osg_domain::{AssetId, ProjectId, TrackId};

    use super::{
        ActiveWorkspacePointer, ProjectAliasEntry, ProjectAliasIndex, activate_alias_in_index,
        activate_project_alias, begin_active_workspace_intent, clear_active_workspace,
        get_active_workspace, get_project_alias_index, migrate_legacy_project_alias_index,
        remove_project_alias, set_active_workspace, set_project_alias_index,
    };
    use crate::storage::DatabaseError;

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys");
        connection
            .execute_batch(include_str!("sql/0001_initial.sql"))
            .expect("schema");
        connection
    }

    fn seed_project(
        connection: &Connection,
        project_id: ProjectId,
        media_id: AssetId,
        track_id: TrackId,
        hash: &[u8; 32],
        timestamp: i64,
    ) {
        connection
            .execute(
                "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 7, ?3, ?3)",
                params![
                    project_id.as_uuid(),
                    format!("Project {timestamp}"),
                    timestamp
                ],
            )
            .expect("project");
        connection
            .execute(
                "INSERT INTO media_assets(
                   id, kind, display_name, extension, size_bytes, content_hash,
                   metadata_json, created_at_ms
                 ) VALUES (?1, 'video', 'same.mp4', 'mp4', 8, ?2, '{}', ?3)",
                params![media_id.as_uuid(), hash.as_slice(), timestamp],
            )
            .expect("media");
        connection
            .execute(
                "INSERT INTO project_media(project_id, media_id, role, ordinal)
                 VALUES (?1, ?2, 'primary', 0)",
                params![project_id.as_uuid(), media_id.as_uuid()],
            )
            .expect("project media");
        connection
            .execute(
                "INSERT INTO tracks(
                   id, project_id, ordinal, role, language, label, origin,
                   state_version, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, 0, 'original', 'en', 'Cached subtitles',
                           'legacyJson', 1, ?3, ?3)",
                params![track_id.as_uuid(), project_id.as_uuid(), timestamp],
            )
            .expect("track");
        connection
            .execute(
                "INSERT INTO project_state(
                   project_id, active_media_id, active_track_id, current_revision_id,
                   state_version, updated_at_ms
                 ) VALUES (?1, ?2, ?3, NULL, 7, ?4)",
                params![
                    project_id.as_uuid(),
                    media_id.as_uuid(),
                    track_id.as_uuid(),
                    timestamp,
                ],
            )
            .expect("project state");
    }

    fn begin(connection: &mut Connection) -> Uuid {
        let intent = Uuid::now_v7();
        begin_active_workspace_intent(connection, intent).expect("begin workspace intent");
        intent
    }

    #[test]
    fn exact_project_media_and_track_survive_preference_clear_without_content_dedupe() {
        let mut connection = fixture();
        let shared_hash = [41_u8; 32];
        let project_a = ProjectId::new();
        let media_a = AssetId::new();
        let track_a = TrackId::new();
        let project_b = ProjectId::new();
        let media_b = AssetId::new();
        let track_b = TrackId::new();
        seed_project(&connection, project_a, media_a, track_a, &shared_hash, 1);
        seed_project(&connection, project_b, media_b, track_b, &shared_hash, 2);
        let initially_empty = get_active_workspace(&connection).expect("initial workspace state");
        assert!(!initially_empty.initialized);
        assert!(initially_empty.workspace.is_none());
        connection
            .execute(
                "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('app', 'theme', '\"dark\"', 3)",
                [],
            )
            .expect("preference");
        connection
            .execute(
                "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('app', 'project.subtitleCacheIndex.v1', ?1, 3)",
                [format!(
                    "{{\"schemaVersion\":1,\"activeCacheId\":\"asset-b\",\"entries\":[{{\"cacheId\":\"asset-a\",\"projectId\":\"{project_a}\",\"lastOpenedAt\":1}},{{\"cacheId\":\"asset-b\",\"projectId\":\"{project_b}\",\"lastOpenedAt\":2}}]}}"
                )],
            )
            .expect("legacy alias index");

        let pointer =
            ActiveWorkspacePointer::new("asset-b", project_b, media_b).expect("workspace pointer");
        let intent = begin(&mut connection);
        let stored =
            set_active_workspace(&mut connection, &pointer, intent).expect("store workspace");
        assert_eq!(stored.project_id, project_b);
        assert_eq!(stored.media_id, media_b);
        assert_eq!(stored.track_id, Some(track_b));

        migrate_legacy_project_alias_index(&mut connection).expect("migrate alias index");

        connection
            .execute("DELETE FROM app_settings WHERE scope = 'app'", [])
            .expect("clear preferences");
        let restored = get_active_workspace(&connection)
            .expect("read workspace")
            .workspace
            .expect("workspace survives");
        assert_eq!(restored.project_id, project_b);
        assert_eq!(restored.media_id, media_b);
        assert_eq!(restored.track_id, Some(track_b));
        assert_ne!(restored.project_id, project_a);
        assert_ne!(restored.media_id, media_a);
        assert_ne!(restored.track_id, Some(track_a));
        let aliases = get_project_alias_index(&mut connection)
            .expect("read aliases")
            .expect("aliases survive");
        assert_eq!(aliases.entries.len(), 2);
        assert_eq!(aliases.entries[0].project_id, project_a);
        assert_eq!(aliases.entries[1].project_id, project_b);
        assert_eq!(aliases.active_cache_id.as_deref(), Some("asset-b"));

        let reopened_a = activate_project_alias(
            &mut connection,
            &ProjectAliasEntry {
                cache_id: "asset-a".to_owned(),
                project_id: project_a,
                last_opened_at: 3,
            },
        )
        .expect("reopen inactive A by exact alias");
        assert_eq!(reopened_a.active_cache_id.as_deref(), Some("asset-a"));
        assert!(
            reopened_a
                .entries
                .iter()
                .any(|entry| { entry.cache_id == "asset-b" && entry.project_id == project_b })
        );
        let reopened_b = activate_project_alias(
            &mut connection,
            &ProjectAliasEntry {
                cache_id: "asset-b".to_owned(),
                project_id: project_b,
                last_opened_at: 4,
            },
        )
        .expect("reopen B by exact alias");
        assert_eq!(reopened_b.active_cache_id.as_deref(), Some("asset-b"));
        assert!(
            reopened_b
                .entries
                .iter()
                .any(|entry| { entry.cache_id == "asset-a" && entry.project_id == project_a })
        );
        assert_eq!(
            get_active_workspace(&connection)
                .expect("read restored winner")
                .workspace
                .expect("winner remains durable")
                .project_id,
            project_b
        );
    }

    #[test]
    fn cross_project_media_is_refused_and_conditional_clear_cannot_erase_a_new_winner() {
        let mut connection = fixture();
        let shared_hash = [9_u8; 32];
        let project_a = ProjectId::new();
        let media_a = AssetId::new();
        let track_a = TrackId::new();
        let project_b = ProjectId::new();
        let media_b = AssetId::new();
        let track_b = TrackId::new();
        seed_project(&connection, project_a, media_a, track_a, &shared_hash, 1);
        seed_project(&connection, project_b, media_b, track_b, &shared_hash, 2);

        let invalid = ActiveWorkspacePointer::new("bad", project_a, media_b).expect("bounded");
        let invalid_intent = begin(&mut connection);
        assert!(matches!(
            set_active_workspace(&mut connection, &invalid, invalid_intent),
            Err(DatabaseError::InvalidActiveWorkspace)
        ));

        let winner = ActiveWorkspacePointer::new("winner", project_b, media_b).expect("winner");
        let stale_intent = begin(&mut connection);
        let winner_intent = begin(&mut connection);
        assert!(matches!(
            set_active_workspace(&mut connection, &winner, stale_intent),
            Err(DatabaseError::StaleActiveWorkspaceIntent)
        ));
        set_active_workspace(&mut connection, &winner, winner_intent).expect("store winner");
        let ownerless_clear_intent = begin(&mut connection);
        assert!(
            !clear_active_workspace(&mut connection, None, ownerless_clear_intent)
                .expect("ownerless clear")
        );
        assert_eq!(
            get_active_workspace(&connection)
                .expect("read winner after ownerless clear")
                .workspace
                .expect("winner survives ownerless clear")
                .project_id,
            project_b
        );
        let stale = ActiveWorkspacePointer::new("stale", project_a, media_a).expect("stale");
        let stale_clear_intent = begin(&mut connection);
        assert!(
            !clear_active_workspace(&mut connection, Some(&stale), stale_clear_intent)
                .expect("stale clear")
        );
        assert_eq!(
            get_active_workspace(&connection)
                .expect("read winner")
                .workspace
                .expect("winner remains")
                .project_id,
            project_b
        );
        let winner_clear_intent = begin(&mut connection);
        assert!(
            clear_active_workspace(&mut connection, Some(&winner), winner_clear_intent)
                .expect("winner clear")
        );
        let empty = get_active_workspace(&connection).expect("empty read");
        assert!(empty.initialized);
        assert!(empty.workspace.is_none());
        let idempotent_clear_intent = begin(&mut connection);
        assert!(
            clear_active_workspace(&mut connection, Some(&winner), idempotent_clear_intent)
                .expect("idempotent clear")
        );
    }

    #[test]
    fn malformed_or_future_records_fail_closed() {
        let connection = fixture();
        connection
            .execute(
                "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('active_workspace', 'current', ?1, 1)",
                [format!(
                    "{{\"schemaVersion\":2,\"cacheId\":\"x\",\"projectId\":\"{}\",\"mediaId\":\"{}\"}}",
                    Uuid::now_v7(),
                    Uuid::now_v7(),
                )],
            )
            .expect("future record");
        assert!(matches!(
            get_active_workspace(&connection),
            Err(DatabaseError::InvalidActiveWorkspace)
        ));
        connection
            .execute(
                "UPDATE app_settings SET value_json = '{\"schemaVersion\":1}'
                 WHERE scope = 'active_workspace' AND key = 'current'",
                [],
            )
            .expect("truncated record");
        assert!(matches!(
            get_active_workspace(&connection),
            Err(DatabaseError::InvalidActiveWorkspace)
        ));
    }

    #[test]
    fn malformed_empty_tombstone_fails_closed() {
        let connection = fixture();
        connection
            .execute(
                "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('active_workspace', 'initialized', 'false', 1)",
                [],
            )
            .expect("malformed tombstone");
        assert!(matches!(
            get_active_workspace(&connection),
            Err(DatabaseError::InvalidActiveWorkspace)
        ));
    }

    #[test]
    fn workspace_state_version_must_round_trip_through_javascript_exactly() {
        let mut connection = fixture();
        let project = ProjectId::new();
        let media = AssetId::new();
        let track = TrackId::new();
        seed_project(&connection, project, media, track, &[5_u8; 32], 1);
        connection
            .execute(
                "UPDATE project_state SET state_version = 9007199254740992
                 WHERE project_id = ?1",
                [project.as_uuid()],
            )
            .expect("unsafe JavaScript state version");
        let pointer =
            ActiveWorkspacePointer::new("unsafe-version", project, media).expect("bounded pointer");
        let intent = begin(&mut connection);
        assert!(matches!(
            set_active_workspace(&mut connection, &pointer, intent),
            Err(DatabaseError::InvalidActiveWorkspace)
        ));
    }

    #[test]
    fn alias_bounds_match_javascript_and_stale_projects_are_pruned_individually() {
        let mut connection = fixture();
        let project = ProjectId::new();
        let media = AssetId::new();
        let track = TrackId::new();
        seed_project(&connection, project, media, track, &[3_u8; 32], 1);
        let boundary_alias = "😀".repeat(4_096);
        let valid = ProjectAliasIndex {
            schema_version: 1,
            active_cache_id: Some(boundary_alias.clone()),
            entries: vec![ProjectAliasEntry {
                cache_id: boundary_alias,
                project_id: project,
                last_opened_at: 9_007_199_254_740_991,
            }],
        };
        set_project_alias_index(&mut connection, &valid).expect("UTF-16 boundary index");

        for invalid in [
            ProjectAliasIndex {
                schema_version: 1,
                active_cache_id: None,
                entries: vec![ProjectAliasEntry {
                    cache_id: format!("{}x", "😀".repeat(4_096)),
                    project_id: project,
                    last_opened_at: 1,
                }],
            },
            ProjectAliasIndex {
                schema_version: 1,
                active_cache_id: None,
                entries: vec![ProjectAliasEntry {
                    cache_id: "line\nbreak".to_owned(),
                    project_id: project,
                    last_opened_at: 1,
                }],
            },
            ProjectAliasIndex {
                schema_version: 1,
                active_cache_id: None,
                entries: vec![ProjectAliasEntry {
                    cache_id: "cache\u{0085}id".to_owned(),
                    project_id: project,
                    last_opened_at: 1,
                }],
            },
            ProjectAliasIndex {
                schema_version: 1,
                active_cache_id: None,
                entries: vec![ProjectAliasEntry {
                    cache_id: "too-new".to_owned(),
                    project_id: project,
                    last_opened_at: 9_007_199_254_740_992,
                }],
            },
        ] {
            assert!(matches!(
                set_project_alias_index(&mut connection, &invalid),
                Err(DatabaseError::InvalidProjectAliasIndex)
            ));
        }

        let stale_project = ProjectId::new();
        let raw = format!(
            "{{\"schemaVersion\":1,\"activeCacheId\":\"stale\",\"entries\":[{{\"cacheId\":\"valid\",\"projectId\":\"{project}\",\"lastOpenedAt\":1}},{{\"cacheId\":\"stale\",\"projectId\":\"{stale_project}\",\"lastOpenedAt\":2}}]}}"
        );
        connection
            .execute(
                "UPDATE app_settings SET value_json = ?1
                 WHERE scope = 'active_workspace'
                   AND key = 'project.subtitleCacheIndex.v1'",
                [raw],
            )
            .expect("stage stale alias");
        let pruned = get_project_alias_index(&mut connection)
            .expect("read pruned index")
            .expect("index exists");
        assert_eq!(pruned.entries.len(), 1);
        assert_eq!(pruned.entries[0].project_id, project);
        assert_eq!(pruned.active_cache_id, None);
    }

    #[test]
    fn atomic_alias_mutations_preserve_inactive_projects_and_refuse_stale_removal() {
        let mut connection = fixture();
        let shared_hash = [4_u8; 32];
        let project_a = ProjectId::new();
        let media_a = AssetId::new();
        let track_a = TrackId::new();
        let project_b = ProjectId::new();
        let media_b = AssetId::new();
        let track_b = TrackId::new();
        seed_project(&connection, project_a, media_a, track_a, &shared_hash, 1);
        seed_project(&connection, project_b, media_b, track_b, &shared_hash, 2);

        activate_project_alias(
            &mut connection,
            &ProjectAliasEntry {
                cache_id: "inactive-a".to_owned(),
                project_id: project_a,
                last_opened_at: 10,
            },
        )
        .expect("activate A");
        let both = activate_project_alias(
            &mut connection,
            &ProjectAliasEntry {
                cache_id: "active-b".to_owned(),
                project_id: project_b,
                last_opened_at: 11,
            },
        )
        .expect("activate B");
        assert_eq!(both.entries.len(), 2);
        assert_eq!(both.active_cache_id.as_deref(), Some("active-b"));

        let stale = remove_project_alias(&mut connection, "active-b", project_a)
            .expect("stale exact-owner removal");
        assert!(!stale.changed);
        assert_eq!(stale.index.entries.len(), 2);
        assert_eq!(stale.index.active_cache_id.as_deref(), Some("active-b"));

        let removed = remove_project_alias(&mut connection, "inactive-a", project_a)
            .expect("remove inactive A");
        assert!(removed.changed);
        assert_eq!(removed.index.entries.len(), 1);
        assert_eq!(removed.index.entries[0].project_id, project_b);
        assert_eq!(removed.index.active_cache_id.as_deref(), Some("active-b"));
    }

    #[test]
    fn activating_alias_keeps_its_slot_when_the_wall_clock_moves_backwards() {
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        let activating_project = ProjectId::new();
        let mut index = ProjectAliasIndex {
            schema_version: 1,
            active_cache_id: Some("new-b".to_owned()),
            entries: vec![
                ProjectAliasEntry {
                    cache_id: "old-a".to_owned(),
                    project_id: project_a,
                    last_opened_at: 100,
                },
                ProjectAliasEntry {
                    cache_id: "new-b".to_owned(),
                    project_id: project_b,
                    last_opened_at: 200,
                },
            ],
        };
        let activating = ProjectAliasEntry {
            cache_id: "clock-rolled-back".to_owned(),
            project_id: activating_project,
            last_opened_at: 1,
        };

        activate_alias_in_index(&mut index, &activating, 2);

        assert_eq!(index.entries.len(), 2);
        assert!(index.entries.contains(&activating));
        assert!(
            index
                .entries
                .iter()
                .any(|entry| entry.project_id == project_b)
        );
        assert_eq!(index.active_cache_id.as_deref(), Some("clock-rolled-back"));
    }
}
