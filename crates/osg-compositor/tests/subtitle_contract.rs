//! What the compositor refuses before it allocates anything. No GPU is involved, so these run on
//! every machine.

mod common;

use common::{
    BASELINE_PX, FAMILY, INK_CELL, LINE_HEIGHT_PX, SPACE_CELL, WEIGHT, atlas, baked, baked_line,
    baked_run, layout_align, scene, second_page, staged, style, style_spec, two_cue_scene,
};
use osg_compositor::{
    AtlasPages, CompositorError, CueLine, CueRun, Rejection, SubtitleScene, SubtitleStyle,
    SubtitleStyleSpec, TextureTarget,
};
use osg_scene::color::Rgba;
use osg_scene::glyph::{CellAdvanceVerdict, Direction, GlyphAtlasDescriptor, MAX_ATLAS_PAGES};

fn rejection(error: &CompositorError) -> Rejection {
    match error {
        CompositorError::UnsupportedSceneInput { reason } => *reason,
        other => panic!("expected a staged-input refusal, got: {other}"),
    }
}

fn stage(atlas: GlyphAtlasDescriptor, runs: Vec<CueRun>) -> Result<SubtitleScene, CompositorError> {
    let cues = scene(FAMILY, WEIGHT).cues().len();
    SubtitleScene::new(
        scene(FAMILY, WEIGHT),
        AtlasPages::single(atlas, cues),
        style(&style_spec()),
        runs,
    )
}

/// The pages of a two-page fixture, in page order.
fn two_pages() -> Vec<GlyphAtlasDescriptor> {
    let align = layout_align(&style_spec());
    vec![
        common::aligned_atlas(FAMILY, WEIGHT, align),
        second_page(FAMILY, WEIGHT, align),
    ]
}

#[test]
fn the_fixture_scene_is_accepted() {
    let staged = staged(&style_spec());
    assert_eq!(staged.frame_count(), common::FRAME_COUNT);
    assert_eq!(staged.size().width(), common::WIDTH);
    assert_eq!(staged.size().height(), common::HEIGHT);
    assert_eq!(staged.runs().len(), staged.scene().cues().len());
}

/// The contract exists so preview and export can be *proven* to have drawn the same glyphs. An
/// atlas baked from another family is exactly what it has to catch.
#[test]
fn an_atlas_baked_from_another_family_is_refused() {
    let error = stage(atlas("Other Face", WEIGHT), vec![baked(&[INK_CELL])])
        .expect_err("an atlas from another family must not be staged");
    assert_eq!(rejection(&error), Rejection::AtlasFaceMismatch);
    assert!(
        error.to_string().contains("resolved face"),
        "the refusal must name what disagreed: {error}"
    );
}

#[test]
fn an_atlas_baked_at_another_weight_is_refused() {
    let error = stage(atlas(FAMILY, 700), vec![baked(&[INK_CELL])])
        .expect_err("an atlas at another weight must not be staged");
    assert_eq!(rejection(&error), Rejection::AtlasFaceMismatch);
}

/// The descriptor's `cell_advance_layout` is a `#[must_use]` verdict, not advice. A right-to-left
/// run the baker could **not** resolve into visual order would be drawn backwards if it were placed
/// in the order given, so the compositor refuses it.
#[test]
fn an_atlas_that_refuses_cell_advance_layout_is_refused() {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.base_direction = Direction::Rtl;
    unchecked.glyphs[1].direction = Direction::Rtl;
    unchecked.layout.refusal.direction_needs_bidi = true;
    unchecked.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("still a valid descriptor");
    assert!(!atlas.cell_advance_layout().reproduces());

    let error = stage(atlas, vec![baked(&[INK_CELL])])
        .expect_err("a right-to-left run the baker could not reorder must not be drawn");
    assert_eq!(rejection(&error), Rejection::AtlasLayoutRefused);
}

/// The same right-to-left run, resolved. The baker says the order it emitted is visual, and the
/// compositor's job is to draw that order rather than to second-guess it from cell directions —
/// which still classify every cell right-to-left.
#[test]
fn an_atlas_whose_right_to_left_run_the_baker_reordered_is_staged() {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.base_direction = Direction::Rtl;
    unchecked.glyphs[1].direction = Direction::Rtl;
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("still a valid descriptor");
    assert!(atlas.cell_advance_layout().reproduces());

    let staged = stage(atlas, vec![baked(&[INK_CELL])])
        .expect("a reordered right-to-left run is one the compositor can draw");
    assert_eq!(staged.runs().len(), 1);
}

/// Shaping that crossed cluster boundaries means the emitted positions do not reproduce the run.
#[test]
fn an_atlas_with_a_shaping_residual_is_refused() {
    let mut unchecked = common::unchecked_atlas(FAMILY, WEIGHT);
    unchecked.metrics.shaping_residual_px = -1.5;
    unchecked.layout.refusal.shaping_crosses_clusters = true;
    unchecked.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    let atlas = GlyphAtlasDescriptor::try_from(unchecked).expect("still a valid descriptor");

    let error = stage(atlas, vec![baked(&[INK_CELL])])
        .expect_err("a run whose ink crossed a cluster boundary must not be drawn from its cells");
    assert_eq!(rejection(&error), Rejection::AtlasLayoutRefused);
}

/// The run is the layout, so a run that could not have come from one is refused before a frame is
/// planned: a pen for every cell, finite positions, and baselines that descend.
#[test]
fn a_run_that_cannot_place_its_glyphs_is_refused() {
    let cases = [
        // A pen position missing, so the compositor would have to invent one.
        CueRun::single_line(CueLine::new(
            vec![INK_CELL, SPACE_CELL],
            vec![0.0],
            10.0,
            BASELINE_PX,
        )),
        // More pens than cells, which is the same disagreement the other way round.
        CueRun::single_line(CueLine::new(
            vec![INK_CELL],
            vec![0.0, 10.0],
            10.0,
            BASELINE_PX,
        )),
        CueRun::single_line(CueLine::new(
            vec![INK_CELL],
            vec![f64::NAN],
            10.0,
            BASELINE_PX,
        )),
        CueRun::single_line(CueLine::new(vec![INK_CELL], vec![0.0], 10.0, f64::INFINITY)),
        // Two lines sharing a baseline: nothing on this side could stack them.
        CueRun::new(vec![
            baked_line(0, &[INK_CELL]),
            CueLine::new(vec![INK_CELL], vec![0.0], 10.0, BASELINE_PX),
        ]),
    ];
    for run in cases {
        let error = stage(atlas(FAMILY, WEIGHT), vec![run])
            .expect_err("a run that cannot place its glyphs is not a staged run");
        assert_eq!(rejection(&error), Rejection::RunGeometry);
    }

    // The same run with its second baseline one line box down is accepted.
    let stacked = CueRun::new(vec![
        baked_line(0, &[INK_CELL]),
        CueLine::new(
            vec![INK_CELL],
            vec![0.0],
            10.0,
            BASELINE_PX + LINE_HEIGHT_PX,
        ),
    ]);
    assert!(stage(atlas(FAMILY, WEIGHT), vec![stacked]).is_ok());
}

#[test]
fn a_run_pointing_past_the_atlas_is_refused() {
    let error = stage(atlas(FAMILY, WEIGHT), vec![baked_run(&[&[INK_CELL, 99]])])
        .expect_err("a run must not index a cell the atlas does not have");
    assert_eq!(rejection(&error), Rejection::RunGlyphIndex);
}

#[test]
fn a_run_with_no_glyphs_is_refused() {
    for run in [CueRun::new(Vec::new()), baked(&[])] {
        let error = stage(atlas(FAMILY, WEIGHT), vec![run])
            .expect_err("a cue with nothing to draw is not a staged run");
        assert_eq!(rejection(&error), Rejection::RunLength);
    }
}

#[test]
fn one_run_per_cue_is_required() {
    for runs in [Vec::new(), vec![baked(&[INK_CELL]), baked(&[SPACE_CELL])]] {
        let error =
            stage(atlas(FAMILY, WEIGHT), runs).expect_err("the run list must match the cue list");
        assert_eq!(rejection(&error), Rejection::RunCount);
    }
}

// ---- Atlas pages ---------------------------------------------------------------------------

/// A document with a large character set is baked into several pages, and a page list that cannot
/// address every cue is refused before a frame exists rather than at the frame that would draw it.
#[test]
fn a_page_list_no_cue_could_draw_from_is_refused() {
    let cases = [
        (
            AtlasPages::new(Vec::new(), vec![0]),
            Rejection::AtlasPagesEmpty,
        ),
        (
            // One more page than the renderer accepts. The bound exists so a page list cannot grow
            // without limit before its pixels are ever counted.
            AtlasPages::new(
                (0..=MAX_ATLAS_PAGES)
                    .map(|_| atlas(FAMILY, WEIGHT))
                    .collect(),
                vec![0],
            ),
            Rejection::AtlasPageCount,
        ),
        (
            AtlasPages::new(two_pages(), vec![0, 2]),
            Rejection::AtlasPageIndex,
        ),
    ];
    for (refused, expected) in cases {
        let error = refused.expect_err("a page list no cue could draw from is not a page list");
        assert_eq!(rejection(&error), expected);
    }

    // And the page list those refusals are the negatives of: exactly `MAX_ATLAS_PAGES` pages, with
    // the last one addressed, is accepted.
    let full: Vec<GlyphAtlasDescriptor> = (0..MAX_ATLAS_PAGES)
        .map(|_| atlas(FAMILY, WEIGHT))
        .collect();
    let last = u32::try_from(MAX_ATLAS_PAGES - 1).expect("a bounded page index");
    let pages = AtlasPages::new(full, vec![last]).expect("the largest accepted page list");
    assert_eq!(pages.pages().len(), MAX_ATLAS_PAGES);
    assert_eq!(pages.page_of_cue(0), Some(MAX_ATLAS_PAGES - 1));
    assert!(pages.page_of_cue(1).is_none());
}

/// The page assignment covers the scene's cues, one entry each. A scene and a page list that
/// disagree on how many cues there are is the same class of mistake as a run count that does not
/// match, and gets its own refusal so the cause is not guessed at.
#[test]
fn a_page_per_cue_is_required() {
    for page_of_cue in [Vec::new(), vec![0, 1]] {
        let pages = AtlasPages::new(two_pages(), page_of_cue)
            .expect("the page indices themselves are in range");
        let error = SubtitleScene::new(
            scene(FAMILY, WEIGHT),
            pages,
            style(&style_spec()),
            vec![baked(&[INK_CELL])],
        )
        .expect_err("the page assignment must cover exactly this scene's cues");
        assert_eq!(rejection(&error), Rejection::AtlasPageCueCount);
    }
}

/// Every page is checked, not just the first: they are bakes of one face at one size, so a page that
/// disagrees is a fault rather than a variation.
#[test]
fn a_later_page_baked_from_another_face_is_refused() {
    let pages = AtlasPages::new(
        vec![atlas(FAMILY, WEIGHT), atlas("Other Face", WEIGHT)],
        vec![0, 1],
    )
    .expect("two pages is a page list the compositor accepts");
    let error = SubtitleScene::new(
        two_cue_scene(FAMILY, WEIGHT),
        pages,
        style(&style_spec()),
        vec![baked(&[INK_CELL]), baked(&[INK_CELL])],
    )
    .expect_err("a page from another family must not be staged");
    assert_eq!(rejection(&error), Rejection::AtlasFaceMismatch);
}

/// A run is checked against **its own** page's cell table. Page one of the fixture is a smaller
/// texture, and a run validated against page zero's table would be accepted here and would then draw
/// from cells page one does not have.
#[test]
fn a_run_is_checked_against_its_own_page() {
    let pages = AtlasPages::new(two_pages(), vec![0, 1])
        .expect("two pages is a page list the compositor accepts");
    let error = SubtitleScene::new(
        two_cue_scene(FAMILY, WEIGHT),
        pages,
        style(&style_spec()),
        vec![baked(&[INK_CELL]), baked_run(&[&[INK_CELL, 99]])],
    )
    .expect_err("the second cue points at a cell its own page does not have");
    assert_eq!(rejection(&error), Rejection::RunGlyphIndex);
}

/// A page past what the device can allocate is refused up front, whichever page it is.
///
/// The limit is passed in rather than taken from a real adapter, because no shipped adapter stops
/// below the atlas ceiling: the only way to prove that the check reaches a page *after* the first is
/// to name a limit that only the later page exceeds.
#[test]
fn a_page_after_the_first_is_checked_against_the_device_limit() {
    let align = layout_align(&style_spec());
    // Page zero is the 8-pixel-square second-page fixture; page one is the 16x8 standard one.
    let pages = AtlasPages::new(
        vec![
            second_page(FAMILY, WEIGHT, align),
            common::aligned_atlas(FAMILY, WEIGHT, align),
        ],
        vec![0, 1],
    )
    .expect("two pages is a page list the compositor accepts");

    pages
        .check_device(16)
        .expect("both pages fit a device that allocates a 16-pixel edge");

    let error = pages
        .check_device(8)
        .expect_err("the second page is wider than an 8-pixel edge");
    assert!(
        matches!(
            error,
            CompositorError::DeviceTextureLimit {
                target: TextureTarget::Atlas,
                value: 16,
                max: 8,
                ..
            }
        ),
        "the refusal must name the atlas and the page's own edge: {error}"
    );
}

#[test]
fn a_background_that_carries_alpha_multiplies_it_by_background_opacity() {
    let spec = SubtitleStyleSpec {
        background_color: "#11223344".to_owned(),
        ..style_spec()
    };
    let style = SubtitleStyle::resolve(&spec).expect("an eight-digit background is supported");
    assert_eq!(
        style.background(),
        Rgba {
            red: 17,
            green: 34,
            blue: 51,
            // style_spec has 50% background opacity: round(68 * 127 / 255).
            alpha: 34,
        }
    );
    assert!(style.background_visible());
}

#[test]
fn unreviewed_style_vocabulary_is_refused() {
    let cases: [(SubtitleStyleSpec, Rejection); 4] = [
        (
            SubtitleStyleSpec {
                position: "middle".to_owned(),
                ..style_spec()
            },
            Rejection::StylePosition,
        ),
        (
            SubtitleStyleSpec {
                text_align: "start".to_owned(),
                ..style_spec()
            },
            Rejection::StyleAlign,
        ),
        (
            SubtitleStyleSpec {
                animation: "explode".to_owned(),
                ..style_spec()
            },
            Rejection::StyleAnimation,
        ),
        (
            // The shipped renderer falls through to linear here. Refusing changes no recognised
            // curve's pixels; it only stops an unrecognised one from being invisible.
            SubtitleStyleSpec {
                easing: "cubic-bezier(0.1, 0.2, 0.3, 0.4)".to_owned(),
                ..style_spec()
            },
            Rejection::StyleEasing,
        ),
    ];
    for (spec, expected) in cases {
        let error = SubtitleStyle::resolve(&spec).expect_err("an unreviewed value is refused");
        assert_eq!(rejection(&error), expected);
    }
}

#[test]
fn out_of_range_style_numbers_are_refused() {
    let cases: [(SubtitleStyleSpec, Rejection); 5] = [
        (
            SubtitleStyleSpec {
                font_size: f64::NAN,
                ..style_spec()
            },
            Rejection::StyleFontSize,
        ),
        (
            SubtitleStyleSpec {
                line_spacing: 0.0,
                ..style_spec()
            },
            Rejection::StyleLineSpacing,
        ),
        (
            SubtitleStyleSpec {
                opacity: 1.5,
                ..style_spec()
            },
            Rejection::StyleOpacity,
        ),
        (
            SubtitleStyleSpec {
                fade_in: f64::INFINITY,
                ..style_spec()
            },
            Rejection::StyleTiming,
        ),
        (
            // Past the render contract's `-1000..=1000`, and only just: 140 used to be refused
            // here, which made every project the editor saved with a cue placed off-composition
            // unexportable. `tests/bounds.rs` pins both ends of the accepted range.
            SubtitleStyleSpec {
                custom_y: 1_000.1,
                ..style_spec()
            },
            Rejection::StyleGeometry,
        ),
    ];
    for (spec, expected) in cases {
        let error = SubtitleStyle::resolve(&spec).expect_err("an out-of-range number is refused");
        assert_eq!(rejection(&error), expected);
    }
}

/// Every refusal must be loggable next to a user's project without leaking their subtitle text,
/// their font choice or their colours.
#[test]
fn refusals_name_the_field_and_never_the_value() {
    let secrets = ["Other Face", "#11223g", "explode", "middle"];
    let errors = [
        stage(atlas("Other Face", WEIGHT), vec![baked(&[INK_CELL])])
            .expect_err("a mismatched face is refused"),
        SubtitleStyle::resolve(&SubtitleStyleSpec {
            background_color: "#11223g".to_owned(),
            ..style_spec()
        })
        .expect_err("an invalid background is refused"),
        SubtitleStyle::resolve(&SubtitleStyleSpec {
            animation: "explode".to_owned(),
            ..style_spec()
        })
        .expect_err("an unknown animation is refused"),
        SubtitleStyle::resolve(&SubtitleStyleSpec {
            position: "middle".to_owned(),
            ..style_spec()
        })
        .expect_err("an unknown position is refused"),
    ];
    for error in &errors {
        let message = error.to_string();
        for secret in secrets {
            assert!(
                !message.contains(secret),
                "a refusal must not echo the value it refused: {message}"
            );
        }
    }
}
