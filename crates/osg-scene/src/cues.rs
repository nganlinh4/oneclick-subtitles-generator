//! Which cue is on screen at an instant, and how far through its fade it is.
//!
//! Fade windows are allowed to overlap, but they must never hide authored subtitle time:
//!
//! * The fade window widens a cue's visibility. A cue is selected from `start - fade_in` until
//!   `end + fade_out`, so it appears before its own start time and lingers past its end.
//! * A cue inside its authored `start..=end` interval outranks every widened fade window. When only
//!   fades overlap in a real gap, the more opaque cue wins (with list order as a stable tie-break).
//!
//! This keeps selection single-cue and deterministic while preventing an outgoing zero-opacity cue
//! from swallowing the next live cue—the playback blink caused by the former first-match rule.

use crate::timeline::ExactTime;

/// A subtitle cue on the timeline. Text is carried by the caller; this module only decides timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CueTiming {
    /// When the cue's own text begins.
    pub start: ExactTime,
    /// When the cue's own text ends.
    pub end: ExactTime,
}

/// The phase a selected cue is in at an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CuePhase {
    /// Before the cue's start, inside the fade-in window.
    FadingIn,
    /// Between start and end.
    Holding,
    /// After the cue's end, inside the fade-out window.
    FadingOut,
}

/// The selected cue at an instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ActiveCue {
    /// Index into the caller's cue list, so the caller keeps ownership of the text.
    pub index: usize,
    /// Fade progress, clamped to `0.0..=1.0`. Feed this to the easing curve, not to layout.
    pub progress: f64,
    /// Which side of the cue the instant falls on.
    pub phase: CuePhase,
}

/// Select the strongest cue visible at `instant`.
///
/// `fade_in` and `fade_out` are in seconds and are clamped at zero; a non-finite or negative value
/// is treated as zero rather than widening the window unpredictably.
#[must_use]
pub fn active_cue_at(
    cues: &[CueTiming],
    instant: ExactTime,
    fade_in: f64,
    fade_out: f64,
) -> Option<ActiveCue> {
    let fade_in = sanitise_fade(fade_in);
    let fade_out = sanitise_fade(fade_out);
    let now = instant.as_seconds_lossy();

    let mut strongest_fade = None;
    for (index, cue) in cues.iter().enumerate() {
        let start = cue.start.as_seconds_lossy();
        let end = cue.end.as_seconds_lossy();
        if now >= start && now <= end {
            return Some(ActiveCue {
                index,
                progress: 1.0,
                phase: CuePhase::Holding,
            });
        }

        let candidate = if fade_in > 0.0 && now >= start - fade_in && now < start {
            Some(ActiveCue {
                index,
                progress: ((now - (start - fade_in)) / fade_in).clamp(0.0, 1.0),
                phase: CuePhase::FadingIn,
            })
        } else if fade_out > 0.0 && now > end && now <= end + fade_out {
            Some(ActiveCue {
                index,
                progress: (1.0 - (now - end) / fade_out).clamp(0.0, 1.0),
                phase: CuePhase::FadingOut,
            })
        } else {
            None
        };
        if let Some(candidate) = candidate
            && strongest_fade.is_none_or(|current: ActiveCue| candidate.progress > current.progress)
        {
            strongest_fade = Some(candidate);
        }
    }
    strongest_fade
}

fn sanitise_fade(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}
