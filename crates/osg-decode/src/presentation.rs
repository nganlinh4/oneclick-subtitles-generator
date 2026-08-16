//! What the container says about how its coded pixels are meant to be *presented*.
//!
//! A source has three sizes, and treating them as one is a real, measured defect rather than a
//! theoretical one. The editor sizes its composition from the `<video>` element's
//! `videoWidth`/`videoHeight`, which is the browser's **display** size — pixel aspect ratio applied,
//! rotation applied. This crate read `MF_MT_FRAME_SIZE`, which is the **coded** size, and honoured
//! neither. Both sides then ran the identical width formula, so the formula was never the problem:
//! the input was.
//!
//! | Size | What it is | Who wants it |
//! | --- | --- | --- |
//! | [`SourcePresentation::coded`] | `MF_MT_FRAME_SIZE`: the grid the platform decodes into | the NV12 buffer, the stride check, the frame layout |
//! | [`SourcePresentation::decoded`] | the coded grid with the rotation applied | whoever reads pixels out of a [`crate::DecodedFrame`] |
//! | [`SourcePresentation::display`] | the coded grid with the rotation *and* the pixel aspect applied | whoever sizes a composition |
//!
//! Two examples, both from files a user of this application really has:
//!
//! * An anamorphic 720x480 clip whose pixels are wider than they are tall displays at 854x480. At
//!   1080p the display aspect composes 1922 and the coded aspect composes 1620.
//! * A portrait phone clip is stored as a 1920x1080 landscape frame plus a rotation. The browser
//!   reports 1080x1920; the coded size composes 608 pixels wide against the 1920 the editor shows.
//!
//! # When the container says nothing
//!
//! Media Foundation omits `MF_MT_PIXEL_ASPECT_RATIO` and `MF_MT_VIDEO_ROTATION` when the file does
//! not carry them, which is the common case: an ordinary camera or screen-capture file is square
//! pixels, unrotated. So an absent attribute is read as [`PixelAspect::SQUARE`] and
//! [`Rotation::None`] — not as unknown-and-refuse, because refusing would reject nearly every file,
//! and not as a guess from the frame shape, because a shape does not imply a ratio. That assumption
//! is exactly "the file did not ask for anything", and it leaves an ordinary source composing the
//! same size it composed before any of this existed.
//!
//! A *present* attribute this module cannot represent is a different matter and is refused:
//! [`crate::DecodeError::UnsupportedPixelAspect`] for a ratio with a zero term, and
//! [`crate::DecodeError::UnsupportedRotation`] for a rotation that is not a quarter turn. A file
//! that states something we cannot reproduce is not a file to guess about.

use crate::planes::FrameGeometry;

/// The quarter turn a source has to be given to be shown upright.
///
/// # Which way round
///
/// The direction is not a guess. `mfapi.h` documents `MF_MT_VIDEO_ROTATION` as "the degree that the
/// content **has already been rotated** in the counter clockwise direction", with the example that a
/// file rotated 90 degrees clockwise carries the value 270. So the value describes the turn already
/// applied to the stored frame, and presenting it upright means turning it back: clockwise, by the
/// same amount. That is what this type holds — the correcting turn, clockwise — so nothing
/// downstream has to remember which convention it is looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Rotation {
    /// The stored frame is already upright.
    #[default]
    None,
    /// A quarter turn clockwise.
    Quarter,
    /// A half turn.
    Half,
    /// Three quarters of a turn clockwise, which is a quarter turn anticlockwise.
    ThreeQuarter,
}

impl Rotation {
    /// Reads an `MF_MT_VIDEO_ROTATION` value: the anticlockwise turn already applied to the content.
    ///
    /// Returns `None` for a value that is not a quarter turn. Media Foundation documents only 0, 90,
    /// 180 and 270 as valid, and an arbitrary angle would need a resample rather than a turn.
    #[must_use]
    pub const fn from_already_rotated_degrees(degrees: u32) -> Option<Self> {
        match degrees {
            0 => Some(Self::None),
            90 => Some(Self::Quarter),
            180 => Some(Self::Half),
            270 => Some(Self::ThreeQuarter),
            _ => None,
        }
    }

    /// The correcting turn, in degrees clockwise.
    #[must_use]
    pub const fn clockwise_degrees(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Quarter => 90,
            Self::Half => 180,
            Self::ThreeQuarter => 270,
        }
    }

    /// Whether this turn swaps the two axes.
    #[must_use]
    pub const fn transposes(self) -> bool {
        matches!(self, Self::Quarter | Self::ThreeQuarter)
    }

    /// The frame this turn produces from a frame of `geometry`.
    #[must_use]
    pub const fn geometry(self, geometry: FrameGeometry) -> FrameGeometry {
        if self.transposes() {
            geometry.transposed()
        } else {
            geometry
        }
    }

    /// Where source pixel `(x, y)` of a `width` by `height` frame lands after this turn.
    ///
    /// The one piece of arithmetic the whole rotation rests on, kept in one place so a test can
    /// assert the corners rather than infer them from an image. The result indexes the *turned*
    /// frame, whose edges are [`Self::geometry`]'s.
    ///
    /// # Panics
    /// The coordinate must be inside the frame — `x < width` and `y < height`. The caller is the
    /// conversion loop, which walks exactly that range; an out-of-range coordinate panics in a debug
    /// build rather than silently naming a pixel in the wrong row.
    #[must_use]
    pub const fn place(self, x: usize, y: usize, width: usize, height: usize) -> (usize, usize) {
        match self {
            Self::None => (x, y),
            Self::Quarter => (height - 1 - y, x),
            Self::Half => (width - 1 - x, height - 1 - y),
            Self::ThreeQuarter => (y, width - 1 - x),
        }
    }
}

/// How wide one stored pixel is against how tall it is.
///
/// Kept as the ratio the container declares rather than a float, because the display size is derived
/// from it with integer arithmetic and has to be the same number on every machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelAspect {
    numerator: u32,
    denominator: u32,
}

impl Default for PixelAspect {
    fn default() -> Self {
        Self::SQUARE
    }
}

impl PixelAspect {
    /// Pixels as tall as they are wide, which is what almost every file carries.
    pub const SQUARE: Self = Self {
        numerator: 1,
        denominator: 1,
    };

    /// A declared ratio, or `None` when either term is zero.
    #[must_use]
    pub const fn new(numerator: u32, denominator: u32) -> Option<Self> {
        if numerator == 0 || denominator == 0 {
            return None;
        }
        Some(Self {
            numerator,
            denominator,
        })
    }

    /// The width term.
    #[must_use]
    pub const fn numerator(self) -> u32 {
        self.numerator
    }

    /// The height term.
    #[must_use]
    pub const fn denominator(self) -> u32 {
        self.denominator
    }

    /// Whether one stored pixel is square, in which case the display size is the coded size.
    #[must_use]
    pub const fn is_square(self) -> bool {
        self.numerator == self.denominator
    }
}

/// The size a composition of this source is derived from.
///
/// Deliberately not a [`FrameGeometry`]: a geometry describes a buffer that has to be decodable, and
/// a display size does not — 854x480 is a perfectly ordinary display size and would never be a
/// legal NV12 grid. Keeping them different types is what stops one being passed where the other is
/// meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplaySize {
    width: u32,
    height: u32,
}

impl DisplaySize {
    /// The display width in pixels.
    #[must_use]
    pub const fn width(self) -> u32 {
        self.width
    }

    /// The display height in pixels.
    #[must_use]
    pub const fn height(self) -> u32 {
        self.height
    }
}

/// The coded frame, plus everything the container says about presenting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourcePresentation {
    coded: FrameGeometry,
    rotation: Rotation,
    pixel_aspect: PixelAspect,
}

impl SourcePresentation {
    /// A coded frame with a declared rotation and pixel aspect.
    #[must_use]
    pub const fn new(coded: FrameGeometry, rotation: Rotation, pixel_aspect: PixelAspect) -> Self {
        Self {
            coded,
            rotation,
            pixel_aspect,
        }
    }

    /// A coded frame the container says nothing else about: square pixels, upright.
    #[must_use]
    pub const fn square(coded: FrameGeometry) -> Self {
        Self::new(coded, Rotation::None, PixelAspect::SQUARE)
    }

    /// The grid the platform decodes into, which is what an NV12 buffer has to hold.
    #[must_use]
    pub const fn coded(self) -> FrameGeometry {
        self.coded
    }

    /// The grid a decoded frame carries, which is the coded grid with the rotation applied.
    #[must_use]
    pub const fn decoded(self) -> FrameGeometry {
        self.rotation.geometry(self.coded)
    }

    /// The correcting turn the frames are decoded with.
    #[must_use]
    pub const fn rotation(self) -> Rotation {
        self.rotation
    }

    /// The declared pixel aspect ratio.
    #[must_use]
    pub const fn pixel_aspect(self) -> PixelAspect {
        self.pixel_aspect
    }

    /// The size a composition of this source is derived from.
    ///
    /// The stretch enlarges the shorter axis and never shrinks either one, which is the rule the
    /// browser applies to reach `videoWidth`/`videoHeight`; the rotation is applied afterwards,
    /// because the pixel aspect is a property of the stored frame's own axes. Integer arithmetic
    /// with a half-up round, so the number is the same on every machine.
    #[must_use]
    pub fn display(self) -> DisplaySize {
        let (width, height) = stretched(
            edge(self.coded.width()),
            edge(self.coded.height()),
            self.pixel_aspect,
        );
        if self.rotation.transposes() {
            DisplaySize {
                width: height,
                height: width,
            }
        } else {
            DisplaySize { width, height }
        }
    }
}

/// A frame edge as a `u32`, saturating rather than failing.
///
/// [`crate::DecodeLimits::check_geometry`] has already bounded every geometry that reaches this
/// module at 7680, so the saturation is unreachable there; it exists because [`FrameGeometry`] is
/// public and can be built without those bounds.
fn edge(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Applies the pixel aspect to a coded size, in the coded frame's own axes.
fn stretched(width: u32, height: u32, aspect: PixelAspect) -> (u32, u32) {
    let numerator = u64::from(aspect.numerator());
    let denominator = u64::from(aspect.denominator());
    match numerator.cmp(&denominator) {
        core::cmp::Ordering::Equal => (width, height),
        core::cmp::Ordering::Greater => (scaled(width, numerator, denominator), height),
        core::cmp::Ordering::Less => (width, scaled(height, denominator, numerator)),
    }
}

/// `edge * by / over`, rounded half up, saturating instead of wrapping.
fn scaled(edge: u32, by: u64, over: u64) -> u32 {
    let value = u64::from(edge)
        .saturating_mul(by)
        .saturating_add(over / 2)
        .checked_div(over)
        .unwrap_or(0);
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::{DisplaySize, PixelAspect, Rotation, SourcePresentation};
    use crate::planes::FrameGeometry;

    fn geometry(width: u32, height: u32) -> FrameGeometry {
        FrameGeometry::new(width, height).expect("an even, addressable frame")
    }

    #[test]
    fn a_plain_source_displays_at_exactly_its_coded_size() {
        // The regression guard. Nothing this module does may move an ordinary file.
        let presentation = SourcePresentation::square(geometry(1_920, 1_080));
        assert_eq!(presentation.coded(), geometry(1_920, 1_080));
        assert_eq!(presentation.decoded(), geometry(1_920, 1_080));
        assert_eq!(
            presentation.display(),
            DisplaySize {
                width: 1_920,
                height: 1_080
            }
        );
    }

    #[test]
    fn an_anamorphic_source_displays_wider_than_it_is_coded() {
        // 720x480 stored, 854x480 displayed: the clip the review measured composing 1922 in the
        // browser and 1620 here.
        let aspect = PixelAspect::new(427, 360).expect("a legal ratio");
        let presentation = SourcePresentation::new(geometry(720, 480), Rotation::None, aspect);
        assert_eq!(presentation.coded(), geometry(720, 480));
        assert_eq!(
            presentation.decoded(),
            geometry(720, 480),
            "a pixel aspect is not a rotation and must not move the decoded grid"
        );
        assert_eq!(presentation.display().width(), 854);
        assert_eq!(presentation.display().height(), 480);
    }

    #[test]
    fn a_pixel_narrower_than_it_is_tall_stretches_the_height_instead() {
        // The rule never shrinks an axis, so a sub-unit ratio grows the other one.
        let aspect = PixelAspect::new(3, 4).expect("a legal ratio");
        let display =
            SourcePresentation::new(geometry(1_440, 1_080), Rotation::None, aspect).display();
        assert_eq!((display.width(), display.height()), (1_440, 1_440));
    }

    #[test]
    fn a_rotated_phone_clip_is_portrait_in_both_the_decoded_and_the_display_size() {
        let presentation = SourcePresentation::new(
            geometry(1_920, 1_080),
            Rotation::Quarter,
            PixelAspect::SQUARE,
        );
        assert_eq!(presentation.coded(), geometry(1_920, 1_080));
        assert_eq!(presentation.decoded(), geometry(1_080, 1_920));
        assert_eq!(
            (
                presentation.display().width(),
                presentation.display().height()
            ),
            (1_080, 1_920)
        );
    }

    #[test]
    fn the_pixel_aspect_is_applied_in_the_coded_axes_and_then_turned() {
        // Order matters: a stretch applied after the turn would widen the portrait clip instead of
        // making it taller.
        let aspect = PixelAspect::new(2, 1).expect("a legal ratio");
        let display =
            SourcePresentation::new(geometry(1_920, 1_080), Rotation::Quarter, aspect).display();
        assert_eq!((display.width(), display.height()), (1_080, 3_840));
    }

    #[test]
    fn a_rotation_that_is_not_a_quarter_turn_is_not_a_rotation() {
        assert_eq!(
            Rotation::from_already_rotated_degrees(0),
            Some(Rotation::None)
        );
        assert_eq!(
            Rotation::from_already_rotated_degrees(90),
            Some(Rotation::Quarter),
            "90 degrees already turned anticlockwise is undone by a quarter turn clockwise"
        );
        assert_eq!(
            Rotation::from_already_rotated_degrees(270),
            Some(Rotation::ThreeQuarter)
        );
        assert_eq!(Rotation::from_already_rotated_degrees(45), None);
        assert_eq!(Rotation::from_already_rotated_degrees(360), None);
    }

    #[test]
    fn a_ratio_with_a_zero_term_is_not_a_ratio() {
        assert_eq!(PixelAspect::new(0, 1), None);
        assert_eq!(PixelAspect::new(1, 0), None);
        assert!(PixelAspect::SQUARE.is_square());
        assert!(!PixelAspect::new(4, 3).expect("a legal ratio").is_square());
    }

    #[test]
    fn a_quarter_turn_moves_the_top_left_corner_to_the_top_right() {
        // Asserted on coordinates rather than on an image, because this is the arithmetic every
        // rotated frame is written through.
        assert_eq!(Rotation::Quarter.place(0, 0, 4, 2), (1, 0));
        assert_eq!(Rotation::Quarter.place(3, 0, 4, 2), (1, 3));
        assert_eq!(Rotation::Half.place(0, 0, 4, 2), (3, 1));
        assert_eq!(Rotation::ThreeQuarter.place(0, 0, 4, 2), (0, 3));
        assert_eq!(Rotation::None.place(2, 1, 4, 2), (2, 1));
    }

    #[test]
    fn every_turn_is_a_bijection_of_the_frame() {
        // A turn that dropped or doubled a pixel would show up as a torn frame rather than as a
        // wrong size, so it is worth proving rather than eyeballing.
        for rotation in [
            Rotation::None,
            Rotation::Quarter,
            Rotation::Half,
            Rotation::ThreeQuarter,
        ] {
            let (width, height) = (6_usize, 4_usize);
            let destination = rotation.geometry(geometry(6, 4));
            let mut seen = vec![false; width * height];
            for y in 0..height {
                for x in 0..width {
                    let (moved_x, moved_y) = rotation.place(x, y, width, height);
                    assert!(moved_x < destination.width() && moved_y < destination.height());
                    let slot = moved_y * destination.width() + moved_x;
                    assert!(!seen[slot], "{rotation:?} put two pixels in one place");
                    seen[slot] = true;
                }
            }
            assert!(seen.into_iter().all(|hit| hit), "{rotation:?} left a hole");
        }
    }
}
