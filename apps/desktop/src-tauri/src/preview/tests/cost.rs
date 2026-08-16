//! What one composited preview frame costs at 1080p, measured rather than estimated.
//!
//! **This is a measurement harness, not a gate.** It is `#[ignore]`d, so no verification run
//! executes it and nothing in the shipped renderer reads a clock; it exists so the numbers quoted
//! for the decode path can be reproduced instead of believed. Run it with:
//!
//! ```text
//! cargo test -p osg-desktop --lib preview::tests::cost -- --ignored --nocapture
//! ```
//!
//! Three costs matter and they are very different, which is the whole reason the decoder is kept
//! rather than opened per request:
//!
//! * opening the source and decoding the first frame — paid once per media,
//! * the next frame forward — what a scrub actually pays, and
//! * a jump backwards — what clicking elsewhere on the timeline pays, since a backward seek is the
//!   one case `osg-decode` cannot answer by walking.
//!
//! # What it measured
//!
//! On the development machine, 1920x1088 `H.264`, ten-frame keyframe interval, **with the shipped
//! release profile** (`opt-level = "z"`, fat LTO): open 41.6ms, first frame 32.9ms, forward scrub
//! **5.4ms a frame** over thirty consecutive frames, backward jump 21.0ms — one seek and
//! thirty-five samples decoded for thirty-two requested frames. A forward scrub is therefore about
//! five milliseconds of decode per preview frame at 1080p, which is well inside usable, and the
//! sample count is what proves it: the walk really is linear rather than re-seeking.
//!
//! Run under `cargo test`'s own profile — which is a debug build — the same measurement reports
//! 73.7ms a frame, because the `NV12` to RGBA8 conversion is a two-megapixel scalar loop and
//! nothing is optimised. That number is an artefact of the test profile, not of the pipeline; add
//! `--release` to the command above to reproduce the shipped one.

use std::path::PathBuf;
use std::time::Instant;

use osg_decode::{DecoderConfig, open_decoder};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
use osg_scene::{ExactTime, FrameTimeline};
use tempfile::TempDir;

/// The measured source: 1080p, three seconds, a ten-frame keyframe interval.
///
/// The height is 1088 rather than 1080 because that is what H.264 codes 1080p as — the macroblock
/// grid is sixteen pixels — and `osg-decode` refuses a file whose coded size the platform decoder
/// pads, reporting `SourceGeometryChanged`. So this frame is 0.7% larger than a 1080p one, which is
/// the direction that cannot flatter the measurement.
const HD_WIDTH: u32 = 1_920;
const HD_HEIGHT: u32 = 1_088;
const HD_FPS: u32 = 30;
const HD_FRAMES: u32 = 90;

/// How many consecutive frames the forward scrub walks.
const SCRUB_FRAMES: u32 = 30;

/// Encodes a 1080p clip whose frames differ, so nothing can be shortcut by identical samples.
fn hd_clip(directory: &TempDir) -> PathBuf {
    let output = directory.path().join("preview-cost-1080p.mp4");
    let video = VideoConfig::new(HD_WIDTH, HD_HEIGHT, HD_FPS, 1, HD_FRAMES)
        .expect("a supported source configuration")
        .with_bitrate_kbps(12_000)
        .expect("12 Mbit/s is in range")
        .with_keyframe_interval(10)
        .expect("10 frames is in range");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder");
    for index in 0..HD_FRAMES {
        let level = u8::try_from(16 + index * 2).expect("ninety steps of two stay inside a byte");
        let pixels = vec![level; (HD_WIDTH * HD_HEIGHT * 4) as usize];
        let frame = FrameBuffer::new(&pixels, HD_WIDTH, HD_HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the source container is closed");
    output
}

#[test]
#[ignore = "a measurement harness: it reports numbers rather than asserting a threshold"]
fn what_one_1080p_source_frame_costs_to_decode() {
    let directory = TempDir::new().expect("a temporary directory");
    let source = hd_clip(&directory);
    let timeline = FrameTimeline::new(HD_FPS, 1, HD_FRAMES, ExactTime::ZERO).expect("a timeline");

    let opening = Instant::now();
    let mut decoder =
        open_decoder(&source, DecoderConfig::new(timeline)).expect("the clip is decodable");
    let opened = opening.elapsed();

    let cold = Instant::now();
    decoder.frame_for_output(0).expect("the first frame");
    let first = cold.elapsed();

    let walking = Instant::now();
    for index in 1..=SCRUB_FRAMES {
        decoder.frame_for_output(index).expect("a scrubbed frame");
    }
    let forward = walking.elapsed() / SCRUB_FRAMES;

    let jumping = Instant::now();
    decoder.frame_for_output(1).expect("a backward jump");
    let backward = jumping.elapsed();
    let stats = decoder.stats();
    decoder.close();

    println!("open {opened:?}, first frame {first:?}");
    println!("forward scrub {forward:?} a frame over {SCRUB_FRAMES} frames");
    println!("backward jump {backward:?}");
    println!(
        "{} seeks, {} samples decoded",
        stats.seeks(),
        stats.samples_decoded()
    );
}
