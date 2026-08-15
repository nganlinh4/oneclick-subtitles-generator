#![recursion_limit = "256"]

//! Real end-to-end exports against the platform's own codecs and a real GPU adapter.
//!
//! Nothing here is a fixture somebody generated once and checked in. The source clip is encoded by
//! `osg-encode` through Media Foundation, exported through the whole native pipeline, and read back
//! through `osg-decode`, so every stage is proven against the others rather than against a file.
//!
//! These tests deliberately do **not** skip when Media Foundation or a GPU adapter is unavailable.
//! A silent skip would leave a green suite that has never exported anything, which is precisely the
//! state this crate exists to make impossible: every `expect` below turns a missing platform codec
//! or adapter into a failed test.

#![cfg(windows)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use osg_audio::{AudioDecoder, AudioError};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
use osg_export::{
    ExportCancel, ExportError, ExportJob, ExportPlan, ExportProgress, FrameRenderer, ProgressFn,
    SilentProgress, probe_source, run_export,
};
use osg_render::RenderRequest;
use serde_json::{Value, json};
use support::{default_face, request_json, staged_text};
use tempfile::TempDir;

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
static PLATFORM: Mutex<()> = Mutex::new(());

/// Takes the platform lock, ignoring poisoning so one failing test does not fail the rest.
fn platform() -> MutexGuard<'static, ()> {
    PLATFORM.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The synthetic source clip: small, deterministic, and long enough to trim inside.
const SOURCE_WIDTH: u32 = 320;
const SOURCE_HEIGHT: u32 = 240;
const SOURCE_FPS: u32 = 30;
const SOURCE_FRAMES: u32 = 90;

/// The composition the exports produce: 360p against a 4:3 source.
const OUT_WIDTH: u32 = 480;
const OUT_HEIGHT: u32 = 360;

/// The narration fixture's rate and length.
const NARRATION_RATE: u32 = 48_000;
const NARRATION_FRAMES: usize = 3 * 48_000;

/// A deterministic `RGBA8` frame of four flat grey quadrants. No RNG and no clock.
///
/// Flat blocks on purpose: they survive compression well enough to be read back as a number, and a
/// neutral grey isolates the luma range, which is the thing that has to survive the round trip.
fn synthetic_frame(index: u32) -> Vec<u8> {
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
fn source_clip(directory: &TempDir, name: &str) -> PathBuf {
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

/// A three-second mono 16-bit `PCM` `WAV`, generated from the sample index alone.
fn narration_clip(directory: &TempDir, name: &str) -> PathBuf {
    let output = directory.path().join(name);
    let mut samples = Vec::with_capacity(NARRATION_FRAMES * 2);
    for index in 0..NARRATION_FRAMES {
        // A triangle from the index: audible, bounded, and identical on every machine.
        let phase = i32::try_from(index % 100).expect("a small remainder") - 50;
        let value = i16::try_from(phase * 300).expect("the peak stays inside a sample");
        samples.extend_from_slice(&value.to_le_bytes());
    }
    let mut bytes = Vec::with_capacity(44 + samples.len());
    let data_len = u32::try_from(samples.len()).expect("the fixture is small");
    let byte_rate = NARRATION_RATE * 2;
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1_u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&NARRATION_RATE.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&16_u16.to_le_bytes()); // bits per sample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend_from_slice(&samples);
    std::fs::write(&output, &bytes).expect("the narration fixture is written");
    output
}

/// The fixture request, retargeted at the synthetic clip.
fn export_request(trim_start_us: u64, trim_end_us: u64) -> Value {
    let mut value = request_json();
    value["settings"]["resolution"] = json!("360p");
    value["settings"]["trimStartUs"] = json!(trim_start_us);
    value["settings"]["trimEndUs"] = json!(trim_end_us);
    // No fade window, so a frame is either fully inside a cue's hold or fully outside it. That
    // removes every knife-edge from the comparisons below without changing what is being compared.
    value["customization"]["fadeInDuration"] = json!(0);
    value["customization"]["fadeOutDuration"] = json!(0);
    // Large enough that the drawn cue covers an unmistakable number of pixels at 360p.
    value["customization"]["fontSize"] = json!(96);
    value["lyrics"] = json!([{"id":"cue-1","startUs":1_200_000,"endUs":1_700_000,"text":"A"}]);
    value
}

fn request_of(value: Value) -> RenderRequest {
    serde_json::from_value(value).expect("the export request deserializes")
}

fn export(
    source: &Path,
    output: &Path,
    narration: Option<&Path>,
    value: Value,
) -> Result<osg_export::ExportSummary, ExportError> {
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

fn renderer_for(source: &Path, value: Value) -> FrameRenderer {
    let info = probe_source(source).expect("the synthetic clip is readable");
    let width = u32::try_from(info.width()).expect("a small width");
    let height = u32::try_from(info.height()).expect("a small height");
    let duration_us =
        u64::try_from(info.duration_100ns() / 10).expect("a positive duration in microseconds");
    let plan = request_of(value)
        .validate(width, height, duration_us)
        .expect("the export request validates against the synthetic clip");
    let plan = ExportPlan::convert(&plan, &default_face()).expect("the request converts");
    let scene = plan
        .compose(staged_text(1))
        .expect("the staged text composes");
    FrameRenderer::open(&plan, scene, source).expect("a GPU adapter and a readable source")
}

#[test]
fn an_export_produces_a_playable_mp4_with_the_frames_and_duration_the_timeline_names() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "source.mp4");
    let output = directory.path().join("export.mp4");

    let summary = export(&source, &output, None, export_request(0, 2_000_000))
        .expect("the whole pipeline runs end to end");

    assert_eq!(summary.frames(), 60, "two seconds at 30fps is sixty frames");
    assert_eq!((summary.width(), summary.height()), (OUT_WIDTH, OUT_HEIGHT));
    assert!(summary.file_bytes() > 0, "the export is empty");
    assert!(output.is_file(), "the export produced no file");

    // Playable is not "the file exists": the platform decoder has to open it and agree about what
    // it carries. This is also the DURATION_SOURCE assertion at the far end of the pipeline — the
    // written length is the timeline's, not however many frames a decode happened to produce.
    let info = probe_source(&output).expect("the export is a file the platform can decode");
    assert_eq!(
        (info.width(), info.height()),
        (
            usize::try_from(OUT_WIDTH).expect("a small width"),
            usize::try_from(OUT_HEIGHT).expect("a small height")
        )
    );
    assert_eq!(info.nominal_frame_count(), 60);
    let one_frame = 10_000_000 / i64::from(SOURCE_FPS);
    assert!(
        (info.duration_100ns() - 20_000_000).abs() < one_frame,
        "the export declares {} units where two seconds is 20_000_000",
        info.duration_100ns()
    );
    println!(
        "exported {}x{}, {} frames, {} bytes, {} units",
        summary.width(),
        summary.height(),
        summary.frames(),
        summary.file_bytes(),
        info.duration_100ns(),
    );
}

#[test]
fn a_trimmed_export_shows_at_every_frame_exactly_what_an_untrimmed_one_shows_at_that_instant() {
    let _platform = platform();
    // The `trimStart` parity decision, proven at the pixel rather than at the contract. Trimmed
    // frame `i` and untrimmed frame `i + 30` name the same absolute instant, so they must be the
    // same picture: the same source frame, and the cue at the same point in its own life. The
    // shipped renderer fails this by a whole second of subtitle.
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "trim.mp4");

    let mut trimmed = renderer_for(&source, export_request(1_000_000, 2_000_000));
    let mut whole = renderer_for(&source, export_request(0, 2_000_000));
    assert_eq!(trimmed.frame_count(), 30);
    assert_eq!(whole.frame_count(), 60);

    // Frames inside the cue's hold and frames with no cue at all, and none on a boundary.
    for index in [0_u32, 3, 12, 20, 25, 29] {
        let near = trimmed.frame(index).expect("a trimmed frame");
        let far = whole.frame(index + 30).expect("an untrimmed frame");
        assert_eq!(
            near.pixels(),
            far.pixels(),
            "trimmed frame {index} differs from untrimmed frame {}",
            index + 30
        );
    }

    // The comparison is only meaningful if the cue is actually drawn somewhere in that range.
    let with_cue = trimmed.frame(12).expect("a frame inside the cue");
    let without = trimmed.frame(0).expect("a frame before the cue");
    assert_ne!(
        with_cue.pixels(),
        without.pixels(),
        "no cue was drawn, so the comparison above proves nothing"
    );
}

#[test]
fn composing_a_frame_directly_and_reaching_it_by_walking_produce_the_same_bytes() {
    let _platform = platform();
    // The determinism contract. It binds the composited frames rather than the file, because an
    // H.264 bitstream is not reproducible across vendors and driver versions.
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "deterministic.mp4");

    let mut walked = renderer_for(&source, export_request(0, 2_000_000));
    let mut sought = renderer_for(&source, export_request(0, 2_000_000));

    let mut last = Vec::new();
    for index in 0..=45 {
        last = walked.frame(index).expect("a walked frame").into_pixels();
    }
    let direct = sought.frame(45).expect("a sought frame").into_pixels();
    assert_eq!(last, direct, "frame 45 differs between walking and seeking");

    // And twice from the same renderer, which is the property a re-render depends on.
    let again = sought
        .frame(45)
        .expect("the same frame again")
        .into_pixels();
    assert_eq!(direct, again, "frame 45 is not stable within one renderer");
    assert_eq!(
        direct.len(),
        usize::try_from(OUT_WIDTH * OUT_HEIGHT * 4).expect("a small frame")
    );
}

#[test]
fn an_export_with_a_narration_track_carries_audio_and_one_without_carries_none() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "audio-source.mp4");
    let narration = narration_clip(&directory, "narration.wav");

    let silent_output = directory.path().join("silent.mp4");
    let silent = export(&source, &silent_output, None, export_request(0, 2_000_000))
        .expect("a source with no audio track exports as a silent file");
    assert_eq!(silent.audio_samples(), 0);
    assert!(
        matches!(
            AudioDecoder::open_path(&silent_output),
            Err(AudioError::NoAudioTrack)
        ),
        "a silent export must carry no audio stream at all"
    );

    let voiced_output = directory.path().join("voiced.mp4");
    let voiced = export(
        &source,
        &voiced_output,
        Some(&narration),
        export_request(1_000_000, 2_000_000),
    )
    .expect("a narration track is mixed into the export");
    // One second at 48 kHz, taken from the same trim window the subtitles were rebased onto.
    assert_eq!(voiced.audio_samples(), 48_000);
    assert_eq!(voiced.clipped_samples(), 0, "the fixture must not clip");
    assert!(voiced.audio_peak() > 0.0, "the narration was not audible");
    AudioDecoder::open_path(&voiced_output).expect("the export carries a decodable audio track");
}

#[test]
fn a_cancelled_export_leaves_nothing_behind() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "cancel-source.mp4");

    // Cancelled before the first frame.
    let early_output = directory.path().join("early.mp4");
    let cancel = ExportCancel::new();
    cancel.cancel();
    let error = run_export(
        ExportJob {
            request: request_of(export_request(0, 2_000_000)),
            source: &source,
            narration: None,
            output: &early_output,
            text: staged_text(1),
            cancel,
        },
        &mut SilentProgress,
    )
    .expect_err("a cancelled export must not report success");
    assert!(matches!(error, ExportError::Cancelled), "got {error}");
    assert!(
        !early_output.exists(),
        "a cancelled export left a container behind"
    );

    // Cancelled part way through, from the progress callback, which is how a UI would do it.
    let late_output = directory.path().join("late.mp4");
    let cancel = ExportCancel::new();
    let trigger = cancel.clone();
    let mut sink = ProgressFn(move |progress: ExportProgress| {
        if progress.permille() >= 500 {
            trigger.cancel();
        }
    });
    let error = run_export(
        ExportJob {
            request: request_of(export_request(0, 2_000_000)),
            source: &source,
            narration: None,
            output: &late_output,
            text: staged_text(1),
            cancel,
        },
        &mut sink,
    )
    .expect_err("a cancelled export must not report success");
    assert!(matches!(error, ExportError::Cancelled), "got {error}");
    assert!(
        !late_output.exists(),
        "a mid-export cancellation left a container behind"
    );
}

#[test]
fn an_export_never_clobbers_a_file_that_is_already_there() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "clobber-source.mp4");
    let output = directory.path().join("existing.mp4");
    std::fs::write(&output, b"not an export").expect("the decoy is written");

    let error = export(&source, &output, None, export_request(0, 2_000_000))
        .expect_err("an occupied output must be refused");
    assert!(
        matches!(error, ExportError::OutputUnwritable { .. }),
        "got {error}"
    );
    assert_eq!(
        std::fs::read(&output).expect("the decoy survives"),
        b"not an export",
        "the export overwrote a file it did not create"
    );
}

#[test]
fn progress_reaches_full_and_stays_bounded_over_a_real_export() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory, "progress-source.mp4");
    let output = directory.path().join("progress.mp4");

    let mut reports: Vec<ExportProgress> = Vec::new();
    let summary = run_export(
        ExportJob {
            request: request_of(export_request(0, 2_000_000)),
            source: &source,
            narration: None,
            output: &output,
            text: staged_text(1),
            cancel: ExportCancel::new(),
        },
        &mut ProgressFn(|progress: ExportProgress| reports.push(progress)),
    )
    .expect("the export runs");

    assert_eq!(summary.frames(), 60);
    assert!(!reports.is_empty(), "no progress was reported");
    assert!(
        reports.len() <= usize::try_from(osg_export::MAX_PROGRESS_REPORTS).expect("a small bound"),
        "{} reports is past the bound",
        reports.len()
    );
    assert!(
        reports
            .windows(2)
            .all(|pair| pair[0].permille() <= pair[1].permille()),
        "progress went backwards"
    );
    let last = reports.last().expect("a last report");
    assert_eq!(last.stage(), osg_export::ExportStage::Finalizing);
    assert_eq!(last.permille(), 1_000);
    assert_eq!(last.frames_done(), 60);
}

#[test]
fn a_source_that_is_not_media_is_refused_without_naming_itself() {
    let _platform = platform();
    let directory = TempDir::new().expect("a temporary directory");
    let hostile = directory.path().join("hostile.mp4");
    let mut bytes = b"\x00\x00\x00\x18ftypmp42".to_vec();
    bytes.extend(std::iter::repeat_n(0xA5_u8, 64 * 1024));
    std::fs::write(&hostile, &bytes).expect("the hostile fixture is written");
    let output = directory.path().join("never.mp4");

    let error = export(&hostile, &output, None, export_request(0, 2_000_000))
        .expect_err("a file that is not media is refused");
    let rendered = error.to_string();
    assert!(!rendered.contains("hostile"), "the error named the file");
    assert!(!rendered.contains("C:"), "the error carried a path");
    assert!(!output.exists(), "a refused export left a container behind");
    println!("hostile source refused with: {error:?}");
}
