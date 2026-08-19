//! An ordinary video whose height is not a multiple of 16 must decode.
//!
//! WHAT THIS FOUND. Media Foundation reports the unpadded size when a source is opened and the
//! macroblock-aligned size once decoding actually begins: 640x360 becomes 640x368. The reader treats
//! any change as a source that changed geometry mid-stream and refuses it, so NO frame can be
//! decoded at all. 1080p is the same shape of problem, coding to 1088.
//!
//! WHY IT IS NOT FIXED HERE. `SourcePresentation` derives the display size FROM the coded size, so
//! it has no way to say "the buffer is 640x368 and the picture inside it is 640x360". Making the
//! padded size acceptable therefore needs a visible region alongside the coded one, carried through
//! decode, preview and export together — the plane maths reads chroma at the coded height, so a
//! buffer read at the wrong height would silently produce a corrupted image rather than a refusal.
//! That is a deliberate design change, not a patch, and it is recorded in `e2e/inventory.json`.
//!
//! This test states the behaviour the product owes its users. It is ignored so the suite stays
//! honest about what passes rather than encoding the defect as expected; run it with
//! `cargo test -p osg-decode -- --ignored` to see the current failure with both geometries named.

use std::path::PathBuf;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/media/bars-6s-640x360.mp4")
}

#[test]
#[ignore = "known defect: a macroblock-padded output geometry is refused as a mid-stream change"]
fn a_source_whose_height_is_not_a_multiple_of_sixteen_decodes_its_first_frame() {
    let path = fixture();
    assert!(path.exists(), "the media fixture must be present");

    let timeline =
        osg_scene::FrameTimeline::new(30, 1, 1, osg_scene::ExactTime::ZERO).expect("timeline");
    let mut decoder = osg_decode::open_decoder(&path, osg_decode::DecoderConfig::new(timeline))
        .expect("a 640x360 H.264 file must open");

    let info = decoder.source();
    assert_eq!(info.display_width(), 640);
    assert_eq!(info.display_height(), 360);

    let frame = decoder
        .frame_for_output(0)
        .expect("the first frame of an ordinary 360p video must decode");
    assert_eq!(frame.width(), 640);
    assert_eq!(frame.height(), 360);
}
