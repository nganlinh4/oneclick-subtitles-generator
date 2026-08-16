//! Composing at the output sizes the product ships, against a real adapter.
//!
//! The shipped UI offers 1440p, 4K and 8K, the render contract accepts them, and the release
//! profile is `panic = "abort"`. `wgpu` validates a texture dimension inside `Device::create_texture`
//! by panicking, so a composition edge the device cannot take used to end the process mid-export
//! rather than returning an error the caller could show. Every test here asserts the only two
//! outcomes that are allowed: the frame composes, or a typed [`CompositorError::DeviceTextureLimit`]
//! comes back. Never a panic.
//!
//! The decoration mask is exercised at every size, not just the frame target. It is a separate
//! allocation at the composition size — the parity gate aborted at 1440p on
//! `'osg-compositor decoration mask'` while the frame target itself had not yet been reached — so a
//! suite that only composed a bare glyph would have passed while the shipped export still died.
//!
//! Every test skips loudly when no GPU adapter exists, and says so on stderr, so a green run on an
//! adapter-less machine is never mistaken for a verified one.

mod common;

use common::frames::compositor;
use common::ink::{count_where, inked, reddish};
use common::{HOLD_FRAME, decorated, staged_at, style_spec};
use osg_compositor::{
    Compositor, CompositorError, MAX_FRAME_DIMENSION, SubtitleDecorationSpec, SubtitleStyleSpec,
    TextureTarget,
};

/// The output sizes the shipped UI offers above `Limits::downlevel_defaults()`'s 2048.
///
/// 1080p is deliberately absent: it composed before this bound existed, so it discriminates
/// nothing. These three are the ones the gate proved aborted.
const OVERSIZED: [(u32, u32, &str); 3] = [
    (2560, 1440, "1440p"),
    (3840, 2160, "4K"),
    (7680, 4320, "8K"),
];

/// A red drop shadow with a small blur.
///
/// A shadow rather than a bare glyph because it is what allocates the decoration mask, and red
/// rather than the glyph's own white because "a red pixel exists" is proof the mask was allocated
/// at the composition size, rendered into, blurred and sampled — not merely that something drew.
///
/// The blur is small on purpose: the mask is three full-composition targets and two full-composition
/// passes, and at 8K a large radius would make this suite a benchmark rather than a bound.
fn shadowed() -> SubtitleStyleSpec {
    decorated(SubtitleDecorationSpec {
        text_shadow_enabled: true,
        text_shadow_color: "#ff0000".to_owned(),
        text_shadow_blur: 2.0,
        // Offset so the shadow is not entirely hidden behind the glyph that casts it.
        text_shadow_offset_x: 6.0,
        text_shadow_offset_y: 6.0,
        ..SubtitleDecorationSpec::default()
    })
}

/// Compose one size and assert the outcome the contract allows, whichever one this device gives.
///
/// The branch is on the device's own reported limit rather than on a guess about the machine, so
/// the assertion is exact on an adapter that can take the size *and* on one that cannot.
fn compose_or_refuse(compositor: &Compositor, width: u32, height: u32, name: &str) {
    let max_edge = compositor.adapter().max_texture_dimension_2d();
    let scene = staged_at(&shadowed(), width, height);
    let composed = compositor.render_scene(&scene, HOLD_FRAME);

    if width.max(height) > max_edge {
        let error = composed.err().unwrap_or_else(|| {
            panic!("{name} is past this device's {max_edge}px limit and must not compose")
        });
        assert!(
            matches!(
                error,
                CompositorError::DeviceTextureLimit {
                    target: TextureTarget::Frame,
                    value,
                    max,
                    ..
                } if value > max && max == max_edge
            ),
            "{name} must be refused by the device limit, not by anything else: {error}"
        );
        return;
    }

    let frame = composed.unwrap_or_else(|error| {
        panic!("{name} is within this device's {max_edge}px limit: {error}")
    });
    assert_eq!(frame.width(), width, "{name} composed at the wrong width");
    assert_eq!(
        frame.height(),
        height,
        "{name} composed at the wrong height"
    );
    assert!(inked(&frame) > 0, "{name} composed an empty frame");
    assert!(
        count_where(&frame, reddish) > 0,
        "{name} composed without its decoration mask: no shadow pixel is on screen"
    );
}

#[test]
fn every_shipped_output_size_composes_its_frame_and_its_decoration_mask() {
    let compositor = compositor!();
    let max_edge = compositor.adapter().max_texture_dimension_2d();
    eprintln!(
        "adapter {} ({}) reports max_texture_dimension_2d = {max_edge}",
        compositor.adapter().name(),
        compositor.adapter().backend(),
    );
    for (width, height, name) in OVERSIZED {
        compose_or_refuse(&compositor, width, height, name);
    }
}

/// The device is asked for the resolution it has, so no adapter is capped at the downlevel 2048
/// unless it genuinely stops there.
///
/// This is the defect stated as an assertion: `Limits::downlevel_defaults()` grants 2048, which is
/// below every size in [`OVERSIZED`]. An adapter that really cannot exceed 2048 is allowed — it
/// takes the typed-refusal branch above — but a device that was merely *asked* for too little is
/// not.
#[test]
fn the_device_is_not_capped_below_what_the_adapter_offers() {
    let compositor = compositor!();
    let granted = compositor.adapter().max_texture_dimension_2d();
    assert!(
        granted <= MAX_FRAME_DIMENSION,
        "the compositor must never be granted more than it would ever ask for: {granted}"
    );
    assert_ne!(
        granted, 2048,
        "2048 is the downlevel default; a real adapter reporting exactly it is possible but \
         vanishingly unlikely, and getting it back means the request was not raised at all"
    );
}

/// A frame no larger than 1080p still composes, so the new bound refuses nothing that worked.
#[test]
fn a_1080p_frame_still_composes() {
    let compositor = compositor!();
    let scene = staged_at(&style_spec(), 1920, 1080);
    let frame = compositor
        .render_scene(&scene, HOLD_FRAME)
        .expect("1080p composed before this bound existed and must still compose");
    assert_eq!((frame.width(), frame.height()), (1920, 1080));
    assert!(inked(&frame) > 0, "1080p composed an empty frame");
}
