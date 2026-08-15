//! Crop, flip and the canvas backfill: everything the export does to the decoded source frame.
//!
//! These are the three fields `src/platform/renderParityLedger.js` still lists as pending on the
//! output side, and they belong together because they are one sampling decision rather than three
//! passes. A crop is a source rectangle; a flip is that rectangle read backwards; the backfill is
//! whatever shows where the rectangle does not reach. Resolving them into a single validated value
//! keeps the compositor from re-deriving any of it per frame.
//!
//! **Crop is implemented here for the first time.** The shipped renderer never applies it: the
//! extractor produces full-size frames, the crop becomes CSS percentages on the video element, and
//! the output dimensions come from the crop ratio regardless. The ledger records that as a
//! deliberate behaviour change, not a regression — the exported framing finally matches the crop UI.
//!
//! The percentage vocabulary is the editor's, mirrored from `CropSettings` in
//! `crates/osg-render/src/contract.rs` rather than imported, because the compositor must not depend
//! on the render crate. Every bound below is that contract's bound.

use osg_scene::color::{Rgba, parse_hex_color};

use crate::error::{CompositorError, Rejection};

/// The largest absolute crop offset, as a percentage of the source edge.
const MAX_CROP_OFFSET: f64 = 1_000.0;
/// The smallest crop extent, as a percentage of the source edge.
const MIN_CROP_EXTENT: f64 = 0.01;
/// The largest crop extent, as a percentage of the source edge.
const MAX_CROP_EXTENT: f64 = 1_000.0;
/// The largest blur the editor may store, as a percentage-free pixel radius.
const MAX_STORED_BLUR: f64 = 1_000.0;

/// The blur the shipped renderer falls back to when `canvasBgBlur` is absent.
pub const DEFAULT_CANVAS_BLUR: f64 = 24.0;

/// The largest blur standard deviation the compositor will actually apply, in output pixels.
///
/// The stored field accepts up to 1000, which as a Gaussian would be a 6001-tap kernel per axis for
/// a backdrop that is already an unrecognisable wash by a fraction of that. The value is clamped
/// rather than refused, because refusing would reject a setting the editor legitimately stores.
pub const MAX_CANVAS_BLUR_SIGMA: f64 = 40.0;

/// The largest kernel half-width, in output pixels. `ceil(3 * MAX_CANVAS_BLUR_SIGMA)`.
pub const MAX_CANVAS_BLUR_RADIUS: u32 = 120;

/// Ported from the shipped renderer: the blurred backdrop is over-scaled so its own blurred edge
/// never reaches the frame.
pub const CANVAS_BACKFILL_ZOOM: f64 = 1.06;

/// Ported from the shipped renderer: the blurred backdrop is darkened so the cropped video reads as
/// the subject rather than competing with its own background.
pub const CANVAS_BACKFILL_BRIGHTNESS: f64 = 0.7;

/// The colour the shipped renderer falls back to when `canvasBgColor` is absent.
const DEFAULT_CANVAS_COLOR: &str = "#000";

/// What fills the output where the cropped source region does not reach.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub enum CanvasBackground {
    /// Nothing. The uncovered area stays transparent, which is what the shipped renderer's empty
    /// backdrop element produces when no mode is selected.
    Transparent,
    /// A flat colour.
    Solid(Rgba),
    /// A darkened, over-scaled, blurred copy of the source.
    Blur {
        /// The Gaussian standard deviation in output pixels, already clamped to
        /// [`MAX_CANVAS_BLUR_SIGMA`].
        sigma_px: f64,
    },
}

/// The crop exactly as the editor stores it: percentages of the source and unparsed strings.
///
/// `x`/`y`/`width`/`height` are percentages of the **source** frame. The rectangle they describe is
/// mapped onto the whole output frame, so `x: 0, y: 0, width: 100, height: 100` is the identity.
/// Values outside the source are legal and are exactly the case the backfill exists for.
///
/// Two properties of that mapping, stated rather than assumed:
///
/// - **It stretches.** The rectangle fills the output on both axes independently. That is not a
///   distortion in practice, because the request contract derives the output dimensions from the
///   crop ratio times the source aspect, which makes the two aspects equal; but a caller that
///   composes at some other size gets a stretch rather than letterboxing, and gets it silently.
/// - **Its edge is hard.** Whether an output pixel is video or backfill is decided once, at the
///   pixel centre, so the boundary is not antialiased. A crop that lands between pixels shows a
///   one-pixel step rather than a blended edge.
#[derive(Debug, Clone, PartialEq)]
pub struct CropSpec {
    /// Left edge of the source rectangle, as a percentage of the source width.
    pub x: f64,
    /// Top edge of the source rectangle, as a percentage of the source height.
    pub y: f64,
    /// Width of the source rectangle, as a percentage of the source width.
    pub width: f64,
    /// Height of the source rectangle, as a percentage of the source height.
    pub height: f64,
    /// Mirror the cropped region horizontally.
    pub flip_x: bool,
    /// Mirror the cropped region vertically.
    pub flip_y: bool,
    /// `solid`, `blur`, or absent for no backfill at all.
    pub canvas_bg_mode: Option<String>,
    /// Backfill colour as `#rgb`, `#rrggbb` or `#rrggbbaa`.
    pub canvas_bg_color: Option<String>,
    /// Backfill blur standard deviation in output pixels.
    pub canvas_bg_blur: Option<f64>,
}

impl Default for CropSpec {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            flip_x: false,
            flip_y: false,
            canvas_bg_mode: None,
            canvas_bg_color: None,
            canvas_bg_blur: None,
        }
    }
}

/// A validated crop: source fractions, flip flags and a resolved backfill.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Crop {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    flip_x: bool,
    flip_y: bool,
    background: CanvasBackground,
}

fn bounded(value: f64, low: f64, high: f64) -> bool {
    value.is_finite() && (low..=high).contains(&value)
}

impl Crop {
    /// The whole source, unflipped, with no backfill.
    #[must_use]
    pub const fn identity() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            width: 1.0,
            height: 1.0,
            flip_x: false,
            flip_y: false,
            background: CanvasBackground::Transparent,
        }
    }

    /// Resolve a staged crop.
    ///
    /// # Errors
    /// Returns [`CompositorError::UnsupportedSceneInput`] naming the field that was refused: a
    /// non-finite or out-of-range rectangle, a canvas mode that is neither `solid` nor `blur`, a
    /// colour that is not a supported hex colour, or a blur outside the stored range.
    ///
    /// One shape the stored contract accepts is refused here: the four-digit `#rgba` shorthand.
    /// `osg-scene` resolves `#rgb`, `#rrggbb` and `#rrggbbaa` and nothing else, and inventing a
    /// second colour parser in the compositor is exactly the duplication this architecture forbids.
    pub fn resolve(spec: &CropSpec) -> Result<Self, CompositorError> {
        if !bounded(spec.x, -MAX_CROP_OFFSET, MAX_CROP_OFFSET)
            || !bounded(spec.y, -MAX_CROP_OFFSET, MAX_CROP_OFFSET)
            || !bounded(spec.width, MIN_CROP_EXTENT, MAX_CROP_EXTENT)
            || !bounded(spec.height, MIN_CROP_EXTENT, MAX_CROP_EXTENT)
        {
            return Err(Rejection::CropRegion.into());
        }

        Ok(Self {
            left: spec.x / 100.0,
            top: spec.y / 100.0,
            width: spec.width / 100.0,
            height: spec.height / 100.0,
            flip_x: spec.flip_x,
            flip_y: spec.flip_y,
            background: resolve_background(spec)?,
        })
    }

    /// The left edge of the source rectangle, as a fraction of the source width.
    #[must_use]
    pub const fn left(self) -> f64 {
        self.left
    }

    /// The top edge of the source rectangle, as a fraction of the source height.
    #[must_use]
    pub const fn top(self) -> f64 {
        self.top
    }

    /// The width of the source rectangle, as a fraction of the source width.
    #[must_use]
    pub const fn width(self) -> f64 {
        self.width
    }

    /// The height of the source rectangle, as a fraction of the source height.
    #[must_use]
    pub const fn height(self) -> f64 {
        self.height
    }

    /// Whether the cropped region is mirrored horizontally.
    #[must_use]
    pub const fn flip_x(self) -> bool {
        self.flip_x
    }

    /// Whether the cropped region is mirrored vertically.
    #[must_use]
    pub const fn flip_y(self) -> bool {
        self.flip_y
    }

    /// What fills the output where the source rectangle does not reach.
    #[must_use]
    pub const fn background(self) -> CanvasBackground {
        self.background
    }

    /// Whether the source rectangle lies entirely inside the source, so no backfill can show.
    #[must_use]
    pub fn covers_output(self) -> bool {
        self.left >= 0.0
            && self.top >= 0.0
            && self.left + self.width <= 1.0
            && self.top + self.height <= 1.0
    }

    /// The Gaussian kernel half-width in output pixels, or zero when nothing is blurred.
    ///
    /// Never larger than [`MAX_CANVAS_BLUR_RADIUS`], so the per-frame cost of the backfill has a
    /// ceiling that does not depend on what the editor stored.
    #[must_use]
    pub fn blur_radius_px(self) -> u32 {
        let CanvasBackground::Blur { sigma_px } = self.background else {
            return 0;
        };
        // Three standard deviations is where a Gaussian has spent 99.7% of its weight; past that
        // the extra taps change nothing a pixel can hold.
        let radius = (sigma_px * 3.0).ceil();
        if radius <= 0.0 {
            return 0;
        }
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "sigma is clamped to MAX_CANVAS_BLUR_SIGMA, so the radius is small and positive"
        )]
        let radius = radius as u32;
        radius.min(MAX_CANVAS_BLUR_RADIUS)
    }
}

fn resolve_background(spec: &CropSpec) -> Result<CanvasBackground, CompositorError> {
    let Some(mode) = spec.canvas_bg_mode.as_deref() else {
        return Ok(CanvasBackground::Transparent);
    };
    match mode {
        "solid" => {
            let colour = spec
                .canvas_bg_color
                .as_deref()
                .unwrap_or(DEFAULT_CANVAS_COLOR);
            let colour = parse_hex_color(colour).map_err(|_| Rejection::CropCanvasColor)?;
            Ok(CanvasBackground::Solid(colour))
        }
        "blur" => {
            let stored = spec.canvas_bg_blur.unwrap_or(DEFAULT_CANVAS_BLUR);
            if !bounded(stored, 0.0, MAX_STORED_BLUR) {
                return Err(Rejection::CropCanvasBlur.into());
            }
            Ok(CanvasBackground::Blur {
                sigma_px: stored.min(MAX_CANVAS_BLUR_SIGMA),
            })
        }
        _ => Err(Rejection::CropCanvasMode.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{CanvasBackground, Crop, CropSpec, MAX_CANVAS_BLUR_RADIUS, MAX_CANVAS_BLUR_SIGMA};
    use crate::error::{CompositorError, Rejection};

    fn refusal(spec: &CropSpec) -> Rejection {
        match Crop::resolve(spec).expect_err("the spec must be refused") {
            CompositorError::UnsupportedSceneInput { reason } => reason,
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn the_default_spec_is_the_identity_crop() {
        let crop = Crop::resolve(&CropSpec::default()).expect("the default crop resolves");
        assert_eq!(crop, Crop::identity());
        assert!(crop.covers_output());
        assert_eq!(crop.blur_radius_px(), 0);
    }

    #[test]
    fn percentages_become_source_fractions() {
        let crop = Crop::resolve(&CropSpec {
            x: 25.0,
            y: 10.0,
            width: 50.0,
            height: 40.0,
            ..CropSpec::default()
        })
        .expect("an inside-the-source crop resolves");

        assert!((crop.left() - 0.25).abs() < f64::EPSILON);
        assert!((crop.top() - 0.10).abs() < f64::EPSILON);
        assert!((crop.width() - 0.50).abs() < f64::EPSILON);
        assert!((crop.height() - 0.40).abs() < f64::EPSILON);
        assert!(crop.covers_output());
    }

    #[test]
    fn a_region_reaching_past_the_source_does_not_cover_the_output() {
        let crop = Crop::resolve(&CropSpec {
            x: -50.0,
            width: 200.0,
            ..CropSpec::default()
        })
        .expect("an overhanging crop is legal and is what the backfill exists for");
        assert!(!crop.covers_output());
    }

    #[test]
    fn an_out_of_range_region_is_refused() {
        for spec in [
            CropSpec {
                x: f64::NAN,
                ..CropSpec::default()
            },
            CropSpec {
                y: 1_001.0,
                ..CropSpec::default()
            },
            CropSpec {
                width: 0.0,
                ..CropSpec::default()
            },
            CropSpec {
                height: 1_000.5,
                ..CropSpec::default()
            },
        ] {
            assert_eq!(refusal(&spec), Rejection::CropRegion);
        }
    }

    #[test]
    fn the_canvas_mode_vocabulary_is_closed() {
        assert_eq!(
            refusal(&CropSpec {
                canvas_bg_mode: Some("cover".to_owned()),
                ..CropSpec::default()
            }),
            Rejection::CropCanvasMode
        );
    }

    #[test]
    fn a_solid_backfill_defaults_to_black_and_refuses_an_unparseable_colour() {
        let crop = Crop::resolve(&CropSpec {
            canvas_bg_mode: Some("solid".to_owned()),
            ..CropSpec::default()
        })
        .expect("solid with no colour falls back the way the shipped renderer does");
        let CanvasBackground::Solid(colour) = crop.background() else {
            panic!("the background must be solid");
        };
        assert_eq!(
            (colour.red, colour.green, colour.blue, colour.alpha),
            (0, 0, 0, 255)
        );

        assert_eq!(
            refusal(&CropSpec {
                canvas_bg_mode: Some("solid".to_owned()),
                canvas_bg_color: Some("rgb(1,2,3)".to_owned()),
                ..CropSpec::default()
            }),
            Rejection::CropCanvasColor
        );
    }

    #[test]
    fn a_blur_radius_is_bounded_however_large_the_stored_value_is() {
        let clamped = Crop::resolve(&CropSpec {
            canvas_bg_mode: Some("blur".to_owned()),
            canvas_bg_blur: Some(1_000.0),
            ..CropSpec::default()
        })
        .expect("the largest stored blur is accepted, not refused");
        assert_eq!(
            clamped.background(),
            CanvasBackground::Blur {
                sigma_px: MAX_CANVAS_BLUR_SIGMA
            }
        );
        assert_eq!(clamped.blur_radius_px(), MAX_CANVAS_BLUR_RADIUS);

        let zero = Crop::resolve(&CropSpec {
            canvas_bg_mode: Some("blur".to_owned()),
            canvas_bg_blur: Some(0.0),
            ..CropSpec::default()
        })
        .expect("a zero blur is a legal setting");
        assert_eq!(zero.blur_radius_px(), 0);

        assert_eq!(
            refusal(&CropSpec {
                canvas_bg_mode: Some("blur".to_owned()),
                canvas_bg_blur: Some(-1.0),
                ..CropSpec::default()
            }),
            Rejection::CropCanvasBlur
        );
    }
}
