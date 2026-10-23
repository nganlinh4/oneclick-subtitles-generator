//! Plan tests: typed arguments, fixed filters, and bounded inputs for every operation.

use super::*;
use crate::{CompatibilityProfile, MediaMetadata, parse_ffprobe_json};
use std::path::Path;

fn paths(extension: &str) -> (tempfile::TempDir, MediaInput, MediaOutput) {
    let directory = tempfile::tempdir().unwrap();
    let input_path = directory.path().join("input;$(unsafe).mp4");
    std::fs::write(&input_path, b"media").unwrap();
    let input = MediaInput::from_native_selection(&input_path).unwrap();
    let output = MediaOutput::within_root(
        directory.path().join(format!("output.{extension}")),
        directory.path(),
    )
    .unwrap();
    (directory, input, output)
}

fn incompatible_metadata() -> MediaMetadata {
    parse_ffprobe_json(
            br#"{"streams":[{"index":0,"codec_type":"video","codec_name":"vp9","width":1920,"height":1080,"pix_fmt":"yuv444p"},{"index":1,"codec_type":"audio","codec_name":"vorbis"}],"format":{"format_name":"webm","duration":"5"}}"#,
        )
        .unwrap()
}

#[test]
fn conversion_args_are_typed_and_keep_metacharacter_path_in_one_argument() {
    let (_directory, input, output) = paths("mp4");
    let decision = CompatibilityDecision::analyze(
        &incompatible_metadata(),
        CompatibilityProfile::PortableWebView,
    );
    let operation = MediaOperation::CompatibilityConversion(
        CompatibilityConversionPlan::new(
            input.clone(),
            output,
            &decision,
            ConversionOptions::default(),
            Some(5_000_000),
        )
        .unwrap(),
    );
    let args = operation.build_args(Path::new("staging.mp4"));
    let input_position = args.iter().position(|arg| arg == "-i").unwrap() + 1;
    assert_eq!(args[input_position], input.as_path().as_os_str());
    assert!(args.iter().any(|arg| arg == "libx264"));
    assert!(args.iter().any(|arg| arg == "aac"));
}

#[test]
fn asr_plan_is_fixed_mono_16khz_pcm() {
    let (_directory, input, output) = paths("wav");
    let operation = MediaOperation::AudioExtraction(
        AudioExtractionPlan::asr_wav(input, output, MediaTimeRange::default()).unwrap(),
    );
    let joined = operation
        .build_args(Path::new("staging.wav"))
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(joined.contains("-c:a pcm_s16le -ar 16000 -ac 1"));
}

#[test]
fn narration_mix_is_bounded_and_uses_sample_precise_closed_filters() {
    let directory = tempfile::tempdir().unwrap();
    let first_path = directory.path().join("first;$(private).wav");
    let second_path = directory.path().join("second.wav");
    std::fs::write(&first_path, b"audio").unwrap();
    std::fs::write(&second_path, b"audio").unwrap();
    let first = MediaInput::from_native_selection(&first_path).unwrap();
    let second = MediaInput::from_native_selection(&second_path).unwrap();
    let output =
        MediaOutput::within_root(directory.path().join("aligned.m4a"), directory.path()).unwrap();
    let operation = MediaOperation::NarrationMix(
        NarrationMixPlan::new(
            vec![
                NarrationMixClip::new(first.clone(), 0),
                NarrationMixClip::new(second.clone(), 1_234_567),
            ],
            output,
            AudioOutput::M4aAac {
                bitrate: AudioBitrate::new(192).unwrap(),
            },
            2_000_001,
        )
        .unwrap(),
    );
    let args = operation.build_args(Path::new("staging.m4a"));
    let inputs = args
        .windows(2)
        .filter(|pair| pair[0] == "-i")
        .map(|pair| pair[1].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        inputs,
        vec![
            first.as_path().as_os_str().to_owned(),
            second.as_path().as_os_str().to_owned(),
        ]
    );
    let graph = args
        .windows(2)
        .find(|pair| pair[0] == "-filter_complex")
        .map(|pair| pair[1].to_string_lossy())
        .unwrap();
    assert!(graph.contains("adelay=59259S:all=1"));
    assert!(graph.contains("apad=whole_len=96001"));
    assert!(graph.contains("atrim=end_sample=96001"));
    assert!(!graph.contains("private"));
    assert!(
        NarrationMixPlan::new(
            Vec::new(),
            MediaOutput::within_root(directory.path().join("empty.wav"), directory.path()).unwrap(),
            AudioOutput::WavPcm16 {
                sample_rate: AudioSampleRate::new(48_000).unwrap(),
                channels: ChannelCount::new(2).unwrap(),
            },
            1,
        )
        .is_err()
    );
}

#[test]
fn narration_audio_edit_uses_closed_sample_precise_filters() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source;$(private).wav");
    std::fs::write(&source_path, b"audio").unwrap();
    let input = MediaInput::from_native_selection(&source_path).unwrap();
    let output =
        MediaOutput::within_root(directory.path().join("edited.wav"), directory.path()).unwrap();
    let operation = MediaOperation::NarrationAudioEdit(
        NarrationAudioEditPlan::new(input, output, 250_001, 1_750_001, 3_000).unwrap(),
    );
    let args = operation.build_args(Path::new("staging.wav"));
    let filter = args
        .windows(2)
        .find(|pair| pair[0] == "-af")
        .map(|pair| pair[1].to_string_lossy())
        .unwrap();
    assert!(filter.contains("atrim=start_sample=12000:end_sample=84001"));
    assert!(filter.contains("atempo=2.000,atempo=1.500"));
    assert!(!filter.contains("private"));
    assert_eq!(operation.expected_duration_us(), Some(500_000));
}

#[test]
fn narration_audio_edit_rejects_invalid_ranges_speeds_and_formats() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.wav");
    std::fs::write(&source_path, b"audio").unwrap();
    let input = MediaInput::from_native_selection(&source_path).unwrap();
    let output =
        || MediaOutput::within_root(directory.path().join("edited.wav"), directory.path()).unwrap();
    assert!(NarrationAudioEditPlan::new(input.clone(), output(), 1, 1, 1_000).is_err());
    assert!(NarrationAudioEditPlan::new(input.clone(), output(), 0, 1_000, 249).is_err());
    let wrong =
        MediaOutput::within_root(directory.path().join("edited.mp3"), directory.path()).unwrap();
    assert!(NarrationAudioEditPlan::new(input, wrong, 0, 1_000, 1_000).is_err());
}

#[test]
fn audio_visualization_is_a_fixed_safe_legacy_compatible_canvas() {
    let (_directory, input, output) = paths("mp4");
    let operation = MediaOperation::AudioVisualization(
        AudioVisualizationPlan::new(input.clone(), output, Some(5_000_000)).unwrap(),
    );
    let args = operation.build_args(Path::new("staging.mp4"));
    let input_position = args.iter().position(|arg| arg == "-i").unwrap() + 1;
    assert_eq!(args[input_position], input.as_path().as_os_str());
    let joined = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(joined.contains("color=c=black:s=256x144:r=15"));
    assert!(joined.contains("-c:v libx264"));
    assert!(joined.contains("-c:a aac -b:a 128k"));
}

#[test]
fn video_clip_is_accurate_portable_and_requires_a_bounded_range() {
    let (_directory, input, output) = paths("mp4");
    let range = MediaTimeRange::new(1_250_000, Some(2_500_000)).unwrap();
    let operation = MediaOperation::VideoClip(
        VideoClipPlan::new(input, output, range, ConversionOptions::default()).unwrap(),
    );
    let joined = operation
        .build_args(Path::new("staging.mp4"))
        .iter()
        .map(|argument| argument.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(joined.contains("-ss 1.250000 -t 2.500000"));
    assert!(joined.contains("-c:v libx264"));
    assert!(joined.contains("-c:a aac"));
    assert!(joined.contains("-reset_timestamps 1"));

    let (_directory, input, output) = paths("mp4");
    assert!(
        VideoClipPlan::new(
            input,
            output,
            MediaTimeRange::default(),
            ConversionOptions::default()
        )
        .is_err()
    );
    assert!(MediaTimeRange::new(u64::MAX, Some(1)).is_err());
}

#[test]
fn waveform_density_is_capped_for_long_media() {
    let (_directory, input, output) = paths("pcm");
    let plan = WaveformPlan::new(
        input,
        output,
        Some(10 * 60 * 60 * 1_000_000),
        200,
        1_000_000,
        MediaTimeRange::default(),
    )
    .unwrap();
    assert!(plan.points_per_second() < 200);
    assert!(plan.sample_rate_hz() >= 400);
}
