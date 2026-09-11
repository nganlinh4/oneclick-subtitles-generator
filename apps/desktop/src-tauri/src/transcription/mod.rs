pub(crate) mod engine;
pub(crate) mod events;
pub(crate) mod planner;
pub(crate) mod projection;
pub(crate) mod staging;
pub(crate) mod worker;

use std::sync::Arc;

use osg_domain::{JobId, JobSnapshot, JobUpdate};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::DesktopState;

pub(crate) use self::engine::StartWordNativeTranscriptionRequest;
pub(crate) use self::events::WordNativeTranscriptionEvent;

/// Starts native word-native transcription for a project media.
#[tauri::command]
pub(crate) async fn start_word_native_transcription(
    state: State<'_, DesktopState>,
    media_blobs: State<'_, MediaBlobStore>,
    request: StartWordNativeTranscriptionRequest,
    on_event: Channel<WordNativeTranscriptionEvent>,
) -> CommandResult<JobSnapshot> {
    engine::start_transcription_engine(&state, &media_blobs, request, on_event).await
}

/// Cooperatively cancels an in-flight transcription operation.
#[tauri::command]
pub(crate) async fn cancel_transcription(
    state: State<'_, DesktopState>,
    task_id: Option<JobId>,
    job_id: Option<JobId>,
) -> CommandResult<JobSnapshot> {
    let id = task_id
        .or(job_id)
        .ok_or_else(|| CommandError::invalid_input("missing taskId or jobId"))?;
    let jobs = Arc::clone(&state.jobs);
    tauri::async_runtime::spawn_blocking(move || jobs.apply(id, JobUpdate::RequestCancellation))
        .await
        .map_err(|_| CommandError::internal("the job cancellation task stopped unexpectedly"))?
        .map(|ticket| ticket.snapshot().clone())
        .map_err(Into::into)
}
