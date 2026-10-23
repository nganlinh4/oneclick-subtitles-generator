//! Audio tails, cancellation, bounds, hostile inputs, closing, and redaction.

use std::fs;

use osg_decode::{DecodeError, DecodeLimits, DecoderConfig, SourceRejection, open_decoder};
use osg_scene::{ExactTime, FrameTimeline};
use tempfile::TempDir;

use super::{
    FPS, FRAMES, HEIGHT, WIDTH, assert_frame_is, decoder_for, encoded_clip,
    encoded_clip_with_audio_tail, output_timeline,
};

#[test]
fn a_declared_audio_tail_holds_the_last_video_frame() {
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip_with_audio_tail(&directory, "audio-tail.mp4");
    let tail_timeline =
        FrameTimeline::new(FPS, 1, 33, ExactTime::ZERO).expect("a supported timeline");
    let mut decoder = open_decoder(&clip, DecoderConfig::new(tail_timeline))
        .expect("the clip opens against its full presentation");
    assert!(
        decoder.source().duration_100ns() > 10_000_000,
        "the audio track must extend the declared presentation"
    );

    let held = decoder
        .frame_for_output(31)
        .expect("the final picture stays visible during the declared audio tail");
    assert_frame_is(&held, FRAMES - 1);
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
