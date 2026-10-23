//! End-to-end decodes against the real platform codecs.
//!
//! The clip is not a committed fixture. It is encoded here by `osg-encode`, through Media
//! Foundation, and then decoded back through Media Foundation, so the two halves of the pipeline are
//! proven against each other rather than against a file somebody generated once and checked in. That
//! also makes the colour round trip meaningful: `osg-encode` writes full-range Rec.709 deliberately,
//! and if the decoder failed to notice, the grey levels below would come back visibly shifted.
//!
//! These tests deliberately do **not** skip when Media Foundation is unavailable. A silent skip
//! would leave a green suite that has never decoded anything, which is precisely the state this
//! crate exists to make impossible: every `expect` below turns a missing or refusing platform codec
//! into a failed test.

#![cfg(windows)]

#[path = "decode_mp4/colour_range.rs"]
mod colour_range;
#[path = "decode_mp4/frame_selection.rs"]
mod frame_selection;
#[path = "decode_mp4/lifecycle_and_refusals.rs"]
mod lifecycle_and_refusals;

use std::path::{Path, PathBuf};

use osg_decode::{DecodedFrame, DecoderConfig, VideoDecoder, open_decoder};
use osg_encode::{
    AudioBlock, AudioConfig, EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder,
};
use osg_scene::{ExactTime, FrameTimeline};
use tempfile::TempDir;

/// Serialises Media Foundation across this binary's test threads.
///
/// Opening several source readers or sink writers at the same moment from one process has faulted
/// inside the platform layers here. The guard is held only while the platform object is being
/// opened, not across the decode, so the suite stays parallel where parallelism is safe.
///
/// WHAT THIS DOES NOT CLAIM. It used to say the product opens one at a time on one thread, so this
/// was a shape only the harness created. That was wrong, and it is worth recording rather than
/// quietly deleting, because it is the kind of comfortable sentence that stops anyone looking:
/// `osg_export::run_export` holds a source reader AND a sink writer live across its whole frame
/// loop, and `apps/desktop/src-tauri/src/preview/source.rs` runs a third source reader on its own
/// thread with nothing serialising it against an export. Scrubbing the preview while a video
/// exports really does open several at once. Whether that faults is unmeasured — the export suite
/// exercises a reader and a writer together in every test and has never flaked — so this guard is
/// justified by the contention it was observed to fix, not by a claim about what the product
/// cannot do.
static PLATFORM: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn platform() -> std::sync::MutexGuard<'static, ()> {
    // A poisoned lock means another test panicked while holding it; whatever it was opening is gone
    // either way, so recovering is correct.
    PLATFORM
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

const WIDTH: u32 = 320;
const HEIGHT: u32 = 240;
const FPS: u32 = 30;
const FRAMES: u32 = 30;
const AUDIO_TAIL_FRAMES: usize = 52_800;

/// How far a decoded grey may sit from the grey that was encoded.
///
/// Wide enough for H.264 quantisation on a flat block, and far narrower than the ~13 level shift a
/// mistaken nominal range produces, so a colour-range regression fails these tests rather than
/// hiding inside the tolerance.
const GREY_TOLERANCE: i32 = 6;

/// The top-left quadrant's grey for frame `index`, which is what identifies the frame.
///
/// A ramp rather than a moving edge: a flat block survives compression well enough to be read back
/// as a number, so "is this the frame I asked for" is answerable without comparing whole images.
fn ramp_level(index: u32) -> u8 {
    u8::try_from(16 + index * 8).expect("thirty steps of eight stay inside a byte")
}

/// The three fixed quadrants: a dark grey, a mid grey and a bright grey.
///
/// All neutral on purpose. Chroma subsampling makes a saturated block a poor witness, while a grey
/// isolates exactly the thing that has to survive — the luma range.
const FIXED_LEVELS: [u8; 3] = [32, 128, 224];

/// A deterministic RGBA8 frame of four flat grey quadrants. No RNG and no clock.
fn synthetic_frame(index: u32) -> Vec<u8> {
    let capacity = usize::try_from(WIDTH * HEIGHT * 4).expect("the frame fits in memory");
    let mut pixels = Vec::with_capacity(capacity);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let level = match (x < WIDTH / 2, y < HEIGHT / 2) {
                (true, true) => ramp_level(index),
                (false, true) => FIXED_LEVELS[0],
                (true, false) => FIXED_LEVELS[1],
                (false, false) => FIXED_LEVELS[2],
            };
            pixels.extend_from_slice(&[level, level, level, 255]);
        }
    }
    pixels
}

/// The centre of each quadrant, well away from the block edges compression blurs.
const PROBES: [(usize, usize); 4] = [(80, 60), (240, 60), (80, 180), (240, 180)];

fn expected_levels(index: u32) -> [u8; 4] {
    [
        ramp_level(index),
        FIXED_LEVELS[0],
        FIXED_LEVELS[1],
        FIXED_LEVELS[2],
    ]
}

/// The four quadrant greys a decoded frame actually carries.
fn measured_levels(frame: &DecodedFrame) -> [i32; 4] {
    let mut levels = [0_i32; 4];
    for (slot, (x, y)) in PROBES.iter().enumerate() {
        let pixel = frame.pixel(*x, *y).expect("the probe is inside the frame");
        // Neutral by construction, so any one channel is the grey level.
        levels[slot] = i32::from(pixel[0]);
    }
    levels
}

fn assert_frame_is(frame: &DecodedFrame, index: u32) {
    let measured = measured_levels(frame);
    let expected = expected_levels(index);
    for (slot, want) in expected.iter().enumerate() {
        let difference = measured[slot] - i32::from(*want);
        assert!(
            difference.abs() <= GREY_TOLERANCE,
            "frame {index} quadrant {slot}: encoded {want}, decoded {}, difference {difference}",
            measured[slot]
        );
    }
}

/// Encodes the synthetic clip at the requested rate and returns where it landed.
fn encoded_clip_at_rate(directory: &TempDir, name: &str, fps: u32, frame_count: u32) -> PathBuf {
    let _platform = platform();
    let output = directory.path().join(name);
    let video = VideoConfig::new(WIDTH, HEIGHT, fps, 1, frame_count)
        .expect("a supported configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(10)
        .expect("10 frames is in range");

    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder for these tests to mean anything");
    for index in 0..frame_count {
        let pixels = synthetic_frame(index);
        let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the container is closed");
    assert!(output.is_file(), "the encoder produced no file");
    // Keep only synthetic fixtures on isolated CI so an independent decoder can distinguish
    // encoder timestamp offsets from source-reader selection defects. Never copy user media.
    if std::env::var_os("GITHUB_ACTIONS").is_some()
        && let Some(root) = std::env::var_os("RUNNER_TEMP")
    {
        let evidence = PathBuf::from(root).join("osg-decode-evidence");
        std::fs::create_dir_all(&evidence).expect("create synthetic decode evidence");
        std::fs::copy(&output, evidence.join(name)).expect("retain synthetic decode evidence");
    }
    output
}

/// Encodes the standard one-second, 30fps synthetic clip.
fn encoded_clip(directory: &TempDir, name: &str) -> PathBuf {
    encoded_clip_at_rate(directory, name, FPS, FRAMES)
}

/// Encodes one second of video inside a 1.1-second presentation whose audio has a short tail.
fn encoded_clip_with_audio_tail(directory: &TempDir, name: &str) -> PathBuf {
    let _platform = platform();
    let output = directory.path().join(name);
    let video = VideoConfig::new(WIDTH, HEIGHT, FPS, 1, FRAMES)
        .expect("a supported configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range");
    let audio = AudioConfig::from_parts(48_000, 2, 128).expect("a supported audio configuration");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video).with_audio(audio))
        .expect("Media Foundation must provide H.264 and AAC encoders for these tests");

    for index in 0..FRAMES {
        let pixels = synthetic_frame(index);
        let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }

    let samples = vec![0.0_f32; AUDIO_TAIL_FRAMES * 2];
    let block = AudioBlock::new(&samples, audio).expect("the stereo block is aligned");
    encoder
        .write_audio(0, &block)
        .expect("the platform accepts the audio tail");
    encoder.finalize().expect("the container is closed");
    assert!(output.is_file(), "the encoder produced no file");
    output
}

fn output_timeline() -> FrameTimeline {
    FrameTimeline::new(FPS, 1, FRAMES, ExactTime::ZERO).expect("a supported timeline")
}

fn decoder_for(source: &Path) -> Box<dyn VideoDecoder> {
    let _platform = platform();
    open_decoder(source, DecoderConfig::new(output_timeline()))
        .expect("Media Foundation must decode the clip it just encoded")
}
