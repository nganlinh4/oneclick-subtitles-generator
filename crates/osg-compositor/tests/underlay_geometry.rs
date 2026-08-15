//! Where the underlay's pixels come from: crop and flip, against a real adapter.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.
//!
//! The fixture source carries four flat quadrant colours, so a crop that selects the wrong region or
//! a flip applied to the wrong axis lands a *different named colour* under the assertion rather than
//! a slightly wrong one. The flips are additionally checked as exact reversals of the unflipped
//! frame, which is a claim a nearly-right sampling transform cannot satisfy.

mod common;

use common::frames::{
    compositor, mirrored_horizontally, mirrored_vertically, quadrants, rotated_180,
};
use common::{
    HOLD_FRAME, SILENT_FRAME, SOURCE_BOTTOM_LEFT, SOURCE_BOTTOM_RIGHT, SOURCE_TOP_LEFT,
    SOURCE_TOP_RIGHT, quadrant_source, staged, style_spec, underlay,
};
use osg_compositor::{CropSpec, VideoUnderlay};

#[test]
fn reports_the_adapter_the_underlay_path_used() {
    let compositor = compositor!();
    let profile = compositor.adapter();
    eprintln!(
        "UNDERLAY ADAPTER: name={:?} backend={} kind={:?} software={}",
        profile.name(),
        profile.backend(),
        profile.kind(),
        profile.kind().is_software()
    );
    assert!(!profile.backend().is_empty());
}

/// The identity crop maps the whole source onto the whole output, so each quadrant colour must
/// arrive in its own corner and none of them may be swapped.
#[test]
fn an_identity_crop_puts_every_source_quadrant_in_its_own_corner() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let frame = compositor
        .render_scene_over(
            &scene,
            &VideoUnderlay::whole(quadrant_source()),
            SILENT_FRAME,
        )
        .expect("a frame inside the timeline composes");

    assert_eq!(
        quadrants(&frame),
        [
            SOURCE_TOP_LEFT,
            SOURCE_TOP_RIGHT,
            SOURCE_BOTTOM_LEFT,
            SOURCE_BOTTOM_RIGHT
        ],
        "the underlay is mirrored, rotated or sampled from the wrong place"
    );
}

/// The alpha rule the encoder depends on: an opaque source leaves no transparency anywhere, with or
/// without a cue on top of it.
#[test]
fn an_opaque_underlay_makes_the_output_fully_opaque() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let video = VideoUnderlay::whole(quadrant_source());

    for index in [SILENT_FRAME, HOLD_FRAME] {
        let frame = compositor
            .render_scene_over(&scene, &video, index)
            .expect("composition succeeds");
        let transparent = frame
            .pixels()
            .chunks_exact(4)
            .filter(|pixel| pixel[3] != 255)
            .count();
        assert_eq!(
            transparent, 0,
            "frame {index} left {transparent} pixels not fully opaque over an opaque source"
        );
    }
}

/// Crop for real, for the first time in this product: a region inside one quadrant must fill the
/// whole output with that quadrant's colour and nothing else.
#[test]
fn a_crop_selects_the_requested_source_region() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    // Two percent inside each quadrant, so no output pixel samples across a quadrant boundary.
    let cases = [
        (2.0_f64, 2.0_f64, SOURCE_TOP_LEFT),
        (52.0, 2.0, SOURCE_TOP_RIGHT),
        (2.0, 52.0, SOURCE_BOTTOM_LEFT),
        (52.0, 52.0, SOURCE_BOTTOM_RIGHT),
    ];
    for (x, y, expected) in cases {
        let video = underlay(&CropSpec {
            x,
            y,
            width: 46.0,
            height: 46.0,
            ..CropSpec::default()
        });
        let frame = compositor
            .render_scene_over(&scene, &video, SILENT_FRAME)
            .expect("composition succeeds");

        let wrong = frame
            .pixels()
            .chunks_exact(4)
            .filter(|pixel| *pixel != expected)
            .count();
        assert_eq!(
            wrong, 0,
            "a crop at ({x}, {y}) must fill the frame with {expected:?}, but {wrong} pixels differ"
        );
    }
}

/// Flip is a sampling transform on the cropped region, so it must be an exact mirror of the frame
/// rather than an approximate re-render, and it must move the named quadrants.
#[test]
fn flip_x_mirrors_the_frame_horizontally() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let plain = compositor
        .render_scene_over(&scene, &underlay(&CropSpec::default()), SILENT_FRAME)
        .expect("composition succeeds");
    let flipped = compositor
        .render_scene_over(
            &scene,
            &underlay(&CropSpec {
                flip_x: true,
                ..CropSpec::default()
            }),
            SILENT_FRAME,
        )
        .expect("composition succeeds");

    assert_eq!(
        quadrants(&flipped),
        [
            SOURCE_TOP_RIGHT,
            SOURCE_TOP_LEFT,
            SOURCE_BOTTOM_RIGHT,
            SOURCE_BOTTOM_LEFT
        ],
        "flipX must swap the left and right quadrants and leave the rows alone"
    );
    assert_eq!(
        flipped.pixels(),
        mirrored_horizontally(&plain),
        "flipX must be an exact column reversal"
    );
}

#[test]
fn flip_y_mirrors_the_frame_vertically() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let plain = compositor
        .render_scene_over(&scene, &underlay(&CropSpec::default()), SILENT_FRAME)
        .expect("composition succeeds");
    let flipped = compositor
        .render_scene_over(
            &scene,
            &underlay(&CropSpec {
                flip_y: true,
                ..CropSpec::default()
            }),
            SILENT_FRAME,
        )
        .expect("composition succeeds");

    assert_eq!(
        quadrants(&flipped),
        [
            SOURCE_BOTTOM_LEFT,
            SOURCE_BOTTOM_RIGHT,
            SOURCE_TOP_LEFT,
            SOURCE_TOP_RIGHT
        ],
        "flipY must swap the top and bottom quadrants and leave the columns alone"
    );
    assert_eq!(
        flipped.pixels(),
        mirrored_vertically(&plain),
        "flipY must be an exact row reversal"
    );
}

/// Both flips together are the 180-degree case, which is the one a per-axis sign error still gets
/// right on one axis and wrong on the other.
#[test]
fn both_flips_together_are_the_180_degree_case() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let plain = compositor
        .render_scene_over(&scene, &underlay(&CropSpec::default()), SILENT_FRAME)
        .expect("composition succeeds");
    let turned = compositor
        .render_scene_over(
            &scene,
            &underlay(&CropSpec {
                flip_x: true,
                flip_y: true,
                ..CropSpec::default()
            }),
            SILENT_FRAME,
        )
        .expect("composition succeeds");

    assert_eq!(
        quadrants(&turned),
        [
            SOURCE_BOTTOM_RIGHT,
            SOURCE_BOTTOM_LEFT,
            SOURCE_TOP_RIGHT,
            SOURCE_TOP_LEFT
        ],
        "both flips must move every quadrant to the diagonally opposite corner"
    );
    assert_eq!(
        turned.pixels(),
        rotated_180(&plain),
        "both flips must be an exact 180-degree turn of the unflipped frame"
    );
}
