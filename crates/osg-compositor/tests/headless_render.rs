//! Headless composition against a real adapter.
//!
//! Every test here skips loudly when the environment has no GPU adapter, and says so on stderr, so
//! a green run on an adapter-less machine is never mistaken for a verified one.

use osg_compositor::{Compositor, CompositorError, Frame, FrameSize, TestScene};

/// Acquires a compositor, or reports that GPU coverage did not run.
fn adapter() -> Option<Compositor> {
    match Compositor::new() {
        Ok(compositor) => Some(compositor),
        Err(CompositorError::NoAdapter { reason }) => {
            eprintln!(
                "SKIPPED: no GPU adapter in this environment ({reason}). \
                 GPU composition was NOT verified by this run."
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

fn size(width: u32, height: u32) -> FrameSize {
    FrameSize::new(width, height).expect("test sizes are within bounds")
}

/// The top-left `width` x `height` corner of a frame, so two differently sized frames can be
/// compared over the region they share.
fn corner(frame: &Frame, width: u32, height: u32) -> Vec<u8> {
    assert!(width <= frame.width() && height <= frame.height());
    let mut corner = Vec::new();
    for y in 0..height {
        for x in 0..width {
            corner.extend_from_slice(&frame.pixel(x, y).expect("inside the frame"));
        }
    }
    corner
}

#[test]
fn reports_the_adapter_it_acquired() {
    let compositor = compositor!();
    let profile = compositor.adapter();
    eprintln!(
        "ADAPTER: name={:?} backend={} kind={:?} software={}",
        profile.name(),
        profile.backend(),
        profile.kind(),
        profile.kind().is_software()
    );
    assert!(!profile.backend().is_empty());
}

/// The golden property: identical inputs give byte-identical output.
#[test]
fn the_same_scene_renders_byte_identically_twice() {
    let compositor = compositor!();
    let target = size(320, 180);
    let scene = TestScene::origin();

    let first = compositor
        .render(scene, target)
        .expect("the first composition succeeds");
    let second = compositor
        .render(scene, target)
        .expect("the second composition succeeds");

    assert_eq!(
        first.pixels().len(),
        320 * 180 * 4,
        "readback must be tightly packed RGBA8"
    );
    assert_eq!(
        first.pixels(),
        second.pixels(),
        "the same scene at the same size must be byte-identical"
    );
}

/// Determinism must survive a fresh device, not only a warm one.
#[test]
fn a_second_compositor_reproduces_the_same_bytes() {
    let first_compositor = compositor!();
    let second_compositor = Compositor::new().expect("a second device on a working adapter");
    let target = size(160, 90);
    let scene = TestScene::new(0.25).expect("a unit phase");

    let first = first_compositor
        .render(scene, target)
        .expect("composition succeeds");
    let second = second_compositor
        .render(scene, target)
        .expect("composition succeeds");

    assert_eq!(
        first.pixels(),
        second.pixels(),
        "a fresh device must reproduce the same frame"
    );
}

#[test]
fn the_same_scene_at_two_sizes_is_a_different_image() {
    let compositor = compositor!();
    let scene = TestScene::origin();

    let small = compositor
        .render(scene, size(256, 144))
        .expect("composition succeeds");
    let large = compositor
        .render(scene, size(512, 288))
        .expect("composition succeeds");

    assert_ne!(
        small.pixels().len(),
        large.pixels().len(),
        "a larger frame must carry more pixels"
    );
    assert_ne!(
        corner(&small, 128, 72),
        corner(&large, 128, 72),
        "the shared corner must differ: the scene is resolution-dependent, not a rescale"
    );
}

#[test]
fn a_different_phase_is_a_different_frame() {
    let compositor = compositor!();
    let target = size(256, 144);

    let start = compositor
        .render(TestScene::new(0.0).expect("a unit phase"), target)
        .expect("composition succeeds");
    let middle = compositor
        .render(TestScene::new(0.5).expect("a unit phase"), target)
        .expect("composition succeeds");
    let start_again = compositor
        .render(TestScene::new(0.0).expect("a unit phase"), target)
        .expect("composition succeeds");

    assert_ne!(
        start.pixels(),
        middle.pixels(),
        "the phase input must reach the pixels"
    );
    assert_eq!(
        start.pixels(),
        start_again.pixels(),
        "seeking back to a phase must reproduce it exactly"
    );
}

/// A width whose RGBA8 row is not a multiple of 256 bytes exercises the readback row unpadding.
#[test]
fn unaligned_widths_read_back_without_row_padding() {
    let compositor = compositor!();
    let target = size(17, 9);

    let frame = compositor
        .render(TestScene::origin(), target)
        .expect("composition succeeds");

    assert_eq!(frame.pixels().len(), 17 * 9 * 4);
    assert_eq!(
        u64::try_from(frame.pixels().len()).ok(),
        Some(target.rgba8_len())
    );

    // The scene's orientation anchor occupies the first 8x8 pixels. Finding it at (0, 0) proves the
    // rows survived unpadding in order.
    let [red, green, blue, alpha] = frame.pixel(0, 0).expect("the first pixel exists");
    assert!(
        red > 200 && red > green.saturating_add(100) && red > blue.saturating_add(100),
        "the top-left anchor must be red-dominant, got {red},{green},{blue}"
    );
    assert_eq!(alpha, 255, "the composed frame must be opaque");

    assert_eq!(
        frame.pixel(17, 0),
        None,
        "sampling outside the frame is None"
    );
    assert_eq!(
        frame.pixel(0, 9),
        None,
        "sampling outside the frame is None"
    );
}

#[test]
fn a_one_pixel_frame_composes() {
    let compositor = compositor!();
    let frame = compositor
        .render(TestScene::origin(), size(1, 1))
        .expect("a 1x1 frame is renderable");
    assert_eq!(frame.pixels().len(), 4);
    assert_eq!(frame.width(), 1);
    assert_eq!(frame.height(), 1);
}
