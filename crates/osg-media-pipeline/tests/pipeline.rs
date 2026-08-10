use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use osg_media::{
    AudioBitrate, AudioOutput, BinarySearch, CancellationToken, ChannelCount, MediaEngine,
    MediaInput, MediaTimeRange, RunControl, ToolchainResolver,
};
use osg_media_pipeline::{MediaPipeline, PipelineError, PreparationOutcome, PreparedMediaKind};

fn pipeline() -> MediaPipeline {
    MediaPipeline::new(media_engine())
}

fn media_engine() -> MediaEngine {
    let binary = mock_binary();
    let tools = ToolchainResolver::new(
        BinarySearch::default()
            .configured_ffmpeg(&binary)
            .configured_ffprobe(binary),
    )
    .resolve()
    .expect("mock toolchain");
    MediaEngine::new(tools)
}

fn mock_binary() -> PathBuf {
    static MOCK: OnceLock<PathBuf> = OnceLock::new();
    MOCK.get_or_init(|| {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock_media_tool.rs");
        let output = std::env::temp_dir().join(if cfg!(windows) {
            format!("osg-media-pipeline-mock-{}.exe", std::process::id())
        } else {
            format!("osg-media-pipeline-mock-{}", std::process::id())
        });
        let status = Command::new("rustc")
            .args([
                source.as_os_str(),
                "--edition=2024".as_ref(),
                "-O".as_ref(),
                "-o".as_ref(),
                output.as_os_str(),
            ])
            .status()
            .expect("rustc");
        assert!(status.success());
        output
    })
    .clone()
}

fn input(directory: &tempfile::TempDir, name: &str) -> MediaInput {
    let path = directory.path().join(name);
    std::fs::write(&path, b"media").expect("fixture");
    MediaInput::from_native_selection(path).expect("media input")
}

fn control() -> RunControl {
    RunControl::new(Duration::from_secs(5)).expect("run control")
}

#[test]
fn compatible_video_stays_zero_copy() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let outcome = pipeline()
        .prepare_playback(input(&directory, "video.mp4"), &control())
        .expect("prepare");
    assert!(matches!(outcome, PreparationOutcome::Direct(_)));
}

#[test]
fn incompatible_codec_container_is_transcoded_to_portable_mp4() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let outcome = pipeline()
        .prepare_playback(input(&directory, "incompatible.webm"), &control())
        .expect("prepare");
    let PreparationOutcome::Prepared(prepared) = outcome else {
        panic!("incompatible media must be prepared");
    };
    assert_eq!(prepared.kind(), PreparedMediaKind::CompatibilityConversion);
    assert_eq!(prepared.extension(), "mp4");
    assert!(prepared.path().is_file());
    assert!(!format!("{prepared:?}").contains(directory.path().to_string_lossy().as_ref()));
}

#[test]
fn audio_only_media_gets_legacy_black_video_canvas() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let outcome = pipeline()
        .prepare_playback(input(&directory, "audio.mp3"), &control())
        .expect("prepare");
    let PreparationOutcome::Prepared(prepared) = outcome else {
        panic!("audio must get a video canvas");
    };
    assert_eq!(prepared.kind(), PreparedMediaKind::AudioVisualization);
    assert!(prepared.metadata().primary_video().is_some());
    assert!(prepared.metadata().primary_audio().is_some());
}

#[test]
fn staged_media_is_removed_unless_a_durable_store_publishes_it() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let outcome = pipeline()
        .prepare_playback(input(&directory, "incompatible.webm"), &control())
        .expect("prepare");
    let PreparationOutcome::Prepared(prepared) = outcome else {
        panic!("prepared media");
    };
    let staged = prepared.path().to_owned();
    let root = prepared.staging_root().to_owned();
    drop(prepared);
    assert!(!staged.exists());
    assert!(!root.exists());
}

#[test]
fn extraction_and_waveform_cover_audio_presence_and_bounded_output() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let pipeline = pipeline();
    let extracted = pipeline
        .extract_audio(
            input(&directory, "video.mp4"),
            AudioOutput::Mp3 {
                bitrate: AudioBitrate::new(128).expect("bitrate"),
            },
            MediaTimeRange::new(500_000, Some(2_000_000)).expect("range"),
            &control(),
        )
        .expect("extract audio");
    assert_eq!(extracted.kind(), PreparedMediaKind::AudioExtraction);
    assert_eq!(extracted.extension(), "mp3");

    let waveform = pipeline
        .generate_waveform(
            input(&directory, "audio.wav"),
            100,
            1_000,
            MediaTimeRange::default(),
            &control(),
        )
        .expect("waveform");
    assert!(!waveform.waveform.levels.is_empty());
    assert!(waveform.waveform.levels[0].points.len() <= 1_000);

    let missing = pipeline.extract_audio(
        input(&directory, "video-no-audio.mp4"),
        AudioOutput::WavPcm16 {
            sample_rate: osg_media::AudioSampleRate::new(16_000).expect("sample rate"),
            channels: ChannelCount::new(1).expect("channels"),
        },
        MediaTimeRange::default(),
        &control(),
    );
    assert!(matches!(missing, Err(PipelineError::MissingAudio)));
}

#[test]
fn analysis_clip_materializes_video_or_audio_and_rejects_range_drift() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let pipeline = pipeline();
    let range = MediaTimeRange::new(500_000, Some(1_500_000)).expect("range");

    let video = pipeline
        .clip_for_analysis(input(&directory, "video.mp4"), range, &control())
        .expect("video clip");
    assert_eq!(video.kind(), PreparedMediaKind::AnalysisClip);
    assert_eq!(video.extension(), "mp4");
    assert!(video.path().is_file());

    let audio = pipeline
        .clip_for_analysis(input(&directory, "audio.mp3"), range, &control())
        .expect("audio clip");
    assert_eq!(audio.extension(), "mp3");
    let audio_path = audio.path().to_owned();
    drop(audio);
    assert!(!audio_path.exists(), "unpublished clip must not survive");

    let outside = MediaTimeRange::new(3_500_000, Some(1_000_000)).expect("range syntax");
    assert!(matches!(
        pipeline.clip_for_analysis(input(&directory, "another.mp4"), outside, &control()),
        Err(PipelineError::InvalidClipRange)
    ));
}

#[test]
fn analysis_clip_honors_cancellation_before_publication() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let cancellation = CancellationToken::default();
    let run_control = RunControl::new(Duration::from_secs(10))
        .expect("control")
        .with_cancellation(cancellation.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        cancellation.cancel();
    });
    let result = pipeline().clip_for_analysis(
        input(&directory, "hang.mp4"),
        MediaTimeRange::new(0, Some(1_000_000)).expect("range"),
        &run_control,
    );
    assert!(matches!(
        result,
        Err(PipelineError::Media(osg_media::MediaError::Cancelled(_)))
    ));
}

#[test]
fn cancellation_is_bounded_and_kills_the_native_process_group() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let cancellation = CancellationToken::default();
    let run_control = RunControl::new(Duration::from_secs(10))
        .expect("control")
        .with_cancellation(cancellation.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        cancellation.cancel();
    });
    let started = Instant::now();
    let result = pipeline().prepare_playback(input(&directory, "hang.mp4"), &run_control);
    assert!(matches!(
        result,
        Err(PipelineError::Media(osg_media::MediaError::Cancelled(_)))
    ));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn native_paths_support_unicode_and_shell_metacharacters_on_every_os() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let outcome = pipeline()
        .prepare_playback(input(&directory, "한글 ; $(literal).webm"), &control())
        .expect("metacharacters remain one native argument");
    assert!(matches!(outcome, PreparationOutcome::Direct(_)));
}

#[test]
fn managed_staging_reconciles_crash_leftovers_but_refuses_unknown_trees() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let staging = directory.path().join("pipeline-staging");
    let pipeline = MediaPipeline::with_staging_root(media_engine(), &staging).expect("staging");
    drop(pipeline);

    let stale = staging.join("job-stale-after-crash");
    std::fs::create_dir(&stale).expect("stale job directory");
    std::fs::write(stale.join("prepared.mp4"), b"partial").expect("partial output");
    let recovered =
        MediaPipeline::with_staging_root(media_engine(), &staging).expect("reconcile stale job");
    assert!(!stale.exists());
    drop(recovered);

    let unknown = staging.join("job-unexpected");
    std::fs::create_dir(&unknown).expect("unknown job");
    std::fs::create_dir(unknown.join("nested")).expect("unexpected nested directory");
    assert!(MediaPipeline::with_staging_root(media_engine(), &staging).is_err());
    assert!(
        unknown.exists(),
        "unknown tree must fail closed, not be deleted"
    );
}
