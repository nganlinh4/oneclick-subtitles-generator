use std::{collections::BTreeMap, sync::Arc};

use osg_application::{
    ImportedMedia, ProjectHistoryStatus, ProjectSnapshot, ProjectTrackHistoryMutation,
    ProjectTrackHistoryStatus, ProjectTrackSelector, RESIDENT_TERMINAL_JOB_LIMIT, RevisionCommit,
    inspect_media,
};
use osg_domain::{
    AUDIO_EXTENSIONS, AssetId, JobId, JobKind, JobSnapshot, JobState, JobUpdate, ProjectId,
    ProjectMetadata, RevisionReason, SubtitleTrack, VIDEO_EXTENSIONS,
};
use osg_infrastructure::secrets::{
    CredentialId, CredentialPurpose, CredentialServiceError, CredentialSetRequest,
    CredentialStatus, CredentialStatusReport,
};
use osg_infrastructure::storage::{
    ActiveWorkspace, ActiveWorkspacePointer, ActiveWorkspaceState, ContentHash, Database,
    DatabaseError, ProjectAliasEntry, ProjectAliasIndex, ProjectAliasMutation,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Runtime, State, WebviewWindow};
use uuid::Uuid;

use crate::diagnostics;
use crate::dialog_paths;
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_field_names,
    reason = "cache_id, project_id, and media_id are the three distinct product identities"
)]
pub(crate) struct ActiveWorkspaceIdentity {
    cache_id: String,
    project_id: ProjectId,
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
    run_database_task("read active workspace", move || {
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
    run_database_task("begin active workspace change", move || {
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
    run_database_task("save active workspace", move || {
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
    run_database_task("clear active workspace", move || {
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
    run_database_task("read subtitle project index", move || {
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
    run_database_task("activate subtitle project alias", move || {
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
    run_database_task("remove subtitle project alias", move || {
        database.remove_project_alias(&cache_id, expected_project_id)
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
    idempotency_key: String,
) -> CommandResult<ProjectSnapshot> {
    let metadata = ProjectMetadata::new(name)
        .map_err(|error| CommandError::invalid_input(error.to_string()))?;
    let database = state.database.clone();
    run_database_task("create project", move || {
        database.create_project_idempotent(&metadata, &idempotency_key)
    })
    .await
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTranscriptSnapshot {
    pub(crate) revision_id: osg_domain::TranscriptRevisionId,
    pub(crate) project_id: ProjectId,
    pub(crate) words: Vec<crate::transcription::events::TimedWordDto>,
    pub(crate) turns: Vec<crate::transcription::events::TranscriptTurnDto>,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn project_load_transcript(
    state: State<'_, DesktopState>,
    id: ProjectId,
) -> CommandResult<Option<ProjectTranscriptSnapshot>> {
    let database = state.database.clone();
    run_database_task("load project transcript", move || {
        let revisions = database.transcript_list_revisions(id)?;
        let latest = revisions
            .into_iter()
            .rev()
            .find(|r| r.state == "completed" || r.state == "partial" || r.state == "in_progress");

        let Some(rev) = latest else {
            return Ok(None);
        };

        let words = database.transcript_query_words_in_range(rev.id, 0, i64::MAX)?;
        let turns = database.transcript_query_turns_in_range(rev.id, 0, i64::MAX)?;

        let word_dtos = words
            .into_iter()
            .map(|w| crate::transcription::events::TimedWordDto {
                id: w.id,
                revision_id: w.revision_id,
                ordinal: w.ordinal,
                text: w.text,
                start_ms: w.start_ms,
                end_ms: w.end_ms,
                speaker_id: w.speaker_id,
                confidence: w.confidence,
                provenance: w.provenance,
                alignment_status: w.alignment_status,
            })
            .collect();

        let turn_dtos = turns
            .into_iter()
            .map(|t| crate::transcription::events::TranscriptTurnDto {
                id: t.id,
                revision_id: t.revision_id,
                ordinal: t.ordinal,
                speaker_id: t.speaker_id,
                start_ms: t.start_ms,
                end_ms: t.end_ms,
                text: t.text,
                start_word_ordinal: t.start_word_ordinal,
                end_word_ordinal: t.end_word_ordinal,
            })
            .collect();

        Ok(Some(ProjectTranscriptSnapshot {
            revision_id: rev.id,
            project_id: id,
            words: word_dtos,
            turns: turn_dtos,
        }))
    })
    .await
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

/// Terminates an orphaned transcription after its `WebView` consumer reloads.
///
/// `transcribe` is shared by local ASR and Gemini, so the terminal result delivery kind—not this
/// job kind—decides whether a completed result is discarded or recovered. Active work has no
/// delivery yet and no consumer after reload. Request cancellation using the exact durable
/// sequence, but never forge terminal cancellation before the worker has actually quiesced. A
/// concurrent success wins and is returned for result-kind routing.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn job_recovery_abandon_transcribe(
    state: State<'_, DesktopState>,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || abandon_orphaned_transcribe(&jobs, id))
        .await
        .map_err(|_| {
            CommandError::internal("the transcription recovery task stopped unexpectedly")
        })?
}

fn abandon_orphaned_transcribe(
    jobs: &crate::background::DesktopJobs,
    id: JobId,
) -> CommandResult<JobSnapshot> {
    for _ in 0..4 {
        let current = jobs.get(id).map_err(CommandError::from)?;
        let snapshot = current.snapshot();
        if snapshot.kind() != JobKind::Transcribe {
            return Err(CommandError::invalid_input(
                "Only an orphaned transcription can be abandoned during recovery.",
            ));
        }
        let update = match snapshot.state() {
            JobState::Queued | JobState::Running => JobUpdate::RequestCancellation,
            JobState::Cancelling
            | JobState::Succeeded
            | JobState::Failed
            | JobState::Cancelled
            | JobState::Interrupted => return Ok(snapshot.clone()),
        };
        match jobs.apply_if_sequence(id, snapshot.sequence(), update) {
            Ok(ticket) => return Ok(ticket.snapshot().clone()),
            Err(osg_application::JobRegistryError::Conflict { .. }) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(CommandError::internal(
        "the orphaned transcription changed too often during recovery",
    ))
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
pub(crate) async fn credential_replace(
    state: State<'_, DesktopState>,
    id: CredentialId,
    request: CredentialSetRequest,
) -> CommandResult<CredentialStatus> {
    let credentials = state.credentials.clone();
    run_credential_task("replace credential", move || {
        credentials.replace(id, request)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_reveal(
    state: State<'_, DesktopState>,
    id: CredentialId,
) -> CommandResult<String> {
    let credentials = state.credentials.clone();
    run_credential_task("reveal credential", move || {
        credentials.resolve(id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map(|secret| secret.expose_secret().to_owned())
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
    #[allow(
        dead_code,
        reason = "used by native integration tests before the command manifest is updated"
    )]
    pub(crate) const fn asset(&self) -> &osg_domain::MediaAsset {
        &self.asset
    }
}

#[tauri::command]
#[allow(
    dead_code,
    reason = "staged candidate picker stays unregistered until frontend activation integration"
)]
pub(crate) async fn select_media_candidate(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> CommandResult<Option<MediaCandidateResponse>> {
    let Some(path) = pick_media_path(window).await? else {
        return Ok(None);
    };
    Ok(Some(stage_media_candidate_path(&state, path).await?))
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

#[allow(
    dead_code,
    reason = "shared only by unregistered candidate picker and drop commands"
)]
pub(crate) async fn stage_media_candidate_path(
    state: &DesktopState,
    path: std::path::PathBuf,
) -> CommandResult<MediaCandidateResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || prepare_media_candidate(&database, &path))
        .await
        .map_err(|_| CommandError::internal("the media candidate task stopped unexpectedly"))?
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

fn prepare_media_candidate(
    database: &Database,
    path: &std::path::Path,
) -> CommandResult<MediaCandidateResponse> {
    let media = inspect_media(path)?;
    if media.asset().size_bytes() > MAX_MEDIA_FILE_SIZE_BYTES {
        return Err(CommandError::media_too_large());
    }
    let content_hash = database.remember_media_candidate(media.asset(), media.canonical_path())?;
    Ok(MediaCandidateResponse::new(
        media.asset().clone(),
        content_hash,
    ))
}

#[tauri::command]
#[allow(
    dead_code,
    reason = "registered in the following command-manifest integration step"
)]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn discard_media_candidate(
    state: State<'_, DesktopState>,
    id: AssetId,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let discarded = run_database_task("discard media candidate", move || {
        database.discard_media_candidate(id)
    })
    .await?;
    if discarded {
        invalidate_pending_media_activation(&state.editor, Some(id))?;
    }
    Ok(discarded)
}

#[tauri::command]
#[allow(
    dead_code,
    reason = "registered in the following command-manifest integration step"
)]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn promote_media_candidate(
    state: State<'_, DesktopState>,
    id: AssetId,
) -> CommandResult<bool> {
    let database = state.database.clone();
    run_database_task("promote media candidate", move || {
        database.promote_media_candidate(id)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn clear_media(
    state: State<'_, DesktopState>,
    expected_asset_id: Option<AssetId>,
    expected_playback_id: Option<Uuid>,
) -> CommandResult<DesktopSessionSnapshot> {
    let expected = match (expected_asset_id, expected_playback_id) {
        (None, None) => None,
        (Some(asset_id), Some(playback_id)) => Some((asset_id, playback_id)),
        _ => {
            return Err(CommandError::invalid_input(
                "Both expected media identifiers are required.",
            ));
        }
    };
    clear_activated_media(&state.editor, &state.media_server, expected)
}

fn clear_activated_media(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    expected: Option<(AssetId, Uuid)>,
) -> CommandResult<DesktopSessionSnapshot> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    if let Some((expected_asset_id, expected_playback_id)) = expected {
        let exact_media_is_active = editor.pending_media_activation.is_none()
            && editor
                .local_media
                .as_ref()
                .map(crate::state::LocalMedia::asset_id)
                == Some(expected_asset_id)
            && editor.playback.as_ref().map(|playback| playback.id) == Some(expected_playback_id);
        if !exact_media_is_active {
            return Err(CommandError::media_selection_changed());
        }
    }
    advance_media_intent(&mut editor)?;
    editor.pending_media_activation = None;
    let previous = editor.playback.take();
    editor.local_media = None;
    editor.session.clear_media();
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous {
        media_server.unregister(previous.id)?;
    }
    Ok(snapshot)
}

#[tauri::command]
#[allow(
    dead_code,
    reason = "the explicit activation entry point is retained for the staged command manifest"
)]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn activate_media_asset(
    state: State<'_, DesktopState>,
    id: AssetId,
    project_id: ProjectId,
    expected_state_version: u64,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    activate_media_asset_with_policy(
        state,
        id,
        ProjectMediaAuthorization {
            project_id,
            expected_state_version,
        },
        false,
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProjectMediaAuthorization {
    project_id: ProjectId,
    expected_state_version: u64,
}

async fn activate_media_asset_with_policy(
    state: State<'_, DesktopState>,
    id: AssetId,
    authorization: ProjectMediaAuthorization,
    only_if_empty: bool,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    let Some(sequence) = begin_media_activation(&state.editor, id, only_if_empty)? else {
        return Ok(None);
    };
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let reopened = tauri::async_runtime::spawn_blocking(move || {
        reopen_media_asset(&database, &media_server, authorization, id)
    })
    .await
    .map_err(|_| CommandError::internal("the media reopen task stopped unexpectedly"));
    let (media, playback) = match reopened {
        Ok(Ok(reopened)) => reopened,
        Ok(Err(error)) | Err(error) => {
            cancel_media_activation(&state.editor, sequence, id)?;
            return Err(error);
        }
    };

    commit_authorized_activated_media(
        &state.editor,
        &state.media_server,
        (&state.database, authorization),
        sequence,
        id,
        media,
        playback,
    )
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "temporary compatibility alias until the shared Tauri registration is updated"
)]
pub(crate) async fn open_media_asset(
    state: State<'_, DesktopState>,
    id: AssetId,
    project_id: ProjectId,
    expected_state_version: u64,
    only_if_empty: bool,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    activate_media_asset_with_policy(
        state,
        id,
        ProjectMediaAuthorization {
            project_id,
            expected_state_version,
        },
        only_if_empty,
    )
    .await
}

fn advance_media_intent(editor: &mut crate::state::EditorSession) -> CommandResult<u64> {
    editor.media_intent = editor
        .media_intent
        .checked_add(1)
        .ok_or_else(|| CommandError::internal("the media activation sequence is exhausted"))?;
    Ok(editor.media_intent)
}

fn begin_media_activation(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    asset_id: AssetId,
    only_if_empty: bool,
) -> CommandResult<Option<u64>> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    if only_if_empty
        && (editor.session.media_path().is_some()
            || editor.playback.is_some()
            || editor.local_media.is_some()
            || editor.pending_media_activation.is_some())
    {
        return Ok(None);
    }
    let sequence = advance_media_intent(&mut editor)?;
    editor.pending_media_activation =
        Some(crate::state::PendingMediaActivation { sequence, asset_id });
    Ok(Some(sequence))
}

fn cancel_media_activation(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    sequence: u64,
    asset_id: AssetId,
) -> CommandResult<()> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    let expected = crate::state::PendingMediaActivation { sequence, asset_id };
    if editor.media_intent == sequence && editor.pending_media_activation == Some(expected) {
        editor.pending_media_activation = None;
    }
    Ok(())
}

fn invalidate_pending_media_activation(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    asset_id: Option<AssetId>,
) -> CommandResult<()> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    if editor
        .pending_media_activation
        .is_some_and(|pending| asset_id.is_none_or(|id| pending.asset_id == id))
    {
        advance_media_intent(&mut editor)?;
        editor.pending_media_activation = None;
    }
    Ok(())
}

fn commit_activated_media(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    sequence: u64,
    asset_id: AssetId,
    media: ImportedMedia,
    playback: RegisteredMedia,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    commit_activated_media_with_authorization(
        editor_state,
        media_server,
        None,
        sequence,
        asset_id,
        media,
        playback,
    )
}

fn commit_authorized_activated_media(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    // The database and the revision it authorizes are only meaningful together.
    authorization: (&Database, ProjectMediaAuthorization),
    sequence: u64,
    asset_id: AssetId,
    media: ImportedMedia,
    playback: RegisteredMedia,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    commit_activated_media_with_authorization(
        editor_state,
        media_server,
        Some(authorization),
        sequence,
        asset_id,
        media,
        playback,
    )
}

fn commit_activated_media_with_authorization(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    authorization: Option<(&Database, ProjectMediaAuthorization)>,
    sequence: u64,
    asset_id: AssetId,
    media: ImportedMedia,
    playback: RegisteredMedia,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    if media.asset().id() != asset_id {
        let _ = media_server.unregister(playback.id);
        return Err(CommandError::internal(
            "the verified media identity did not match the activation intent",
        ));
    }
    let Ok(mut editor) = editor_state.write() else {
        let _ = media_server.unregister(playback.id);
        return Err(CommandError::internal("the editing session is unavailable"));
    };
    let expected = crate::state::PendingMediaActivation { sequence, asset_id };
    if editor.media_intent != sequence || editor.pending_media_activation != Some(expected) {
        drop(editor);
        let _ = media_server.unregister(playback.id);
        return Ok(None);
    }
    if let Some((database, authorization)) = authorization {
        let authorized = database.project_media_is_current(
            authorization.project_id,
            authorization.expected_state_version,
            asset_id,
        );
        match authorized {
            Ok(true) => {}
            Ok(false) => {
                editor.pending_media_activation = None;
                drop(editor);
                let _ = media_server.unregister(playback.id);
                return Err(CommandError::media_unavailable());
            }
            Err(error) => {
                editor.pending_media_activation = None;
                drop(editor);
                let _ = media_server.unregister(playback.id);
                return Err(error.into());
            }
        }
    }
    let previous = editor.playback.replace(playback);
    editor.local_media = Some(crate::state::LocalMedia::new(
        media.asset().id(),
        media.canonical_path().to_owned(),
        media.asset().kind(),
        media.asset().extension(),
    ));
    editor.session.set_media(media);
    editor.pending_media_activation = None;
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous {
        let _ = media_server.unregister(previous.id);
    }
    Ok(Some(snapshot))
}

fn reopen_media_asset(
    database: &Database,
    media_server: &MediaServer,
    authorization: ProjectMediaAuthorization,
    id: AssetId,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let resolved = database
        .resolve_project_media_revision(
            authorization.project_id,
            authorization.expected_state_version,
            id,
        )?
        .ok_or_else(CommandError::media_unavailable)?;
    register_resolved_media(media_server, &resolved)
}

fn reopen_media_asset_unowned(
    database: &Database,
    media_server: &MediaServer,
    id: AssetId,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let resolved = database
        .resolve_media(id)?
        .ok_or_else(CommandError::media_unavailable)?;
    register_resolved_media(media_server, &resolved)
}

fn register_resolved_media(
    media_server: &MediaServer,
    resolved: &osg_infrastructure::storage::ResolvedMedia,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let media = ImportedMedia::from_verified_native_asset(
        resolved.asset().clone(),
        resolved.path().to_owned(),
    )?;
    let playback = media_server.register_content_snapshot_with_extension(
        resolved.verified_file().as_ref(),
        media.asset().extension(),
        media.asset().size_bytes(),
        *resolved.content_hash().as_bytes(),
    )?;
    if let Err(error) = resolved.revalidate_verified_file() {
        let _ = media_server.unregister(playback.id);
        return Err(error.into());
    }
    Ok((media, playback))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, RwLock},
    };

    use osg_application::{JobRegistry, ProjectSnapshot, inspect_media};
    use osg_domain::{
        AssetId, JobKind, JobSnapshot, JobUpdate, MediaAsset, MediaKind, ProjectMetadata,
        RevisionReason,
    };
    use osg_infrastructure::storage::Database;
    use osg_media_server::MediaServer;

    use super::{
        MAX_EXPOSED_ACTIVE_JOBS, MAX_EXPOSED_TERMINAL_JOBS, ProjectMediaAuthorization,
        abandon_orphaned_transcribe, begin_media_activation, bounded_job_list,
        clear_activated_media, commit_activated_media, commit_authorized_activated_media,
        invalidate_pending_media_activation, media_picker_outcome, prepare_media_candidate,
        reopen_media_asset,
    };
    use crate::state::EditorSession;

    #[test]
    fn media_picker_diagnostic_outcome_is_categorical_and_path_free() {
        assert_eq!(media_picker_outcome(Some(&"private-path")), "selected");
        assert_eq!(media_picker_outcome::<&str>(None), "none");
    }

    #[test]
    fn orphaned_transcription_recovery_terminalizes_queued_and_running_work_only() {
        let directory = tempfile::tempdir().expect("temporary jobs directory");
        let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
        let jobs = Arc::new(JobRegistry::restore(Arc::new(database)).expect("job registry"));

        let queued = jobs
            .register(JobKind::Transcribe)
            .expect("queued transcription");
        let queued_id = queued.snapshot().id();
        let cancelled =
            abandon_orphaned_transcribe(&jobs, queued_id).expect("abandon queued transcription");
        assert_eq!(cancelled.state(), osg_domain::JobState::Cancelled);

        let running = jobs
            .register(JobKind::Transcribe)
            .expect("running transcription");
        let running_id = running.snapshot().id();
        let running = jobs
            .apply(running_id, JobUpdate::Start)
            .expect("start transcription");
        let cancellation = running.cancellation().clone();
        let cancelling =
            abandon_orphaned_transcribe(&jobs, running_id).expect("abandon running transcription");
        assert_eq!(cancelling.state(), osg_domain::JobState::Cancelling);
        assert!(cancellation.is_cancelled());
        let cancelled = jobs
            .apply(running_id, JobUpdate::ConfirmCancelled)
            .expect("worker confirms cancellation");
        assert_eq!(
            cancelled.snapshot().state(),
            osg_domain::JobState::Cancelled
        );

        let foreign = jobs.register(JobKind::RenderVideo).expect("foreign job");
        assert!(abandon_orphaned_transcribe(&jobs, foreign.snapshot().id()).is_err());
    }

    fn attach_media_to_project(
        database: &Database,
        asset: &MediaAsset,
    ) -> ProjectMediaAuthorization {
        let metadata = ProjectMetadata::new("Media activation fixture").expect("project metadata");
        let base = database.create_project(&metadata).expect("create project");
        let snapshot = ProjectSnapshot::new(
            metadata,
            base.state_version(),
            vec![asset.clone()],
            Vec::new(),
        )
        .expect("project snapshot");
        let commit = database
            .commit_project(
                &snapshot,
                &RevisionReason::new("attach media fixture").expect("revision reason"),
            )
            .expect("attach media");
        ProjectMediaAuthorization {
            project_id: snapshot.metadata().id(),
            expected_state_version: commit.state_version,
        }
    }

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
        let authorization = attach_media_to_project(&database, &asset);
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");

        let (media, playback) =
            reopen_media_asset(&database, &media_server, authorization, asset.id())
                .expect("reopen extensionless media");

        assert_eq!(media.asset(), &asset);
        assert_eq!(playback.mime_type, "video/mp4");
        assert_eq!(playback.byte_length, asset.size_bytes());
    }

    #[test]
    fn activation_is_project_revision_scoped_and_rechecked_after_handle_verification() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
        let media_path = directory.path().join("authorized.mp4");
        fs::write(&media_path, vec![0x45; 32 * 1024]).expect("media fixture");
        let imported = inspect_media(&media_path).expect("inspect media");
        let asset = imported.asset().clone();
        database
            .remember_media_candidate(&asset, imported.canonical_path())
            .expect("stage media");

        let owner = ProjectMetadata::new("Owner project").expect("owner metadata");
        let base = database.create_project(&owner).expect("create owner");
        let attach = ProjectSnapshot::new(
            owner.clone(),
            base.state_version(),
            vec![asset.clone()],
            Vec::new(),
        )
        .expect("attach snapshot");
        let attached = database
            .commit_project(
                &attach,
                &RevisionReason::new("attach media").expect("revision reason"),
            )
            .expect("attach media");
        let authorization = ProjectMediaAuthorization {
            project_id: owner.id(),
            expected_state_version: attached.state_version,
        };
        let other = ProjectMetadata::new("Other project").expect("other metadata");
        let other_base = database.create_project(&other).expect("create other");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");

        let cross_project = reopen_media_asset(
            &database,
            &media_server,
            ProjectMediaAuthorization {
                project_id: other.id(),
                expected_state_version: other_base.state_version(),
            },
            asset.id(),
        )
        .expect_err("another project cannot authorize this media");
        assert_eq!(cross_project.code(), "mediaUnavailable");

        let (media, playback) =
            reopen_media_asset(&database, &media_server, authorization, asset.id())
                .expect("hash and register authorized media");
        let playback_id = playback.id;
        let editor = RwLock::new(EditorSession::default());
        let sequence = begin_media_activation(&editor, asset.id(), false)
            .expect("begin activation")
            .expect("activation intent");

        let detach = ProjectSnapshot::new(owner, attached.state_version, Vec::new(), Vec::new())
            .expect("detach snapshot");
        database
            .commit_project(
                &detach,
                &RevisionReason::new("detach before activation commit").expect("revision reason"),
            )
            .expect("detach media");

        let error = commit_authorized_activated_media(
            &editor,
            &media_server,
            (&database, authorization),
            sequence,
            asset.id(),
            media,
            playback,
        )
        .expect_err("stale revision authorization must fail at final commit");
        assert_eq!(error.code(), "mediaUnavailable");
        assert!(
            editor
                .read()
                .expect("editor")
                .snapshot()
                .session
                .media
                .is_none()
        );
        assert!(
            !media_server
                .unregister(playback_id)
                .expect("stale playback was removed")
        );
    }

    #[test]
    fn explicit_activation_replaces_the_previous_native_media() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first_path = directory.path().join("persisted.mp4");
        let winner_path = directory.path().join("winner.mp4");
        fs::write(&first_path, vec![0x41; 1024]).expect("persisted fixture");
        fs::write(&winner_path, vec![0x42; 2048]).expect("winner fixture");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let editor = RwLock::new(EditorSession::default());

        let persisted = inspect_media(&first_path).expect("persisted media");
        let persisted_id = persisted.asset().id();
        let persisted_playback = media_server
            .register(persisted.canonical_path())
            .expect("persisted playback");
        let persisted_playback_id = persisted_playback.id;
        let persisted_sequence = begin_media_activation(&editor, persisted_id, false)
            .expect("begin initial activation")
            .expect("initial activation intent");
        let restored = commit_activated_media(
            &editor,
            &media_server,
            persisted_sequence,
            persisted_id,
            persisted,
            persisted_playback,
        )
        .expect("initial activation")
        .expect("initial activation won");
        assert_eq!(
            restored.session.media.as_ref().map(MediaAsset::id),
            Some(persisted_id)
        );
        assert!(restored.playback.is_some());

        let winner = inspect_media(&winner_path).expect("winner media");
        let winner_id = winner.asset().id();
        let winner_playback = media_server
            .register(winner.canonical_path())
            .expect("winner playback");
        let winner_sequence = begin_media_activation(&editor, winner_id, false)
            .expect("begin winner activation")
            .expect("winner activation intent");
        let selected = commit_activated_media(
            &editor,
            &media_server,
            winner_sequence,
            winner_id,
            winner,
            winner_playback,
        )
        .expect("replacement activation")
        .expect("replacement activation won");
        assert_eq!(
            selected.session.media.as_ref().map(MediaAsset::id),
            Some(winner_id)
        );

        let final_snapshot = editor.read().expect("editor read").snapshot();
        assert_eq!(
            final_snapshot.session.media.as_ref().map(MediaAsset::id),
            Some(winner_id)
        );
        assert!(
            !media_server
                .unregister(persisted_playback_id)
                .expect("inspect previous playback cleanup")
        );
    }

    #[test]
    fn delayed_restore_cannot_overwrite_a_newer_explicit_activation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let restore_path = directory.path().join("restore.mp4");
        let winner_path = directory.path().join("winner.mp4");
        fs::write(&restore_path, vec![0x31; 1024]).expect("restore fixture");
        fs::write(&winner_path, vec![0x32; 2048]).expect("winner fixture");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let editor = RwLock::new(EditorSession::default());

        let restore = inspect_media(&restore_path).expect("restore media");
        let restore_id = restore.asset().id();
        let restore_playback = media_server
            .register(restore.canonical_path())
            .expect("restore playback");
        let restore_playback_id = restore_playback.id;
        let restore_sequence = begin_media_activation(&editor, restore_id, true)
            .expect("begin restore")
            .expect("restore intent");

        let winner = inspect_media(&winner_path).expect("winner media");
        let winner_id = winner.asset().id();
        let winner_playback = media_server
            .register(winner.canonical_path())
            .expect("winner playback");
        let winner_sequence = begin_media_activation(&editor, winner_id, false)
            .expect("begin winner")
            .expect("winner intent");
        let winner_snapshot = commit_activated_media(
            &editor,
            &media_server,
            winner_sequence,
            winner_id,
            winner,
            winner_playback,
        )
        .expect("commit winner")
        .expect("winner remains current");
        assert_eq!(
            winner_snapshot.session.media.as_ref().map(MediaAsset::id),
            Some(winner_id)
        );

        assert!(
            commit_activated_media(
                &editor,
                &media_server,
                restore_sequence,
                restore_id,
                restore,
                restore_playback,
            )
            .expect("finish delayed restore")
            .is_none()
        );
        assert_eq!(
            editor
                .read()
                .expect("editor read")
                .snapshot()
                .session
                .media
                .as_ref()
                .map(MediaAsset::id),
            Some(winner_id)
        );
        assert!(
            !media_server
                .unregister(restore_playback_id)
                .expect("stale capability already removed")
        );
        assert!(
            begin_media_activation(&editor, restore_id, true)
                .expect("attempt occupied restore")
                .is_none()
        );
    }

    #[test]
    fn conditional_clear_refuses_stale_or_in_flight_media_and_releases_only_the_exact_active_pair()
    {
        let directory = tempfile::tempdir().expect("temporary directory");
        let active_path = directory.path().join("active.mp4");
        fs::write(&active_path, vec![0x51; 1024]).expect("active fixture");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let editor = RwLock::new(EditorSession::default());

        let active = inspect_media(&active_path).expect("active media");
        let active_id = active.asset().id();
        let active_playback = media_server
            .register(active.canonical_path())
            .expect("active playback");
        let active_playback_id = active_playback.id;
        let active_sequence = begin_media_activation(&editor, active_id, false)
            .expect("begin active")
            .expect("active intent");
        commit_activated_media(
            &editor,
            &media_server,
            active_sequence,
            active_id,
            active,
            active_playback,
        )
        .expect("commit active")
        .expect("active wins");

        let stale = clear_activated_media(
            &editor,
            &media_server,
            Some((AssetId::new(), active_playback_id)),
        )
        .expect_err("stale asset must not clear active media");
        assert_eq!(stale.code(), "mediaSelectionChanged");

        let pending_id = AssetId::new();
        begin_media_activation(&editor, pending_id, false)
            .expect("begin replacement")
            .expect("replacement intent");
        let pending = clear_activated_media(
            &editor,
            &media_server,
            Some((active_id, active_playback_id)),
        )
        .expect_err("a newer in-flight selection must win");
        assert_eq!(pending.code(), "mediaSelectionChanged");
        assert_eq!(
            editor
                .read()
                .expect("editor read")
                .snapshot()
                .session
                .media
                .as_ref()
                .map(MediaAsset::id),
            Some(active_id),
        );

        invalidate_pending_media_activation(&editor, Some(pending_id)).expect("cancel replacement");
        let cleared = clear_activated_media(
            &editor,
            &media_server,
            Some((active_id, active_playback_id)),
        )
        .expect("clear exact media");
        assert!(cleared.session.media.is_none());
        assert!(cleared.playback.is_none());
        assert!(
            !media_server
                .unregister(active_playback_id)
                .expect("exact clear already withdrew capability")
        );
    }

    #[test]
    fn clear_advances_the_intent_and_invalidates_in_flight_activation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let active_path = directory.path().join("active.mp4");
        let pending_path = directory.path().join("pending.mp4");
        fs::write(&active_path, vec![0x51; 1024]).expect("active fixture");
        fs::write(&pending_path, vec![0x52; 2048]).expect("pending fixture");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let editor = RwLock::new(EditorSession::default());

        let active = inspect_media(&active_path).expect("active media");
        let active_id = active.asset().id();
        let active_playback = media_server
            .register(active.canonical_path())
            .expect("active playback");
        let active_playback_id = active_playback.id;
        let active_sequence = begin_media_activation(&editor, active_id, false)
            .expect("begin active")
            .expect("active intent");
        commit_activated_media(
            &editor,
            &media_server,
            active_sequence,
            active_id,
            active,
            active_playback,
        )
        .expect("commit active")
        .expect("active wins");

        let pending = inspect_media(&pending_path).expect("pending media");
        let pending_id = pending.asset().id();
        let pending_playback = media_server
            .register(pending.canonical_path())
            .expect("pending playback");
        let pending_playback_id = pending_playback.id;
        let pending_sequence = begin_media_activation(&editor, pending_id, false)
            .expect("begin pending")
            .expect("pending intent");

        let cleared = clear_activated_media(&editor, &media_server, None).expect("clear media");
        assert!(cleared.session.media.is_none());
        assert!(cleared.playback.is_none());
        assert!(
            !media_server
                .unregister(active_playback_id)
                .expect("active capability already removed")
        );
        assert!(
            commit_activated_media(
                &editor,
                &media_server,
                pending_sequence,
                pending_id,
                pending,
                pending_playback,
            )
            .expect("finish invalidated activation")
            .is_none()
        );
        assert!(
            !media_server
                .unregister(pending_playback_id)
                .expect("invalidated capability already removed")
        );
        let editor = editor.read().expect("editor read");
        assert!(editor.pending_media_activation.is_none());
        assert!(editor.snapshot().session.media.is_none());
    }

    #[test]
    fn discarding_one_candidate_does_not_cancel_another_assets_intent() {
        let editor = RwLock::new(EditorSession::default());
        let discarded = AssetId::new();
        let winner = AssetId::new();
        let sequence = begin_media_activation(&editor, winner, false)
            .expect("begin winner")
            .expect("winner intent");

        invalidate_pending_media_activation(&editor, Some(discarded))
            .expect("discard unrelated candidate");
        {
            let editor = editor.read().expect("editor read");
            assert_eq!(editor.media_intent, sequence);
            assert_eq!(
                editor
                    .pending_media_activation
                    .map(|pending| pending.asset_id),
                Some(winner)
            );
        }

        invalidate_pending_media_activation(&editor, Some(winner)).expect("discard winner");
        let editor = editor.read().expect("editor read");
        assert!(editor.media_intent > sequence);
        assert!(editor.pending_media_activation.is_none());
    }

    #[test]
    fn candidate_staging_is_path_free_and_leaves_the_editor_untouched() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
        let media_path = directory.path().join("private-recording.mp4");
        fs::write(&media_path, vec![0x2a; 32 * 1024]).expect("media fixture");
        let editor = EditorSession::default();
        let before = editor.snapshot();

        let candidate =
            prepare_media_candidate(&database, &media_path).expect("prepare media candidate");

        assert_eq!(editor.snapshot(), before);
        assert!(
            database
                .resolve_media(candidate.asset().id())
                .expect("resolve staged media")
                .is_some()
        );
        let value = serde_json::to_value(&candidate).expect("serialize candidate");
        let object = value.as_object().expect("candidate object");
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["asset", "contentIdentity"]
        );
        assert_eq!(value["contentIdentity"]["algorithm"], "blake3-256");
        assert_eq!(
            value["contentIdentity"]["digest"]
                .as_str()
                .expect("digest")
                .len(),
            64
        );
        assert_eq!(value["contentIdentity"]["sizeBytes"], 32 * 1024);
        let json = serde_json::to_string(&value).expect("candidate JSON");
        assert!(!json.contains(media_path.to_string_lossy().as_ref()));
        assert!(!json.to_ascii_lowercase().contains("path"));
        assert!(object.get("playback").is_none());
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");
        let metadata = ProjectMetadata::new("Detached candidate").expect("project metadata");
        let project = database.create_project(&metadata).expect("create project");
        let authorization = ProjectMediaAuthorization {
            project_id: metadata.id(),
            expected_state_version: project.state_version(),
        };
        let error = reopen_media_asset(
            &database,
            &media_server,
            authorization,
            candidate.asset().id(),
        )
        .expect_err("detached candidates must not activate");
        assert_eq!(error.code(), "mediaUnavailable");
    }

    #[test]
    fn missing_durable_media_identity_fails_closed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
        let media_server = MediaServer::start(std::iter::empty()).expect("media server");

        let metadata = ProjectMetadata::new("Missing media").expect("project metadata");
        let project = database.create_project(&metadata).expect("create project");
        let error = reopen_media_asset(
            &database,
            &media_server,
            ProjectMediaAuthorization {
                project_id: metadata.id(),
                expected_state_version: project.state_version(),
            },
            AssetId::new(),
        )
        .expect_err("unknown media must not reopen");

        assert_eq!(error.code(), "mediaUnavailable");
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
