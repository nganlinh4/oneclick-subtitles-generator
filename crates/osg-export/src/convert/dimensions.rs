//! The output frame size, derived once, from the source's display shape and the crop region.
//!
//! The scene, the compositor and the encoder are all configured from the [`CompositionSize`] this
//! module returns, so there is one derivation rather than one per consumer. The height is the
//! resolution ladder's, taken from the validated request unchanged — the ladder lives in the
//! request contract and is deliberately not copied here. The width is what the source shape and the
//! crop decide, and is the whole subject of the parity ledger's `aspectRatio` entry.
//!
//! # The source aspect is the *display* aspect
//!
//! `plan.source_width` and `plan.source_height` are the size the source is **shown** at — pixel
//! aspect ratio applied, rotation applied — and not the size it is stored at. That is not a
//! preference; it is the only reading under which this module agrees with the editor, which sizes
//! its own composition from the `<video>` element's `videoWidth`/`videoHeight`, and the browser
//! applies both before it reports them.
//!
//! The two readings are the same number for an ordinary file and a visibly different number for the
//! two kinds of file a user of this application actually has:
//!
//! * An anamorphic clip stored 720x480 and shown 854x480 composes **1922** wide at 1080p from its
//!   display shape and **1620** from its coded shape.
//! * A portrait phone clip stored 1920x1080 with a quarter-turn and shown 1080x1920 composes
//!   **608** wide from its display shape and **1920** — landscape, the wrong way round entirely —
//!   from its coded shape.
//!
//! Both numbers are asserted below. `osg-decode` reports the two sizes separately and by name, and
//! the two callers that validate a request — `osg_export::run::plan_against_source` and the
//! preview's `plan_for_source` — take the display one, so the preview, the export and the editor
//! compose one frame rather than three.
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
//! * Every other writer sets it to `null` and nothing else: the defaults in
//!   `VideoRenderingSection/renderPreferences.js` and `previews/videoDownloadHandlers.js`, plus the
//!   crop-clearing handler in the deleted browser preview. `renderService.js` carries whatever it
//!   finds straight through to the request.
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
//! That distinction is not theoretical. The deleted browser preview's `getCompositionDimensions`
//! sized its composition from the same inputs but associated them differently —
//! `sourceAspect * ((cropWidth / 100) / (cropHeight / 100))` — and
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
    /// Derived from the source's display aspect and the crop region.
    pub(crate) width: u32,
    /// The resolution ladder's height, from the validated request.
    pub(crate) height: u32,
}

/// Derives the output frame size from the resolution height, the source's display shape and the
/// crop region.
///
/// # Errors
/// Returns [`ExportError::UnsupportedRequest`] when the crop implies a width outside the range the
/// request contract accepts, and [`ExportError::OutputSizeNotFromCrop`] when the size the crop
/// implies is not the size the request was validated to.
pub(crate) fn composition_size(plan: &RenderPlan) -> Result<CompositionSize, ExportError> {
    let height = even(plan.height);
    let width = composed_width(
        plan.source_width,
        plan.source_height,
        plan.crop.width / plan.crop.height,
        height,
    )
    .ok_or(ExportError::UnsupportedRequest {
        reason: RenderError::InvalidRequest,
    })?;
    if (width, height) != (plan.width, plan.height) {
        return Err(ExportError::OutputSizeNotFromCrop);
    }
    Ok(CompositionSize { width, height })
}

/// The width a source of this display shape composes at `height`, or `None` outside the range the
/// request contract accepts.
///
/// The associativity is the request contract's, term for term, for the reason the module note gives:
/// two spellings of the same product round apart on a small fraction of crop shapes, and the size a
/// request was validated to has to be the size it composes at.
fn composed_width(
    source_width: u32,
    source_height: u32,
    crop_ratio: f64,
    height: u32,
) -> Option<u32> {
    let source_aspect = f64::from(source_width) / f64::from(source_height);
    let effective_aspect = source_aspect * crop_ratio;
    let rounded = (f64::from(height) * effective_aspect).round();
    if !(MIN_OUTPUT_EDGE..=MAX_OUTPUT_EDGE).contains(&rounded) {
        return None;
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the width is finite and range checked on the line above"
    )]
    Some(even(rounded as u32))
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
    use super::{composed_width, even};

    /// The whole source, uncropped, which is what an untouched crop region means.
    const WHOLE: f64 = 1.0;

    #[test]
    fn an_anamorphic_source_composes_from_the_size_it_is_shown_at() {
        // 720x480 stored, 854x480 shown. The first number is what the editor composes and the
        // second is what this module composed before the display size existed.
        assert_eq!(composed_width(854, 480, WHOLE, 1_080), Some(1_922));
        assert_eq!(composed_width(720, 480, WHOLE, 1_080), Some(1_620));
    }

    #[test]
    fn a_rotated_source_composes_portrait_rather_than_landscape() {
        // 1920x1080 stored with a quarter turn, 1080x1920 shown. Composing from the coded shape
        // does not merely round differently — it produces a landscape frame for a portrait video.
        assert_eq!(composed_width(1_080, 1_920, WHOLE, 1_080), Some(608));
        assert_eq!(composed_width(1_920, 1_080, WHOLE, 1_080), Some(1_920));
    }

    #[test]
    fn a_square_pixel_source_is_unchanged_at_every_rung_of_the_ladder() {
        // The regression guard: the ordinary file must compose exactly what it always composed.
        for (height, width) in [(480, 854), (720, 1_280), (1_080, 1_920), (2_160, 3_840)] {
            assert_eq!(composed_width(1_920, 1_080, WHOLE, height), Some(width));
        }
    }

    #[test]
    fn a_shape_the_contract_will_not_accept_is_refused_rather_than_clamped() {
        // Far past the widest edge the request contract takes, which a hostile pixel aspect could
        // otherwise turn into a composition nobody asked for.
        assert_eq!(composed_width(u32::MAX, 2, WHOLE, 1_080), None);
        assert_eq!(composed_width(2, u32::MAX, WHOLE, 1_080), None);
    }

    #[test]
    fn an_odd_edge_grows_by_one_and_an_even_one_does_not() {
        assert_eq!(even(0), 0);
        assert_eq!(even(853), 854);
        assert_eq!(even(854), 854);
        assert_eq!(even(u32::MAX), u32::MAX, "saturating rather than wrapping");
    }
}
