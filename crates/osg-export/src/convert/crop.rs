//! The crop, from the persisted vocabulary to the compositor's, and the canvas backfill decision.
//!
//! The percentages cross unchanged; only the canvas mode is renamed, and it is renamed exhaustively
//! so a mode added to the contract is a compile error here.
//!
//! `crates/osg-compositor` applies the crop for real. The shipped renderer never did — frames were
//! extracted full size, the crop became CSS percentages on the video element, and the output
//! dimensions came from the crop ratio regardless — which is why the parity ledger records `x`,
//! `y`, `width` and `height` as deliberate visible changes wherever the crop was already wrong.
//! Nothing about that decision is taken here; this module only carries the numbers across.
//!
//! # The canvas backfill is opaque, and that is decided here
//!
//! The compositor is premultiplied, `osg-encode` hands `BGRA` to `MFVideoFormat_ARGB32`, and H.264
//! has no alpha channel. A backfill that is not opaque therefore exports as its premultiplied
//! colour over black — darker than it previewed — with nothing in the pipeline saying so. Leaving
//! that to the encoder is exactly the silent divergence this migration exists to remove, so the
//! decision is taken in the conversion, before a decoder or an encoder is opened:
//!
//! * **No canvas mode at all** — the shipped renderer's empty backdrop element — composites onto
//!   one explicit opaque ground, [`EXPORT_CANVAS_GROUND`]. Black is not invented for this: it is
//!   what the shipped renderer's empty backdrop already produced in an exported file. Stating it
//!   makes the composited frame opaque before the encoder sees it, and makes the previewed frame
//!   the same frame rather than one the browser blends differently.
//! * **A solid backfill whose colour carries alpha** is refused, by name, and refused for what it
//!   says rather than for whether this particular rectangle happens to hide it — so the refusal
//!   does not appear and disappear as a user drags the crop.
//!
//! Refusing costs no editor traffic. The control is `<input type="color">` in
//! `src/components/CanvasSettingsPill.js`, which can only produce `#rrggbb`, and
//! `normalizeCrop` in `src/platform/renderService.js` defaults the colour to `#000000` and the mode
//! to `solid`. An alpha on this field can only reach the export from a hand-edited or third-party
//! project, where there is no user intent to honour and darkening it quietly would be the worse
//! answer.

use osg_compositor::{CanvasBackground, Crop, CropSpec};
use osg_render::{CanvasBackgroundMode, CropSettings};
use osg_scene::color::parse_hex_color;

use crate::error::ExportError;

/// Fully opaque alpha.
const OPAQUE: u8 = 255;

/// The one explicit opaque ground an export composites an unset canvas backfill onto.
pub const EXPORT_CANVAS_GROUND: &str = "#000000";

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

/// Refuses a canvas colour an export cannot carry, before anything has been opened.
///
/// Runs on the raw request, so the refusal beats the source probe rather than following it. The
/// full conversion applies the same rule, so this is a promotion in the order of failures and not
/// the only place the decision is made.
///
/// # Errors
/// Returns [`ExportError::CanvasBackgroundNotOpaque`] when the solid backfill colour carries alpha.
pub(crate) fn check_canvas_background(crop: &CropSettings) -> Result<(), ExportError> {
    if crop.canvas_bg_mode != Some(CanvasBackgroundMode::Solid) {
        return Ok(());
    }
    let Some(colour) = crop.canvas_bg_color.as_deref() else {
        return Ok(());
    };
    // A colour that will not parse at all stays the compositor's refusal, unchanged, so that one
    // message keeps describing one problem.
    match parse_hex_color(colour) {
        Ok(colour) if colour.alpha != OPAQUE => Err(ExportError::CanvasBackgroundNotOpaque),
        _ => Ok(()),
    }
}

/// Resolves a request's crop into the one the compositor samples with, with an opaque backfill.
///
/// # Errors
/// Returns [`ExportError::CompositionRejected`] when the rectangle, mode, colour or blur is one the
/// compositor refuses, and [`ExportError::CanvasBackgroundNotOpaque`] when the backfill colour
/// carries alpha.
pub(crate) fn resolve(crop: &CropSettings) -> Result<Crop, ExportError> {
    let spec = crop_spec(crop);
    let resolved = Crop::resolve(&spec)?;
    match resolved.background() {
        CanvasBackground::Solid(colour) if colour.alpha != OPAQUE => {
            Err(ExportError::CanvasBackgroundNotOpaque)
        }
        CanvasBackground::Transparent => Ok(Crop::resolve(&CropSpec {
            canvas_bg_mode: Some(canvas_mode_name(CanvasBackgroundMode::Solid).to_owned()),
            canvas_bg_color: Some(EXPORT_CANVAS_GROUND.to_owned()),
            ..spec
        })?),
        _ => Ok(resolved),
    }
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
    use osg_compositor::{
        CanvasBackground, Crop, DEFAULT_CANVAS_BLUR_RADIUS_PX, MAX_CANVAS_BLUR_SIGMA,
    };
    use osg_render::{CanvasBackgroundMode, CropSettings};

    use super::{canvas_mode_name, check_canvas_background, crop_spec, resolve};
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

    fn solid(crop: &CropSettings) -> (u8, u8, u8, u8) {
        let resolved = resolve(crop).expect("the crop resolves");
        let CanvasBackground::Solid(colour) = resolved.background() else {
            panic!("the backfill must be solid");
        };
        (colour.red, colour.green, colour.blue, colour.alpha)
    }

    #[test]
    fn the_identity_rectangle_crosses_unchanged_over_the_explicit_opaque_ground() {
        let crop = resolve(&settings()).expect("identity");
        let identity = Crop::identity();
        assert_eq!(
            (crop.left(), crop.top(), crop.width(), crop.height()),
            (
                identity.left(),
                identity.top(),
                identity.width(),
                identity.height()
            )
        );
        assert!(!crop.flip_x() && !crop.flip_y());
        // Not `Crop::identity()`: an export has no alpha to carry, so an unset backfill is decided
        // here rather than left to the encoder.
        assert_eq!(solid(&settings()), (0, 0, 0, 255));
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
        assert_eq!(
            solid(&CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
                canvas_bg_color: Some("#123456".to_owned()),
                ..settings()
            }),
            (0x12, 0x34, 0x56, 255)
        );

        let blur = resolve(&CropSettings {
            canvas_bg_mode: Some(CanvasBackgroundMode::Blur),
            ..settings()
        })
        .expect("a blurred backfill resolves");
        // Half the default, not the default: `canvasBgBlur` is a CSS blur RADIUS and the compositor
        // stores the standard deviation it means, which is what
        // `fix(compositor): halve the canvas backfill blur` settled. Comparing against the stored
        // radius here is comparing a sigma with a length.
        assert_eq!(
            blur.background(),
            CanvasBackground::Blur {
                sigma_px: DEFAULT_CANVAS_BLUR_RADIUS_PX / 2.0
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
        // and is expanded there, so a hand-edited project carrying an opaque one still exports.
        assert_eq!(
            solid(&CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
                canvas_bg_color: Some("#abcf".to_owned()),
                ..settings()
            }),
            (0xAA, 0xBB, 0xCC, 0xFF)
        );
    }

    #[test]
    fn a_translucent_backfill_is_refused_rather_than_exported_darker_than_it_previewed() {
        for colour in ["#abcd", "#12345678", "#00000000"] {
            let crop = CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
                canvas_bg_color: Some(colour.to_owned()),
                ..settings()
            };
            let error = resolve(&crop).expect_err("a translucent backfill is refused");
            assert!(
                matches!(error, ExportError::CanvasBackgroundNotOpaque),
                "{colour} gave {error}"
            );
            // And the same refusal is reachable without resolving anything, which is what lets the
            // runner take it before the source is opened.
            assert!(matches!(
                check_canvas_background(&crop),
                Err(ExportError::CanvasBackgroundNotOpaque)
            ));
        }
    }

    #[test]
    fn the_pre_flight_refuses_only_alpha_and_leaves_every_other_verdict_alone() {
        // Opaque colours, both shorthands, the absent colour and both other modes all pass, so the
        // early check cannot become a second validator that disagrees with the conversion.
        for crop in [
            settings(),
            CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
                canvas_bg_color: Some("#fff".to_owned()),
                ..settings()
            },
            CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
                canvas_bg_color: None,
                ..settings()
            },
            CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Blur),
                canvas_bg_color: Some("#abcd".to_owned()),
                ..settings()
            },
            // Not a colour at all: still the compositor's verdict, not this one's.
            CropSettings {
                canvas_bg_mode: Some(CanvasBackgroundMode::Solid),
                canvas_bg_color: Some("rgb(1,2,3)".to_owned()),
                ..settings()
            },
        ] {
            check_canvas_background(&crop).expect("only alpha is refused here");
        }
    }

    #[test]
    fn an_absent_canvas_mode_stays_absent_on_the_wire() {
        assert!(crop_spec(&settings()).canvas_bg_mode.is_none());
        assert_eq!(canvas_mode_name(CanvasBackgroundMode::Solid), "solid");
        assert_eq!(canvas_mode_name(CanvasBackgroundMode::Blur), "blur");
    }
}
