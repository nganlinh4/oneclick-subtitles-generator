//! The two timelines an export walks, and the two parity decisions that live in them.
//!
//! Both decisions are recorded in `src/platform/renderParityLedger.js` as deliberate visible
//! changes, and both are implemented here rather than anywhere else, so a reviewer reads one file
//! to check them.
//!
//! # `trimStart` — the cues are rebased
//!
//! The shipped renderer trims the video with `FFmpeg -ss` but passes cue timestamps absolute and
//! never rebases them, so any `trimStart` above zero shifts every subtitle in the exported file by
//! exactly that much. Here the scene's timeline starts at zero and every cue is moved back by
//! `trimStart`: a cue at absolute `t` lands at `t - trimStart`, which is where the editor showed
//! it. Cues that fall entirely before the trim point are kept rather than dropped, at negative
//! times: they are never selected, except through the fade-out window that legitimately lets a cue
//! ending just before the trim point linger into the first frames — which is exactly what the
//! editor shows at that instant.
//!
//! The narration track is rebased by the same window, in `super::audio`. It is generated from the
//! same absolute cue times, so leaving it un-rebased while the subtitles move would desynchronise
//! the two halves of the same sentence.
//!
//! # `DURATION_SOURCE` — the length comes from the timeline
//!
//! The shipped renderer takes the final duration from however many frames extraction happened to
//! produce, overriding the computed one, so the output length depends on the extractor's behaviour
//! rather than on the timeline the user set. Here the frame count is
//! [`RenderPlan::duration_frames`] — `ceil((trimEnd - trimStart) * fps)` — and it is the frame
//! count of the scene timeline, of the source timeline, of the encoder configuration and of the
//! audio mix. Nothing downstream may shorten it: a source that ends first is
//! [`DecodeError::TruncatedStream`](osg_decode::DecodeError::TruncatedStream), not a quietly
//! shorter export.

use osg_render::RenderPlan;
use osg_scene::scene::SceneCue;
use osg_scene::{ExactTime, FrameTimeline};

use crate::error::ExportError;

/// Microseconds in a second: the unit the render contract carries every instant in.
const MICROS_PER_SECOND: i64 = 1_000_000;

/// The two grids an export walks, built from one frame count so they cannot disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Timelines {
    /// The composition's own grid, starting at zero. Cue times are rebased onto it.
    pub(crate) scene: FrameTimeline,
    /// The same grid offset to the trim point, so the decoder samples the right source instants.
    pub(crate) source: FrameTimeline,
}

/// Builds both grids from a validated plan.
pub(crate) fn build(plan: &RenderPlan) -> Result<Timelines, ExportError> {
    let fps = u32::from(plan.settings.frame_rate.value());
    let frames = plan.duration_frames;
    let trim_start = microseconds(trimmed(plan.trim_start_us))?;
    Ok(Timelines {
        scene: FrameTimeline::new(fps, 1, frames, ExactTime::ZERO)?,
        source: FrameTimeline::new(fps, 1, frames, trim_start)?,
    })
}

/// The plan's cues, moved onto the trimmed timeline.
///
/// Order is preserved exactly. The scene contract refuses an out-of-order list, and that refusal is
/// carried through rather than repaired: cue selection takes the first match, so silently sorting a
/// list the editor sent unsorted would change which cue is drawn.
pub(crate) fn rebased_cues(plan: &RenderPlan) -> Result<Vec<SceneCue>, ExportError> {
    let trim_start = trimmed(plan.trim_start_us);
    let mut cues = Vec::with_capacity(plan.lyrics.len());
    for lyric in &plan.lyrics {
        cues.push(SceneCue {
            text: lyric.text.clone(),
            start: microseconds(trimmed(lyric.start_us) - trim_start)?,
            end: microseconds(trimmed(lyric.end_us) - trim_start)?,
        });
    }
    Ok(cues)
}

/// The exact instant `micros` names.
fn microseconds(micros: i64) -> Result<ExactTime, ExportError> {
    ExactTime::new(micros, MICROS_PER_SECOND).ok_or(ExportError::UnsupportedRequest {
        reason: osg_render::RenderError::InvalidRequest,
    })
}

/// A contract microsecond value as a signed one.
///
/// The contract bounds every instant at 24 hours, which is `86_400_000_000` — four orders of
/// magnitude inside `i64` — so the conversion cannot fail for a validated plan. It saturates rather
/// than panicking so a caller that reached here with an unvalidated value still gets a refusal from
/// the bounds below instead of an abort.
fn trimmed(micros: u64) -> i64 {
    i64::try_from(micros).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{MICROS_PER_SECOND, microseconds, trimmed};

    #[test]
    fn a_microsecond_instant_is_exact_rather_than_rounded() {
        let time = microseconds(1_001).expect("an instant");
        // 1001/1_000_000 reduces to 1001/1_000_000: the numerator is odd, so nothing cancels.
        assert_eq!((time.numerator(), time.denominator()), (1_001, 1_000_000));

        let second = microseconds(MICROS_PER_SECOND).expect("an instant");
        assert_eq!((second.numerator(), second.denominator()), (1, 1));
    }

    #[test]
    fn a_rebased_instant_may_be_negative() {
        let time = microseconds(-500_000).expect("an instant");
        assert_eq!((time.numerator(), time.denominator()), (-1, 2));
    }

    #[test]
    fn the_contract_ceiling_converts_without_saturating() {
        let day = 24 * 60 * 60 * 1_000_000_u64;
        assert_eq!(trimmed(day), 86_400_000_000);
        assert_eq!(trimmed(u64::MAX), i64::MAX);
    }
}
