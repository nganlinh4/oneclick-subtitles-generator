//! Why a native export refused, in a vocabulary that carries nothing private.
//!
//! The export pipeline already refuses in typed, path-free terms: [`ExportError`] names a category
//! and never a location, a credential or a line of subtitle text. This module is the one place that
//! vocabulary becomes the `{ code, message }` shape the `WebView` reads for every native failure,
//! and it is deliberately not a flattening: the five outcomes a user can act on differently — an
//! unavailable font, an atlas that refuses cell-advance layout, an unreadable source, a full volume
//! and a lost graphics device — each keep their own code.
//!
//! The messages are written for a person, name no file and quote no text, so a refusal is safe to
//! surface verbatim and safe to log.
//!
//! Two of these codes are not yet in `RENDER_COMMAND_CODES` in `src/platform/renderService.js`,
//! which is frozen: that module maps a code it does not know to `nativeRenderFailed` and shows its
//! generic sentence. The refusal is still typed here and still typed in the diagnostics, so nothing
//! is lost but the sentence, and the frontend change that teaches it these codes is recorded with
//! the rest of the handoff rather than made here.

use osg_compositor::CompositorError;
use osg_export::ExportError;

use crate::error::CommandError;

/// The export cannot start because the `WebView` did not stage the text it is to draw.
///
/// Not a fallback point. The architecture forbids a Rust text stack, so an export with no staged
/// atlas has no glyphs at all; drawing a substitute would be exactly the silent divergence between
/// preview and export that the native pipeline exists to remove.
pub(crate) fn text_not_staged() -> CommandError {
    CommandError::render_refusal(
        "renderTextNotStaged",
        "The subtitle text for this export was not staged, so there is nothing to draw with.",
    )
}

/// No staged atlas answers to the handle the request named, or it is not the one it named.
pub(crate) fn atlas_unknown() -> CommandError {
    CommandError::render_refusal(
        "renderAtlasUnknown",
        "The staged glyph atlas for this export is no longer available. Try again.",
    )
}

/// The staged text does not describe the cues the request carries.
pub(crate) fn text_mismatched() -> CommandError {
    CommandError::render_refusal(
        "renderTextMismatched",
        "The staged subtitle text does not match the subtitles in this render request.",
    )
}

/// The export was cancelled, and its partial output has been removed.
pub(crate) fn cancelled() -> CommandError {
    CommandError::render_refusal("renderCancelled", "The video render was cancelled.")
}

/// The export ran past the time limit and was stopped.
pub(crate) fn timed_out() -> CommandError {
    CommandError::render_refusal(
        "renderTimeout",
        "The video render exceeded its safe time limit.",
    )
}

/// The staging area the export writes its output into is unusable.
pub(crate) fn staging_unavailable() -> CommandError {
    CommandError::render_refusal(
        "renderStagingUnavailable",
        "The native render staging area is unavailable.",
    )
}

/// The finished file is not the one the timeline described.
///
/// A last gate rather than a likely one: the export's own contract makes the frame count the
/// timeline's, so this fires only if the encoder and the plan ever disagree — and a file of the
/// wrong length must not be published as the render the user asked for.
pub(crate) fn output_invalid() -> CommandError {
    CommandError::render_refusal(
        "renderOutputInvalid",
        "The native video render did not produce the file the timeline describes.",
    )
}

/// One export failure, as the `WebView` learns about it.
///
/// Exhaustive on purpose. [`ExportError`] is `#[non_exhaustive]`, so the wildcard arm exists, but
/// every variant that exists today is named: a new one arriving as "the render failed" would be a
/// silent loss of the thing this module is for.
pub(crate) fn from_export(error: &ExportError) -> CommandError {
    match error {
        ExportError::Cancelled => cancelled(),
        ExportError::UnsupportedRequest { .. } | ExportError::CanvasBackgroundNotOpaque => {
            CommandError::render_refusal(
                "invalidRenderRequest",
                "The selected video, subtitles, or render settings cannot be exported.",
            )
        }
        ExportError::FontUnavailable | ExportError::AtlasFaceMismatch => {
            CommandError::render_refusal(
                "renderFontUnavailable",
                "The font this render asks for is not the font the text was measured with.",
            )
        }
        ExportError::AtlasCannotLayOut { refusal } => {
            if refusal.direction_needs_bidi {
                CommandError::render_refusal(
                    "renderAtlasCannotLayOut",
                    "The subtitle text needs a right-to-left reorder this render cannot reproduce.",
                )
            } else {
                CommandError::render_refusal(
                    "renderAtlasCannotLayOut",
                    "The subtitle text was shaped in a way this render cannot place cell by cell.",
                )
            }
        }
        ExportError::SourceUnreadable { .. } => CommandError::render_refusal(
            "renderSourceUnreadable",
            "The source video could not be read all the way through.",
        ),
        ExportError::AudioUnusable { .. } => CommandError::render_refusal(
            "renderAudioUnusable",
            "The audio for this render could not be decoded and mixed.",
        ),
        ExportError::OutputVolumeFull => CommandError::render_refusal(
            "renderVolumeFull",
            "There is not enough free space to write the rendered video.",
        ),
        ExportError::OutputUnwritable { .. } => CommandError::render_refusal(
            "renderIo",
            "The native video render could not write its output file.",
        ),
        ExportError::CompositionRejected { reason } => from_composition(reason),
        // The scene, the timeline and the derived output size, plus whatever a later export adds:
        // all of them mean the composition this request describes is not one that can be drawn.
        _ => scene_rejected(),
    }
}

/// The composition's refusals, split where the split changes what a user should do.
///
/// A device that cannot be acquired, one that will not be created and a readback that failed are one
/// thing to a user — the graphics device is not usable — and are the same three the preview treats
/// as a lost device. Everything else is a property of the scene, which retrying will not fix.
fn from_composition(error: &CompositorError) -> CommandError {
    match error {
        CompositorError::NoAdapter { .. }
        | CompositorError::DeviceUnavailable { .. }
        | CompositorError::ReadbackFailed { .. } => CommandError::render_refusal(
            "renderDeviceLost",
            "No usable graphics device is available to render this video.",
        ),
        _ => scene_rejected(),
    }
}

fn scene_rejected() -> CommandError {
    CommandError::render_refusal(
        "renderSceneRejected",
        "This render is not one the native compositor can draw.",
    )
}
