//! Bounded frame dimensions.
//!
//! Every size that reaches the GPU passes through [`FrameSize`], so an absurd request is rejected
//! with a typed error before any allocation is attempted.

use crate::error::{Axis, CompositorError};

/// The smallest frame the compositor will render.
pub const MIN_FRAME_DIMENSION: u32 = 1;

/// The largest frame edge the compositor will render.
///
/// This matches the `max_texture_dimension_2d` of `wgpu`'s downlevel default limits, so a size that
/// passes this bound is renderable on every adapter the compositor is willing to run on.
pub const MAX_FRAME_DIMENSION: u32 = 8192;

/// The largest frame area the compositor will render, in pixels.
///
/// 7680x4320 (8K) is the widest output the renderer targets. The area bound sits on top of the edge
/// bound because 8192x8192 would allocate 256 MiB of readback for a frame nothing asks for.
pub const MAX_FRAME_PIXELS: u64 = 33_177_600;

#[allow(
    clippy::cast_lossless,
    reason = "`u64::from` is not a const fn; the widening is exact for u32"
)]
const fn area(width: u32, height: u32) -> u64 {
    width as u64 * height as u64
}

/// A validated offscreen frame size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FrameSize {
    width: u32,
    height: u32,
}

impl FrameSize {
    /// Validates a requested size.
    ///
    /// Both edges must lie in [`MIN_FRAME_DIMENSION`]..=[`MAX_FRAME_DIMENSION`] and their product
    /// must not exceed [`MAX_FRAME_PIXELS`].
    pub const fn new(width: u32, height: u32) -> Result<Self, CompositorError> {
        if width < MIN_FRAME_DIMENSION || width > MAX_FRAME_DIMENSION {
            return Err(CompositorError::DimensionOutOfRange {
                axis: Axis::Width,
                value: width,
                min: MIN_FRAME_DIMENSION,
                max: MAX_FRAME_DIMENSION,
            });
        }
        if height < MIN_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION {
            return Err(CompositorError::DimensionOutOfRange {
                axis: Axis::Height,
                value: height,
                min: MIN_FRAME_DIMENSION,
                max: MAX_FRAME_DIMENSION,
            });
        }

        let pixels = area(width, height);
        if pixels > MAX_FRAME_PIXELS {
            return Err(CompositorError::AreaOutOfRange {
                width,
                height,
                value: pixels,
                max: MAX_FRAME_PIXELS,
            });
        }

        Ok(Self { width, height })
    }

    /// The validated width in pixels.
    #[must_use]
    pub const fn width(self) -> u32 {
        self.width
    }

    /// The validated height in pixels.
    #[must_use]
    pub const fn height(self) -> u32 {
        self.height
    }

    /// The validated pixel count.
    #[must_use]
    pub const fn pixels(self) -> u64 {
        area(self.width, self.height)
    }

    /// The length of a tightly packed RGBA8 readback of this frame, in bytes.
    #[must_use]
    pub const fn rgba8_len(self) -> u64 {
        self.pixels() * 4
    }
}
