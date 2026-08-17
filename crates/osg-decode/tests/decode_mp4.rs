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

use std::fs;
use std::path::{Path, PathBuf};

use osg_decode::{
    DecodeError, DecodeLimits, DecodedFrame, DecoderConfig, SourceRejection, VideoDecoder,
    open_decoder,
};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
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

/// Encodes the synthetic clip and returns where it landed.
fn encoded_clip(directory: &TempDir, name: &str) -> PathBuf {
    let _platform = platform();
    let output = directory.path().join(name);
    let video = VideoConfig::new(WIDTH, HEIGHT, FPS, 1, FRAMES)
        .expect("a supported configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(10)
        .expect("10 frames is in range");

    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder for these tests to mean anything");
    for index in 0..FRAMES {
        let pixels = synthetic_frame(index);
        let frame = FrameBuffer::new(&pixels, WIDTH, HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
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

#[test]
fn the_source_reports_its_real_dimensions_frame_rate_and_duration() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "probe.mp4");
    let decoder = decoder_for(&clip);
    let source = decoder.source();

    // The regression guard for the three sizes: a plain camera-shaped clip declares no pixel
    // aspect and no rotation, so all three of them are the one number the file was encoded at.
    assert_eq!(source.coded_geometry().width(), WIDTH as usize);
    assert_eq!(source.coded_geometry().height(), HEIGHT as usize);
    assert_eq!(source.decoded_width(), WIDTH as usize);
    assert_eq!(source.decoded_height(), HEIGHT as usize);
    assert_eq!(source.display_width(), WIDTH);
    assert_eq!(source.display_height(), HEIGHT);
    assert_eq!(source.rotation(), osg_decode::Rotation::None);
    assert!(
        source.pixel_aspect().is_square(),
        "an ordinary clip must not acquire a pixel aspect: {:?}",
        source.pixel_aspect()
    );
    assert_eq!(source.fps_numerator(), FPS);
    assert_eq!(source.fps_denominator(), 1);

    // Thirty frames at thirty a second is one second. The container's own rounding is allowed to
    // move it by less than a frame and no more.
    let one_frame = 10_000_000 / i64::from(FPS);
    let difference = source.duration_100ns() - 10_000_000;
    assert!(
        difference.abs() < one_frame,
        "the source declares {} units, one second is 10_000_000",
        source.duration_100ns()
    );
    assert_eq!(source.nominal_frame_count(), u64::from(FRAMES));

    println!(
        "source: {}x{} @ {}/{}, {} units, {:?}",
        source.display_width(),
        source.display_height(),
        source.fps_numerator(),
        source.fps_denominator(),
        source.duration_100ns(),
        source.colorimetry(),
    );
}

#[test]
fn walking_the_clip_yields_every_frame_in_order_and_stops_at_the_end() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "walk.mp4");
    let mut decoder = decoder_for(&clip);

    let mut walked = 0_u32;
    while let Some(frame) = decoder.next_frame().expect("the platform decodes the clip") {
        assert_eq!(frame.width(), WIDTH as usize);
        assert_eq!(frame.height(), HEIGHT as usize);
        assert_eq!(frame.pixels().len(), frame.width() * frame.height() * 4);
        assert_eq!(
            frame.source_index(),
            u64::from(walked),
            "frame {walked} reports itself as source frame {}",
            frame.source_index()
        );
        assert_frame_is(&frame, walked);
        walked += 1;
        assert!(walked <= FRAMES + 1, "the walk did not terminate");
    }
    assert_eq!(walked, FRAMES, "the clip should carry {FRAMES} frames");
    // The end is the end: asking again does not restart the file.
    assert!(decoder.next_frame().expect("end of stream").is_none());
}

#[test]
fn seeking_to_a_frame_produces_the_frame_walking_reaches() {
    // The defect this whole crate exists to prevent. `IMFSourceReader` seeks to a keyframe, so a
    // decoder that trusted its seek would return a different frame here — and would do it silently,
    // because the frame it returns is a perfectly good frame of the same video.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "seek.mp4");
    let mut decoder = decoder_for(&clip);

    let mut walked: Vec<Vec<u8>> = Vec::with_capacity(FRAMES as usize);
    while let Some(frame) = decoder.next_frame().expect("the platform decodes the clip") {
        walked.push(frame.into_pixels());
    }
    assert_eq!(walked.len(), FRAMES as usize);

    let after_walk = decoder.stats().seeks();
    // Backwards on purpose, and across the keyframe boundaries the encode was given, so every
    // request has to reposition and then decode forward to the right frame.
    for index in [29_u64, 17, 11, 9, 4, 0, 23] {
        let frame = decoder
            .source_frame(index)
            .expect("the platform decodes a sought frame");
        assert_eq!(
            frame.source_index(),
            index,
            "source_frame({index}) returned source frame {}",
            frame.source_index()
        );
        assert_eq!(
            frame.pixels(),
            &walked[usize::try_from(index).expect("a small index")][..],
            "source_frame({index}) is not the frame walking reached"
        );
    }
    assert!(
        decoder.stats().seeks() > after_walk,
        "the comparison is vacuous unless the sought frames really seeked"
    );
}

#[test]
fn output_frames_land_on_the_source_frames_they_show() {
    // The output timeline here is the source's own, so output frame N must be source frame N. When
    // they differ — a trim, or a frame-rate conversion — the same arithmetic still applies, which is
    // why it lives in `osg-scene` and not here.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "output.mp4");
    let mut decoder = decoder_for(&clip);

    for index in 0..FRAMES {
        let frame = decoder
            .frame_for_output(index)
            .expect("the platform decodes the frame the timeline names");
        assert_eq!(
            frame.source_index(),
            u64::from(index),
            "output frame {index} showed source frame {}",
            frame.source_index()
        );
        assert_frame_is(&frame, index);
    }
    assert_eq!(
        decoder.frame_for_output(FRAMES),
        Err(DecodeError::FrameOutOfRange {
            index: FRAMES,
            frame_count: FRAMES,
        })
    );
}

#[test]
fn an_output_rate_below_the_source_rate_still_lands_on_whole_source_frames() {
    // The case a decoder that trusted its seek gets wrong most visibly. At half the source rate,
    // every output frame falls on a different source frame, and none of them is a keyframe boundary.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "half-rate.mp4");
    let halved =
        FrameTimeline::new(FPS / 2, 1, FRAMES / 2, ExactTime::ZERO).expect("a supported timeline");
    let mut decoder = open_decoder(&clip, DecoderConfig::new(halved))
        .expect("the clip opens against a slower timeline");

    for index in 0..FRAMES / 2 {
        let frame = decoder
            .frame_for_output(index)
            .expect("the platform decodes the frame the timeline names");
        let expected = u64::from(index) * 2;
        assert_eq!(
            frame.source_index(),
            expected,
            "output frame {index} at half rate showed source frame {}",
            frame.source_index()
        );
        assert_frame_is(&frame, index * 2);
    }
}

#[test]
fn a_trimmed_timeline_samples_from_where_the_trim_starts() {
    // The trim lives in the timeline's start offset, so the decoder applies it without arithmetic
    // of its own. Ten frames in at 30fps is exactly a third of a second, which is also the instant a
    // float would already have got wrong.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "trimmed.mp4");
    let trim = ExactTime::new(1, 3).expect("a third of a second");
    let trimmed = FrameTimeline::new(FPS, 1, 20, trim).expect("a supported timeline");
    let mut decoder = open_decoder(&clip, DecoderConfig::new(trimmed))
        .expect("the clip opens against a trimmed timeline");

    for index in 0..20 {
        let frame = decoder
            .frame_for_output(index)
            .expect("the platform decodes the frame the timeline names");
        let expected = u64::from(index) + 10;
        assert_eq!(
            frame.source_index(),
            expected,
            "trimmed output frame {index} showed source frame {}",
            frame.source_index()
        );
        assert_frame_is(&frame, index + 10);
    }
}

#[test]
fn the_full_range_the_encoder_declared_survives_the_round_trip() {
    // `osg-encode` writes `MFNominalRange_0_255` on purpose, and this is the assertion that the
    // decoder reads it back rather than assuming the studio range that compressed video usually
    // carries. If this ever regresses, every re-imported export comes back with crushed blacks.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "range.mp4");
    let decoder = decoder_for(&clip);
    assert_eq!(
        decoder.source().colorimetry().range,
        osg_decode::NominalRange::Full,
        "the decoder did not read back the range the encoder declared"
    );
}

#[test]
fn decoding_the_same_clip_at_the_wrong_range_is_visibly_different() {
    // The proof that the range is applied and not decorative. The same bytes, decoded once as the
    // file declares itself and once as studio range, must disagree by far more than compression
    // noise — that disagreement is exactly the washed-out export the migration is guarding against.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "wrong-range.mp4");

    let mut honest = decoder_for(&clip);
    let honest_levels = measured_levels(&honest.frame_for_output(0).expect("a frame"));

    let mistaken_config = DecoderConfig::new(output_timeline())
        .with_colorimetry(osg_decode::SourceColorimetry::STUDIO_BT709);
    let mut mistaken = open_decoder(&clip, mistaken_config)
        .expect("the clip opens with an overridden description");
    let mistaken_levels = measured_levels(&mistaken.frame_for_output(0).expect("a frame"));

    // The dark quadrant was encoded at 32. Read as studio range it lands near 19.
    assert!(
        (honest_levels[1] - 32).abs() <= GREY_TOLERANCE,
        "the honest decode put the dark quadrant at {}",
        honest_levels[1]
    );
    assert!(
        honest_levels[1] - mistaken_levels[1] >= 8,
        "reading the dark quadrant as studio range changed it from {} to {}, which is not enough \
         to say the range is being applied at all",
        honest_levels[1],
        mistaken_levels[1]
    );
    // The bright quadrant was encoded at 224 and moves the other way.
    assert!(
        mistaken_levels[3] - honest_levels[3] >= 8,
        "the bright quadrant moved from {} to {}",
        honest_levels[3],
        mistaken_levels[3]
    );
}

#[test]
fn scrubbing_by_instant_agrees_with_scrubbing_by_index() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "scrub.mp4");
    let mut decoder = decoder_for(&clip);

    for index in [0_u32, 5, 21, 29] {
        let by_time = decoder
            .frame_at_time(
                ExactTime::new(i64::from(index) * 2 + 1, i64::from(FPS) * 2).expect("an instant"),
            )
            .expect("the platform decodes a scrubbed frame")
            .into_pixels();
        let by_index = decoder
            .source_frame(u64::from(index))
            .expect("the platform decodes a sought frame")
            .into_pixels();
        assert_eq!(
            by_time, by_index,
            "the two routes to frame {index} disagree"
        );
    }
}

#[test]
fn a_frame_past_the_end_of_the_source_is_reported_as_truncation() {
    // A source shorter than the timeline is not an export that quietly stops early. The decoder
    // says the stream ended, and how far it got.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "short.mp4");
    let long_timeline =
        FrameTimeline::new(FPS, 1, FRAMES * 3, ExactTime::ZERO).expect("a supported timeline");
    let mut decoder = open_decoder(&clip, DecoderConfig::new(long_timeline))
        .expect("the clip opens against a longer timeline");

    let error = decoder
        .frame_for_output(FRAMES * 2)
        .expect_err("the source has no such frame");
    assert!(
        matches!(error, DecodeError::TruncatedStream { .. }),
        "expected a truncation, got {error:?}"
    );
    assert!(!error.to_string().contains("C:"));
}

#[test]
fn a_cancelled_decode_stops_rather_than_finishing() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "cancel.mp4");
    let mut decoder = decoder_for(&clip);

    let token = decoder.cancel_token();
    decoder.frame_for_output(0).expect("the first frame");

    // Signalled the way a long export would be abandoned from the UI thread.
    let remote = token.clone();
    std::thread::spawn(move || remote.cancel())
        .join()
        .expect("the signalling thread finishes");

    assert!(token.is_cancelled());
    assert_eq!(decoder.frame_for_output(1), Err(DecodeError::Cancelled));
    assert!(matches!(decoder.next_frame(), Err(DecodeError::Cancelled)));
}

#[test]
fn a_source_beyond_the_configured_bounds_is_refused_before_it_is_decoded() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "bounded.mp4");

    let limits = DecodeLimits::new().with_max_dimensions(WIDTH - 2, HEIGHT);
    let config = DecoderConfig::new(output_timeline()).with_limits(limits);
    let error = open_decoder(&clip, config).expect_err("a source past the bound is refused");
    assert_eq!(
        error,
        DecodeError::SourceOutOfBounds {
            bound: osg_decode::SourceBound::Width,
        }
    );
}

#[test]
fn a_file_that_is_not_media_is_refused_without_naming_itself() {
    let directory = TempDir::new().expect("a temporary directory");
    let hostile = directory.path().join("hostile.mp4");
    // Plausible enough to reach the platform and nothing like a container once it gets there.
    let mut bytes = b"\x00\x00\x00\x18ftypmp42".to_vec();
    bytes.extend(std::iter::repeat_n(0xA5_u8, 64 * 1024));
    fs::write(&hostile, &bytes).expect("the hostile fixture is written");

    let error = open_decoder(&hostile, DecoderConfig::new(output_timeline()))
        .expect_err("a file that is not media is refused");
    let rendered = error.to_string();
    assert!(!rendered.contains("hostile"), "the error named the file");
    assert!(!rendered.contains("C:"), "the error carried a path");
    println!("hostile file refused with: {error:?}");
}

#[test]
fn a_closed_decoder_refuses_further_work() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "closed.mp4");
    let mut decoder = decoder_for(&clip);

    decoder.frame_for_output(0).expect("the first frame");
    decoder.close();
    // Every route in, including the one that would not have had to touch the reader.
    assert_eq!(decoder.frame_for_output(0), Err(DecodeError::Closed));
    assert_eq!(decoder.frame_for_output(1), Err(DecodeError::Closed));
    assert_eq!(decoder.source_frame(4), Err(DecodeError::Closed));
    assert!(matches!(decoder.next_frame(), Err(DecodeError::Closed)));
    // Idempotent, so a close racing a natural end is not itself an error.
    decoder.close();
}

#[test]
fn the_debug_view_of_a_live_decoder_carries_no_path_and_no_pixels() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "debug-view.mp4");
    let mut decoder = decoder_for(&clip);
    let frame = decoder.frame_for_output(3).expect("a frame");

    let decoder_view = format!("{decoder:?}");
    assert!(
        !decoder_view.contains("debug-view") && !decoder_view.contains('\\'),
        "the decoder debug view leaked a path: {decoder_view}"
    );
    assert!(
        decoder_view.contains("width"),
        "the decoder debug view says nothing useful"
    );

    let frame_view = format!("{frame:?}");
    assert!(
        frame_view.contains("source_index"),
        "the frame debug view says nothing useful"
    );
    assert!(
        !frame_view.contains("pixels: ["),
        "the frame debug view leaked the picture: {frame_view}"
    );
}

#[test]
fn a_missing_source_is_refused_before_the_platform_is_asked() {
    let directory = TempDir::new().expect("a temporary directory");
    let missing = directory.path().join("not-here.mp4");
    assert_eq!(
        open_decoder(&missing, DecoderConfig::new(output_timeline())).unwrap_err(),
        DecodeError::SourceUnusable {
            reason: SourceRejection::NotAFile,
        }
    );
}
