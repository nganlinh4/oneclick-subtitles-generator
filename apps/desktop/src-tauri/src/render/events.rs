//! What crosses back to the `WebView`: the status, the phases, the events and the result.
//!
//! Every shape here is frozen by `src/platform/renderService.js`, which validates each one field by
//! field and treats anything else as a protocol error. Nothing may be added or renamed without
//! changing that module too, so the engine underneath these types changed and these types did not.
//!
//! What did go is what only the deleted worker ever produced: the vestigial engine-version field on
//! the status, which the `WebView` already accepts a response without, and the four extraction and
//! composition phases nothing emits any more. The `WebView` still recognizes those phase names, so
//! reporting a subset of its vocabulary is what it was written to accept.

use osg_domain::{AssetId, JobSnapshot, MediaAsset, ProjectId};
use osg_media_server::RegisteredMedia;
use serde::Serialize;

use crate::error::CommandError;

use super::manifest::RenderManifestResult;

/// What `render_runtime_status` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderRuntimeStatusResponse {
    pub(super) available: bool,
    pub(super) reason: Option<&'static str>,
    pub(super) max_concurrent_renders: usize,
}

/// Which part of a render a progress event describes.
///
/// The vocabulary is the `WebView`'s, which orders these and refuses an event that moves backwards
/// through them. The native export reports the four it can reach — [`Self::Staging`], then
/// [`Self::RenderingFrames`] while frames are composed and encoded, then [`Self::Muxing`] while the
/// container is closed, then [`Self::Publishing`]. The `WebView` recognizes four more that only the
/// deleted worker ever emitted; reporting a subset is allowed, because the order it enforces is
/// non-decreasing rather than exhaustive, and naming a phase nothing can produce would be a claim
/// about an engine that no longer exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RenderPhaseResponse {
    Staging,
    RenderingFrames,
    Muxing,
    Publishing,
}

impl RenderPhaseResponse {
    /// The `WebView`'s own order, which it refuses to see an event move backwards through.
    ///
    /// Declared here rather than assumed, so the one place that emits progress can enforce it
    /// instead of relying on every producer to emit phases in the right order. The ranks are dense
    /// rather than positions in the `WebView`'s longer list, because only their order is compared.
    pub(super) const fn rank(self) -> u8 {
        match self {
            Self::Staging => 0,
            Self::RenderingFrames => 1,
            Self::Muxing => 2,
            Self::Publishing => 3,
        }
    }

    pub(super) const fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::RenderingFrames => "renderingFrames",
            Self::Muxing => "muxing",
            Self::Publishing => "publishing",
        }
    }
}

/// A finished render, with a playback capability the `WebView` may load.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderCompletedResult {
    artifact_id: String,
    asset: MediaAsset,
    source_asset_id: AssetId,
    project_id: ProjectId,
    width: u32,
    height: u32,
    fps: u16,
    duration_in_frames: u32,
    playback: RegisteredMedia,
}

impl RenderCompletedResult {
    pub(super) fn new(manifest: RenderManifestResult, playback: RegisteredMedia) -> Self {
        Self {
            artifact_id: manifest.artifact_id,
            asset: manifest.asset,
            source_asset_id: manifest.source_asset_id,
            project_id: manifest.project_id,
            width: manifest.width,
            height: manifest.height,
            fps: manifest.fps,
            duration_in_frames: manifest.duration_in_frames,
            playback,
        }
    }
}

/// What `render_result` answers: the job, and its result once there is one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderResultResponse {
    pub(super) job: JobSnapshot,
    pub(super) result: Option<RenderCompletedResult>,
}

/// One event on a render's channel.
#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum RenderEvent {
    Progress {
        job: JobSnapshot,
        phase: RenderPhaseResponse,
        fraction_millionths: u32,
        rendered_frames: u32,
        encoded_frames: u32,
        duration_in_frames: u32,
    },
    Completed {
        job: JobSnapshot,
        result: RenderCompletedResult,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}
