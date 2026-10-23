mod contracts;
mod lifecycle;
mod ownership;
mod rollback;

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use osg_application::JobRegistry;
use osg_domain::{JobId, JobUpdate, ProjectId};
use osg_domain::{JobKind, JobSnapshot, JobState, ProjectMetadata};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactRegistration, ArtifactState,
    ContentHash, Database, ResolvedArtifact,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde_json::json;
use uuid::Uuid;

use super::commands::{list_generated_images, resolve_owned_image};
use super::completion::{
    finalize_pending_completion_parts, invalidate_pending_completion_parts,
    recover_completed_image, rollback_published_image,
};
use super::format::{
    artifact_kind, descriptor_from_record, is_safe_export_name, prepare_image_export,
    validate_generated_image,
};
use super::generation::{
    PreparedGeneratedArtifact, PublishedGeneratedImage, fail_pending_completion_parts,
};
use super::publication::{
    clear_generated_images, delete_generated_image, publish_and_register_image,
    publish_generated_image, register_playable_image_record, release_generated_image_playback,
    write_staged_image,
};
use super::types::{
    GeminiImageEvent, GeminiImageStartRequest, GeneratedImageDescriptor,
    GeneratedImageExportRequest, GeneratedImageRegistry, GeneratedImageRuntime,
    PendingGeneratedImage, PlayableGeneratedImage,
};
use super::*;
use crate::background;
use crate::error::CommandResult;

fn png(label: &[u8]) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(label);
    bytes
}

fn fixture() -> (tempfile::TempDir, PathBuf, Database, ProjectId, JobId) {
    let directory = tempfile::tempdir().expect("temporary data");
    let database_path = directory.path().join("db/osg.sqlite3");
    let database = Database::open(&database_path).expect("database");
    let project = ProjectMetadata::new("image project").expect("project");
    let project_id = project.id();
    database.create_project(&project).expect("create project");
    let mut job = JobSnapshot::new(JobKind::GenerateImage);
    job.start().expect("running job");
    let job_id = job.id();
    database
        .create_job(&JobSnapshot::with_id(job_id, JobKind::GenerateImage))
        .expect("job");
    (directory, database_path, database, project_id, job_id)
}

fn succeed_job(database: &Database, job_id: JobId) -> JobSnapshot {
    let registry = JobRegistry::restore(Arc::new(database.clone())).expect("job registry");
    let current = registry.get(job_id).expect("job lookup");
    let running = match current.snapshot().state() {
        JobState::Queued => registry.apply(job_id, JobUpdate::Start).expect("start job"),
        JobState::Running => current,
        JobState::Succeeded => return current.snapshot().clone(),
        state => panic!("job cannot succeed from {state:?}"),
    };
    registry
        .apply_if_sequence(job_id, running.snapshot().sequence(), JobUpdate::Succeed)
        .expect("succeed job")
        .snapshot()
        .clone()
}

fn commit_prepared(database: &Database, prepared: &PreparedGeneratedArtifact) -> ResolvedArtifact {
    database
        .mark_artifact_ready(prepared.record().id())
        .expect("commit artifact");
    database
        .resolve_artifact(prepared.record().id())
        .expect("resolve committed artifact")
        .expect("committed artifact")
}

fn stage_pending_image(
    database: &Database,
    media_server: &MediaServer,
    runtime: &GeneratedImageRuntime,
    project_id: ProjectId,
    job_id: JobId,
    expected_job_sequence: u64,
    bytes: &[u8],
) -> PublishedGeneratedImage {
    runtime
        .access(|registry| {
            let published = publish_and_register_image(
                database,
                media_server,
                registry,
                project_id,
                job_id,
                "image/png",
                bytes,
            )?;
            registry.pending_by_job.insert(
                job_id,
                PendingGeneratedImage {
                    published: published.clone(),
                    expected_job_sequence,
                },
            );
            Ok(published)
        })
        .expect("stage pending image")
}

fn register_playable_image(
    media_server: &MediaServer,
    registry: &mut GeneratedImageRegistry,
    resolved: &ResolvedArtifact,
) -> CommandResult<PlayableGeneratedImage> {
    register_playable_image_record(
        media_server,
        registry,
        resolved.record(),
        resolved.path(),
        false,
    )
}
