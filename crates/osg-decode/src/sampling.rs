//! Which instant of the source an output frame must be sampled at.
//!
//! This module is the whole reason the decoder is not simply "read samples until they run out".
//! `IMFSourceReader` seeks to a keyframe, not to a frame index, so a decoder that trusts its own
//! seek samples the wrong source frame everywhere the two grids disagree — which is everywhere near
//! a cut, and everywhere the output frame rate is not the source frame rate. The fix is to stop
//! treating the seek as an answer and treat it as a starting point: the instant an output frame
//! wants is computed exactly, from the shared timeline, and the decoder walks forward from whatever
//! keyframe the seek happened to land on until it holds the sample that actually covers it.
//!
//! Everything here is exact rational arithmetic from `osg-scene` with a single rounding at the
//! boundary, so an instant is the same value whether it was reached by playing forward or by
//! seeking straight to it. That is the property the whole preview-equals-export guarantee rests on,
//! and it is pure, so it is tested without a media file.

use osg_scene::{ExactTime, FrameTimeline};

use crate::error::DecodeError;
use crate::limits::HUNDRED_NANOS_PER_SECOND;

/// Rounds an exact time to 100ns units, half away from zero, in one step.
///
/// The same rule `osg-encode` applies on the way out, so a frame written at an instant and a frame
/// read at that instant name the same number. Rounding once from the frame's own index, rather than
/// accumulating a per-frame duration, is what keeps the error at half a unit for a six-hour source
/// instead of letting it grow with the file.
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

/// Maps an output frame index onto the instant of the source it must show.
///
/// The timeline is the export's own, carried through from `osg-scene`, so its start offset is the
/// trim and its rate is the output rate. Both are already accounted for by the time an index
/// reaches here: this type adds no arithmetic of its own beyond the conversion to the platform's
/// time base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputSampler {
    timeline: FrameTimeline,
}

impl OutputSampler {
    /// Wraps an output timeline.
    #[must_use]
    pub const fn new(timeline: FrameTimeline) -> Self {
        Self { timeline }
    }

    /// The timeline being sampled.
    #[must_use]
    pub const fn timeline(self) -> FrameTimeline {
        self.timeline
    }

    /// The exact instant output frame `index` samples the source at.
    ///
    /// # Errors
    /// Returns [`DecodeError::FrameOutOfRange`] when `index` is past the end of the timeline.
    pub fn sample_time(self, index: u32) -> Result<ExactTime, DecodeError> {
        self.timeline
            .frame_time(index)
            .map_err(|_| DecodeError::FrameOutOfRange {
                index,
                frame_count: self.timeline.frame_count(),
            })
    }

    /// The instant output frame `index` samples the source at, in 100ns units.
    ///
    /// # Errors
    /// Returns [`DecodeError::FrameOutOfRange`] when `index` is past the end of the timeline, and
    /// [`DecodeError::TimestampOutOfRange`] when the instant does not fit in 100ns units.
    pub fn sample_100ns(self, index: u32) -> Result<i64, DecodeError> {
        exact_time_to_100ns(self.sample_time(index)?)
            .ok_or(DecodeError::TimestampOutOfRange { index })
    }
}

/// The source's own frame grid, derived from the frame rate it declares.
///
/// Used for two things and nothing else: turning a source frame index into an instant to ask for,
/// and turning a decoded sample's timestamp back into the index it belongs to so a caller can be
/// told which source frame it is looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceGrid {
    numerator: u32,
    denominator: u32,
}

impl SourceGrid {
    /// Builds a grid from a declared frame rate.
    ///
    /// # Errors
    /// Returns [`DecodeError::UnsupportedFrameRate`] when either term is zero or the represented
    /// rate exceeds the decoder's 120fps product bound, so a source that declares a nonsense rate
    /// is refused here rather than producing nonsense instants later.
    pub fn new(numerator: u32, denominator: u32) -> Result<Self, DecodeError> {
        if numerator == 0 || denominator == 0 {
            return Err(DecodeError::UnsupportedFrameRate);
        }
        // Media Foundation is allowed to preserve the container's time-base scale instead of
        // returning a reduced ratio. Real 23.976fps AV1 files commonly arrive here as
        // 24_000_000/1_001_000 rather than 24_000/1_001. Refusing before reducing made an ordinary
        // YouTube download look like an unreadable/truncated source even though both spellings name
        // exactly the same grid.
        let divisor = greatest_common_divisor(numerator, denominator);
        let numerator = numerator / divisor;
        let denominator = denominator / divisor;
        // A source grid is not a render timeline. Media Foundation may express it in its 100ns
        // clock (10_000_000/417_083 for ordinary 23.976fps), whose terms are larger than the
        // canonical authored ratios accepted by `FrameTimeline` but whose represented rate is
        // entirely ordinary. Bound the value, not the spelling.
        if u64::from(numerator) > u64::from(denominator) * 120 {
            return Err(DecodeError::UnsupportedFrameRate);
        }
        Ok(Self {
            numerator,
            denominator,
        })
    }

    /// The frame rate numerator.
    #[must_use]
    pub const fn numerator(self) -> u32 {
        self.numerator
    }

    /// The frame rate denominator.
    #[must_use]
    pub const fn denominator(self) -> u32 {
        self.denominator
    }

    /// The exact duration of one source frame, in seconds.
    #[must_use]
    pub fn frame_duration(self) -> ExactTime {
        ExactTime::new(i64::from(self.denominator), i64::from(self.numerator))
            .unwrap_or(ExactTime::ZERO)
    }

    /// One source frame's duration in 100ns units, rounded down.
    ///
    /// Only ever used as a budget — how far forward walking is cheaper than seeking — never as a
    /// timestamp, so the rounding direction is a policy choice and not an accuracy one.
    #[must_use]
    pub fn frame_duration_100ns(self) -> i64 {
        i64::from(self.denominator) * HUNDRED_NANOS_PER_SECOND / i64::from(self.numerator)
    }

    /// The instant to ask the decoder for when a caller names source frame `index`.
    ///
    /// Deliberately the **middle** of the frame's interval rather than its start. A decoder reports
    /// the timestamps the container carries, which are rounded to the platform's time base and need
    /// not agree with this grid to the unit; asking for the start of a frame therefore risks
    /// landing a unit before it and selecting its predecessor. The middle is half a frame away from
    /// either boundary, so no rounding either side can move it into the wrong frame.
    ///
    /// # Errors
    /// Returns [`DecodeError::TimestampOutOfRange`] when the instant does not fit in 100ns units.
    pub fn frame_midpoint_100ns(self, index: u32) -> Result<i64, DecodeError> {
        let out_of_range = DecodeError::TimestampOutOfRange { index };
        // (index + 1/2) * denominator / numerator, kept exact until the single rounding.
        let numerator = i64::from(index)
            .checked_mul(2)
            .and_then(|doubled| doubled.checked_add(1))
            .and_then(|doubled| doubled.checked_mul(i64::from(self.denominator)))
            .ok_or(out_of_range)?;
        let denominator = i64::from(self.numerator)
            .checked_mul(2)
            .ok_or(out_of_range)?;
        let time = ExactTime::new(numerator, denominator).ok_or(out_of_range)?;
        exact_time_to_100ns(time).ok_or(out_of_range)
    }

    /// The source frame index whose interval contains `instant_100ns`.
    ///
    /// Clamped at zero: a container may carry a small negative timestamp for a frame it wants
    /// discarded, and the first frame is the honest answer for it.
    #[must_use]
    pub fn frame_index_at_100ns(self, instant_100ns: i64) -> u64 {
        if instant_100ns <= 0 {
            return 0;
        }
        let scaled = i128::from(instant_100ns) * i128::from(self.numerator);
        let divisor = i128::from(HUNDRED_NANOS_PER_SECOND) * i128::from(self.denominator);
        u64::try_from(scaled / divisor).unwrap_or(u64::MAX)
    }

    /// Which frame of this grid a decoded sample's own timestamp names.
    ///
    /// Rounded to nearest, not floored, and the difference is a real off-by-one rather than a
    /// nicety. A container stores timestamps in its own time base and Media Foundation converts them
    /// into 100ns units by truncation, so frame 1 of a 30fps source arrives as `333_333` where the
    /// exact instant is `333_333.33`. Flooring that reports it as frame **0**, and the error repeats
    /// on roughly every frame whose exact instant is not a whole number of units — which at 30fps is
    /// two frames in every three. Rounding to the nearest grid position is correct as long as the
    /// container's quantisation is smaller than half a frame, which is true of every time base a
    /// real container uses.
    #[must_use]
    pub fn nearest_frame_index_100ns(self, instant_100ns: i64) -> u64 {
        if instant_100ns <= 0 {
            return 0;
        }
        let scaled = i128::from(instant_100ns) * i128::from(self.numerator);
        let divisor = i128::from(HUNDRED_NANOS_PER_SECOND) * i128::from(self.denominator);
        u64::try_from((scaled * 2 + divisor) / (divisor * 2)).unwrap_or(u64::MAX)
    }

    /// How many whole frames a source of `duration_100ns` carries.
    #[must_use]
    pub fn frame_count_for(self, duration_100ns: i64) -> u64 {
        if duration_100ns <= 0 {
            return 0;
        }
        let scaled = i128::from(duration_100ns) * i128::from(self.numerator);
        let divisor = i128::from(HUNDRED_NANOS_PER_SECOND) * i128::from(self.denominator);
        u64::try_from(scaled / divisor).unwrap_or(u64::MAX)
    }
}

const fn greatest_common_divisor(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let next = left % right;
        left = right;
        right = next;
    }
    left
}
