//! Reading composed frames back, and the underlay fixtures every underlay test shares.
//!
//! The assertions in the underlay suites are geometric — "this colour is in that corner", "the
//! backfill covers exactly these columns" — so the arithmetic that turns a frame into those answers
//! lives here once rather than being re-derived per test file.

use osg_compositor::{Compositor, CompositorError, CropSpec, Frame, VideoUnderlay};

use super::{HEIGHT, WIDTH, underlay};

/// Acquire a compositor, or report loudly that nothing was verified.
pub(crate) fn adapter() -> Option<Compositor> {
    match Compositor::new() {
        Ok(compositor) => Some(compositor),
        Err(CompositorError::NoAdapter { reason }) => {
            eprintln!(
                "SKIPPED: no GPU adapter in this environment ({reason}). \
                 Underlay composition was NOT verified by this run."
            );
            None
        }
        Err(error) => panic!("the adapter was present but the compositor failed: {error}"),
    }
}

/// Bind a compositor or leave the test, so an adapter-less machine skips instead of failing.
macro_rules! compositor {
    () => {
        match $crate::common::frames::adapter() {
            Some(compositor) => compositor,
            None => return,
        }
    };
}
pub(crate) use compositor;

/// Fully opaque white, which is what the fixture cue's glyph interior composes to.
pub(crate) const OPAQUE_WHITE: [u8; 4] = [255, 255, 255, 255];

/// A crop that overhangs the source by half its width on each side, so the middle half of the
/// output is video and the outer quarters are whatever the backfill puts there.
pub(crate) const OVERHANG: CropSpec = CropSpec {
    x: -50.0,
    y: 0.0,
    width: 200.0,
    height: 100.0,
    flip_x: false,
    flip_y: false,
    canvas_bg_mode: None,
    canvas_bg_color: None,
    canvas_bg_blur: None,
};

/// The first and last output columns [`OVERHANG`] actually covers.
///
/// Derived rather than guessed: column `x` samples the source at `-0.5 + 2 * (x + 0.5) / WIDTH`,
/// which lies in `0..=1` exactly for the middle half of the frame.
pub(crate) const COVERED_FIRST: u32 = WIDTH / 4;
pub(crate) const COVERED_LAST: u32 = WIDTH - WIDTH / 4 - 1;

/// [`OVERHANG`] with a caller-chosen canvas background.
pub(crate) fn overhanging(
    mode: Option<&str>,
    colour: Option<&str>,
    blur: Option<f64>,
) -> VideoUnderlay {
    underlay(&CropSpec {
        canvas_bg_mode: mode.map(str::to_owned),
        canvas_bg_color: colour.map(str::to_owned),
        canvas_bg_blur: blur,
        ..OVERHANG
    })
}

pub(crate) fn pixel(frame: &Frame, x: u32, y: u32) -> [u8; 4] {
    frame
        .pixel(x, y)
        .expect("the coordinate is inside the frame")
}

/// The centre of one output quadrant, which is well clear of every interpolated boundary.
fn quadrant(frame: &Frame, right: bool, bottom: bool) -> [u8; 4] {
    let x = if right { WIDTH * 3 / 4 } else { WIDTH / 4 };
    let y = if bottom { HEIGHT * 3 / 4 } else { HEIGHT / 4 };
    pixel(frame, x, y)
}

/// The four quadrant centres, in reading order.
pub(crate) fn quadrants(frame: &Frame) -> [[u8; 4]; 4] {
    [
        quadrant(frame, false, false),
        quadrant(frame, true, false),
        quadrant(frame, false, true),
        quadrant(frame, true, true),
    ]
}

/// The frame with every row and column reversed, which is what both flips together must produce.
pub(crate) fn rotated_180(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.pixels().len());
    for y in (0..frame.height()).rev() {
        for x in (0..frame.width()).rev() {
            out.extend_from_slice(&pixel(frame, x, y));
        }
    }
    out
}

pub(crate) fn mirrored_horizontally(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.pixels().len());
    for y in 0..frame.height() {
        for x in (0..frame.width()).rev() {
            out.extend_from_slice(&pixel(frame, x, y));
        }
    }
    out
}

pub(crate) fn mirrored_vertically(frame: &Frame) -> Vec<u8> {
    let row_len = (frame.width() * 4) as usize;
    let mut out = Vec::with_capacity(frame.pixels().len());
    for y in (0..frame.height()).rev() {
        let start = y as usize * row_len;
        out.extend_from_slice(&frame.pixels()[start..start + row_len]);
    }
    out
}
