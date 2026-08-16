//! What the decoder found out about the file, before any frame is decoded.
//!
//! The export's output size and the crop region both derive from the source's real dimensions, and
//! the export's length derives from its real duration, so these are not diagnostics — they are
//! inputs. The shipped renderer took the final duration from however many frames the extractor
//! happened to produce; this crate reports what the file says and lets the timeline decide, which
//! is the correction `src/platform/renderParityLedger.js` records under `DURATION_SOURCE`.
//!
//! # Which size
//!
//! There is deliberately no `width()` here. A source has three sizes — see [`crate::presentation`]
//! — and the one a caller wants depends on what the caller is doing:
//!
//! * sizing a buffer, a stride or a frame layout: [`SourceInfo::coded_geometry`];
//! * reading pixels out of a [`crate::DecodedFrame`]: [`SourceInfo::geometry`], which is the coded
//!   grid with the rotation applied;
//! * sizing a composition, or validating a render request: [`SourceInfo::display_width`] and
//!   [`SourceInfo::display_height`], which are what the editor's `<video>` element reports.
//!
//! They are the same numbers for an ordinary file and different numbers for an anamorphic or a
//! rotated one, which is exactly why the choice is made at the call site instead of here.

use crate::colorimetry::SourceColorimetry;
use crate::planes::FrameGeometry;
use crate::presentation::{DisplaySize, PixelAspect, Rotation, SourcePresentation};
use crate::sampling::SourceGrid;

/// Everything the decoder knows about a source before it decodes anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceInfo {
    presentation: SourcePresentation,
    grid: SourceGrid,
    duration_100ns: i64,
    colorimetry: SourceColorimetry,
}

impl SourceInfo {
    pub(crate) const fn new(
        presentation: SourcePresentation,
        grid: SourceGrid,
        duration_100ns: i64,
        colorimetry: SourceColorimetry,
    ) -> Self {
        Self {
            presentation,
            grid,
            duration_100ns,
            colorimetry,
        }
    }

    /// The coded grid, the rotation and the pixel aspect, together.
    #[must_use]
    pub const fn presentation(self) -> SourcePresentation {
        self.presentation
    }

    /// The grid the platform decodes into, before the rotation is applied.
    ///
    /// This is `MF_MT_FRAME_SIZE`: the size of the buffer a decoded sample arrives in, and the size
    /// every stride and layout check is made against. It is *not* the size to compose at.
    #[must_use]
    pub const fn coded_geometry(self) -> FrameGeometry {
        self.presentation.coded()
    }

    /// The geometry of the frames this decoder hands out.
    ///
    /// The coded grid with the rotation applied, so a portrait phone clip reports portrait here and
    /// the pixels of a [`crate::DecodedFrame`] really are laid out that way.
    #[must_use]
    pub const fn geometry(self) -> FrameGeometry {
        self.presentation.decoded()
    }

    /// The decoded frame width in pixels.
    #[must_use]
    pub const fn decoded_width(self) -> usize {
        self.geometry().width()
    }

    /// The decoded frame height in pixels.
    #[must_use]
    pub const fn decoded_height(self) -> usize {
        self.geometry().height()
    }

    /// The size a composition of this source is derived from.
    ///
    /// Rotation and pixel aspect applied: the number the editor's `<video>` element reports as
    /// `videoWidth`/`videoHeight`. Validate a render request against this and the preview, the
    /// export and the browser all compose the same frame.
    #[must_use]
    pub fn display_size(self) -> DisplaySize {
        self.presentation.display()
    }

    /// The display width in pixels.
    #[must_use]
    pub fn display_width(self) -> u32 {
        self.display_size().width()
    }

    /// The display height in pixels.
    #[must_use]
    pub fn display_height(self) -> u32 {
        self.display_size().height()
    }

    /// The turn the decoder applies to stand the source upright.
    #[must_use]
    pub const fn rotation(self) -> Rotation {
        self.presentation.rotation()
    }

    /// The pixel aspect ratio the source declares, or [`PixelAspect::SQUARE`] when it declares none.
    #[must_use]
    pub const fn pixel_aspect(self) -> PixelAspect {
        self.presentation.pixel_aspect()
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
