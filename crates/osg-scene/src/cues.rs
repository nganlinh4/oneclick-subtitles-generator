//! Which cue is on screen at an instant, and how far through its fade it is.
//!
//! This reproduces the shipped selection exactly, including two behaviours that are surprising and
//! are therefore called out rather than quietly corrected:
//!
//! * The fade window widens a cue's visibility. A cue is selected from `start - fade_in` until
//!   `end + fade_out`, so it appears before its own start time and lingers past its end.
//! * The first cue whose widened window contains the instant wins, and no other cue is considered.
//!   Overlapping cues therefore disappear rather than stacking, and widening the fade window can
//!   make an earlier cue swallow a later one.
//!
//! Changing either is a visible behaviour change for existing projects, not a bug fix, so both are
//! pinned by tests. Selection is a pure function of the instant, so seeking is exact.

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

/// Select the cue visible at `instant`, reproducing the shipped first-match-wins behaviour.
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

    // Deliberately `find`, not `filter().last()`: the shipped renderer takes the first match and
    // ignores every later overlapping cue.
    let (index, cue) = cues.iter().enumerate().find(|(_, cue)| {
        let start = cue.start.as_seconds_lossy();
        let end = cue.end.as_seconds_lossy();
        now >= start - fade_in && now <= end + fade_out
    })?;

    let start = cue.start.as_seconds_lossy();
    let end = cue.end.as_seconds_lossy();
    let (progress, phase) = if now < start {
        // A zero-length fade window can only be entered exactly at `start`, which is not `< start`,
        // so this division cannot see a zero denominator.
        (((now - (start - fade_in)) / fade_in), CuePhase::FadingIn)
    } else if now > end {
        ((1.0 - (now - end) / fade_out), CuePhase::FadingOut)
    } else {
        (1.0, CuePhase::Holding)
    };

    Some(ActiveCue {
        index,
        progress: progress.clamp(0.0, 1.0),
        phase,
    })
}

fn sanitise_fade(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}
