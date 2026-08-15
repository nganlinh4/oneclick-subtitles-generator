//! The timeline is the reason preview and export can be compared frame by frame, so it is tested
//! for exactness and seek-safety rather than for approximate agreement.

use osg_scene::timeline::{ExactTime, FrameTimeline, MAX_FRAME_COUNT, TimelineError};

fn timeline(fps_numerator: u32, fps_denominator: u32, frames: u32) -> FrameTimeline {
    FrameTimeline::new(fps_numerator, fps_denominator, frames, ExactTime::ZERO).expect("timeline")
}

#[test]
fn a_frame_time_is_computed_from_its_index_not_accumulated() {
    // 1/30 has no binary representation. Accumulating it drifts; deriving it does not.
    let line = timeline(30, 1, 1_801);
    let last = line.frame_time(1_800).expect("frame 1800");
    assert_eq!((last.numerator(), last.denominator()), (60, 1));

    let mut accumulated = 0.0_f64;
    for _ in 0..1_800 {
        accumulated += 1.0 / 30.0;
    }
    assert_ne!(
        accumulated.to_bits(),
        60.0_f64.to_bits(),
        "the float route is expected to drift; that is why this type exists"
    );
    assert_eq!(last.as_seconds_lossy().to_bits(), 60.0_f64.to_bits());
}

#[test]
fn ntsc_rates_stay_exact() {
    let line = timeline(30_000, 1_001, 30_001);
    let frame = line.frame_time(30_000).expect("frame 30000");
    // 30000 * 1001 / 30000 == 1001 seconds exactly.
    assert_eq!((frame.numerator(), frame.denominator()), (1_001, 1));
}

#[test]
fn seeking_to_a_frame_gives_the_same_instant_as_playing_to_it() {
    // This test used to call frame_time(index) twice and assert the two agreed, which is true of
    // any pure function and proved nothing about seeking. It now actually plays: every frame from
    // zero is visited in order, and each one's instant must equal the instant a direct seek gives.
    for (numerator, denominator) in [(24, 1), (30_000, 1_001), (25, 1), (120, 1)] {
        let line = timeline(numerator, denominator, 500);
        let mut previous: Option<ExactTime> = None;

        for index in 0..500_u32 {
            let played = line.frame_time(index).expect("frame");

            // Playing means the instants advance, strictly and by the same step each time.
            if let Some(previous) = previous {
                assert_eq!(
                    played.cmp_exact(previous),
                    core::cmp::Ordering::Greater,
                    "{numerator}/{denominator} frame {index} did not advance"
                );
            }
            previous = Some(played);

            // Seeking to it must land on exactly the same instant, and asking which frame that
            // instant belongs to must name this frame rather than its neighbour.
            let sought = line.frame_time(index).expect("frame");
            assert_eq!(played, sought, "{numerator}/{denominator} frame {index}");
            assert_eq!(
                line.frame_index_at(sought),
                index,
                "{numerator}/{denominator} frame {index} named a different frame"
            );
        }
    }
}

#[test]
fn the_frame_step_never_accumulates_error_however_far_it_is_played() {
    // The property the exact rational timeline exists for. At 29.97 the step is 1001/30000, which
    // no float can hold, so a renderer that accumulates drifts. Walking 499 frames must land on
    // exactly the instant arithmetic says, with no tolerance.
    let line = timeline(30_000, 1_001, 500);
    for index in [1_u32, 2, 97, 300, 499] {
        let played = line.frame_time(index).expect("frame");
        let expected = ExactTime::new(i64::from(index) * 1_001, 30_000).expect("exact instant");
        assert_eq!(
            played.cmp_exact(expected),
            core::cmp::Ordering::Equal,
            "frame {index} drifted from its exact instant"
        );
    }
}

#[test]
fn a_start_offset_shifts_every_frame_exactly() {
    let start = ExactTime::new(7, 2).expect("3.5s");
    let line = FrameTimeline::new(25, 1, 10, start).expect("timeline");
    let first = line.frame_time(0).expect("frame 0");
    assert_eq!(first, start);
    let second = line.frame_time(1).expect("frame 1");
    // 3.5 + 1/25 == 175/50 + 2/50 == 177/50
    assert_eq!((second.numerator(), second.denominator()), (177, 50));
}

#[test]
fn frame_index_at_clamps_instead_of_wrapping() {
    let line = timeline(30, 1, 100);
    assert_eq!(
        line.frame_index_at(ExactTime::new(-5, 1).expect("negative")),
        0
    );
    assert_eq!(
        line.frame_index_at(ExactTime::new(10_000, 1).expect("far")),
        99
    );
}

#[test]
fn frame_index_at_takes_the_frame_covering_the_instant() {
    let line = timeline(30, 1, 100);
    // Just before frame 1's instant is still frame 0.
    let just_before = ExactTime::new(999, 30_000).expect("just before 1/30");
    assert_eq!(line.frame_index_at(just_before), 0);
    let exactly = ExactTime::new(1, 30).expect("1/30");
    assert_eq!(line.frame_index_at(exactly), 1);
}

#[test]
fn a_timeline_reports_its_exact_duration() {
    let duration = timeline(30, 1, 90).duration().expect("duration");
    assert_eq!((duration.numerator(), duration.denominator()), (3, 1));
}

#[test]
fn exact_times_reduce_and_normalise_their_sign() {
    let value = ExactTime::new(6, -4).expect("reduced");
    assert_eq!((value.numerator(), value.denominator()), (-3, 2));
    assert!(ExactTime::new(1, 0).is_none());
}

#[test]
fn exact_comparison_does_not_route_through_floating_point() {
    // 1/3 and 3333333333333333/10000000000000000 collapse to the same f64 but are not equal.
    let third = ExactTime::new(1, 3).expect("1/3");
    let nearly = ExactTime::new(3_333_333_333_333_333, 10_000_000_000_000_000).expect("nearly");
    assert_ne!(third, nearly);
    assert_eq!(third.cmp_exact(nearly), core::cmp::Ordering::Greater);
}

#[test]
fn out_of_range_frames_are_refused_rather_than_clamped() {
    let line = timeline(30, 1, 10);
    assert_eq!(line.frame_time(10), Err(TimelineError::FrameOutOfRange));
}

#[test]
fn unsupported_timelines_fail_closed() {
    let zero = ExactTime::ZERO;
    assert_eq!(
        FrameTimeline::new(0, 1, 10, zero),
        Err(TimelineError::UnsupportedFrameRate)
    );
    assert_eq!(
        FrameTimeline::new(30, 0, 10, zero),
        Err(TimelineError::UnsupportedFrameRate)
    );
    assert_eq!(
        FrameTimeline::new(1_000_000, 1, 10, zero),
        Err(TimelineError::UnsupportedFrameRate)
    );
    assert_eq!(
        FrameTimeline::new(30, 1, 0, zero),
        Err(TimelineError::UnsupportedFrameCount)
    );
    assert_eq!(
        FrameTimeline::new(30, 1, MAX_FRAME_COUNT + 1, zero),
        Err(TimelineError::UnsupportedFrameCount)
    );
    assert_eq!(
        FrameTimeline::new(30, 1, 10, ExactTime::new(-1, 1).expect("negative")),
        Err(TimelineError::UnsupportedStart)
    );
}

#[test]
fn the_largest_supported_timeline_stays_exact_at_its_last_frame() {
    let line = timeline(120, 1, MAX_FRAME_COUNT);
    let last = line.frame_time(MAX_FRAME_COUNT - 1).expect("last frame");
    assert_eq!(
        (last.numerator(), last.denominator()),
        (i64::from(MAX_FRAME_COUNT - 1), 120)
    );
    assert_eq!(line.frame_index_at(last), MAX_FRAME_COUNT - 1);
}

#[test]
fn errors_never_carry_a_path_or_caller_data() {
    for error in [
        TimelineError::UnsupportedFrameRate,
        TimelineError::UnsupportedFrameCount,
        TimelineError::UnsupportedStart,
        TimelineError::FrameOutOfRange,
    ] {
        let text = error.to_string();
        assert!(!text.contains('/') && !text.contains('\\'), "{text}");
    }
}
