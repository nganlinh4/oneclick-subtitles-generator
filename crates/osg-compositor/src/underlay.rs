//! The video underlay: a decoded source frame plus what the export does to it.
//!
//! The seam with the decoder is deliberately a byte buffer. `docs/rewrite/NATIVE_RENDERER.md`
//! settles decoding on `IMFSourceReader`, but the compositor must not know that: it takes tightly
//! packed RGBA8 and its dimensions, so the same path serves a Media Foundation frame, a test
//! fixture, and whatever a second platform's decoder eventually produces. Nothing here links
//! against a decoder crate.
//!
//! Alpha convention: the **source** bytes are straight alpha, because that is what an image decoder
//! produces and what an opaque video frame trivially satisfies. The compositor premultiplies on the
//! way in, so [`crate::Frame`]'s premultiplied contract is unchanged.

use crate::crop::Crop;
use crate::error::{CompositorError, Rejection};
use crate::size::FrameSize;

/// One decoded source frame in host memory.
///
/// Pixels are tightly packed RGBA8 with straight alpha, top row first — the same layout
/// [`crate::Frame`] reads back, minus the premultiplication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFrame {
    size: FrameSize,
    pixels: Vec<u8>,
}

impl SourceFrame {
    /// Check a decoded frame against its own dimensions.
    ///
    /// # Errors
    /// Returns a dimension error when the frame is larger than the compositor will allocate, and
    /// [`CompositorError::UnsupportedSceneInput`] when the buffer is not exactly
    /// `width * height * 4` bytes. A short buffer is refused rather than padded: padding it would
    /// draw whatever the allocator last left there.
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, CompositorError> {
        let size = FrameSize::new(width, height)?;
        if u64::try_from(pixels.len()) != Ok(size.rgba8_len()) {
            return Err(Rejection::SourcePixelCount.into());
        }
        Ok(Self { size, pixels })
    }

    /// The validated source size.
    #[must_use]
    pub const fn size(&self) -> FrameSize {
        self.size
    }

    /// The source width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.size.width()
    }

    /// The source height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.size.height()
    }

    /// The pixels, tightly packed as `width * height * 4` straight-alpha RGBA8 bytes.
    #[must_use]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }
}

/// A source frame and the crop, flip and backfill that place it under the subtitle layer.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoUnderlay {
    source: SourceFrame,
    crop: Crop,
}

impl VideoUnderlay {
    /// Pair a decoded frame with a resolved crop.
    #[must_use]
    pub const fn new(source: SourceFrame, crop: Crop) -> Self {
        Self { source, crop }
    }

    /// The whole source frame, unflipped, with no backfill.
    #[must_use]
    pub const fn whole(source: SourceFrame) -> Self {
        Self::new(source, Crop::identity())
    }

    /// The decoded frame.
    #[must_use]
    pub const fn source(&self) -> &SourceFrame {
        &self.source
    }

    /// The crop, flip and backfill applied to it.
    #[must_use]
    pub const fn crop(&self) -> Crop {
        self.crop
    }
}

#[cfg(test)]
mod tests {
    use super::{SourceFrame, VideoUnderlay};
    use crate::crop::Crop;
    use crate::error::{Axis, CompositorError, Rejection};

    #[test]
    fn a_frame_must_carry_exactly_its_own_pixels() {
        let short = SourceFrame::new(4, 4, vec![0; 4 * 4 * 4 - 1])
            .expect_err("a buffer one byte short is not a frame");
        assert!(
            matches!(
                short,
                CompositorError::UnsupportedSceneInput {
                    reason: Rejection::SourcePixelCount
                }
            ),
            "unexpected error: {short}"
        );

        let long = SourceFrame::new(4, 4, vec![0; 4 * 4 * 4 + 1])
            .expect_err("a buffer with trailing bytes is not a frame either");
        assert!(
            matches!(
                long,
                CompositorError::UnsupportedSceneInput {
                    reason: Rejection::SourcePixelCount
                }
            ),
            "unexpected error: {long}"
        );
    }

    #[test]
    fn an_absurd_source_size_is_refused_before_anything_is_allocated() {
        let error = SourceFrame::new(0, 4, Vec::new()).expect_err("a zero edge is not a frame");
        assert!(
            matches!(
                error,
                CompositorError::DimensionOutOfRange {
                    axis: Axis::Width,
                    value: 0,
                    ..
                }
            ),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_whole_underlay_carries_the_identity_crop() {
        let source = SourceFrame::new(2, 2, vec![255; 2 * 2 * 4]).expect("a 2x2 frame is valid");
        let underlay = VideoUnderlay::whole(source);
        assert_eq!(underlay.crop(), Crop::identity());
        assert_eq!(underlay.source().pixels().len(), 16);
    }
}
