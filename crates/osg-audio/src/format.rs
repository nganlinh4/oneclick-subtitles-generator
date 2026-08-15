//! The output format a mix produces, and the exact conversion from scene time to sample index.
//!
//! Every time value that crosses into this crate is an [`ExactTime`] from `osg-scene`, and every
//! conversion to a sample index is integer arithmetic on that rational. Nothing here goes through
//! `f64` seconds, so the sample index of video frame `n` is the same value whether the caller
//! reached it by playing forward or by seeking, and audio and video cannot disagree about where a
//! frame boundary is.

use osg_scene::ExactTime;

use crate::error::AudioError;

/// The lowest output or source sample rate the crate accepts.
pub const MIN_SAMPLE_RATE: u32 = 8_000;
/// The highest output or source sample rate the crate accepts.
pub const MAX_SAMPLE_RATE: u32 = 192_000;
/// The most channels an output format may carry.
pub const MAX_CHANNELS: u16 = 8;
/// The longest mix, in seconds.
///
/// This is `osg-scene`'s [`MAX_FRAME_COUNT`](osg_scene::timeline::MAX_FRAME_COUNT) at the highest
/// supported frame rate, so the audio ceiling and the video ceiling are the same wall clock.
pub const MAX_MIX_DURATION_SECONDS: u32 = 22_500;

/// The interleaved PCM format a mix produces.
///
/// Samples are `f32` in `-1.0..=1.0`, interleaved by frame, which is what
/// `MFAudioFormat_Float` wants and what a wgpu-side readback never has to touch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputFormat {
    sample_rate: u32,
    channels: u16,
}

impl OutputFormat {
    /// Build an output format, refusing anything outside the supported bounds.
    ///
    /// # Errors
    /// Returns [`AudioError::OutputSampleRateOutOfRange`] or
    /// [`AudioError::OutputChannelCountOutOfRange`].
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, AudioError> {
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
            return Err(AudioError::OutputSampleRateOutOfRange {
                value: sample_rate,
                min: MIN_SAMPLE_RATE,
                max: MAX_SAMPLE_RATE,
            });
        }
        if channels == 0 || channels > MAX_CHANNELS {
            return Err(AudioError::OutputChannelCountOutOfRange {
                value: u32::from(channels),
                max: u32::from(MAX_CHANNELS),
            });
        }
        Ok(Self {
            sample_rate,
            channels,
        })
    }

    /// The output sample rate in Hz.
    #[must_use]
    pub const fn sample_rate(self) -> u32 {
        self.sample_rate
    }

    /// The output channel count.
    #[must_use]
    pub const fn channels(self) -> u16 {
        self.channels
    }

    /// The output channel count as an index-friendly `usize`.
    #[must_use]
    pub(crate) fn channel_count(self) -> usize {
        usize::from(self.channels)
    }

    /// The sample index that `time` falls in, exactly.
    ///
    /// Rounding is towards the earlier sample, so a boundary belongs to the frame that starts on
    /// it. That is the same direction `osg-scene`'s
    /// [`frame_index_at`](osg_scene::FrameTimeline::frame_index_at) rounds, which is why a video
    /// frame and its audio start on the same instant.
    ///
    /// # Errors
    /// Returns [`AudioError::DurationOutOfRange`] when `time` is negative or beyond
    /// [`MAX_MIX_DURATION_SECONDS`].
    pub fn frame_index(self, time: ExactTime) -> Result<u64, AudioError> {
        frames_floor(time, self.sample_rate).ok_or(AudioError::DurationOutOfRange {
            max: MAX_MIX_DURATION_SECONDS,
        })
    }

    /// The number of output frames between two instants, exactly.
    ///
    /// # Errors
    /// Returns [`AudioError::DurationOutOfRange`] when the span is negative or beyond
    /// [`MAX_MIX_DURATION_SECONDS`].
    pub fn frame_span(self, from: ExactTime, to: ExactTime) -> Result<u64, AudioError> {
        span_floor(from, to, self.sample_rate).ok_or(AudioError::DurationOutOfRange {
            max: MAX_MIX_DURATION_SECONDS,
        })
    }

    /// How many interleaved samples `frames` frames occupy, or `None` on overflow.
    #[must_use]
    pub fn samples_for(self, frames: u64) -> Option<u64> {
        frames.checked_mul(u64::from(self.channels))
    }
}

/// The largest frame index any rate in range may address, used as the shared overflow ceiling.
fn frame_ceiling(rate: u32) -> i128 {
    i128::from(MAX_MIX_DURATION_SECONDS) * i128::from(rate)
}

/// `floor(time * rate)`, or `None` when the result is negative or past the ceiling.
pub(crate) fn frames_floor(time: ExactTime, rate: u32) -> Option<u64> {
    if time.numerator() < 0 {
        return None;
    }
    let numerator = i128::from(time.numerator()) * i128::from(rate);
    let denominator = i128::from(time.denominator());
    if denominator <= 0 {
        return None;
    }
    let frames = numerator.div_euclid(denominator);
    if frames > frame_ceiling(rate) {
        return None;
    }
    u64::try_from(frames).ok()
}

/// `floor((to - from) * rate)`, or `None` when the span is negative or past the ceiling.
///
/// Every step is checked. `ExactTime` bounds neither its numerator nor its denominator beyond i64,
/// so cross-multiplying two of them reaches 2^126 and their difference reaches 2^127 — already at
/// the edge of i128 — and multiplying that by a sample rate of up to 192_000 passes it. An
/// unchecked version wraps silently in release and reports a plausible but wrong frame count for
/// the span, which is a wrong audio length rather than a crash.
pub(crate) fn span_floor(from: ExactTime, to: ExactTime, rate: u32) -> Option<u64> {
    let numerator = i128::from(to.numerator())
        .checked_mul(i128::from(from.denominator()))?
        .checked_sub(i128::from(from.numerator()).checked_mul(i128::from(to.denominator()))?)?
        .checked_mul(i128::from(rate))?;
    let denominator = i128::from(to.denominator()).checked_mul(i128::from(from.denominator()))?;
    if denominator <= 0 {
        return None;
    }
    let frames = numerator.div_euclid(denominator);
    if frames < 0 || frames > frame_ceiling(rate) {
        return None;
    }
    u64::try_from(frames).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_span_at_the_extremes_of_exact_time_refuses_instead_of_wrapping() {
        use osg_scene::timeline::ExactTime;

        // ExactTime bounds neither field beyond i64, so cross-multiplying two of them reaches 2^126
        // and their difference 2^127 — then multiplying by the sample rate passes what i128 holds.
        // Unchecked, that wraps in release and yields a plausible but wrong frame count, i.e. an
        // audio track of the wrong length rather than an error anyone would notice.
        let from = ExactTime::new(1, i64::MAX).expect("a legal instant");
        let to = ExactTime::new(i64::MAX, 1).expect("a legal instant");
        assert_eq!(super::span_floor(from, to, 192_000), None);
        assert_eq!(super::span_floor(from, to, 8_000), None);

        // The ordinary case still works, so the guard did not simply disable the function.
        let quarter = ExactTime::new(1, 4).expect("a quarter second");
        assert_eq!(
            super::span_floor(ExactTime::ZERO, quarter, 48_000),
            Some(12_000)
        );
    }

    use super::{
        AudioError, MAX_CHANNELS, MAX_MIX_DURATION_SECONDS, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE,
        OutputFormat, frames_floor, span_floor,
    };
    use osg_scene::{ExactTime, FrameTimeline};

    fn stereo_48k() -> OutputFormat {
        OutputFormat::new(48_000, 2).expect("48 kHz stereo is in range")
    }

    #[test]
    fn rejects_rates_and_channel_counts_outside_the_bounds() {
        assert!(matches!(
            OutputFormat::new(MIN_SAMPLE_RATE - 1, 2),
            Err(AudioError::OutputSampleRateOutOfRange { .. })
        ));
        assert!(matches!(
            OutputFormat::new(MAX_SAMPLE_RATE + 1, 2),
            Err(AudioError::OutputSampleRateOutOfRange { .. })
        ));
        assert!(matches!(
            OutputFormat::new(48_000, 0),
            Err(AudioError::OutputChannelCountOutOfRange { .. })
        ));
        assert!(matches!(
            OutputFormat::new(48_000, MAX_CHANNELS + 1),
            Err(AudioError::OutputChannelCountOutOfRange { .. })
        ));
    }

    #[test]
    fn frame_index_never_drifts_from_the_video_grid() {
        let format = stereo_48k();
        let timeline = FrameTimeline::new(30, 1, 200_000, ExactTime::ZERO).expect("timeline");
        for index in [0_u32, 1, 999, 100_000, 199_999] {
            let time = timeline.frame_time(index).expect("frame time");
            assert_eq!(
                format.frame_index(time).expect("sample index"),
                u64::from(index) * 1_600
            );
        }
    }

    #[test]
    fn frame_index_floors_a_boundary_that_is_not_a_whole_sample() {
        let format = stereo_48k();
        // 30000/1001 fps: one frame is 1601.6 samples at 48 kHz.
        let timeline = FrameTimeline::new(30_000, 1_001, 100, ExactTime::ZERO).expect("timeline");
        let one = timeline.frame_time(1).expect("frame time");
        assert_eq!(format.frame_index(one).expect("sample index"), 1_601);
        let two = timeline.frame_time(2).expect("frame time");
        assert_eq!(format.frame_index(two).expect("sample index"), 3_203);
    }

    #[test]
    fn frame_index_rejects_negative_and_overlong_times() {
        let format = stereo_48k();
        let negative = ExactTime::new(-1, 1).expect("exact time");
        assert!(matches!(
            format.frame_index(negative),
            Err(AudioError::DurationOutOfRange { .. })
        ));
        let overlong =
            ExactTime::new(i64::from(MAX_MIX_DURATION_SECONDS) + 1, 1).expect("exact time");
        assert!(matches!(
            format.frame_index(overlong),
            Err(AudioError::DurationOutOfRange { .. })
        ));
    }

    #[test]
    fn spans_are_exact_and_directional() {
        let format = stereo_48k();
        let from = ExactTime::new(1, 3).expect("exact time");
        let to = ExactTime::new(2, 3).expect("exact time");
        assert_eq!(format.frame_span(from, to).expect("span"), 16_000);
        assert!(matches!(
            format.frame_span(to, from),
            Err(AudioError::DurationOutOfRange { .. })
        ));
    }

    #[test]
    fn helpers_agree_with_the_public_conversions() {
        let time = ExactTime::new(7, 8).expect("exact time");
        assert_eq!(frames_floor(time, 44_100), Some(38_587));
        assert_eq!(
            span_floor(ExactTime::ZERO, time, 44_100),
            frames_floor(time, 44_100)
        );
    }

    #[test]
    fn sample_counts_are_checked() {
        let format = stereo_48k();
        assert_eq!(format.samples_for(10), Some(20));
        assert_eq!(format.samples_for(u64::MAX), None);
    }
}
