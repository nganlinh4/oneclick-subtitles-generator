//! Explicit, user-selected import of legacy browser-era settings, credentials and artifacts.

mod classification;
mod execution;
mod planning;
mod source_files;
mod types;

use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use osg_infrastructure::storage::LegacyImportSummary;
use same_file::Handle;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

pub(crate) use self::classification::{is_project_scoped_setting_key, is_transient_setting_key};
use self::execution::execute_import;
use self::planning::plan_legacy_root;
use self::source_files::reject_unsafe_metadata;
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const APP_SETTINGS_SCOPE: &str = "app";
const MAX_LOCAL_STORAGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LOCAL_STORAGE_KEYS: usize = 4_096;
const MAX_LEGACY_SETTING_JSON_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_FILES: usize = 20_000;
const MAX_SOURCE_DIRECTORIES: usize = 20_000;
const MAX_SOURCE_ENTRIES: usize = MAX_SOURCE_FILES + MAX_SOURCE_DIRECTORIES;
const MAX_SOURCE_FILE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_LEGACY_GEMINI_KEYS: usize = 32;

const LEGACY_ROOTS: &[&str] = &[
    "videos",
    "subtitles",
    "narration",
    "uploads",
    "output",
    "video-renderer/server/uploads",
    "video-renderer/server/output",
    "public/videos/album_art",
];

const CREDENTIAL_SETTING_KEYS: &[&str] = &[
    "gemini_api_key",
    "gemini_api_keys",
    "gemini_token",
    "gemini_blacklisted_keys",
    "genius_token",
    "youtube_api_key",
    "youtube_client_id",
    "youtube_client_secret",
    "youtube_oauth_token",
];

const PROJECT_SCOPED_SETTING_KEYS: &[&str] = &[
    "latest_segment_subtitles",
    "original_subtitles_map",
    "transcription_rules",
    "transcription_rules_video_id",
    "user_provided_subtitles",
];

const TRANSIENT_SETTING_KEYS: &[&str] = &[
    "currentrenderid",
    "currentrenderitem",
    "gemini_active_key_index",
    "last_optimization_timestamp",
    "offline_segments_cache",
    "osg.nativejobids.v1",
    "osg.nativenarrationalignment.v1",
    "osg.nativenarrationjob.v1",
    "originalnarrations",
    "reference_audio_cache",
    "split_result",
    "subtitles_data",
    "toast_history_v1",
    "translatednarrations",
    "uploaded_srt_info",
    "videorenderqueue",
    "video_processing_in_progress",
];

static IMPORT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyImportReport {
    summary: LegacyImportSummary,
    source_retained: bool,
    already_imported: bool,
}

struct ImportGuard;

impl ImportGuard {
    fn acquire() -> CommandResult<Self> {
        IMPORT_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| CommandError::legacy_import_busy())
    }
}

impl Drop for ImportGuard {
    fn drop(&mut self) {
        IMPORT_IN_PROGRESS.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub(crate) async fn legacy_import_select(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<LegacyImportReport>> {
    let guard = ImportGuard::acquire()?;
    let process_lock = acquire_process_import_lock(&app)?;
    let selected = dialog_paths::pick_folder(
        &app,
        "Choose the previous One-Click Subtitles Generator data folder",
    )?;
    let Some(path) = selected else {
        return Ok(None);
    };
    let database = state.database.clone();
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let _process_lock = process_lock;
        let plan = plan_legacy_root(&path).map_err(CommandError::from)?;
        execute_import(&database, &credentials, plan).map(Some)
    })
    .await
    .map_err(|_| CommandError::internal("the legacy migration task stopped unexpectedly"))?
}

fn acquire_process_import_lock(app: &AppHandle) -> CommandResult<File> {
    let local_data = match crate::harness_data_root() {
        Some(root) => root.join("data"),
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|_| CommandError::internal("the legacy migration lock is unavailable"))?,
    };
    fs::create_dir_all(&local_data)
        .map_err(|_| CommandError::internal("the legacy migration lock is unavailable"))?;
    let lock_path = local_data.join(".legacy-import-v1.lock");
    acquire_import_file_lock(&lock_path)
}

fn acquire_import_file_lock(lock_path: &Path) -> CommandResult<File> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| CommandError::internal("the legacy migration lock is unavailable"))?;
    let metadata = fs::symlink_metadata(lock_path)
        .map_err(|_| CommandError::internal("the legacy migration lock is unavailable"))?;
    let lock_clone = lock
        .try_clone()
        .map_err(|_| CommandError::internal("the legacy migration lock is unavailable"))?;
    let same_lock_file = Handle::from_file(lock_clone)
        .and_then(|opened| Handle::from_path(lock_path).map(|path| opened == path));
    if reject_unsafe_metadata(&metadata, false).is_err() || !matches!(same_lock_file, Ok(true)) {
        return Err(CommandError::internal(
            "the legacy migration lock is unavailable",
        ));
    }
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|error| {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            CommandError::legacy_import_busy()
        } else {
            CommandError::internal("the legacy migration lock is unavailable")
        }
    })?;
    Ok(lock)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn legacy_import_status(
    state: State<'_, DesktopState>,
) -> CommandResult<Vec<LegacyImportSummary>> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.list_legacy_imports())
        .await
        .map_err(|_| {
            CommandError::internal("the legacy migration status task stopped unexpectedly")
        })?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests;
