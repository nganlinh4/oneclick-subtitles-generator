//! Speech artifact editing and durable per-project narration results.

use std::collections::HashSet;
use std::path::Path;

use osg_domain::ProjectId;
use osg_infrastructure::storage::Database;
use osg_media::{
    CancellationToken as MediaCancellationToken, MediaInput, MediaOperation, MediaOutput,
    NarrationAudioEditPlan as MediaAudioEditPlan, RunControl as MediaRunControl,
};
use osg_speech::{
    AudioEditPlan as SpeechAudioEditPlan, AudioFilter, NormalizedPoint, NormalizedTrim,
    SpeedFactor, TimeMicros,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::artifact_types::{
    SpeechArtifactDescriptor, SpeechArtifactEditRequest, SpeechArtifactEditResponse,
    SpeechArtifactFormatResponse,
};
use super::artifacts::{
    SpeechArtifactMetadata, descriptor_from_record, parse_artifact_id,
    publish_project_durable_artifact, resolve_alignment_audio, rollback_published_speech_artifact,
};
use super::jobs::speech_command_error;
use super::reference::require_reference_project_state;
use super::runtime::SpeechRuntime;
use super::{
    MAX_ALIGNMENT_DURATION_MICROS, MAX_BATCH_TEXT_BYTES, MAX_SEGMENT_TEXT_CHARACTERS, MAX_SEGMENTS,
    NARRATION_EDIT_TIMEOUT, PROJECT_NARRATION_SCHEMA_VERSION, PROJECT_NARRATION_SCOPE,
};
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub(super) enum SpeechNarrationCueId {
    Number(i64),
    Text(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechNarrationSource {
    Original,
    Translated,
    Grouped,
}

impl SpeechNarrationSource {
    const fn storage_key(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Translated => "translated",
            Self::Grouped => "grouped",
        }
    }
}

pub(super) fn project_narration_storage_key(
    project_id: ProjectId,
    source: SpeechNarrationSource,
) -> String {
    format!("{project_id}:{}", source.storage_key())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpeechProjectNarrationResultRequest {
    pub(super) subtitle_id: SpeechNarrationCueId,
    pub(super) text: String,
    pub(super) artifact_id: String,
    pub(super) method: String,
    pub(super) output_index: Option<u32>,
    pub(super) original_ids: Vec<SpeechNarrationCueId>,
    pub(super) start_micros: u64,
    pub(super) end_micros: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechProjectNarrationPutRequest {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) source: SpeechNarrationSource,
    pub(super) results: Vec<SpeechProjectNarrationResultRequest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredProjectNarrationResult {
    pub(super) subtitle_id: SpeechNarrationCueId,
    pub(super) text: String,
    pub(super) artifact_id: String,
    pub(super) method: String,
    pub(super) output_index: Option<u32>,
    pub(super) original_ids: Vec<SpeechNarrationCueId>,
    pub(super) start_micros: u64,
    pub(super) end_micros: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredProjectNarration {
    pub(super) schema_version: u32,
    pub(super) project_id: ProjectId,
    pub(super) project_state_version: u64,
    pub(super) source: SpeechNarrationSource,
    pub(super) results: Vec<StoredProjectNarrationResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechProjectNarrationResultResponse {
    pub(super) subtitle_id: SpeechNarrationCueId,
    pub(super) text: String,
    pub(super) artifact: SpeechArtifactDescriptor,
    pub(super) method: String,
    pub(super) output_index: Option<u32>,
    pub(super) original_ids: Vec<SpeechNarrationCueId>,
    pub(super) start_micros: u64,
    pub(super) end_micros: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechProjectNarrationResponse {
    pub(super) schema_version: u32,
    pub(super) project_id: ProjectId,
    pub(super) project_state_version: u64,
    pub(super) source: SpeechNarrationSource,
    pub(super) results: Vec<SpeechProjectNarrationResultResponse>,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_artifact_edit(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechArtifactEditRequest,
) -> CommandResult<SpeechArtifactEditResponse> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    let speech_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        edit_project_speech_artifact(
            &speech_runtime,
            &database,
            &media_engine,
            work.path(),
            &request,
        )
    })
    .await
    .map_err(|_| CommandError::internal("The narration edit task stopped unexpectedly."))?
}

fn edit_project_speech_artifact(
    runtime: &SpeechRuntime,
    database: &Database,
    media_engine: &osg_media::MediaEngine,
    work_root: &Path,
    request: &SpeechArtifactEditRequest,
) -> CommandResult<SpeechArtifactEditResponse> {
    if request.expected_project_state_version > i64::MAX as u64 {
        return Err(CommandError::invalid_input(
            "The narration edit project state version is invalid.",
        ));
    }
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    let (audio, media, descriptor, source_project_id) =
        resolve_alignment_audio(database, &request.artifact_id)?;
    if source_project_id != Some(request.project_id) {
        return Err(CommandError::invalid_input(
            "The narration audio does not belong to the requested project.",
        ));
    }
    let duration = descriptor.duration_micros.ok_or_else(|| {
        CommandError::invalid_input("The narration duration is unavailable for editing.")
    })?;
    let trim = NormalizedTrim::new(
        NormalizedPoint::from_millionths(request.normalized_start_millionths)
            .map_err(|error| speech_command_error(&error))?,
        NormalizedPoint::from_millionths(request.normalized_end_millionths)
            .map_err(|error| speech_command_error(&error))?,
    )
    .map_err(|error| speech_command_error(&error))?;
    let speed = SpeedFactor::from_milli(request.speed_milli)
        .map_err(|error| speech_command_error(&error))?;
    let speech_plan = SpeechAudioEditPlan::new(
        audio,
        TimeMicros::new(duration).map_err(|error| speech_command_error(&error))?,
        trim,
        speed,
    )
    .map_err(|error| speech_command_error(&error))?;
    let (start_us, end_us) = match speech_plan.filters().first() {
        Some(AudioFilter::Trim { start, end }) => (start.get(), end.get()),
        _ => {
            return Err(CommandError::internal(
                "The narration edit plan is invalid.",
            ));
        }
    };
    let output_path = work_root.join("edited.wav");
    let output = MediaOutput::within_root(&output_path, work_root)?;
    let media_plan =
        MediaAudioEditPlan::new(media, output, start_us, end_us, speech_plan.speed().milli())?;
    let control = MediaRunControl::new(NARRATION_EDIT_TIMEOUT)?
        .with_cancellation(MediaCancellationToken::default());
    media_engine.execute(&MediaOperation::NarrationAudioEdit(media_plan), &control)?;
    let edited_input = MediaInput::from_native_selection(&output_path)?;
    let metadata = media_engine.probe(&edited_input, &control)?;
    let audio_metadata = metadata
        .primary_audio()
        .and_then(|stream| stream.audio.as_ref())
        .ok_or_else(|| CommandError::internal("The edited narration audio is invalid."))?;
    let duration_micros = metadata
        .duration_us()
        .ok_or_else(|| CommandError::internal("The edited narration duration is unavailable."))?;
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    let published = publish_project_durable_artifact(
        runtime,
        database,
        request.project_id,
        None,
        "narrationOutput",
        &output_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(duration_micros),
            sample_rate_hz: audio_metadata.sample_rate_hz,
            channels: audio_metadata
                .channels
                .and_then(|value| u8::try_from(value).ok()),
            source: "nativeNarrationEdit",
        },
    )?;
    if let Err(error) = require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    ) {
        rollback_published_speech_artifact(database, &published)?;
        return Err(error);
    }
    Ok(SpeechArtifactEditResponse {
        project_id: request.project_id,
        expected_project_state_version: request.expected_project_state_version,
        artifact: published.descriptor,
    })
}

fn validate_narration_cue_id(id: &SpeechNarrationCueId) -> bool {
    match id {
        SpeechNarrationCueId::Number(value) => value.unsigned_abs() <= 9_007_199_254_740_991,
        SpeechNarrationCueId::Text(value) => {
            !value.is_empty()
                && value.chars().count() <= 256
                && !value.chars().any(char::is_control)
        }
    }
}

fn validate_project_narration_result(
    database: &Database,
    project_id: ProjectId,
    request: SpeechProjectNarrationResultRequest,
) -> CommandResult<StoredProjectNarrationResult> {
    if !validate_narration_cue_id(&request.subtitle_id)
        || request.text.is_empty()
        || request.text.chars().count() > MAX_SEGMENT_TEXT_CHARACTERS
        || !matches!(
            request.method.as_str(),
            "f5tts" | "chatterbox" | "edge-tts" | "gtts" | "gemini"
        )
        || request.original_ids.is_empty()
        || request.original_ids.len() > MAX_SEGMENTS
        || request
            .original_ids
            .iter()
            .any(|id| !validate_narration_cue_id(id))
        || request.end_micros <= request.start_micros
        || request.end_micros > MAX_ALIGNMENT_DURATION_MICROS
    {
        return Err(CommandError::invalid_input(
            "The project narration record is invalid.",
        ));
    }
    let artifact_id = parse_artifact_id(&request.artifact_id)?;
    let resolved = database
        .resolve_artifact(artifact_id)?
        .ok_or_else(|| CommandError::invalid_input("The narration audio is unavailable."))?;
    if resolved.record().project_id() != Some(project_id)
        || !matches!(
            resolved.record().kind().as_str(),
            "narrationOutput" | "voiceConversion"
        )
    {
        return Err(CommandError::invalid_input(
            "The narration audio does not belong to this project.",
        ));
    }
    descriptor_from_record(resolved.record())?;
    Ok(StoredProjectNarrationResult {
        subtitle_id: request.subtitle_id,
        text: request.text,
        artifact_id: artifact_id.to_string(),
        method: request.method,
        output_index: request.output_index,
        original_ids: request.original_ids,
        start_micros: request.start_micros,
        end_micros: request.end_micros,
    })
}

fn project_narration_response(
    database: &Database,
    stored: StoredProjectNarration,
) -> CommandResult<SpeechProjectNarrationResponse> {
    let mut text_bytes = 0_usize;
    let mut cue_ids = HashSet::with_capacity(stored.results.len());
    let mut artifact_ids = HashSet::with_capacity(stored.results.len());
    let mut results = Vec::with_capacity(stored.results.len());
    for result in stored.results {
        text_bytes = text_bytes
            .checked_add(result.text.len())
            .filter(|bytes| *bytes <= MAX_BATCH_TEXT_BYTES)
            .ok_or_else(|| CommandError::internal("The stored project narration is invalid."))?;
        if !validate_narration_cue_id(&result.subtitle_id)
            || result.text.is_empty()
            || result.text.chars().count() > MAX_SEGMENT_TEXT_CHARACTERS
            || !matches!(
                result.method.as_str(),
                "f5tts" | "chatterbox" | "edge-tts" | "gtts" | "gemini"
            )
            || result.original_ids.is_empty()
            || result.original_ids.len() > MAX_SEGMENTS
            || result
                .original_ids
                .iter()
                .any(|id| !validate_narration_cue_id(id))
            || result.end_micros <= result.start_micros
            || result.end_micros > MAX_ALIGNMENT_DURATION_MICROS
            || !cue_ids.insert(result.subtitle_id.clone())
            || !artifact_ids.insert(result.artifact_id.clone())
        {
            return Err(CommandError::internal(
                "The stored project narration is invalid.",
            ));
        }
        let artifact_id = parse_artifact_id(&result.artifact_id)
            .map_err(|_| CommandError::internal("The stored project narration is invalid."))?;
        let resolved = database
            .resolve_artifact(artifact_id)?
            .ok_or_else(|| CommandError::internal("The stored project narration is invalid."))?;
        if resolved.record().project_id() != Some(stored.project_id)
            || !matches!(
                resolved.record().kind().as_str(),
                "narrationOutput" | "voiceConversion"
            )
        {
            return Err(CommandError::internal(
                "The stored project narration is invalid.",
            ));
        }
        results.push(SpeechProjectNarrationResultResponse {
            subtitle_id: result.subtitle_id,
            text: result.text,
            artifact: descriptor_from_record(resolved.record())?,
            method: result.method,
            output_index: result.output_index,
            original_ids: result.original_ids,
            start_micros: result.start_micros,
            end_micros: result.end_micros,
        });
    }
    Ok(SpeechProjectNarrationResponse {
        schema_version: stored.schema_version,
        project_id: stored.project_id,
        project_state_version: stored.project_state_version,
        source: stored.source,
        results,
    })
}

pub(super) fn put_project_narration(
    database: &Database,
    request: SpeechProjectNarrationPutRequest,
) -> CommandResult<SpeechProjectNarrationResponse> {
    if request.expected_project_state_version > i64::MAX as u64
        || request.results.len() > MAX_SEGMENTS
    {
        return Err(CommandError::invalid_input(
            "The project narration record is invalid.",
        ));
    }
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    let mut text_bytes = 0_usize;
    let mut cue_ids = HashSet::with_capacity(request.results.len());
    let mut artifact_ids = HashSet::with_capacity(request.results.len());
    let mut results = Vec::with_capacity(request.results.len());
    for result in request.results {
        text_bytes = text_bytes
            .checked_add(result.text.len())
            .filter(|bytes| *bytes <= MAX_BATCH_TEXT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The project narration record is too large.")
            })?;
        let result = validate_project_narration_result(database, request.project_id, result)?;
        if !cue_ids.insert(result.subtitle_id.clone())
            || !artifact_ids.insert(result.artifact_id.clone())
        {
            return Err(CommandError::invalid_input(
                "The project narration record contains duplicate results.",
            ));
        }
        results.push(result);
    }
    let storage_key = project_narration_storage_key(request.project_id, request.source);
    let stored = StoredProjectNarration {
        schema_version: PROJECT_NARRATION_SCHEMA_VERSION,
        project_id: request.project_id,
        project_state_version: request.expected_project_state_version,
        source: request.source,
        results,
    };
    let value = serde_json::to_value(&stored)
        .map_err(|_| CommandError::internal("The project narration record is invalid."))?;
    database.put_project_setting(
        PROJECT_NARRATION_SCOPE,
        &storage_key,
        &value,
        request.project_id,
        request.expected_project_state_version,
    )?;
    project_narration_response(database, stored)
}

pub(super) fn get_project_narration(
    database: &Database,
    project_id: ProjectId,
    source: SpeechNarrationSource,
) -> CommandResult<Option<SpeechProjectNarrationResponse>> {
    let Some(project) = database.load_project(project_id)? else {
        return Err(CommandError::invalid_input(
            "The subtitle project is unavailable.",
        ));
    };
    let storage_key = project_narration_storage_key(project_id, source);
    let (value, legacy) = if let Some(value) =
        database.get_setting(PROJECT_NARRATION_SCOPE, &storage_key)?
    {
        (value, false)
    } else {
        let Some(value) = database.get_setting(PROJECT_NARRATION_SCOPE, &project_id.to_string())?
        else {
            return Ok(None);
        };
        (value, true)
    };
    let stored: StoredProjectNarration = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The stored project narration is invalid."))?;
    if stored.schema_version != PROJECT_NARRATION_SCHEMA_VERSION
        || stored.project_id != project_id
        || stored.results.len() > MAX_SEGMENTS
    {
        return Err(CommandError::internal(
            "The stored project narration is invalid.",
        ));
    }
    if stored.source != source {
        if legacy {
            return Ok(None);
        }
        return Err(CommandError::internal(
            "The stored project narration is invalid.",
        ));
    }
    if stored.project_state_version != project.state_version() {
        return Ok(None);
    }
    project_narration_response(database, stored).map(Some)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_project_narration_put(
    state: State<'_, DesktopState>,
    request: SpeechProjectNarrationPutRequest,
) -> CommandResult<SpeechProjectNarrationResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || put_project_narration(&database, request))
        .await
        .map_err(|_| CommandError::internal("The project narration task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_project_narration_get(
    state: State<'_, DesktopState>,
    project_id: ProjectId,
    source: SpeechNarrationSource,
) -> CommandResult<Option<SpeechProjectNarrationResponse>> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_project_narration(&database, project_id, source)
    })
    .await
    .map_err(|_| CommandError::internal("The project narration task stopped unexpectedly."))?
}
