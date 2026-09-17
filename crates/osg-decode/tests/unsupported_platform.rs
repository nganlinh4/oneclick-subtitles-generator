//! Platforms without an audited backend fail loudly.
//!
//! The design note is explicit that a non-Windows target gets an `UnsupportedPlatform` error and not
//! a silent fallback to whatever decoder happens to be installed. When macOS gains an
//! `AVFoundation` backend it gets its own audited implementation behind the same trait, and this
//! test moves with it.

#![cfg(not(windows))]

use std::path::Path;

use osg_decode::{DecodeError, DecoderConfig, open_decoder};
use osg_scene::{ExactTime, FrameTimeline};

#[test]
fn opening_a_decoder_is_refused_rather_than_substituted() {
    let timeline = FrameTimeline::new(30, 1, 90, ExactTime::ZERO).expect("a supported timeline");
    let error = open_decoder(
        Path::new("/tmp/opaque-id.mp4"),
        DecoderConfig::new(timeline),
    )
    .expect_err("this platform has no audited backend");
    assert_eq!(error, DecodeError::UnsupportedPlatform);
}
