//! Why one preview frame was refused.
//!
//! The cases are separated by what the editor has to *say*, not by where in the pipeline they
//! arose. An unavailable font, an atlas that cannot be laid out from cell advances, a scene the
//! compositor will not draw, a result that arrived after the thing it described changed, and a lost
//! graphics device all need different words in front of a user, so each is its own variant.
//!
//! Every variant is value-free. No filesystem path, no credential, no font family the user typed,
//! no line of subtitle text and no adapter-reported string ever reaches this vocabulary, so a
//! refusal is safe to surface verbatim and safe to log.

use std::fmt;

use osg_compositor::CompositorError;
use osg_export::ExportError;
use osg_render::RenderError;
use osg_scene::glyph::LayoutRefusal;
use serde::{Serialize, Serializer, ser::SerializeStruct};

/// Everything the preview boundary can refuse to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreviewRefusal {
    /// The request is not one this build reads, or its bounds do not hold.
    UnsupportedRequest,
    /// The media the request names is not available to render against.
    MediaUnavailable,
    /// The source could not be read at the frame the timeline names.
    SourceUnreadable,
    /// The face the request resolved is not the face its `fontFamily` asks for.
    ///
    /// The migration exists to stop a substitute being drawn in silence, so this is a refusal
    /// rather than a fallback.
    FontUnavailable,
    /// No staged atlas answers to that identifier, or it is not the one the caller staged.
    AtlasUnknown,
    /// The staged atlas refuses layout from per-cell advances.
    ///
    /// Either shaping moved ink across a cluster boundary or the run is right-to-left with cells in
    /// logical order. Both would draw the wrong picture rather than fail, so the two reasons are
    /// carried separately: they are different things to tell a user.
    AtlasCannotLayOut {
        /// Shaping crossed a cluster boundary, so the advances do not sum to the run.
        shaping_crosses_clusters: bool,
        /// The run needs a bidi reorder this atlas did not perform.
        direction_needs_bidi: bool,
    },
    /// The scene, style, crop or staged runs are not something the compositor will draw.
    SceneRejected,
    /// The frame was rendered for a project, media, scene revision or generation that has moved on.
    StaleGeneration,
    /// No usable graphics device: none could be acquired, or the one in use was lost.
    DeviceLost,
    /// Too many renders are already running.
    Busy,
    /// The composed frame could not be published as an element-loadable capability.
    FrameUnpublishable,
    /// The preview registry is unavailable.
    Unavailable,
}

impl PreviewRefusal {
    /// The stable code the `WebView` switches on.
    ///
    /// Shaped to the `^[A-Za-z][A-Za-z0-9]{0,127}$` pattern `nativePreviewFrames.js` will accept, so
    /// a refusal survives the bridge as a code rather than being flattened into a generic rejection.
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::UnsupportedRequest => "previewUnsupportedRequest",
            Self::MediaUnavailable => "previewMediaUnavailable",
            Self::SourceUnreadable => "previewSourceUnreadable",
            Self::FontUnavailable => "previewFontUnavailable",
            Self::AtlasUnknown => "previewAtlasUnknown",
            Self::AtlasCannotLayOut { .. } => "previewAtlasCannotLayOut",
            Self::SceneRejected => "previewSceneRejected",
            Self::StaleGeneration => "previewStaleGeneration",
            Self::DeviceLost => "previewDeviceLost",
            Self::Busy => "previewBusy",
            Self::FrameUnpublishable => "previewFrameUnpublishable",
            Self::Unavailable => "previewUnavailable",
        }
    }
}

impl fmt::Display for PreviewRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedRequest => "the preview frame request is not one this build renders",
            Self::MediaUnavailable => "the media this preview renders against is unavailable",
            Self::SourceUnreadable => "the source video could not be read at that frame",
            Self::FontUnavailable => "the resolved font face is not the face the request asked for",
            Self::AtlasUnknown => "no staged glyph atlas answers to that identifier",
            Self::AtlasCannotLayOut {
                shaping_crosses_clusters: true,
                ..
            } => {
                "the staged glyph atlas cannot be laid out because shaping crosses cluster \
                  boundaries"
            }
            Self::AtlasCannotLayOut {
                direction_needs_bidi: true,
                ..
            } => "the staged glyph atlas cannot be laid out because the run needs a bidi reorder",
            Self::AtlasCannotLayOut { .. } => {
                "the staged glyph atlas refuses layout from per-cell advances"
            }
            Self::SceneRejected => "the preview scene was refused by the compositor",
            Self::StaleGeneration => "the preview frame is no longer the one being asked for",
            Self::DeviceLost => "no graphics device is available to compose a preview frame",
            Self::Busy => "another preview frame is already being composed",
            Self::FrameUnpublishable => "the composed preview frame could not be published",
            Self::Unavailable => "the preview frame registry is unavailable",
        };
        formatter.write_str(message)
    }
}

impl From<LayoutRefusal> for PreviewRefusal {
    fn from(refusal: LayoutRefusal) -> Self {
        Self::AtlasCannotLayOut {
            shaping_crosses_clusters: refusal.shaping_crosses_clusters,
            direction_needs_bidi: refusal.direction_needs_bidi,
        }
    }
}

impl From<CompositorError> for PreviewRefusal {
    /// One place decides which compositor failures are a lost device rather than a bad scene.
    ///
    /// A device that cannot be acquired, a device that will not be created and a readback that
    /// failed are all the same thing to a user — the GPU is not usable — and all three mean the
    /// compositor this host is holding must be thrown away rather than reused. Everything else is a
    /// property of the scene that was handed in, which retrying will not fix.
    fn from(error: CompositorError) -> Self {
        match error {
            CompositorError::NoAdapter { .. }
            | CompositorError::DeviceUnavailable { .. }
            | CompositorError::ReadbackFailed { .. } => Self::DeviceLost,
            _ => Self::SceneRejected,
        }
    }
}

impl From<RenderError> for PreviewRefusal {
    fn from(_: RenderError) -> Self {
        Self::UnsupportedRequest
    }
}

impl From<ExportError> for PreviewRefusal {
    /// Maps the shared conversion's refusals onto the ones the preview surface must explain.
    ///
    /// The conversion is the export's, so its vocabulary is the export's too. What the preview adds
    /// is the split the editor needs: the font, the atlas and the device are each their own thing
    /// to say, and everything the compositor decided about the scene collapses to one.
    fn from(error: ExportError) -> Self {
        match error {
            ExportError::FontUnavailable | ExportError::AtlasFaceMismatch => Self::FontUnavailable,
            ExportError::AtlasCannotLayOut { refusal } => refusal.into(),
            ExportError::CompositionRejected { reason } => reason.into(),
            ExportError::SourceUnreadable { .. } => Self::SourceUnreadable,
            ExportError::UnsupportedRequest { .. } => Self::UnsupportedRequest,
            _ => Self::SceneRejected,
        }
    }
}

impl Serialize for PreviewRefusal {
    /// The `{ code, message }` shape `desktopRuntime.js` already reads for every native failure.
    ///
    /// A command may fail with any `Serialize` error, and this one carries a *dynamic* code, which
    /// `CommandError`'s `&'static str` constructors cannot express. The shape is deliberately
    /// identical, so nothing on the `WebView` side has to learn a second failure vocabulary; if
    /// `CommandError` ever gains a constructor that takes a code and a message, this collapses into
    /// a `From` implementation and the impl below goes away.
    ///
    /// Both fields are value-free by construction: [`Self::code`] is a fixed token and the message
    /// is [`fmt::Display`], which names a category and never a path, a family or a line of text.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("PreviewRefusal", 2)?;
        error.serialize_field("code", self.code())?;
        error.serialize_field(
            "message",
            &format!("The preview frame was not rendered: {self}."),
        )?;
        error.end()
    }
}
