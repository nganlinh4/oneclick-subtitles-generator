//! Reading a composed frame as evidence.
//!
//! The decoration suites assert in the vocabulary a user would use — "the stroke colour is on
//! screen", "the letter is still white", "the box grew upward" — so the arithmetic that turns
//! bytes into those answers lives here once instead of being re-derived per test.
//!
//! Frames are **premultiplied**, so a half-covered red pixel is `(127, 0, 0, 127)` and not
//! `(255, 0, 0, 127)`. Every hue predicate below compares channels against each other rather than
//! against a fixed threshold, which is what makes it survive that.

use osg_compositor::Frame;

/// How many pixels carry any coverage at all.
pub(crate) fn inked(frame: &Frame) -> usize {
    frame.pixels().chunks_exact(4).filter(|p| p[3] > 0).count()
}

/// How many pixels are exactly this byte quadruple.
pub(crate) fn exactly(frame: &Frame, wanted: [u8; 4]) -> usize {
    frame
        .pixels()
        .chunks_exact(4)
        .filter(|pixel| *pixel == wanted)
        .count()
}

/// How many pixels satisfy a predicate.
pub(crate) fn count_where(frame: &Frame, predicate: impl Fn(&[u8]) -> bool) -> usize {
    frame
        .pixels()
        .chunks_exact(4)
        .filter(|pixel| predicate(pixel))
        .count()
}

/// Enough of a channel lead that no rounding or antialiasing could have produced it by accident.
const LEAD: u8 = 24;

pub(crate) fn reddish(pixel: &[u8]) -> bool {
    pixel[3] > 0
        && pixel[0] > pixel[1].saturating_add(LEAD)
        && pixel[0] > pixel[2].saturating_add(LEAD)
}

pub(crate) fn greenish(pixel: &[u8]) -> bool {
    pixel[3] > 0
        && pixel[1] > pixel[0].saturating_add(LEAD)
        && pixel[1] > pixel[2].saturating_add(LEAD)
}

pub(crate) fn bluish(pixel: &[u8]) -> bool {
    pixel[3] > 0
        && pixel[2] > pixel[0].saturating_add(LEAD)
        && pixel[2] > pixel[1].saturating_add(LEAD)
}

/// The first row that carries any coverage, or `None` for an empty frame.
pub(crate) fn top_inked_row(frame: &Frame) -> Option<u32> {
    (0..frame.height())
        .find(|y| (0..frame.width()).any(|x| frame.pixel(x, *y).is_some_and(|pixel| pixel[3] > 0)))
}

/// The first column that carries any coverage, or `None` for an empty frame.
pub(crate) fn left_inked_column(frame: &Frame) -> Option<u32> {
    (0..frame.width())
        .find(|x| (0..frame.height()).any(|y| frame.pixel(*x, y).is_some_and(|pixel| pixel[3] > 0)))
}

/// The first column carrying coverage within a band of rows, or `None` when the band is empty.
///
/// A band rather than the whole frame because a laid-out run's lines are separate objects: asking
/// where line two starts means asking within line two's rows.
pub(crate) fn left_inked_column_in_rows(frame: &Frame, rows: core::ops::Range<u32>) -> Option<u32> {
    (0..frame.width()).find(|x| {
        rows.clone()
            .any(|y| frame.pixel(*x, y).is_some_and(|pixel| pixel[3] > 0))
    })
}

/// The last column carrying coverage within a band of rows, or `None` when the band is empty.
pub(crate) fn right_inked_column_in_rows(
    frame: &Frame,
    rows: core::ops::Range<u32>,
) -> Option<u32> {
    (0..frame.width()).rev().find(|x| {
        rows.clone()
            .any(|y| frame.pixel(*x, y).is_some_and(|pixel| pixel[3] > 0))
    })
}

/// The coverage-weighted centre of the ink, or `None` for an empty frame.
pub(crate) fn ink_centre(frame: &Frame) -> Option<(f64, f64)> {
    let mut total = (0.0_f64, 0.0_f64);
    let mut weight = 0.0_f64;
    for y in 0..frame.height() {
        for x in 0..frame.width() {
            let Some(pixel) = frame.pixel(x, y) else {
                continue;
            };
            let alpha = f64::from(pixel[3]) / 255.0;
            total.0 += f64::from(x) * alpha;
            total.1 += f64::from(y) * alpha;
            weight += alpha;
        }
    }
    (weight > 0.0).then(|| (total.0 / weight, total.1 / weight))
}
