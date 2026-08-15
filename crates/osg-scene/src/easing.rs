//! Subtitle animation easing.
//!
//! A deliberate twin of the shipped TypeScript implementation, locked to it by a generated golden
//! fixture rather than by inspection. Two properties here are surprising and are reproduced on
//! purpose: `ease` and `ease-in-out` are the same quadratic and neither is the CSS `ease` curve,
//! and any unrecognised easing falls through to linear.

/// The reviewed easing catalog, in the order the editor presents it.
pub const SUBTITLE_ANIMATION_EASINGS: [&str; 7] = [
    "linear",
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
    "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
];

const SMOOTH_EASING: &str = SUBTITLE_ANIMATION_EASINGS[5];
const BOUNCE_EASING: &str = SUBTITLE_ANIMATION_EASINGS[6];
const BISECTION_STEPS: usize = 40;

fn cubic_coordinate(parameter: f64, first: f64, second: f64) -> f64 {
    let inverse = 1.0 - parameter;
    (3.0 * inverse * inverse * parameter * first)
        + (3.0 * inverse * parameter * parameter * second)
        + (parameter * parameter * parameter)
}

/// CSS cubic-bezier timing treats progress as x, not as the curve parameter. The reviewed curves
/// have monotonic x control points, so a fixed-step bisection is deterministic and seek-safe for
/// both preview and export.
#[allow(
    clippy::manual_midpoint,
    reason = "f64::midpoint is a different computation; bit-exact parity needs this expression"
)]
fn evaluate_cubic_bezier(progress: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    if progress <= 0.0 {
        return 0.0;
    }
    if progress >= 1.0 {
        return 1.0;
    }
    let mut lower = 0.0_f64;
    let mut upper = 1.0_f64;
    for _ in 0..BISECTION_STEPS {
        let parameter = (lower + upper) / 2.0;
        if cubic_coordinate(parameter, x1, x2) < progress {
            lower = parameter;
        } else {
            upper = parameter;
        }
    }
    cubic_coordinate((lower + upper) / 2.0, y1, y2)
}

/// Ease `progress` by the named curve. Unknown curves are linear, matching the shipped behaviour.
#[must_use]
pub fn apply_subtitle_animation_easing(progress: f64, easing: &str) -> f64 {
    match easing {
        "ease-in" => progress * progress,
        "ease-out" => 1.0 - (1.0 - progress).powi(2),
        // Not a mistake: the shipped implementation maps both to the same quadratic.
        "ease" | "ease-in-out" => {
            if progress < 0.5 {
                2.0 * progress * progress
            } else {
                1.0 - (-2.0 * progress + 2.0).powi(2) / 2.0
            }
        }
        SMOOTH_EASING => evaluate_cubic_bezier(progress, 0.25, 0.46, 0.45, 0.94),
        BOUNCE_EASING => evaluate_cubic_bezier(progress, 0.68, -0.55, 0.265, 1.55),
        _ => progress,
    }
}
