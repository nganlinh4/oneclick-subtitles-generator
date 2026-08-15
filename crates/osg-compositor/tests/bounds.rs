//! Bounds and fail-closed behaviour that needs no GPU.
//!
//! These assertions run on every machine, adapter or not.

use osg_compositor::{
    AdapterSelection, Axis, Compositor, CompositorError, FrameSize, MAX_FRAME_DIMENSION,
    MAX_FRAME_PIXELS, MIN_FRAME_DIMENSION, TestScene,
};

#[test]
fn accepts_the_smallest_and_largest_supported_frames() {
    let smallest = FrameSize::new(MIN_FRAME_DIMENSION, MIN_FRAME_DIMENSION)
        .expect("a 1x1 frame is within bounds");
    assert_eq!(smallest.pixels(), 1);
    assert_eq!(smallest.rgba8_len(), 4);

    let largest = FrameSize::new(7680, 4320).expect("8K is within bounds");
    assert_eq!(largest.pixels(), MAX_FRAME_PIXELS);
    assert_eq!(largest.rgba8_len(), MAX_FRAME_PIXELS * 4);
}

#[test]
fn rejects_a_zero_width() {
    let error = FrameSize::new(0, 1080).expect_err("a zero width is not renderable");
    assert!(
        matches!(
            error,
            CompositorError::DimensionOutOfRange {
                axis: Axis::Width,
                value: 0,
                ..
            }
        ),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_a_zero_height() {
    let error = FrameSize::new(1920, 0).expect_err("a zero height is not renderable");
    assert!(
        matches!(
            error,
            CompositorError::DimensionOutOfRange {
                axis: Axis::Height,
                value: 0,
                ..
            }
        ),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_an_oversized_edge() {
    let error = FrameSize::new(MAX_FRAME_DIMENSION + 1, 16)
        .expect_err("an edge past the texture limit is not renderable");
    assert!(
        matches!(
            error,
            CompositorError::DimensionOutOfRange {
                axis: Axis::Width,
                ..
            }
        ),
        "unexpected error: {error}"
    );

    let error = FrameSize::new(16, MAX_FRAME_DIMENSION + 1)
        .expect_err("an edge past the texture limit is not renderable");
    assert!(
        matches!(
            error,
            CompositorError::DimensionOutOfRange {
                axis: Axis::Height,
                ..
            }
        ),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_an_oversized_area_built_from_legal_edges() {
    let error = FrameSize::new(MAX_FRAME_DIMENSION, MAX_FRAME_DIMENSION)
        .expect_err("both edges are legal but 67 megapixels is not");
    assert!(
        matches!(
            error,
            CompositorError::AreaOutOfRange {
                value: 67_108_864,
                max: MAX_FRAME_PIXELS,
                ..
            }
        ),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_a_phase_outside_the_unit_range() {
    for phase in [-0.000_01_f32, 1.000_01, f32::NAN, f32::INFINITY, -f32::MAX] {
        let error = TestScene::new(phase)
            .expect_err("a phase outside 0.0..=1.0 is not a valid scene input");
        assert!(
            matches!(error, CompositorError::PhaseOutOfRange { .. }),
            "unexpected error for {phase}: {error}"
        );
    }
}

#[test]
fn accepts_the_full_unit_phase_range() {
    for phase in [0.0_f32, 0.5, 1.0] {
        let scene = TestScene::new(phase).expect("a unit phase is a valid scene input");
        assert!((scene.phase() - phase).abs() < f32::EPSILON);
    }
    assert!(TestScene::origin().phase().abs() < f32::EPSILON);
    assert_eq!(TestScene::default(), TestScene::origin());
}

/// Adapter absence must be a typed error, not a panic and not a silently degraded frame.
///
/// `AdapterSelection::None` drives exactly the code path a machine with no usable GPU takes, so
/// this holds even on a machine that has one.
#[test]
fn adapter_absence_is_a_typed_error() {
    let error = Compositor::with_adapters(AdapterSelection::None)
        .expect_err("a compositor with no backends must not be constructed");
    assert!(
        matches!(error, CompositorError::NoAdapter { .. }),
        "unexpected error: {error}"
    );
    assert!(
        error.to_string().contains("no GPU adapter is available"),
        "the failure must say what is missing: {error}"
    );
}
