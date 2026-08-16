//! Consuming the export's conversion for a single frame.
//!
//! **Nothing in this module decides anything about how a subtitle looks.** Every parity decision —
//! the `trimStart` rebase, the duration source, the output dimensions, the canvas ground, the whole
//! style and crop mapping — is made by [`osg_export::ExportPlan::convert`] and the modules beside
//! it, and is made once for both surfaces. What is here is the three calls that get a validated
//! request to that conversion, and the one that turns the staged text into a drawable scene.
//!
//! Those three calls mirror `osg-export`'s own private `plan_against_source`, which is not exposed.
//! That is the only thing in this file worth reviewing: see the module note in
//! [`super`] and the handoff request that would let this call it directly instead.

use std::path::Path;

use osg_compositor::{CueRun, SubtitleScene};
use osg_export::{ExportPlan, StagedText, probe_source};
use osg_render::{RenderPlan, RenderRequest};
use osg_scene::glyph::GlyphAtlasDescriptor;
use osg_scene::scene::ResolvedFace;

use super::refusal::PreviewRefusal;

/// 100ns units per microsecond, which is the only unit conversion this module performs.
const HUNDRED_NANOS_PER_MICRO: i64 = 10;

/// Reads what the source really is and validates the request against exactly those numbers.
///
/// The request cannot be validated against anything else: the output width follows from the source
/// aspect and the crop region, and the frame count follows from the source duration, so a preview
/// planned against guessed dimensions would be a different composition from the export.
pub(crate) fn plan_for_source(
    request: RenderRequest,
    source: &Path,
) -> Result<RenderPlan, PreviewRefusal> {
    let info = probe_source(source).map_err(|_| PreviewRefusal::SourceUnreadable)?;
    let width = u32::try_from(info.width()).map_err(|_| PreviewRefusal::SourceUnreadable)?;
    let height = u32::try_from(info.height()).map_err(|_| PreviewRefusal::SourceUnreadable)?;
    let duration_us = u64::try_from(info.duration_100ns() / HUNDRED_NANOS_PER_MICRO)
        .map_err(|_| PreviewRefusal::SourceUnreadable)?;
    Ok(request.validate(width, height, duration_us)?)
}

/// The composition a preview frame is drawn from: the export's plan and the export's scene.
#[derive(Debug)]
pub(crate) struct PreviewComposition {
    plan: ExportPlan,
    scene: SubtitleScene,
}

impl PreviewComposition {
    /// Converts a validated plan and composes the staged text into a drawable scene.
    ///
    /// # Errors
    /// Returns the conversion's own refusal, narrowed to what the preview surface must explain:
    /// an unavailable face, an atlas that refuses cell-advance layout, or a scene the compositor
    /// will not draw.
    pub(crate) fn build(
        plan: &RenderPlan,
        face: &ResolvedFace,
        atlas: GlyphAtlasDescriptor,
    ) -> Result<Self, PreviewRefusal> {
        let export = ExportPlan::convert(plan, face)?;
        // One run per cue, copied from the layout the baker emitted. `CueRun::from_layout` is a
        // copy rather than a computation, so no layout is derived on this side of the boundary.
        let runs = vec![CueRun::from_layout(atlas.layout())];
        let scene = export.compose(StagedText::new(face.clone(), atlas, runs))?;
        Ok(Self {
            plan: export,
            scene,
        })
    }

    /// The scene the compositor draws.
    pub(crate) const fn scene(&self) -> &SubtitleScene {
        &self.scene
    }

    /// The composition width the conversion derived.
    #[cfg(test)]
    pub(crate) const fn width(&self) -> u32 {
        self.plan.width()
    }

    /// The composition height the conversion derived.
    #[cfg(test)]
    pub(crate) const fn height(&self) -> u32 {
        self.plan.height()
    }

    /// How many frames the converted timeline has.
    ///
    /// From the timeline, exactly as an export takes it, so frame `n` of a preview and frame `n` of
    /// the exported file are the same instant.
    pub(crate) const fn frame_count(&self) -> u32 {
        self.plan.frame_count()
    }
}
