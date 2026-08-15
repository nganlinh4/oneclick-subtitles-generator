//! A composed frame in host memory.

use crate::size::FrameSize;

/// Tightly packed RGBA8 pixels for one composed frame, top row first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    size: FrameSize,
    pixels: Vec<u8>,
}

impl Frame {
    pub(crate) const fn new(size: FrameSize, pixels: Vec<u8>) -> Self {
        Self { size, pixels }
    }

    /// The size this frame was composed at.
    #[must_use]
    pub const fn size(&self) -> FrameSize {
        self.size
    }

    /// The frame width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.size.width()
    }

    /// The frame height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.size.height()
    }

    /// The pixels, tightly packed as `width * height * 4` RGBA8 bytes with no row padding.
    #[must_use]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Takes ownership of the pixels.
    #[must_use]
    pub fn into_pixels(self) -> Vec<u8> {
        self.pixels
    }

    /// The RGBA8 sample at `(x, y)`, or `None` when the coordinate is outside the frame.
    #[must_use]
    pub fn pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        if x >= self.width() || y >= self.height() {
            return None;
        }
        let index = usize::try_from((u64::from(y) * u64::from(self.width()) + u64::from(x)) * 4)
            .ok()
            .filter(|start| start + 4 <= self.pixels.len())?;
        Some([
            self.pixels[index],
            self.pixels[index + 1],
            self.pixels[index + 2],
            self.pixels[index + 3],
        ])
    }
}
