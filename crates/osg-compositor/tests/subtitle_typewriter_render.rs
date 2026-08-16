//! The typewriter reveal, composed against a real adapter.
//!
//! The reveal is the one animation that is not a transform, so it is the one that has to be proven
//! at the pixels: a frame part-way through must differ from an empty one and from a finished one,
//! the sequence must never go backwards, and the two documented decisions — cut at a cluster
//! boundary, measure the laid-out run — must be visible rather than merely written down.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr.

mod common;

use common::frames::compositor;
use common::ink::inked;
use common::{
    FAMILY, HOLD_FRAME, INK_CELL, WEIGHT, atlas, baked_line, scene, staged_with_run, style,
    style_spec,
};
use osg_compositor::{Compositor, CueRun, Frame, SubtitleScene, SubtitleStyleSpec};
use osg_scene::glyph::GlyphAtlasDescriptor;

/// Frames inside the fixture cue's fade-in window, which opens at 0.7s and closes at 1.0s.
///
/// The reveal is proportional to the raw fade progress, so each of these is a different number of
/// revealed cells out of four: 0, 1, 2 and 3.
const NOTHING_REVEALED: u32 = 22;
const ONE_REVEALED: u32 = 25;
const TWO_REVEALED: u32 = 27;
const THREE_REVEALED: u32 = 29;

/// A four-cell run, wide enough apart that each cell's ink is its own block of pixels.
fn four_cells() -> CueRun {
    CueRun::single_line(baked_line(0, &[INK_CELL, INK_CELL, INK_CELL, INK_CELL]))
}

fn typing(fade_in: f64) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        animation: "typewriter".to_owned(),
        text_align: "left".to_owned(),
        background_opacity: 0.0,
        fade_in,
        ..style_spec()
    }
}

fn render(scene: &SubtitleScene, compositor: &Compositor, frame_index: u32) -> Frame {
    compositor
        .render_scene(scene, frame_index)
        .expect("composition succeeds")
}

#[test]
fn the_reveal_is_progressive_and_reaches_nothing_and_everything() {
    let compositor = compositor!();
    let scene = staged_with_run(&typing(0.3), four_cells());

    let counts: Vec<usize> = [
        NOTHING_REVEALED,
        ONE_REVEALED,
        TWO_REVEALED,
        THREE_REVEALED,
        HOLD_FRAME,
    ]
    .into_iter()
    .map(|frame| inked(&render(&scene, &compositor, frame)))
    .collect();

    assert_eq!(
        counts[0], 0,
        "nothing is revealed at the start of the window"
    );
    for window in counts.windows(2) {
        assert!(
            window[1] > window[0],
            "the reveal must grow, got {counts:?} cell coverages"
        );
    }

    // A partly typed frame is neither of the two frames it sits between.
    let partial = render(&scene, &compositor, TWO_REVEALED);
    let empty = render(&scene, &compositor, NOTHING_REVEALED);
    let full = render(&scene, &compositor, HOLD_FRAME);
    assert_ne!(partial.pixels(), empty.pixels());
    assert_ne!(partial.pixels(), full.pixels());
}

/// The reveal has to be the *animation*, not the fade: the same frame with the animation off draws
/// the whole run.
#[test]
fn only_the_typewriter_trims_the_run() {
    let compositor = compositor!();
    let typed = staged_with_run(&typing(0.3), four_cells());
    let whole = staged_with_run(
        &SubtitleStyleSpec {
            animation: "none".to_owned(),
            ..typing(0.3)
        },
        four_cells(),
    );

    assert!(
        inked(&render(&typed, &compositor, TWO_REVEALED))
            < inked(&render(&whole, &compositor, TWO_REVEALED)),
        "mid-fade, a typed cue must show less than an untyped one"
    );
    assert_eq!(
        render(&typed, &compositor, HOLD_FRAME).pixels(),
        render(&whole, &compositor, HOLD_FRAME).pixels(),
        "once the cue is holding, the typewriter is finished and the two agree"
    );
}

/// The shipped no-op, reproduced structurally: with no fade-in window there is no fading-in phase,
/// so `typewriter` types nothing and the cue simply appears.
#[test]
fn a_cue_with_no_fade_in_window_never_types() {
    let compositor = compositor!();
    let typed = staged_with_run(&typing(0.0), four_cells());
    let whole = staged_with_run(
        &SubtitleStyleSpec {
            animation: "none".to_owned(),
            ..typing(0.0)
        },
        four_cells(),
    );

    // 1.0s exactly, which is the cue's own start and the first frame it can be visible at.
    for frame in [30, HOLD_FRAME] {
        assert_eq!(
            render(&typed, &compositor, frame).pixels(),
            render(&whole, &compositor, frame).pixels(),
            "at fadeInDuration 0 the typewriter is a no-op, as shipped"
        );
        assert!(inked(&render(&typed, &compositor, frame)) > 0);
    }
}

/// The documented decision: the reveal counts UTF-16 code units, as the shipped renderer does, but
/// draws whole clusters. A cluster whose second code unit has not been reached is not drawn at all,
/// where the shipped renderer would have drawn half a surrogate pair.
#[test]
fn an_astral_cluster_appears_only_once_both_of_its_code_units_are_revealed() {
    let compositor = compositor!();
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.glyphs[1].cluster = "\u{1f600}".to_owned();
    unchecked.glyphs[1].code_points = vec![0x1_f600];
    unchecked.layout.lines[0].glyphs = vec![1];
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("an astral bake");

    // Two clusters, four UTF-16 code units.
    let scene = SubtitleScene::new(
        scene(FAMILY, WEIGHT),
        atlas,
        style(&typing(0.3)),
        vec![CueRun::single_line(baked_line(0, &[INK_CELL, INK_CELL]))],
    )
    .expect("the astral fixture stages");

    // One code unit revealed: half of the first cluster, which is half of nothing drawable.
    assert_eq!(
        inked(&render(&scene, &compositor, ONE_REVEALED)),
        0,
        "a cluster is drawn whole or not at all"
    );
    // Two: the first cluster, complete.
    let one = inked(&render(&scene, &compositor, TWO_REVEALED));
    assert!(one > 0, "both code units of the first cluster are revealed");
    assert!(
        one < inked(&render(&scene, &compositor, HOLD_FRAME)),
        "and the second cluster is still to come"
    );
}

/// Determinism survives the new path: the reveal is a pure function of the frame's own time, so
/// seeking to a frame and playing up to it are the same bytes.
#[test]
fn seek_equals_play_through_a_reveal() {
    let compositor = compositor!();
    let scene = staged_with_run(&typing(0.3), four_cells());

    let mut played = None;
    for index in 0..=TWO_REVEALED {
        played = Some(render(&scene, &compositor, index));
    }
    let played = played.expect("the loop rendered at least one frame");

    let fresh = Compositor::new().expect("a second device on a working adapter");
    let sought = render(&scene, &fresh, TWO_REVEALED);

    assert_eq!(
        played.pixels(),
        sought.pixels(),
        "a partly typed frame must not depend on what was rendered before it"
    );
    assert_eq!(
        render(&scene, &compositor, TWO_REVEALED).pixels(),
        sought.pixels(),
        "and the same frame must be byte-identical twice"
    );
}

/// The run the atlas itself lays out is the ordinary staging path, and it types too.
#[test]
fn the_atlas_layout_run_types_as_well() {
    let compositor = compositor!();
    let scene = staged_with_run(
        &typing(0.3),
        CueRun::from_layout(atlas(FAMILY, WEIGHT).layout()),
    );

    assert_eq!(inked(&render(&scene, &compositor, NOTHING_REVEALED)), 0);
    assert!(inked(&render(&scene, &compositor, HOLD_FRAME)) > 0);
}
