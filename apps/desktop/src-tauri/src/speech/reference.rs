//! Reference-audio selection, import, extraction and commit.

use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use osg_domain::{JobId, ProjectId};
use osg_infrastructure::storage::{Database, ProjectSpeechReference, ProjectSpeechReferenceWrite};
use osg_media::{
    AudioExtractionPlan, AudioOutput, AudioSampleRate, CancellationToken as MediaCancellationToken,
    ChannelCount, MediaInput, MediaOperation, MediaOutput, MediaTimeRange,
    RunControl as MediaRunControl,
};
use osg_runtime_staging::OwnedStagingDirectory;
use osg_speech::AudioAsset;
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::artifact_types::{
    SpeechArtifactFormatResponse, SpeechPlayableArtifact, SpeechReferenceBackend,
    SpeechReferenceClearRequest, SpeechReferenceCommitRequest, SpeechReferenceDeliveryResponse,
    SpeechReferenceExtractRequest, SpeechReferenceImportRequest, SpeechReferencePlayableResponse,
    SpeechReferenceProjectRequest, SpeechReferenceRecordResponse, SpeechReferenceSelectRequest,
};
use super::artifacts::{
    PublishedSpeechArtifact, SpeechArtifactMetadata, descriptor_from_record, parse_artifact_id,
    publish_project_durable_artifact, register_speech_playback, rollback_published_speech_artifact,
};
use super::jobs::speech_command_error;
use super::runtime::SpeechRuntime;
use super::{MAX_REFERENCE_BYTES, REFERENCE_EXTRACTION_TIMEOUT};
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::DesktopState;

#[tauri::command]
pub(crate) async fn speech_reference_select(
    app: AppHandle,
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechReferenceSelectRequest,
) -> CommandResult<Option<SpeechReferencePlayableResponse>> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let speech_runtime = runtime.inner().clone();
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &database,
            request.project_id,
            request.expected_project_state_version,
        )?;
        let Some(path) = dialog_paths::pick_file(&app)? else {
            return Ok(None);
        };
        normalize_and_publish_reference(
            &ReferencePublicationContext {
                runtime: &speech_runtime,
                media_engine: &media_engine,
                work: &work,
                database: &database,
                media_server: &media_server,
                project_id: request.project_id,
                expected_project_state_version: request.expected_project_state_version,
                expected_reference_version: request.expected_reference_version,
            },
            &path,
            request.backend,
            "nativeSelection",
        )
        .map(Some)
    })
    .await
    .map_err(|_| CommandError::internal("The reference import task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State values as owned command extractors"
)]
pub(crate) async fn speech_reference_import(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    blob_store: State<'_, MediaBlobStore>,
    request: SpeechReferenceImportRequest,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let speech_runtime = runtime.inner().clone();
    let imported = blob_store
        .resolve(request.asset_id)?
        .ok_or_else(|| CommandError::invalid_input("The imported reference audio expired."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &database,
            request.project_id,
            request.expected_project_state_version,
        )?;
        normalize_and_publish_reference(
            &ReferencePublicationContext {
                runtime: &speech_runtime,
                media_engine: &media_engine,
                work: &work,
                database: &database,
                media_server: &media_server,
                project_id: request.project_id,
                expected_project_state_version: request.expected_project_state_version,
                expected_reference_version: request.expected_reference_version,
            },
            imported.path(),
            request.backend,
            "nativeBinaryImport",
        )
    })
    .await
    .map_err(|_| CommandError::internal("The reference import task stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn speech_reference_extract(
    runtime: State<'_, SpeechRuntime>,
    state: State<'_, DesktopState>,
    request: SpeechReferenceExtractRequest,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let duration_ms = request
        .end_ms
        .checked_sub(request.start_ms)
        .filter(|duration| *duration > 0 && *duration <= request.backend.maximum_duration_ms())
        .ok_or_else(|| CommandError::invalid_input("The reference-audio range is invalid."))?;
    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let local_media = state
        .editor
        .read()
        .map_err(|_| CommandError::internal("The editing session is unavailable."))?
        .local_media
        .clone()
        .ok_or_else(|| {
            CommandError::invalid_input("Select media before extracting a reference.")
        })?;
    let media_path = local_media.path().to_owned();
    let media_asset_id = local_media.asset_id();
    let work = runtime
        .work_directory()
        .map_err(|_| CommandError::internal("The speech work directory is unavailable."))?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let speech_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_reference_project_state(
            &database,
            request.project_id,
            request.expected_project_state_version,
        )?;
        if !database.project_media_is_current(
            request.project_id,
            request.expected_project_state_version,
            media_asset_id,
        )? {
            return Err(CommandError::media_unavailable());
        }
        let source = MediaInput::from_native_selection(media_path)?;
        let output_path = work.path().join("reference.wav");
        let output = MediaOutput::within_root(&output_path, work.path())?;
        let range = MediaTimeRange::new(
            request.start_ms.saturating_mul(1_000),
            Some(duration_ms.saturating_mul(1_000)),
        )?;
        let plan = AudioExtractionPlan::new(
            source,
            output,
            AudioOutput::WavPcm16 {
                sample_rate: AudioSampleRate::new(44_100)?,
                channels: ChannelCount::new(2)?,
            },
            range,
        )?;
        let control = MediaRunControl::new(REFERENCE_EXTRACTION_TIMEOUT)?
            .with_cancellation(MediaCancellationToken::default());
        media_engine.execute(&MediaOperation::AudioExtraction(plan), &control)?;
        let asset = AudioAsset::from_native_file(&output_path)
            .map_err(|error| speech_command_error(&error))?;
        let published = publish_project_durable_artifact(
            &speech_runtime,
            &database,
            request.project_id,
            None,
            &reference_artifact_kind(request.project_id),
            &output_path,
            SpeechArtifactMetadata {
                format: SpeechArtifactFormatResponse::Wav,
                duration_micros: Some(duration_ms.saturating_mul(1_000)),
                sample_rate_hz: Some(44_100),
                channels: Some(2),
                source: "activeMediaSegment",
            },
        )?;
        drop(asset);
        commit_published_reference(
            &database,
            &media_server,
            &published,
            request.project_id,
            request.expected_project_state_version,
            request.expected_reference_version,
            String::new(),
            "Unknown".to_owned(),
            None,
            None,
        )
    })
    .await
    .map_err(|_| CommandError::internal("The reference extraction task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_reference_get(
    state: State<'_, DesktopState>,
    request: SpeechReferenceProjectRequest,
) -> CommandResult<Option<SpeechReferencePlayableResponse>> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(reference) = database.get_project_speech_reference(request.project_id)? else {
            return Ok(None);
        };
        resolve_reference_record(&database, &media_server, reference).map(Some)
    })
    .await
    .map_err(|_| CommandError::internal("The reference restore task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_reference_commit(
    state: State<'_, DesktopState>,
    request: SpeechReferenceCommitRequest,
) -> CommandResult<SpeechReferenceRecordResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let artifact_id = parse_artifact_id(&request.artifact_id)?;
        let stored = database.put_project_speech_reference(&ProjectSpeechReferenceWrite {
            project_id: request.project_id,
            expected_project_state_version: request.expected_project_state_version,
            expected_reference_version: request.expected_reference_version,
            artifact_id,
            transcript: request.transcript,
            language: request.language,
            delivery_job_id: request.delivery_job_id,
            delivery_id: request.delivery_id,
        })?;
        Ok(reference_record_response(stored))
    })
    .await
    .map_err(|_| CommandError::internal("The reference commit task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_reference_clear(
    state: State<'_, DesktopState>,
    request: SpeechReferenceClearRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .delete_project_speech_reference(
                request.project_id,
                request.expected_project_state_version,
                request.expected_reference_version,
            )
            .map_err(Into::into)
    })
    .await
    .map_err(|_| CommandError::internal("The reference clear task stopped unexpectedly."))?
}

fn reference_artifact_kind(project_id: ProjectId) -> String {
    format!("speechReference.{project_id}")
}

pub(super) fn require_reference_project_state(
    database: &Database,
    project_id: ProjectId,
    expected_state_version: u64,
) -> CommandResult<()> {
    let project = database.load_project(project_id)?.ok_or(
        osg_infrastructure::storage::DatabaseError::ProjectNotFound(project_id),
    )?;
    if project.state_version() != expected_state_version {
        return Err(
            osg_infrastructure::storage::DatabaseError::StaleProjectVersion {
                project_id,
                expected: expected_state_version,
                actual: project.state_version(),
            }
            .into(),
        );
    }
    Ok(())
}

fn reference_record_response(reference: ProjectSpeechReference) -> SpeechReferenceRecordResponse {
    let pending_delivery =
        reference
            .delivery_job_id
            .zip(reference.delivery_id)
            .map(|(job_id, delivery_id)| SpeechReferenceDeliveryResponse {
                job_id,
                delivery_id,
            });
    SpeechReferenceRecordResponse {
        schema_version: 1,
        project_id: reference.project_id,
        project_state_version: reference.committed_project_state_version,
        reference_version: reference.reference_version,
        artifact_id: reference.artifact_id.to_string(),
        transcript: reference.transcript,
        language: reference.language,
        pending_delivery,
    }
}

fn resolve_reference_record(
    database: &Database,
    media_server: &osg_media_server::MediaServer,
    reference: ProjectSpeechReference,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let resolved = database
        .resolve_artifact(reference.artifact_id)?
        .ok_or_else(|| CommandError::invalid_input("The reference audio is unavailable."))?;
    if resolved.record().project_id() != Some(reference.project_id)
        || resolved.record().kind().as_str() != reference_artifact_kind(reference.project_id)
    {
        return Err(CommandError::invalid_input(
            "The reference audio does not belong to this project.",
        ));
    }
    let descriptor = descriptor_from_record(resolved.record())?;
    let playback = register_speech_playback(media_server, resolved.path(), descriptor.format)?;
    Ok(SpeechReferencePlayableResponse {
        reference: reference_record_response(reference),
        playable: SpeechPlayableArtifact {
            artifact: descriptor,
            playback,
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn commit_published_reference(
    database: &Database,
    media_server: &osg_media_server::MediaServer,
    published: &PublishedSpeechArtifact,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
    transcript: String,
    language: String,
    delivery_job_id: Option<JobId>,
    delivery_id: Option<Uuid>,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let stored = match database.put_project_speech_reference(&ProjectSpeechReferenceWrite {
        project_id,
        expected_project_state_version,
        expected_reference_version,
        artifact_id: published.id,
        transcript,
        language,
        delivery_job_id,
        delivery_id,
    }) {
        Ok(stored) => stored,
        Err(error) => {
            rollback_published_speech_artifact(database, published)?;
            return Err(error.into());
        }
    };
    resolve_reference_record(database, media_server, stored)
}

pub(super) struct ReferencePublicationContext<'a> {
    pub(super) runtime: &'a SpeechRuntime,
    pub(super) media_engine: &'a osg_media::MediaEngine,
    pub(super) work: &'a OwnedStagingDirectory,
    pub(super) database: &'a Database,
    pub(super) media_server: &'a osg_media_server::MediaServer,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) expected_reference_version: u64,
}

fn normalize_and_publish_reference(
    context: &ReferencePublicationContext<'_>,
    source_path: &Path,
    backend: SpeechReferenceBackend,
    source_label: &'static str,
) -> CommandResult<SpeechReferencePlayableResponse> {
    let mut source_file = fs::File::open(source_path)
        .map_err(|_| CommandError::invalid_input("The reference audio is unavailable."))?;
    let source_metadata = source_file
        .metadata()
        .map_err(|_| CommandError::invalid_input("The reference audio is unavailable."))?;
    if !source_metadata.is_file()
        || source_metadata.len() == 0
        || source_metadata.len() > MAX_REFERENCE_BYTES
    {
        return Err(CommandError::invalid_input(
            "Reference audio must be a nonempty file no larger than 64 MiB.",
        ));
    }
    let mut staged_source = tempfile::Builder::new()
        .prefix("reference-input-")
        .suffix(".media")
        .tempfile_in(context.work.path())
        .map_err(|_| CommandError::internal("The reference staging area is unavailable."))?;
    let copied = io::copy(
        &mut (&mut source_file).take(MAX_REFERENCE_BYTES.saturating_add(1)),
        staged_source.as_file_mut(),
    )
    .map_err(|_| CommandError::invalid_input("The reference audio could not be read safely."))?;
    if copied != source_metadata.len() || copied > MAX_REFERENCE_BYTES {
        return Err(CommandError::invalid_input(
            "The reference audio changed while it was being imported.",
        ));
    }
    staged_source
        .as_file_mut()
        .flush()
        .and_then(|()| staged_source.as_file().sync_all())
        .map_err(|_| CommandError::internal("The reference staging area is unavailable."))?;
    let source = MediaInput::from_native_selection(staged_source.path())?;
    let cancellation = MediaCancellationToken::default();
    let control =
        MediaRunControl::new(REFERENCE_EXTRACTION_TIMEOUT)?.with_cancellation(cancellation);
    let metadata = context.media_engine.probe(&source, &control)?;
    let duration_micros = metadata
        .duration_us()
        .filter(|duration| {
            *duration > 0 && *duration <= backend.maximum_duration_ms().saturating_mul(1_000)
        })
        .ok_or_else(|| {
            CommandError::invalid_input("The reference-audio duration is outside the safe limit.")
        })?;
    if metadata.primary_audio().is_none() {
        return Err(CommandError::invalid_input(
            "The selected reference does not contain usable audio.",
        ));
    }

    let output_path = context.work.path().join("reference.wav");
    let output = MediaOutput::within_root(&output_path, context.work.path())?;
    let plan = AudioExtractionPlan::new(
        source,
        output,
        AudioOutput::WavPcm16 {
            sample_rate: AudioSampleRate::new(44_100)?,
            channels: ChannelCount::new(2)?,
        },
        MediaTimeRange::new(0, Some(duration_micros))?,
    )?;
    context
        .media_engine
        .execute(&MediaOperation::AudioExtraction(plan), &control)?;
    let normalized =
        AudioAsset::from_native_file(&output_path).map_err(|error| speech_command_error(&error))?;
    let published = publish_project_durable_artifact(
        context.runtime,
        context.database,
        context.project_id,
        None,
        &reference_artifact_kind(context.project_id),
        &output_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(duration_micros),
            sample_rate_hz: Some(44_100),
            channels: Some(2),
            source: source_label,
        },
    )?;
    drop(normalized);
    commit_published_reference(
        context.database,
        context.media_server,
        &published,
        context.project_id,
        context.expected_project_state_version,
        context.expected_reference_version,
        String::new(),
        "Unknown".to_owned(),
        None,
        None,
    )
}
