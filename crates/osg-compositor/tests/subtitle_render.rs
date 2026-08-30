//! Composing real subtitle frames against a real adapter.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.
//!
//! The property these exist for is the one the whole migration turns on: **seek equals play**.
//! Rendering frame `n` directly must be byte-identical to rendering it after frames `0..n`, because
//! the editor seeks and the export plays, and if those disagree the two surfaces disagree.

mod common;

use common::{
    FADING_FRAME, HEIGHT, HOLD_FRAME, INK_CELL, SILENT_FRAME, SPACE_CELL, WIDTH, baked, baked_run,
    staged, staged_with_run, style_spec,
};
use osg_compositor::{Compositor, CompositorError, Frame, SubtitleStyleSpec};

fn adapter() -> Option<Compositor> {
    match Compositor::new() {
        Ok(compositor) => Some(compositor),
        Err(CompositorError::NoAdapter { reason }) => {
            eprintln!(
                "SKIPPED: no GPU adapter in this environment ({reason}). \
                 Subtitle composition was NOT verified by this run."
            );
            None
        }
        Err(error) => panic!("the adapter was present but the compositor failed: {error}"),
    }
}

macro_rules! compositor {
    () => {
        match adapter() {
            Some(compositor) => compositor,
            None => return,
        }
    };
}

/// How many pixels carry any coverage at all.
fn inked(frame: &Frame) -> usize {
    frame.pixels().chunks_exact(4).filter(|p| p[3] > 0).count()
}

fn maximum_alpha(frame: &Frame) -> u8 {
    frame
        .pixels()
        .chunks_exact(4)
        .map(|pixel| pixel[3])
        .max()
        .unwrap_or(0)
}

/// The mean row of the inked pixels, or `None` when nothing was drawn.
fn ink_centre_y(frame: &Frame) -> Option<f64> {
    let mut total = 0.0_f64;
    let mut count = 0.0_f64;
    for y in 0..frame.height() {
        for x in 0..frame.width() {
            if frame.pixel(x, y).is_some_and(|pixel| pixel[3] > 0) {
                total += f64::from(y);
                count += 1.0;
            }
        }
    }
    (count > 0.0).then(|| total / count)
}

/// The leftmost inked column, or the frame width when nothing was drawn.
fn ink_left_edge(frame: &Frame) -> u32 {
    for x in 0..frame.width() {
        for y in 0..frame.height() {
            if frame.pixel(x, y).is_some_and(|pixel| pixel[3] > 0) {
                return x;
            }
        }
    }
    frame.width()
}

#[test]
fn reports_the_adapter_the_subtitle_path_used() {
    let compositor = compositor!();
    let profile = compositor.adapter();
    eprintln!(
        "SUBTITLE ADAPTER: name={:?} backend={} kind={:?} software={}",
        profile.name(),
        profile.backend(),
        profile.kind(),
        profile.kind().is_software()
    );
    assert!(!profile.backend().is_empty());
}

#[test]
fn a_scene_frame_reads_back_at_the_scene_size() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let frame = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("a frame inside the timeline composes");

    assert_eq!(frame.width(), WIDTH);
    assert_eq!(frame.height(), HEIGHT);
    assert_eq!(
        u64::try_from(frame.pixels().len()).ok(),
        Some(scene.size().rgba8_len()),
        "the readback must be tightly packed RGBA8"
    );
}

/// The golden property: identical inputs give byte-identical output.
#[test]
fn the_same_frame_renders_byte_identically_twice() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let first = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");
    let second = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        first.pixels(),
        second.pixels(),
        "the same scene at the same frame must be byte-identical"
    );
}

/// Seek equals play. The frame the editor jumps to and the frame the export walks to must be the
/// same bytes, and nothing rendered before either one may change it.
#[test]
fn seeking_to_a_frame_equals_playing_up_to_it() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let mut played = None;
    for index in 0..=HOLD_FRAME {
        played = Some(
            compositor
                .render_scene(&scene, index)
                .expect("composition succeeds"),
        );
    }
    let played = played.expect("the loop rendered at least one frame");

    let fresh = Compositor::new().expect("a second device on a working adapter");
    let sought = fresh
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        played.pixels(),
        sought.pixels(),
        "rendering frame {HOLD_FRAME} after 0..{HOLD_FRAME} must equal seeking straight to it"
    );
}

/// Playing forwards and playing backwards must agree frame for frame, which is the same guarantee
/// stated over a whole range rather than one index.
#[test]
fn playing_backwards_reproduces_every_frame() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let range = 20..=30;

    let forwards: Vec<_> = range
        .clone()
        .map(|index| {
            compositor
                .render_scene(&scene, index)
                .expect("composition succeeds")
        })
        .collect();
    let mut backwards: Vec<_> = range
        .rev()
        .map(|index| {
            compositor
                .render_scene(&scene, index)
                .expect("composition succeeds")
        })
        .collect();
    backwards.reverse();

    for (index, (forward, backward)) in forwards.iter().zip(&backwards).enumerate() {
        assert_eq!(
            forward.pixels(),
            backward.pixels(),
            "frame {} disagreed between forward and reverse playback",
            20 + index
        );
    }
}

/// A frame with no active cue is a transparent overlay, not a black one.
#[test]
fn a_frame_with_no_cue_is_empty_and_differs_from_one_with_a_cue() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let silent = compositor
        .render_scene(&scene, SILENT_FRAME)
        .expect("composition succeeds");
    let held = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        silent.pixels().iter().all(|byte| *byte == 0),
        "an overlay frame with no cue must be fully transparent"
    );
    assert_ne!(
        silent.pixels(),
        held.pixels(),
        "a cue must reach the pixels"
    );
    assert!(inked(&held) > 0, "the cue frame must carry coverage");
}

#[test]
fn opacity_zero_produces_no_visible_cue() {
    let compositor = compositor!();
    let visible = staged(&style_spec());
    let invisible = staged(&SubtitleStyleSpec {
        opacity: 0.0,
        ..style_spec()
    });

    let silent = compositor
        .render_scene(&visible, SILENT_FRAME)
        .expect("composition succeeds");
    let hidden = compositor
        .render_scene(&invisible, HOLD_FRAME)
        .expect("composition succeeds");
    let shown = compositor
        .render_scene(&visible, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        hidden.pixels(),
        silent.pixels(),
        "a zero-opacity cue must be exactly as absent as no cue at all"
    );
    assert_ne!(
        hidden.pixels(),
        shown.pixels(),
        "the same frame at full opacity must differ"
    );
}

/// The atlas cell's ink lives in the right half of the texture, so drawing it at all proves the
/// cell rectangle reached the sampler as more than a guess.
#[test]
fn the_glyph_cell_is_drawn_from_the_atlas() {
    let compositor = compositor!();
    // No background, so every inked pixel came from the atlas rather than the box.
    let scene = staged(&SubtitleStyleSpec {
        background_opacity: 0.0,
        ..style_spec()
    });

    let frame = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    let opaque_white = frame
        .pixels()
        .chunks_exact(4)
        .filter(|pixel| *pixel == [255, 255, 255, 255])
        .count();
    assert!(
        opaque_white > 0,
        "the opaque interior of the glyph cell must survive to the frame, got {} inked pixels",
        inked(&frame)
    );
}

/// Layout comes from `osg-scene`, and this is the cheapest proof that it reaches the pixels: the
/// same cue anchored top and bottom must land in different halves of the composition.
#[test]
fn the_anchor_position_moves_the_cue() {
    let compositor = compositor!();
    let bottom = staged(&style_spec());
    let top = staged(&SubtitleStyleSpec {
        position: "top".to_owned(),
        ..style_spec()
    });

    let bottom_frame = compositor
        .render_scene(&bottom, HOLD_FRAME)
        .expect("composition succeeds");
    let top_frame = compositor
        .render_scene(&top, HOLD_FRAME)
        .expect("composition succeeds");

    let bottom_centre = ink_centre_y(&bottom_frame).expect("the bottom cue drew something");
    let top_centre = ink_centre_y(&top_frame).expect("the top cue drew something");
    assert!(
        bottom_centre > f64::from(HEIGHT) / 2.0,
        "a bottom-anchored cue must sit below the middle, got {bottom_centre}"
    );
    assert!(
        top_centre < f64::from(HEIGHT) / 2.0,
        "a top-anchored cue must sit above the middle, got {top_centre}"
    );
}

/// The cue transform is `osg-scene`'s, and it has to reach the geometry: the same instant with a
/// slide animation must not be the same picture as with none.
#[test]
fn the_cue_transform_reaches_the_pixels() {
    let compositor = compositor!();
    let still = staged(&style_spec());
    let sliding = staged(&SubtitleStyleSpec {
        animation: "slide-up".to_owned(),
        ..style_spec()
    });

    let still_fading = compositor
        .render_scene(&still, FADING_FRAME)
        .expect("composition succeeds");
    let slid = compositor
        .render_scene(&sliding, FADING_FRAME)
        .expect("composition succeeds");
    let still_held = compositor
        .render_scene(&still, HOLD_FRAME)
        .expect("composition succeeds");
    let slid_held = compositor
        .render_scene(&sliding, HOLD_FRAME)
        .expect("composition succeeds");

    assert_ne!(
        still_fading.pixels(),
        slid.pixels(),
        "mid-fade, a slide must displace the cue"
    );
    assert_eq!(
        still_held.pixels(),
        slid_held.pixels(),
        "while holding, a slide carries no transform, so the two must agree"
    );
}

/// The fade window widens a cue's visibility, and the eased progress must reach the alpha: a frame
/// inside the fade-in must be drawn, and must differ from the held frame.
#[test]
fn the_fade_window_is_visible_before_the_cue_starts() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let fading = compositor
        .render_scene(&scene, FADING_FRAME)
        .expect("composition succeeds");
    let held = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        inked(&fading) > 0,
        "the cue must already be on screen inside its fade-in window"
    );
    assert_ne!(
        fading.pixels(),
        held.pixels(),
        "a partly faded cue must not be identical to a held one"
    );
}

/// Magnitude belongs at the renderer boundary, where it is deterministic. A screenshot oracle that
/// averages only pixels above a difference threshold is nonlinear in opacity: dim pixels leave its
/// denominator, so a correct one-third fade can look 1.5x or more too strong. The opaque interior
/// of this fixture's atlas cell has no such ambiguity and pins the actual UNORM output byte.
#[test]
fn eased_and_flat_opacity_reach_the_exact_output_alpha() {
    let compositor = compositor!();
    let linear = SubtitleStyleSpec {
        background_opacity: 0.0,
        easing: "linear".to_owned(),
        ..style_spec()
    };
    let half = SubtitleStyleSpec {
        opacity: 0.5,
        ..linear.clone()
    };

    let fading = compositor
        .render_scene(&staged(&linear), FADING_FRAME)
        .expect("one-third fade composes");
    let held = compositor
        .render_scene(&staged(&linear), HOLD_FRAME)
        .expect("held cue composes");
    let half_held = compositor
        .render_scene(&staged(&half), HOLD_FRAME)
        .expect("half-opacity cue composes");

    assert_eq!(maximum_alpha(&fading), 85, "one-third linear fade");
    assert_eq!(maximum_alpha(&held), 255, "fully held cue");
    assert_eq!(maximum_alpha(&half_held), 128, "half flat opacity");
}

/// A second line must lower the ink, and a blank cell in front of the glyph must push it right by
/// the pen the layout gave it. The placement is the layout's; what is under test here is that the
/// compositor reaches every line and every cell of a run.
#[test]
fn every_line_and_every_cell_of_a_run_is_placed() {
    let compositor = compositor!();
    // Centred alignment would re-centre a wider line and hide the horizontal offset.
    let spec = SubtitleStyleSpec {
        text_align: "left".to_owned(),
        background_opacity: 0.0,
        ..style_spec()
    };
    let one_line = staged_with_run(&spec, baked(&[INK_CELL]));
    let two_lines = staged_with_run(&spec, baked_run(&[&[INK_CELL], &[INK_CELL]]));
    let indented = staged_with_run(&spec, baked(&[SPACE_CELL, INK_CELL]));

    let single = compositor
        .render_scene(&one_line, HOLD_FRAME)
        .expect("composition succeeds");
    let stacked = compositor
        .render_scene(&two_lines, HOLD_FRAME)
        .expect("composition succeeds");
    let shifted = compositor
        .render_scene(&indented, HOLD_FRAME)
        .expect("composition succeeds");

    assert!(
        inked(&stacked) > inked(&single),
        "a second line must add coverage: {} vs {}",
        inked(&stacked),
        inked(&single)
    );
    assert_eq!(
        inked(&shifted),
        inked(&single),
        "a blank cell inks nothing, so the coverage must be unchanged"
    );
    assert!(
        ink_left_edge(&shifted) > ink_left_edge(&single),
        "the blank cell's advance must move the pen right"
    );
}

#[test]
fn a_frame_outside_the_timeline_is_refused() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let error = compositor
        .render_scene(&scene, scene.frame_count())
        .expect_err("one past the last frame is not in the timeline");
    assert!(
        matches!(
            error,
            CompositorError::FrameOutOfRange {
                index,
                frame_count,
            } if index == scene.frame_count() && frame_count == scene.frame_count()
        ),
        "unexpected error: {error}"
    );
}
