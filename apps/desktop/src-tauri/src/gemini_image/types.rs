//! Generated-image runtime state, request DTOs and progress events.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use osg_domain::{AssetId, JobId, JobSnapshot, ProjectId};
use osg_gemini::ImageModel;
use osg_infrastructure::secrets::{CredentialId, CredentialService};
use osg_infrastructure::storage::{ArtifactId, Database};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::format::generated_image_storage_error;
use super::generation::PublishedGeneratedImage;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopCredentialBackend;

#[derive(Debug)]
pub(super) struct ProjectPlaybacks {
    pub(super) project_id: ProjectId,
    pub(super) playback_ids: BTreeSet<Uuid>,
}

#[derive(Debug, Clone)]
pub(super) struct PendingGeneratedImage {
    pub(super) published: PublishedGeneratedImage,
    pub(super) expected_job_sequence: u64,
}

#[derive(Debug, Clone)]
pub(super) struct CompletedGeneratedImage {
    pub(super) published: PublishedGeneratedImage,
    pub(super) job: JobSnapshot,
}

#[derive(Debug, Default)]
pub(super) struct GeneratedImageRegistry {
    pub(super) by_artifact: BTreeMap<ArtifactId, ProjectPlaybacks>,
    pub(super) pending_by_job: BTreeMap<JobId, PendingGeneratedImage>,
    pub(super) completed_by_job: BTreeMap<JobId, CompletedGeneratedImage>,
}

#[derive(Clone, Default)]
pub(crate) struct GeneratedImageRuntime(pub(super) Arc<Mutex<GeneratedImageRegistry>>);

impl fmt::Debug for GeneratedImageRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let artifact_count = self
            .0
            .lock()
            .map_or(0, |registry| registry.by_artifact.len());
        formatter
            .debug_struct("GeneratedImageRuntime")
            .field("artifact_count", &artifact_count)
            .finish_non_exhaustive()
    }
}

impl GeneratedImageRuntime {
    pub(super) fn access<T>(
        &self,
        operation: impl FnOnce(&mut GeneratedImageRegistry) -> CommandResult<T>,
    ) -> CommandResult<T> {
        let mut registry = self.0.lock().map_err(|_| generated_image_storage_error())?;
        operation(&mut registry)
    }
}

#[derive(Clone)]
pub(super) struct GeneratedImageServices {
    pub(super) credentials: CredentialService<DesktopCredentialBackend>,
    pub(super) database: Database,
    pub(super) media_server: MediaServer,
    pub(super) runtime: GeneratedImageRuntime,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "the prompt is private user content"
)]
pub(crate) struct GeminiImageStartRequest {
    pub(super) credential_id: CredentialId,
    pub(super) model: ImageModel,
    pub(super) prompt: String,
    pub(super) reference_asset_id: AssetId,
    pub(super) project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageDescriptor {
    pub(super) artifact_id: ArtifactId,
    pub(super) project_id: ProjectId,
    pub(super) mime_type: &'static str,
    pub(super) size_bytes: u64,
    pub(super) created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayableGeneratedImage {
    pub(super) artifact: GeneratedImageDescriptor,
    pub(super) playback: RegisteredMedia,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GeminiImageEvent {
    Prepared {
        job: JobSnapshot,
        image: PlayableGeneratedImage,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_field_names,
    reason = "the explicit ID suffixes are part of the audited cross-boundary request schema"
)]
pub(crate) struct GeminiImageCompleteRequest {
    pub(super) job_id: JobId,
    pub(super) project_id: ProjectId,
    pub(super) artifact_id: String,
    pub(super) playback_id: Uuid,
}

impl fmt::Debug for GeminiImageCompleteRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiImageCompleteRequest")
            .field("job_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .field("playback_id", &"<opaque>")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedImageProjectRequest {
    pub(super) project_id: ProjectId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedImageArtifactRequest {
    pub(super) project_id: ProjectId,
    pub(super) artifact_id: String,
}

impl fmt::Debug for GeneratedImageArtifactRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImageArtifactRequest")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedImageExportRequest {
    pub(super) project_id: ProjectId,
    pub(super) artifact_id: String,
    pub(super) suggested_name: String,
}

impl fmt::Debug for GeneratedImageExportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImageExportRequest")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .field("suggested_name", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_field_names,
    reason = "the explicit ID suffixes are part of the audited cross-boundary request schema"
)]
pub(crate) struct GeneratedImagePlaybackReleaseRequest {
    pub(super) project_id: ProjectId,
    pub(super) artifact_id: String,
    pub(super) playback_id: Uuid,
}

impl fmt::Debug for GeneratedImagePlaybackReleaseRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImagePlaybackReleaseRequest")
            .field("project_id", &"<opaque>")
            .field("artifact_id", &"<opaque>")
            .field("playback_id", &"<opaque>")
            .finish()
    }
}
