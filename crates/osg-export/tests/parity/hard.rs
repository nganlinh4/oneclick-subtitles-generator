//! The cases the release requirement names by hand: dense, long, high-rate, voiced, cancelled,
//! restarted — every one of them a real export through the platform's own codecs.
//!
//! Nothing here is a fixture somebody generated once. The source clip is encoded by `osg-encode`
//! through Media Foundation on this machine, exported through the whole native pipeline, and read
//! back through `osg-decode`, so each stage is proven against the others.
//!
//! Two notes on what is and is not here:
//!
//! * **4K** is exercised by `every_output_shape_the_matrix_names_can_be_composed` in the suite root,
//!   which probes every shape the matrix names with its own throwaway device. Repeating it here
//!   would report the same finding twice.
//! * **Long duration** runs by default at [`DEFAULT_LONG_SECONDS`] and scales to any length through
//!   `OSG_PARITY_LONG=<seconds>`. A minute of video is a minute of encoding and does not belong in
//!   every `cargo test`, but a case that runs only when somebody sets a variable reports `ok`
//!   without exporting anything, so the default is a real export rather than a skip.

#![cfg(windows)]

use std::path::PathBuf;

use osg_audio::{AudioDecoder, AudioError};
use osg_export::{
    ExportCancel, ExportError, ExportJob, ExportProgress, ProgressFn, probe_source, run_export,
};
use osg_render::RenderRequest;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::case::{Case, WINDOW_US};
use super::compare;
use super::matrix;
use super::roundtrip::{self, REVIEWED};
use super::sweep;
use crate::support::media::SOURCE_FPS;

/// The environment variable that turns the long-duration case on, in seconds.
pub(crate) const LONG: &str = "OSG_PARITY_LONG";

/// The narration fixture's rate.
const NARRATION_RATE: u32 = 48_000;

/// A case at the matrix's default customization, one text and one shape.
fn case(id: &str, text_id: &str, resolution: &str, frame_rate: u16) -> Case {
    let matrix = matrix::load();
    Case::new(
        id,
        sweep::defaults(&matrix),
        matrix.text(text_id).text.clone(),
        resolution,
        frame_rate,
    )
}

/// One cue per `step` microseconds across the whole window, all carrying the same dense text.
fn dense_cues(text: &str, step_us: u64) -> Value {
    let mut cues = Vec::new();
    let mut start = 0_u64;
    let mut index = 0_usize;
    while start + step_us <= WINDOW_US {
        cues.push(json!({
            "id": format!("cue-{index}"),
            "startUs": start,
            "endUs": start + step_us,
            "text": text,
        }));
        start += step_us;
        index += 1;
    }
    Value::Array(cues)
}

#[test]
fn a_dense_cue_list_exports_every_frame_and_decodes_back_inside_the_tolerance() {
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let mut dense = case("hard=dense", "dense", "720p", 30);
    dense.lyrics = Some(dense_cues(&dense.text, 8_000));
    let cue_count = dense.cue_count();
    assert!(cue_count >= 100, "{cue_count} cues is not dense");

    let round = roundtrip::measure(&directory, &dense, &[3, 15, 27]);
    println!(
        "dense: {cue_count} cues, {}x{}, {} frames, {} bytes",
        round.width,
        round.height,
        round.frames,
        round.summary.file_bytes()
    );
    for (index, diff) in round.diffs() {
        println!("  frame {index}: {diff:?}");
        assert!(
            REVIEWED.admits(&diff),
            "{}",
            compare::report("hard=dense", index, &diff, &[], &[])
        );
    }
}

#[test]
fn a_high_frame_rate_export_writes_every_frame_the_timeline_names() {
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let fast = case("hard=60fps", "latin", "720p", 60);
    let round = roundtrip::measure(&directory, &fast, &[7, 31, 55]);
    assert_eq!(round.frames, 60, "one second at 60fps is sixty frames");
    assert_eq!(round.summary.frames(), 60);
    println!(
        "60fps: {}x{}, {} frames, {} bytes",
        round.width,
        round.height,
        round.frames,
        round.summary.file_bytes()
    );
    for (index, diff) in round.diffs() {
        assert!(
            REVIEWED.admits(&diff),
            "{}",
            compare::report("hard=60fps", index, &diff, &[], &[])
        );
    }
}

/// A mono 16-bit `PCM` `WAV` generated from the sample index alone, so it is the same everywhere.
fn narration_clip(directory: &TempDir, seconds: u32) -> PathBuf {
    let output = directory.path().join("narration.wav");
    let frames = (NARRATION_RATE * seconds) as usize;
    let mut samples = Vec::with_capacity(frames * 2);
    for index in 0..frames {
        let phase = i32::try_from(index % 100).expect("a small remainder") - 50;
        let value = i16::try_from(phase * 300).expect("the peak stays inside a sample");
        samples.extend_from_slice(&value.to_le_bytes());
    }
    let data_len = u32::try_from(samples.len()).expect("the fixture is small");
    let mut bytes = Vec::with_capacity(44 + samples.len());
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&NARRATION_RATE.to_le_bytes());
    bytes.extend_from_slice(&(NARRATION_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend_from_slice(&samples);
    std::fs::write(&output, &bytes).expect("the narration fixture is written");
    output
}

#[test]
fn a_voiced_export_carries_the_narration_and_a_silent_one_carries_no_stream() {
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let source = roundtrip::clip(&directory, "voiced-source.mp4");
    let narration = narration_clip(&directory, 3);
    let voiced = case("hard=narration", "latin", "720p", 30);
    let prepared = roundtrip::prepare_against(&source, &voiced);

    let silent_output = directory.path().join("silent.mp4");
    let silent = roundtrip::export(&source, &silent_output, None, &voiced, &prepared)
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
    let mixed = roundtrip::export(
        &source,
        &voiced_output,
        Some(&narration),
        &voiced,
        &prepared,
    )
    .expect("a narration track is mixed into the export");
    assert_eq!(
        mixed.audio_samples(),
        u64::from(NARRATION_RATE),
        "one second of window is one second of audio"
    );
    assert_eq!(mixed.clipped_samples(), 0, "the fixture must not clip");
    assert!(mixed.audio_peak() > 0.0, "the narration was not audible");
    AudioDecoder::open_path(&voiced_output).expect("the export carries a decodable audio track");
    println!(
        "narration: {} samples, peak {:.3}, {} bytes",
        mixed.audio_samples(),
        mixed.audio_peak(),
        mixed.file_bytes()
    );
}

#[test]
fn a_cancelled_export_leaves_nothing_and_the_restart_after_it_succeeds() {
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let source = roundtrip::clip(&directory, "restart-source.mp4");
    let restarted = case("hard=cancel-restart", "korean", "720p", 30);
    let prepared = roundtrip::prepare_against(&source, &restarted);
    let output = directory.path().join("restart.mp4");

    // Cancelled from the progress callback, which is how a user's cancel button reaches it.
    let cancel = ExportCancel::new();
    let trigger = cancel.clone();
    let mut sink = ProgressFn(move |progress: ExportProgress| {
        if progress.permille() >= 400 {
            trigger.cancel();
        }
    });
    let request: RenderRequest =
        serde_json::from_value(restarted.request()).expect("the case request deserializes");
    let error = run_export(
        ExportJob {
            request,
            source: &source,
            narration: None,
            output: &output,
            text: prepared.staged.text(1),
            cancel,
        },
        &mut sink,
    )
    .expect_err("a cancelled export must not report success");
    assert!(matches!(error, ExportError::Cancelled), "got {error}");
    assert!(
        !output.exists(),
        "a mid-export cancellation left a container behind, so the restart would refuse it"
    );

    // The restart: same request, same output location, no residue in the way.
    let summary = roundtrip::export(&source, &output, None, &restarted, &prepared)
        .expect("the export restarts cleanly after a cancellation");
    assert_eq!(summary.frames(), prepared.plan.frame_count());
    assert!(output.is_file(), "the restart produced no file");
    let info = probe_source(&output).expect("the restarted export is decodable");
    assert_eq!(
        info.nominal_frame_count(),
        u64::from(prepared.plan.frame_count())
    );
    println!(
        "cancel and restart: {} frames, {} bytes",
        summary.frames(),
        summary.file_bytes()
    );
}

/// How long the long-duration case runs for by default.
///
/// Five seconds is a hundred and fifty frames, which is five times every other case here and still
/// a few seconds of wall clock. It is deliberately not zero: a case that only runs when somebody
/// remembers an environment variable reports `ok` on every ordinary run without exporting anything,
/// which is exactly the shape of coverage that is not coverage.
const DEFAULT_LONG_SECONDS: u32 = 5;

/// How long the long-duration case runs for.
fn long_seconds() -> u32 {
    std::env::var(LONG)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_LONG_SECONDS)
}

#[test]
fn a_long_export_runs_end_to_end_and_scales_to_whatever_length_is_asked_for() {
    let seconds = long_seconds();
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let source = roundtrip::long_clip(&directory, "long-source.mp4", seconds);
    let mut long = case("hard=long", "vietnamese", "720p", 30);
    long.window_us = Some(u64::from(seconds) * 1_000_000);
    let prepared = roundtrip::prepare_against(&source, &long);
    let output = directory.path().join("long.mp4");

    let (summary, elapsed) = sweep::timed(|| {
        roundtrip::export(&source, &output, None, &long, &prepared)
            .expect("a long export runs to completion")
    });
    assert_eq!(summary.frames(), seconds * SOURCE_FPS);
    println!(
        "long: {seconds}s, {} frames, {} bytes, {:.2}s of wall clock",
        summary.frames(),
        summary.file_bytes(),
        elapsed.as_secs_f64()
    );
}
