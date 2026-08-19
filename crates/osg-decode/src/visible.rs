//! The picture inside a decoded surface, which is not the same thing as the surface.
//!
//! A decoder hands back a buffer it finds convenient, not one shaped like the video. H.264 codes in
//! sixteen-pixel macroblocks, so a 640x360 stream decodes into a 640x368 surface with eight rows of
//! padding, and 1920x1080 decodes into 1920x1088. Those extra rows are not black and not a border:
//! they are whatever the encoder left there, and showing them means green or purple bands along an
//! edge.
//!
//! Conflating the two is a real defect this module exists to end. The decoder previously recorded
//! one geometry and refused when the platform later reported the padded one, so no frame decoded at
//! all for either of the sizes above. Accepting the padded size instead — without carrying the
//! picture rectangle — would have been worse: the chroma plane starts after the FULL surface, so
//! reading it at the picture height silently shifts colour, and the customer would have got a
//! quietly wrong image rather than a refusal.
//!
//! So three things stay distinct everywhere:
//!
//!   * the **surface**: what the platform allocated and filled, which is what plane maths reads;
//!   * the **visible region**: the rectangle of real picture inside it, origin included;
//!   * the **display size**: the visible region with pixel aspect and rotation applied, which is
//!     what a customer sees and what a composition is sized from.

use crate::error::DecodeError;
use crate::planes::FrameGeometry;

/// The rectangle of valid picture inside a decoded surface.
///
/// Constructed only through [`VisibleRegion::new`], which refuses anything that cannot address 4:2:0
/// chroma or does not fit the surface it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisibleRegion {
    x: usize,
    y: usize,
    size: FrameGeometry,
}

impl VisibleRegion {
    /// The region at `(x, y)` of `size` inside `surface`.
    ///
    /// # Errors
    /// Returns [`DecodeError::UnsupportedFrameLayout`] when the origin is odd, when the region runs
    /// past the surface, or when the arithmetic to reach its last row would overflow. An odd origin
    /// is refused rather than nudged: one chroma sample covers a two-by-two block of luma, so a
    /// picture starting on an odd row has no chroma sample of its own to start from, and moving the
    /// origin to make it fit would hand back a different picture than the file describes.
    pub fn new(
        x: u32,
        y: u32,
        size: FrameGeometry,
        surface: FrameGeometry,
    ) -> Result<Self, DecodeError> {
        let layout = DecodeError::UnsupportedFrameLayout;
        if !x.is_multiple_of(2) || !y.is_multiple_of(2) {
            return Err(layout);
        }
        let x = usize::try_from(x).map_err(|_| layout)?;
        let y = usize::try_from(y).map_err(|_| layout)?;
        let right = x.checked_add(size.width()).ok_or(layout)?;
        let bottom = y.checked_add(size.height()).ok_or(layout)?;
        if right > surface.width() || bottom > surface.height() {
            return Err(layout);
        }
        Ok(Self { x, y, size })
    }

    /// The whole surface, for a source that declares no smaller picture.
    #[must_use]
    pub const fn whole(surface: FrameGeometry) -> Self {
        Self {
            x: 0,
            y: 0,
            size: surface,
        }
    }

    /// The left edge, in luma samples.
    #[must_use]
    pub const fn x(self) -> usize {
        self.x
    }

    /// The top edge, in luma samples.
    #[must_use]
    pub const fn y(self) -> usize {
        self.y
    }

    /// The size of the picture itself.
    #[must_use]
    pub const fn size(self) -> FrameGeometry {
        self.size
    }

    /// Whether this region is the entire surface, in which case no cropping is needed.
    #[must_use]
    pub fn covers(self, surface: FrameGeometry) -> bool {
        self.x == 0 && self.y == 0 && self.size == surface
    }
}

#[cfg(test)]
mod tests {
    use super::VisibleRegion;
    use crate::planes::FrameGeometry;

    fn geometry(width: u32, height: u32) -> FrameGeometry {
        FrameGeometry::new(width, height).expect("geometry")
    }

    #[test]
    fn a_padded_surface_carries_the_picture_it_actually_holds() {
        // The case that produced no decodable frame at all: 360 rows of picture in a 368-row buffer.
        let surface = geometry(640, 368);
        let region = VisibleRegion::new(0, 0, geometry(640, 360), surface).expect("region");
        assert_eq!(region.size(), geometry(640, 360));
        assert!(
            !region.covers(surface),
            "the picture is not the whole surface"
        );
    }

    #[test]
    fn an_unpadded_surface_needs_no_crop() {
        let surface = geometry(640, 480);
        assert!(VisibleRegion::whole(surface).covers(surface));
    }

    #[test]
    fn a_region_running_past_the_surface_is_refused() {
        let surface = geometry(640, 368);
        assert!(VisibleRegion::new(0, 0, geometry(640, 480), surface).is_err());
        assert!(VisibleRegion::new(0, 16, geometry(640, 360), surface).is_err());
        assert!(VisibleRegion::new(64, 0, geometry(640, 360), surface).is_err());
    }

    #[test]
    fn an_odd_origin_is_refused_rather_than_nudged() {
        // One chroma sample covers two luma rows and columns, so an odd origin has no chroma sample
        // of its own; moving it would silently hand back a different picture.
        let surface = geometry(640, 368);
        assert!(VisibleRegion::new(1, 0, geometry(320, 240), surface).is_err());
        assert!(VisibleRegion::new(0, 3, geometry(320, 240), surface).is_err());
        assert!(VisibleRegion::new(2, 4, geometry(320, 240), surface).is_ok());
    }

    #[test]
    fn a_nonzero_origin_inside_the_surface_is_accepted() {
        let surface = geometry(1920, 1088);
        let region = VisibleRegion::new(8, 4, geometry(1900, 1080), surface).expect("region");
        assert_eq!((region.x(), region.y()), (8, 4));
        assert_eq!(region.size(), geometry(1900, 1080));
    }
}
