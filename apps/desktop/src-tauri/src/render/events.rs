//! What crosses back to the `WebView`: the status, the phases, the events and the result.
//!
//! Every shape here is frozen by `src/platform/renderService.js`, which validates each one field by
//! field and treats anything else as a protocol error. Nothing may be added, removed or renamed
//! without changing that module too, so the engine underneath these types changed and these types
//! did not.
//!
//! Two of the frozen fields are now vestigial and are documented as such rather than quietly
//! reinterpreted: `remotionVersion`, which the `WebView` still compares against its own constant,
//! and the four extraction and composition phases the managed worker used to report. They are the
//! shape of a transport, not a claim about an engine.

use osg_domain::{AssetId, JobSnapshot, MediaAsset, ProjectId};
use osg_media_server::RegisteredMedia;
use osg_render::RenderPhase;
use serde::Serialize;

use crate::error::CommandError;

use super::manifest::RenderManifestResult;

/// What `render_runtime_status` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderRuntimeStatusResponse {
    pub(super) available: bool,
    /// Vestigial, and kept only because the `WebView` compares it against its own frozen constant.
    ///
    /// It names no engine any more: nothing `render_start` does reaches Remotion. Removing the
    /// field is a frontend change, and this wave does not make frontend changes.
    pub(super) remotion_version: &'static str,
    pub(super) reason: Option<&'static str>,
    pub(super) max_concurrent_renders: usize,
}

/// Which part of a render a progress event describes.
///
/// The vocabulary is the `WebView`'s, which orders these and refuses an event that moves backwards
/// through them. The native export reports a subset — [`Self::Staging`], then
/// [`Self::RenderingFrames`] while frames are composed and encoded, then [`Self::Muxing`] while the
/// container is closed, then [`Self::Publishing`] — and skipping the rest is allowed, because the
/// order the `WebView` enforces is non-decreasing rather than exhaustive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RenderPhaseResponse {
    Staging,
    ExtractingFrames,
    ExtractingAudio,
    LoadingComposition,
    RenderingFrames,
    Encoding,
    Muxing,
    Publishing,
}

impl RenderPhaseResponse {
    /// The `WebView`'s own order, which it refuses to see an event move backwards through.
    ///
    /// Declared here rather than assumed, so the one place that emits progress can enforce it
    /// instead of relying on every producer to emit phases in the right order.
    pub(super) const fn rank(self) -> u8 {
        match self {
            Self::Staging => 0,
            Self::ExtractingFrames => 1,
            Self::ExtractingAudio => 2,
            Self::LoadingComposition => 3,
            Self::RenderingFrames => 4,
            Self::Encoding => 5,
            Self::Muxing => 6,
            Self::Publishing => 7,
        }
    }

    pub(super) const fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::ExtractingFrames => "extractingFrames",
            Self::ExtractingAudio => "extractingAudio",
            Self::LoadingComposition => "loadingComposition",
            Self::RenderingFrames => "renderingFrames",
            Self::Encoding => "encoding",
            Self::Muxing => "muxing",
            Self::Publishing => "publishing",
        }
    }
}

impl From<RenderPhase> for RenderPhaseResponse {
    /// The managed worker's phases, mapped.
    ///
    /// Nothing produces a [`RenderPhase`] on the export path any more. The mapping is kept because
    /// it is the definition of what the four extraction and composition phases in the `WebView`'s
    /// frozen vocabulary meant, and deleting the worker is a separate, later step.
    fn from(value: RenderPhase) -> Self {
        match value {
            RenderPhase::Staging => Self::Staging,
            RenderPhase::ExtractingFrames => Self::ExtractingFrames,
            RenderPhase::ExtractingAudio => Self::ExtractingAudio,
            RenderPhase::LoadingComposition => Self::LoadingComposition,
            RenderPhase::RenderingFrames => Self::RenderingFrames,
            RenderPhase::Encoding => Self::Encoding,
            RenderPhase::Muxing => Self::Muxing,
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
