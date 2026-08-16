//! The subtitle style, resolved once so a frame never re-parses a string.
//!
//! Every derivation here is delegated to `osg-scene`: colours through [`osg_scene::color`],
//! positions and alignments through [`osg_scene::layout`], animations through
//! [`osg_scene::animation`], easings through the reviewed catalog. This module contributes bounds
//! and nothing else, because a second copy of any of that maths is exactly how the preview and the
//! export drifted apart in the first place.
//!
//! One deliberate difference from the shipped renderer: an unrecognised easing is refused here
//! rather than silently falling through to linear. The pixels for a *recognised* easing are
//! unchanged; only the unrecognised case stops being invisible.

use osg_scene::animation::AnimationType;
use osg_scene::color::{
    Rgba, background_survives_gradient, resolve_background, resolve_text_color,
};
use osg_scene::easing::SUBTITLE_ANIMATION_EASINGS;
use osg_scene::layout::{Margins, SubtitlePosition, TextAlign};

use crate::decoration::{FillPaint, SubtitleDecoration, SubtitleDecorationSpec};
use crate::error::{CompositorError, Rejection};

/// The largest reference-pixel size any style value may carry.
const MAX_STYLE_PIXELS: f64 = 4_096.0;
/// The largest fade window, in seconds.
const MAX_FADE_SECONDS: f64 = 60.0;
/// The line spacing multiplier range.
const MIN_LINE_SPACING: f64 = 0.1;
const MAX_LINE_SPACING: f64 = 10.0;
/// The largest margin magnitude, in reference pixels.
///
/// This is the render contract's own `-10000..=10000`, magnitude and sign both. A negative margin
/// is not nonsense: the shipped renderer emits it as a CSS percentage and lays the box outside the
/// composition, which is how a caption is bled off an edge. Refusing it here would make a project
/// the editor saved, and once drew, impossible to export.
const MAX_MARGIN_PIXELS: f64 = 10_000.0;
/// The largest custom-placement magnitude, as a percentage of the composition.
///
/// The render contract accepts `-1000..=1000` and the shipped renderer draws it verbatim as
/// `left: ${customPositionX}%`, so anything inside that range has already been on a user's screen.
/// A value outside `0..=100` places the cue off-composition, which is exactly what it asks for.
const MAX_CUSTOM_PLACEMENT_PERCENT: f64 = 1_000.0;

/// The style exactly as the editor stores it: strings and reference-pixel numbers, unvalidated.
///
/// Sizes are authored against a 1080-high composition and are scaled by
/// [`osg_scene::scale_subtitle_style_value`] at render time; margins are not, because the shipped
/// renderer converts them to a fixed 1920x1080 percentage instead. Both rules are reproduced by
/// `osg-scene`, not here.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleStyleSpec {
    /// Font size in reference pixels.
    pub font_size: f64,
    /// The persisted `lineHeight` multiplier.
    ///
    /// **Validated and carried, never applied here.** The baker owns line height: it bakes the
    /// atlas at `fontSizePx * lineHeight` and derives every baseline from that, so the compositor
    /// reads the baselines and multiplies nothing. It is kept on the style because the staging
    /// boundary needs it to choose the bake — which also means a change to it invalidates the
    /// atlas, exactly as a change to the family or the size does.
    pub line_spacing: f64,
    /// Text colour as `#rgb`, `#rrggbb` or `#rrggbbaa`.
    pub text_color: String,
    /// Whether the gradient fill is on. It makes the text colour transparent and, as shipped, takes
    /// the background box with it.
    pub gradient_enabled: bool,
    /// Background colour as `#rgb` or `#rrggbb`.
    pub background_color: String,
    /// Background opacity as a 0-100 percentage, appended to the colour as shipped.
    pub background_opacity: f64,
    /// Horizontal padding between the text and the background box, in reference pixels.
    pub background_padding_x: f64,
    /// Vertical padding between the text and the background box, in reference pixels.
    pub background_padding_y: f64,
    /// Corner radius of the **border box** in reference pixels.
    ///
    /// CSS `border-radius` names the outer edge, so the padding box inside a border is rounded by
    /// this less the border width. With no border the two are the same rectangle.
    pub border_radius: f64,
    /// Where the box is anchored: `bottom`, `top`, `center` or `custom`.
    pub position: String,
    /// Margins in reference pixels, in `-10000..=10000`.
    ///
    /// Negative is accepted and drawn: it lays the box outside the composition, which is what the
    /// shipped renderer does with the negative percentage it emits.
    pub margins: Margins,
    /// Horizontal placement as a percentage of the composition, in `-1000..=1000`, used only when
    /// `position` is `custom`.
    ///
    /// Outside `0..=100` the cue is placed off-composition, which is what `left: ${custom_x}%`
    /// does in the shipped renderer.
    pub custom_x: f64,
    /// Vertical placement as a percentage of the composition, in `-1000..=1000`, used only when
    /// `position` is `custom`.
    pub custom_y: f64,
    /// How lines align inside the box: `left`, `center`, `right` or `justify`.
    pub text_align: String,
    /// The animation name, as [`AnimationType::from_wire`] accepts it.
    pub animation: String,
    /// One of [`SUBTITLE_ANIMATION_EASINGS`].
    pub easing: String,
    /// Fade-in window in seconds. It widens the cue's visibility before its own start.
    pub fade_in: f64,
    /// Fade-out window in seconds. It widens the cue's visibility past its own end.
    pub fade_out: f64,
    /// A flat multiplier on the whole cue, in `0.0..=1.0`.
    pub opacity: f64,
    /// Stroke, shadow, glow, border and the gradient stops.
    pub decoration: SubtitleDecorationSpec,
}

impl Default for SubtitleStyleSpec {
    fn default() -> Self {
        Self {
            font_size: 24.0,
            line_spacing: 1.2,
            text_color: "#ffffff".to_owned(),
            gradient_enabled: false,
            background_color: "#000000".to_owned(),
            background_opacity: 50.0,
            background_padding_x: 20.0,
            background_padding_y: 10.0,
            border_radius: 4.0,
            position: "bottom".to_owned(),
            margins: Margins {
                bottom: 80.0,
                top: 80.0,
                left: 100.0,
                right: 100.0,
            },
            custom_x: 50.0,
            custom_y: 50.0,
            text_align: "center".to_owned(),
            animation: "none".to_owned(),
            easing: "ease".to_owned(),
            fade_in: 0.3,
            fade_out: 0.3,
            opacity: 1.0,
            decoration: SubtitleDecorationSpec::default(),
        }
    }
}

/// A validated style. Every string has become a typed value and every number is in range.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleStyle {
    font_size: f64,
    line_spacing: f64,
    text_color: Rgba,
    background: Rgba,
    background_visible: bool,
    background_padding_x: f64,
    background_padding_y: f64,
    border_radius: f64,
    position: SubtitlePosition,
    margins: Margins,
    custom_x: f64,
    custom_y: f64,
    align: TextAlign,
    animation: AnimationType,
    easing: String,
    fade_in: f64,
    fade_out: f64,
    opacity: f64,
    decoration: SubtitleDecoration,
}

fn bounded(value: f64, low: f64, high: f64) -> bool {
    value.is_finite() && (low..=high).contains(&value)
}

impl SubtitleStyle {
    /// Resolve a staged style.
    ///
    /// # Errors
    /// Returns [`CompositorError::UnsupportedSceneInput`] naming the field that was refused. In
    /// particular a background colour that already carries its own alpha is refused rather than
    /// silently disappearing, which is what the shipped renderer does with it.
    pub fn resolve(spec: &SubtitleStyleSpec) -> Result<Self, CompositorError> {
        if !bounded(spec.font_size, 1.0, MAX_STYLE_PIXELS) {
            return Err(Rejection::StyleFontSize.into());
        }
        if !bounded(spec.line_spacing, MIN_LINE_SPACING, MAX_LINE_SPACING) {
            return Err(Rejection::StyleLineSpacing.into());
        }
        Self::check_geometry(spec)?;
        if !bounded(spec.fade_in, 0.0, MAX_FADE_SECONDS)
            || !bounded(spec.fade_out, 0.0, MAX_FADE_SECONDS)
        {
            return Err(Rejection::StyleTiming.into());
        }
        if !bounded(spec.opacity, 0.0, 1.0) {
            return Err(Rejection::StyleOpacity.into());
        }

        let position =
            SubtitlePosition::from_wire(&spec.position).ok_or(Rejection::StylePosition)?;
        let align = TextAlign::from_wire(&spec.text_align).ok_or(Rejection::StyleAlign)?;
        let animation =
            AnimationType::from_wire(&spec.animation).ok_or(Rejection::StyleAnimation)?;
        if !SUBTITLE_ANIMATION_EASINGS.contains(&spec.easing.as_str()) {
            return Err(Rejection::StyleEasing.into());
        }

        if !bounded(spec.background_opacity, 0.0, 100.0) {
            return Err(Rejection::StyleBackground.into());
        }
        let background = resolve_background(&spec.background_color, spec.background_opacity)
            .map_err(|_| Rejection::StyleBackground)?;
        let text_color = resolve_text_color(&spec.text_color, spec.gradient_enabled)
            .map_err(|_| Rejection::StyleColor)?;

        Ok(Self {
            font_size: spec.font_size,
            line_spacing: spec.line_spacing,
            text_color,
            background,
            background_visible: background.alpha > 0
                && background_survives_gradient(spec.gradient_enabled),
            background_padding_x: spec.background_padding_x,
            background_padding_y: spec.background_padding_y,
            border_radius: spec.border_radius,
            position,
            margins: spec.margins,
            custom_x: spec.custom_x,
            custom_y: spec.custom_y,
            align,
            animation,
            easing: spec.easing.clone(),
            fade_in: spec.fade_in,
            fade_out: spec.fade_out,
            opacity: spec.opacity,
            decoration: SubtitleDecoration::resolve(&spec.decoration, spec.gradient_enabled)?,
        })
    }

    /// Bounds the geometry three ways, because the three answer to different authorities.
    ///
    /// Padding and radius are non-negative sizes: a negative one has no drawing to describe. The
    /// margins and the custom placement are *offsets*, and their range is the render contract's,
    /// sign included — see [`MAX_MARGIN_PIXELS`] and [`MAX_CUSTOM_PLACEMENT_PERCENT`]. A bound
    /// narrower than the contract's would make a persisted project unexportable, which is the one
    /// failure this crate cannot have.
    fn check_geometry(spec: &SubtitleStyleSpec) -> Result<(), CompositorError> {
        let sizes = [
            spec.background_padding_x,
            spec.background_padding_y,
            spec.border_radius,
        ];
        let margins = [
            spec.margins.bottom,
            spec.margins.top,
            spec.margins.left,
            spec.margins.right,
        ];
        let placements = [spec.custom_x, spec.custom_y];
        let ok = sizes
            .iter()
            .all(|value| bounded(*value, 0.0, MAX_STYLE_PIXELS))
            && margins
                .iter()
                .all(|value| bounded(*value, -MAX_MARGIN_PIXELS, MAX_MARGIN_PIXELS))
            && placements.iter().all(|value| {
                bounded(
                    *value,
                    -MAX_CUSTOM_PLACEMENT_PERCENT,
                    MAX_CUSTOM_PLACEMENT_PERCENT,
                )
            });
        if ok {
            Ok(())
        } else {
            Err(Rejection::StyleGeometry.into())
        }
    }

    /// The font size in reference pixels, before resolution scaling.
    #[must_use]
    pub const fn font_size(&self) -> f64 {
        self.font_size
    }

    /// The persisted `lineHeight` multiplier, for the boundary that bakes the atlas.
    ///
    /// The compositor does not apply it; see [`SubtitleStyleSpec::line_spacing`].
    #[must_use]
    pub const fn line_spacing(&self) -> f64 {
        self.line_spacing
    }

    /// The resolved text colour. Transparent when the gradient fill is on.
    #[must_use]
    pub const fn text_color(&self) -> Rgba {
        self.text_color
    }

    /// The resolved background colour, including the opacity byte.
    #[must_use]
    pub const fn background(&self) -> Rgba {
        self.background
    }

    /// Whether the background box survives the current settings.
    #[must_use]
    pub const fn background_visible(&self) -> bool {
        self.background_visible
    }

    /// Horizontal padding in reference pixels.
    #[must_use]
    pub const fn background_padding_x(&self) -> f64 {
        self.background_padding_x
    }

    /// Vertical padding in reference pixels.
    #[must_use]
    pub const fn background_padding_y(&self) -> f64 {
        self.background_padding_y
    }

    /// Corner radius in reference pixels.
    #[must_use]
    pub const fn border_radius(&self) -> f64 {
        self.border_radius
    }

    /// Where the box is anchored.
    #[must_use]
    pub const fn position(&self) -> SubtitlePosition {
        self.position
    }

    /// The margins in reference pixels.
    #[must_use]
    pub const fn margins(&self) -> Margins {
        self.margins
    }

    /// Custom horizontal placement, as a percentage of the composition.
    #[must_use]
    pub const fn custom_x(&self) -> f64 {
        self.custom_x
    }

    /// Custom vertical placement, as a percentage of the composition.
    #[must_use]
    pub const fn custom_y(&self) -> f64 {
        self.custom_y
    }

    /// How lines align inside the box.
    #[must_use]
    pub const fn align(&self) -> TextAlign {
        self.align
    }

    /// The animation the cue carries.
    #[must_use]
    pub const fn animation(&self) -> AnimationType {
        self.animation
    }

    /// The reviewed easing curve name.
    #[must_use]
    pub fn easing(&self) -> &str {
        &self.easing
    }

    /// The fade-in window in seconds.
    #[must_use]
    pub const fn fade_in(&self) -> f64 {
        self.fade_in
    }

    /// The fade-out window in seconds.
    #[must_use]
    pub const fn fade_out(&self) -> f64 {
        self.fade_out
    }

    /// The flat opacity multiplier applied to the whole cue.
    #[must_use]
    pub const fn opacity(&self) -> f64 {
        self.opacity
    }

    /// The resolved stroke, shadow, glow, border and gradient.
    #[must_use]
    pub const fn decoration(&self) -> SubtitleDecoration {
        self.decoration
    }

    /// What fills the glyphs.
    ///
    /// The gradient wins when it is enabled, which is the whole reason the two must ship together:
    /// `osg-scene` has already made [`SubtitleStyle::text_color`] transparent by then, so a caller
    /// that consulted the colour alone would draw nothing.
    #[must_use]
    pub const fn fill(&self) -> FillPaint {
        match self.decoration.gradient_effect() {
            Some(gradient) => FillPaint::Gradient(gradient),
            None => FillPaint::Solid(self.text_color),
        }
    }
}
