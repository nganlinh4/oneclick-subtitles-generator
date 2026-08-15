//! Colour resolution, and the place where the shipped renderer loses a user's background.
//!
//! The background colour is built by appending the opacity to the colour string as two hex digits.
//! That works for the `#rrggbb` the colour picker produces, but every validator in the chain also
//! accepts `#rrggbbaa` — and appending to one of those yields a ten-digit colour that no renderer
//! understands, so the background silently disappears while every other style still applies.
//!
//! This module reproduces the composition faithfully and reports the failure instead of hiding it,
//! so the caller can decide. Returning a typed refusal rather than a transparent background is the
//! one deliberate improvement: the pixels are unchanged, but the cause becomes visible.

/// A straight 8-bit RGBA colour. The renderer works in these; strings stop at this boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgba {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
    /// Alpha channel, where 255 is opaque.
    pub alpha: u8,
}

impl Rgba {
    /// Fully transparent.
    pub const TRANSPARENT: Self = Self {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 0,
    };
}

/// Why a colour could not be resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorError {
    /// The string is not a `#rgb`, `#rrggbb` or `#rrggbbaa` colour.
    Unrecognised,
    /// The colour already carried its own alpha, so the opacity setting cannot be applied to it.
    ///
    /// The shipped renderer produces a ten-digit colour here and the background vanishes with no
    /// message. Surfacing it changes nothing on screen but makes the cause findable.
    AlreadyHasAlpha,
}

impl core::fmt::Display for ColorError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let message = match self {
            Self::Unrecognised => "the colour is not a supported hex colour",
            Self::AlreadyHasAlpha => {
                "the colour already carries an alpha channel, so the opacity cannot be applied"
            }
        };
        formatter.write_str(message)
    }
}

impl core::error::Error for ColorError {}

/// Parse `#rgb`, `#rrggbb` or `#rrggbbaa`. Anything else is refused.
///
/// # Errors
/// Returns [`ColorError::Unrecognised`] for any other shape.
pub fn parse_hex_color(value: &str) -> Result<Rgba, ColorError> {
    let digits = value.strip_prefix('#').ok_or(ColorError::Unrecognised)?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ColorError::Unrecognised);
    }
    let channel =
        |index: usize| -> Option<u8> { u8::from_str_radix(digits.get(index..index + 2)?, 16).ok() };
    match digits.len() {
        // `#rgb` and `#rgba`. The four-digit form is accepted because every validator in the
        // persistence chain accepts it, so a hand-edited or third-party project can carry one, and
        // refusing it here would fail an entire render over a colour the schema calls valid.
        // Nothing in the application emits it: all 139 colours across the defaults and the 30
        // shipped presets are six digits.
        3 | 4 => {
            let mut channels = [255_u8; 4];
            for (slot, digit) in channels.iter_mut().zip(digits.bytes()) {
                let value = char::from(digit)
                    .to_digit(16)
                    .and_then(|value| u8::try_from(value).ok())
                    .ok_or(ColorError::Unrecognised)?;
                // The shorthand repeats each digit, so #abc is #aabbcc and #abcd is #aabbccdd.
                *slot = value * 17;
            }
            Ok(Rgba {
                red: channels[0],
                green: channels[1],
                blue: channels[2],
                alpha: channels[3],
            })
        }
        6 | 8 => Ok(Rgba {
            red: channel(0).ok_or(ColorError::Unrecognised)?,
            green: channel(2).ok_or(ColorError::Unrecognised)?,
            blue: channel(4).ok_or(ColorError::Unrecognised)?,
            alpha: if digits.len() == 8 {
                channel(6).ok_or(ColorError::Unrecognised)?
            } else {
                255
            },
        }),
        _ => Err(ColorError::Unrecognised),
    }
}

/// The alpha byte the shipped renderer appends for a given opacity.
///
/// Reproduced exactly, rounding included: opacity is a 0-100 percentage scaled by 2.55 and rounded
/// to the nearest integer. Note which way that lands at half opacity — 2.55 is not representable in
/// binary floating point, so `50 * 2.55` is 127.49999999999999 and rounds **down to 127**, not up
/// to 128. Half opacity is a shade more transparent than half.
///
/// Do not "correct" this to 128. The rounding is not a defect to fix here; it is the behaviour every
/// already-saved project was rendered with, and changing it would shift each of their backgrounds by
/// one alpha level.
#[must_use]
pub fn opacity_to_alpha_byte(opacity: f64) -> u8 {
    if !opacity.is_finite() || opacity <= 0.0 {
        return 0;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "reproduces the shipped Math.round(opacity * 2.55) exactly"
    )]
    let rounded = (opacity * 2.55).round() as i64;
    u8::try_from(rounded.clamp(0, 255)).unwrap_or(255)
}

/// Resolve the subtitle background from its colour and opacity setting.
///
/// A zero or negative opacity is transparent, matching the shipped behaviour of not emitting a
/// background at all.
///
/// # Errors
/// Returns [`ColorError::AlreadyHasAlpha`] when the colour already carries alpha — the case where
/// the shipped renderer silently loses the background — and [`ColorError::Unrecognised`] when the
/// colour cannot be parsed.
pub fn resolve_background(color: &str, opacity: f64) -> Result<Rgba, ColorError> {
    if !opacity.is_finite() || opacity <= 0.0 {
        return Ok(Rgba::TRANSPARENT);
    }
    let digits = color.strip_prefix('#').ok_or(ColorError::Unrecognised)?;
    // Both alpha-carrying shapes are refused, and they fail differently in the shipped renderer.
    // Appending two digits to `#rrggbbaa` yields a ten-digit colour nothing understands, so the
    // background vanishes. Appending them to `#rgba` yields `#rgbaXX` — six digits, perfectly
    // valid, and a completely different colour drawn with no hint that anything went wrong. The
    // second is the worse of the two, which is why neither is silently accepted here.
    if digits.len() == 8 || digits.len() == 4 {
        return Err(ColorError::AlreadyHasAlpha);
    }
    let parsed = parse_hex_color(color)?;
    Ok(Rgba {
        alpha: opacity_to_alpha_byte(opacity),
        ..parsed
    })
}

/// The text colour, accounting for gradient fill.
///
/// When a gradient is enabled the shipped renderer sets the text colour to transparent and paints
/// the gradient through the glyphs. It also clips the background box away in the process, which is
/// why enabling a gradient appears to delete a user's subtitle background.
///
/// # Errors
/// Returns [`ColorError::Unrecognised`] when the colour cannot be parsed.
pub fn resolve_text_color(color: &str, gradient_enabled: bool) -> Result<Rgba, ColorError> {
    if gradient_enabled {
        return Ok(Rgba::TRANSPARENT);
    }
    parse_hex_color(color)
}

/// Whether the background box survives the current settings.
///
/// Reproduces the interaction rather than the mechanism: clipping the paint to the glyphs removes
/// the box as well, so a gradient and a background cannot both be visible.
#[must_use]
pub const fn background_survives_gradient(gradient_enabled: bool) -> bool {
    !gradient_enabled
}
