//! The crop, from the persisted vocabulary to the compositor's.
//!
//! The percentages cross unchanged; only the canvas mode is renamed, and it is renamed exhaustively
//! so a mode added to the contract is a compile error here.
//!
//! `crates/osg-compositor` applies the crop for real. The shipped renderer never did — frames were
//! extracted full size, the crop became CSS percentages on the video element, and the output
//! dimensions came from the crop ratio regardless — which is why the parity ledger records `x`,
//! `y`, `width` and `height` as deliberate visible changes wherever the crop was already wrong.
//! Nothing about that decision is taken here; this module only carries the numbers across.

use osg_compositor::{Crop, CropSpec};
use osg_render::{CanvasBackgroundMode, CropSettings};

use crate::error::ExportError;

/// The staged crop a request describes, before the compositor resolves it.
pub(crate) fn crop_spec(crop: &CropSettings) -> CropSpec {
    CropSpec {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        flip_x: crop.flip_x,
        flip_y: crop.flip_y,
        canvas_bg_mode: crop
            .canvas_bg_mode
            .map(|mode| canvas_mode_name(mode).to_owned()),
        canvas_bg_color: crop.canvas_bg_color.clone(),
        canvas_bg_blur: crop.canvas_bg_blur,
    }
}

/// Resolves a request's crop into the one the compositor samples with.
pub(crate) fn resolve(crop: &CropSettings) -> Result<Crop, ExportError> {
    Ok(Crop::resolve(&crop_spec(crop))?)
}

/// The wire name `osg_compositor::Crop::resolve` accepts.
#[must_use]
pub(crate) const fn canvas_mode_name(mode: CanvasBackgroundMode) -> &'static str {
    match mode {
        CanvasBackgroundMode::Solid => "solid",
        CanvasBackgroundMode::Blur => "blur",
    }
}

#[cfg(test)]
mod tests {
    use osg_compositor::{CanvasBackground, Crop, DEFAULT_CANVAS_BLUR, MAX_CANVAS_BLUR_SIGMA};
    use osg_render::{CanvasBackgroundMode, CropSettings};

    use super::{canvas_mode_name, crop_spec, resolve};
    use crate::error::ExportError;

    fn settings() -> CropSettings {
        CropSettings {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            aspect_ratio: None,
            canvas_bg_mode: None,
            canvas_bg_color: None,
            canvas_bg_blur: None,
            flip_x: false,
            flip_y: false,
        }
    }

    #[test]
    fn the_identity_crop_crosses_unchanged() {
        assert_eq!(resolve(&settings()).expect("identity"), Crop::identity());
    }

    #[test]
    fn percentages_and_flips_cross_unchanged() {
        let crop = resolve(&CropSettings {
            x: 25.0,
            y: 10.0,
            width: 50.0,
            height: 40.0,
            flip_x: true,
            flip_y: true,
            ..settings()
        })
        .expect("a cropped, flipped region resolves");
        assert!((crop.left() - 0.25).abs() < f64::EPSILON);
        assert!((crop.top() - 0.10).abs() < f64::EPSILON);
        assert!((crop.width() - 0.50).abs() < f64::EPSILON);
        assert!((crop.height() - 0.40).abs() < f64::EPSILON);
        assert!(crop.flip_x() && crop.flip_y());
    }

    #[test]
    fn both_canvas_modes_are_names_the_compositor_accepts() {
        let solid = resolve(&CropSettings {
            canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
            canvas_bg_color: Some("#123456".to_owned()),
            ..settings()
        })
        .expect("a solid backfill resolves");
        let CanvasBackground::Solid(colour) = solid.background() else {
            panic!("the backfill must be solid");
        };
        assert_eq!(
            (colour.red, colour.green, colour.blue, colour.alpha),
            (0x12, 0x34, 0x56, 255)
        );

        let blur = resolve(&CropSettings {
            canvas_bg_mode: Some(CanvasBackgroundMode::Blur),
            ..settings()
        })
        .expect("a blurred backfill resolves");
        assert_eq!(
            blur.background(),
            CanvasBackground::Blur {
                sigma_px: DEFAULT_CANVAS_BLUR
            }
        );

        let clamped = resolve(&CropSettings {
            canvas_bg_mode: Some(CanvasBackgroundMode::Blur),
            canvas_bg_blur: Some(1_000.0),
            ..settings()
        })
        .expect("the largest stored blur is accepted");
        assert_eq!(
            clamped.background(),
            CanvasBackground::Blur {
                sigma_px: MAX_CANVAS_BLUR_SIGMA
            }
        );
    }

    #[test]
    fn a_canvas_colour_the_compositor_will_not_parse_is_refused_rather_than_guessed_at() {
        // The colour goes through `osg-scene`'s single parser rather than a second one written
        // here, which is what makes this a refusal instead of a guess.
        let error = resolve(&CropSettings {
            canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
            canvas_bg_color: Some("rgb(1,2,3)".to_owned()),
            ..settings()
        })
        .expect_err("a colour that is not a hex colour is refused");
        assert!(
            matches!(error, ExportError::CompositionRejected { .. }),
            "unexpected error: {error}"
        );

        // The four-digit `#rgba` shorthand the persistence chain accepts reaches the same parser
        // and is expanded there, so a hand-edited project carrying one still exports.
        let shorthand = resolve(&CropSettings {
            canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
            canvas_bg_color: Some("#abcd".to_owned()),
            ..settings()
        })
        .expect("the four-digit shorthand is expanded, not refused");
        let CanvasBackground::Solid(colour) = shorthand.background() else {
            panic!("the backfill must be solid");
        };
        assert_eq!(
            (colour.red, colour.green, colour.blue, colour.alpha),
            (0xAA, 0xBB, 0xCC, 0xDD)
        );
    }

    #[test]
    fn an_absent_canvas_mode_stays_absent() {
        assert!(crop_spec(&settings()).canvas_bg_mode.is_none());
        assert_eq!(canvas_mode_name(CanvasBackgroundMode::Solid), "solid");
        assert_eq!(canvas_mode_name(CanvasBackgroundMode::Blur), "blur");
    }
}
