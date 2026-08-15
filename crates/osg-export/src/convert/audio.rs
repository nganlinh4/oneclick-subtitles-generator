//! The audio half of the conversion: two volumes and one window.
//!
//! The volume vocabulary is the shipped one, unchanged — integers in `0..=100` applied as a linear
//! `percent / 100` gain, with `0` meaning "do not use this audio" rather than "use it silently".
//! `osg-audio` already encodes exactly that, so this module only carries the two persisted fields
//! across and refuses anything outside the range.
//!
//! The trim window applies to **both** sources. The original audio is trimmed because the video is;
//! the narration is trimmed because it is generated from the same absolute cue times that
//! `super::timeline` rebases, so leaving it alone while the subtitles move would put a sentence's
//! audio and its subtitle in different places. That follows from the `trimStart` decision rather
//! than adding to it.

use osg_audio::{OutputFormat, TrimWindow, Volume};
use osg_render::RenderPlan;
use osg_scene::ExactTime;

use crate::error::ExportError;

/// The output sample rate. One of the two the platform `AAC` encoder accepts, and the one every
/// modern source already uses, so the resampler is usually the identity.
pub const AUDIO_SAMPLE_RATE_HZ: u32 = 48_000;

/// The output channel count. Stereo: the fold-down in `osg-audio` brings anything wider down to it
/// deterministically, and the platform encoder accepts nothing above it.
pub const AUDIO_CHANNELS: u16 = 2;

/// The average `AAC` bitrate, in kbit/s. One of the four values the platform encoder recognises.
pub const AUDIO_BITRATE_KBPS: u32 = 128;

/// Microseconds in a second, matching the render contract's unit.
const MICROS_PER_SECOND: i64 = 1_000_000;

/// The two volumes and the window an export's audio is read through.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioPlan {
    original: Volume,
    narration: Volume,
    window: TrimWindow,
    format: OutputFormat,
}

impl AudioPlan {
    /// The gain the source video's own audio contributes at.
    #[must_use]
    pub const fn original(self) -> Volume {
        self.original
    }

    /// The gain the narration track contributes at.
    #[must_use]
    pub const fn narration(self) -> Volume {
        self.narration
    }

    /// The part of each source the export uses, in the source's own timeline.
    #[must_use]
    pub const fn window(self) -> TrimWindow {
        self.window
    }

    /// The interleaved format the mix produces.
    #[must_use]
    pub const fn format(self) -> OutputFormat {
        self.format
    }
}

/// Builds the audio plan from a validated request.
pub(crate) fn build(plan: &RenderPlan) -> Result<AudioPlan, ExportError> {
    let original = Volume::from_percent(u32::from(plan.settings.original_audio_volume))?;
    let narration = Volume::from_percent(u32::from(plan.settings.narration_volume))?;
    let window = TrimWindow::new(instant(plan.trim_start_us), Some(instant(plan.trim_end_us)))?;
    let format = OutputFormat::new(AUDIO_SAMPLE_RATE_HZ, AUDIO_CHANNELS)?;
    Ok(AudioPlan {
        original,
        narration,
        window,
        format,
    })
}

/// A contract microsecond instant as an exact time, saturating rather than panicking.
///
/// The contract bounds every instant at 24 hours, four orders of magnitude inside `i64`, so a
/// validated plan never reaches the fallbacks. They exist so an unvalidated value is refused by the
/// window bounds rather than aborting.
fn instant(micros: u64) -> ExactTime {
    let micros = i64::try_from(micros).unwrap_or(i64::MAX);
    ExactTime::new(micros, MICROS_PER_SECOND).unwrap_or(ExactTime::ZERO)
}

#[cfg(test)]
mod tests {
    use osg_audio::Volume;

    use super::instant;

    #[test]
    fn the_shipped_percentage_becomes_a_linear_gain() {
        assert!((Volume::from_percent(100).expect("full").gain() - 1.0).abs() < f32::EPSILON);
        assert!((Volume::from_percent(35).expect("a third").gain() - 0.35).abs() < f32::EPSILON);
        assert!(Volume::from_percent(0).expect("muted").is_muted());
    }

    #[test]
    fn a_microsecond_instant_is_exact() {
        let time = instant(1_500_000);
        assert_eq!((time.numerator(), time.denominator()), (3, 2));
        assert_eq!(instant(0), osg_scene::ExactTime::ZERO);
    }
}
