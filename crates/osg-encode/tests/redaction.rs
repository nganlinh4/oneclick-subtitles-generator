//! Errors must be safe to log verbatim.
//!
//! The workspace rule is that an error never contains a filesystem path, a credential, or a line of
//! a user's subtitle text. This crate is handed all three kinds of thing indirectly — an export
//! path, and the pixels a caption was rendered into — so the rule is asserted rather than assumed.

use std::path::Path;

use osg_encode::{
    ConfigField, EncodeError, EncoderConfig, MfStage, OutputRejection, VideoConfig, open_encoder,
};

/// A path with something in it that must never reach a log.
const SECRET_PATH: &str = r"C:\Users\ngan.linh\Documents\my client project\final cut.mp4";

/// Every variant, so a new one cannot be added without deciding what it says.
fn every_error() -> Vec<EncodeError> {
    let mut errors = vec![
        EncodeError::UnsupportedPlatform,
        EncodeError::Cancelled,
        EncodeError::AlreadyFinished,
        EncodeError::NoAudioStream,
        EncodeError::OutputUnmeasurable,
        EncodeError::FrameSizeMismatch {
            width: 1920,
            height: 1080,
            expected: 8_294_400,
            actual: 12,
        },
        EncodeError::FrameSizeUnexpected {
            expected_width: 1920,
            expected_height: 1080,
            width: 640,
            height: 480,
        },
        EncodeError::FrameOutOfOrder {
            expected: 7,
            actual: 9,
        },
        EncodeError::FrameOutOfRange {
            index: 12,
            frame_count: 10,
        },
        EncodeError::TimestampOutOfRange { index: 3 },
        EncodeError::AudioTimestampOutOfRange {
            sample_index: 48_000,
        },
        EncodeError::AudioBlockMisaligned {
            channels: 2,
            samples: 5,
        },
        EncodeError::AudioOutOfOrder {
            expected: 480,
            actual: 960,
        },
    ];
    for field in [
        ConfigField::Width,
        ConfigField::Height,
        ConfigField::FrameRate,
        ConfigField::FrameCount,
        ConfigField::VideoBitrate,
        ConfigField::KeyframeInterval,
        ConfigField::AudioSampleRate,
        ConfigField::AudioChannels,
        ConfigField::AudioBitrate,
    ] {
        errors.push(EncodeError::UnsupportedConfig { field });
    }
    for reason in [
        OutputRejection::NotAbsolute,
        OutputRejection::NotMp4,
        OutputRejection::NoFileName,
        OutputRejection::InteriorNul,
        OutputRejection::TooLong,
        OutputRejection::ParentMissing,
        OutputRejection::AlreadyExists,
    ] {
        errors.push(EncodeError::OutputUnusable { reason });
    }
    for stage in [
        MfStage::ComApartment,
        MfStage::PlatformStartup,
        MfStage::WriterAttributes,
        MfStage::CreateSinkWriter,
        MfStage::MediaType,
        MfStage::AddStream,
        MfStage::InputMediaType,
        MfStage::BeginWriting,
        MfStage::AllocateBuffer,
        MfStage::LockBuffer,
        MfStage::CreateSample,
        MfStage::WriteSample,
        MfStage::Finalize,
    ] {
        errors.push(EncodeError::MediaFoundation {
            stage,
            code: 0x8000_4005,
        });
    }
    errors
}

#[test]
fn no_error_message_can_carry_a_path() {
    for error in every_error() {
        let rendered = error.to_string();
        let debugged = format!("{error:?}");
        for text in [&rendered, &debugged] {
            assert!(
                !text.contains('\\'),
                "an error carries a path separator: {text}"
            );
            assert!(
                !text.contains("C:") && !text.contains("/Users/") && !text.contains("/home/"),
                "an error carries a path fragment: {text}"
            );
            assert!(!text.is_empty(), "an error must say something");
        }
    }
}

#[test]
fn refusing_a_path_never_repeats_the_path() {
    // The path is the caller's; it is refused, not echoed.
    let error = open_encoder(
        Path::new("relative/output.mp4"),
        EncoderConfig::video_only(
            VideoConfig::new(640, 480, 30, 1, 1).expect("a supported configuration"),
        ),
    )
    .expect_err("a relative path is refused");

    let rendered = error.to_string();
    assert!(!rendered.contains("relative"));
    assert!(!rendered.contains("output.mp4"));
}

#[cfg(windows)]
#[test]
fn a_path_that_cannot_be_opened_is_refused_without_naming_itself() {
    let missing_parent = Path::new(r"C:\this-directory-does-not-exist-osg-encode\opaque.mp4");
    let error = open_encoder(
        missing_parent,
        EncoderConfig::video_only(
            VideoConfig::new(640, 480, 30, 1, 1).expect("a supported configuration"),
        ),
    )
    .expect_err("a missing parent directory is refused");

    assert_eq!(
        error,
        EncodeError::OutputUnusable {
            reason: OutputRejection::ParentMissing,
        }
    );
    assert!(!error.to_string().contains("osg-encode"));
    assert!(!error.to_string().contains("C:"));
}

#[test]
fn the_secret_path_constant_would_be_caught_by_the_assertions() {
    // A guard on the guard: if the checks above were vacuous, this would pass too.
    assert!(SECRET_PATH.contains("C:\\"));
}
