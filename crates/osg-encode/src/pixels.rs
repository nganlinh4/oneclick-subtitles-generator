//! The byte buffer the compositor and the encoder meet at.
//!
//! `osg-compositor` reads a composed frame back as tightly packed **RGBA8**, top row first
//! (`osg_compositor::Frame::pixels`). Media Foundation's uncompressed RGB subtype is
//! `MFVideoFormat_ARGB32`, whose memory order is **B, G, R, A**. The two are not the same buffer,
//! so a frame crosses this module and the red and blue channels are exchanged on the way through.
//!
//! Everything here is pure and length-checked before a single byte is read, because the next thing
//! that happens to the converted bytes is a copy into a locked platform buffer.

use crate::error::{ConfigField, EncodeError};

/// The number of bytes one pixel occupies in every layout this crate handles.
pub const BYTES_PER_PIXEL: u64 = 4;

/// How the four bytes of a pixel are ordered in a caller's buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelLayout {
    /// `R, G, B, A` — what `osg-compositor` reads back.
    Rgba8,
    /// `B, G, R, A` — what `MFVideoFormat_ARGB32` expects, so no conversion is needed.
    Bgra8,
}

/// A validated, borrowed view of one composed frame.
///
/// Constructing one is the only way to get a frame into the encoder, and construction is where the
/// buffer length is checked against `width * height * 4`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameBuffer<'pixels> {
    pixels: &'pixels [u8],
    width: u32,
    height: u32,
    layout: PixelLayout,
}

impl<'pixels> FrameBuffer<'pixels> {
    /// Validates `pixels` as a `width` x `height` frame in `layout`.
    ///
    /// # Errors
    /// Returns [`EncodeError::FrameSizeMismatch`] when the buffer is not exactly
    /// `width * height * 4` bytes, and [`EncodeError::UnsupportedConfig`] when either dimension is
    /// zero.
    pub fn new(
        pixels: &'pixels [u8],
        width: u32,
        height: u32,
        layout: PixelLayout,
    ) -> Result<Self, EncodeError> {
        let expected = required_bytes(width, height)?;
        let actual = byte_len(pixels);
        if actual != expected {
            return Err(EncodeError::FrameSizeMismatch {
                width,
                height,
                expected,
                actual,
            });
        }
        Ok(Self {
            pixels,
            width,
            height,
            layout,
        })
    }

    /// The frame width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// The frame height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// How the caller's bytes are ordered.
    #[must_use]
    pub const fn layout(&self) -> PixelLayout {
        self.layout
    }

    /// The validated bytes.
    #[must_use]
    pub const fn pixels(&self) -> &'pixels [u8] {
        self.pixels
    }

    /// Writes this frame into `destination` as BGRA8, converting if needed.
    ///
    /// `destination` must be exactly as long as the frame. The write is total: every byte of
    /// `destination` is assigned, so a caller may hand over uninitialised-looking scratch space
    /// without leaking whatever was there before.
    ///
    /// # Errors
    /// Returns [`EncodeError::FrameSizeMismatch`] when `destination` is not the frame's length.
    pub fn copy_as_bgra(&self, destination: &mut [u8]) -> Result<(), EncodeError> {
        if destination.len() != self.pixels.len() {
            return Err(EncodeError::FrameSizeMismatch {
                width: self.width,
                height: self.height,
                expected: byte_len(self.pixels),
                actual: byte_len(destination),
            });
        }
        match self.layout {
            PixelLayout::Bgra8 => destination.copy_from_slice(self.pixels),
            PixelLayout::Rgba8 => swap_red_and_blue(self.pixels, destination),
        }
        Ok(())
    }
}

/// The byte count a `width` x `height` RGBA8 or BGRA8 frame occupies.
///
/// # Errors
/// Returns [`EncodeError::UnsupportedConfig`] when either dimension is zero.
pub fn required_bytes(width: u32, height: u32) -> Result<u64, EncodeError> {
    if width == 0 {
        return Err(EncodeError::UnsupportedConfig {
            field: ConfigField::Width,
        });
    }
    if height == 0 {
        return Err(EncodeError::UnsupportedConfig {
            field: ConfigField::Height,
        });
    }
    // u32 * u32 * 4 is at most 2^68 in theory, but both dimensions are bounded well below that by
    // `VideoConfig`; u64 is used so this function is safe to call before those bounds are applied.
    Ok(u64::from(width) * u64::from(height) * BYTES_PER_PIXEL)
}

/// A slice's length as a `u64`.
///
/// Saturating rather than fallible: on every target this crate builds for, `usize` is 64 bits or
/// narrower, so the fallback is unreachable and does not deserve an error path of its own.
fn byte_len(slice: &[u8]) -> u64 {
    u64::try_from(slice.len()).unwrap_or(u64::MAX)
}

/// Copies `source` into `destination` with the first and third bytes of every pixel exchanged.
///
/// Panic-free by construction: both slices are walked in fixed four-byte steps and the caller has
/// already established that they are the same length.
fn swap_red_and_blue(source: &[u8], destination: &mut [u8]) {
    for (input, output) in source.chunks_exact(4).zip(destination.chunks_exact_mut(4)) {
        output[0] = input[2];
        output[1] = input[1];
        output[2] = input[0];
        output[3] = input[3];
    }
}
