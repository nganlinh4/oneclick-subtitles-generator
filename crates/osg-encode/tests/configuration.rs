//! Configuration and output-path validation.
//!
//! Every bound is checked here rather than at a platform call, so an unsupported request is refused
//! with a named field instead of an opaque status code from three layers down.

use std::path::{Path, PathBuf};

use osg_encode::{
    AudioConfig, ConfigField, EncodeError, EncoderConfig, MAX_ENCODE_FRAME_COUNT, OutputRejection,
    VideoConfig, check_output_path, config,
};

fn assert_field(result: Result<VideoConfig, EncodeError>, field: ConfigField) {
    assert_eq!(result, Err(EncodeError::UnsupportedConfig { field }));
}

#[test]
fn a_typical_export_configuration_is_accepted() {
    let video = VideoConfig::new(1920, 1080, 30_000, 1_001, 1_800)
        .expect("1080p29.97 is a supported configuration")
        .with_bitrate_kbps(16_000)
        .expect("16 Mbit/s is in range")
        .with_keyframe_interval(60)
        .expect("60 frames is in range");

    assert_eq!(video.width(), 1920);
    assert_eq!(video.height(), 1080);
    assert_eq!(video.fps_numerator(), 30_000);
    assert_eq!(video.fps_denominator(), 1_001);
    assert_eq!(video.frame_count(), 1_800);
    assert_eq!(video.bitrate_kbps(), 16_000);
    assert_eq!(video.keyframe_interval(), 60);
}

#[test]
fn the_defaults_are_the_documented_ones() {
    let video = VideoConfig::new(1280, 720, 30, 1, 10).expect("a supported configuration");
    assert_eq!(video.bitrate_kbps(), config::DEFAULT_VIDEO_BITRATE_KBPS);
    assert_eq!(video.keyframe_interval(), config::DEFAULT_KEYFRAME_INTERVAL);
    // Bounded keyframe spacing is the point: an unbounded gap makes an exported file miserable to
    // scrub in the render tab.
    assert!(video.keyframe_interval() <= config::MAX_KEYFRAME_INTERVAL);
}

#[test]
fn dimensions_outside_the_range_are_refused_by_name() {
    assert_field(VideoConfig::new(14, 720, 30, 1, 10), ConfigField::Width);
    assert_field(VideoConfig::new(7682, 720, 30, 1, 10), ConfigField::Width);
    assert_field(VideoConfig::new(1280, 14, 30, 1, 10), ConfigField::Height);
    assert_field(VideoConfig::new(1280, 7682, 30, 1, 10), ConfigField::Height);
    // The bound is per edge, so a portrait 8K frame is accepted.
    assert!(VideoConfig::new(4320, 7680, 30, 1, 10).is_ok());
}

#[test]
fn odd_dimensions_are_refused() {
    // H.264 encodes 4:2:0 chroma at half resolution, so an odd edge has no representation.
    assert_field(VideoConfig::new(1281, 720, 30, 1, 10), ConfigField::Width);
    assert_field(VideoConfig::new(1280, 721, 30, 1, 10), ConfigField::Height);
}

#[test]
fn unsupported_frame_rates_and_counts_are_refused_by_name() {
    assert_field(
        VideoConfig::new(1280, 720, 0, 1, 10),
        ConfigField::FrameRate,
    );
    assert_field(
        VideoConfig::new(1280, 720, 30, 0, 10),
        ConfigField::FrameRate,
    );
    assert_field(
        VideoConfig::new(1280, 720, 240_000, 1_001, 10),
        ConfigField::FrameRate,
    );
    assert_field(
        VideoConfig::new(1280, 720, 30, 1, 0),
        ConfigField::FrameCount,
    );
    assert_field(
        VideoConfig::new(1280, 720, 30, 1, MAX_ENCODE_FRAME_COUNT + 1),
        ConfigField::FrameCount,
    );
    assert!(VideoConfig::new(1280, 720, 30, 1, MAX_ENCODE_FRAME_COUNT).is_ok());
}

#[test]
fn bitrate_and_keyframe_interval_are_bounded() {
    let video = VideoConfig::new(1280, 720, 30, 1, 10).expect("a supported configuration");
    assert_field(video.with_bitrate_kbps(0), ConfigField::VideoBitrate);
    assert_field(video.with_bitrate_kbps(99), ConfigField::VideoBitrate);
    assert_field(video.with_bitrate_kbps(200_001), ConfigField::VideoBitrate);
    assert!(video.with_bitrate_kbps(100).is_ok());
    assert!(video.with_bitrate_kbps(200_000).is_ok());

    assert_field(
        video.with_keyframe_interval(0),
        ConfigField::KeyframeInterval,
    );
    assert_field(
        video.with_keyframe_interval(601),
        ConfigField::KeyframeInterval,
    );
    assert!(video.with_keyframe_interval(1).is_ok());
    assert!(video.with_keyframe_interval(600).is_ok());
}

#[test]
fn the_frame_clock_matches_the_configuration() {
    let video = VideoConfig::new(1920, 1080, 60_000, 1_001, 120).expect("a supported rate");
    let clock = video.frame_clock().expect("the clock the config implies");
    assert_eq!(clock.frame_count(), 120);
    assert_eq!(clock.timestamp_100ns(0), Ok(0));
}

#[test]
fn audio_settings_the_platform_encoder_rejects_are_refused_up_front() {
    assert!(AudioConfig::from_parts(48_000, 2, 192).is_ok());
    assert!(AudioConfig::from_parts(44_100, 1, 96).is_ok());

    assert_eq!(
        AudioConfig::from_parts(32_000, 2, 192),
        Err(EncodeError::UnsupportedConfig {
            field: ConfigField::AudioSampleRate,
        })
    );
    assert_eq!(
        AudioConfig::from_parts(48_000, 6, 192),
        Err(EncodeError::UnsupportedConfig {
            field: ConfigField::AudioChannels,
        })
    );
    assert_eq!(
        AudioConfig::from_parts(48_000, 2, 320),
        Err(EncodeError::UnsupportedConfig {
            field: ConfigField::AudioBitrate,
        })
    );
}

#[test]
fn audio_derives_the_numbers_the_platform_asks_for() {
    let audio = AudioConfig::from_parts(48_000, 2, 192).expect("a supported configuration");
    assert_eq!(audio.sample_rate().hz(), 48_000);
    assert_eq!(audio.channels().count(), 2);
    assert_eq!(audio.bitrate().kbps(), 192);
    // The platform takes average *bytes* per second.
    assert_eq!(audio.bitrate().bytes_per_second(), 24_000);
    // Two channels of 32-bit float.
    assert_eq!(audio.input_block_align(), 8);
}

#[test]
fn an_encoder_config_carries_audio_only_when_it_is_asked_to() {
    let video = VideoConfig::new(1280, 720, 30, 1, 10).expect("a supported configuration");
    let silent = EncoderConfig::video_only(video);
    assert!(silent.audio().is_none());

    let audio = AudioConfig::from_parts(48_000, 2, 128).expect("a supported configuration");
    let with_sound = silent.with_audio(audio);
    assert_eq!(with_sound.audio(), Some(audio));
    assert_eq!(with_sound.video(), video);
}

fn absolute(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\exports\{name}"))
    } else {
        PathBuf::from(format!("/exports/{name}"))
    }
}

#[test]
fn an_absolute_mp4_path_is_accepted() {
    assert_eq!(check_output_path(&absolute("opaque-id.mp4")), Ok(()));
    assert_eq!(check_output_path(&absolute("OPAQUE-ID.MP4")), Ok(()));
}

#[test]
fn a_relative_path_is_refused() {
    assert_eq!(
        check_output_path(Path::new("exports/opaque-id.mp4")),
        Err(EncodeError::OutputUnusable {
            reason: OutputRejection::NotAbsolute,
        })
    );
}

#[test]
fn a_non_mp4_path_is_refused() {
    // The container is chosen by extension, so anything else would silently produce a different
    // format under an .mp4-shaped promise.
    assert_eq!(
        check_output_path(&absolute("opaque-id.mkv")),
        Err(EncodeError::OutputUnusable {
            reason: OutputRejection::NotMp4,
        })
    );
    assert_eq!(
        check_output_path(&absolute("opaque-id")),
        Err(EncodeError::OutputUnusable {
            reason: OutputRejection::NotMp4,
        })
    );
}

#[test]
fn an_overlong_path_is_refused() {
    let long = "a".repeat(40_000);
    assert_eq!(
        check_output_path(&absolute(&format!("{long}.mp4"))),
        Err(EncodeError::OutputUnusable {
            reason: OutputRejection::TooLong,
        })
    );
}

#[cfg(windows)]
#[test]
fn a_path_with_an_interior_nul_is_refused() {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt as _;

    // Everything past a NUL would be dropped at the wide-string boundary, so the encoder would
    // write to a different file than the caller named.
    let units: Vec<u16> = r"C:\exports\opaque"
        .encode_utf16()
        .chain(core::iter::once(0))
        .chain("-id.mp4".encode_utf16())
        .collect();
    let path = PathBuf::from(OsString::from_wide(&units));
    assert_eq!(
        check_output_path(&path),
        Err(EncodeError::OutputUnusable {
            reason: OutputRejection::InteriorNul,
        })
    );
}
