use osg_application::{SessionSnapshot, import_subtitle_track, inspect_media};
use osg_domain::{AUDIO_EXTENSIONS, VIDEO_EXTENSIONS};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppHealth {
    app_version: &'static str,
    architecture: &'static str,
    platform: &'static str,
}

#[tauri::command]
pub(crate) const fn app_health() -> AppHealth {
    AppHealth {
        app_version: env!("CARGO_PKG_VERSION"),
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
) -> CommandResult<SessionSnapshot> {
    let session = state
        .session
        .read()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    Ok(session.snapshot())
}

#[tauri::command]
pub(crate) async fn select_media(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<SessionSnapshot>> {
    let extensions: Vec<&str> = VIDEO_EXTENSIONS
        .iter()
        .chain(AUDIO_EXTENSIONS.iter())
        .copied()
        .collect();
    let selected = app
        .dialog()
        .file()
        .set_title("Choose video or audio")
        .add_filter("Video and audio", &extensions)
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| CommandError::invalid_path(error.to_string()))?;
    let media = inspect_media(&path)?;
    let mut session = state
        .session
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    session.set_media(media);
    Ok(Some(session.snapshot()))
}

#[tauri::command]
pub(crate) async fn select_subtitle_file(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<SessionSnapshot>> {
    let selected = app
        .dialog()
        .file()
        .set_title("Import subtitles")
        .add_filter("Subtitle files", &["srt", "json"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| CommandError::invalid_path(error.to_string()))?;
    let track = import_subtitle_track(&path)?;
    let mut session = state
        .session
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    session.set_subtitle_track(track);
    Ok(Some(session.snapshot()))
}
