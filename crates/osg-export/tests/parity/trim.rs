//! Trimming, and the determinism claim that makes a trim safe.
//!
//! # What a trim has to mean
//!
//! `trimStart` is one of the two deliberate visible changes the ledger records: the shipped renderer
//! trims the video but passes cue timestamps absolute, so every subtitle in the exported file is
//! shifted by the trim. `crates/osg-export/src/convert/timeline.rs` rebases them instead — the scene
//! timeline starts at zero and a cue at absolute `t` lands at `t - trimStart` — so the exported file
//! shows what the editor showed.
//!
//! That claim has an exact form, and it is the one asserted here: **a trimmed export writes the
//! frames an untrimmed export of the same project produces at the same source instants.** Output
//! frame `n` of a window starting at `trimStart` shows source instant `trimStart + n/fps` with the
//! cue that is absolutely at that instant; output frame `trimStart*fps + n` of the untrimmed export
//! shows the same source instant with the same absolute cue. Different plans, different timelines,
//! different frame counts — and the same picture, byte for byte. A rebase that was skipped, applied
//! twice, or applied to the cues but not the decoder grid all break it in a way no single-export
//! test can see.
//!
//! Both halves are checked: the composed frames exactly, and the frames a real export **wrote**,
//! decoded back out of the finished `MP4` inside `roundtrip`'s own measured tolerance.
//!
//! # Seek equals play, through the decoder
//!
//! `sweep` already checks seek-against-play for a composed scene, where the only moving part is the
//! compositor. This checks it where it is actually hard: through `FrameRenderer`, which resolves
//! every request against the exact rational source timeline rather than trusting a seek. A frame
//! reached by walking the whole export up to it and the same frame asked for directly must be the
//! same bytes — including at a cue boundary, which is where a decoder that carried state between
//! frames, or a scene that accumulated one, would show it first.

#![cfg(windows)]

use osg_compositor::SubtitleScene;
use osg_export::{ExportPlan, FrameRenderer, StagedText};
use tempfile::TempDir;

use super::case::Case;
use super::compare;
use super::documents::{self, CUE_STEP_US, DocumentCase, FRAME_RATE, FRAMES_PER_CUE};
use super::matrix;
use super::roundtrip::{self, REVIEWED};
use crate::support::media::source_clip;

/// How many cues the trim case's document carries. Twenty cues of three frames is two seconds,
/// which fits inside the synthetic clip with room for the trim to move the window.
const CUES: usize = 20;
/// Where the trimmed export's window starts. Half a second is exactly fifteen frames, so the two
/// exports share a frame grid and the comparison is frame against frame rather than an interpolation.
const TRIM_START_US: u64 = 500_000;

/// The offset between the two exports' frame indices.
fn shift() -> u32 {
    u32::try_from(TRIM_START_US * u64::from(FRAME_RATE) / 1_000_000).expect("a bounded shift")
}

/// The frames of the trimmed export that are compared.
///
/// Two of them straddle a cue boundary and two are interior, because those fail differently: a
/// rebase that is off by a frame is invisible in the middle of a cue and obvious at its edge.
fn compared_frames() -> Vec<u32> {
    let boundary = u32::try_from(FRAMES_PER_CUE * 2).expect("a bounded frame index");
    vec![boundary - 1, boundary, 20, 44]
}

/// The plan and scene for one case, staged with the whole document.
fn compose(
    source: &std::path::Path,
    case: &Case,
    text: &StagedText,
) -> (ExportPlan, SubtitleScene) {
    let prepared = roundtrip::prepare_against(source, case);
    let scene = prepared
        .plan
        .compose(text.clone())
        .unwrap_or_else(|error| panic!("{}: the staged text does not compose: {error}", case.id));
    (prepared.plan, scene)
}

/// The trimmed case: the same absolute cue list, a window that starts later and ends in the same
/// place.
fn trimmed(document: &DocumentCase) -> Case {
    let mut case = document.case.clone();
    case.id = format!("{} trim={TRIM_START_US}", document.id);
    case.trim_start_us = TRIM_START_US;
    case.window_us =
        Some(u64::try_from(CUES).expect("a bounded cue count") * CUE_STEP_US - TRIM_START_US);
    case
}

#[test]
fn a_trimmed_export_writes_the_untrimmed_exports_frames_from_the_same_source_instants() {
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let loaded = matrix::load();
    let document = documents::cycled(&loaded, "trim=grid", CUES, "480p");
    let text = document.document.staged_text();
    let source = source_clip(&directory, "trim-source.mp4");

    let whole = document.case.clone();
    let part = trimmed(&document);
    let (whole_plan, whole_scene) = compose(&source, &whole, &text);
    let (part_plan, part_scene) = compose(&source, &part, &text);
    let offset = shift();
    assert_eq!(
        whole_plan.frame_count(),
        part_plan.frame_count() + offset,
        "the trim did not remove exactly the frames it names"
    );
    println!(
        "trim: {} frames untrimmed, {} frames from {TRIM_START_US}us, offset {offset}",
        whole_plan.frame_count(),
        part_plan.frame_count()
    );

    // The exact half: the same source instant, composed through two different plans.
    let mut untrimmed_renderer = FrameRenderer::open(&whole_plan, whole_scene, &source)
        .expect("a graphics adapter and a readable source");
    let mut trimmed_renderer = FrameRenderer::open(&part_plan, part_scene.clone(), &source)
        .expect("a graphics adapter and a readable source");
    let mut untrimmed_frames = Vec::new();
    for index in compared_frames() {
        let from_trimmed = frame(&mut trimmed_renderer, index, &part.id);
        let from_whole = frame(&mut untrimmed_renderer, index + offset, &whole.id);
        compare::assert_identical(
            &part.id,
            index,
            &from_whole,
            &from_trimmed,
            "a trimmed export must write the frame the untrimmed export produces at the same \
             source instant, with the same subtitle on it",
        );
        untrimmed_frames.push((index, from_whole));
    }
    untrimmed_renderer.close();
    trimmed_renderer.close();
    println!(
        "  {} frames agree exactly across the trim",
        untrimmed_frames.len()
    );

    // And the same claim about the frames a real export actually wrote, which is the only place the
    // encoder, the container timestamps and the decoder grid all take part.
    let output = directory.path().join("trimmed.mp4");
    let summary = roundtrip::export_text(&source, &output, None, &part, text.clone())
        .expect("the trimmed export runs to completion");
    assert_eq!(summary.frames(), part_plan.frame_count());
    for (index, composed) in &untrimmed_frames {
        let decoded = roundtrip::decoded(&output, *index, summary.frames(), u32::from(FRAME_RATE));
        let diff = compare::diff(composed, &decoded);
        println!(
            "  written frame {index}: differing {} of {}, mean {:.4}, p999 {}, max {}",
            diff.differing_pixels,
            diff.total_pixels,
            diff.mean_channel,
            diff.p999_channel,
            diff.max_channel
        );
        assert!(
            REVIEWED.admits(&diff),
            "the trimmed file's frame is not the untrimmed composition at the same source \
             instant\n{}",
            compare::report(&part.id, *index, &diff, &[], &[])
        );
    }
    println!("  {} bytes written", summary.file_bytes());
}

#[test]
fn seeking_to_a_frame_of_an_export_produces_the_same_pixels_as_playing_up_to_it() {
    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let loaded = matrix::load();
    let document = documents::cycled(&loaded, "seek=grid", CUES, "480p");
    let text = document.document.staged_text();
    let source = source_clip(&directory, "seek-source.mp4");
    let case = trimmed(&document);
    let (plan, scene) = compose(&source, &case, &text);

    // One frame in the middle of a cue and one on the first frame of the next, which is where a
    // decoder that carried state, or a scene that accumulated one, would diverge first.
    let boundary = u32::try_from(FRAMES_PER_CUE * 2).expect("a bounded frame index");
    for index in [20_u32, boundary] {
        let mut played = FrameRenderer::open(&plan, scene.clone(), &source)
            .expect("a graphics adapter and a readable source");
        let mut walked = Vec::new();
        for step in 0..=index {
            walked = frame(&mut played, step, &case.id);
        }
        played.close();

        let mut sought = FrameRenderer::open(&plan, scene.clone(), &source)
            .expect("a graphics adapter and a readable source");
        let direct = frame(&mut sought, index, &case.id);
        sought.close();

        compare::assert_identical(
            &case.id,
            index,
            &walked,
            &direct,
            "seeking to a frame of an export and playing up to it must produce the same picture",
        );
    }
    println!(
        "seek equals play at an interior frame and at a cue boundary, over {} frames",
        plan.frame_count()
    );
}

/// One composed frame, or the case identity and the refusal.
fn frame(renderer: &mut FrameRenderer, index: u32, id: &str) -> Vec<u8> {
    renderer
        .frame(index)
        .unwrap_or_else(|error| panic!("{id}: frame {index} was refused: {error}"))
        .into_pixels()
}
