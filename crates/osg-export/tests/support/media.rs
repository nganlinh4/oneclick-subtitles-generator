//! The real-media fixtures the end-to-end suites share: a synthetic clip, the runner, and readback.
//!
//! Nothing here is checked in as bytes. The source clip is encoded by `osg-encode` through Media
//! Foundation on the machine running the test, exported through the whole native pipeline, and read
//! back through `osg-decode`, so every stage is proven against the others rather than against a
//! file somebody generated once.
//!
//! Windows-only, because that is where the platform codecs are. The conversion suites need none of
//! it and do not compile it.

// Neither end-to-end suite uses every helper, and one that did would be a coincidence.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use osg_decode::{DecoderConfig, open_decoder};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
use osg_export::{
    ExportCancel, ExportError, ExportJob, ExportPlan, ExportSummary, FrameRenderer, SilentProgress,
    probe_source, run_export,
};
use osg_render::RenderRequest;
use osg_scene::{ExactTime, FrameTimeline};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::{default_face, request_json, staged_text};

/// Serialises the tests that drive a graphics adapter and Media Foundation at the same time.
///
/// Not decoration and not a workaround for anything in this crate. Run in parallel, several of
/// these tests each acquire their own `wgpu` device while other threads are opening Media
/// Foundation source readers and sink writers, and that combination faulted once in five runs
/// (`STATUS_ACCESS_VIOLATION`) inside the platform layers, with no `unsafe` code of our own
/// anywhere in the stack. The product exports one file at a time on one thread, so the concurrency
/// these tests were creating is not a shape it ever has; serialising them keeps the suite a signal
/// about the exporter rather than about a driver. The observation is recorded here rather than
/// quietly absorbed, because the next person to add a parallel adapter user needs to know.
///
/// One static per test binary, which is all that is needed: `cargo` runs test binaries one after
/// another, so the only concurrency to guard is inside each one.
static PLATFORM: Mutex<()> = Mutex::new(());

/// Takes the platform lock, ignoring poisoning so one failing test does not fail the rest.
pub(crate) fn platform() -> MutexGuard<'static, ()> {
    PLATFORM.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The synthetic source clip: small, deterministic, and long enough to trim inside.
pub(crate) const SOURCE_WIDTH: u32 = 320;
pub(crate) const SOURCE_HEIGHT: u32 = 240;
pub(crate) const SOURCE_FPS: u32 = 30;
pub(crate) const SOURCE_FRAMES: u32 = 90;

/// A deterministic `RGBA8` frame of four flat grey quadrants. No RNG and no clock.
///
/// Flat blocks on purpose: they survive compression well enough to be read back as a number, and a
/// neutral grey isolates the luma range, which is the thing that has to survive the round trip.
pub(crate) fn synthetic_frame(index: u32) -> Vec<u8> {
    let ramp = u8::try_from(16 + index * 2).expect("ninety steps of two stay inside a byte");
    let capacity = (SOURCE_WIDTH * SOURCE_HEIGHT * 4) as usize;
    let mut pixels = Vec::with_capacity(capacity);
    for y in 0..SOURCE_HEIGHT {
        for x in 0..SOURCE_WIDTH {
            let level = match (x < SOURCE_WIDTH / 2, y < SOURCE_HEIGHT / 2) {
                (true, true) => ramp,
                (false, true) => 32,
                (true, false) => 128,
                (false, false) => 224,
            };
            pixels.extend_from_slice(&[level, level, level, 255]);
        }
    }
    pixels
}

/// Encodes the synthetic source clip and returns where it landed.
pub(crate) fn source_clip(directory: &TempDir, name: &str) -> PathBuf {
    let output = directory.path().join(name);
    let video = VideoConfig::new(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS, 1, SOURCE_FRAMES)
        .expect("a supported source configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(10)
        .expect("10 frames is in range");

    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder for these tests to mean anything");
    for index in 0..SOURCE_FRAMES {
        let pixels = synthetic_frame(index);
        let frame = FrameBuffer::new(&pixels, SOURCE_WIDTH, SOURCE_HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the source container is closed");
    assert!(output.is_file(), "the source clip was not written");
    output
}

/// The fixture request, retargeted at the synthetic clip.
pub(crate) fn export_request(trim_start_us: u64, trim_end_us: u64) -> Value {
    let mut value = request_json();
    value["settings"]["resolution"] = json!("360p");
    value["settings"]["trimStartUs"] = json!(trim_start_us);
    value["settings"]["trimEndUs"] = json!(trim_end_us);
    // No fade window, so a frame is either fully inside a cue's hold or fully outside it. That
    // removes every knife-edge from the comparisons without changing what is being compared.
    value["customization"]["fadeInDuration"] = json!(0);
    value["customization"]["fadeOutDuration"] = json!(0);
    // Large enough that the drawn cue covers an unmistakable number of pixels at 360p.
    value["customization"]["fontSize"] = json!(96);
    value["lyrics"] = json!([{"id":"cue-1","startUs":1_200_000,"endUs":1_700_000,"text":"A"}]);
    value
}

pub(crate) fn request_of(value: Value) -> RenderRequest {
    serde_json::from_value(value).expect("the export request deserializes")
}

/// Runs one export to completion, silently.
pub(crate) fn export(
    source: &Path,
    output: &Path,
    narration: Option<&Path>,
    value: Value,
) -> Result<ExportSummary, ExportError> {
    run_export(
        ExportJob {
            request: request_of(value),
            source,
            narration,
            output,
            text: staged_text(1),
            cancel: ExportCancel::new(),
        },
        &mut SilentProgress,
    )
}

/// The conversion of `value` against what the synthetic clip really is.
pub(crate) fn converted_for(source: &Path, value: Value) -> ExportPlan {
    let info = probe_source(source).expect("the synthetic clip is readable");
    let duration_us =
        u64::try_from(info.duration_100ns() / 10).expect("a positive duration in microseconds");
    let plan = request_of(value)
        .validate(info.display_width(), info.display_height(), duration_us)
        .expect("the export request validates against the synthetic clip");
    ExportPlan::convert(&plan, &default_face()).expect("the request converts")
}

/// A renderer over the synthetic clip, for the tests that compare composed frames.
pub(crate) fn renderer_for(source: &Path, value: Value) -> FrameRenderer {
    let plan = converted_for(source, value);
    let scene = plan
        .compose(staged_text(1))
        .expect("the staged text composes");
    FrameRenderer::open(&plan, scene, source).expect("a GPU adapter and a readable source")
}

/// One `RGBA` pixel out of a tightly packed frame.
pub(crate) fn pixel_at(pixels: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let start = usize::try_from((y * width + x) * 4).expect("a small frame offset");
    pixels[start..start + 4]
        .try_into()
        .expect("four channels per pixel")
}

/// Decodes one frame back out of a finished export, through the same platform decoder the exporter
/// reads sources with.
///
/// The file's edges must both be multiples of 16. `osg-decode` refuses a file whose coded size the
/// platform decoder pads, reporting `SourceGeometryChanged`, so a caller that wants pixels back has
/// to compose at a size the encoder does not pad.
pub(crate) fn decoded_frame(path: &Path, index: u32, frames: u32) -> Vec<u8> {
    let timeline =
        FrameTimeline::new(SOURCE_FPS, 1, frames, ExactTime::ZERO).expect("a supported grid");
    let mut decoder =
        open_decoder(path, DecoderConfig::new(timeline)).expect("the export is decodable");
    let frame = decoder
        .frame_for_output(index)
        .expect("the export carries the frame the timeline names");
    decoder.close();
    frame.into_pixels()
}
