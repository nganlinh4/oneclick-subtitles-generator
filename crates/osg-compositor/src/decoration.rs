//! Stroke, text shadow, glow, border and gradient fill: the decoration the shipped renderer draws.
//!
//! Every value here is one of the fields `src/platform/renderParityLedger.js` listed as pending
//! under *Decoration*, *Box* and *Gradient* — all of them except `borderRadius`, which is a
//! dimension of the box itself and so lives on [`crate::SubtitleStyleSpec`] beside the padding.
//! They are resolved together because they are one paint order rather than five independent
//! switches, and because two of them only make sense next to each other: `gradientEnabled` already
//! makes the text colour transparent and clips the background box away in `osg-scene`, so the fill
//! below has to exist or enabling a gradient would render nothing at all.
//!
//! **What "reproduce" means here.** The shipped renderer is
//! `video-renderer/src/components/SubtitledVideo.tsx`, which builds five CSS declarations:
//!
//! ```text
//! textShadow  = `${x}px ${y}px ${blur}px ${textShadowColor}`      when textShadowEnabled
//! boxShadow   = `0 0 ${glowIntensity}px ${glowColor}`             when glowEnabled
//! border      = `${borderWidth}px ${borderStyle} ${borderColor}`  when width > 0 and style != none
//! WebkitTextStroke = `${strokeWidth}px ${strokeColor}`            when strokeEnabled
//! backgroundImage  = `linear-gradient(${dir}, ${start}, ${end})`  when gradientEnabled
//! ```
//!
//! with every pixel value passed through `scaleSubtitleStyleValue`. Three consequences are copied
//! deliberately rather than improved:
//!
//! - **The glow is a box shadow.** It glows the subtitle box, not the glyphs. Making it a real text
//!   glow would change every existing project that switched it on.
//! - **`textShadowOffsetX` renders and has no editor control.** It stays rendering.
//! - **A CSS blur radius is twice its Gaussian deviation**, so `textShadowBlur: 4` is a deviation of
//!   two, not four. Reading it as the deviation would double every existing shadow.

use osg_scene::color::{Rgba, parse_hex_color};

use crate::blur::gaussian_radius_px;
use crate::error::{CompositorError, Rejection};

/// The largest stroke width the stored contract accepts, in reference pixels.
const MAX_STROKE_WIDTH: f64 = 100.0;
/// The largest border width the stored contract accepts, in reference pixels.
const MAX_BORDER_WIDTH: f64 = 100.0;
/// The largest shadow or glow blur radius the stored contract accepts, in reference pixels.
const MAX_BLUR_RADIUS: f64 = 1_000.0;
/// The largest shadow offset the stored contract accepts, in reference pixels.
const MAX_SHADOW_OFFSET: f64 = 2_000.0;
/// The largest gradient angle the stored contract accepts, in degrees.
const MAX_GRADIENT_DEGREES: u32 = 360;

/// A CSS blur radius is twice the standard deviation of the Gaussian it names.
const CSS_BLUR_TO_SIGMA: f64 = 0.5;

/// The largest blur standard deviation the compositor will actually apply, in output pixels.
///
/// Chosen so nothing the editor's own controls can reach is clamped at 1080p or 1440p: the widest
/// glow the slider offers is 100 reference pixels, which is a deviation of 50 at 1080p and 66 at
/// 1440p. Above that the value is clamped rather than refused, exactly as
/// [`crate::MAX_CANVAS_BLUR_SIGMA`] clamps the canvas backfill, because a stored 1000 is a setting
/// the editor accepts and must keep round-tripping.
pub const MAX_DECORATION_BLUR_SIGMA: f64 = 64.0;

/// The largest decoration kernel half-width, in output pixels. `ceil(3 * MAX_DECORATION_BLUR_SIGMA)`.
pub const MAX_DECORATION_BLUR_RADIUS: u32 = 192;

/// How the border line is drawn between the border box and the padding box.
///
/// `none` is not a variant: the shipped renderer emits no border at all for it, so it is the absent
/// [`Option`] rather than a style that draws nothing.
///
/// **What is and is not reproduced.** `solid` and `double` are defined by CSS itself and are copied
/// exactly: one line filling the width, or two lines of a third with a third between them. The dash
/// metrics of `dashed` and `dotted` are **not** defined by CSS — they are a browser implementation
/// detail, and this crate has no way to measure the pinned Chrome the shipped renderer drew them
/// with. The pattern below is therefore this compositor's own deterministic choice, stated so it can
/// be corrected against a measurement rather than mistaken for one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BorderStyle {
    /// One continuous line filling the whole border width.
    Solid,
    /// Two lines, each a third of the border width, separated by a third.
    Double,
    /// Dashes three widths long, separated by three widths, along the border's centre line.
    Dashed,
    /// Round dots one width across, separated by one width, along the border's centre line.
    Dotted,
}

impl BorderStyle {
    /// Parse the wire name. `none` is [`None`], and anything else is refused.
    fn from_wire(value: &str) -> Result<Option<Self>, CompositorError> {
        Ok(Some(match value {
            "none" => return Ok(None),
            "solid" => Self::Solid,
            "double" => Self::Double,
            "dashed" => Self::Dashed,
            "dotted" => Self::Dotted,
            _ => return Err(Rejection::DecorationBorderStyle.into()),
        }))
    }

    /// The code the shader branches on.
    #[must_use]
    pub const fn shader_code(self) -> f64 {
        match self {
            Self::Solid => 0.0,
            Self::Double => 1.0,
            Self::Dashed => 2.0,
            Self::Dotted => 3.0,
        }
    }
}

/// The glyph outline pass.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stroke {
    /// Width in reference pixels, before resolution scaling.
    pub width: f64,
    /// The stroke colour.
    pub color: Rgba,
}

/// The drop shadow cast by the glyphs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextShadow {
    /// Horizontal offset in reference pixels. Positive is right.
    pub offset_x: f64,
    /// Vertical offset in reference pixels. Positive is down.
    pub offset_y: f64,
    /// The CSS blur radius in reference pixels, which is twice the Gaussian deviation.
    pub blur: f64,
    /// The shadow colour.
    pub color: Rgba,
}

/// The box shadow the editor calls a glow.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glow {
    /// The CSS blur radius in reference pixels, which is twice the Gaussian deviation.
    pub intensity: f64,
    /// The glow colour.
    pub color: Rgba,
}

/// The line drawn around the subtitle box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Border {
    /// Width in reference pixels, before resolution scaling.
    pub width: f64,
    /// The border colour.
    pub color: Rgba,
    /// How the line is patterned.
    pub style: BorderStyle,
}

/// The linear gradient painted through the glyphs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gradient {
    /// The colour at the start of the gradient line.
    pub start: Rgba,
    /// The colour at its end.
    pub end: Rgba,
    /// The CSS angle in degrees: zero points at the top edge and the angle turns clockwise.
    pub degrees: f64,
}

/// What fills the glyphs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FillPaint {
    /// One colour everywhere.
    Solid(Rgba),
    /// A linear ramp across the padding box, sampled through the glyph coverage.
    Gradient(Gradient),
}

/// The decoration exactly as the editor stores it: booleans, strings and reference-pixel numbers.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleDecorationSpec {
    /// Whether the glyph outline is drawn.
    pub stroke_enabled: bool,
    /// Outline width in reference pixels.
    pub stroke_width: f64,
    /// Outline colour as `#rgb`, `#rrggbb` or `#rrggbbaa`.
    pub stroke_color: String,
    /// Whether the glyphs cast a shadow.
    pub text_shadow_enabled: bool,
    /// Shadow colour.
    pub text_shadow_color: String,
    /// Shadow CSS blur radius in reference pixels.
    pub text_shadow_blur: f64,
    /// Shadow horizontal offset in reference pixels. Renders today with no editor control.
    pub text_shadow_offset_x: f64,
    /// Shadow vertical offset in reference pixels.
    pub text_shadow_offset_y: f64,
    /// Whether the box glows.
    pub glow_enabled: bool,
    /// Glow colour.
    pub glow_color: String,
    /// Glow CSS blur radius in reference pixels.
    pub glow_intensity: f64,
    /// Border width in reference pixels.
    pub border_width: f64,
    /// Border colour.
    pub border_color: String,
    /// `none`, `solid`, `dashed`, `dotted` or `double`.
    pub border_style: String,
    /// The colour at the start of the gradient line.
    pub gradient_color_start: String,
    /// The colour at its end.
    pub gradient_color_end: String,
    /// The CSS angle, as `<0..=360>deg`.
    pub gradient_direction: String,
}

impl Default for SubtitleDecorationSpec {
    /// Every effect off.
    ///
    /// Not the editor's saved defaults — those switch the text shadow on — because this is the
    /// undecorated ground a test or a caller builds up from, in the same spirit as
    /// [`crate::SubtitleStyleSpec::default`], which is likewise not the shipped preset.
    fn default() -> Self {
        Self {
            stroke_enabled: false,
            stroke_width: 0.0,
            stroke_color: "#000000".to_owned(),
            text_shadow_enabled: false,
            text_shadow_color: "#000000".to_owned(),
            text_shadow_blur: 4.0,
            text_shadow_offset_x: 0.0,
            text_shadow_offset_y: 2.0,
            glow_enabled: false,
            glow_color: "#ffffff".to_owned(),
            glow_intensity: 10.0,
            border_width: 0.0,
            border_color: "#ffffff".to_owned(),
            border_style: "none".to_owned(),
            gradient_color_start: "#ffffff".to_owned(),
            gradient_color_end: "#cccccc".to_owned(),
            gradient_direction: "45deg".to_owned(),
        }
    }
}

/// A validated decoration. Each effect is present only when it draws something.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SubtitleDecoration {
    stroke: Option<Stroke>,
    text_shadow: Option<TextShadow>,
    glow: Option<Glow>,
    border: Option<Border>,
    gradient: Option<Gradient>,
}

fn bounded(value: f64, low: f64, high: f64) -> bool {
    value.is_finite() && (low..=high).contains(&value)
}

fn colour(value: &str, reason: Rejection) -> Result<Rgba, CompositorError> {
    parse_hex_color(value).map_err(|_| reason.into())
}

impl SubtitleDecoration {
    /// Resolve a staged decoration.
    ///
    /// `gradient_enabled` is not part of the spec because `osg-scene` already consumes it twice —
    /// it is what makes the text colour transparent and what removes the background box — so it
    /// arrives from the style that owns those two decisions rather than being stored a third time.
    ///
    /// An effect whose switch is on but whose size is zero resolves to absent, because that is what
    /// the shipped CSS renders: `0px` of stroke, of border or of glow is nothing at all.
    ///
    /// # Errors
    /// Returns [`CompositorError::UnsupportedSceneInput`] naming the field that was refused: a
    /// width, blur or offset outside the stored range, a colour that is not a supported hex colour,
    /// a border style outside the closed vocabulary, or a gradient direction that is not
    /// `<0..=360>deg`.
    pub fn resolve(
        spec: &SubtitleDecorationSpec,
        gradient_enabled: bool,
    ) -> Result<Self, CompositorError> {
        Ok(Self {
            stroke: Self::stroke(spec)?,
            text_shadow: Self::text_shadow(spec)?,
            glow: Self::glow(spec)?,
            border: Self::border(spec)?,
            gradient: gradient_enabled.then(|| Self::gradient(spec)).transpose()?,
        })
    }

    fn stroke(spec: &SubtitleDecorationSpec) -> Result<Option<Stroke>, CompositorError> {
        if !bounded(spec.stroke_width, 0.0, MAX_STROKE_WIDTH) {
            return Err(Rejection::DecorationStroke.into());
        }
        let color = colour(&spec.stroke_color, Rejection::DecorationStroke)?;
        if !spec.stroke_enabled || spec.stroke_width <= 0.0 {
            return Ok(None);
        }
        Ok(Some(Stroke {
            width: spec.stroke_width,
            color,
        }))
    }

    fn text_shadow(spec: &SubtitleDecorationSpec) -> Result<Option<TextShadow>, CompositorError> {
        if !bounded(spec.text_shadow_blur, 0.0, MAX_BLUR_RADIUS)
            || !bounded(
                spec.text_shadow_offset_x,
                -MAX_SHADOW_OFFSET,
                MAX_SHADOW_OFFSET,
            )
            || !bounded(
                spec.text_shadow_offset_y,
                -MAX_SHADOW_OFFSET,
                MAX_SHADOW_OFFSET,
            )
        {
            return Err(Rejection::DecorationShadow.into());
        }
        let color = colour(&spec.text_shadow_color, Rejection::DecorationShadow)?;
        if !spec.text_shadow_enabled {
            return Ok(None);
        }
        Ok(Some(TextShadow {
            offset_x: spec.text_shadow_offset_x,
            offset_y: spec.text_shadow_offset_y,
            blur: spec.text_shadow_blur,
            color,
        }))
    }

    fn glow(spec: &SubtitleDecorationSpec) -> Result<Option<Glow>, CompositorError> {
        if !bounded(spec.glow_intensity, 0.0, MAX_BLUR_RADIUS) {
            return Err(Rejection::DecorationGlow.into());
        }
        let color = colour(&spec.glow_color, Rejection::DecorationGlow)?;
        if !spec.glow_enabled || spec.glow_intensity <= 0.0 {
            return Ok(None);
        }
        Ok(Some(Glow {
            intensity: spec.glow_intensity,
            color,
        }))
    }

    fn border(spec: &SubtitleDecorationSpec) -> Result<Option<Border>, CompositorError> {
        if !bounded(spec.border_width, 0.0, MAX_BORDER_WIDTH) {
            return Err(Rejection::DecorationBorder.into());
        }
        let color = colour(&spec.border_color, Rejection::DecorationBorder)?;
        let style = BorderStyle::from_wire(&spec.border_style)?;
        // Shipped: the declaration is emitted only when the width is positive *and* the style is
        // not `none`, so either one alone removes the border and with it the box's outer edge.
        let Some(style) = style else {
            return Ok(None);
        };
        if spec.border_width <= 0.0 {
            return Ok(None);
        }
        Ok(Some(Border {
            width: spec.border_width,
            color,
            style,
        }))
    }

    fn gradient(spec: &SubtitleDecorationSpec) -> Result<Gradient, CompositorError> {
        Ok(Gradient {
            start: colour(&spec.gradient_color_start, Rejection::DecorationGradient)?,
            end: colour(&spec.gradient_color_end, Rejection::DecorationGradient)?,
            degrees: parse_degrees(&spec.gradient_direction)?,
        })
    }

    /// The glyph outline, or [`None`] when nothing is stroked.
    #[must_use]
    pub const fn stroke_effect(self) -> Option<Stroke> {
        self.stroke
    }

    /// The glyph drop shadow, or [`None`] when nothing is shadowed.
    #[must_use]
    pub const fn text_shadow_effect(self) -> Option<TextShadow> {
        self.text_shadow
    }

    /// The box glow, or [`None`] when the box does not glow.
    #[must_use]
    pub const fn glow_effect(self) -> Option<Glow> {
        self.glow
    }

    /// The box border, or [`None`] when no line is drawn.
    #[must_use]
    pub const fn border_effect(self) -> Option<Border> {
        self.border
    }

    /// The gradient fill, or [`None`] when the glyphs take a flat colour.
    #[must_use]
    pub const fn gradient_effect(self) -> Option<Gradient> {
        self.gradient
    }
}

/// Parse the `<0..=360>deg` the stored contract accepts, and nothing else.
fn parse_degrees(value: &str) -> Result<f64, CompositorError> {
    let digits = value
        .strip_suffix("deg")
        .ok_or(Rejection::DecorationGradient)?;
    let degrees: u32 = digits
        .parse()
        .map_err(|_| Rejection::DecorationGradient)
        .and_then(|degrees| {
            if degrees <= MAX_GRADIENT_DEGREES {
                Ok(degrees)
            } else {
                Err(Rejection::DecorationGradient)
            }
        })?;
    Ok(f64::from(degrees))
}

/// The applied Gaussian deviation for a CSS blur radius already scaled to output pixels.
///
/// Halved because that is what a CSS blur radius means, then clamped because the stored range is
/// far wider than a bounded kernel.
#[must_use]
pub fn decoration_blur_sigma_px(css_blur_px: f64) -> f64 {
    if !css_blur_px.is_finite() || css_blur_px <= 0.0 {
        return 0.0;
    }
    (css_blur_px * CSS_BLUR_TO_SIGMA).min(MAX_DECORATION_BLUR_SIGMA)
}

/// The kernel half-width for a decoration blur, never larger than
/// [`MAX_DECORATION_BLUR_RADIUS`].
#[must_use]
pub fn decoration_blur_radius_px(sigma_px: f64) -> u32 {
    gaussian_radius_px(sigma_px, MAX_DECORATION_BLUR_RADIUS)
}
