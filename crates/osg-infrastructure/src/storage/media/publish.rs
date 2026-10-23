//! Durable media publication: snapshot the source, register a content-addressed artifact, and
//! remember the opaque media identity.

use std::io::{Seek, SeekFrom};
use std::path::Path;

use osg_domain::{JobId, MediaAsset};
use serde_json::Value;

use super::files::{MediaSourceSnapshot, snapshot_media_file};
use super::{
    COMMIT_ON_JOB_SUCCESS_METADATA_KEY, MEDIA_ARTIFACT_METADATA_KEY, MEDIA_PUBLICATION_LOCK,
    NATIVE_MEDIA_SNAPSHOT_KIND, PublishedMedia, media_provenance_matches_asset,
};
use crate::storage::artifacts::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
};
use crate::storage::{Database, DatabaseError};

/// Publishes a verified media file into durable content-addressed storage and
/// remembers its independent opaque media identity. The final artifact path is
/// intentionally extensionless; playback must use the asset's trusted MIME or
/// extension metadata rather than re-inspecting that path.
pub fn publish_durable_media(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
) -> Result<PublishedMedia, DatabaseError> {
    publish_media(database, job_id, kind, asset, source_path, metadata, false)
}

/// Publishes media bytes durably while keeping the new media identity in the explicit candidate
/// lifecycle. Candidate media can be discarded only while it is still detached from every
/// project, or promoted after a project commit makes the reference durable.
pub fn publish_durable_media_candidate(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
) -> Result<PublishedMedia, DatabaseError> {
    publish_media(database, job_id, kind, asset, source_path, metadata, true)
}

#[allow(
    clippy::too_many_arguments,
    reason = "durable publication keeps its immutable artifact and media identity inputs explicit"
)]
fn publish_media(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
    candidate: bool,
) -> Result<PublishedMedia, DatabaseError> {
    let snapshot = snapshot_media_file(source_path, asset.size_bytes())?;
    publish_media_snapshot(
        database,
        Some(job_id),
        kind,
        asset,
        snapshot,
        metadata,
        candidate,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the snapshot publication boundary keeps identity, lifecycle, and optional job claim explicit"
)]
fn publish_media_snapshot(
    database: &Database,
    job_id: Option<JobId>,
    kind: ArtifactKind,
    asset: MediaAsset,
    mut snapshot: MediaSourceSnapshot,
    metadata: Value,
    candidate: bool,
) -> Result<PublishedMedia, DatabaseError> {
    let content_hash = snapshot.content_hash;
    let Value::Object(mut metadata) = metadata else {
        return Err(DatabaseError::InvalidArtifactMetadata);
    };
    metadata.insert(MEDIA_ARTIFACT_METADATA_KEY.to_owned(), Value::Bool(true));
    if candidate && job_id.is_some() {
        metadata.insert(
            COMMIT_ON_JOB_SUCCESS_METADATA_KEY.to_owned(),
            Value::Bool(true),
        );
    }
    let metadata = Value::Object(metadata);
    if !media_provenance_matches_asset(&kind, &metadata, &asset) {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    let mut draft = ArtifactDraft::new(kind, content_hash, asset.size_bytes(), metadata)?;
    if let Some(job_id) = job_id {
        draft = draft.with_job(job_id);
    }
    // The database actor owns the durable reservation, while the potentially large filesystem
    // copy happens on the caller.  A process-wide publication lock bridges that gap.  Together
    // with the database writer lease it guarantees that exactly one publisher owns a pending
    // kind/content tuple until it reaches ready or failed.
    let _publication_guard = MEDIA_PUBLICATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = if let Some(job_id) = job_id {
        database.register_media_artifact(&draft, asset.id(), job_id)?
    } else {
        database.register_artifact(&draft)?
    };
    let (artifact_id, staged) = match &registration {
        ArtifactRegistration::Existing(record) | ArtifactRegistration::Pending(record) => {
            (record.id(), false)
        }
        ArtifactRegistration::Staging(staging) => (staging.record().id(), true),
    };
    match registration {
        ArtifactRegistration::Existing(_) => {}
        ArtifactRegistration::Pending(record) => {
            return Err(DatabaseError::ArtifactPublicationInProgress(record.id()));
        }
        ArtifactRegistration::Staging(staging) => {
            let publication = (|| -> std::io::Result<()> {
                let mut target = std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(staging.path())?;
                snapshot.file.seek(SeekFrom::Start(0))?;
                let copied = std::io::copy(&mut snapshot.file, &mut target)?;
                if copied != asset.size_bytes() {
                    return Err(std::io::Error::other("media artifact size changed"));
                }
                target.sync_all()
            })();
            if let Err(error) = publication {
                fail_publication(database, artifact_id);
                return Err(error.into());
            }
        }
    }
    let committed = if let Some(job_id) = job_id {
        database.commit_media_artifact(&asset, artifact_id, job_id, candidate)
    } else {
        database.commit_unclaimed_media_artifact(&asset, artifact_id, candidate)
    };
    let resolved = match committed {
        Ok(resolved) => resolved,
        Err(error) => {
            if staged {
                fail_publication(database, artifact_id);
            }
            return Err(error);
        }
    };
    if resolved.record().content_hash() != content_hash {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    Ok(PublishedMedia {
        asset,
        artifact_id,
        content_hash,
        path: resolved.path().to_owned(),
    })
}

pub(in crate::storage) fn publish_native_media_snapshot(
    database: &Database,
    asset: MediaAsset,
    source_path: &Path,
    candidate: bool,
) -> Result<PublishedMedia, DatabaseError> {
    let snapshot = snapshot_media_file(source_path, asset.size_bytes())?;
    publish_media_snapshot(
        database,
        None,
        ArtifactKind::new(NATIVE_MEDIA_SNAPSHOT_KIND)?,
        asset,
        snapshot,
        serde_json::json!({ "source": "nativeSnapshot" }),
        candidate,
    )
}

fn fail_publication(database: &Database, artifact_id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("mediaPublish") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}
