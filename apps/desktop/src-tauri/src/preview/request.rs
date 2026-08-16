//! What crosses the command boundary, in both directions.
//!
//! The request is the same [`RenderRequest`] an export is built from, plus the four things a single
//! frame needs that a whole export does not: which frame, which staged atlas, which face the
//! `WebView` resolved, and the revision the caller believes it is looking at.
//!
//! Carrying the export's own request rather than a preview-shaped scene is the whole point. The
//! style, the crop, the trim, the resolution and the frame rate are then read by the conversion in
//! `crates/osg-export/src/convert/`, which is the single place those decisions are made. A preview
//! DTO that carried only cues and a face could not render what the user configured, and one that
//! carried a *second* description of the style would be the divergence this boundary exists to
//! close.

use osg_domain::AssetId;
use osg_render::RenderRequest;
use osg_scene::scene::ResolvedFace;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::refusal::PreviewRefusal;
use super::{MAX_IDENTITY_BYTES, PREVIEW_SCHEMA_VERSION};

/// Which layer of the composition a caller is asking for.
///
/// The two are not two renderers — the same compositor draws both, from the same converted plan —
/// but the *last* blend differs, and that is what the editor is choosing between:
///
/// - [`Self::Composited`] is the whole frame as the export writes it, one image, blended on the GPU.
///   Every surface where a user decides whether the output looks right asks for this one.
/// - [`Self::Subtitles`] is the subtitle pass alone on a transparent ground, for the `WebView` to lay
///   over its own `<video>`. Cheap enough for continuous playback, and **approximate**: the browser
///   performs the final blend, over a frame its own decoder colour-managed, so chroma subsampling,
///   the browser's colour management and its straight-alpha compositing all land in the gap. It is
///   never what a user judges, and it must never be the last thing on screen.
///
/// Absent from a request, the layer is [`Self::Composited`]: the guaranteed one is the default, and
/// asking for the approximation has to be deliberate.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewLayer {
    /// The fully composited frame: what the export writes, delivered as one image.
    #[default]
    Composited,
    /// The subtitle pass alone, on a transparent ground, for the `WebView` to blend.
    Subtitles,
}

/// One preview frame request, exactly as it arrives.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewFrameRequest {
    /// The request shape version, refused before any other field is read.
    pub(crate) schema_version: u32,
    /// The caller's identity for the scene it believes it is looking at.
    ///
    /// Opaque here: it is compared, never parsed. It exists so a frame that finishes after an edit
    /// can be recognised as belonging to the text that was on screen before it.
    pub(crate) scene_revision: String,
    /// The handle [`crate::glyph_atlas::command::glyph_atlas_stage`] minted for the baked atlas.
    pub(crate) atlas_id: AssetId,
    /// The baker's identity for that atlas, cross-checked against the staged one.
    pub(crate) atlas_content_hash: String,
    /// Which frame of the converted timeline to draw.
    pub(crate) frame_index: u32,
    /// The face the `WebView` resolved and baked from.
    pub(crate) face: ResolvedFace,
    /// The validated render request the export path is built from.
    pub(crate) render: RenderRequest,
    /// Which layer to draw. Defaulted rather than required, so every existing caller keeps asking
    /// for the composited frame without saying so.
    #[serde(default)]
    pub(crate) layer: PreviewLayer,
}

impl PreviewFrameRequest {
    /// Checks everything decidable without opening the source or touching the GPU.
    ///
    /// Deliberately shallow: [`RenderRequest::validate`] owns the render contract's own bounds and
    /// runs against the real source, and re-stating any of them here would create a second
    /// vocabulary to keep in step. What is checked is only what belongs to *this* boundary.
    pub(crate) fn check(&self) -> Result<(), PreviewRefusal> {
        if self.schema_version != PREVIEW_SCHEMA_VERSION
            || !is_opaque_identity(&self.scene_revision)
            || !is_opaque_identity(&self.atlas_content_hash)
        {
            return Err(PreviewRefusal::UnsupportedRequest);
        }
        // One staged atlas carries one `AtlasLayout`, and the compositor needs one staged run per
        // cue, so a request may name exactly as many cues as the atlas can lay out. Refused here,
        // before a source is opened, rather than surfacing later as a run-count rejection whose
        // cause is not obvious.
        if self.render.lyrics.len() != 1 {
            return Err(PreviewRefusal::UnsupportedRequest);
        }
        Ok(())
    }
}

/// A bounded, control-free opaque token: a revision or a content hash this side only compares.
fn is_opaque_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

/// What the `WebView` gets back: an element-loadable URL and the frame's own measurements.
///
/// Exactly the seven fields `nativePreviewFrames.js` accepts, in the shape it accepts them. Nothing
/// else may be added without changing that module too, because it matches the response key set
/// exactly and refuses a response carrying anything more.
///
/// The layer is echoed for the same reason the frame index and the dimensions are: a subtitle layer
/// shown where a composited frame was asked for is a *wrong picture* rather than a failure, and the
/// only way the caller can refuse one is to be told which layer it actually got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewFrameResponse {
    /// The opaque capability the frame is published under.
    pub(crate) sequence_id: Uuid,
    /// The loopback URL an `<img>` may load. Never a filesystem path.
    pub(crate) frame_url: String,
    /// The frame of the converted timeline this image shows.
    pub(crate) frame_index: u32,
    /// The composition width the conversion derived.
    pub(crate) width_px: u32,
    /// The composition height the conversion derived.
    pub(crate) height_px: u32,
    /// The image type, always [`super::PREVIEW_MIME_TYPE`].
    pub(crate) mime_type: String,
    /// Which layer this image carries, echoed from the request.
    pub(crate) layer: PreviewLayer,
}
