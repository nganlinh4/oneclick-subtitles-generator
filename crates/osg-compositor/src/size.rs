//! Bounded frame dimensions.
//!
//! Every size that reaches the GPU passes through [`FrameSize`], so an absurd request is rejected
//! with a typed error before any allocation is attempted.
//!
//! There are two bounds here, and they answer different questions. [`MAX_FRAME_DIMENSION`] is
//! static: the largest edge this crate would ever ask any device for. The device's own
//! `max_texture_dimension_2d` is a runtime fact that varies by adapter, and it is checked
//! separately by [`FrameSize::check_device`] and [`check_device_texture`] — a size may pass the
//! static bound and still be more than the machine in front of the user can allocate.

use crate::error::{Axis, CompositorError, TextureTarget};

/// The smallest frame the compositor will render.
pub const MIN_FRAME_DIMENSION: u32 = 1;

/// The largest frame edge the compositor will ever ask a device for.
///
/// It matches `wgpu::Limits::default().max_texture_dimension_2d`, the WebGPU baseline, and it
/// deliberately does **not** match `wgpu::Limits::downlevel_defaults()`, whose
/// `max_texture_dimension_2d` is 2048 — below 1440p, 4K and 8K. The compositor therefore raises
/// that one limit to the adapter's own when it acquires a device, and this constant is the ceiling
/// on how far it will raise it.
///
/// Passing this bound does **not** mean a given machine can render the size: it is an upper bound
/// on the request, not a guarantee about the adapter. What a particular device will take is
/// [`crate::AdapterProfile::max_texture_dimension_2d`], enforced by [`FrameSize::check_device`].
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

    /// Refuses a size the acquired device cannot allocate a texture for.
    ///
    /// # Errors
    /// Returns [`CompositorError::DeviceTextureLimit`] when either edge exceeds `max_edge`.
    pub(crate) const fn check_device(
        self,
        target: TextureTarget,
        max_edge: u32,
    ) -> Result<(), CompositorError> {
        check_device_texture(target, self.width, self.height, max_edge)
    }
}

/// Refuses a 2D texture the acquired device cannot allocate, before it is created.
///
/// Takes bare edges rather than a [`FrameSize`] because the glyph atlas is neither a frame nor
/// bounded by [`MAX_FRAME_PIXELS`], and it is uploaded as a texture on the same device limit.
pub(crate) const fn check_device_texture(
    target: TextureTarget,
    width: u32,
    height: u32,
    max_edge: u32,
) -> Result<(), CompositorError> {
    if width > max_edge {
        return Err(CompositorError::DeviceTextureLimit {
            target,
            axis: Axis::Width,
            value: width,
            max: max_edge,
        });
    }
    if height > max_edge {
        return Err(CompositorError::DeviceTextureLimit {
            target,
            axis: Axis::Height,
            value: height,
            max: max_edge,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{FrameSize, MAX_FRAME_DIMENSION, check_device_texture};
    use crate::error::{Axis, CompositorError, TextureTarget};

    /// The device limit the compositor used to be stuck with, and the reason this check exists.
    const DOWNLEVEL_EDGE: u32 = 2048;

    /// The static bound is the ceiling on the *request*, not a claim about any adapter.
    ///
    /// Pinned to `wgpu::Limits::default().max_texture_dimension_2d` rather than to
    /// `downlevel_defaults()`, whose 2048 the doc comment used to claim it matched.
    #[test]
    fn the_static_bound_is_the_webgpu_default_and_not_the_downlevel_one() {
        assert_eq!(MAX_FRAME_DIMENSION, 8_192);
        assert_ne!(MAX_FRAME_DIMENSION, DOWNLEVEL_EDGE);
    }

    /// Every size the shipped UI offers is past the downlevel edge, and refused *by axis*.
    #[test]
    fn a_frame_past_the_device_edge_is_refused_before_any_texture_exists() {
        for (width, height) in [(2560_u32, 1440_u32), (3840, 2160), (7680, 4320)] {
            let size = FrameSize::new(width, height).expect("a shipped output size is in bounds");
            let error = size
                .check_device(TextureTarget::Frame, DOWNLEVEL_EDGE)
                .expect_err("a downlevel device cannot allocate this frame");
            assert!(
                matches!(
                    error,
                    CompositorError::DeviceTextureLimit {
                        target: TextureTarget::Frame,
                        axis: Axis::Width,
                        value,
                        max: DOWNLEVEL_EDGE,
                    } if value == width
                ),
                "unexpected error for {width}x{height}: {error}"
            );
            // The same size on a device that can take it is not refused, so the check is a device
            // bound rather than a second static one.
            assert!(
                size.check_device(TextureTarget::Frame, MAX_FRAME_DIMENSION)
                    .is_ok(),
                "{width}x{height} must compose on a device that allows {MAX_FRAME_DIMENSION}"
            );
        }
    }

    /// A tall-and-narrow texture is refused on its height, not silently on the wrong axis.
    #[test]
    fn the_refused_axis_is_the_one_that_exceeded() {
        let error = check_device_texture(TextureTarget::Source, 16, 4_096, DOWNLEVEL_EDGE)
            .expect_err("a 4096-pixel height is past a downlevel device");
        assert!(
            matches!(
                error,
                CompositorError::DeviceTextureLimit {
                    target: TextureTarget::Source,
                    axis: Axis::Height,
                    value: 4_096,
                    max: DOWNLEVEL_EDGE,
                }
            ),
            "unexpected error: {error}"
        );
    }

    /// The glyph atlas rides the same device limit as the frame, and its own ceiling exceeds a
    /// downlevel device's.
    #[test]
    fn a_glyph_atlas_past_the_device_edge_is_refused_too() {
        let error = check_device_texture(
            TextureTarget::Atlas,
            osg_scene::glyph::MAX_ATLAS_DIMENSION_PX,
            256,
            DOWNLEVEL_EDGE,
        )
        .expect_err("a 4096-pixel atlas is past a downlevel device");
        assert!(
            matches!(
                error,
                CompositorError::DeviceTextureLimit {
                    target: TextureTarget::Atlas,
                    axis: Axis::Width,
                    max: DOWNLEVEL_EDGE,
                    ..
                }
            ),
            "unexpected error: {error}"
        );
        assert!(
            check_device_texture(TextureTarget::Atlas, 16, 8, DOWNLEVEL_EDGE).is_ok(),
            "an atlas inside the device edge must not be refused"
        );
    }

    /// The message names the limit, the need and which texture, and nothing else.
    #[test]
    fn the_refusal_says_what_the_device_can_do_and_what_was_asked_of_it() {
        let error = check_device_texture(TextureTarget::Frame, 3_840, 2_160, DOWNLEVEL_EDGE)
            .expect_err("4K is past a downlevel device");
        let message = error.to_string();
        assert!(message.contains("2048"), "the limit is missing: {message}");
        assert!(
            message.contains("3840"),
            "the request is missing: {message}"
        );
        assert!(
            message.contains("composition"),
            "the texture is missing: {message}"
        );
    }
}
