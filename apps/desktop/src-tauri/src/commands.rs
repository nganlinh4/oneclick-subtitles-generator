//! Core desktop commands: health, session snapshot and native media selection. Settings, projects,
//! jobs, credentials and media activation live in the submodules.

mod credentials;
mod jobs;
mod media_activation;
mod projects;
mod settings;

use osg_application::{ImportedMedia, RESIDENT_TERMINAL_JOB_LIMIT, inspect_media};
use osg_domain::{AUDIO_EXTENSIONS, AssetId, VIDEO_EXTENSIONS};
use osg_infrastructure::storage::{ContentHash, Database};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State, WebviewWindow};

pub(crate) use self::credentials::{
    credential_delete, credential_replace, credential_reveal, credential_set, credential_status,
    credential_upsert,
};
pub(crate) use self::jobs::{job_cancel, job_get, job_recovery_abandon_transcribe, jobs_list};
use self::media_activation::{
    begin_media_activation, commit_activated_media, invalidate_pending_media_activation,
    reopen_media_asset_unowned,
};
pub(crate) use self::media_activation::{clear_media, open_media_asset};
pub(crate) use self::projects::{
    project_commit, project_create, project_history_status, project_load, project_load_transcript,
    project_redo, project_track_commit, project_track_history_status, project_track_redo,
    project_track_undo, project_undo,
};
pub(crate) use self::settings::{
    active_workspace_begin, active_workspace_clear, active_workspace_get, active_workspace_set,
    setting_delete, setting_get, setting_set, settings_clear, settings_set_many,
    subtitle_project_alias_activate, subtitle_project_alias_remove, subtitle_project_index_get,
};
use crate::background;
use crate::diagnostics;
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::state::{DesktopSessionSnapshot, DesktopState};

const MAX_MEDIA_FILE_SIZE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_EXPOSED_ACTIVE_JOBS: usize = 256;
const MAX_EXPOSED_TERMINAL_JOBS: usize = RESIDENT_TERMINAL_JOB_LIMIT;

const APP_SETTINGS_SCOPE: &str = "app";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppHealth {
    app_version: String,
    architecture: &'static str,
    platform: &'static str,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle as an owned command extractor"
)]
pub(crate) fn app_health<R: Runtime>(app: AppHandle<R>) -> AppHealth {
    AppHealth {
        app_version: app.package_info().version.to_string(),
        architecture: std::env::consts::ARCH,
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn get_session_snapshot(
    state: State<'_, DesktopState>,
) -> CommandResult<DesktopSessionSnapshot> {
    let editor = state
        .editor
        .read()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    Ok(editor.snapshot())
}

#[tauri::command]
pub(crate) async fn select_media(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    let Some(path) = pick_media_path(window).await? else {
        return Ok(None);
    };
    Ok(Some(import_media_path(&state, path).await?))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaContentIdentityResponse {
    algorithm: &'static str,
    digest: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaCandidateResponse {
    asset: osg_domain::MediaAsset,
    content_identity: MediaContentIdentityResponse,
}

impl MediaCandidateResponse {
    pub(crate) fn new(asset: osg_domain::MediaAsset, content_hash: ContentHash) -> Self {
        let digest =
            content_hash
                .as_bytes()
                .iter()
                .fold(String::with_capacity(64), |mut encoded, byte| {
                    use std::fmt::Write as _;
                    write!(encoded, "{byte:02x}").expect("writing to a string cannot fail");
                    encoded
                });
        let size_bytes = asset.size_bytes();
        Self {
            asset,
            content_identity: MediaContentIdentityResponse {
                algorithm: "blake3-256",
                digest,
                size_bytes,
            },
        }
    }

    #[must_use]
    pub(crate) const fn asset(&self) -> &osg_domain::MediaAsset {
        &self.asset
    }
}

async fn pick_media_path(window: WebviewWindow) -> CommandResult<Option<std::path::PathBuf>> {
    let extensions: Vec<&str> = VIDEO_EXTENSIONS
        .iter()
        .chain(AUDIO_EXTENSIONS.iter())
        .copied()
        .collect();
    diagnostics::record("media-picker.requested", &[]);
    let selected = dialog_paths::pick_file_with_window(
        window,
        "Choose video or audio",
        "Video and audio",
        &extensions,
    )
    .await?;
    diagnostics::record(
        "media-picker.returned",
        &[(
            "outcome",
            media_picker_outcome(selected.as_ref()).to_owned(),
        )],
    );
    let Some(path) = selected else {
        return Ok(None);
    };
    Ok(Some(path))
}

const fn media_picker_outcome<T>(selection: Option<&T>) -> &'static str {
    if selection.is_some() {
        "selected"
    } else {
        "none"
    }
}

pub(crate) async fn import_media_path(
    state: &DesktopState,
    path: std::path::PathBuf,
) -> CommandResult<DesktopSessionSnapshot> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let reopened = tauri::async_runtime::spawn_blocking(move || {
        prepare_compatibility_media(&database, &media_server, &path)
    })
    .await
    .map_err(|_| CommandError::internal("the media import task stopped unexpectedly"))??;
    let (media, playback) = reopened;
    let asset_id = media.asset().id();
    let sequence = begin_media_activation(&state.editor, asset_id, false)?
        .ok_or_else(|| CommandError::internal("the media import intent was not created"))?;
    commit_activated_media(
        &state.editor,
        &state.media_server,
        sequence,
        asset_id,
        media,
        playback,
    )?
    .ok_or_else(|| CommandError::internal("the media import was superseded"))
}

fn prepare_compatibility_media(
    database: &Database,
    media_server: &MediaServer,
    path: &std::path::Path,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let inspected = inspect_media(path)?;
    if inspected.asset().size_bytes() > MAX_MEDIA_FILE_SIZE_BYTES {
        return Err(CommandError::media_too_large());
    }
    let id = inspected.asset().id();
    database.remember_media(inspected.asset(), inspected.canonical_path())?;
    reopen_media_asset_unowned(database, media_server, id)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn discard_media_candidate(
    state: State<'_, DesktopState>,
    id: AssetId,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let discarded = background::run_blocking("discard media candidate", move || {
        database.discard_media_candidate(id)
    })
    .await?;
    if discarded {
        invalidate_pending_media_activation(&state.editor, Some(id))?;
    }
    Ok(discarded)
}

#[cfg(test)]
mod tests;
