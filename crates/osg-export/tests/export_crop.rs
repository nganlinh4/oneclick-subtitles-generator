#![recursion_limit = "256"]

//! Real end-to-end exports of a crop that does not fill the frame.
//!
//! Split from `export_mp4.rs` at a real seam: that suite proves the shape of an ordinary export —
//! frames, duration, trim, audio, cancellation, progress — while this one proves the two decisions
//! the parity ledger records against the crop. Both drive the same synthetic clip through the same
//! platform codecs and the same GPU adapter, from `support::media`.
//!
//! * **`aspectRatio`.** The output frame is derived from the crop region, and the persisted field
//!   is not read. Here that derivation is checked against what a platform decoder finds in the
//!   finished file rather than against the maths that produced it.
//! * **`canvasBgColor`.** An export carries no alpha, so the backfill is opaque before a frame is
//!   composed. The uncovered area reaches the encoder already opaque and comes back the colour it
//!   previewed, and a backfill an export cannot carry is refused before anything is opened.
//!
//! Like `export_mp4.rs`, nothing here skips when a codec or an adapter is missing: every `expect`
//! turns that into a failed test rather than a green suite that never exported anything.

#![cfg(windows)]

mod support;

use osg_export::ExportError;
use serde_json::{Value, json};
use support::media::{
    converted_for, decoded_frame, export, export_request, pixel_at, platform, renderer_for,
    source_clip,
};
use tempfile::TempDir;

/// A crop that does not fill the frame: shifted a quarter of the source to the left and half again
/// as wide as it, so the output is 2:1 and both side margins can only be canvas backfill.
const PADDED_CROP_X: f64 = -25.0;
const PADDED_CROP_WIDTH: f64 = 150.0;

/// The padded exports run at 720p, where `720 * (320/240) * (150/100)` is 1440 by 720.
///
/// Both edges are deliberately multiples of 16. `osg-decode` refuses to read frames back out of a
/// file whose coded size the platform decoder pads — it reports `SourceGeometryChanged` — so the
/// pixel comparisons below would fail for a reason that has nothing to do with the crop. The
/// derivation itself is exercised across the whole resolution ladder by the conversion suite,
/// which needs no decoder.
const PADDED_OUT_WIDTH: u32 = 1_440;
const PADDED_OUT_HEIGHT: u32 = 720;

/// How many frames a two-second export at 30fps writes.
const PADDED_FRAMES: u32 = 60;

/// An output column inside the left margin, where only the backfill can reach: the crop's left edge
/// lands at output x 240.
const BACKFILL_COLUMN: u32 = 20;
/// An output column the cropped video does reach, so the backfill assertions are not about a
/// uniformly black frame.
const VIDEO_COLUMN: u32 = 864;
/// The row both columns are sampled on: inside the source's bottom half, away from every edge.
const SAMPLE_ROW: u32 = 540;

/// The request with the padding crop applied, so the backfill has somewhere to show.
fn padded_request() -> Value {
    let mut value = export_request(0, 2_000_000);
    value["settings"]["resolution"] = json!("720p");
    value["crop"]["x"] = json!(PADDED_CROP_X);
    value["crop"]["width"] = json!(PADDED_CROP_WIDTH);
    value
}

#[test]
fn a_crop_that_does_not_fill_the_frame_is_decoded_at_the_size_the_conversion_derived() {
    let _platform = platform();
    // The ledger's `aspectRatio`, `resolution` and `trimEnd` entries at the far end of the pipeline.
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "cropped-source.mp4");
    let output = directory.path().join("cropped.mp4");

    let plan = converted_for(&source, padded_request());
    assert_eq!(
        (plan.width(), plan.height()),
        (PADDED_OUT_WIDTH, PADDED_OUT_HEIGHT),
        "the crop region did not drive the composition size"
    );
    // The same numbers the encoder is configured with, not a second derivation beside them.
    assert_eq!(
        (plan.video().width(), plan.video().height()),
        (PADDED_OUT_WIDTH, PADDED_OUT_HEIGHT)
    );
    assert_eq!(
        (
            plan.encoder_config(false).video().width(),
            plan.encoder_config(false).video().height()
        ),
        (PADDED_OUT_WIDTH, PADDED_OUT_HEIGHT)
    );
    assert_eq!(
        plan.frame_count(),
        PADDED_FRAMES,
        "trimEnd bounds the frame range"
    );

    let summary = export(&source, &output, None, padded_request()).expect("the export runs");
    assert_eq!(
        (summary.width(), summary.height()),
        (PADDED_OUT_WIDTH, PADDED_OUT_HEIGHT)
    );
    assert_eq!(summary.frames(), PADDED_FRAMES);

    // Not the summary's word for it: the platform decoder's.
    let decoded = decoded_frame(&output, 0, PADDED_FRAMES);
    assert_eq!(
        decoded.len(),
        usize::try_from(PADDED_OUT_WIDTH * PADDED_OUT_HEIGHT * 4).expect("a small frame"),
        "the decoded export is not the size the conversion derived"
    );
    println!("cropped export decoded at {PADDED_OUT_WIDTH}x{PADDED_OUT_HEIGHT}");
}

#[test]
fn the_uncovered_area_reaches_the_encoder_already_opaque_and_comes_back_the_colour_it_previewed() {
    let _platform = platform();
    // The ledger's open question on `canvasBgColor`, closed. This request selects no canvas mode at
    // all, which is the shipped renderer's empty backdrop; the conversion composites it onto one
    // explicit opaque ground before a frame is composed, rather than handing the encoder an alpha it
    // would silently turn into black.
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "backfill-source.mp4");
    let output = directory.path().join("backfill.mp4");

    let mut renderer = renderer_for(&source, padded_request());
    let composed = renderer.frame(0).expect("a composed frame");
    let pixels = composed.pixels();
    assert!(
        pixels.chunks_exact(4).all(|pixel| pixel[3] == 255),
        "the frame handed to the encoder still carries transparency"
    );
    let previewed = pixel_at(pixels, PADDED_OUT_WIDTH, BACKFILL_COLUMN, SAMPLE_ROW);
    assert_eq!(
        previewed,
        [0, 0, 0, 255],
        "the uncovered area is not the explicit opaque ground"
    );
    let video = pixel_at(pixels, PADDED_OUT_WIDTH, VIDEO_COLUMN, SAMPLE_ROW);
    assert!(
        video[0] > 128,
        "no video reached the frame, so the backfill assertion proves nothing: {video:?}"
    );
    renderer.close();

    export(&source, &output, None, padded_request()).expect("the export runs");
    let decoded = decoded_frame(&output, 0, PADDED_FRAMES);
    let exported = pixel_at(&decoded, PADDED_OUT_WIDTH, BACKFILL_COLUMN, SAMPLE_ROW);
    // The encoder is a carrier, not a decision: the exported pixel is the previewed one, to within
    // what a full-range H.264 round trip costs a flat block.
    assert!(
        exported[0] <= 8 && exported[1] <= 8 && exported[2] <= 8,
        "the exported backfill is {exported:?}, not the black it previewed"
    );
    let exported_video = pixel_at(&decoded, PADDED_OUT_WIDTH, VIDEO_COLUMN, SAMPLE_ROW);
    assert!(
        exported_video[0] > 128,
        "the exported frame lost its video: {exported_video:?}"
    );
    println!("backfill previewed {previewed:?} and exported {exported:?}");
}

#[test]
fn a_translucent_canvas_backfill_is_refused_before_a_decoder_or_an_encoder_is_opened() {
    let _platform = platform();
    // Ordering, proven rather than asserted: the source does not exist, so anything that opened a
    // decoder before deciding this would have reported an unreadable source instead.
    let directory = TempDir::new().expect("a temporary directory");
    let missing = directory.path().join("never-created.mp4");
    let output = directory.path().join("never-written.mp4");

    let mut translucent = padded_request();
    translucent["crop"]["canvasBgMode"] = json!("solid");
    translucent["crop"]["canvasBgColor"] = json!("#20304050");
    let error = export(&missing, &output, None, translucent)
        .expect_err("a backfill an export cannot carry is refused");
    assert!(
        matches!(error, ExportError::CanvasBackgroundNotOpaque),
        "got {error}"
    );
    assert!(!output.exists(), "a refused export opened an encoder");
    let rendered = error.to_string();
    assert!(!rendered.contains("C:"), "the error carried a path");
    assert!(!rendered.contains(".mp4"), "the error named a file");

    // The control: with an opaque backfill the same missing source is what the runner reports, so
    // the refusal above really did come first.
    let mut opaque = padded_request();
    opaque["crop"]["canvasBgMode"] = json!("solid");
    opaque["crop"]["canvasBgColor"] = json!("#203040");
    let error = export(&missing, &output, None, opaque).expect_err("the source does not exist");
    assert!(
        matches!(error, ExportError::SourceUnreadable { .. }),
        "got {error}"
    );
    assert!(!output.exists());
}
