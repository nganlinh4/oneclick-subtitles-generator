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

use std::path::PathBuf;

use osg_audio::{AudioDecoder, AudioError};
use osg_export::{
    ExportCancel, ExportError, ExportJob, ExportProgress, ProgressFn, SilentProgress, probe_source,
    run_export,
};
use support::media::{
    SOURCE_FPS, export, export_request, platform, renderer_for, request_of, source_clip,
};
use support::staged_text;
use tempfile::TempDir;

/// The composition the exports produce: 360p against a 4:3 source.
const OUT_WIDTH: u32 = 480;
const OUT_HEIGHT: u32 = 360;
/// The narration fixture's rate and length.
const NARRATION_RATE: u32 = 48_000;
const NARRATION_FRAMES: usize = 3 * 48_000;

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
        (info.display_width(), info.display_height()),
        (OUT_WIDTH, OUT_HEIGHT)
    );
    assert_eq!(
        (info.decoded_width(), info.decoded_height()),
        (
            usize::try_from(OUT_WIDTH).expect("a small width"),
            usize::try_from(OUT_HEIGHT).expect("a small height")
        ),
        "an export writes square pixels and no rotation, so it decodes at the size it displays"
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
