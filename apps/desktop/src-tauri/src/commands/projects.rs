//! Project, revision and track-history commands.

use osg_application::{
    ProjectHistoryStatus, ProjectSnapshot, ProjectTrackHistoryMutation, ProjectTrackHistoryStatus,
    ProjectTrackSelector, RevisionCommit,
};
use osg_domain::{ProjectId, ProjectMetadata, RevisionReason, SubtitleTrack};
use osg_infrastructure::storage::{DatabaseError, TranscriptRevisionState};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

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
    background::run_blocking("create project", move || {
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
    background::run_blocking("load project", move || database.load_project(id)).await
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
    background::run_blocking::<_, DatabaseError>("load project transcript", move || {
        let revisions = database.transcript_list_revisions(id)?;
        let latest = revisions
            .into_iter()
            .rev()
            .find(|r| r.state != TranscriptRevisionState::Failed);

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
    background::run_blocking("inspect project history", move || {
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
    background::run_blocking("inspect editor track history", move || {
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
    background::run_blocking("commit editor track", move || {
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
    background::run_blocking("undo editor track", move || {
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
    background::run_blocking("redo editor track", move || {
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
    background::run_blocking("commit project", move || {
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
    background::run_blocking("undo project", move || {
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
    background::run_blocking("redo project", move || {
        expected_reason.as_ref().map_or_else(
            || database.redo_project(id, expected_version),
            |reason| database.redo_project_guarded(id, expected_version, reason),
        )
    })
    .await
}
