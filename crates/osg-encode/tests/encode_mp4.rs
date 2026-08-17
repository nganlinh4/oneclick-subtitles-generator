//! End-to-end encodes against the real platform encoder.
//!
//! These tests deliberately do **not** skip when Media Foundation is unavailable. A silent skip
//! would leave a green suite that has never encoded anything, which is precisely the state this
//! crate exists to make impossible: every `expect` below turns a missing or refusing platform
//! encoder into a failed test.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};

use osg_encode::{
    AudioBlock, AudioConfig, EncodeError, EncoderConfig, FrameBuffer, PixelLayout, VideoConfig,
    open_encoder,
};
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

/// A deterministic RGBA8 frame: a horizontal gradient with a bar that moves with the frame index.
///
/// No RNG and no clock, matching the determinism rule the rest of the pipeline is held to.
fn synthetic_frame(index: u32) -> Vec<u8> {
    let capacity = usize::try_from(WIDTH * HEIGHT * 4).expect("the frame fits in memory");
    let mut pixels = Vec::with_capacity(capacity);
    let bar = (index * 8) % WIDTH;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let on_bar = x.abs_diff(bar) < 6;
            let red = if on_bar {
                255
            } else {
                u8::try_from(x * 255 / WIDTH).expect("the ratio is a byte")
            };
            let green = u8::try_from(y * 255 / HEIGHT).expect("the ratio is a byte");
            let blue = if on_bar { 255 } else { 0 };
            pixels.extend_from_slice(&[red, green, blue, 255]);
        }
    }
    pixels
}

fn video_config() -> VideoConfig {
    VideoConfig::new(WIDTH, HEIGHT, FPS, 1, FRAMES)
        .expect("a supported configuration")
        .with_bitrate_kbps(4_000)
        .expect("4 Mbit/s is in range")
        .with_keyframe_interval(15)
        .expect("15 frames is in range")
}

fn output_in(directory: &TempDir, name: &str) -> PathBuf {
    directory.path().join(name)
}

/// The first box of an MP4 file is `ftyp`, at offset 4, behind a big-endian box length.
fn assert_looks_like_mp4(path: &Path) {
    let bytes = fs::read(path).expect("the finished file can be read");
    assert!(
        bytes.len() > 4_096,
        "an encoded clip should not be trivially small, got {} bytes",
        bytes.len()
    );
    assert_eq!(
        &bytes[4..8],
        b"ftyp",
        "the file does not start with an MP4 file-type box"
    );
    let box_length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    assert!(
        box_length >= 8 && usize::try_from(box_length).expect("a small box") <= bytes.len(),
        "the leading box length {box_length} is not plausible"
    );
    // A finalized MP4 carries its index. Without `Finalize` there is no `moov` box at all.
    assert!(
        bytes.windows(4).any(|window| window == b"moov"),
        "the file has no moov box, so it was never finalized"
    );
}

#[test]
fn a_synthetic_clip_encodes_to_a_playable_mp4() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "video-only.mp4");

    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("Media Foundation must provide an H.264 encoder for this test to mean anything");

    // A `{:?}` of a live encoder must not leak the path it is writing to.
    let debugged = format!("{encoder:?}");
    assert!(
        !debugged.contains("video-only"),
        "the debug view leaked the file name"
    );
    assert!(
        !debugged.contains('\\'),
        "the debug view leaked a path: {debugged}"
    );
    assert!(
        debugged.contains("frames_written"),
        "the debug view says nothing useful"
    );

    for index in 0..FRAMES {
        let pixels = synthetic_frame(index);
        let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }

    let outcome = encoder.finalize().expect("the container is closed");
    assert_eq!(outcome.frames_written(), FRAMES);
    assert_eq!(outcome.audio_samples_written(), 0);
    // 30 frames at 30fps is exactly one second.
    assert_eq!(outcome.duration_100ns(), 10_000_000);
    assert!(outcome.file_bytes() > 4_096);

    assert!(output.is_file(), "the encoder produced no file");
    assert_looks_like_mp4(&output);
    assert_eq!(
        outcome.file_bytes(),
        fs::metadata(&output)
            .expect("the file can be measured")
            .len()
    );
}

#[test]
fn a_synthetic_clip_with_aac_audio_encodes_to_a_playable_mp4() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "with-audio.mp4");

    let audio = AudioConfig::from_parts(48_000, 2, 128).expect("a supported configuration");
    let config = EncoderConfig::video_only(video_config()).with_audio(audio);
    let mut encoder = open_encoder(&output, config)
        .expect("Media Foundation must provide H.264 and AAC encoders for this test");

    // One block of audio per video frame, interleaved, so the writer sees a rising timeline.
    let samples_per_frame = 48_000_u64 / u64::from(FPS);
    let block_samples = usize::try_from(samples_per_frame * 2).expect("a small block");
    let mut next_sample = 0_u64;

    for index in 0..FRAMES {
        let pixels = synthetic_frame(index);
        let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");

        // A quiet, deterministic tone: a triangle derived from the sample index alone.
        let mut samples = Vec::with_capacity(block_samples);
        for offset in 0..samples_per_frame {
            let phase = (next_sample + offset) % 480;
            let value =
                (f64::from(u32::try_from(phase).expect("a small phase")) / 480.0 - 0.5) * 0.2;
            #[expect(
                clippy::cast_possible_truncation,
                reason = "a bounded fraction of one, written as the f32 PCM the platform takes"
            )]
            let sample = value as f32;
            samples.push(sample);
            samples.push(sample);
        }
        let block = AudioBlock::new(&samples, audio).expect("whole stereo frames");
        encoder
            .write_audio(next_sample, &block)
            .expect("the platform accepts a well-formed audio block");
        next_sample += samples_per_frame;
    }

    let outcome = encoder.finalize().expect("the container is closed");
    assert_eq!(outcome.frames_written(), FRAMES);
    assert_eq!(outcome.audio_samples_written(), 48_000);
    assert_looks_like_mp4(&output);
}

#[test]
fn frames_out_of_order_are_refused_without_writing_them() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "out-of-order.mp4");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("the platform provides an encoder");

    let pixels = synthetic_frame(0);
    let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8).expect("a frame");
    assert_eq!(
        encoder.write_frame(1, &frame),
        Err(EncodeError::FrameOutOfOrder {
            expected: 0,
            actual: 1,
        })
    );
    encoder.write_frame(0, &frame).expect("frame zero is next");
    assert_eq!(
        encoder.write_frame(0, &frame),
        Err(EncodeError::FrameOutOfOrder {
            expected: 1,
            actual: 0,
        })
    );
}

#[test]
fn a_frame_of_the_wrong_size_is_refused() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "wrong-size.mp4");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("the platform provides an encoder");

    let pixels = vec![0_u8; 64 * 64 * 4];
    let frame = FrameBuffer::new(&pixels, 64, 64, PixelLayout::Rgba8).expect("a valid frame");
    assert_eq!(
        encoder.write_frame(0, &frame),
        Err(EncodeError::FrameSizeUnexpected {
            expected_width: WIDTH,
            expected_height: HEIGHT,
            width: 64,
            height: 64,
        })
    );
}

#[test]
fn audio_offered_to_a_silent_encode_is_refused() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "silent.mp4");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("the platform provides an encoder");

    let audio = AudioConfig::from_parts(48_000, 2, 128).expect("a supported configuration");
    let samples = [0.0_f32; 4];
    let block = AudioBlock::new(&samples, audio).expect("whole stereo frames");
    assert_eq!(
        encoder.write_audio(0, &block),
        Err(EncodeError::NoAudioStream)
    );
}

#[test]
fn writing_after_finalize_is_refused() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "after-finalize.mp4");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("the platform provides an encoder");

    let pixels = synthetic_frame(0);
    let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8).expect("a frame");
    encoder.write_frame(0, &frame).expect("the first frame");
    encoder.finalize().expect("the container is closed");

    assert_eq!(
        encoder.write_frame(1, &frame),
        Err(EncodeError::AlreadyFinished)
    );
    assert!(matches!(
        encoder.finalize(),
        Err(EncodeError::AlreadyFinished)
    ));
    assert!(
        output.is_file(),
        "finalizing twice must not remove the file"
    );
}

#[test]
fn cancelling_mid_encode_removes_the_partial_file() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "cancelled.mp4");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("the platform provides an encoder");

    let pixels = synthetic_frame(0);
    let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8).expect("a frame");
    for index in 0..5 {
        encoder.write_frame(index, &frame).expect("a frame");
    }
    encoder.cancel().expect("cancellation releases the output");

    assert!(!output.exists(), "a cancelled encode left its partial file");
    assert_eq!(encoder.write_frame(5, &frame), Err(EncodeError::Cancelled));
    assert!(matches!(encoder.finalize(), Err(EncodeError::Cancelled)));
    // Idempotent: a cancellation racing a natural end is not itself an error.
    assert_eq!(encoder.cancel(), Ok(()));
}

#[test]
fn a_token_signalled_from_elsewhere_stops_the_encode() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "token-cancelled.mp4");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect("the platform provides an encoder");

    let token = encoder.cancel_token();
    let pixels = synthetic_frame(0);
    let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8).expect("a frame");
    encoder.write_frame(0, &frame).expect("the first frame");

    // Signalled the way an export would be abandoned from the UI thread.
    let remote = token.clone();
    std::thread::spawn(move || remote.cancel())
        .join()
        .expect("the signalling thread finishes");

    assert!(token.is_cancelled());
    assert_eq!(encoder.write_frame(1, &frame), Err(EncodeError::Cancelled));
    assert!(!output.exists(), "a cancelled encode left its partial file");
}

#[test]
fn dropping_without_finalize_removes_the_half_written_file() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "dropped.mp4");
    {
        let mut encoder = open_encoder(&output, EncoderConfig::video_only(video_config()))
            .expect("the platform provides an encoder");
        let pixels = synthetic_frame(0);
        let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8).expect("a frame");
        for index in 0..5 {
            encoder.write_frame(index, &frame).expect("a frame");
        }
        assert!(output.exists(), "the sink writer opened the file");
    }
    // Without `Finalize` the container has no index, so what is on disk is not an export. Leaving
    // it would put something that looks finished where a finished export belongs.
    assert!(!output.exists(), "a dropped encode left its partial file");
}

#[test]
fn an_existing_file_is_never_clobbered() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let output = output_in(&directory, "existing.mp4");
    fs::write(&output, b"a previous export").expect("the fixture file is written");

    let error = open_encoder(&output, EncoderConfig::video_only(video_config()))
        .expect_err("an occupied location is refused");
    assert_eq!(
        error,
        EncodeError::OutputUnusable {
            reason: osg_encode::OutputRejection::AlreadyExists,
        }
    );
    assert_eq!(
        fs::read(&output).expect("the previous file is intact"),
        b"a previous export"
    );
}
