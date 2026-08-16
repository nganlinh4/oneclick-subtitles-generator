//! The preview frame request, end to end.
//!
//! One function, in the order the failures have to happen: refuse what can be refused without
//! spending anything, then open the source, then convert, then claim a generation, then draw, then
//! publish. Every step before the render is cheap and every step after it is bounded, so a request
//! that cannot succeed never reaches the GPU and a frame that arrives too late never reaches the
//! screen.
//!
//! # Where the glyphs come from
//!
//! A frame is drawn from a [`GlyphAtlasDescriptor`], and the atlas the `WebView` staged is held by
//! `crate::glyph_atlas`. That message once omitted `face.cssFont` and `face.probes` — the evidence
//! that the requested face actually participated in the measurement — which made a descriptor
//! impossible to build without synthesising them, and synthesising them would have turned the
//! substitution check into a rubber stamp that always passes.
//!
//! The resolution was to forward the real evidence rather than to drop the check: staging now
//! carries it, and builds the checked descriptor at the door, so the registry only ever holds
//! atlases the compositor can actually draw. The atlas still arrives through [`StagedAtlases`], so
//! this module can be tested without a registry.

use std::path::Path;

use osg_domain::AssetId;
use osg_media_server::MediaServer;
use osg_scene::glyph::GlyphAtlasDescriptor;

use super::host::PreviewHost;
use super::plan::{PreviewComposition, plan_for_source};
use super::publish::PreviewBinding;
use super::refusal::PreviewRefusal;
use super::request::{PreviewFrameRequest, PreviewFrameResponse};

/// Where a preview frame's glyphs come from.
///
/// The lookup is by the opaque handle `glyph_atlas_stage` minted, cross-checked against the baker's
/// own content hash: a handle alone would let a stale editor cache address an atlas that has since
/// been evicted and replaced under a recycled identifier.
pub(crate) trait StagedAtlases {
    /// Resolves one staged atlas, or refuses.
    ///
    /// # Errors
    /// Returns [`PreviewRefusal::AtlasUnknown`] when nothing answers to `atlas_id`, when the staged
    /// atlas is not the one `content_hash` names, or when the registry is unavailable.
    fn descriptor(
        &self,
        atlas_id: AssetId,
        content_hash: &str,
    ) -> Result<GlyphAtlasDescriptor, PreviewRefusal>;
}

/// Renders one preview frame and publishes it as an element-loadable image.
///
/// `source` is the decoded media the request names, resolved by the caller from an opaque asset
/// identifier. It is read here and never appears in a response, in a refusal or in the published
/// URL.
///
/// The request's [`super::request::PreviewLayer`] chooses what the image carries and is echoed in
/// the response, so a caller can refuse a layer it did not ask for rather than draw it.
///
/// # Errors
/// Returns [`PreviewRefusal::UnsupportedRequest`] for a request this build does not read or a frame
/// outside the converted timeline, [`PreviewRefusal::SourceUnreadable`] when the source cannot be
/// probed, [`PreviewRefusal::AtlasUnknown`] for an atlas that is not staged,
/// [`PreviewRefusal::FontUnavailable`] when the staged face is not the one the request asks for,
/// [`PreviewRefusal::AtlasCannotLayOut`] when the atlas refuses cell-advance layout,
/// [`PreviewRefusal::SceneRejected`] when the composition is refused, [`PreviewRefusal::Busy`] when
/// too many renders are already running, [`PreviewRefusal::DeviceLost`] when no usable graphics
/// device remains, and [`PreviewRefusal::StaleGeneration`] when the frame finished after the thing
/// it describes changed.
pub(crate) fn render_preview_frame(
    host: &PreviewHost,
    server: &MediaServer,
    atlases: &dyn StagedAtlases,
    source: &Path,
    request: PreviewFrameRequest,
) -> Result<PreviewFrameResponse, PreviewRefusal> {
    request.check()?;
    let PreviewFrameRequest {
        scene_revision,
        atlas_id,
        atlas_content_hash,
        frame_index,
        face,
        render,
        layer,
        ..
    } = request;

    let atlas = atlases.descriptor(atlas_id, &atlas_content_hash)?;
    let plan = plan_for_source(render, source)?;
    let binding = PreviewBinding {
        project_id: plan.project_id,
        source_asset_id: plan.source_asset_id,
        scene_revision,
        atlas_id,
    };
    let composition = PreviewComposition::build(&plan, &face, atlas)?;

    // The generation is claimed after the conversion and before the draw, so the window a stale
    // result has to lose is exactly the render itself — which is the only slow part.
    let ticket = host.claim(binding)?;
    let frame = host.compose(&composition, frame_index)?;
    host.publish(server, &ticket, &frame, frame_index, layer)
}

// The registry adapter and the Tauri entry point.
//
// Kept here rather than in `crate::glyph_atlas` so the direction of the dependency matches the
// direction of the need: the preview reaches for an atlas, the staging registry knows nothing about
// previews.

impl StagedAtlases for crate::glyph_atlas::registry::GlyphAtlasStore {
    fn descriptor(
        &self,
        atlas_id: AssetId,
        content_hash: &str,
    ) -> Result<GlyphAtlasDescriptor, PreviewRefusal> {
        let staged = self
            .resolve(atlas_id)
            .map_err(|_| PreviewRefusal::Unavailable)?
            .ok_or(PreviewRefusal::AtlasUnknown)?;
        // A handle alone is not enough: an evicted atlas can leave a stale editor cache addressing
        // an identifier that has since been recycled, and drawing that would be silently wrong.
        if staged.content_hash() != content_hash {
            return Err(PreviewRefusal::AtlasUnknown);
        }
        // Infallible in practice — staging refuses anything that cannot become a descriptor — but
        // the conversion is fallible by type, and inventing an `expect` here would be the one place
        // a malformed atlas could take the process down.
        staged
            .to_descriptor()
            .map_err(|_| PreviewRefusal::AtlasUnknown)
    }
}

/// Renders one preview frame for the editor and returns a capability URL an `<img>` can load.
///
/// # Errors
/// Returns a [`PreviewRefusal`] for every refusal reason the renderer has, and
/// [`PreviewRefusal::SourceUnreadable`] when the request's media asset cannot be resolved. No
/// filesystem path, credential or subtitle text appears in any of them.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn preview_frame_render(
    state: tauri::State<'_, crate::state::DesktopState>,
    host: tauri::State<'_, PreviewHost>,
    atlases: tauri::State<'_, crate::glyph_atlas::registry::GlyphAtlasStore>,
    server: tauri::State<'_, MediaServer>,
    request: PreviewFrameRequest,
) -> Result<PreviewFrameResponse, PreviewRefusal> {
    // The two failures are different and the UI explains them differently: an asset that is not
    // there at all, and one that is there but cannot be read.
    let source = state
        .database
        .resolve_media(request.render.source_asset_id)
        .map_err(|_| PreviewRefusal::SourceUnreadable)?
        .ok_or(PreviewRefusal::MediaUnavailable)?;
    render_preview_frame(&host, &server, &*atlases, source.path(), request)
}
