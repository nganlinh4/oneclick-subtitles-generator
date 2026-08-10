use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use osg_infrastructure::secrets::{
    CredentialBackend, CredentialPurpose, CredentialService, CredentialSetRequest, CredentialState,
    CredentialStoreAvailability,
};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactKind, ArtifactRegistration, ArtifactState,
    ContentHash, Database, DatabaseError, LegacyImportCandidate, LegacyImportItemKey,
    LegacyImportItemKind, LegacyImportItemOutcome, LegacyImportItemState, LegacyImportSourceKind,
    LegacyImportState, LegacyImportSummary, MAX_LEGACY_IMPORT_ITEMS, is_secret_setting_key,
};
use same_file::Handle;
use secrecy::ExposeSecret;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

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

#[derive(Clone, Copy, Debug)]
enum PlanningError {
    Invalid,
    TooLarge,
    Io,
}

impl From<std::io::Error> for PlanningError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

impl From<serde_json::Error> for PlanningError {
    fn from(_: serde_json::Error) -> Self {
        Self::Invalid
    }
}

impl From<PlanningError> for CommandError {
    fn from(error: PlanningError) -> Self {
        match error {
            PlanningError::Invalid | PlanningError::Io => Self::legacy_import_invalid(),
            PlanningError::TooLarge => Self::legacy_import_too_large(),
        }
    }
}

struct LegacyImportPlan {
    source_root: SourceRoot,
    fingerprint: ContentHash,
    items: Vec<PlannedItem>,
}

struct PlannedItem {
    candidate: LegacyImportCandidate,
    work: ImportWork,
}

enum ImportWork {
    Setting {
        key: String,
        value: Value,
    },
    Credential {
        purpose: CredentialPurpose,
        secret_fingerprint: ContentHash,
        request: CredentialSetRequest,
    },
    Artifact(PlannedArtifact),
    Ignored(&'static str),
}

struct PlannedArtifact {
    source_path: PathBuf,
    kind: &'static str,
    extension: String,
    content_hash: ContentHash,
    size_bytes: u64,
}

struct ScannedFile {
    source_path: PathBuf,
    relative_path: String,
    size_bytes: u64,
    import: Option<ScannedArtifact>,
}

struct ScannedArtifact {
    kind: &'static str,
    extension: String,
    content_hash: ContentHash,
}

struct SourceRoot {
    canonical: PathBuf,
    identity: Handle,
}

struct ValidatedSourceFile {
    file: File,
    identity: Handle,
    metadata: fs::Metadata,
}

struct SensitiveBytes(Vec<u8>);

impl Drop for SensitiveBytes {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[tauri::command]
pub(crate) async fn legacy_import_select(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<LegacyImportReport>> {
    let guard = ImportGuard::acquire()?;
    let process_lock = acquire_process_import_lock(&app)?;
    let selected = app
        .dialog()
        .file()
        .set_title("Choose the previous One-Click Subtitles Generator data folder")
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| CommandError::legacy_import_invalid())?;
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
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| CommandError::internal("the legacy migration lock is unavailable"))?;
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

fn plan_legacy_root(selected_root: &Path) -> Result<LegacyImportPlan, PlanningError> {
    let source_root = SourceRoot::open(selected_root)?;

    let (local_storage_fingerprint, local_storage) = read_local_storage(&source_root)?;
    let mut items = plan_storage_items(local_storage)?;
    let remaining_items = MAX_LEGACY_IMPORT_ITEMS
        .checked_sub(items.len())
        .ok_or(PlanningError::TooLarge)?;
    let scanned_files = scan_known_roots(&source_root, remaining_items.min(MAX_SOURCE_FILES))?;
    if local_storage_fingerprint.is_none() && scanned_files.is_empty() {
        return Err(PlanningError::Invalid);
    }

    let mut manifest =
        Vec::with_capacity(scanned_files.len().saturating_mul(64).saturating_add(128));
    append_manifest_field(&mut manifest, b"osg-electron-root-v1")?;
    if let Some(fingerprint) = local_storage_fingerprint {
        append_manifest_field(&mut manifest, b"local-storage-present")?;
        append_manifest_field(&mut manifest, fingerprint.as_bytes())?;
    } else {
        append_manifest_field(&mut manifest, b"local-storage-absent")?;
    }

    let artifact_offset = items.len();
    for (index, scanned) in scanned_files.into_iter().enumerate() {
        append_manifest_field(&mut manifest, scanned.relative_path.as_bytes())?;
        append_manifest_field(&mut manifest, &scanned.size_bytes.to_be_bytes())?;
        let candidate = candidate(
            if scanned.import.is_some() {
                LegacyImportItemKind::Artifact
            } else {
                LegacyImportItemKind::Ignored
            },
            artifact_offset + index,
        )?;
        let work = if let Some(artifact) = scanned.import {
            append_manifest_field(&mut manifest, artifact.content_hash.as_bytes())?;
            ImportWork::Artifact(PlannedArtifact {
                source_path: scanned.source_path,
                kind: artifact.kind,
                extension: artifact.extension,
                content_hash: artifact.content_hash,
                size_bytes: scanned.size_bytes,
            })
        } else {
            append_manifest_field(&mut manifest, b"ignored-extension")?;
            ImportWork::Ignored("unsupportedLegacyFile")
        };
        items.push(PlannedItem { candidate, work });
    }

    Ok(LegacyImportPlan {
        source_root,
        fingerprint: ContentHash::digest(&manifest),
        items,
    })
}

fn read_local_storage(
    source_root: &SourceRoot,
) -> Result<(Option<ContentHash>, BTreeMap<String, Value>), PlanningError> {
    let path = source_root.canonical.join("localStorage.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((None, BTreeMap::new()));
        }
        Err(error) => return Err(error.into()),
    };
    reject_unsafe_metadata(&metadata, false)?;
    if metadata.len() > MAX_LOCAL_STORAGE_BYTES {
        return Err(PlanningError::TooLarge);
    }
    let ValidatedSourceFile {
        mut file,
        identity,
        metadata: opened_metadata,
    } = open_source_file(source_root, &path)?;
    if opened_metadata.len() > MAX_LOCAL_STORAGE_BYTES {
        return Err(PlanningError::TooLarge);
    }
    let mut bytes = SensitiveBytes(Vec::with_capacity(
        usize::try_from(opened_metadata.len()).unwrap_or(0),
    ));
    (&mut file)
        .take(MAX_LOCAL_STORAGE_BYTES + 1)
        .read_to_end(&mut bytes.0)?;
    if u64::try_from(bytes.0.len()).map_or(true, |length| length > MAX_LOCAL_STORAGE_BYTES) {
        return Err(PlanningError::TooLarge);
    }
    if u64::try_from(bytes.0.len()).ok() != Some(opened_metadata.len()) {
        return Err(PlanningError::Invalid);
    }
    let fingerprint = ContentHash::digest(&bytes.0);
    if digest_exact(&mut file, opened_metadata.len())? != fingerprint {
        return Err(PlanningError::Invalid);
    }
    verify_source_path(source_root, &path, &identity, false)?;
    let values = serde_json::from_slice::<BTreeMap<String, Value>>(&bytes.0)?;
    if values.len() > MAX_LOCAL_STORAGE_KEYS {
        return Err(PlanningError::TooLarge);
    }
    Ok((Some(fingerprint), values))
}

#[allow(clippy::too_many_lines)]
fn plan_storage_items(values: BTreeMap<String, Value>) -> Result<Vec<PlannedItem>, PlanningError> {
    let mut items = Vec::new();
    let mut seen_secrets = HashSet::new();
    let mut credential_index = 0_usize;

    let mut add_credential =
        |purpose: CredentialPurpose, secret: String| -> Result<(), PlanningError> {
            let secret = secret.trim().to_owned();
            if secret.is_empty() || secret.len() > 16 * 1024 {
                return Ok(());
            }
            let secret_fingerprint = ContentHash::digest(secret.as_bytes());
            if seen_secrets.contains(&(purpose, secret_fingerprint)) {
                return Ok(());
            }
            if purpose == CredentialPurpose::GeminiApiKey
                && seen_secrets
                    .iter()
                    .filter(|(candidate, _)| *candidate == CredentialPurpose::GeminiApiKey)
                    .count()
                    >= MAX_LEGACY_GEMINI_KEYS
            {
                return Ok(());
            }
            seen_secrets.insert((purpose, secret_fingerprint));
            items.push(PlannedItem {
                candidate: candidate(LegacyImportItemKind::Credential, credential_index)?,
                work: ImportWork::Credential {
                    purpose,
                    secret_fingerprint,
                    request: CredentialSetRequest::new(purpose, secret),
                },
            });
            credential_index += 1;
            Ok(())
        };

    if let Some(value) = string_value(&values, "gemini_api_keys")
        && let Ok(keys) = serde_json::from_str::<Vec<String>>(value)
    {
        for key in keys.into_iter().take(MAX_LEGACY_GEMINI_KEYS) {
            add_credential(CredentialPurpose::GeminiApiKey, key)?;
        }
    }
    for key in ["gemini_api_key", "gemini_token"] {
        if let Some(value) = string_value(&values, key) {
            add_credential(CredentialPurpose::GeminiApiKey, value.to_owned())?;
        }
    }
    if let Some(value) = string_value(&values, "genius_token") {
        add_credential(CredentialPurpose::GeniusAccessToken, value.to_owned())?;
    }
    if let Some(value) = string_value(&values, "youtube_api_key") {
        add_credential(CredentialPurpose::YouTubeApiKey, value.to_owned())?;
    }
    if let (Some(client_id), Some(client_secret)) = (
        string_value(&values, "youtube_client_id"),
        string_value(&values, "youtube_client_secret"),
    ) && !client_id.trim().is_empty()
        && !client_secret.trim().is_empty()
    {
        let pair = serde_json::to_string(&json!({
            "clientId": client_id.trim(),
            "clientSecret": client_secret.trim(),
        }))?;
        add_credential(CredentialPurpose::YouTubeOauthClient, pair)?;
    }
    for (index, (key, value)) in values.into_iter().enumerate() {
        let kind;
        let work;
        if CREDENTIAL_SETTING_KEYS.contains(&key.as_str()) || is_secret_setting_key(&key) {
            kind = LegacyImportItemKind::Ignored;
            work = ImportWork::Ignored(if key == "youtube_oauth_token" {
                "unsupportedOauthToken"
            } else {
                "credentialMovedToVault"
            });
        } else if is_project_scoped_setting_key(&key) || is_transient_setting_key(&key) {
            kind = LegacyImportItemKind::Ignored;
            work = ImportWork::Ignored("transientLegacyValue");
        } else if !is_native_setting_key(&key)
            || !value.is_string()
            || contains_location_bearing_value(&value)
            || serde_json::to_vec(&value)?.len() > MAX_LEGACY_SETTING_JSON_BYTES
        {
            kind = LegacyImportItemKind::Ignored;
            work = ImportWork::Ignored("invalidLegacySetting");
        } else {
            kind = LegacyImportItemKind::Setting;
            work = ImportWork::Setting { key, value };
        }
        items.push(PlannedItem {
            candidate: candidate(kind, credential_index + index)?,
            work,
        });
    }
    Ok(items)
}

fn scan_known_roots(
    source_root: &SourceRoot,
    max_files: usize,
) -> Result<Vec<ScannedFile>, PlanningError> {
    let mut files = Vec::new();
    let mut directory_count = 0_usize;
    let mut total_bytes = 0_u64;
    for relative_root in LEGACY_ROOTS {
        let directory = source_root.canonical.join(relative_root);
        let directory_metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        reject_unsafe_metadata(&directory_metadata, true)?;
        let mut pending = vec![directory];
        while let Some(current) = pending.pop() {
            directory_count = directory_count.saturating_add(1);
            if directory_count > MAX_SOURCE_DIRECTORIES {
                return Err(PlanningError::TooLarge);
            }
            source_root.verify()?;
            let current_metadata = fs::symlink_metadata(&current)?;
            reject_unsafe_metadata(&current_metadata, true)?;
            let current_identity = Handle::from_path(&current)?;
            let canonical = fs::canonicalize(&current)?;
            if !canonical.starts_with(&source_root.canonical) {
                return Err(PlanningError::Invalid);
            }
            let mut entries = Vec::new();
            for entry in fs::read_dir(&current)? {
                entries.push(entry?);
                if entries.len() > MAX_SOURCE_ENTRIES {
                    return Err(PlanningError::TooLarge);
                }
            }
            verify_source_path(source_root, &current, &current_identity, true)?;
            entries.sort_by_key(std::fs::DirEntry::file_name);
            for entry in entries {
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.is_dir() {
                    reject_unsafe_metadata(&metadata, true)?;
                    pending.push(path);
                    continue;
                }
                reject_unsafe_metadata(&metadata, false)?;
                if files.len() >= max_files {
                    return Err(PlanningError::TooLarge);
                }
                let ValidatedSourceFile {
                    file,
                    identity: opened_identity,
                    metadata: opened_metadata,
                } = open_source_file(source_root, &path)?;
                if opened_metadata.len() > MAX_SOURCE_FILE_BYTES {
                    return Err(PlanningError::TooLarge);
                }
                total_bytes = total_bytes
                    .checked_add(opened_metadata.len())
                    .filter(|total| *total <= MAX_SOURCE_TOTAL_BYTES)
                    .ok_or(PlanningError::TooLarge)?;
                let relative_path = safe_relative_path(&source_root.canonical, &path)?;
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                let import = if is_importable_extension(&extension) {
                    let mut file = file;
                    let content_hash = digest_exact(&mut file, opened_metadata.len())?;
                    verify_source_path(source_root, &path, &opened_identity, false)?;
                    Some(ScannedArtifact {
                        kind: artifact_kind(&relative_path),
                        extension,
                        content_hash,
                    })
                } else {
                    None
                };
                files.push(ScannedFile {
                    source_path: path,
                    relative_path,
                    size_bytes: opened_metadata.len(),
                    import,
                });
            }
        }
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn execute_import<B>(
    database: &Database,
    credentials: &CredentialService<B>,
    plan: LegacyImportPlan,
) -> CommandResult<LegacyImportReport>
where
    B: CredentialBackend,
{
    let LegacyImportPlan {
        source_root,
        fingerprint,
        items,
    } = plan;
    let candidates = items
        .iter()
        .map(|item| item.candidate.clone())
        .collect::<Vec<_>>();
    let prepared = database.prepare_legacy_import(
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        &candidates,
    )?;
    if prepared.state() == LegacyImportState::Complete {
        return Ok(LegacyImportReport {
            summary: prepared,
            source_retained: true,
            already_imported: true,
        });
    }

    let ExistingCredentials {
        purposes: mut configured_purposes,
        secrets: mut configured_secrets,
        complete: credential_resolution_complete,
    } = inspect_existing_credentials(credentials);

    let processing_result = (|| -> Result<(), DatabaseError> {
        for PlannedItem { candidate, work } in items {
            if matches!(
                database.legacy_import_item_state(prepared.source_id(), &candidate)?,
                Some(LegacyImportItemState::Imported | LegacyImportItemState::Skipped)
            ) {
                continue;
            }
            let outcome = match work {
                ImportWork::Setting { key, value } => {
                    if database.get_setting(APP_SETTINGS_SCOPE, &key)?.is_some() {
                        LegacyImportItemOutcome::skipped("existingNativeSetting")
                    } else if database
                        .put_setting(APP_SETTINGS_SCOPE, &key, &value)
                        .is_ok()
                    {
                        LegacyImportItemOutcome::imported(None)
                    } else {
                        LegacyImportItemOutcome::failed("settingImportFailed")
                    }
                }
                ImportWork::Credential {
                    purpose,
                    secret_fingerprint,
                    request,
                } => {
                    if !credential_resolution_complete {
                        LegacyImportItemOutcome::failed("credentialStoreUnavailable")
                    } else if configured_secrets.contains(&(purpose, secret_fingerprint))
                        || (!purpose.allows_multiple() && configured_purposes.contains(&purpose))
                    {
                        LegacyImportItemOutcome::skipped("existingNativeCredential")
                    } else {
                        match credentials.set(request) {
                            Ok(status) => {
                                configured_purposes.insert(purpose);
                                configured_secrets.insert((purpose, secret_fingerprint));
                                LegacyImportItemOutcome::imported(Some(status.id.as_uuid()))
                            }
                            Err(_) => LegacyImportItemOutcome::failed("credentialImportFailed"),
                        }
                    }
                }
                ImportWork::Artifact(artifact) => {
                    publish_artifact(database, &source_root, &artifact)?
                }
                ImportWork::Ignored(reason) => LegacyImportItemOutcome::skipped(reason),
            };
            database.record_legacy_import_item(prepared.source_id(), &candidate, &outcome)?;
        }
        Ok(())
    })();
    if let Err(error) = processing_result {
        let _ = database.finish_legacy_import(prepared.source_id());
        return Err(error.into());
    }
    let summary = database.finish_legacy_import(prepared.source_id())?;
    Ok(LegacyImportReport {
        summary,
        source_retained: true,
        already_imported: false,
    })
}

struct ExistingCredentials {
    purposes: HashSet<CredentialPurpose>,
    secrets: HashSet<(CredentialPurpose, ContentHash)>,
    complete: bool,
}

fn inspect_existing_credentials<B>(credentials: &CredentialService<B>) -> ExistingCredentials
where
    B: CredentialBackend,
{
    let mut existing = ExistingCredentials {
        purposes: HashSet::new(),
        secrets: HashSet::new(),
        complete: false,
    };
    let Ok(report) = credentials.status(None) else {
        return existing;
    };
    if report.store != CredentialStoreAvailability::Available {
        return existing;
    }
    existing.complete = true;
    for credential in report.credentials {
        match credential.state {
            CredentialState::Ready => {
                existing.purposes.insert(credential.purpose);
                match credentials.resolve(credential.id, credential.purpose) {
                    Ok(secret) => {
                        existing.secrets.insert((
                            credential.purpose,
                            ContentHash::digest(secret.expose_secret().as_bytes()),
                        ));
                    }
                    Err(_) => existing.complete = false,
                }
            }
            CredentialState::Unavailable => {
                if credentials.delete(credential.id).is_err() {
                    existing.complete = false;
                }
            }
            CredentialState::Pending => existing.complete = false,
        }
    }
    existing
}

fn publish_artifact(
    database: &Database,
    source_root: &SourceRoot,
    artifact: &PlannedArtifact,
) -> Result<LegacyImportItemOutcome, DatabaseError> {
    let Ok(mut source) = open_planned_artifact(source_root, artifact) else {
        return Ok(LegacyImportItemOutcome::failed("legacySourceChanged"));
    };
    let metadata = json!({
        "source": "electronRootV1",
        "extension": artifact.extension,
    });
    let draft = ArtifactDraft::new(
        ArtifactKind::new(artifact.kind)?,
        artifact.content_hash,
        artifact.size_bytes,
        metadata,
    )?;
    let mut retried_failed_record = false;
    let artifact_id = loop {
        match database.register_artifact(&draft)? {
            ArtifactRegistration::Existing(record) => match record.state() {
                ArtifactState::Ready => {
                    if database.resolve_artifact(record.id())?.is_some() {
                        break record.id();
                    }
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactUnavailable"));
                }
                ArtifactState::Pending => {
                    if let Ok(ready) = database.mark_artifact_ready(record.id()) {
                        break ready.id();
                    }
                    fail_artifact_publication(database, record.id());
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactUnavailable"));
                }
                ArtifactState::Failed if !retried_failed_record => {
                    let _ = database.remove_artifact(record.id())?;
                    retried_failed_record = true;
                }
                ArtifactState::Failed => {
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactUnavailable"));
                }
            },
            ArtifactRegistration::Staging(staging) => {
                let artifact_id = staging.record().id();
                let copied = copy_source_to_staging(&mut source, artifact, staging.path())
                    .and_then(|()| {
                        verify_source_path(
                            source_root,
                            &artifact.source_path,
                            &source.identity,
                            false,
                        )
                        .map_err(|_| std::io::Error::other("legacy source changed"))
                    });
                if copied.is_err() || database.mark_artifact_ready(artifact_id).is_err() {
                    fail_artifact_publication(database, artifact_id);
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactChanged"));
                }
                break artifact_id;
            }
        }
    };
    Ok(LegacyImportItemOutcome::imported(Some(
        *artifact_id.as_uuid(),
    )))
}

fn open_planned_artifact(
    source_root: &SourceRoot,
    artifact: &PlannedArtifact,
) -> Result<ValidatedSourceFile, PlanningError> {
    let mut source = open_source_file(source_root, &artifact.source_path)?;
    if source.metadata.len() != artifact.size_bytes {
        return Err(PlanningError::Invalid);
    }
    let content_hash = digest_exact(&mut source.file, artifact.size_bytes)?;
    if content_hash != artifact.content_hash {
        return Err(PlanningError::Invalid);
    }
    source.file.seek(SeekFrom::Start(0))?;
    verify_source_path(source_root, &artifact.source_path, &source.identity, false)?;
    Ok(source)
}

fn fail_artifact_publication(
    database: &Database,
    artifact_id: osg_infrastructure::storage::ArtifactId,
) {
    if let Ok(code) = ArtifactFailureCode::new("legacyImport") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}

fn copy_source_to_staging(
    source: &mut ValidatedSourceFile,
    artifact: &PlannedArtifact,
    destination: &Path,
) -> std::io::Result<()> {
    let metadata = source.file.metadata()?;
    if !metadata.is_file()
        || is_reparse_point(&metadata)
        || metadata.len() != artifact.size_bytes
        || Handle::from_file(source.file.try_clone()?)? != source.identity
    {
        return Err(std::io::Error::other("legacy source changed"));
    }
    source.file.seek(SeekFrom::Start(0))?;
    let mut target = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination)?;
    let copied = std::io::copy(
        &mut (&mut source.file).take(artifact.size_bytes.saturating_add(1)),
        &mut target,
    )?;
    if copied != artifact.size_bytes {
        return Err(std::io::Error::other("legacy source changed"));
    }
    target.flush()?;
    target.sync_all()
}

fn digest_exact(file: &mut File, expected_size: u64) -> Result<ContentHash, PlanningError> {
    file.seek(SeekFrom::Start(0))?;
    let limit = expected_size
        .checked_add(1)
        .ok_or(PlanningError::TooLarge)?;
    let mut bounded = (&mut *file).take(limit);
    let hash = ContentHash::digest_reader(&mut bounded)?;
    let bytes_read = limit.saturating_sub(bounded.limit());
    if bytes_read != expected_size {
        return Err(PlanningError::Invalid);
    }
    Ok(hash)
}

impl SourceRoot {
    fn open(selected: &Path) -> Result<Self, PlanningError> {
        reject_unsafe_entry(selected, true)?;
        let canonical = fs::canonicalize(selected)?;
        reject_unsafe_entry(&canonical, true)?;
        let identity = Handle::from_path(&canonical)?;
        let root = Self {
            canonical,
            identity,
        };
        root.verify()?;
        Ok(root)
    }

    fn verify(&self) -> Result<(), PlanningError> {
        let metadata = fs::symlink_metadata(&self.canonical)?;
        reject_unsafe_metadata(&metadata, true)?;
        if Handle::from_path(&self.canonical)? != self.identity
            || fs::canonicalize(&self.canonical)? != self.canonical
        {
            return Err(PlanningError::Invalid);
        }
        Ok(())
    }
}

fn open_source_file(
    source_root: &SourceRoot,
    path: &Path,
) -> Result<ValidatedSourceFile, PlanningError> {
    source_root.verify()?;
    reject_unsafe_entry(path, false)?;
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(&source_root.canonical) {
        return Err(PlanningError::Invalid);
    }
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    reject_unsafe_metadata(&metadata, false)?;
    let identity = Handle::from_file(file.try_clone()?)?;
    verify_source_path(source_root, path, &identity, false)?;
    Ok(ValidatedSourceFile {
        file,
        identity,
        metadata,
    })
}

fn verify_source_path(
    source_root: &SourceRoot,
    path: &Path,
    expected_identity: &Handle,
    directory: bool,
) -> Result<(), PlanningError> {
    source_root.verify()?;
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, directory)?;
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(&source_root.canonical)
        || Handle::from_path(path)? != *expected_identity
    {
        return Err(PlanningError::Invalid);
    }
    source_root.verify()
}

fn reject_unsafe_metadata(metadata: &fs::Metadata, directory: bool) -> Result<(), PlanningError> {
    if metadata.file_type().is_symlink()
        || is_reparse_point(metadata)
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        Err(PlanningError::Invalid)
    } else {
        Ok(())
    }
}

fn candidate(
    kind: LegacyImportItemKind,
    index: usize,
) -> Result<LegacyImportCandidate, PlanningError> {
    let prefix = match kind {
        LegacyImportItemKind::Setting => "setting",
        LegacyImportItemKind::Credential => "credential",
        LegacyImportItemKind::Artifact => "artifact",
        LegacyImportItemKind::Ignored => "ignored",
    };
    LegacyImportItemKey::new(format!("{prefix}/{index:05}"))
        .map(|key| LegacyImportCandidate::new(key, kind))
        .map_err(|_| PlanningError::Invalid)
}

fn append_manifest_field(manifest: &mut Vec<u8>, value: &[u8]) -> Result<(), PlanningError> {
    let length = u64::try_from(value.len()).map_err(|_| PlanningError::TooLarge)?;
    manifest.extend_from_slice(&length.to_be_bytes());
    manifest.extend_from_slice(value);
    Ok(())
}

fn safe_relative_path(root: &Path, path: &Path) -> Result<String, PlanningError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| PlanningError::Invalid)?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(PlanningError::Invalid);
        };
        let value = value.to_str().ok_or(PlanningError::Invalid)?;
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(PlanningError::Invalid);
        }
        components.push(value);
    }
    let result = components.join("/");
    if result.is_empty() || result.len() > 1_800 {
        Err(PlanningError::Invalid)
    } else {
        Ok(result)
    }
}

fn reject_unsafe_entry(path: &Path, directory: bool) -> Result<(), PlanningError> {
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, directory)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_: &fs::Metadata) -> bool {
    false
}

fn string_value<'a>(values: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    values.get(key).and_then(Value::as_str)
}

fn is_native_setting_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn contains_location_bearing_value(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            if looks_like_location(text) {
                return true;
            }
            let trimmed = text.trim();
            if !matches!(trimmed.as_bytes().first(), Some(b'{' | b'[')) {
                return false;
            }
            serde_json::from_str::<Value>(trimmed)
                .is_ok_and(|nested| contains_location_bearing_value(&nested))
        }
        Value::Array(values) => values.iter().any(contains_location_bearing_value),
        Value::Object(values) => values
            .iter()
            .any(|(key, nested)| is_location_field(key) || contains_location_bearing_value(nested)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn is_location_field(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "thumbnail"
        || ["url", "uri", "path", "directory", "location"]
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

fn looks_like_location(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("://")
        || ["blob:", "data:", "file:", "tauri:", "osg-native:"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        || trimmed.starts_with('/')
        || trimmed.starts_with("\\\\")
        || (trimmed.len() >= 3
            && trimmed.as_bytes()[0].is_ascii_alphabetic()
            && trimmed.as_bytes()[1] == b':'
            && matches!(trimmed.as_bytes()[2], b'/' | b'\\'))
}

pub(crate) fn is_transient_setting_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    TRANSIENT_SETTING_KEYS.contains(&normalized.as_str())
        || normalized.starts_with("current_")
        || normalized.starts_with("gemini_file_")
        || normalized.starts_with("oauth_")
        || normalized.ends_with("_cache")
        || normalized.ends_with("_result")
        || normalized.ends_with("_timestamp")
        || normalized.ends_with("_in_progress")
        || normalized.ends_with("_directory")
        || normalized.ends_with("_location")
        || normalized.ends_with("_path")
        || normalized.ends_with("_uri")
        || normalized.ends_with("_url")
}

pub(crate) fn is_project_scoped_setting_key(key: &str) -> bool {
    PROJECT_SCOPED_SETTING_KEYS.contains(&key)
}

fn is_importable_extension(extension: &str) -> bool {
    matches!(
        extension,
        "3gp"
            | "aac"
            | "aiff"
            | "ass"
            | "avi"
            | "flac"
            | "gif"
            | "jpeg"
            | "jpg"
            | "json"
            | "lrc"
            | "m4a"
            | "m4v"
            | "mkv"
            | "mov"
            | "mp3"
            | "mp4"
            | "ogg"
            | "opus"
            | "png"
            | "srt"
            | "ssa"
            | "txt"
            | "vtt"
            | "wav"
            | "webm"
            | "webp"
            | "wmv"
            | "zip"
    )
}

fn artifact_kind(relative_path: &str) -> &'static str {
    if relative_path.starts_with("subtitles/") {
        "legacySubtitle"
    } else if relative_path.starts_with("narration/reference/") {
        "legacyReferenceAudio"
    } else if relative_path.starts_with("narration/") {
        "legacyNarration"
    } else if relative_path.starts_with("videos/rendered/")
        || relative_path.starts_with("output/")
        || relative_path.starts_with("video-renderer/server/output/")
    {
        "legacyRenderedMedia"
    } else if relative_path.starts_with("videos/lyrics/") {
        "legacyLyrics"
    } else if relative_path.contains("/album_art/")
        || relative_path.starts_with("public/videos/album_art/")
    {
        "legacyAlbumArt"
    } else {
        "legacyMedia"
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use osg_infrastructure::secrets::{
        CredentialId, CredentialPurpose, CredentialService, CredentialState,
        SessionCredentialBackend,
    };
    use tempfile::TempDir;

    use super::*;

    const ALIAS_SECRET_VALUES: [(&str, &str); 9] = [
        ("clientSecret", "legacy-client-secret-never-in-sqlite"),
        ("client.secret", "legacy-dotted-secret-never-in-sqlite"),
        ("client:secret", "legacy-colon-secret-never-in-sqlite"),
        ("accessToken", "legacy-access-token-never-in-sqlite"),
        ("refreshToken", "legacy-refresh-token-never-in-sqlite"),
        ("privateKey", "legacy-private-key-never-in-sqlite"),
        ("apiKey", "legacy-api-key-never-in-sqlite"),
        ("APIKey", "legacy-acronym-api-key-never-in-sqlite"),
        ("oauthToken", "legacy-oauth-token-never-in-sqlite"),
    ];

    fn write_source(root: &Path, secret: &str) {
        fs::create_dir_all(root.join("videos")).expect("create legacy videos");
        fs::write(root.join("videos/source.mp4"), b"legacy-video-bytes")
            .expect("write legacy media");
        let mut settings = BTreeMap::from([
            ("theme".to_owned(), json!("dark")),
            ("gemini_api_key".to_owned(), json!(secret)),
            ("gemini_max_tokens".to_owned(), json!("8192")),
            ("maxTokens".to_owned(), json!("4096")),
            ("tokenCount".to_owned(), json!("1024")),
            (
                "current_file_url".to_owned(),
                json!("http://127.0.0.1/private-capability"),
            ),
            (
                "original_subtitles_map".to_owned(),
                json!(r#"{"1":{"start":0,"end":1,"text":"project-private"}}"#),
            ),
            (
                "youtube_url_history".to_owned(),
                json!(
                    "[{\"id\":\"AbCdEfGhI_1\",\"url\":\"https://www.youtube.com/watch?v=AbCdEfGhI_1\",\"thumbnail\":\"https://img.youtube.com/vi/AbCdEfGhI_1/0.jpg\"}]"
                ),
            ),
            (
                "youtube_oauth_token".to_owned(),
                json!("unsupported-secret-token"),
            ),
        ]);
        for (key, value) in ALIAS_SECRET_VALUES {
            settings.insert(key.to_owned(), json!(value));
        }
        fs::write(
            root.join("localStorage.json"),
            serde_json::to_vec(&settings).expect("serialize settings"),
        )
        .expect("write legacy settings");
    }

    fn assert_alias_secret_settings_rejected(database: &Database) {
        for (key, _) in ALIAS_SECRET_VALUES {
            assert!(matches!(
                database.get_setting(APP_SETTINGS_SCOPE, key),
                Err(DatabaseError::SecretSetting)
            ));
        }
    }

    fn assert_project_settings_rejected(database: &Database) {
        for key in ["current_file_url", "original_subtitles_map"] {
            assert!(
                database
                    .get_setting(APP_SETTINGS_SCOPE, key)
                    .expect("read project/transient setting")
                    .is_none()
            );
        }
    }

    #[test]
    fn migration_is_idempotent_path_free_and_keeps_secrets_out_of_sqlite() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("legacy");
        fs::create_dir_all(&source).expect("create source");
        let secret = "gemini-secret-never-in-sqlite-1234";
        write_source(&source, secret);

        let native = temporary.path().join("native");
        let database = Database::open(native.join("db/osg.sqlite3")).expect("open database");
        let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());
        let first = execute_import(
            &database,
            &credentials,
            plan_legacy_root(&source).expect("plan import"),
        )
        .expect("execute import");
        assert_eq!(first.summary.state, LegacyImportState::Complete);
        assert_eq!(first.summary.artifacts.imported, 1);
        assert!(!first.already_imported);
        assert!(first.source_retained);
        let serialized_report = serde_json::to_string(&first).expect("serialize safe report");
        assert!(!serialized_report.contains(secret));
        assert!(!serialized_report.contains(source.to_string_lossy().as_ref()));
        assert_eq!(
            database
                .get_setting(APP_SETTINGS_SCOPE, "theme")
                .expect("read setting"),
            Some(Value::String("dark".to_owned()))
        );
        for (key, expected) in [
            ("gemini_max_tokens", json!("8192")),
            ("maxTokens", json!("4096")),
            ("tokenCount", json!("1024")),
        ] {
            assert_eq!(
                database
                    .get_setting(APP_SETTINGS_SCOPE, key)
                    .expect("read token-count setting"),
                Some(expected)
            );
        }
        assert_alias_secret_settings_rejected(&database);
        assert_project_settings_rejected(&database);
        assert!(
            database
                .get_setting(APP_SETTINGS_SCOPE, "youtube_url_history")
                .expect("read URL-bearing history")
                .is_none()
        );
        let credential_status = credentials
            .status(Some(CredentialPurpose::GeminiApiKey))
            .expect("credential status");
        assert_eq!(credential_status.credentials.len(), 1);

        let second = execute_import(
            &database,
            &credentials,
            plan_legacy_root(&source).expect("replan import"),
        )
        .expect("repeat import");
        assert!(second.already_imported);
        assert_eq!(
            credentials
                .status(Some(CredentialPurpose::GeminiApiKey))
                .expect("credential status")
                .credentials
                .len(),
            1
        );

        let backup = temporary.path().join("backup.sqlite3");
        database.backup_to(&backup).expect("backup database");
        let backup_bytes = fs::read(&backup).expect("read backup");
        assert!(
            !backup_bytes
                .windows(secret.len())
                .any(|window| window == secret.as_bytes())
        );
        for (_, value) in ALIAS_SECRET_VALUES {
            assert!(
                !backup_bytes
                    .windows(value.len())
                    .any(|window| window == value.as_bytes())
            );
        }
        assert!(source.join("localStorage.json").exists());
        let source_text = source.to_string_lossy();
        assert!(
            !backup_bytes
                .windows(source_text.len())
                .any(|window| window == source_text.as_bytes())
        );
        assert!(
            !backup_bytes
                .windows(b"videos/source.mp4".len())
                .any(|window| window == b"videos/source.mp4")
        );
    }

    #[test]
    fn all_distinct_gemini_keys_import_and_exact_existing_secrets_are_not_duplicated() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("legacy");
        fs::create_dir_all(&source).expect("create source");
        let existing = "existing-gemini-secret-1111";
        let second = "second-gemini-secret-2222";
        let third = "third-gemini-secret-3333";
        fs::write(
            source.join("localStorage.json"),
            serde_json::to_vec(&json!({
                "gemini_api_key": existing,
                "gemini_api_keys": serde_json::to_string(&[existing, second, third])
                    .expect("serialize legacy key list")
            }))
            .expect("serialize settings"),
        )
        .expect("write settings");

        let database =
            Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
        let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());
        credentials
            .set(CredentialSetRequest::new(
                CredentialPurpose::GeminiApiKey,
                existing.to_owned(),
            ))
            .expect("preconfigure exact existing key");

        let report = execute_import(
            &database,
            &credentials,
            plan_legacy_root(&source).expect("plan import"),
        )
        .expect("execute import");

        assert_eq!(report.summary.state, LegacyImportState::Complete);
        assert_eq!(report.summary.credentials.imported, 2);
        assert_eq!(report.summary.credentials.skipped, 1);
        assert_eq!(
            credentials
                .status(Some(CredentialPurpose::GeminiApiKey))
                .expect("credential status")
                .credentials
                .len(),
            3
        );
    }

    #[test]
    fn unavailable_singleton_metadata_is_reconciled_before_import_retry() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("legacy");
        fs::create_dir_all(&source).expect("create source");
        fs::write(
            source.join("localStorage.json"),
            serde_json::to_vec(&json!({
                "youtube_api_key": "youtube-secret-1234"
            }))
            .expect("serialize settings"),
        )
        .expect("write settings");

        let database =
            Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeApiKey)
            .expect("simulate interrupted credential write");
        let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());

        let report = execute_import(
            &database,
            &credentials,
            plan_legacy_root(&source).expect("plan import"),
        )
        .expect("execute import");

        assert_eq!(report.summary.state, LegacyImportState::Complete);
        assert_eq!(report.summary.credentials.imported, 1);
        let statuses = credentials
            .status(Some(CredentialPurpose::YouTubeApiKey))
            .expect("credential status")
            .credentials;
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].state, CredentialState::Ready);
    }

    #[test]
    fn a_source_changed_after_planning_fails_without_accepting_wrong_bytes() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("legacy");
        fs::create_dir_all(&source).expect("create source");
        write_source(&source, "gemini-key-1234");
        let plan = plan_legacy_root(&source).expect("plan import");
        fs::write(source.join("videos/source.mp4"), b"changed-video-byte")
            .expect("replace source with equal-sized content");

        let database =
            Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
        let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());
        let report = execute_import(&database, &credentials, plan).expect("execute import");

        assert_eq!(report.summary.state, LegacyImportState::Failed);
        assert_eq!(report.summary.artifacts.failed, 1);

        let artifact_root = temporary.path().join("native/artifacts");
        assert!(
            fs::read_dir(&artifact_root)
                .expect("read artifact root")
                .all(|entry| !entry
                    .expect("artifact entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".pending-"))
        );

        fs::write(source.join("videos/source.mp4"), b"legacy-video-bytes")
            .expect("restore original source");
        let resumed = execute_import(
            &database,
            &credentials,
            plan_legacy_root(&source).expect("replan restored source"),
        )
        .expect("resume failed import");
        assert_eq!(resumed.summary.state, LegacyImportState::Complete);
        assert_eq!(resumed.summary.artifacts.imported, 1);
    }

    #[test]
    fn handle_identity_detects_a_path_replaced_after_open() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("legacy");
        fs::create_dir_all(source.join("videos")).expect("create source");
        let path = source.join("videos/source.mp4");
        fs::write(&path, b"original").expect("write source");
        let root = SourceRoot::open(&source).expect("open source root");
        let opened = open_source_file(&root, &path).expect("open validated source");
        let displaced = source.join("videos/displaced.mp4");
        fs::rename(&path, &displaced).expect("move opened source");
        fs::write(&path, b"original").expect("replace with equal content");

        assert!(matches!(
            verify_source_path(&root, &path, &opened.identity, false),
            Err(PlanningError::Invalid)
        ));
    }

    #[test]
    fn exact_digest_rejects_growth_beyond_the_advertised_size() {
        let temporary = TempDir::new().expect("temporary directory");
        let path = temporary.path().join("growing.bin");
        fs::write(&path, b"1234").expect("write original file");
        let mut file = File::open(&path).expect("open file");
        let expected_size = file.metadata().expect("metadata").len();
        fs::write(&path, b"12345").expect("grow file");

        assert!(matches!(
            digest_exact(&mut file, expected_size),
            Err(PlanningError::Invalid)
        ));
    }

    #[test]
    fn symlinked_entries_cannot_escape_the_selected_root() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("legacy");
        let outside = temporary.path().join("outside");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&outside).expect("create outside directory");
        fs::write(outside.join("private.mp4"), b"outside").expect("write outside file");

        let link = source.join("videos");
        let link_result = create_directory_symlink(&outside, &link);
        if cfg!(windows)
            && link_result.as_ref().is_err_and(|error| {
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314)
            })
        {
            return;
        }
        link_result.expect("create directory symlink");
        assert!(matches!(
            plan_legacy_root(&source),
            Err(PlanningError::Invalid)
        ));
    }

    #[cfg(unix)]
    fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[test]
    fn concurrent_in_process_imports_are_rejected_until_the_guard_drops() {
        let first = ImportGuard::acquire().expect("acquire first import guard");
        assert!(ImportGuard::acquire().is_err());
        drop(first);
        assert!(ImportGuard::acquire().is_ok());
    }

    #[test]
    fn process_lock_rejects_a_second_import_and_releases_on_drop() {
        let temporary = TempDir::new().expect("temporary directory");
        let path = temporary.path().join("import.lock");
        let first = acquire_import_file_lock(&path).expect("acquire first process lock");
        assert!(acquire_import_file_lock(&path).is_err());
        drop(first);
        assert!(acquire_import_file_lock(&path).is_ok());
    }

    #[test]
    fn invalid_roots_and_oversized_storage_are_rejected_before_database_work() {
        let temporary = TempDir::new().expect("temporary directory");
        let file = temporary.path().join("not-a-directory");
        fs::write(&file, b"nope").expect("write file");
        assert!(matches!(
            plan_legacy_root(&file),
            Err(PlanningError::Invalid)
        ));

        let source = temporary.path().join("oversized");
        fs::create_dir_all(&source).expect("create source");
        let storage = File::create(source.join("localStorage.json")).expect("create storage");
        storage
            .set_len(MAX_LOCAL_STORAGE_BYTES + 1)
            .expect("extend storage");
        assert!(matches!(
            plan_legacy_root(&source),
            Err(PlanningError::TooLarge)
        ));
    }

    #[test]
    fn oversized_and_location_bearing_settings_are_never_persisted() {
        let planned = plan_storage_items(BTreeMap::from([
            (
                "oversized_preference".to_owned(),
                Value::String("x".repeat(MAX_LEGACY_SETTING_JSON_BYTES)),
            ),
            (
                "download_output_path".to_owned(),
                Value::String(r"C:\Users\private\Videos".to_owned()),
            ),
        ]))
        .expect("plan bounded settings");

        assert_eq!(planned.len(), 2);
        assert!(planned.iter().all(|item| {
            item.candidate.kind() == LegacyImportItemKind::Ignored
                && matches!(item.work, ImportWork::Ignored(_))
        }));
        assert!(is_transient_setting_key("download_output_path"));
        assert!(is_transient_setting_key("provider_file_url"));
        assert!(is_transient_setting_key("gemini_active_key_index"));
        assert!(is_transient_setting_key("osg.nativeNarrationAlignment.v1"));
        assert!(is_transient_setting_key("osg.nativeNarrationJob.v1"));
        assert!(is_transient_setting_key("osg.nativeJobIds.v1"));
        assert!(is_project_scoped_setting_key("original_subtitles_map"));
    }

    #[test]
    fn nested_json_urls_paths_and_provider_handles_are_never_planned_as_settings() {
        let planned = plan_storage_items(BTreeMap::from([
            ("theme".to_owned(), Value::String("dark".to_owned())),
            (
                "safe_layout".to_owned(),
                Value::String(r#"{"scale":1,"compact":true}"#.to_owned()),
            ),
            (
                "youtube_url_history".to_owned(),
                Value::String(
                    r#"[{"id":"AbCdEfGhI_1","url":"https://www.youtube.com/watch?v=AbCdEfGhI_1"}]"#
                        .to_owned(),
                ),
            ),
            (
                "customModels".to_owned(),
                Value::String(
                    r#"[{"name":"unsafe","modelUrl":"https://example.invalid/model","vocabPath":"C:\\private\\vocab.txt"}]"#
                        .to_owned(),
                ),
            ),
        ]))
        .expect("plan bounded settings");

        let settings = planned
            .iter()
            .filter_map(|item| match &item.work {
                ImportWork::Setting { key, .. } => Some(key.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(settings, ["safe_layout", "theme"]);
        assert_eq!(
            planned
                .iter()
                .filter(|item| matches!(item.work, ImportWork::Ignored(_)))
                .count(),
            2
        );
    }
}
