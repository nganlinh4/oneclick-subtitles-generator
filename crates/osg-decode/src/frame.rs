//! One decoded source frame, in host memory, in the representation the compositor consumes.

use core::fmt;

use crate::planes::FrameGeometry;

/// A decoded source frame as tightly packed RGBA8, top row first.
///
/// The same byte layout `osg_compositor::Frame` uses, deliberately: the decoded underlay and the
/// subtitle layer have to meet in one representation or the composite is doing a conversion nobody
/// specified. Every pixel is opaque, so these bytes are simultaneously valid as premultiplied and
/// as straight alpha and no conversion is needed in either direction.
///
/// The frame owns its pixels. The `IMFSample` they were read out of has already been unlocked and
/// may already have been recycled by the platform — which is exactly why the copy happens while the
/// sample is still borrowed, inside a lock whose lifetime the compiler enforces, rather than by
/// handing the caller a pointer and a rule to remember.
#[derive(Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    geometry: FrameGeometry,
    pixels: Vec<u8>,
    presentation_100ns: i64,
    duration_100ns: i64,
    source_index: u64,
}

impl fmt::Debug for DecodedFrame {
    /// Redacted on purpose: the pixels are the user's video. A `{:?}` of a frame reports its shape
    /// and its place on the timeline, never its content, so a decoder's debug output is as safe to
    /// log as its errors are.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DecodedFrame")
            .field("width", &self.width())
            .field("height", &self.height())
            .field("presentation_100ns", &self.presentation_100ns)
            .field("duration_100ns", &self.duration_100ns)
            .field("source_index", &self.source_index)
            .field("bytes", &self.pixels.len())
            .finish_non_exhaustive()
    }
}

impl DecodedFrame {
    pub(crate) const fn new(
        geometry: FrameGeometry,
        pixels: Vec<u8>,
        presentation_100ns: i64,
        duration_100ns: i64,
        source_index: u64,
    ) -> Self {
        Self {
            geometry,
            pixels,
            presentation_100ns,
            duration_100ns,
            source_index,
        }
    }

    /// The frame width in pixels.
    #[must_use]
    pub const fn width(&self) -> usize {
        self.geometry.width()
    }

    /// The frame height in pixels.
    #[must_use]
    pub const fn height(&self) -> usize {
        self.geometry.height()
    }

    /// The frame's geometry.
    #[must_use]
    pub const fn geometry(&self) -> FrameGeometry {
        self.geometry
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

    /// The instant this frame is presented at in the source, in 100ns units.
    ///
    /// The container's own timestamp, not a value derived from an index, so it is the right thing
    /// to compare two decodes of the same frame with.
    #[must_use]
    pub const fn presentation_100ns(&self) -> i64 {
        self.presentation_100ns
    }

    /// How long this frame is shown for in the source, in 100ns units.
    #[must_use]
    pub const fn duration_100ns(&self) -> i64 {
        self.duration_100ns
    }

    /// Which frame of the source this is, on the source's own frame grid.
    #[must_use]
    pub const fn source_index(&self) -> u64 {
        self.source_index
    }

    /// The RGBA8 sample at `(x, y)`, or `None` when the coordinate is outside the frame.
    #[must_use]
    pub fn pixel(&self, x: usize, y: usize) -> Option<[u8; 4]> {
        if x >= self.width() || y >= self.height() {
            return None;
        }
        let start = (y * self.width() + x) * 4;
        let sample = self.pixels.get(start..start + 4)?;
        Some([sample[0], sample[1], sample[2], sample[3]])
    }
}
