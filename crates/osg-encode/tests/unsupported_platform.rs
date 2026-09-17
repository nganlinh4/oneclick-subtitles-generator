//! Platforms without an audited backend fail loudly.
//!
//! The design note is explicit that a non-Windows target gets an `UnsupportedPlatform` error and
//! not a silent fallback to whatever encoder happens to be installed. When macOS gains an
//! `AVFoundation` backend it gets its own audited implementation behind the same trait, this test
//! moves with it.

#![cfg(not(windows))]

use std::path::Path;

use osg_encode::{EncodeError, EncoderConfig, VideoConfig, open_encoder};

#[test]
fn opening_an_encoder_is_refused_rather_than_substituted() {
    let config = EncoderConfig::video_only(
        VideoConfig::new(1920, 1080, 30, 1, 30).expect("a supported configuration"),
    );
    let error = open_encoder(Path::new("/tmp/opaque-id.mp4"), config)
        .expect_err("this platform has no audited backend");
    assert_eq!(error, EncodeError::UnsupportedPlatform);
}
