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
    BASELINE_PX, FAMILY, HOLD_FRAME, INK_CELL, WEIGHT, atlas, baked_line, scene, staged_with_atlas,
    staged_with_run, style, style_spec,
};
use osg_compositor::{
    AtlasPages, Compositor, CueLine, CueRun, Frame, SubtitleScene, SubtitleStyleSpec,
};
use osg_scene::glyph::{AtlasGlyph, Direction, GlyphAtlasDescriptor};

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

/// The four positional forms one cursive letter takes, spelled the way `glyphAtlasCells.js` spells
/// them: the bare cluster, the cluster asking to join onwards, the cluster asking to join backwards,
/// and the cluster asking for both. Listed in the baker's cluster order — strictly increasing by
/// UTF-16 code unit — because that is the order the descriptor is validated in.
///
/// Each is **one letter** of source text and one, two or three UTF-16 code units of cell text, which
/// is the entire difference [`a_joined_run_reveals_one_letter_at_a_time`] exists to catch.
const ISOLATED: &str = "\u{628}";
const INITIAL: &str = "\u{628}\u{200d}";
const FINAL: &str = "\u{200d}\u{628}";
const MEDIAL: &str = "\u{200d}\u{628}\u{200d}";

/// A Latin control with the same shape: four distinct cells, none of which is spelled with a joiner.
const LATIN: [&str; 4] = ["A", "B", "C", "D"];

/// One emoji ZWJ sequence — man, woman, boy — which is a single grapheme cluster of eight UTF-16
/// code units, two of which are joiners the user did type.
const FAMILY_EMOJI: &str = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f466}";

/// Frames from just inside the fixture cue's fade-in window to its last frame.
///
/// The window opens at 0.7s and the cue starts at 1.0s, so frame `f` is at progress `(f - 21) / 9`.
const REVEAL_FRAMES: core::ops::RangeInclusive<u32> = 22..=29;

/// How many of the four letters the source text has revealed at each of [`REVEAL_FRAMES`]:
/// `floor(4 * progress)`, which is what the shipped `text.substring` reaches on four characters.
const REVEALED_LETTERS: [usize; 8] = [0, 0, 1, 1, 2, 2, 3, 3];

/// What counting the *cell* text would have produced instead: eight units rather than four, spread
/// 1, 2, 3, 2 across the run, so two of the eight frames reveal a letter early.
const REVEALED_IF_JOINERS_COUNTED: [usize; 8] = [0, 1, 1, 2, 2, 2, 3, 3];

/// An atlas whose cells are spelled as given, all inked and all classified `direction`.
///
/// Every cell reuses the fixture's own inked cell, so the geometry is the fixture's and only the
/// cluster text — the thing under test — differs between the joined atlas and the Latin one.
fn spelled_atlas(clusters: &[&str], direction: Direction) -> GlyphAtlasDescriptor {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    let inked_cell = unchecked.glyphs[usize::try_from(INK_CELL).expect("a cell index")].clone();
    unchecked.metrics.base_direction = direction;
    unchecked.atlas.glyph_count = u32::try_from(clusters.len()).expect("a cell count");
    unchecked.glyphs = clusters
        .iter()
        .map(|cluster| AtlasGlyph {
            cluster: (*cluster).to_owned(),
            code_points: cluster.chars().map(u32::from).collect(),
            direction,
            ..inked_cell.clone()
        })
        .collect();
    GlyphAtlasDescriptor::try_from(unchecked).expect("a bake the baker could have made")
}

/// The four cells in draw order — isolated, initial, medial, final — far enough apart that each
/// one's ink is a separate group of columns and [`drawn_cells`] can simply count them.
fn positional_run() -> CueRun {
    CueRun::single_line(CueLine::new(
        vec![0, 1, 3, 2],
        vec![0.0, 16.0, 32.0, 48.0],
        64.0,
        BASELINE_PX,
    ))
}

/// How many of the run's cells drew, counted as separated groups of inked columns.
fn drawn_cells(frame: &Frame) -> usize {
    let mut cells = 0_usize;
    let mut inside = false;
    for x in 0..frame.width() {
        let ink = (0..frame.height()).any(|y| frame.pixel(x, y).is_some_and(|pixel| pixel[3] > 0));
        cells += usize::from(ink && !inside);
        inside = ink;
    }
    cells
}

/// The reveal over [`REVEAL_FRAMES`], in cells.
fn reveal_sequence(scene: &SubtitleScene, compositor: &Compositor) -> Vec<usize> {
    REVEAL_FRAMES
        .map(|frame| drawn_cells(&render(scene, compositor, frame)))
        .collect()
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
        AtlasPages::single(atlas, 1),
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

/// A cursive run types one **letter** at a time, not one joiner at a time.
///
/// On the contextual path a cell is rasterized from the canonical spelling of the form the run gives
/// a cluster, so a medial letter's cell text is `ZWJ letter ZWJ` where the source text has one
/// letter. Counting the cell text made this four-letter run eight units long and revealed two of its
/// letters a frame early — on exactly the scripts contextual cells were added for. The Latin control
/// is the same run with the same geometry and no joiners anywhere, and it must not move.
#[test]
fn a_joined_run_reveals_one_letter_at_a_time() {
    let compositor = compositor!();
    let joined = staged_with_atlas(
        &typing(0.3),
        spelled_atlas(&[ISOLATED, INITIAL, FINAL, MEDIAL], Direction::Rtl),
        positional_run(),
    );
    let latin = staged_with_atlas(
        &typing(0.3),
        spelled_atlas(&LATIN, Direction::Ltr),
        positional_run(),
    );

    let joined_reveal = reveal_sequence(&joined, &compositor);
    assert_eq!(
        joined_reveal, REVEALED_LETTERS,
        "a joined run must reveal its letters when the source text reaches them"
    );
    assert_ne!(
        joined_reveal, REVEALED_IF_JOINERS_COUNTED,
        "and counting the context joiners is a different sequence, so this test discriminates"
    );
    assert_eq!(
        reveal_sequence(&latin, &compositor),
        REVEALED_LETTERS,
        "the Latin control is unchanged: it never carried a joiner to strip"
    );
}

/// The stripping is exact rather than a trim: a joiner *inside* a cluster is the cluster's own
/// content and still counts.
///
/// Both cells here are the same family emoji — one grapheme cluster, eight UTF-16 units, two of them
/// joiners the user typed — and the second is additionally spelled with a context joiner on each
/// side. Eight units each makes sixteen, so the first cell finishes at half the reveal; stripping
/// the interior joiners too, or leaving the outer ones in, moves that instant.
#[test]
fn a_clusters_own_joiners_are_interior_and_still_count() {
    let compositor = compositor!();
    let joined_family = format!("\u{200d}{FAMILY_EMOJI}\u{200d}");
    // Cluster order is the baker's, so the joined spelling — which starts with U+200D — sorts first.
    let atlas = spelled_atlas(&[joined_family.as_str(), FAMILY_EMOJI], Direction::Ltr);
    let scene = staged_with_atlas(
        &typing(0.3),
        atlas,
        // Drawn bare first, joined second, so the joined cell's two extra units would land inside
        // the window rather than past its end.
        CueRun::single_line(CueLine::new(vec![1, 0], vec![0.0, 16.0], 32.0, BASELINE_PX)),
    );

    // Progress 4/9 reaches unit 7 of 16: not yet the whole first cluster. Counting the context
    // joiners would make the run eighteen units and this frame reveal it.
    assert_eq!(drawn_cells(&render(&scene, &compositor, 25)), 0);
    // Progress 5/9 reaches unit 8: the first cluster exactly, and no more.
    assert_eq!(drawn_cells(&render(&scene, &compositor, 26)), 1);
    assert_eq!(drawn_cells(&render(&scene, &compositor, HOLD_FRAME)), 2);
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
