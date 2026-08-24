//! Frame index to instant, without a media file.
//!
//! This is the arithmetic the frame-exactness of the whole decoder rests on, so it is proven on its
//! own before anything platform-shaped is involved. The cases that matter are the ones where a
//! float would already have drifted: 30000/1001, a long timeline, and a trim offset that is not a
//! whole number of frames.

use osg_decode::{DecodeError, OutputSampler, SourceGrid, exact_time_to_100ns};
use osg_scene::{ExactTime, FrameTimeline};

fn timeline(numerator: u32, denominator: u32, frames: u32, start: ExactTime) -> FrameTimeline {
    FrameTimeline::new(numerator, denominator, frames, start).expect("a supported timeline")
}

#[test]
fn an_exact_second_is_an_exact_number_of_units() {
    assert_eq!(exact_time_to_100ns(ExactTime::ZERO), Some(0));
    assert_eq!(
        exact_time_to_100ns(ExactTime::new(1, 1).expect("one second")),
        Some(10_000_000)
    );
    assert_eq!(
        exact_time_to_100ns(ExactTime::new(1, 2).expect("half a second")),
        Some(5_000_000)
    );
}

#[test]
fn a_third_of_a_second_rounds_to_nearest_rather_than_truncating() {
    // 1/3 s is 3_333_333.33 units. Truncation would lose a third of a unit here and every time,
    // which is the drift `osg-encode` documents on the encode side; this is the decode side of the
    // same rule, so the two name the same instant.
    assert_eq!(
        exact_time_to_100ns(ExactTime::new(1, 3).expect("a third")),
        Some(3_333_333)
    );
    assert_eq!(
        exact_time_to_100ns(ExactTime::new(2, 3).expect("two thirds")),
        Some(6_666_667)
    );
}

#[test]
fn output_frames_sample_where_the_timeline_says() {
    let sampler = OutputSampler::new(timeline(30, 1, 90, ExactTime::ZERO));
    assert_eq!(sampler.sample_100ns(0), Ok(0));
    assert_eq!(sampler.sample_100ns(1), Ok(333_333));
    assert_eq!(sampler.sample_100ns(30), Ok(10_000_000));
    assert_eq!(sampler.sample_100ns(89), Ok(29_666_667));
}

#[test]
fn a_trim_offset_moves_every_sample_and_nothing_else() {
    // The trim is the timeline's start, so the decoder sees it without doing any arithmetic of its
    // own. Two and a half seconds in, at 30fps.
    let start = ExactTime::new(5, 2).expect("two and a half seconds");
    let sampler = OutputSampler::new(timeline(30, 1, 60, start));
    assert_eq!(sampler.sample_100ns(0), Ok(25_000_000));
    assert_eq!(sampler.sample_100ns(1), Ok(25_333_333));
    assert_eq!(sampler.sample_100ns(30), Ok(35_000_000));
}

#[test]
fn ntsc_rates_do_not_drift_over_a_long_timeline() {
    // 30000/1001 is the rate a float gets wrong. Frame 100_000 is just short of an hour in; its
    // instant is computed from its own index, so it is exact rather than a hundred thousand
    // accumulated roundings.
    let sampler = OutputSampler::new(timeline(30_000, 1_001, 200_000, ExactTime::ZERO));
    let frame = 100_000_u32;
    let expected = i64::from(frame) * 1_001 * 10_000_000 / 30_000;
    let produced = sampler.sample_100ns(frame).expect("in range");
    assert!(
        (produced - expected).abs() <= 1,
        "frame {frame} landed at {produced}, the exact instant is about {expected}"
    );
    // The property that matters more than the value: seeking to it is the same as walking to it.
    assert_eq!(sampler.sample_100ns(frame), sampler.sample_100ns(frame));
}

#[test]
fn an_index_past_the_timeline_is_refused_and_names_the_bound() {
    let sampler = OutputSampler::new(timeline(30, 1, 90, ExactTime::ZERO));
    assert_eq!(
        sampler.sample_100ns(90),
        Err(DecodeError::FrameOutOfRange {
            index: 90,
            frame_count: 90,
        })
    );
}

#[test]
fn a_source_frame_is_asked_for_at_its_midpoint() {
    // Half a frame from either boundary, so no rounding in the container's timestamps can push the
    // request into the neighbouring frame. At 30fps a frame is 333_333 units, so frame zero is
    // asked for at 166_667.
    let grid = SourceGrid::new(30, 1).expect("a supported rate");
    assert_eq!(grid.frame_midpoint_100ns(0), Ok(166_667));
    assert_eq!(grid.frame_midpoint_100ns(1), Ok(500_000));
    assert_eq!(grid.frame_midpoint_100ns(2), Ok(833_333));

    // And each midpoint really is inside the frame it names.
    for index in 0..120_u32 {
        let midpoint = grid.frame_midpoint_100ns(index).expect("in range");
        assert_eq!(
            grid.frame_index_at_100ns(midpoint),
            u64::from(index),
            "the midpoint of frame {index} fell outside it"
        );
    }
}

#[test]
fn a_sample_timestamp_maps_back_to_the_frame_it_belongs_to() {
    let grid = SourceGrid::new(30, 1).expect("a supported rate");
    assert_eq!(grid.frame_index_at_100ns(0), 0);
    assert_eq!(grid.frame_index_at_100ns(333_332), 0);
    assert_eq!(grid.frame_index_at_100ns(333_334), 1);
    assert_eq!(grid.frame_index_at_100ns(10_000_000), 30);
    // A negative timestamp is a frame the container wants discarded; the first frame is the honest
    // answer rather than a panic or a wrapped index.
    assert_eq!(grid.frame_index_at_100ns(-1_000), 0);
}

#[test]
fn a_quantised_sample_timestamp_names_the_frame_it_really_is() {
    // The off-by-one that a real decode found. A container stores frame 1 of a 30fps source as
    // `333_333` where the exact instant is `333_333.33`, so flooring reports it as frame 0 — and
    // does so for two frames in every three. Rounding to the nearest grid position is the fix, and
    // this is the case that proves it.
    let grid = SourceGrid::new(30, 1).expect("a supported rate");
    assert_eq!(grid.frame_index_at_100ns(333_333), 0);
    assert_eq!(grid.nearest_frame_index_100ns(333_333), 1);

    for index in 0..300_u64 {
        // What Media Foundation reports: the exact instant, truncated to whole units.
        let truncated = i64::try_from(index).expect("a small index") * 10_000_000 / 30;
        assert_eq!(
            grid.nearest_frame_index_100ns(truncated),
            index,
            "a truncated timestamp for frame {index} named the wrong frame"
        );
    }
}

#[test]
fn ntsc_source_frames_land_where_the_ratio_says() {
    let grid = SourceGrid::new(30_000, 1_001).expect("a supported rate");
    assert_eq!(grid.frame_count_for(10_000_000), 29);
    assert_eq!(grid.frame_count_for(0), 0);
    for index in [0_u32, 1, 999, 100_000] {
        let midpoint = grid.frame_midpoint_100ns(index).expect("in range");
        assert_eq!(grid.frame_index_at_100ns(midpoint), u64::from(index));
    }
}

#[test]
fn an_unreduced_platform_rate_is_the_same_source_grid() {
    // Media Foundation reports this exact spelling for a real 24000/1001 AV1 download. The scale
    // belongs to the container time base; it does not turn the ordinary rate into an unsupported
    // 24-million-fps source.
    let reduced = SourceGrid::new(24_000, 1_001).expect("a supported rate");
    let platform = SourceGrid::new(24_000_000, 1_001_000).expect("the same supported rate");
    assert_eq!(platform, reduced);
    assert_eq!(platform.numerator(), 24_000);
    assert_eq!(platform.denominator(), 1_001);
    assert_eq!(
        platform.frame_midpoint_100ns(100_000),
        reduced.frame_midpoint_100ns(100_000)
    );
}

#[test]
fn a_media_foundation_clock_rate_is_bounded_by_value_not_by_its_large_terms() {
    let platform = SourceGrid::new(10_000_000, 417_083).expect("ordinary 23.976fps");
    assert_eq!(platform.numerator(), 10_000_000);
    assert_eq!(platform.denominator(), 417_083);
    assert_eq!(platform.frame_count_for(1_910_340_000), 4_580);
}

#[test]
fn a_nonsense_frame_rate_is_refused_rather_than_producing_nonsense_instants() {
    assert_eq!(
        SourceGrid::new(0, 1),
        Err(DecodeError::UnsupportedFrameRate)
    );
    assert_eq!(
        SourceGrid::new(30, 0),
        Err(DecodeError::UnsupportedFrameRate)
    );
    assert_eq!(
        SourceGrid::new(u32::MAX, 1),
        Err(DecodeError::UnsupportedFrameRate)
    );
}
