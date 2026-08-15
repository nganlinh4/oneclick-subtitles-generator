//! Presentation timestamps, derived once per frame and never accumulated.
//!
//! The obvious implementation computes a single frame duration in integer 100ns units and adds it
//! up. At 30000/1001 the true duration is `333_666.67` units; truncating it to `333_666` loses
//! two thirds of a unit *per frame*, and the loss compounds, so the video timeline slides earlier
//! than the audio timeline for as long as the export runs.
//!
//! This module never forms a frame duration and adds it. It asks [`osg_scene::FrameTimeline`] for
//! the exact rational instant of frame `n`, then rounds that one rational to 100ns units. The error
//! in any timestamp is therefore at most half a unit — 50 nanoseconds — regardless of how long the
//! encode is, and it is bounded rather than cumulative.
//!
//! Durations follow from the same source: the duration of frame `n` is the gap between the exact
//! instants of frame `n` and frame `n + 1`, so the durations sum to the total exactly. That is why
//! the clock is built over a timeline of `frame_count + 1` instants — those are the frame
//! boundaries, and the last one is the end of the last frame.

use osg_scene::{ExactTime, FrameTimeline};

use crate::error::{ConfigField, EncodeError};

/// The number of 100-nanosecond units in one second. Media Foundation's whole time base.
pub const HUNDRED_NANOS_PER_SECOND: i64 = 10_000_000;

/// The largest frame count an encode may carry.
///
/// One below [`osg_scene::timeline::MAX_FRAME_COUNT`], because the clock spans one more instant
/// than it has frames.
pub const MAX_ENCODE_FRAME_COUNT: u32 = osg_scene::timeline::MAX_FRAME_COUNT - 1;

/// Rounds an exact time to 100ns units, half away from zero, in one step.
///
/// This is the only rounding in the crate's video timeline. Everything else is exact rational
/// arithmetic inside `osg-scene`.
#[must_use]
pub fn exact_time_to_100ns(time: ExactTime) -> Option<i64> {
    let numerator =
        i128::from(time.numerator()).checked_mul(i128::from(HUNDRED_NANOS_PER_SECOND))?;
    // `ExactTime` guarantees a positive denominator, so doubling it cannot change the sign.
    let denominator = i128::from(time.denominator()).checked_mul(2)?;
    let offset = if numerator < 0 {
        -i128::from(time.denominator())
    } else {
        i128::from(time.denominator())
    };
    let rounded = numerator.checked_mul(2)?.checked_add(offset)? / denominator;
    i64::try_from(rounded).ok()
}

/// The frame grid an encode walks, in the units the container wants.
///
/// Wraps the shared [`FrameTimeline`] rather than reimplementing it: there is one time
/// representation in this codebase and it lives in `osg-scene`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameClock {
    /// A timeline of `frame_count + 1` instants: every frame boundary, start and end.
    boundaries: FrameTimeline,
    frame_count: u32,
}

impl FrameClock {
    /// Builds a clock for `frame_count` frames at `fps_numerator / fps_denominator`.
    ///
    /// # Errors
    /// Returns [`EncodeError::UnsupportedConfig`] when the frame rate or frame count is outside the
    /// range `osg-scene` supports.
    pub fn new(
        fps_numerator: u32,
        fps_denominator: u32,
        frame_count: u32,
    ) -> Result<Self, EncodeError> {
        if frame_count == 0 || frame_count > MAX_ENCODE_FRAME_COUNT {
            return Err(EncodeError::UnsupportedConfig {
                field: ConfigField::FrameCount,
            });
        }
        let boundaries = FrameTimeline::new(
            fps_numerator,
            fps_denominator,
            frame_count + 1,
            ExactTime::ZERO,
        )
        .map_err(|_| EncodeError::UnsupportedConfig {
            field: ConfigField::FrameRate,
        })?;
        Ok(Self {
            boundaries,
            frame_count,
        })
    }

    /// How many frames this clock covers.
    #[must_use]
    pub const fn frame_count(self) -> u32 {
        self.frame_count
    }

    /// The exact instant of frame boundary `index`, for `index` in `0..=frame_count`.
    ///
    /// # Errors
    /// Returns [`EncodeError::FrameOutOfRange`] when `index` is past the end of the encode.
    pub fn boundary(self, index: u32) -> Result<ExactTime, EncodeError> {
        self.boundaries
            .frame_time(index)
            .map_err(|_| EncodeError::FrameOutOfRange {
                index,
                frame_count: self.frame_count,
            })
    }

    /// The instant of frame boundary `index` in 100ns units, for `index` in `0..=frame_count`.
    ///
    /// # Errors
    /// Returns [`EncodeError::FrameOutOfRange`] when `index` is past the end of the encode, or
    /// [`EncodeError::TimestampOutOfRange`] when the instant does not fit in 100ns units.
    pub fn boundary_100ns(self, index: u32) -> Result<i64, EncodeError> {
        exact_time_to_100ns(self.boundary(index)?).ok_or(EncodeError::TimestampOutOfRange { index })
    }

    /// The presentation timestamp of frame `index`, in 100ns units.
    ///
    /// Derived from `index` alone. Seeking straight to frame `400_000` gives the same value as
    /// walking there, and no earlier frame's rounding can influence it.
    ///
    /// # Errors
    /// Returns [`EncodeError::FrameOutOfRange`] when `index` is past the end of the encode, or
    /// [`EncodeError::TimestampOutOfRange`] when the instant does not fit in 100ns units.
    pub fn timestamp_100ns(self, index: u32) -> Result<i64, EncodeError> {
        if index >= self.frame_count {
            return Err(EncodeError::FrameOutOfRange {
                index,
                frame_count: self.frame_count,
            });
        }
        self.boundary_100ns(index)
    }

    /// The duration of frame `index`, in 100ns units.
    ///
    /// The gap to the next boundary, so consecutive frames abut exactly and the durations of a
    /// whole encode sum to [`Self::total_duration_100ns`] with no residue.
    ///
    /// # Errors
    /// Returns [`EncodeError::FrameOutOfRange`] when `index` is past the end of the encode, or
    /// [`EncodeError::TimestampOutOfRange`] when a boundary does not fit in 100ns units.
    pub fn duration_100ns(self, index: u32) -> Result<i64, EncodeError> {
        let start = self.timestamp_100ns(index)?;
        let end = self.boundary_100ns(index + 1)?;
        end.checked_sub(start)
            .ok_or(EncodeError::TimestampOutOfRange { index })
    }

    /// The exact end of the encode, in 100ns units.
    ///
    /// # Errors
    /// Returns [`EncodeError::TimestampOutOfRange`] when the end does not fit in 100ns units.
    pub fn total_duration_100ns(self) -> Result<i64, EncodeError> {
        self.boundary_100ns(self.frame_count)
    }
}

/// The timestamp of audio sample `index` at `sample_rate`, in 100ns units.
///
/// Same rule as video: one rounding of one exact rational derived from the sample index, so a long
/// export cannot walk the audio clock away from the video clock.
///
/// # Errors
/// Returns [`EncodeError::UnsupportedConfig`] when `sample_rate` is zero, or
/// [`EncodeError::AudioTimestampOutOfRange`] when the instant does not fit in 100ns units.
pub fn audio_timestamp_100ns(sample_index: u64, sample_rate: u32) -> Result<i64, EncodeError> {
    if sample_rate == 0 {
        return Err(EncodeError::UnsupportedConfig {
            field: ConfigField::AudioSampleRate,
        });
    }
    let overflow = EncodeError::AudioTimestampOutOfRange { sample_index };
    let index = i64::try_from(sample_index).map_err(|_| overflow)?;
    let time = ExactTime::new(index, i64::from(sample_rate)).ok_or(overflow)?;
    exact_time_to_100ns(time).ok_or(overflow)
}
