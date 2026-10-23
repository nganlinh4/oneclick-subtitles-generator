//! Which source frame each request lands on: walking, seeking, rate conversion, trims, scrubbing.

use osg_decode::{DecodeError, DecoderConfig, exact_time_to_100ns, open_decoder};
use osg_scene::{ExactTime, FrameTimeline};
use tempfile::TempDir;

use super::{
    FPS, FRAMES, HEIGHT, WIDTH, assert_frame_is, decoder_for, encoded_clip, encoded_clip_at_rate,
};

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
        println!(
            "walk index={walked} source={} pts={} duration={}",
            frame.source_index(),
            frame.presentation_100ns(),
            frame.duration_100ns()
        );
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
fn a_fifteen_fps_boundary_is_independent_of_decode_history_on_a_thirty_fps_grid() {
    // Every source frame spans exactly two output frames. Source frame 14 begins at 14/15s, whose
    // exact boundary is not representable in Media Foundation's 100ns clock: it becomes 9_333_333.
    // The frame selected at that rounded boundary must not depend on whether the reader walked to
    // it or arrived after unrelated forward and backward seeks.
    const SOURCE_FPS: u32 = 15;
    const BOUNDARY_SOURCE_INDEX: u32 = 14;
    const BOUNDARY_OUTPUT_INDEX: u32 = BOUNDARY_SOURCE_INDEX * 2;

    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip_at_rate(&directory, "fifteen-fps-boundary.mp4", SOURCE_FPS, FRAMES);
    let timeline = FrameTimeline::new(FPS, 1, FRAMES * 2, ExactTime::ZERO)
        .expect("a supported 30fps output timeline");
    let boundary_time = timeline
        .frame_time(BOUNDARY_OUTPUT_INDEX)
        .expect("the boundary is on the output timeline");
    assert_eq!(boundary_time, ExactTime::new(14, 15).expect("14/15s"));
    assert_eq!(exact_time_to_100ns(boundary_time), Some(9_333_333));

    let mut sequential = open_decoder(&clip, DecoderConfig::new(timeline))
        .expect("the 15fps clip opens against a 30fps timeline");
    assert_eq!(sequential.source().fps_numerator(), SOURCE_FPS);
    assert_eq!(sequential.source().fps_denominator(), 1);
    let mut sequential_boundary = None;
    for output_index in 0..=BOUNDARY_OUTPUT_INDEX {
        let frame = sequential
            .frame_for_output(output_index)
            .expect("sequential sampling decodes the requested frame");
        assert_eq!(
            frame.source_index(),
            u64::from(output_index / 2),
            "30fps output frame {output_index} selected source frame {}",
            frame.source_index()
        );
        if output_index == BOUNDARY_OUTPUT_INDEX {
            sequential_boundary = Some(frame);
        }
    }
    let sequential_boundary =
        sequential_boundary.expect("the sequential walk reached the boundary");
    assert_frame_is(&sequential_boundary, BOUNDARY_SOURCE_INDEX);

    let mut sought = open_decoder(&clip, DecoderConfig::new(timeline))
        .expect("the 15fps clip opens for arbitrary sampling");
    for output_index in [52_u32, 3, 44, 9, 58, 17] {
        let frame = sought
            .frame_for_output(output_index)
            .expect("an arbitrary output request decodes");
        assert_eq!(
            frame.source_index(),
            u64::from(output_index / 2),
            "arbitrary output frame {output_index} selected source frame {}",
            frame.source_index()
        );
    }
    let sought_boundary = sought
        .frame_for_output(BOUNDARY_OUTPUT_INDEX)
        .expect("the rounded boundary decodes after arbitrary seeks");
    assert_eq!(
        sought_boundary.source_index(),
        u64::from(BOUNDARY_SOURCE_INDEX)
    );
    assert_eq!(
        sought_boundary.pixels(),
        sequential_boundary.pixels(),
        "the same quantized boundary produced different pixels after a different decode history"
    );
    assert!(
        sought.stats().seeks() > 0,
        "the arbitrary history did not exercise the seek path"
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
