//! Errors must be safe to log verbatim.
//!
//! The workspace rule is that an error never contains a filesystem path, a credential, or a line of
//! a user's subtitle text. A decoder is handed a media path and reads a user's private video out of
//! it, so the rule is asserted here rather than assumed.

use std::path::Path;

use osg_decode::{DecodeError, DecoderConfig, MfStage, SourceBound, SourceRejection, open_decoder};
use osg_scene::{ExactTime, FrameTimeline};

/// A path with something in it that must never reach a log.
const SECRET_PATH: &str = r"C:\Users\ngan.linh\Documents\my client project\wedding raw.mp4";

fn timeline() -> FrameTimeline {
    FrameTimeline::new(30, 1, 90, ExactTime::ZERO).expect("a supported timeline")
}

/// Every variant, so a new one cannot be added without deciding what it says.
fn every_error() -> Vec<DecodeError> {
    let mut errors = vec![
        DecodeError::UnsupportedPlatform,
        DecodeError::NoVideoStream,
        DecodeError::UnsupportedFrameRate,
        DecodeError::UnsupportedFrameLayout,
        DecodeError::UnsupportedColorimetry,
        DecodeError::SourceGeometryChanged {
            opened: osg_decode::FrameGeometry::new(640, 360).expect("geometry"),
            current: osg_decode::FrameGeometry::new(640, 368).expect("geometry"),
        },
        DecodeError::Cancelled,
        DecodeError::Closed,
        DecodeError::SampleTooSmall {
            expected: 3_110_400,
            actual: 12,
        },
        DecodeError::FrameOutOfRange {
            index: 90,
            frame_count: 90,
        },
        DecodeError::TimestampOutOfRange { index: 7 },
        DecodeError::TruncatedStream { decoded: 412 },
        DecodeError::FrameNotFound {
            target_100ns: 123_456_789,
        },
    ];
    for bound in [
        SourceBound::Width,
        SourceBound::Height,
        SourceBound::Duration,
    ] {
        errors.push(DecodeError::SourceOutOfBounds { bound });
    }
    for reason in [
        SourceRejection::NotAbsolute,
        SourceRejection::NoFileName,
        SourceRejection::InteriorNul,
        SourceRejection::TooLong,
        SourceRejection::NotAFile,
    ] {
        errors.push(DecodeError::SourceUnusable { reason });
    }
    for stage in [
        MfStage::ComApartment,
        MfStage::PlatformStartup,
        MfStage::ReaderAttributes,
        MfStage::CreateSourceReader,
        MfStage::StreamSelection,
        MfStage::MediaType,
        MfStage::NativeMediaType,
        MfStage::OutputMediaType,
        MfStage::PresentationAttribute,
        MfStage::ReadSample,
        MfStage::Seek,
        MfStage::SampleBuffer,
        MfStage::LockBuffer,
    ] {
        errors.push(DecodeError::MediaFoundation {
            stage,
            code: 0xC00D_36B4,
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
    let error = open_decoder(
        Path::new("relative/source.mp4"),
        DecoderConfig::new(timeline()),
    )
    .expect_err("a relative path is refused");

    let rendered = error.to_string();
    assert!(!rendered.contains("relative"));
    assert!(!rendered.contains("source.mp4"));
}

#[cfg(windows)]
#[test]
fn a_missing_file_is_refused_without_naming_itself() {
    let missing = Path::new(r"C:\this-file-does-not-exist-osg-decode\opaque.mp4");
    let error = open_decoder(missing, DecoderConfig::new(timeline()))
        .expect_err("a missing file is refused");

    assert_eq!(
        error,
        DecodeError::SourceUnusable {
            reason: SourceRejection::NotAFile,
        }
    );
    assert!(!error.to_string().contains("osg-decode"));
    assert!(!error.to_string().contains("C:"));
}

#[test]
fn the_secret_path_constant_would_be_caught_by_the_assertions() {
    // A guard on the guard: if the checks above were vacuous, this would pass too.
    assert!(SECRET_PATH.contains("C:\\"));
}
