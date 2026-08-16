//! Bounds and fail-closed behaviour that needs no GPU.
//!
//! These assertions run on every machine, adapter or not.

use osg_compositor::{
    AdapterSelection, Axis, Compositor, CompositorError, FrameSize, MAX_FRAME_DIMENSION,
    MAX_FRAME_PIXELS, MIN_FRAME_DIMENSION, Rejection, SubtitleStyle, SubtitleStyleSpec, TestScene,
};
use osg_scene::layout::Margins;

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

/// The custom-placement range the render contract accepts, from `osg-render`'s `contract.rs`.
const CONTRACT_PLACEMENT: f64 = 1_000.0;
/// The margin range the render contract accepts, from the same table.
const CONTRACT_MARGIN: f64 = 10_000.0;

fn custom_placed(custom_x: f64, custom_y: f64) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        position: "custom".to_owned(),
        custom_x,
        custom_y,
        ..SubtitleStyleSpec::default()
    }
}

fn margined(margin: f64) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        margins: Margins {
            bottom: margin,
            top: margin,
            left: margin,
            right: margin,
        },
        ..SubtitleStyleSpec::default()
    }
}

fn refused_geometry(spec: &SubtitleStyleSpec, what: &str) {
    let error = SubtitleStyle::resolve(spec).expect_err(what);
    assert!(
        matches!(
            error,
            CompositorError::UnsupportedSceneInput {
                reason: Rejection::StyleGeometry
            }
        ),
        "unexpected error: {error}"
    );
}

/// Every custom placement the render contract accepts resolves here.
///
/// A project persisting `customPositionX: -100` is one the shipped renderer drew as
/// `left: -100%`, so a compositor that refused it would make that project unexportable rather than
/// merely differently placed. The endpoints are asserted, not just a sample, because the failure
/// this replaces was a bound that stopped at 100.
#[test]
fn every_custom_placement_the_contract_accepts_resolves() {
    for placement in [
        -CONTRACT_PLACEMENT,
        -100.0,
        -0.001,
        0.0,
        50.0,
        100.0,
        100.001,
        420.0,
        CONTRACT_PLACEMENT,
    ] {
        SubtitleStyle::resolve(&custom_placed(placement, placement))
            .unwrap_or_else(|error| panic!("customPosition {placement} must resolve: {error}"));
    }
}

/// And nothing past it does, so the bound is the contract's rather than absent.
#[test]
fn a_custom_placement_past_the_contract_is_still_refused() {
    for placement in [
        -CONTRACT_PLACEMENT - 0.001,
        CONTRACT_PLACEMENT + 0.001,
        f64::NAN,
        f64::INFINITY,
    ] {
        refused_geometry(
            &custom_placed(placement, 50.0),
            "a horizontal placement past the contract is not renderable",
        );
        refused_geometry(
            &custom_placed(50.0, placement),
            "a vertical placement past the contract is not renderable",
        );
    }
}

/// Every margin the render contract accepts resolves here, negative ones included.
#[test]
fn every_margin_the_contract_accepts_resolves() {
    for margin in [-CONTRACT_MARGIN, -100.0, -0.001, 0.0, 80.0, CONTRACT_MARGIN] {
        SubtitleStyle::resolve(&margined(margin))
            .unwrap_or_else(|error| panic!("a margin of {margin} must resolve: {error}"));
    }
}

/// And nothing past it does.
#[test]
fn a_margin_past_the_contract_is_still_refused() {
    for margin in [
        -CONTRACT_MARGIN - 0.001,
        CONTRACT_MARGIN + 0.001,
        f64::NAN,
        f64::INFINITY,
    ] {
        refused_geometry(
            &margined(margin),
            "a margin past the contract is not renderable",
        );
    }
}

/// Padding and radius are sizes, not offsets, so they stay non-negative.
///
/// Widening the offsets must not widen these with them: a negative padding describes no drawing,
/// and the contract bounds `borderRadius` at `0..=1000` too.
#[test]
fn a_negative_padding_or_radius_is_still_refused() {
    for spec in [
        SubtitleStyleSpec {
            background_padding_x: -1.0,
            ..SubtitleStyleSpec::default()
        },
        SubtitleStyleSpec {
            background_padding_y: -1.0,
            ..SubtitleStyleSpec::default()
        },
        SubtitleStyleSpec {
            border_radius: -1.0,
            ..SubtitleStyleSpec::default()
        },
    ] {
        refused_geometry(
            &spec,
            "a negative size is not a drawing this crate can make",
        );
    }
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
