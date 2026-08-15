//! A composed frame in host memory.
//!
//! Frames come out of the compositor with **premultiplied** alpha, which is right for compositing
//! and wrong for PNG. Getting that conversion wrong is the most plausible way to reintroduce the
//! preview/export divergence this whole architecture exists to prevent, so the conversion lives
//! here, next to the pixels, rather than being rewritten at each call site. See
//! [`Frame::to_straight_alpha`].

use crate::size::FrameSize;

/// Tightly packed RGBA8 pixels for one composed frame, top row first.
///
/// Alpha is premultiplied. Anything that hands these bytes to a format defined in terms of straight
/// alpha — PNG above all — must call [`Frame::to_straight_alpha`] first.
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

    /// The same pixels with alpha divided back out, for formats that define alpha as straight.
    ///
    /// PNG is the one that matters: its alpha is straight by specification, so writing these
    /// premultiplied bytes into a PNG unchanged makes every partly transparent pixel too dark. That
    /// is not a uniform, obvious shift — it lands exactly on antialiased glyph edges and on cues
    /// that are fading, while fully opaque areas look perfect. The preview would show subtly
    /// crunchy, dark-fringed text and the export would not, which is precisely the divergence the
    /// single-pipeline architecture is meant to make impossible.
    ///
    /// Fully transparent pixels carry no colour to recover, so they stay `0,0,0,0` rather than
    /// having a nonsense colour divided out of them.
    ///
    /// The conversion is lossy in the low bits and is not the inverse of premultiplication: a
    /// channel quantised to 8 bits at low alpha cannot be restored exactly. It is only ever applied
    /// on the way out to an image file, never on the export path, where the subtitle layer is
    /// composited over decoded video while it is still premultiplied.
    #[must_use]
    pub fn to_straight_alpha(&self) -> Vec<u8> {
        let mut out = self.pixels.clone();
        for pixel in out.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            if alpha == 0 {
                pixel[0] = 0;
                pixel[1] = 0;
                pixel[2] = 0;
                continue;
            }
            if alpha == 255 {
                continue;
            }
            for channel in &mut pixel[..3] {
                // Round to nearest rather than truncating, so a value that premultiplied cleanly
                // comes back to itself instead of drifting one level darker every round trip.
                let restored = (u32::from(*channel) * 255 + alpha / 2) / alpha;
                *channel = u8::try_from(restored.min(255)).unwrap_or(255);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::Frame;
    use crate::size::FrameSize;

    fn frame(pixels: &[u8]) -> Frame {
        let size = FrameSize::new(16, 16).expect("size");
        let mut buffer = vec![0_u8; 16 * 16 * 4];
        buffer[..pixels.len()].copy_from_slice(pixels);
        Frame::new(size, buffer)
    }

    /// What the compositor produces for `colour` at `alpha`, so the fixtures are premultiplied the
    /// same way the shader premultiplies rather than by hand-picked numbers.
    fn premultiplied(colour: [u8; 3], alpha: u8) -> [u8; 4] {
        let scale = |channel: u8| {
            u8::try_from((u32::from(channel) * u32::from(alpha) + 127) / 255).unwrap_or(255)
        };
        [scale(colour[0]), scale(colour[1]), scale(colour[2]), alpha]
    }

    #[test]
    fn an_opaque_pixel_is_returned_unchanged() {
        let frame = frame(&[10, 20, 30, 255]);
        assert_eq!(&frame.to_straight_alpha()[..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn a_transparent_pixel_keeps_no_colour_to_divide_out() {
        // A premultiplied transparent pixel carries no recoverable colour, so inventing one would
        // put arbitrary values into the file for anything that later ignores alpha.
        let frame = frame(&[0, 0, 0, 0]);
        assert_eq!(&frame.to_straight_alpha()[..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn a_half_transparent_pixel_recovers_its_colour() {
        // The case that matters: a white glyph edge at half coverage. Premultiplied it is mid-grey,
        // and writing that straight into a PNG would draw the edge grey instead of white-at-50%.
        let premultiplied = premultiplied([255, 255, 255], 128);
        assert_eq!(premultiplied, [128, 128, 128, 128]);

        let straight = frame(&premultiplied).to_straight_alpha();
        assert_eq!(&straight[..4], &[255, 255, 255, 128]);
    }

    #[test]
    fn every_colour_and_alpha_recovers_to_within_one_level() {
        // Premultiplication quantises to 8 bits, so the inverse cannot be exact at low alpha. It
        // must still never be systematically dark, which is the failure that would show up as
        // fringed text. One level is the whole tolerance.
        for alpha in 1_u8..=255 {
            for channel in [0_u8, 1, 64, 127, 128, 200, 254, 255] {
                let source = premultiplied([channel, channel, channel], alpha);
                let straight = frame(&source).to_straight_alpha();

                // Only values that survive premultiplication can come back; a channel brighter than
                // its own alpha allows is clamped, so compare against what was actually storable.
                let storable =
                    u8::try_from(u32::from(source[0]) * 255 / u32::from(alpha)).unwrap_or(255);
                let difference = i32::from(straight[0]) - i32::from(storable);
                assert!(
                    difference.abs() <= 1,
                    "alpha {alpha}, channel {channel}: stored {}, recovered {}",
                    source[0],
                    straight[0]
                );
                assert_eq!(straight[3], alpha, "alpha must never change");
            }
        }
    }

    #[test]
    fn the_conversion_does_not_disturb_the_frame_it_reads() {
        // The export path keeps using the premultiplied pixels after a preview PNG has been made
        // from the same frame, so this must not be an in-place edit.
        let source = premultiplied([200, 100, 50], 64);
        let frame = frame(&source);
        let before = frame.pixels().to_vec();
        let straight = frame.to_straight_alpha();

        assert_eq!(frame.pixels(), &before[..]);
        assert_ne!(straight[..4], before[..4]);
        assert_eq!(straight.len(), before.len());
    }
}
