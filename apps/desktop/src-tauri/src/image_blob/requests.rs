//! Image reference request and descriptor DTOs with redacted debug output.

use std::fmt;

use osg_domain::{AssetId, ProjectId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageBlobDescriptor {
    pub(super) asset_id: AssetId,
    pub(super) mime_type: &'static str,
    pub(super) size_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageBlobPlaybackImportRequest {
    pub(super) playback_id: Uuid,
    pub(super) project_id: ProjectId,
}

impl fmt::Debug for ImageBlobPlaybackImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageBlobPlaybackImportRequest")
            .field("playback_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageReferenceSelectRequest {
    pub(super) project_id: ProjectId,
}

impl fmt::Debug for ImageReferenceSelectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageReferenceSelectRequest")
            .field("project_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImagePlaybackReleaseRequest {
    pub(super) playback_id: Uuid,
    pub(super) project_id: ProjectId,
}

impl fmt::Debug for ImagePlaybackReleaseRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImagePlaybackReleaseRequest")
            .field("playback_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageReferenceExportRequest {
    pub(super) project_id: ProjectId,
    pub(super) playback_id: Uuid,
    pub(super) suggested_name: String,
}

impl fmt::Debug for ImageReferenceExportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageReferenceExportRequest")
            .field("project_id", &"<opaque>")
            .field("playback_id", &"<opaque>")
            .field("suggested_name", &"<redacted>")
            .finish()
    }
}
