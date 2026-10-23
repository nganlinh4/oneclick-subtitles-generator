//! Settings, active-workspace and subtitle-project alias commands.

use std::collections::BTreeMap;

use osg_domain::{AssetId, ProjectId};
use osg_infrastructure::storage::{
    ActiveWorkspace, ActiveWorkspacePointer, ActiveWorkspaceState, DatabaseError,
    ProjectAliasEntry, ProjectAliasIndex, ProjectAliasMutation,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use super::APP_SETTINGS_SCOPE;
use crate::background;
use crate::error::CommandResult;
use crate::state::DesktopState;
use crate::webview_bootstrap::is_safe_setting_key;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn setting_get(
    state: State<'_, DesktopState>,
    key: String,
) -> CommandResult<Option<Value>> {
    if !is_safe_setting_key(&key) {
        return Err(DatabaseError::InvalidSettingKey.into());
    }
    let database = state.database.clone();
    background::run_blocking("read setting", move || {
        database.get_setting(APP_SETTINGS_SCOPE, &key)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn setting_set(
    state: State<'_, DesktopState>,
    key: String,
    value: Value,
) -> CommandResult<()> {
    if !is_safe_setting_key(&key) {
        return Err(DatabaseError::InvalidSettingKey.into());
    }
    let database = state.database.clone();
    background::run_blocking("write setting", move || {
        database.put_setting(APP_SETTINGS_SCOPE, &key, &value)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn settings_set_many(
    state: State<'_, DesktopState>,
    values: BTreeMap<String, Value>,
) -> CommandResult<()> {
    if values.keys().any(|key| !is_safe_setting_key(key)) {
        return Err(DatabaseError::InvalidSettingKey.into());
    }
    let database = state.database.clone();
    background::run_blocking("write settings", move || {
        database.put_settings(APP_SETTINGS_SCOPE, &values)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn setting_delete(
    state: State<'_, DesktopState>,
    key: String,
) -> CommandResult<bool> {
    let database = state.database.clone();
    background::run_blocking("delete setting", move || {
        database.delete_setting(APP_SETTINGS_SCOPE, &key)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn settings_clear(state: State<'_, DesktopState>) -> CommandResult<u64> {
    let database = state.database.clone();
    background::run_blocking("clear settings", move || {
        database.clear_settings(APP_SETTINGS_SCOPE)
    })
    .await
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_field_names,
    reason = "cache_id, project_id, and media_id are the three distinct product identities"
)]
pub(crate) struct ActiveWorkspaceIdentity {
    cache_id: String,
    pub(super) project_id: ProjectId,
    media_id: AssetId,
}

impl ActiveWorkspaceIdentity {
    fn into_pointer(self) -> Result<ActiveWorkspacePointer, DatabaseError> {
        ActiveWorkspacePointer::new(self.cache_id, self.project_id, self.media_id)
    }
}

/// Reads the exact durable editor workspace. Unlike `settings_clear`, this state is not a user
/// preference and survives a factory reset so the customer's project can reopen without a picker.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn active_workspace_get(
    state: State<'_, DesktopState>,
) -> CommandResult<ActiveWorkspaceState> {
    let database = state.database.clone();
    background::run_blocking("read active workspace", move || {
        database.get_active_workspace()
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn active_workspace_begin(state: State<'_, DesktopState>) -> CommandResult<Uuid> {
    let intent_id = Uuid::now_v7();
    let database = state.database.clone();
    background::run_blocking("begin active workspace change", move || {
        database.begin_active_workspace_intent(intent_id)
    })
    .await?;
    Ok(intent_id)
}

/// Publishes a pointer only when the named project currently owns that exact active media. Content
/// hashes are deliberately absent: two projects may legitimately contain byte-identical files.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri deserializes the bounded workspace identity as an owned request"
)]
pub(crate) async fn active_workspace_set(
    state: State<'_, DesktopState>,
    workspace: ActiveWorkspaceIdentity,
    intent_id: Uuid,
) -> CommandResult<ActiveWorkspace> {
    let pointer = workspace.into_pointer()?;
    let database = state.database.clone();
    background::run_blocking("save active workspace", move || {
        database.set_active_workspace(&pointer, intent_id)
    })
    .await
}

/// Clears only the exact expected workspace. An absent expectation can establish an already-empty
/// tombstone but cannot erase active authority, so a stale teardown never removes a newer winner.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri deserializes the optional bounded identity as an owned request"
)]
pub(crate) async fn active_workspace_clear(
    state: State<'_, DesktopState>,
    expected: Option<ActiveWorkspaceIdentity>,
    intent_id: Uuid,
) -> CommandResult<bool> {
    let expected = expected
        .map(ActiveWorkspaceIdentity::into_pointer)
        .transpose()?;
    let database = state.database.clone();
    background::run_blocking("clear active workspace", move || {
        database.clear_active_workspace(expected.as_ref(), intent_id)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn subtitle_project_index_get(
    state: State<'_, DesktopState>,
) -> CommandResult<Option<ProjectAliasIndex>> {
    let database = state.database.clone();
    background::run_blocking("read subtitle project index", move || {
        database.get_project_alias_index()
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri deserializes the bounded exact project alias as an owned request"
)]
pub(crate) async fn subtitle_project_alias_activate(
    state: State<'_, DesktopState>,
    entry: ProjectAliasEntry,
) -> CommandResult<ProjectAliasIndex> {
    let database = state.database.clone();
    background::run_blocking("activate subtitle project alias", move || {
        database.activate_project_alias(&entry)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri deserializes the exact stale alias owner as an owned request"
)]
pub(crate) async fn subtitle_project_alias_remove(
    state: State<'_, DesktopState>,
    cache_id: String,
    expected_project_id: ProjectId,
) -> CommandResult<ProjectAliasMutation> {
    let database = state.database.clone();
    background::run_blocking("remove subtitle project alias", move || {
        database.remove_project_alias(&cache_id, expected_project_id)
    })
    .await
}
