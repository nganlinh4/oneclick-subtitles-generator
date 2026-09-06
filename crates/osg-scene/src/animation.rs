//! The transform a cue carries at a moment in its fade.
//!
//! A typed transform rather than a CSS string, because the compositor consumes it directly and a
//! string would have to be parsed back. The values match the shipped renderer exactly, including
//! the asymmetries it happens to have: `Scale` animates on the way in and the way out while
//! `Bounce` only animates in, and the slide distances differ between the vertical and horizontal
//! directions.
//!
//! **Unsettled: whether the pixel offsets scale with the composition.** This doc previously
//! asserted that they are authored against the 1080-high reference and scale "like every other
//! size", and the compositor duly runs them through the size scaler. The shipped renderer does not:
//! `getAnimationTransform` emits a raw `translateY(50px)` and that string is applied directly to the
//! subtitle element, while `getResponsiveScaledValue` is applied only to font size, letter spacing,
//! radius, padding, shadows, glow and border. So a slide travels a fixed 50px at every resolution
//! today, and 100 composition pixels at 4K under the native renderer.
//!
//! Scaling is arguably the better behaviour — a 50px slide is half as visible at 4K — but it is a
//! change to how existing projects animate, and it was not decided, it was assumed. `animationType`
//! is `pending` in the parity ledger; this is one of the things that has to be settled before it
//! can move. The golden fixture carries no animation samples, so nothing currently catches it.

use crate::cues::CuePhase;
use crate::easing::apply_subtitle_animation_easing;

/// The animations the editor offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnimationType {
    /// No transform at any phase.
    None,
    /// Rises into place, and on the way out continues upward.
    SlideUp,
    /// Drops into place, and on the way out continues downward.
    SlideDown,
    /// Enters from the right, exits to the left.
    SlideLeft,
    /// Enters from the left, exits to the right.
    SlideRight,
    /// Grows from half size, and shrinks again on the way out.
    Scale,
    /// Overshoots on the way in only.
    Bounce,
    /// Rotates about the vertical axis.
    Flip,
    /// Rotates in the plane.
    Rotate,
    /// Reveals the text progressively; carries no transform.
    Typewriter,
    /// Reveals words sequentially; carries no transform.
    WordReveal,
    /// Highlights the active word; carries no transform.
    WordHighlight,
}

impl AnimationType {
    /// Parse the wire name, returning `None` for anything unrecognised so the caller can refuse
    /// rather than silently animate differently.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "none" => Self::None,
            "slide-up" => Self::SlideUp,
            "slide-down" => Self::SlideDown,
            "slide-left" => Self::SlideLeft,
            "slide-right" => Self::SlideRight,
            "scale" => Self::Scale,
            "bounce" => Self::Bounce,
            "flip" => Self::Flip,
            "rotate" => Self::Rotate,
            "typewriter" => Self::Typewriter,
            "word-reveal" => Self::WordReveal,
            "word-highlight" => Self::WordHighlight,
            _ => return None,
        })
    }
}

/// A cue's transform at an instant, in composition pixels and degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CueTransform {
    /// Horizontal offset in reference pixels; positive is right.
    pub translate_x: f64,
    /// Vertical offset in reference pixels; positive is down.
    pub translate_y: f64,
    /// Uniform scale about the centre.
    pub scale: f64,
    /// In-plane rotation in degrees.
    pub rotate_degrees: f64,
    /// Rotation about the vertical axis in degrees.
    pub rotate_y_degrees: f64,
}

impl CueTransform {
    /// The transform that changes nothing.
    pub const IDENTITY: Self = Self {
        translate_x: 0.0,
        translate_y: 0.0,
        scale: 1.0,
        rotate_degrees: 0.0,
        rotate_y_degrees: 0.0,
    };
}

/// The transform for `animation` at `progress` within `phase`.
///
/// `progress` is the cue's fade progress; it is eased by `easing` first, matching the shipped
/// renderer, so the easing choice affects the motion and not only the opacity.
#[must_use]
pub fn cue_transform(
    animation: AnimationType,
    phase: CuePhase,
    progress: f64,
    easing: &str,
) -> CueTransform {
    let eased = apply_subtitle_animation_easing(progress, easing);
    let remaining = 1.0 - eased;
    let entering = matches!(phase, CuePhase::FadingIn);
    let leaving = matches!(phase, CuePhase::FadingOut);

    match animation {
        AnimationType::SlideUp => CueTransform {
            translate_y: slide(entering, leaving, remaining, 50.0, -50.0),
            ..CueTransform::IDENTITY
        },
        AnimationType::SlideDown => CueTransform {
            translate_y: slide(entering, leaving, remaining, -50.0, 50.0),
            ..CueTransform::IDENTITY
        },
        AnimationType::SlideLeft => CueTransform {
            translate_x: slide(entering, leaving, remaining, 100.0, -100.0),
            ..CueTransform::IDENTITY
        },
        AnimationType::SlideRight => CueTransform {
            translate_x: slide(entering, leaving, remaining, -100.0, 100.0),
            ..CueTransform::IDENTITY
        },
        // Deliberately symmetric: unlike bounce, scale animates on both edges.
        AnimationType::Scale if entering || leaving => CueTransform {
            scale: 0.5 + (eased * 0.5),
            ..CueTransform::IDENTITY
        },
        // Deliberately asymmetric: the shipped renderer only bounces on the way in.
        AnimationType::Bounce if entering => CueTransform {
            scale: (eased * core::f64::consts::PI * 3.0)
                .sin()
                .mul_add(0.1 * remaining, 1.0),
            ..CueTransform::IDENTITY
        },
        AnimationType::Flip => CueTransform {
            rotate_y_degrees: slide(entering, leaving, remaining, 90.0, -90.0),
            ..CueTransform::IDENTITY
        },
        AnimationType::Rotate => CueTransform {
            rotate_degrees: slide(entering, leaving, remaining, 180.0, -180.0),
            ..CueTransform::IDENTITY
        },
        // Every remaining case holds still: animations with no transform at all, and
        // those whose guarded arms above did not apply in this phase.
        AnimationType::None
        | AnimationType::Typewriter
        | AnimationType::WordReveal
        | AnimationType::WordHighlight
        | AnimationType::Scale
        | AnimationType::Bounce => CueTransform::IDENTITY,
    }
}

fn slide(entering: bool, leaving: bool, remaining: f64, on_enter: f64, on_leave: f64) -> f64 {
    if entering {
        remaining * on_enter
    } else if leaving {
        remaining * on_leave
    } else {
        0.0
    }
}

/// How much of a cue's text the typewriter has revealed.
///
/// Reproduces the shipped truncation exactly, including that it counts UTF-16 code units — so a
/// character outside the basic plane can be split — and that it reveals nothing at zero progress.
/// The caller is responsible for not slicing a surrogate pair when it turns this into text.
#[must_use]
pub fn typewriter_utf16_length(text_utf16_len: usize, progress: f64) -> usize {
    if !progress.is_finite() || progress <= 0.0 {
        return 0;
    }
    if progress >= 1.0 {
        return text_utf16_len;
    }
    #[expect(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "reproduces the shipped Math.floor(length * progress) exactly"
    )]
    let revealed = (text_utf16_len as f64 * progress).floor() as usize;
    revealed.min(text_utf16_len)
}
