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
use osg_render::{RenderLyric, RenderPlan, RenderRequest};
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
    validate_cue_or_not(request, width, height, duration_us)
}

/// Validates a request that may name no cue at all.
///
/// [`RenderRequest::validate`] refuses an empty lyric list, because an *export* with nothing to draw
/// is a request nobody meant. A preview frame is not an export: the instants between cues are
/// ordinary frames, on which the underlay, the crop and the canvas backfill are all still composed,
/// and the editor documents that request as legitimate rather than as an error.
///
/// Nothing in a plan is derived from the lyric list — the dimensions come from the source aspect,
/// the crop and the resolution, and the frame count from the trim and the frame rate — so a
/// cue-less request is validated with one probe cue that is dropped from the plan immediately
/// afterwards. The plan that results is exactly the one a cue-less request describes, and the export
/// contract's own bound stays where it is instead of being relaxed for every caller of it.
fn validate_cue_or_not(
    mut request: RenderRequest,
    width: u32,
    height: u32,
    duration_us: u64,
) -> Result<RenderPlan, PreviewRefusal> {
    let cue_less = request.lyrics.is_empty();
    if cue_less {
        request.lyrics.push(RenderLyric {
            id: "preview-probe".to_owned(),
            start_us: 0,
            end_us: 1,
            text: "x".to_owned(),
        });
    }
    let mut plan = request.validate(width, height, duration_us)?;
    if cue_less {
        plan.lyrics.clear();
    }
    Ok(plan)
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
        //
        // A cue-less instant stages no run at all: the scene has no cue for one to belong to, and a
        // run staged against nothing is refused by the run count the compositor checks. The frame is
        // still composed — the underlay, the crop and the canvas backfill do not depend on a cue.
        let runs = if plan.lyrics.is_empty() {
            Vec::new()
        } else {
            vec![CueRun::from_layout(atlas.layout())]
        };
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
