use std::{collections::BTreeMap, sync::Arc};

use osg_application::{
    ImportedMedia, ProjectHistoryStatus, ProjectSnapshot, ProjectTrackHistoryMutation,
    ProjectTrackHistoryStatus, ProjectTrackSelector, RESIDENT_TERMINAL_JOB_LIMIT, RevisionCommit,
    inspect_media,
};
use osg_domain::{
    AUDIO_EXTENSIONS, AssetId, JobId, JobSnapshot, JobUpdate, ProjectId, ProjectMetadata,
    RevisionReason, SubtitleTrack, VIDEO_EXTENSIONS,
};
use osg_infrastructure::secrets::{
    CredentialId, CredentialPurpose, CredentialServiceError, CredentialSetRequest,
    CredentialStatus, CredentialStatusReport,
};
use osg_infrastructure::storage::{Database, DatabaseError};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{CommandError, CommandResult};
use crate::is_safe_setting_key;
use crate::state::{DesktopSessionSnapshot, DesktopState};

const MAX_MEDIA_FILE_SIZE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_EXPOSED_ACTIVE_JOBS: usize = 256;
const MAX_EXPOSED_TERMINAL_JOBS: usize = RESIDENT_TERMINAL_JOB_LIMIT;

const APP_SETTINGS_SCOPE: &str = "app";

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
pub(crate) async fn setting_get(
    state: State<'_, DesktopState>,
    key: String,
) -> CommandResult<Option<Value>> {
    if !is_safe_setting_key(&key) {
        return Err(DatabaseError::InvalidSettingKey.into());
    }
    let database = state.database.clone();
    run_database_task("read setting", move || {
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
    run_database_task("write setting", move || {
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
    run_database_task("write settings", move || {
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
    run_database_task("delete setting", move || {
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
    run_database_task("clear settings", move || {
        database.clear_settings(APP_SETTINGS_SCOPE)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_create(
    state: State<'_, DesktopState>,
    name: String,
) -> CommandResult<ProjectSnapshot> {
    let metadata = ProjectMetadata::new(name)
        .map_err(|error| CommandError::invalid_input(error.to_string()))?;
    let database = state.database.clone();
    run_database_task("create project", move || database.create_project(&metadata)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_load(
    state: State<'_, DesktopState>,
    id: ProjectId,
) -> CommandResult<Option<ProjectSnapshot>> {
    let database = state.database.clone();
    run_database_task("load project", move || database.load_project(id)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_history_status(
    state: State<'_, DesktopState>,
    id: ProjectId,
) -> CommandResult<ProjectHistoryStatus> {
    let database = state.database.clone();
    run_database_task("inspect project history", move || {
        database.project_history_status(id)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_track_history_status(
    state: State<'_, DesktopState>,
    id: ProjectId,
    selector: ProjectTrackSelector,
) -> CommandResult<ProjectTrackHistoryStatus> {
    let database = state.database.clone();
    run_database_task("inspect editor track history", move || {
        database.project_track_history_status(id, &selector)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and validated DTOs as owned command extractors"
)]
pub(crate) async fn project_track_commit(
    state: State<'_, DesktopState>,
    id: ProjectId,
    selector: ProjectTrackSelector,
    expected_history_version: u64,
    before_track: Option<SubtitleTrack>,
    after_track: Option<SubtitleTrack>,
    reason: RevisionReason,
) -> CommandResult<ProjectTrackHistoryMutation> {
    let database = state.database.clone();
    run_database_task("commit editor track", move || {
        database.commit_project_track(
            id,
            &selector,
            expected_history_version,
            before_track.as_ref(),
            after_track.as_ref(),
            &reason,
        )
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and validated DTOs as owned command extractors"
)]
pub(crate) async fn project_track_undo(
    state: State<'_, DesktopState>,
    id: ProjectId,
    selector: ProjectTrackSelector,
    expected_history_version: u64,
    expected_reason: RevisionReason,
) -> CommandResult<Option<ProjectTrackHistoryMutation>> {
    let database = state.database.clone();
    run_database_task("undo editor track", move || {
        database.undo_project_track(id, &selector, expected_history_version, &expected_reason)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and validated DTOs as owned command extractors"
)]
pub(crate) async fn project_track_redo(
    state: State<'_, DesktopState>,
    id: ProjectId,
    selector: ProjectTrackSelector,
    expected_history_version: u64,
    expected_reason: RevisionReason,
) -> CommandResult<Option<ProjectTrackHistoryMutation>> {
    let database = state.database.clone();
    run_database_task("redo editor track", move || {
        database.redo_project_track(id, &selector, expected_history_version, &expected_reason)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_commit(
    state: State<'_, DesktopState>,
    snapshot: ProjectSnapshot,
    reason: RevisionReason,
) -> CommandResult<RevisionCommit> {
    let database = state.database.clone();
    run_database_task("commit project", move || {
        database.commit_project(&snapshot, &reason)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_undo(
    state: State<'_, DesktopState>,
    id: ProjectId,
    expected_version: u64,
    expected_reason: Option<RevisionReason>,
) -> CommandResult<Option<ProjectSnapshot>> {
    let database = state.database.clone();
    run_database_task("undo project", move || {
        expected_reason.as_ref().map_or_else(
            || database.undo_project(id, expected_version),
            |reason| database.undo_project_guarded(id, expected_version, reason),
        )
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_redo(
    state: State<'_, DesktopState>,
    id: ProjectId,
    expected_version: u64,
    expected_reason: Option<RevisionReason>,
) -> CommandResult<Option<ProjectSnapshot>> {
    let database = state.database.clone();
    run_database_task("redo project", move || {
        expected_reason.as_ref().map_or_else(
            || database.redo_project(id, expected_version),
            |reason| database.redo_project_guarded(id, expected_version, reason),
        )
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn jobs_list(state: State<'_, DesktopState>) -> CommandResult<Vec<JobSnapshot>> {
    let jobs = state
        .jobs
        .list()
        .map_err(CommandError::from)?
        .into_iter()
        .map(|ticket| ticket.snapshot().clone())
        .collect();
    bounded_job_list(jobs)
}

fn bounded_job_list(jobs: Vec<JobSnapshot>) -> CommandResult<Vec<JobSnapshot>> {
    let (mut active, mut terminal): (Vec<_>, Vec<_>) =
        jobs.into_iter().partition(|job| !job.state().is_terminal());
    if active.len() > MAX_EXPOSED_ACTIVE_JOBS {
        return Err(CommandError::internal(
            "the active durable job registry exceeds the recovery limit",
        ));
    }
    terminal.sort_unstable_by_key(JobSnapshot::id);
    terminal.drain(..terminal.len().saturating_sub(MAX_EXPOSED_TERMINAL_JOBS));
    active.append(&mut terminal);
    active.sort_unstable_by_key(JobSnapshot::id);
    Ok(active)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn job_get(state: State<'_, DesktopState>, id: JobId) -> CommandResult<JobSnapshot> {
    state
        .jobs
        .get(id)
        .map(|ticket| ticket.snapshot().clone())
        .map_err(Into::into)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_cancel(
    state: State<'_, DesktopState>,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || jobs.apply(id, JobUpdate::RequestCancellation))
        .await
        .map_err(|_| CommandError::internal("the job cancellation task stopped unexpectedly"))?
        .map(|ticket| ticket.snapshot().clone())
        .map_err(Into::into)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_set(
    state: State<'_, DesktopState>,
    request: CredentialSetRequest,
) -> CommandResult<CredentialStatus> {
    let credentials = state.credentials.clone();
    run_credential_task("store credential", move || credentials.set(request)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_upsert(
    state: State<'_, DesktopState>,
    request: CredentialSetRequest,
) -> CommandResult<CredentialStatus> {
    let credentials = state.credentials.clone();
    run_credential_task("upsert credential", move || credentials.upsert(request)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_delete(
    state: State<'_, DesktopState>,
    id: CredentialId,
) -> CommandResult<bool> {
    let credentials = state.credentials.clone();
    run_credential_task("delete credential", move || credentials.delete(id)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_status(
    state: State<'_, DesktopState>,
    purpose: Option<CredentialPurpose>,
) -> CommandResult<CredentialStatusReport> {
    let credentials = state.credentials.clone();
    run_credential_task("read credential status", move || {
        credentials.status(purpose)
    })
    .await
}

async fn run_database_task<T>(
    operation: &'static str,
    task: impl FnOnce() -> Result<T, DatabaseError> + Send + 'static,
) -> CommandResult<T>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| CommandError::internal(format!("the {operation} task stopped unexpectedly")))?
        .map_err(Into::into)
}

async fn run_credential_task<T>(
    operation: &'static str,
    task: impl FnOnce() -> Result<T, CredentialServiceError> + Send + 'static,
) -> CommandResult<T>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| CommandError::internal(format!("the {operation} task stopped unexpectedly")))?
        .map_err(Into::into)
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
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
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
    Ok(Some(import_media_path(&state, path).await?))
}

pub(crate) async fn import_media_path(
    state: &DesktopState,
    path: std::path::PathBuf,
) -> CommandResult<DesktopSessionSnapshot> {
    let media_server = state.media_server.clone();
    let database = state.database.clone();
    let (media, playback) = tauri::async_runtime::spawn_blocking(move || {
        let media = inspect_media(&path)?;
        if media.asset().size_bytes() > MAX_MEDIA_FILE_SIZE_BYTES {
            return Err(CommandError::media_too_large());
        }
        database.remember_media(media.asset(), media.canonical_path())?;
        let playback = media_server.register(media.canonical_path())?;
        Ok::<_, CommandError>((media, playback))
    })
    .await
    .map_err(|_| CommandError::internal("the media import task stopped unexpectedly"))??;

    let Ok(mut editor) = state.editor.write() else {
        let _ = state.media_server.unregister(playback.id);
        return Err(CommandError::internal("the editing session is unavailable"));
    };
    let previous = editor.playback.replace(playback);
    editor.local_media = Some(crate::state::LocalMedia::new(
        media.asset().id(),
        media.canonical_path().to_owned(),
        media.asset().kind(),
        media.asset().extension(),
    ));
    editor.session.set_media(media);
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous
        && let Err(error) = state.media_server.unregister(previous.id)
    {
        eprintln!("could not release the previous opaque media handle: {error}");
    }
    Ok(snapshot)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn clear_media(state: State<'_, DesktopState>) -> CommandResult<DesktopSessionSnapshot> {
    let mut editor = state
        .editor
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;

    if let Some(playback) = editor.playback.as_ref() {
        state.media_server.unregister(playback.id)?;
    }
    editor.playback = None;
    editor.local_media = None;
    editor.session.clear_media();
    Ok(editor.snapshot())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn open_media_asset(
    state: State<'_, DesktopState>,
    id: AssetId,
) -> CommandResult<DesktopSessionSnapshot> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let (media, playback) = tauri::async_runtime::spawn_blocking(move || {
        reopen_media_asset(&database, &media_server, id)
    })
    .await
    .map_err(|_| CommandError::internal("the media reopen task stopped unexpectedly"))??;

    let Ok(mut editor) = state.editor.write() else {
        let _ = state.media_server.unregister(playback.id);
        return Err(CommandError::internal("the editing session is unavailable"));
    };
    let previous = editor.playback.replace(playback);
    editor.local_media = Some(crate::state::LocalMedia::new(
        media.asset().id(),
        media.canonical_path().to_owned(),
        media.asset().kind(),
        media.asset().extension(),
    ));
    editor.session.set_media(media);
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous {
        let _ = state.media_server.unregister(previous.id);
    }
    Ok(snapshot)
}

fn reopen_media_asset(
    database: &Database,
    media_server: &MediaServer,
    id: AssetId,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let resolved = database
        .resolve_media(id)?
        .ok_or_else(CommandError::media_unavailable)?;
    let media = ImportedMedia::from_native_asset(resolved.asset().clone(), resolved.path())?;
    let playback =
        media_server.register_with_extension(media.canonical_path(), media.asset().extension())?;
    Ok((media, playback))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use osg_domain::{JobKind, JobSnapshot, MediaAsset, MediaKind};
    use osg_infrastructure::storage::Database;
    use osg_media_server::MediaServer;

    use super::{
        MAX_EXPOSED_ACTIVE_JOBS, MAX_EXPOSED_TERMINAL_JOBS, bounded_job_list, reopen_media_asset,
    };

    #[test]
    fn reopens_extensionless_durable_media_from_trusted_asset_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
        let extensionless = directory.path().join("durable-media-object");
        let bytes = vec![0x5a; 32 * 1024];
        fs::write(&extensionless, &bytes).expect("durable media");
        let asset = MediaAsset::new(
            "download.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        database
            .remember_media(&asset, &extensionless)
            .expect("remember media");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");

        let (media, playback) = reopen_media_asset(&database, &media_server, asset.id())
            .expect("reopen extensionless media");

        assert_eq!(media.asset(), &asset);
        assert_eq!(playback.mime_type, "video/mp4");
        assert_eq!(playback.byte_length, asset.size_bytes());
    }

    #[test]
    fn exposed_job_list_keeps_active_work_and_bounds_terminal_history() {
        let active = JobSnapshot::new(JobKind::SynthesizeNarration);
        let mut terminals = Vec::new();
        for _ in 0..(MAX_EXPOSED_TERMINAL_JOBS + 17) {
            let mut terminal = JobSnapshot::new(JobKind::RenderVideo);
            terminal.start().expect("start terminal fixture");
            terminal.succeed().expect("finish terminal fixture");
            terminals.push(terminal);
        }
        let oldest = terminals[0].id();
        let newest = terminals.last().expect("newest terminal job").id();
        terminals.push(active.clone());

        let exposed = bounded_job_list(terminals).expect("bounded job exposure");

        assert_eq!(exposed.len(), MAX_EXPOSED_TERMINAL_JOBS + 1);
        assert!(exposed.iter().any(|job| job.id() == active.id()));
        assert!(exposed.iter().any(|job| job.id() == newest));
        assert!(!exposed.iter().any(|job| job.id() == oldest));
    }

    #[test]
    fn exposed_job_list_fails_closed_instead_of_omitting_active_work() {
        let active = (0..=MAX_EXPOSED_ACTIVE_JOBS)
            .map(|_| JobSnapshot::new(JobKind::SynthesizeNarration))
            .collect();

        assert!(bounded_job_list(active).is_err());
    }
}
