//! Typed, path-safe failures for the headless compositor.

use core::fmt;

/// Which side of a frame a dimension bound rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    /// The horizontal axis.
    Width,
    /// The vertical axis.
    Height,
}

impl fmt::Display for Axis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Width => "width",
            Self::Height => "height",
        };
        f.write_str(name)
    }
}

/// Everything the compositor can refuse to do.
///
/// Every variant fails closed: the compositor never substitutes a degraded result for a failure,
/// and it never panics on a missing adapter, an out-of-range request or a lost device. Messages
/// carry only bounded numbers and adapter-reported text, never filesystem paths or credentials.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CompositorError {
    /// No GPU adapter — hardware or software — could be acquired.
    #[error("no GPU adapter is available for headless composition: {reason}")]
    NoAdapter {
        /// The adapter-request failure reported by the graphics backend.
        reason: String,
    },

    /// An adapter existed but would not yield a device and queue.
    #[error("the GPU adapter refused to create a device: {reason}")]
    DeviceUnavailable {
        /// The device-request failure reported by the graphics backend.
        reason: String,
    },

    /// A requested frame dimension fell outside the accepted range.
    #[error("frame {axis} must be {min}..={max} pixels, got {value}")]
    DimensionOutOfRange {
        /// The axis that was rejected.
        axis: Axis,
        /// The rejected value.
        value: u32,
        /// The smallest accepted value.
        min: u32,
        /// The largest accepted value.
        max: u32,
    },

    /// Both dimensions were individually acceptable but their product was not.
    #[error("frame area must be at most {max} pixels, got {value} ({width}x{height})")]
    AreaOutOfRange {
        /// The requested width.
        width: u32,
        /// The requested height.
        height: u32,
        /// The requested pixel count.
        value: u64,
        /// The largest accepted pixel count.
        max: u64,
    },

    /// A scene parameter was not a finite value inside its documented range.
    #[error("scene phase must be a finite value in 0.0..=1.0, got {value}")]
    PhaseOutOfRange {
        /// The rejected value.
        value: f32,
    },

    /// The composed frame could not be copied back to host memory.
    #[error("the composed frame could not be read back from the GPU: {reason}")]
    ReadbackFailed {
        /// The mapping or polling failure reported by the graphics backend.
        reason: String,
    },
}
