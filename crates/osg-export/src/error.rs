//! Typed, path-free failures for the export.
//!
//! Every variant names a category, never a location. Nothing here can transport a filesystem path,
//! an export identifier, a credential or a line of a user's subtitle text, so an export failure is
//! safe to log verbatim. The variants the task list calls out — a missing font, an atlas that
//! cannot support cell-advance layout, an unreadable source and a full volume — are each their own
//! variant rather than one catch-all, because "the export failed" is not something a user can act
//! on.
//!
//! The wrapped errors are the pipeline's own, unchanged: `osg-decode`, `osg-encode`, `osg-audio`,
//! `osg-scene` and `osg-compositor` already document their failures as path-free, so re-describing
//! them here would be a second vocabulary to keep in step.

use osg_audio::AudioError;
use osg_compositor::{CompositorError, Rejection};
use osg_decode::DecodeError;
use osg_encode::EncodeError;
use osg_render::RenderError;
use osg_scene::TimelineError;
use osg_scene::glyph::LayoutRefusal;
use osg_scene::scene::SceneError;

/// `HRESULT_FROM_WIN32(ERROR_DISK_FULL)`.
const HRESULT_DISK_FULL: u32 = 0x8007_0070;
/// `HRESULT_FROM_WIN32(ERROR_HANDLE_DISK_FULL)`.
const HRESULT_HANDLE_DISK_FULL: u32 = 0x8007_0027;
/// `STG_E_MEDIUMFULL`, which the structured-storage layer under the container writer reports.
const STG_E_MEDIUMFULL: u32 = 0x8003_0070;

/// Everything an export can refuse to do.
///
/// Fails closed throughout: there is no variant that means "exported something other than what you
/// asked for", and no path by which a partially written file is reported as a finished export.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ExportError {
    /// The request did not survive validation against the source it names.
    #[error("the render request cannot be exported: {reason}")]
    UnsupportedRequest {
        /// The contract's own refusal.
        reason: RenderError,
    },

    /// The staged face is not the face the request asked for.
    ///
    /// This is the "missing font" failure. The request carries a CSS `font-family` list; the
    /// primary family in it is the only one that can become an identity, and the caller resolves
    /// that identity before staging. When the two disagree — including when the primary family is
    /// generic, empty or unparseable — the export refuses rather than drawing a substitute, which
    /// is the behaviour the migration exists to remove.
    #[error("the resolved font face is not the face the request asked for")]
    FontUnavailable,

    /// The staged atlas was baked from a different face than the scene resolved.
    #[error("the staged glyph atlas was not baked from the scene's resolved face")]
    AtlasFaceMismatch,

    /// The staged atlas cannot be laid out by accumulating per-cell advances.
    ///
    /// Either shaping moved ink across a cluster boundary, so the advances do not sum to the run,
    /// or the run is right-to-left and the cells are in logical rather than visual order. Both
    /// would draw the wrong picture rather than fail, so the atlas's own verdict is honoured here.
    #[error(
        "the staged glyph atlas refuses cell-advance layout (shaping crosses clusters: {}, needs \
         bidi: {})",
        .refusal.shaping_crosses_clusters,
        .refusal.direction_needs_bidi
    )]
    AtlasCannotLayOut {
        /// Why accumulating per-cell advances would be wrong.
        refusal: LayoutRefusal,
    },

    /// The scene contract refused the converted request.
    #[error("the scene was refused: {reason}")]
    SceneRejected {
        /// The scene contract's own refusal.
        reason: SceneError,
    },

    /// The frame grid the request implies is not one the shared timeline supports.
    #[error("the render timeline is not supported: {reason}")]
    TimelineRejected {
        /// The timeline's own refusal.
        reason: TimelineError,
    },

    /// The composition — style, crop, staged runs, adapter or readback — was refused.
    #[error("the composition was refused: {reason}")]
    CompositionRejected {
        /// The compositor's own refusal.
        reason: CompositorError,
    },

    /// The source video could not be read.
    #[error("the source video could not be read: {reason}")]
    SourceUnreadable {
        /// The decoder's own refusal.
        reason: DecodeError,
    },

    /// The audio could not be decoded, mixed or placed on the output timeline.
    #[error("the export audio could not be prepared: {reason}")]
    AudioUnusable {
        /// The audio stage's own refusal.
        reason: AudioError,
    },

    /// The output could not be written.
    #[error("the export output could not be written: {reason}")]
    OutputUnwritable {
        /// The encoder's own refusal.
        reason: EncodeError,
    },

    /// The volume the output is being written to ran out of space.
    ///
    /// Separated from [`Self::OutputUnwritable`] because it is the one write failure a user can
    /// actually do something about, and because reporting it as a platform status code would leave
    /// them reading an `HRESULT`.
    #[error("the export output could not be written because the volume is full")]
    OutputVolumeFull,

    /// The export was cancelled and its partial output has been removed.
    #[error("the export was cancelled")]
    Cancelled,
}

impl ExportError {
    /// Classifies an encoder failure, separating a full volume from every other write failure.
    #[must_use]
    pub fn from_encode(error: EncodeError) -> Self {
        if let EncodeError::MediaFoundation { code, .. } = error
            && matches!(
                code,
                HRESULT_DISK_FULL | HRESULT_HANDLE_DISK_FULL | STG_E_MEDIUMFULL
            )
        {
            return Self::OutputVolumeFull;
        }
        Self::OutputUnwritable { reason: error }
    }
}

impl From<RenderError> for ExportError {
    fn from(reason: RenderError) -> Self {
        Self::UnsupportedRequest { reason }
    }
}

impl From<SceneError> for ExportError {
    fn from(reason: SceneError) -> Self {
        Self::SceneRejected { reason }
    }
}

impl From<TimelineError> for ExportError {
    fn from(reason: TimelineError) -> Self {
        Self::TimelineRejected { reason }
    }
}

impl From<CompositorError> for ExportError {
    /// One place decides which compositor refusals deserve a name of their own.
    ///
    /// `AtlasFaceMismatch` is a font problem rather than a composition problem, so it is lifted out
    /// here. `AtlasLayoutRefused` is caught earlier, where the atlas's own [`LayoutRefusal`] detail
    /// is still available; if it ever reaches this conversion it stays a composition refusal rather
    /// than being reported with an invented reason.
    fn from(error: CompositorError) -> Self {
        match error {
            CompositorError::UnsupportedSceneInput {
                reason: Rejection::AtlasFaceMismatch,
            } => Self::AtlasFaceMismatch,
            other => Self::CompositionRejected { reason: other },
        }
    }
}

impl From<DecodeError> for ExportError {
    fn from(reason: DecodeError) -> Self {
        Self::SourceUnreadable { reason }
    }
}

impl From<AudioError> for ExportError {
    fn from(reason: AudioError) -> Self {
        Self::AudioUnusable { reason }
    }
}

impl From<EncodeError> for ExportError {
    fn from(error: EncodeError) -> Self {
        Self::from_encode(error)
    }
}
