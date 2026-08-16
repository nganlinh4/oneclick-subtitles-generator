//! Coded size, display size and rotation, against real files the platform demuxes.
//!
//! # Why the clips are patched rather than encoded with the attribute
//!
//! `osg-encode` is the crate that writes an `MP4` here, and its configuration surface declares a
//! size, a rate, a bitrate and a keyframe interval — there is no pixel aspect and no rotation to
//! set, and giving it one is a different task from reading one. So each clip below is encoded
//! normally through Media Foundation and the container attribute is then written into the finished
//! file exactly where the specification puts it: a `pasp` box in the visual sample entry, and a
//! display matrix in `tkhd`. That is what a phone and a DVD ripper write, and Media Foundation's own
//! `MP4` source parses both — which is what makes these real sources rather than hand-built media
//! types with a hand-built answer.
//!
//! Both halves of every claim below are measured from pixels. A rotated clip is asserted by where
//! its quadrants land, not by the attribute it declares, because the attribute is the input to the
//! thing under test.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};

use osg_decode::{DecodedFrame, DecoderConfig, PixelAspect, Rotation, VideoDecoder, open_decoder};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
use osg_scene::{ExactTime, FrameTimeline};
use tempfile::TempDir;

/// Serialises Media Foundation across this binary's test threads.
///
/// Opening several source readers or sink writers at the same moment from one process has faulted
/// inside the platform layers here, and the product opens one at a time on one thread — so this is
/// a shape the harness creates and the application never does. `osg-export`'s media support takes
/// the same measure for the same reason. The guard is held only while the platform object is being
/// opened, not across the decode, so the suite stays parallel where parallelism is safe.
static PLATFORM: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn platform() -> std::sync::MutexGuard<'static, ()> {
    // A poisoned lock means another test panicked while holding it; whatever it was opening is gone
    // either way, so recovering is correct.
    PLATFORM
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

const FPS: u32 = 30;
const FRAMES: u32 = 10;

/// How far a decoded grey may sit from the grey that was encoded.
///
/// Wide enough for H.264 quantisation on a flat block, far narrower than the gap between any two of
/// the four levels below, so a quadrant that moved is never mistaken for one that compressed.
const GREY_TOLERANCE: i32 = 8;

/// The four quadrant greys, clockwise from the top left.
const TOP_LEFT: u8 = 32;
const TOP_RIGHT: u8 = 96;
const BOTTOM_LEFT: u8 = 160;
const BOTTOM_RIGHT: u8 = 224;

/// A frame of four flat, asymmetric grey quadrants. No RNG and no clock.
///
/// Asymmetric in both axes on purpose: a frame that was symmetric could be turned by any amount and
/// still look right, which would make every assertion below vacuous.
fn quadrant_frame(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let level = match (x < width / 2, y < height / 2) {
                (true, true) => TOP_LEFT,
                (false, true) => TOP_RIGHT,
                (true, false) => BOTTOM_LEFT,
                (false, false) => BOTTOM_RIGHT,
            };
            pixels.extend_from_slice(&[level, level, level, u8::MAX]);
        }
    }
    pixels
}

/// Encodes the quadrant clip at `width` by `height` and returns the file's bytes.
fn encoded_clip(directory: &TempDir, name: &str, width: u32, height: u32) -> Vec<u8> {
    let _platform = platform();
    let output = directory.path().join(name);
    let video = VideoConfig::new(width, height, FPS, 1, FRAMES)
        .expect("a supported configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder for these tests to mean anything");
    let pixels = quadrant_frame(width, height);
    for index in 0..FRAMES {
        let frame = FrameBuffer::new(&pixels, width, height, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the container is closed");
    fs::read(&output).expect("the encoder produced a readable file")
}

fn written(directory: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.path().join(name);
    fs::write(&path, bytes).expect("the patched clip is written");
    path
}

fn decoder_for(source: &Path) -> Box<dyn VideoDecoder> {
    let _platform = platform();
    let timeline = FrameTimeline::new(FPS, 1, FRAMES, ExactTime::ZERO).expect("a timeline");
    open_decoder(source, DecoderConfig::new(timeline))
        .expect("Media Foundation must decode the clip it just encoded")
}

/// The four quadrant greys a decoded frame actually carries, clockwise from the top left.
fn measured_quadrants(frame: &DecodedFrame) -> [i32; 4] {
    let (width, height) = (frame.width(), frame.height());
    let probes = [
        (width / 4, height / 4),
        (width * 3 / 4, height / 4),
        (width / 4, height * 3 / 4),
        (width * 3 / 4, height * 3 / 4),
    ];
    probes.map(|(x, y)| {
        let pixel = frame.pixel(x, y).expect("the probe is inside the frame");
        // Neutral by construction, so any one channel is the grey level.
        i32::from(pixel[0])
    })
}

fn assert_quadrants(frame: &DecodedFrame, expected: [u8; 4], what: &str) {
    let measured = measured_quadrants(frame);
    for (slot, want) in expected.iter().enumerate() {
        let difference = measured[slot] - i32::from(*want);
        assert!(
            difference.abs() <= GREY_TOLERANCE,
            "{what}: quadrant {slot} should be {want}, decoded {}",
            measured[slot]
        );
    }
}

// --- container surgery -------------------------------------------------------------------------

/// The offset of the first box named `want`, searching the containers that can hold one.
fn find_box(bytes: &[u8], start: usize, end: usize, want: &str) -> Option<usize> {
    let mut offset = start;
    while offset + 8 <= end {
        let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
        let name = String::from_utf8_lossy(&bytes[offset + 4..offset + 8]).to_string();
        if name == want {
            return Some(offset);
        }
        if size < 8 || offset + size > end {
            return None;
        }
        if matches!(name.as_str(), "moov" | "trak" | "mdia" | "minf" | "stbl")
            && let Some(found) = find_box(bytes, offset + 8, offset + size, want)
        {
            return Some(found);
        }
        offset += size;
    }
    None
}

/// Where the track header's 3x3 display matrix starts.
fn matrix_offset(bytes: &[u8]) -> usize {
    let tkhd = find_box(bytes, 0, bytes.len(), "tkhd").expect("every track has a header");
    let payload = tkhd + 8;
    // Version 1 widens the three time fields from 32 to 64 bits; everything after them is fixed.
    if bytes[payload] == 1 {
        payload + 52
    } else {
        payload + 40
    }
}

/// The clip with `matrix` written into its track header.
///
/// The nine 16.16 fixed-point terms of `ISO/IEC 14496-12`'s display matrix, in file order, which is
/// how every phone declares the turn its player has to apply.
fn with_display_matrix(bytes: &[u8], matrix: [u32; 9]) -> Vec<u8> {
    let mut patched = bytes.to_vec();
    let at = matrix_offset(bytes);
    for (index, term) in matrix.iter().enumerate() {
        patched[at + index * 4..at + index * 4 + 4].copy_from_slice(&term.to_be_bytes());
    }
    patched
}

/// The clip with a `pasp` box declaring non-square pixels.
///
/// The box is appended inside the visual sample entry and every ancestor's size grows by its
/// sixteen bytes. Safe to do in place here because this encoder writes `moov` after `mdat`, so
/// growing the header moves no sample the chunk offsets point at.
fn with_pixel_aspect(bytes: &[u8], horizontal: u32, vertical: u32) -> Vec<u8> {
    let stsd = find_box(bytes, 0, bytes.len(), "stsd").expect("a sample description");
    // Full box header, then the entry count, then the first sample entry.
    let entry = stsd + 8 + 8;
    let entry_size = u32::from_be_bytes(bytes[entry..entry + 4].try_into().expect("four bytes"));
    assert!(
        find_box(bytes, 0, bytes.len(), "mdat").expect("media data") < stsd,
        "the patch assumes the sample data precedes the header it grows"
    );

    let mut patched = bytes.to_vec();
    let mut pasp = Vec::with_capacity(16);
    pasp.extend_from_slice(&16_u32.to_be_bytes());
    pasp.extend_from_slice(b"pasp");
    pasp.extend_from_slice(&horizontal.to_be_bytes());
    pasp.extend_from_slice(&vertical.to_be_bytes());
    let insert_at = entry + entry_size as usize;
    patched.splice(insert_at..insert_at, pasp);

    for name in ["stsd", "stbl", "minf", "mdia", "trak", "moov"] {
        let offset =
            find_box(bytes, 0, bytes.len(), name).expect("an ancestor of the sample entry");
        grow(&mut patched, offset);
    }
    grow(&mut patched, entry);
    patched
}

/// Grows the box at `offset` by the sixteen bytes a `pasp` occupies.
fn grow(bytes: &mut [u8], offset: usize) {
    let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().expect("four bytes"));
    bytes[offset..offset + 4].copy_from_slice(&(size + 16).to_be_bytes());
}

/// The display matrix for a quarter turn clockwise, which is what a portrait phone clip carries.
fn quarter_turn_matrix(coded_height: u32) -> [u32; 9] {
    [
        0,
        0x0001_0000,
        0,
        0xFFFF_0000,
        0,
        0,
        coded_height << 16,
        0,
        0x4000_0000,
    ]
}

/// The display matrix for a half turn.
fn half_turn_matrix(coded_width: u32, coded_height: u32) -> [u32; 9] {
    [
        0xFFFF_0000,
        0,
        0,
        0,
        0xFFFF_0000,
        0,
        coded_width << 16,
        coded_height << 16,
        0x4000_0000,
    ]
}

/// The display matrix for a quarter turn anticlockwise.
fn three_quarter_turn_matrix(coded_width: u32) -> [u32; 9] {
    [
        0,
        0xFFFF_0000,
        0,
        0x0001_0000,
        0,
        0,
        0,
        coded_width << 16,
        0x4000_0000,
    ]
}

// --- the tests ---------------------------------------------------------------------------------

#[test]
fn a_plain_clip_reports_the_same_size_three_times() {
    // The regression guard. An ordinary file declares neither attribute, and nothing about reading
    // them is allowed to move it.
    let directory = TempDir::new().expect("a temporary directory");
    let bytes = encoded_clip(&directory, "plain.mp4", 320, 240);
    let clip = written(&directory, "plain-copy.mp4", &bytes);
    let mut decoder = decoder_for(&clip);
    let info = decoder.source();

    assert_eq!(info.coded_geometry().width(), 320);
    assert_eq!(info.coded_geometry().height(), 240);
    assert_eq!((info.decoded_width(), info.decoded_height()), (320, 240));
    assert_eq!((info.display_width(), info.display_height()), (320, 240));
    assert_eq!(info.rotation(), Rotation::None);
    assert_eq!(info.pixel_aspect(), PixelAspect::SQUARE);

    let frame = decoder.frame_for_output(0).expect("the first frame");
    assert_eq!((frame.width(), frame.height()), (320, 240));
    assert_quadrants(
        &frame,
        [TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT],
        "an unpatched clip",
    );
}

#[test]
fn an_anamorphic_clip_displays_wider_than_it_decodes() {
    // The measured divergence, at the size the review measured it: 720x480 stored, 854x480 shown.
    // The editor's `<video>` element reports the second pair, so anything sizing a composition from
    // the first pair composes a different frame from the one the user is looking at.
    let directory = TempDir::new().expect("a temporary directory");
    let bytes = encoded_clip(&directory, "coded.mp4", 720, 480);
    let clip = written(
        &directory,
        "anamorphic.mp4",
        // 720 * 427/360 is exactly 854: a whole number, so the test asserts the ratio and not a
        // rounding rule that happens to agree with it.
        &with_pixel_aspect(&bytes, 427, 360),
    );
    let mut decoder = decoder_for(&clip);
    let info = decoder.source();

    assert_eq!(
        info.pixel_aspect(),
        PixelAspect::new(427, 360).expect("a legal ratio"),
        "the platform did not surface the declared pixel aspect"
    );
    assert_eq!(
        (
            info.coded_geometry().width(),
            info.coded_geometry().height()
        ),
        (720, 480)
    );
    assert_eq!(
        (info.decoded_width(), info.decoded_height()),
        (720, 480),
        "a pixel aspect is a presentation fact, not a resample: the pixels stay coded"
    );
    assert_eq!(
        (info.display_width(), info.display_height()),
        (854, 480),
        "the display size is what a composition is derived from"
    );
    assert_ne!(
        info.display_width(),
        u32::try_from(info.decoded_width()).expect("a small width"),
        "the whole point of this clip is that the two sizes differ"
    );

    // The frame really is the coded one: same size, same quadrants, nothing stretched into it.
    let frame = decoder.frame_for_output(0).expect("the first frame");
    assert_eq!((frame.width(), frame.height()), (720, 480));
    assert_quadrants(
        &frame,
        [TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT],
        "an anamorphic clip",
    );
}

#[test]
fn a_rotated_clip_decodes_upright_rather_than_sideways() {
    // A phone clip is the most common video this application is given. It is stored landscape with
    // a display matrix, and a decoder that ignored the matrix would hand the compositor a frame
    // lying on its side — which is why this is asserted on where the quadrants land rather than on
    // what the file declares.
    let directory = TempDir::new().expect("a temporary directory");
    let bytes = encoded_clip(&directory, "landscape.mp4", 320, 240);

    let clip = written(
        &directory,
        "portrait.mp4",
        &with_display_matrix(&bytes, quarter_turn_matrix(240)),
    );
    let mut decoder = decoder_for(&clip);
    let info = decoder.source();

    assert_eq!(info.rotation(), Rotation::Quarter);
    assert_eq!(
        (
            info.coded_geometry().width(),
            info.coded_geometry().height()
        ),
        (320, 240),
        "the stored frame is still landscape"
    );
    assert_eq!(
        (info.decoded_width(), info.decoded_height()),
        (240, 320),
        "what comes out is portrait"
    );
    assert_eq!((info.display_width(), info.display_height()), (240, 320));

    let frame = decoder.frame_for_output(0).expect("the first frame");
    assert_eq!(
        (frame.width(), frame.height()),
        (240, 320),
        "the frame's own pixels are portrait, not just its metadata"
    );
    // A quarter turn clockwise carries the stored top-left quadrant to the top right.
    assert_quadrants(
        &frame,
        [BOTTOM_LEFT, TOP_LEFT, BOTTOM_RIGHT, TOP_RIGHT],
        "a quarter turn",
    );

    // And the comparison is not vacuous: the same bytes without the matrix decode the other way.
    let unpatched = written(&directory, "unpatched.mp4", &bytes);
    let mut plain = decoder_for(&unpatched);
    let plain_frame = plain.frame_for_output(0).expect("the first frame");
    assert_eq!((plain_frame.width(), plain_frame.height()), (320, 240));
    assert_quadrants(
        &plain_frame,
        [TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT],
        "the same clip without the matrix",
    );
}

#[test]
fn the_other_two_turns_are_applied_the_way_the_container_asks() {
    let directory = TempDir::new().expect("a temporary directory");
    let bytes = encoded_clip(&directory, "turns.mp4", 320, 240);

    for (name, matrix, rotation, size, quadrants) in [
        (
            "half.mp4",
            half_turn_matrix(320, 240),
            Rotation::Half,
            (320_usize, 240_usize),
            [BOTTOM_RIGHT, BOTTOM_LEFT, TOP_RIGHT, TOP_LEFT],
        ),
        (
            "anticlockwise.mp4",
            three_quarter_turn_matrix(320),
            Rotation::ThreeQuarter,
            (240, 320),
            [TOP_RIGHT, BOTTOM_RIGHT, TOP_LEFT, BOTTOM_LEFT],
        ),
    ] {
        let clip = written(&directory, name, &with_display_matrix(&bytes, matrix));
        let mut decoder = decoder_for(&clip);
        assert_eq!(decoder.source().rotation(), rotation, "{name}");
        let frame = decoder.frame_for_output(0).expect("the first frame");
        assert_eq!((frame.width(), frame.height()), size, "{name}");
        assert_quadrants(&frame, quadrants, name);
    }
}

#[test]
fn a_square_clip_that_declares_a_turn_is_still_turned() {
    // The decoder skips a turn it can see the platform has already applied, and the evidence for
    // that is a transposed buffer. A square frame is its own transpose, so this is the clip where
    // "the shape did not change" must be read as "nothing turned it" rather than "it is already
    // upright" — asserted on the quadrants, which move even though the dimensions do not.
    let directory = TempDir::new().expect("a temporary directory");
    let bytes = encoded_clip(&directory, "square-coded.mp4", 240, 240);
    let clip = written(
        &directory,
        "square-turned.mp4",
        &with_display_matrix(&bytes, quarter_turn_matrix(240)),
    );
    let mut decoder = decoder_for(&clip);

    assert_eq!(decoder.source().rotation(), Rotation::Quarter);
    let frame = decoder.frame_for_output(0).expect("the first frame");
    assert_eq!((frame.width(), frame.height()), (240, 240));
    assert_quadrants(
        &frame,
        [BOTTOM_LEFT, TOP_LEFT, BOTTOM_RIGHT, TOP_RIGHT],
        "a square clip with a quarter turn",
    );
}

#[test]
fn a_turn_and_a_pixel_aspect_compose_in_the_order_the_container_means() {
    // The pixel aspect belongs to the stored frame's own axes and the turn is applied after it, so
    // a portrait clip with wide pixels gets taller rather than wider.
    let directory = TempDir::new().expect("a temporary directory");
    let bytes = encoded_clip(&directory, "both-coded.mp4", 320, 240);
    let patched = with_pixel_aspect(&with_display_matrix(&bytes, quarter_turn_matrix(240)), 2, 1);
    let clip = written(&directory, "both.mp4", &patched);
    let info = decoder_for(&clip).source();

    assert_eq!(info.rotation(), Rotation::Quarter);
    assert_eq!(
        info.pixel_aspect(),
        PixelAspect::new(2, 1).expect("a legal ratio")
    );
    assert_eq!((info.decoded_width(), info.decoded_height()), (240, 320));
    assert_eq!((info.display_width(), info.display_height()), (240, 640));
}
