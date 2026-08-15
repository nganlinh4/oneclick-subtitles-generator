//! Compositing the subtitle layer over the underlay: backfill, layer order, alpha and determinism.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.
//!
//! Crop and flip — where the underlay's pixels come from — are covered in `underlay_geometry.rs`.
//! What is covered here is what happens once they have arrived: what fills the frame where the
//! source does not reach, which layer lands on top, and by which blend.

mod common;

use common::frames::{COVERED_FIRST, COVERED_LAST, OPAQUE_WHITE, compositor, overhanging, pixel};
use common::{
    BACKFILL_COLOR, BACKFILL_PIXEL, HEIGHT, HOLD_FRAME, SILENT_FRAME, WIDTH, quadrant_source,
    staged, style_spec,
};
use osg_compositor::{
    Compositor, CompositorError, MAX_CANVAS_BLUR_SIGMA, SubtitleStyleSpec, VideoUnderlay,
};

/// The overlay path draws on nothing; the export path draws on video. That difference has to reach
/// the pixels, or the underlay is not being composited at all.
#[test]
fn an_underlay_replaces_the_transparent_ground() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let overlay = compositor
        .render_scene(&scene, SILENT_FRAME)
        .expect("composition succeeds");
    let composited = compositor
        .render_scene_over(
            &scene,
            &VideoUnderlay::whole(quadrant_source()),
            SILENT_FRAME,
        )
        .expect("composition succeeds");

    assert!(
        overlay.pixels().iter().all(|byte| *byte == 0),
        "the overlay path must still compose on a transparent ground"
    );
    assert_ne!(
        overlay.pixels(),
        composited.pixels(),
        "the underlay must reach the frame"
    );
}

/// "Exactly the uncovered area and no more" is the whole assertion: a backfill that also painted
/// under the video, or that stopped a column short, fails on the count rather than on a sample.
#[test]
fn a_solid_backfill_fills_exactly_the_uncovered_area() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let frame = compositor
        .render_scene_over(
            &scene,
            &overhanging(Some("solid"), Some(BACKFILL_COLOR), None),
            SILENT_FRAME,
        )
        .expect("composition succeeds");

    for y in [0, HEIGHT / 2, HEIGHT - 1] {
        for x in [0, COVERED_FIRST - 1, COVERED_LAST + 1, WIDTH - 1] {
            assert_eq!(
                pixel(&frame, x, y),
                BACKFILL_PIXEL,
                "({x}, {y}) is outside the cropped region and must carry the backfill"
            );
        }
        for x in [COVERED_FIRST, WIDTH / 2, COVERED_LAST] {
            assert_ne!(
                pixel(&frame, x, y),
                BACKFILL_PIXEL,
                "({x}, {y}) is inside the cropped region and must carry the video"
            );
        }
    }

    let filled = frame
        .pixels()
        .chunks_exact(4)
        .filter(|pixel| *pixel == BACKFILL_PIXEL)
        .count();
    let uncovered = (WIDTH - (COVERED_LAST - COVERED_FIRST + 1)) * HEIGHT;
    assert_eq!(
        u32::try_from(filled).ok(),
        Some(uncovered),
        "the backfill must cover the uncovered columns exactly"
    );
}

/// With no canvas mode the shipped renderer's backdrop element is empty, so the uncovered area is
/// transparent rather than black. Reproduced deliberately: inventing black here would change every
/// project that overhangs its crop without asking for a background.
#[test]
fn no_canvas_mode_leaves_the_uncovered_area_transparent() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let frame = compositor
        .render_scene_over(&scene, &overhanging(None, None, None), SILENT_FRAME)
        .expect("composition succeeds");

    assert_eq!(pixel(&frame, 0, HEIGHT / 2), [0, 0, 0, 0]);
    assert_eq!(pixel(&frame, WIDTH - 1, HEIGHT / 2), [0, 0, 0, 0]);
    assert_eq!(
        pixel(&frame, WIDTH / 2, HEIGHT / 2)[3],
        255,
        "the covered half must still be opaque video"
    );
}

/// The blur backfill has to be a blur of the source, not a second flat colour, and its cost has to
/// stop growing once the stored value passes the compositor's bound.
#[test]
fn a_blur_backfill_differs_from_a_solid_one_and_is_bounded() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let solid = compositor
        .render_scene_over(
            &scene,
            &overhanging(Some("solid"), Some(BACKFILL_COLOR), None),
            SILENT_FRAME,
        )
        .expect("composition succeeds");
    let blurred = compositor
        .render_scene_over(
            &scene,
            &overhanging(Some("blur"), None, Some(8.0)),
            SILENT_FRAME,
        )
        .expect("composition succeeds");

    assert_ne!(
        solid.pixels(),
        blurred.pixels(),
        "a blurred backfill must not equal a solid one"
    );

    // A blur of a four-colour source is not flat: sample two rows far apart in the same uncovered
    // column and require them to differ, which a solid fill of any colour cannot do.
    let top = pixel(&blurred, 4, HEIGHT / 8);
    let bottom = pixel(&blurred, 4, HEIGHT * 7 / 8);
    assert_ne!(
        top, bottom,
        "the blurred backfill must carry the source's own variation, got {top:?} twice"
    );
    assert_eq!(
        top[3], 255,
        "the blurred backfill of an opaque source is opaque"
    );

    // Bounded: the stored maximum and the compositor's own ceiling must render the same bytes,
    // which is only true if the radius stopped growing at the ceiling.
    let at_ceiling = compositor
        .render_scene_over(
            &scene,
            &overhanging(Some("blur"), None, Some(MAX_CANVAS_BLUR_SIGMA)),
            SILENT_FRAME,
        )
        .expect("composition succeeds");
    let far_past_it = compositor
        .render_scene_over(
            &scene,
            &overhanging(Some("blur"), None, Some(1_000.0)),
            SILENT_FRAME,
        )
        .expect("composition succeeds");
    assert_eq!(
        at_ceiling.pixels(),
        far_past_it.pixels(),
        "a stored blur past the compositor's ceiling must render as the ceiling"
    );
}

/// The layer order, stated as the failure it prevents: an opaque video drawn last would bury the
/// cue, so every pixel the subtitle layer made opaque white must still be opaque white.
#[test]
fn the_subtitle_layer_lands_over_the_video() {
    let compositor = compositor!();
    // No background box, so every opaque white pixel is glyph ink rather than a filled rectangle.
    let scene = staged(&SubtitleStyleSpec {
        background_opacity: 0.0,
        ..style_spec()
    });
    let video = VideoUnderlay::whole(quadrant_source());

    let overlay_only = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");
    let composited = compositor
        .render_scene_over(&scene, &video, HOLD_FRAME)
        .expect("composition succeeds");
    let video_only = compositor
        .render_scene_over(&scene, &video, SILENT_FRAME)
        .expect("composition succeeds");

    let mut ink = 0_usize;
    for (index, glyph) in overlay_only.pixels().chunks_exact(4).enumerate() {
        if glyph != OPAQUE_WHITE {
            continue;
        }
        ink += 1;
        let over = &composited.pixels()[index * 4..index * 4 + 4];
        assert_eq!(
            over, OPAQUE_WHITE,
            "the video covered glyph ink at pixel {index}"
        );
    }
    assert!(ink > 0, "the fixture cue must ink some fully opaque pixels");

    assert_ne!(
        composited.pixels(),
        video_only.pixels(),
        "the cue must survive the composite"
    );
    assert_ne!(
        composited.pixels(),
        overlay_only.pixels(),
        "the video must survive the composite"
    );
}

/// The blend rule itself, stated arithmetically rather than by eye.
///
/// The subtitle layer is premultiplied, so the composite must be `src + dst * (1 - src.a)`. A
/// straight-alpha lerp would multiply the already-premultiplied colour by its alpha a second time,
/// which is invisible on the opaque interior of a glyph and darkens exactly its antialiased edge —
/// the fringing this whole alpha convention exists to prevent. Every partly transparent pixel of the
/// overlay is checked against the exact result, so the edge is where the assertion bites hardest.
#[test]
fn the_composite_is_the_premultiplied_blend_and_not_a_straight_alpha_lerp() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let video = VideoUnderlay::whole(quadrant_source());

    let overlay = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("composition succeeds");
    let ground = compositor
        .render_scene_over(&scene, &video, SILENT_FRAME)
        .expect("composition succeeds");
    let composited = compositor
        .render_scene_over(&scene, &video, HOLD_FRAME)
        .expect("composition succeeds");

    let mut edge_pixels = 0_usize;
    for (index, source) in overlay.pixels().chunks_exact(4).enumerate() {
        let alpha = u32::from(source[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        edge_pixels += 1;
        let under = &ground.pixels()[index * 4..index * 4 + 4];
        let over = &composited.pixels()[index * 4..index * 4 + 4];
        for channel in 0..4 {
            // Round to nearest, the way a unorm target resolves the blend.
            let kept = (u32::from(under[channel]) * (255 - alpha) + 127) / 255;
            let expected = u32::from(source[channel]) + kept;
            let actual = u32::from(over[channel]);
            assert!(
                expected.abs_diff(actual) <= 1,
                "pixel {index} channel {channel}: premultiplied blend of {source:?} over \
                 {under:?} is {expected}, got {actual}"
            );
        }
    }
    assert!(
        edge_pixels > 0,
        "the fixture cue must produce antialiased edge pixels for this to prove anything"
    );
}

/// Determinism, unchanged by the underlay: the same inputs give the same bytes.
#[test]
fn the_same_underlay_frame_renders_byte_identically_twice() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let video = overhanging(Some("blur"), None, Some(6.0));

    let first = compositor
        .render_scene_over(&scene, &video, HOLD_FRAME)
        .expect("composition succeeds");
    let second = compositor
        .render_scene_over(&scene, &video, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        first.pixels(),
        second.pixels(),
        "the same scene and underlay at the same frame must be byte-identical"
    );
}

/// Seek equals play, with a video ground and a blurred backfill under the cue. The blur is the part
/// that could plausibly carry state between frames, so it is the one this runs with.
#[test]
fn seeking_over_an_underlay_equals_playing_up_to_it() {
    let compositor = compositor!();
    let scene = staged(&style_spec());
    let video = overhanging(Some("blur"), None, Some(6.0));

    let mut played = None;
    for index in 0..=HOLD_FRAME {
        played = Some(
            compositor
                .render_scene_over(&scene, &video, index)
                .expect("composition succeeds"),
        );
    }
    let played = played.expect("the loop rendered at least one frame");

    let fresh = Compositor::new().expect("a second device on a working adapter");
    let sought = fresh
        .render_scene_over(&scene, &video, HOLD_FRAME)
        .expect("composition succeeds");

    assert_eq!(
        played.pixels(),
        sought.pixels(),
        "rendering frame {HOLD_FRAME} after 0..{HOLD_FRAME} must equal seeking straight to it"
    );
}

#[test]
fn a_frame_outside_the_timeline_is_refused_with_an_underlay_too() {
    let compositor = compositor!();
    let scene = staged(&style_spec());

    let error = compositor
        .render_scene_over(
            &scene,
            &VideoUnderlay::whole(quadrant_source()),
            scene.frame_count(),
        )
        .expect_err("one past the last frame is not in the timeline");
    assert!(
        matches!(
            error,
            CompositorError::FrameOutOfRange { index, frame_count }
                if index == scene.frame_count() && frame_count == scene.frame_count()
        ),
        "unexpected error: {error}"
    );
}
