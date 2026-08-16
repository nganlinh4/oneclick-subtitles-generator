//! The output frame size, derived once, from the crop region.
//!
//! The scene, the compositor and the encoder are all configured from the [`CompositionSize`] this
//! module returns, so there is one derivation rather than one per consumer. The height is the
//! resolution ladder's, taken from the validated request unchanged — the ladder lives in the
//! request contract and is deliberately not copied here. The width is what the crop decides, and is
//! the whole subject of the parity ledger's `aspectRatio` entry.
//!
//! # `crop.aspectRatio` is not read here, and must not be
//!
//! The persisted field exists, is validated, and is discarded. That is correct, and it is a fact
//! about the editor rather than an opinion about the renderer:
//!
//! * The control is `PRESET_ASPECT_RATIOS` in `src/components/VideoCropControls.js` — Free, 16:9,
//!   9:16, 1:1. Its value lives in the `selectedAspectRatio` component state, which is reset to
//!   `null` every time crop mode is entered, and `handleAspectRatioChange` writes **only**
//!   `x`/`y`/`width`/`height` (plus the two flip flags) back into the crop. The crop object never
//!   receives an `aspectRatio` key from the control that is named after it.
//! * Every other writer sets it to `null` and nothing else: `handleClearCrop` in
//!   `RemotionVideoPreview.js`, the defaults in `VideoRenderingSection/renderPreferences.js`, and
//!   `previews/videoDownloadHandlers.js`. `renderService.js` carries whatever it finds straight
//!   through to the request.
//! * The button expresses itself by *reshaping the rectangle*. `calculateCropDimensions` solves for
//!   a rectangle whose own ratio is the selected one, so the selected ratio is already a property of
//!   `width`/`height`. Deriving the output from the rectangle therefore already reproduces the
//!   button exactly, and consulting the field on top of it would apply the same ratio twice.
//!
//! `dimensions.rs` tests assert that last point rather than asserting the prose: for each shipped
//! preset the derived output aspect *is* the selected ratio, and setting `crop.aspectRatio` to any
//! legal value changes no output dimension at all.
//!
//! # One derivation, because two of them already disagreed
//!
//! The rule is `round(targetHeight * (sourceAspect * cropWidth / cropHeight))`, rounded up to an
//! even edge because the encoder cannot take an odd one. It is the request contract's own
//! expression, associated the same way, so the size a request was validated to and the size this
//! composes at are the same number rather than two numbers that usually agree.
//!
//! That distinction is not theoretical. `getCompositionDimensions` in
//! `src/components/RemotionVideoPreview.js` sizes the shipped preview from the same inputs but
//! associates them differently — `sourceAspect * ((cropWidth / 100) / (cropHeight / 100))` — and
//! floating-point multiplication is not associative. Over a scan of crop shapes from 10% to 200% in
//! hundredths, the two forms round to different output widths for a small fraction of them; a 10.01%
//! by 28.16% crop of a 1920x1080 source at 1080p is one, where the shipped preview composes 682 and
//! everything downstream of this module composes 684. Preview and export already disagreed there,
//! and the answer is one derivation rather than a third.
//!
//! The derived size is checked against the size the request was validated to. They agree by
//! construction today; if a future contract change made them disagree, the export refuses rather
//! than writing a file at a size the editor never showed.

use osg_render::{RenderError, RenderPlan};

use crate::error::ExportError;

/// The narrowest output edge the request contract accepts.
const MIN_OUTPUT_EDGE: f64 = 2.0;

/// The widest output edge the request contract accepts.
const MAX_OUTPUT_EDGE: f64 = 15_360.0;

/// The pixel size one export composes, encodes and previews at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CompositionSize {
    /// Derived from the source aspect and the crop region.
    pub(crate) width: u32,
    /// The resolution ladder's height, from the validated request.
    pub(crate) height: u32,
}

/// Derives the output frame size from the resolution height and the crop region.
///
/// # Errors
/// Returns [`ExportError::UnsupportedRequest`] when the crop implies a width outside the range the
/// request contract accepts, and [`ExportError::OutputSizeNotFromCrop`] when the size the crop
/// implies is not the size the request was validated to.
pub(crate) fn composition_size(plan: &RenderPlan) -> Result<CompositionSize, ExportError> {
    let height = even(plan.height);
    let source_aspect = f64::from(plan.source_width) / f64::from(plan.source_height);
    let effective_aspect = source_aspect * (plan.crop.width / plan.crop.height);
    let rounded = (f64::from(height) * effective_aspect).round();
    if !(MIN_OUTPUT_EDGE..=MAX_OUTPUT_EDGE).contains(&rounded) {
        return Err(ExportError::UnsupportedRequest {
            reason: RenderError::InvalidRequest,
        });
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the width is finite and range checked on the line above"
    )]
    let width = even(rounded as u32);
    if (width, height) != (plan.width, plan.height) {
        return Err(ExportError::OutputSizeNotFromCrop);
    }
    Ok(CompositionSize { width, height })
}

/// Rounds an edge up to the even number the encoder requires.
fn even(value: u32) -> u32 {
    if value.is_multiple_of(2) {
        value
    } else {
        value.saturating_add(1)
    }
}

#[cfg(test)]
mod tests {
    use super::even;

    #[test]
    fn an_odd_edge_grows_by_one_and_an_even_one_does_not() {
        assert_eq!(even(0), 0);
        assert_eq!(even(853), 854);
        assert_eq!(even(854), 854);
        assert_eq!(even(u32::MAX), u32::MAX, "saturating rather than wrapping");
    }
}
