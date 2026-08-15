//! Exact frame timing for the native renderer.
//!
//! One sampler produces the timestamps that the video decode, the audio mix and the subtitle
//! overlay all advance on, so the three cannot drift apart. Times are exact rationals rather than
//! floats: `1/30` has no binary representation, so accumulating a float frame duration puts frame
//! 1800 of a 60-second 30fps render measurably off, and two runs that arrive at a timestamp by
//! different routes disagree. Seeking to frame `n` here is the same value every time, from any
//! starting point, which is what makes preview and export comparable frame by frame.

use core::fmt;

/// The largest frame count a single render may produce. At 120fps this is a little over six hours,
/// far beyond any real subtitle render, and it keeps every product below `i64` overflow.
pub const MAX_FRAME_COUNT: u32 = 2_700_000;
/// The largest supported frame rate numerator, covering 120fps and NTSC rates like 120000/1001.
pub const MAX_FPS_NUMERATOR: u32 = 120_000;
/// The largest supported frame rate denominator, covering the 1001 NTSC family.
pub const MAX_FPS_DENOMINATOR: u32 = 1_001;

/// Why a timeline was refused. Carries no path and no caller data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineError {
    /// The frame rate was zero, inverted, or outside the supported range.
    UnsupportedFrameRate,
    /// The requested frame count was zero or beyond [`MAX_FRAME_COUNT`].
    UnsupportedFrameCount,
    /// The start offset was negative or beyond the supported range.
    UnsupportedStart,
    /// A frame index was requested that this timeline does not contain.
    FrameOutOfRange,
}

impl fmt::Display for TimelineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedFrameRate => "the frame rate is outside the supported range",
            Self::UnsupportedFrameCount => "the frame count is outside the supported range",
            Self::UnsupportedStart => "the start offset is outside the supported range",
            Self::FrameOutOfRange => "the frame index is outside this timeline",
        };
        formatter.write_str(message)
    }
}

impl core::error::Error for TimelineError {}

/// An exact time in seconds, held as a rational so no timestamp is ever approximated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExactTime {
    numerator: i64,
    denominator: i64,
}

impl ExactTime {
    /// Zero seconds.
    pub const ZERO: Self = Self {
        numerator: 0,
        denominator: 1,
    };

    /// Build an exact time, reduced to lowest terms with a positive denominator.
    #[must_use]
    pub fn new(numerator: i64, denominator: i64) -> Option<Self> {
        if denominator == 0 {
            return None;
        }
        let (numerator, denominator) = if denominator < 0 {
            (numerator.checked_neg()?, denominator.checked_neg()?)
        } else {
            (numerator, denominator)
        };
        let divisor = greatest_common_divisor(numerator.unsigned_abs(), denominator.unsigned_abs());
        let divisor = i64::try_from(divisor.max(1)).ok()?;
        Some(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    /// The exact numerator, in units of [`Self::denominator`] seconds.
    #[must_use]
    pub const fn numerator(self) -> i64 {
        self.numerator
    }

    /// The exact denominator. Always positive.
    #[must_use]
    pub const fn denominator(self) -> i64 {
        self.denominator
    }

    /// Convert to seconds. Lossy by definition — only for handing a value to something that cannot
    /// take a rational. Never use the result to derive another timestamp.
    #[must_use]
    #[expect(
        clippy::cast_precision_loss,
        reason = "the caller is explicitly asking for the lossy seconds view"
    )]
    pub fn as_seconds_lossy(self) -> f64 {
        self.numerator as f64 / self.denominator as f64
    }

    /// Compare exactly, without going through floating point.
    #[must_use]
    pub fn cmp_exact(self, other: Self) -> core::cmp::Ordering {
        let left = i128::from(self.numerator) * i128::from(other.denominator);
        let right = i128::from(other.numerator) * i128::from(self.denominator);
        left.cmp(&right)
    }
}

const fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let next = left % right;
        left = right;
        right = next;
    }
    left
}

/// The frame grid a render walks. Every consumer samples the same instants from this one source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameTimeline {
    fps_numerator: u32,
    fps_denominator: u32,
    frame_count: u32,
    start: ExactTime,
}

impl FrameTimeline {
    /// Build a timeline, refusing anything outside the supported bounds.
    ///
    /// # Errors
    /// Returns [`TimelineError`] when the frame rate, frame count or start offset is unsupported.
    pub fn new(
        fps_numerator: u32,
        fps_denominator: u32,
        frame_count: u32,
        start: ExactTime,
    ) -> Result<Self, TimelineError> {
        if fps_numerator == 0
            || fps_denominator == 0
            || fps_numerator > MAX_FPS_NUMERATOR
            || fps_denominator > MAX_FPS_DENOMINATOR
        {
            return Err(TimelineError::UnsupportedFrameRate);
        }
        if frame_count == 0 || frame_count > MAX_FRAME_COUNT {
            return Err(TimelineError::UnsupportedFrameCount);
        }
        if start.numerator() < 0 {
            return Err(TimelineError::UnsupportedStart);
        }
        Ok(Self {
            fps_numerator,
            fps_denominator,
            frame_count,
            start,
        })
    }

    /// The number of frames this timeline produces.
    #[must_use]
    pub const fn frame_count(self) -> u32 {
        self.frame_count
    }

    /// The exact instant frame `index` samples.
    ///
    /// This is a direct computation from the index, never an accumulation, so frame `n` is the same
    /// instant whether it was reached by playing forward or by seeking straight to it.
    ///
    /// # Errors
    /// Returns [`TimelineError::FrameOutOfRange`] when `index` is not in this timeline.
    pub fn frame_time(self, index: u32) -> Result<ExactTime, TimelineError> {
        if index >= self.frame_count {
            return Err(TimelineError::FrameOutOfRange);
        }
        // start + index * denominator / numerator, kept exact.
        let offset_numerator = i64::from(index) * i64::from(self.fps_denominator);
        let offset_denominator = i64::from(self.fps_numerator);
        let numerator = self
            .start
            .numerator()
            .checked_mul(offset_denominator)
            .and_then(|scaled| {
                offset_numerator
                    .checked_mul(self.start.denominator())
                    .and_then(|other| scaled.checked_add(other))
            })
            .ok_or(TimelineError::FrameOutOfRange)?;
        let denominator = self
            .start
            .denominator()
            .checked_mul(offset_denominator)
            .ok_or(TimelineError::FrameOutOfRange)?;
        ExactTime::new(numerator, denominator).ok_or(TimelineError::FrameOutOfRange)
    }

    /// The exact duration of the whole timeline.
    ///
    /// # Errors
    /// Returns [`TimelineError`] when the duration cannot be represented.
    pub fn duration(self) -> Result<ExactTime, TimelineError> {
        let numerator = i64::from(self.frame_count) * i64::from(self.fps_denominator);
        ExactTime::new(numerator, i64::from(self.fps_numerator))
            .ok_or(TimelineError::UnsupportedFrameCount)
    }

    /// The frame whose sample instant covers `time`, clamped to the timeline.
    ///
    /// Used to answer "which frame is the editor showing" without the caller inventing its own
    /// rounding, which is how a preview and an export end up one frame apart.
    #[must_use]
    pub fn frame_index_at(self, time: ExactTime) -> u32 {
        if time.cmp_exact(self.start) == core::cmp::Ordering::Less {
            return 0;
        }
        // floor((time - start) * numerator / denominator)
        let elapsed_numerator = i128::from(time.numerator()) * i128::from(self.start.denominator())
            - i128::from(self.start.numerator()) * i128::from(time.denominator());
        let elapsed_denominator =
            i128::from(time.denominator()) * i128::from(self.start.denominator());
        let scaled = elapsed_numerator * i128::from(self.fps_numerator);
        let divisor = elapsed_denominator * i128::from(self.fps_denominator);
        if divisor <= 0 {
            return 0;
        }
        let index = scaled.div_euclid(divisor);
        let last = i128::from(self.frame_count - 1);
        u32::try_from(index.clamp(0, last)).unwrap_or(self.frame_count - 1)
    }
}
