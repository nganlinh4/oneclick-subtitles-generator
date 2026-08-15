//! The timestamp contract: one rounding per frame, derived from that frame's own index.
//!
//! These tests need no GPU and no media platform. They re-derive every expected value from exact
//! integer arithmetic in this file, so they are a check on the implementation rather than a
//! restatement of it.

use osg_encode::{EncodeError, FrameClock, MAX_ENCODE_FRAME_COUNT, timing};

/// 100ns units in one second.
const HUNDRED_NANOS: i128 = 10_000_000;

/// NTSC 29.97: the rate the naive implementation fails on.
const NTSC_NUMERATOR: u32 = 30_000;
const NTSC_DENOMINATOR: u32 = 1_001;

/// The exact instant of frame `index`, rounded to 100ns units exactly once.
///
/// Independent of the crate: plain integer arithmetic on the rational `index * den / num`.
fn ideal_100ns(index: u32, fps_numerator: u32, fps_denominator: u32) -> i128 {
    let numerator = i128::from(index) * i128::from(fps_denominator) * HUNDRED_NANOS;
    let denominator = i128::from(fps_numerator);
    (numerator * 2 + denominator) / (denominator * 2)
}

/// The single truncated frame duration the reference implementation computes and reuses.
fn naive_frame_duration_100ns(fps_numerator: u32, fps_denominator: u32) -> i128 {
    (HUNDRED_NANOS * i128::from(fps_denominator)) / i128::from(fps_numerator)
}

#[test]
fn naive_accumulation_drifts_at_ntsc_and_this_clock_does_not() {
    let clock = FrameClock::new(NTSC_NUMERATOR, NTSC_DENOMINATOR, MAX_ENCODE_FRAME_COUNT)
        .expect("the longest supported NTSC encode is a valid clock");

    // The reference's arithmetic: 10_000_000 * 1001 / 30_000 truncated to whole 100ns units.
    let naive_duration = naive_frame_duration_100ns(NTSC_NUMERATOR, NTSC_DENOMINATOR);
    assert_eq!(naive_duration, 333_666);
    // The true duration is 333_666.666..., so every frame loses two thirds of a unit.

    let last = MAX_ENCODE_FRAME_COUNT - 1;
    let ours = i128::from(
        clock
            .timestamp_100ns(last)
            .expect("the last frame has a timestamp"),
    );
    let exact = ideal_100ns(last, NTSC_NUMERATOR, NTSC_DENOMINATOR);
    let naive = i128::from(last) * naive_duration;

    // Ours is the correctly rounded value; the naive one is 179.9999 ms early by the end.
    assert_eq!(ours, exact);
    assert_eq!(ours, 900_899_332_667);
    assert_eq!(naive, 900_897_532_668);
    assert_eq!(ours - naive, 1_799_999);

    // 1_799_999 units is 5.39 frames at this rate: an exported file whose audio and video have
    // visibly parted company.
    let drift_frames = (ours - naive) / naive_duration;
    assert_eq!(drift_frames, 5);
}

#[test]
fn naive_drift_grows_with_length_while_ours_stays_at_zero() {
    let naive_duration = naive_frame_duration_100ns(NTSC_NUMERATOR, NTSC_DENOMINATOR);

    // One hour, four hours, and the longest supported encode.
    for frames in [107_892_u32, 431_568, MAX_ENCODE_FRAME_COUNT - 1] {
        let clock = FrameClock::new(NTSC_NUMERATOR, NTSC_DENOMINATOR, frames + 1)
            .expect("a valid NTSC clock");
        let ours = i128::from(
            clock
                .timestamp_100ns(frames)
                .expect("the frame has a timestamp"),
        );
        let exact = ideal_100ns(frames, NTSC_NUMERATOR, NTSC_DENOMINATOR);
        let naive = i128::from(frames) * naive_duration;

        assert_eq!(ours - exact, 0, "our timestamp is the exact rounded value");
        assert!(
            exact - naive > 0,
            "the naive accumulation is always early, never late"
        );
    }

    // The drift is proportional to length, which is what makes it a defect rather than an offset.
    let drift_at = |frames: u32| {
        ideal_100ns(frames, NTSC_NUMERATOR, NTSC_DENOMINATOR) - i128::from(frames) * naive_duration
    };
    assert_eq!(drift_at(107_892), 71_928);
    assert_eq!(drift_at(431_568), 287_712);
    assert_eq!(drift_at(2_699_998), 1_799_999);
}

#[test]
fn every_timestamp_is_within_half_a_unit_of_its_exact_instant() {
    let clock = FrameClock::new(NTSC_NUMERATOR, NTSC_DENOMINATOR, MAX_ENCODE_FRAME_COUNT)
        .expect("a valid NTSC clock");

    // Sampled across the whole range, including the ends and a prime stride so the sample set is
    // not aligned to the 1001-frame repeat of the rational.
    let samples = [0_u32, 1, 2, 999, 100_003, 1_000_003, 2_000_003, 2_699_998];
    for index in samples {
        let ours = i128::from(
            clock
                .timestamp_100ns(index)
                .expect("a sampled frame has a timestamp"),
        );
        // |ours - index*den*1e7/num| <= 1/2, multiplied out to stay in integers.
        let scaled_error = (ours * i128::from(NTSC_NUMERATOR)
            - i128::from(index) * i128::from(NTSC_DENOMINATOR) * HUNDRED_NANOS)
            .abs();
        assert!(
            scaled_error * 2 <= i128::from(NTSC_NUMERATOR),
            "frame {index} is more than half a 100ns unit from its exact instant"
        );
    }
}

#[test]
fn seeking_to_a_frame_matches_walking_to_it() {
    let clock = FrameClock::new(24_000, 1_001, 5_000).expect("a valid 23.976 clock");

    let mut walked = Vec::with_capacity(5_000);
    for index in 0..5_000 {
        walked.push(clock.timestamp_100ns(index).expect("a timestamp"));
    }
    for index in [0_u32, 1, 1_234, 4_999] {
        let sought = clock.timestamp_100ns(index).expect("a timestamp");
        let position = usize::try_from(index).expect("the index fits a usize");
        assert_eq!(sought, walked[position]);
    }
}

#[test]
fn frame_durations_sum_to_the_total_duration_exactly() {
    for (numerator, denominator) in [
        (30_000_u32, 1_001_u32),
        (24_000, 1_001),
        (60_000, 1_001),
        (25, 1),
        (30, 1),
        (50, 1),
        (120, 1),
    ] {
        let frames = 3_000;
        let clock = FrameClock::new(numerator, denominator, frames).expect("a valid clock");
        let summed: i64 = (0..frames)
            .map(|index| clock.duration_100ns(index).expect("a duration"))
            .sum();
        assert_eq!(
            summed,
            clock.total_duration_100ns().expect("a total duration"),
            "durations do not sum to the total at {numerator}/{denominator}"
        );
    }
}

#[test]
fn timestamps_are_strictly_increasing() {
    let clock = FrameClock::new(NTSC_NUMERATOR, NTSC_DENOMINATOR, 20_000).expect("a valid clock");
    let mut previous = i64::MIN;
    for index in 0..20_000 {
        let current = clock.timestamp_100ns(index).expect("a timestamp");
        assert!(
            current > previous,
            "frame {index} did not advance the clock"
        );
        previous = current;
    }
}

#[test]
fn integer_frame_rates_land_on_exact_values() {
    let clock = FrameClock::new(25, 1, 100).expect("a valid 25fps clock");
    assert_eq!(clock.timestamp_100ns(0), Ok(0));
    assert_eq!(clock.timestamp_100ns(7), Ok(2_800_000));
    assert_eq!(clock.duration_100ns(7), Ok(400_000));
    assert_eq!(clock.total_duration_100ns(), Ok(40_000_000));
}

#[test]
fn a_frame_past_the_end_is_refused() {
    let clock = FrameClock::new(30, 1, 10).expect("a valid clock");
    assert_eq!(
        clock.timestamp_100ns(10),
        Err(EncodeError::FrameOutOfRange {
            index: 10,
            frame_count: 10,
        })
    );
    assert_eq!(
        clock.duration_100ns(10),
        Err(EncodeError::FrameOutOfRange {
            index: 10,
            frame_count: 10,
        })
    );
    // The last real frame still has both, because the clock spans one more instant than it has
    // frames.
    assert!(clock.timestamp_100ns(9).is_ok());
    assert!(clock.duration_100ns(9).is_ok());
}

#[test]
fn unusable_clocks_are_refused() {
    assert!(FrameClock::new(30, 1, 0).is_err(), "zero frames");
    assert!(
        FrameClock::new(30, 1, MAX_ENCODE_FRAME_COUNT + 1).is_err(),
        "past the frame-count bound"
    );
    assert!(FrameClock::new(0, 1, 10).is_err(), "zero numerator");
    assert!(FrameClock::new(30, 0, 10).is_err(), "zero denominator");
    assert!(FrameClock::new(1_000_000, 1, 10).is_err(), "absurd rate");
    assert!(
        FrameClock::new(MAX_ENCODE_FRAME_COUNT, 1, 10).is_err(),
        "numerator past the supported range"
    );
}

#[test]
fn audio_timestamps_are_derived_from_the_sample_index() {
    // One hour of 44.1kHz, where a per-block accumulation of a truncated duration would drift.
    let rate = 44_100_u32;
    let one_hour = u64::from(rate) * 3_600;
    for sample in [0_u64, 1, 441, 44_100, one_hour / 2, one_hour] {
        let ours =
            i128::from(timing::audio_timestamp_100ns(sample, rate).expect("an audio timestamp"));
        let scaled_error = (ours * i128::from(rate) - i128::from(sample) * HUNDRED_NANOS).abs();
        assert!(
            scaled_error * 2 <= i128::from(rate),
            "sample {sample} is more than half a 100ns unit from its exact instant"
        );
    }
    assert_eq!(
        timing::audio_timestamp_100ns(44_100, 44_100),
        Ok(10_000_000)
    );
    assert_eq!(
        timing::audio_timestamp_100ns(48_000, 48_000),
        Ok(10_000_000)
    );
    assert!(timing::audio_timestamp_100ns(0, 0).is_err());
}
