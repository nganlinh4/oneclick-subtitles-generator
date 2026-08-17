//! Composing a document that was baked into more than one atlas page.
//!
//! One atlas holds a bounded number of distinct cells, which a CJK, Korean or emoji-heavy document
//! exhausts, so such a document is baked into several pages and each cue records the page it belongs
//! to. [`osg_scene::cues::active_cue_at`] selects exactly one cue per frame, so exactly one page is
//! bound per frame — and the claim these tests exist to check is that it is the *right* one.
//!
//! The evidence is byte equality rather than a shape check. Each cue of the two-page scene is
//! compared against a scene in which that cue's page is the **only** page: same window, same run,
//! same style. If the compositor resolved the wrong page — or bound one page's texture while placing
//! another page's cells — the fixture pages differ enough that the frame cannot come out the same.
//!
//! Every test skips loudly when no GPU adapter exists, so a green run on an adapter-less machine is
//! never mistaken for a verified one.

mod common;

use common::frames::compositor;
use common::ink::inked;
use common::{
    FAMILY, HOLD_FRAME, SECOND_CUE_FRAME, WEIGHT, aligned_atlas, layout_align, second_page, staged,
    staged_one_page, staged_two_pages, style_spec,
};
use osg_compositor::{Compositor, Frame, SubtitleScene, SubtitleStyleSpec};

/// No background box, so every pixel on screen came from a glyph cell and nothing else can account
/// for a difference between two frames.
fn glyphs_only() -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        background_opacity: 0.0,
        ..style_spec()
    }
}

fn render(scene: &SubtitleScene, compositor: &Compositor, frame: u32) -> Frame {
    compositor
        .render_scene(scene, frame)
        .expect("the fixture scene composes at every frame of its own timeline")
}

/// Cue zero draws page zero's cells and cue one draws page one's — each exactly as it would if its
/// own page were the only one staged.
#[test]
fn each_cue_draws_from_its_own_page() {
    let compositor = compositor!();
    let spec = glyphs_only();
    let align = layout_align(&spec);
    let two = staged_two_pages(&spec);

    let first_alone = staged_one_page(&spec, aligned_atlas(FAMILY, WEIGHT, align), (1, 2));
    let second_alone = staged_one_page(&spec, second_page(FAMILY, WEIGHT, align), (2, 3));

    let first = render(&two, &compositor, HOLD_FRAME);
    let second = render(&two, &compositor, SECOND_CUE_FRAME);

    assert_eq!(
        first.pixels(),
        render(&first_alone, &compositor, HOLD_FRAME).pixels(),
        "the first cue must draw what page zero alone draws"
    );
    assert_eq!(
        second.pixels(),
        render(&second_alone, &compositor, SECOND_CUE_FRAME).pixels(),
        "the second cue must draw what page one alone draws"
    );

    // The discriminating half: the two pages really do draw differently, so the equalities above
    // could not both have held by accident. Page zero's cell is an 8x8 block and page one's is 4x4,
    // and the ink counts follow the cells.
    assert!(inked(&first) > 0 && inked(&second) > 0, "both cues drew");
    assert!(
        inked(&first) > inked(&second) * 2,
        "the fixture pages must differ enough for a wrong page to be visible: {} against {}",
        inked(&first),
        inked(&second),
    );
    assert_ne!(first.pixels(), second.pixels());
}

/// A scene with one page composes exactly what it composed before pages existed.
///
/// The single-page case is every Latin document and the whole of the preview, so it is the case that
/// must not have moved. Proven rather than asserted: the one-page scene the rest of the suite uses
/// and a two-page scene's first cue land on the same bytes, and the frames a one-page scene draws do
/// not depend on how many pages are beside it.
#[test]
fn a_single_page_scene_is_unchanged_by_the_page_machinery() {
    let compositor = compositor!();
    let spec = glyphs_only();
    let one = staged(&spec);
    let one_of_two = staged_one_page(
        &spec,
        aligned_atlas(FAMILY, WEIGHT, layout_align(&spec)),
        (1, 2),
    );

    for frame in [HOLD_FRAME, 30, 59] {
        assert_eq!(
            render(&one, &compositor, frame).pixels(),
            render(&one_of_two, &compositor, frame).pixels(),
            "frame {frame} of a one-page scene must not depend on how it was staged"
        );
    }
}

/// A frame between cues resolves no page at all, and still composes: an empty subtitle layer rather
/// than a refusal, exactly as a one-page scene's silent frames do.
#[test]
fn a_frame_with_no_cue_composes_from_a_two_page_scene() {
    let compositor = compositor!();
    let silent = render(&staged_two_pages(&glyphs_only()), &compositor, 0);
    assert_eq!(inked(&silent), 0, "no cue is visible at the first frame");
}
