//! Durable speech artifact publication, rollback and playback resolution.

use std::fmt;
use std::fs;
use std::io::{self, BufReader, Seek, SeekFrom, Write};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use osg_domain::{JobId, ProjectId};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
    ContentHash, Database,
};
use osg_media::MediaInput;
use osg_media_server::RegisteredMedia;
use osg_speech::{AudioAsset, AudioFormat};
use uuid::Uuid;

use super::artifact_types::{SpeechArtifactDescriptor, SpeechArtifactFormatResponse};
use super::jobs::{SpeechFailureCode, StoredSpeechResult, speech_command_error};
use super::lifecycle::SpeechLifecycleOwnership;
use super::runtime::{SpeechArtifactPublicationKey, SpeechRuntime};
use super::{MAX_CONVERSION_INPUT_BYTES, MAX_REFERENCE_BYTES};
use crate::error::{CommandError, CommandResult};

#[derive(Clone, Copy)]
pub(super) struct SpeechArtifactMetadata {
    pub(super) format: SpeechArtifactFormatResponse,
    pub(super) duration_micros: Option<u64>,
    pub(super) sample_rate_hz: Option<u32>,
    pub(super) channels: Option<u8>,
    pub(super) source: &'static str,
}

impl SpeechArtifactMetadata {
    pub(super) fn from_summary(summary: &osg_speech::SpeechArtifactSummary) -> Self {
        Self {
            format: summary.format().into(),
            duration_micros: Some(summary.duration().get()),
            sample_rate_hz: Some(summary.sample_rate_hz()),
            channels: Some(summary.channels()),
            source: "nativeSpeechWorker",
        }
    }
}

pub(super) struct PublishedSpeechArtifact {
    pub(super) id: ArtifactId,
    pub(super) created: bool,
    pub(super) descriptor: SpeechArtifactDescriptor,
    #[cfg(test)]
    pub(super) path: PathBuf,
}

pub(super) struct PreparedSpeechArtifactPublication {
    pub(super) source: BufReader<fs::File>,
    draft: ArtifactDraft,
    size_bytes: u64,
    pub(super) key: SpeechArtifactPublicationKey,
}

impl fmt::Debug for PublishedSpeechArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedSpeechArtifact")
            .field("id", &"<redacted>")
            .field("created", &self.created)
            .field("descriptor", &self.descriptor)
            .field("path", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
pub(super) fn publish_durable_artifact(
    runtime: &SpeechRuntime,
    database: &Database,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    publish_durable_artifact_with_project(
        runtime,
        database,
        None,
        job_id,
        kind,
        source_path,
        metadata,
    )
}

pub(super) fn publish_project_durable_artifact(
    runtime: &SpeechRuntime,
    database: &Database,
    project_id: ProjectId,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    publish_durable_artifact_with_project(
        runtime,
        database,
        Some(project_id),
        job_id,
        kind,
        source_path,
        metadata,
    )
}

fn publish_durable_artifact_with_project(
    runtime: &SpeechRuntime,
    database: &Database,
    project_id: Option<ProjectId>,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PublishedSpeechArtifact> {
    let prepared =
        prepare_speech_artifact_publication(project_id, job_id, kind, source_path, metadata)?;
    let gate = runtime
        .artifact_publication_gate(prepared.key.clone())
        .map_err(|_| artifact_storage_error())?;
    let _publication = gate.lock().map_err(|_| artifact_storage_error())?;
    publish_prepared_speech_artifact(database, prepared)
}

fn prepare_speech_artifact_publication(
    project_id: Option<ProjectId>,
    job_id: Option<JobId>,
    kind: &str,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
) -> CommandResult<PreparedSpeechArtifactPublication> {
    let source_metadata =
        fs::symlink_metadata(source_path).map_err(|_| artifact_storage_error())?;
    let size_bytes = source_metadata.len();
    let maximum_bytes = match kind {
        kind if kind == "speechReference"
            || kind == "speechPreparedReference"
            || kind.starts_with("speechReference.") =>
        {
            MAX_REFERENCE_BYTES
        }
        "narrationOutput" | "voiceConversion" | "alignedNarration" => MAX_CONVERSION_INPUT_BYTES,
        _ => return Err(artifact_storage_error()),
    };
    if !source_metadata.file_type().is_file() || size_bytes == 0 || size_bytes > maximum_bytes {
        return Err(artifact_storage_error());
    }
    let source = fs::File::open(source_path).map_err(|_| artifact_storage_error())?;
    let mut source = BufReader::new(source);
    let content_hash =
        ContentHash::digest_reader(&mut source).map_err(|_| artifact_storage_error())?;
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| artifact_storage_error())?;
    let draft = ArtifactDraft::new(
        ArtifactKind::new(kind).map_err(|_| artifact_storage_error())?,
        content_hash,
        size_bytes,
        serde_json::json!({
            "format": metadata.format,
            "durationMicros": metadata.duration_micros,
            "sampleRateHz": metadata.sample_rate_hz,
            "channels": metadata.channels,
            "source": metadata.source,
        }),
    )
    .map_err(|_| artifact_storage_error())?;
    let draft = match project_id {
        Some(project_id) => draft.with_project(project_id),
        None => draft,
    };
    let draft = match job_id {
        Some(job_id) => draft.with_job(job_id),
        None => draft,
    };
    Ok(PreparedSpeechArtifactPublication {
        source,
        draft,
        size_bytes,
        key: SpeechArtifactPublicationKey {
            kind: kind.to_owned(),
            content_hash: content_hash.as_bytes().to_vec(),
        },
    })
}

fn publish_prepared_speech_artifact(
    database: &Database,
    mut prepared: PreparedSpeechArtifactPublication,
) -> CommandResult<PublishedSpeechArtifact> {
    let (id, created) = match database.register_artifact(&prepared.draft)? {
        ArtifactRegistration::Existing(record) => (record.id(), false),
        ArtifactRegistration::Pending(record) => {
            return Err(
                osg_infrastructure::storage::DatabaseError::ArtifactPublicationInProgress(
                    record.id(),
                )
                .into(),
            );
        }
        ArtifactRegistration::Staging(staging) => {
            let id = staging.record().id();
            let publication = (|| -> io::Result<()> {
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(staging.path())?;
                let copied = io::copy(&mut prepared.source, &mut target)?;
                if copied != prepared.size_bytes {
                    return Err(io::Error::other("speech artifact size changed"));
                }
                target.flush()?;
                target.sync_all()
            })();
            if publication.is_err() || database.mark_artifact_ready(id).is_err() {
                fail_artifact_publication(database, id);
                return Err(artifact_storage_error());
            }
            (id, true)
        }
    };
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(artifact_storage_error)?;
    let descriptor = descriptor_from_record(resolved.record())?;
    Ok(PublishedSpeechArtifact {
        id,
        created,
        descriptor,
        #[cfg(test)]
        path: resolved.path().to_owned(),
    })
}

pub(super) fn rollback_published_speech_artifact(
    database: &Database,
    published: &PublishedSpeechArtifact,
) -> CommandResult<()> {
    if !published.created {
        return Ok(());
    }
    database
        .remove_artifact(published.id)?
        .filter(|record| record.id() == published.id)
        .map(|_| ())
        .ok_or_else(artifact_storage_error)
}

fn rollback_unowned_publication<T>(
    database: &Database,
    published: &PublishedSpeechArtifact,
    code: SpeechFailureCode,
) -> Result<T, SpeechFailureCode> {
    rollback_published_speech_artifact(database, published)
        .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    Err(code)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn commit_completed_speech_source<F>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
    project_id: Option<ProjectId>,
    job_id: JobId,
    segment_id: String,
    kind: &'static str,
    publish_event: F,
) -> Result<StoredSpeechResult, SpeechFailureCode>
where
    F: FnOnce(&StoredSpeechResult),
{
    commit_completed_speech_source_with_hook(
        runtime,
        ownership,
        database,
        source_path,
        metadata,
        project_id,
        job_id,
        segment_id,
        kind,
        |_| {},
        publish_event,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn commit_completed_speech_source_with_hook<F, E>(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    source_path: &Path,
    metadata: SpeechArtifactMetadata,
    project_id: Option<ProjectId>,
    job_id: JobId,
    segment_id: String,
    kind: &'static str,
    after_publish: F,
    publish_event: E,
) -> Result<StoredSpeechResult, SpeechFailureCode>
where
    F: FnOnce(&PublishedSpeechArtifact),
    E: FnOnce(&StoredSpeechResult),
{
    let prepared =
        prepare_speech_artifact_publication(project_id, Some(job_id), kind, source_path, metadata)
            .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    let publication_gate = runtime
        .artifact_publication_gate(prepared.key.clone())
        .map_err(|_| SpeechFailureCode::WorkerFailed)?;
    let publication = publication_gate
        .lock()
        .map_err(|_| SpeechFailureCode::WorkerFailed)?;
    ownership.ensure_owned(runtime, database)?;
    let published = publish_prepared_speech_artifact(database, prepared)
        .map_err(|_| SpeechFailureCode::ArtifactStorage)?;
    after_publish(&published);
    if let Err(code) = ownership.ensure_owned(runtime, database) {
        return rollback_unowned_publication(database, &published, code);
    }
    let result = StoredSpeechResult::Completed {
        segment_id,
        artifact: published.descriptor.clone(),
    };
    match ownership.commit_manifest_result(runtime, database, job_id, result.clone()) {
        Ok(()) => {
            drop(publication);
            publish_event(&result);
            Ok(result)
        }
        Err(SpeechFailureCode::ArtifactStorage) => {
            rollback_unowned_publication(database, &published, SpeechFailureCode::ArtifactStorage)
        }
        Err(code) => rollback_unowned_publication(database, &published, code),
    }
}

fn fail_artifact_publication(database: &Database, id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("speechPublish") {
        let _ = database.mark_artifact_failed(id, &code);
    }
}

fn artifact_storage_error() -> CommandError {
    CommandError::internal("The speech artifact could not be stored durably.")
}

pub(super) fn register_speech_playback(
    media_server: &osg_media_server::MediaServer,
    path: &Path,
    format: SpeechArtifactFormatResponse,
) -> CommandResult<RegisteredMedia> {
    media_server
        .register_with_extension(path, format.extension())
        .map_err(Into::into)
}

pub(super) fn descriptor_from_record(
    record: &osg_infrastructure::storage::ArtifactRecord,
) -> CommandResult<SpeechArtifactDescriptor> {
    let metadata = record
        .metadata()
        .as_object()
        .ok_or_else(|| CommandError::internal("The speech artifact metadata is invalid."))?;
    let format = match metadata.get("format").and_then(serde_json::Value::as_str) {
        Some("wav") => SpeechArtifactFormatResponse::Wav,
        Some("mp3") => SpeechArtifactFormatResponse::Mp3,
        Some("m4a") => SpeechArtifactFormatResponse::M4a,
        _ => {
            return Err(CommandError::internal(
                "The speech artifact metadata is invalid.",
            ));
        }
    };
    let optional_u64 = |key: &str| -> CommandResult<Option<u64>> {
        match metadata.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .map(Some)
                .ok_or_else(|| CommandError::internal("The speech artifact metadata is invalid.")),
        }
    };
    let duration_micros = optional_u64("durationMicros")?;
    let sample_rate_hz = optional_u64("sampleRateHz")?
        .map(u32::try_from)
        .transpose()
        .map_err(|_| CommandError::internal("The speech artifact metadata is invalid."))?;
    let channels = optional_u64("channels")?
        .map(u8::try_from)
        .transpose()
        .map_err(|_| CommandError::internal("The speech artifact metadata is invalid."))?;
    if record.size_bytes() == 0
        || duration_micros == Some(0)
        || duration_micros.is_some_and(|duration| duration > 7 * 24 * 60 * 60 * 1_000_000)
        || sample_rate_hz.is_some_and(|rate| !(8_000..=384_000).contains(&rate))
        || channels.is_some_and(|channels| !(1..=8).contains(&channels))
    {
        return Err(CommandError::internal(
            "The speech artifact metadata is invalid.",
        ));
    }
    Ok(SpeechArtifactDescriptor {
        artifact_id: record.id().to_string(),
        format,
        bytes: record.size_bytes(),
        duration_micros,
        sample_rate_hz,
        channels,
    })
}

pub(super) fn resolve_audio_artifact(
    database: &Database,
    value: &str,
    reference_only: bool,
) -> CommandResult<AudioAsset> {
    let id = parse_artifact_id(value)?;
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(|| CommandError::invalid_input("The speech audio is unavailable."))?;
    ensure_speech_artifact_kind(resolved.record().kind().as_str(), reference_only)?;
    let maximum_bytes = if reference_only {
        MAX_REFERENCE_BYTES
    } else {
        MAX_CONVERSION_INPUT_BYTES
    };
    if resolved.record().size_bytes() > maximum_bytes {
        return Err(CommandError::invalid_input(
            "The speech audio exceeds the safe reference limit.",
        ));
    }
    let descriptor = descriptor_from_record(resolved.record())?;
    let format = match descriptor.format {
        SpeechArtifactFormatResponse::Wav => AudioFormat::Wav,
        SpeechArtifactFormatResponse::Mp3 => AudioFormat::Mp3,
        SpeechArtifactFormatResponse::M4a => AudioFormat::M4a,
    };
    let asset = AudioAsset::from_trusted_native_file(resolved.path(), format)
        .map_err(|error| speech_command_error(&error))?;
    if asset.bytes() != resolved.record().size_bytes() {
        return Err(CommandError::internal(
            "The stored speech audio changed unexpectedly.",
        ));
    }
    Ok(asset)
}

pub(super) fn resolve_alignment_audio(
    database: &Database,
    value: &str,
) -> CommandResult<(
    AudioAsset,
    MediaInput,
    SpeechArtifactDescriptor,
    Option<ProjectId>,
)> {
    let id = parse_artifact_id(value)?;
    let resolved = database
        .resolve_artifact(id)?
        .ok_or_else(|| CommandError::invalid_input("The narration audio is unavailable."))?;
    if !matches!(
        resolved.record().kind().as_str(),
        "narrationOutput" | "voiceConversion"
    ) {
        return Err(CommandError::invalid_input(
            "The artifact is not generated narration audio.",
        ));
    }
    if resolved.record().size_bytes() > MAX_CONVERSION_INPUT_BYTES {
        return Err(CommandError::invalid_input(
            "The narration audio exceeds the safe alignment limit.",
        ));
    }
    let descriptor = descriptor_from_record(resolved.record())?;
    let format = match descriptor.format {
        SpeechArtifactFormatResponse::Wav => AudioFormat::Wav,
        SpeechArtifactFormatResponse::Mp3 => AudioFormat::Mp3,
        SpeechArtifactFormatResponse::M4a => AudioFormat::M4a,
    };
    let asset = AudioAsset::from_trusted_native_file(resolved.path(), format)
        .map_err(|error| speech_command_error(&error))?;
    if asset.bytes() != descriptor.bytes {
        return Err(CommandError::internal(
            "The stored narration audio changed unexpectedly.",
        ));
    }
    let media = MediaInput::from_native_selection(resolved.path())?;
    Ok((asset, media, descriptor, resolved.record().project_id()))
}

pub(super) fn ensure_speech_artifact_kind(kind: &str, reference_only: bool) -> CommandResult<()> {
    let allowed = if reference_only {
        matches!(kind, "speechReference" | "speechPreparedReference")
            || kind.starts_with("speechReference.")
    } else {
        matches!(
            kind,
            "speechReference"
                | "speechPreparedReference"
                | "narrationOutput"
                | "voiceConversion"
                | "alignedNarration"
        ) || kind.starts_with("speechReference.")
    };
    allowed
        .then_some(())
        .ok_or_else(|| CommandError::invalid_input("The artifact is not usable speech audio."))
}

pub(super) fn parse_artifact_id(value: &str) -> CommandResult<ArtifactId> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| CommandError::invalid_input("The speech artifact identifier is invalid."))?;
    ArtifactId::from_uuid(uuid)
        .map_err(|_| CommandError::invalid_input("The speech artifact identifier is invalid."))
}
