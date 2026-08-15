//! What the decoder will and will not accept from a file it did not write.
//!
//! Every bound here exists because the input is untrusted. A container can declare an eight
//! gigapixel frame, a thirty-year duration, or a keyframe interval of one per hour, and each of
//! those turns a decode into an allocation, a walk, or a hang that no caller asked for. The bounds
//! are values rather than constants baked into the backend so a test can shrink them and prove the
//! refusal without building a hostile file.

use crate::error::{DecodeError, SourceBound};

/// The smallest source edge the decoder accepts.
///
/// 4:2:0 chroma is half resolution in both axes, so an edge below two pixels has no chroma sample
/// at all.
pub const MIN_SOURCE_DIMENSION: u32 = 2;

/// The largest source edge the decoder accepts, covering 8K in either orientation.
///
/// The same number `osg-encode` caps its output at, because a source larger than the largest
/// encodable frame can only be scaled down and the compositor is where that decision belongs.
pub const MAX_SOURCE_DIMENSION: u32 = 7680;

/// The number of 100-nanosecond units in one second. Media Foundation's whole time base.
pub const HUNDRED_NANOS_PER_SECOND: i64 = 10_000_000;

/// The longest source the decoder accepts: six hours.
///
/// Chosen to match `osg_scene::timeline::MAX_FRAME_COUNT`, which is a little over six hours at
/// 120fps, so a source that passes this bound can always be represented on the shared timeline.
pub const MAX_SOURCE_DURATION_100NS: i64 = 6 * 3600 * HUNDRED_NANOS_PER_SECOND;

/// How far the decoder will walk forward before it prefers a seek, in source frames.
///
/// Walking is exact and seeking is not, so the decoder walks whenever walking is cheap. Fifteen
/// seconds at 60fps is longer than any sane keyframe interval, which means a forward scrub almost
/// never seeks and therefore almost never has to re-establish where it is.
pub const DEFAULT_FORWARD_SCAN_FRAMES: u32 = 900;

/// The most samples one request may decode before the decoder gives up.
///
/// This is the bound that stops a hostile file: a container whose timestamps never reach the
/// requested instant, or whose keyframes are hours apart, would otherwise decode until the process
/// is killed. Thirty thousand frames is over sixteen minutes of 30fps footage from a single
/// keyframe — far past any real encode — and it is still a bounded amount of work.
pub const DEFAULT_MAX_DECODE_WALK: u32 = 30_000;

/// The bounds one decoder is held to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeLimits {
    max_width: u32,
    max_height: u32,
    max_duration_100ns: i64,
    forward_scan_frames: u32,
    max_decode_walk: u32,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_width: MAX_SOURCE_DIMENSION,
            max_height: MAX_SOURCE_DIMENSION,
            max_duration_100ns: MAX_SOURCE_DURATION_100NS,
            forward_scan_frames: DEFAULT_FORWARD_SCAN_FRAMES,
            max_decode_walk: DEFAULT_MAX_DECODE_WALK,
        }
    }
}

impl DecodeLimits {
    /// The shipped bounds.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Lowers the largest source frame the decoder will accept.
    ///
    /// Only ever lowers: a caller cannot raise a bound past what this build was audited for, so a
    /// configuration mistake cannot widen the attack surface.
    #[must_use]
    pub fn with_max_dimensions(mut self, width: u32, height: u32) -> Self {
        self.max_width = width.clamp(MIN_SOURCE_DIMENSION, self.max_width);
        self.max_height = height.clamp(MIN_SOURCE_DIMENSION, self.max_height);
        self
    }

    /// Lowers the longest source the decoder will accept, in 100ns units.
    #[must_use]
    pub fn with_max_duration_100ns(mut self, duration_100ns: i64) -> Self {
        self.max_duration_100ns = duration_100ns.clamp(0, self.max_duration_100ns);
        self
    }

    /// Sets how far the decoder walks forward before it prefers a seek, in source frames.
    #[must_use]
    pub fn with_forward_scan_frames(mut self, frames: u32) -> Self {
        self.forward_scan_frames = frames;
        self
    }

    /// Lowers the number of samples one request may decode.
    #[must_use]
    pub fn with_max_decode_walk(mut self, samples: u32) -> Self {
        self.max_decode_walk = samples.clamp(1, self.max_decode_walk);
        self
    }

    /// The largest accepted frame width.
    #[must_use]
    pub const fn max_width(self) -> u32 {
        self.max_width
    }

    /// The largest accepted frame height.
    #[must_use]
    pub const fn max_height(self) -> u32 {
        self.max_height
    }

    /// The longest accepted duration, in 100ns units.
    #[must_use]
    pub const fn max_duration_100ns(self) -> i64 {
        self.max_duration_100ns
    }

    /// How far the decoder walks forward before it prefers a seek, in source frames.
    #[must_use]
    pub const fn forward_scan_frames(self) -> u32 {
        self.forward_scan_frames
    }

    /// The most samples one request may decode.
    #[must_use]
    pub const fn max_decode_walk(self) -> u32 {
        self.max_decode_walk
    }

    /// Checks a source's declared geometry against these bounds.
    ///
    /// # Errors
    /// Returns [`DecodeError::SourceOutOfBounds`] naming the first bound that was exceeded, and
    /// [`DecodeError::UnsupportedFrameLayout`] for an odd edge, which 4:2:0 chroma cannot describe.
    pub fn check_geometry(self, width: u32, height: u32) -> Result<(), DecodeError> {
        if width < MIN_SOURCE_DIMENSION || width > self.max_width {
            return Err(DecodeError::SourceOutOfBounds {
                bound: SourceBound::Width,
            });
        }
        if height < MIN_SOURCE_DIMENSION || height > self.max_height {
            return Err(DecodeError::SourceOutOfBounds {
                bound: SourceBound::Height,
            });
        }
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(DecodeError::UnsupportedFrameLayout);
        }
        Ok(())
    }

    /// Checks a source's declared duration against these bounds.
    ///
    /// A negative duration is refused outright: it is not a short file, it is a file lying about
    /// itself.
    ///
    /// # Errors
    /// Returns [`DecodeError::SourceOutOfBounds`] when the duration is negative or too long.
    pub fn check_duration(self, duration_100ns: i64) -> Result<(), DecodeError> {
        if duration_100ns < 0 || duration_100ns > self.max_duration_100ns {
            return Err(DecodeError::SourceOutOfBounds {
                bound: SourceBound::Duration,
            });
        }
        Ok(())
    }
}
