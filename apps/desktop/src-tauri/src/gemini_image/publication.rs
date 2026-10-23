//! Generated-image publication, playback registration and removal.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, BufReader, Write};
use std::path::Path;

use osg_domain::{JobId, JobState, ProjectId};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRecord,
    ArtifactRegistration, ArtifactRetention, ArtifactState, ContentHash, Database,
};
use osg_media_server::MediaServer;
use uuid::Uuid;

use super::commands::{
    ensure_project_accepts_generated_image, ensure_project_exists, pending_new_image_count,
    resolve_owned_image,
};
use super::format::{
    artifact_kind, descriptor_from_prepared_record, descriptor_from_record,
    generated_image_in_progress, generated_image_ownership_error, generated_image_storage_error,
    validate_generated_image,
};
use super::generation::{PreparedGeneratedArtifact, PublishedGeneratedImage};
use super::types::{GeneratedImageRegistry, PlayableGeneratedImage, ProjectPlaybacks};
use super::{COMMIT_ON_JOB_SUCCESS_METADATA_KEY, MAX_GENERATED_IMAGE_BYTES, MAX_PROJECT_IMAGES};
use crate::error::CommandResult;

pub(super) fn publish_and_register_image(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
    job_id: JobId,
    mime_type: &'static str,
    bytes: &[u8],
) -> CommandResult<PublishedGeneratedImage> {
    let provisional_count = pending_new_image_count(registry, project_id);
    let (prepared, newly_created) = publish_generated_image_with_pending_count(
        database,
        project_id,
        job_id,
        mime_type,
        bytes,
        provisional_count,
        write_staged_image,
    )?;
    let artifact_id = prepared.record().id();
    match register_playable_image_record(
        media_server,
        registry,
        prepared.record(),
        prepared.path(),
        newly_created,
    ) {
        Ok(image) => Ok(PublishedGeneratedImage {
            image,
            newly_created,
        }),
        Err(error) => {
            if newly_created {
                rollback_artifact(database, artifact_id)?;
            }
            Err(error)
        }
    }
}

#[cfg(test)]
pub(super) fn publish_generated_image(
    database: &Database,
    project_id: ProjectId,
    job_id: JobId,
    mime_type: &'static str,
    bytes: &[u8],
    writer: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> CommandResult<(PreparedGeneratedArtifact, bool)> {
    publish_generated_image_with_pending_count(
        database, project_id, job_id, mime_type, bytes, 0, writer,
    )
}

#[allow(
    clippy::too_many_lines,
    reason = "the provisional publication transaction keeps validation, dedup ownership, and rollback adjacent"
)]
fn publish_generated_image_with_pending_count(
    database: &Database,
    project_id: ProjectId,
    job_id: JobId,
    mime_type: &'static str,
    bytes: &[u8],
    provisional_count: usize,
    writer: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> CommandResult<(PreparedGeneratedArtifact, bool)> {
    validate_generated_image(mime_type, bytes)?;
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let content_hash = ContentHash::digest(bytes);
    let size_bytes = u64::try_from(bytes.len()).map_err(|_| generated_image_storage_error())?;
    let draft = ArtifactDraft::new(
        kind.clone(),
        content_hash,
        size_bytes,
        serde_json::json!({
            "mimeType": mime_type,
            COMMIT_ON_JOB_SUCCESS_METADATA_KEY: true,
        }),
    )?
    .with_project(project_id)
    .with_job(job_id);

    for attempt in 0..2 {
        let registration = match database.register_artifact(&draft)? {
            ArtifactRegistration::Pending(record) => ArtifactRegistration::Existing(record),
            registration => registration,
        };
        match registration {
            ArtifactRegistration::Existing(record) => {
                if !is_owned_generated_image_record(
                    &record,
                    project_id,
                    &kind,
                    content_hash,
                    size_bytes,
                ) {
                    return Err(generated_image_ownership_error());
                }
                match record.state() {
                    ArtifactState::Ready => {
                        descriptor_from_record(&record, project_id)?;
                        let resolved = database
                            .resolve_artifact(record.id())?
                            .ok_or_else(generated_image_storage_error)?;
                        return Ok((
                            PreparedGeneratedArtifact {
                                record: resolved.record().clone(),
                                path: resolved.path().to_path_buf(),
                            },
                            false,
                        ));
                    }
                    ArtifactState::Pending => {
                        descriptor_from_prepared_record(&record, project_id)?;
                        let owner = record.job_id().ok_or_else(generated_image_storage_error)?;
                        let owner_job = database.get_job(owner)?;
                        if owner_job
                            .as_ref()
                            .is_some_and(|job| job.state() == JobState::Succeeded)
                        {
                            let ready = database
                                .mark_artifact_ready(record.id())
                                .map_err(|_| generated_image_storage_error())?;
                            descriptor_from_record(&ready, project_id)?;
                            let resolved = database
                                .resolve_artifact(record.id())?
                                .ok_or_else(generated_image_storage_error)?;
                            return Ok((
                                PreparedGeneratedArtifact {
                                    record: resolved.record().clone(),
                                    path: resolved.path().to_path_buf(),
                                },
                                false,
                            ));
                        }
                        let owner_terminal = owner_job
                            .as_ref()
                            .is_none_or(|job| job.state().is_terminal());
                        if owner_terminal && attempt == 0 {
                            let _ = database.remove_artifact(record.id())?;
                            continue;
                        }
                        return Err(generated_image_in_progress());
                    }
                    // Storage recycles a failed row into a fresh staging reservation, so
                    // a registration that reports an existing record is never failed.
                    ArtifactState::Failed => return Err(generated_image_storage_error()),
                }
            }
            ArtifactRegistration::Staging(staging) => {
                let artifact_id = staging.record().id();
                if let Err(error) =
                    ensure_project_accepts_generated_image(database, project_id, provisional_count)
                {
                    rollback_artifact(database, artifact_id)?;
                    return Err(error);
                }
                let publication = finish_generated_image_preparation(
                    staging.record(),
                    staging.path(),
                    project_id,
                    bytes,
                    writer,
                );
                if let Ok(prepared) = publication {
                    return Ok((prepared, true));
                }
                rollback_artifact(database, artifact_id)?;
                return Err(generated_image_storage_error());
            }
            ArtifactRegistration::Pending(_) => {
                unreachable!("pending registrations are normalized above")
            }
        }
    }
    Err(generated_image_storage_error())
}

fn is_owned_generated_image_record(
    record: &ArtifactRecord,
    project_id: ProjectId,
    kind: &ArtifactKind,
    content_hash: ContentHash,
    size_bytes: u64,
) -> bool {
    record.project_id() == Some(project_id)
        && record.kind() == kind
        && record.content_hash() == content_hash
        && record.size_bytes() == size_bytes
        && record.retention() == ArtifactRetention::Durable
}

fn finish_generated_image_preparation(
    record: &ArtifactRecord,
    staging_path: &Path,
    project_id: ProjectId,
    bytes: &[u8],
    writer: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> CommandResult<PreparedGeneratedArtifact> {
    writer(staging_path, bytes).map_err(|_| generated_image_storage_error())?;
    validate_prepared_image_file(staging_path, record)?;
    descriptor_from_prepared_record(record, project_id)?;
    Ok(PreparedGeneratedArtifact {
        record: record.clone(),
        path: staging_path.to_path_buf(),
    })
}

fn validate_prepared_image_file(path: &Path, record: &ArtifactRecord) -> CommandResult<()> {
    let file = fs::File::open(path).map_err(|_| generated_image_storage_error())?;
    let metadata = file
        .metadata()
        .map_err(|_| generated_image_storage_error())?;
    if metadata.len() != record.size_bytes()
        || ContentHash::digest_reader(BufReader::new(file))
            .map_err(|_| generated_image_storage_error())?
            != record.content_hash()
    {
        return Err(generated_image_storage_error());
    }
    Ok(())
}

pub(super) fn write_staged_image(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut target = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)?;
    target.write_all(bytes)?;
    target.flush()?;
    target.sync_all()
}

pub(super) fn rollback_artifact(database: &Database, artifact_id: ArtifactId) -> CommandResult<()> {
    if let Some(record) = database.get_artifact(artifact_id)? {
        if record.state() == ArtifactState::Pending
            && let Ok(code) = ArtifactFailureCode::new("generatedImagePublish")
        {
            database.mark_artifact_failed(artifact_id, &code)?;
        }
        let _ = database.remove_artifact(artifact_id)?;
    }
    Ok(())
}

pub(super) fn register_playable_image_record(
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    record: &ArtifactRecord,
    path: &Path,
    allow_pending: bool,
) -> CommandResult<PlayableGeneratedImage> {
    let project_id = record
        .project_id()
        .ok_or_else(generated_image_storage_error)?;
    let artifact = if allow_pending {
        descriptor_from_prepared_record(record, project_id)?
    } else {
        descriptor_from_record(record, project_id)?
    };
    let playback = media_server.register_owned_image_file(
        path,
        artifact.mime_type,
        project_id.into_uuid(),
        MAX_GENERATED_IMAGE_BYTES,
    )?;
    if playback.byte_length != artifact.size_bytes || playback.mime_type != artifact.mime_type {
        let _ = media_server.unregister_owned_image(playback.id, project_id.into_uuid());
        return Err(generated_image_storage_error());
    }
    let entry = registry
        .by_artifact
        .entry(artifact.artifact_id)
        .or_insert_with(|| ProjectPlaybacks {
            project_id,
            playback_ids: BTreeSet::new(),
        });
    if entry.project_id != project_id {
        let _ = media_server.unregister_owned_image(playback.id, project_id.into_uuid());
        return Err(generated_image_ownership_error());
    }
    entry.playback_ids.insert(playback.id);
    Ok(PlayableGeneratedImage { artifact, playback })
}

fn release_artifact_playbacks(
    registry: &mut GeneratedImageRegistry,
    media_server: &MediaServer,
    artifact_id: ArtifactId,
) -> CommandResult<()> {
    let Some(entry) = registry.by_artifact.get(&artifact_id) else {
        return Ok(());
    };
    for playback_id in &entry.playback_ids {
        let _ = media_server.unregister_owned_image(*playback_id, entry.project_id.into_uuid())?;
    }
    registry.by_artifact.remove(&artifact_id);
    Ok(())
}

pub(super) fn release_generated_image_playback(
    registry: &mut GeneratedImageRegistry,
    media_server: &MediaServer,
    project_id: ProjectId,
    artifact_id: ArtifactId,
    playback_id: Uuid,
) -> CommandResult<bool> {
    let Some(entry) = registry.by_artifact.get_mut(&artifact_id) else {
        return Ok(false);
    };
    if entry.project_id != project_id {
        return Err(generated_image_ownership_error());
    }
    if !entry.playback_ids.contains(&playback_id) {
        return Ok(false);
    }
    let released = media_server.unregister_owned_image(playback_id, project_id.into_uuid())?;
    entry.playback_ids.remove(&playback_id);
    if entry.playback_ids.is_empty() {
        registry.by_artifact.remove(&artifact_id);
    }
    Ok(released)
}

pub(super) fn delete_generated_image(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
    artifact_id: ArtifactId,
) -> CommandResult<bool> {
    let Some(resolved) = resolve_owned_image(database, project_id, artifact_id)? else {
        return Ok(false);
    };
    drop(resolved);
    release_artifact_playbacks(registry, media_server, artifact_id)?;
    database
        .remove_artifact(artifact_id)
        .map(|record| record.is_some())
        .map_err(Into::into)
}

pub(super) fn clear_generated_images(
    database: &Database,
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    project_id: ProjectId,
) -> CommandResult<u64> {
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let records = database.list_ready_artifacts(project_id, &kind, MAX_PROJECT_IMAGES)?;
    let mut removed = 0_u64;
    for record in records {
        descriptor_from_record(&record, project_id)?;
        release_artifact_playbacks(registry, media_server, record.id())?;
        if database.remove_artifact(record.id())?.is_some() {
            removed = removed.saturating_add(1);
        }
    }
    Ok(removed)
}
