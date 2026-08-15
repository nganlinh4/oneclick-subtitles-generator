//! What the decoder found out about the file, before any frame is decoded.
//!
//! The export's output size and the crop region both derive from the source's real dimensions, and
//! the export's length derives from its real duration, so these are not diagnostics — they are
//! inputs. The shipped renderer took the final duration from however many frames the extractor
//! happened to produce; this crate reports what the file says and lets the timeline decide, which
//! is the correction `src/platform/renderParityLedger.js` records under `DURATION_SOURCE`.

use crate::colorimetry::SourceColorimetry;
use crate::planes::FrameGeometry;
use crate::sampling::SourceGrid;

/// Everything the decoder knows about a source before it decodes anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceInfo {
    geometry: FrameGeometry,
    grid: SourceGrid,
    duration_100ns: i64,
    colorimetry: SourceColorimetry,
}

impl SourceInfo {
    pub(crate) const fn new(
        geometry: FrameGeometry,
        grid: SourceGrid,
        duration_100ns: i64,
        colorimetry: SourceColorimetry,
    ) -> Self {
        Self {
            geometry,
            grid,
            duration_100ns,
            colorimetry,
        }
    }

    /// The real decoded width in pixels.
    #[must_use]
    pub const fn width(self) -> usize {
        self.geometry.width()
    }

    /// The real decoded height in pixels.
    #[must_use]
    pub const fn height(self) -> usize {
        self.geometry.height()
    }

    /// The decoded frame geometry.
    #[must_use]
    pub const fn geometry(self) -> FrameGeometry {
        self.geometry
    }

    /// The source's frame grid, as it declares it.
    #[must_use]
    pub const fn grid(self) -> SourceGrid {
        self.grid
    }

    /// The frame rate numerator the source declares.
    #[must_use]
    pub const fn fps_numerator(self) -> u32 {
        self.grid.numerator()
    }

    /// The frame rate denominator the source declares.
    ///
    /// Kept as a ratio rather than reduced to a float, so 29.97 stays `30000/1001` and an
    /// hour-long source does not drift against the export it is being composited into.
    #[must_use]
    pub const fn fps_denominator(self) -> u32 {
        self.grid.denominator()
    }

    /// The source duration in 100ns units, as the container declares it.
    #[must_use]
    pub const fn duration_100ns(self) -> i64 {
        self.duration_100ns
    }

    /// How many whole frames the declared duration and frame rate imply.
    ///
    /// Nominal, not measured: it is what the container says, which is the right thing to plan an
    /// export against. What the file actually delivers is reported by decoding it, and a shortfall
    /// is [`crate::error::DecodeError::TruncatedStream`] rather than a quietly shorter export.
    #[must_use]
    pub fn nominal_frame_count(self) -> u64 {
        self.grid.frame_count_for(self.duration_100ns)
    }

    /// The colour description the frames are decoded with.
    #[must_use]
    pub const fn colorimetry(self) -> SourceColorimetry {
        self.colorimetry
    }

    /// The duration in seconds, for display only.
    ///
    /// Lossy by definition. Never derive a timestamp from it — the exact value is
    /// [`Self::duration_100ns`] and the exact grid is [`Self::grid`].
    #[must_use]
    #[expect(
        clippy::cast_precision_loss,
        reason = "the caller is explicitly asking for the lossy seconds view"
    )]
    pub fn duration_seconds_lossy(self) -> f64 {
        self.duration_100ns as f64 / 10_000_000.0
    }
}
