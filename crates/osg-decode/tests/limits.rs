//! Bounds and path rules, checked before the platform is involved at all.
//!
//! The input is a file the product did not write. Everything here refuses something a container is
//! free to claim about itself, and all of it is pure, so a hostile declaration is proven refused
//! without having to build a hostile file.

use std::path::Path;

use osg_decode::error::SourceBound;
use osg_decode::{DecodeError, DecodeLimits, SourceRejection, check_source_path};

#[test]
fn the_shipped_bounds_accept_ordinary_video_and_refuse_the_absurd() {
    let limits = DecodeLimits::new();
    for (width, height) in [(640_u32, 480_u32), (1920, 1080), (3840, 2160), (7680, 4320)] {
        assert_eq!(limits.check_geometry(width, height), Ok(()));
    }
    // Beyond 8K in either axis. A container may declare it; nothing in this product can use it.
    assert_eq!(
        limits.check_geometry(7682, 1080),
        Err(DecodeError::SourceOutOfBounds {
            bound: SourceBound::Width,
        })
    );
    assert_eq!(
        limits.check_geometry(1920, 8000),
        Err(DecodeError::SourceOutOfBounds {
            bound: SourceBound::Height,
        })
    );
}

#[test]
fn an_odd_edge_is_a_layout_refusal_and_not_a_bound() {
    // Distinguished on purpose: an odd edge is not "too big", it is a frame 4:2:0 chroma cannot
    // describe, and reporting it as a bound would send someone looking for the wrong problem.
    assert_eq!(
        DecodeLimits::new().check_geometry(1921, 1080),
        Err(DecodeError::UnsupportedFrameLayout)
    );
}

#[test]
fn a_duration_beyond_six_hours_or_below_zero_is_refused() {
    let limits = DecodeLimits::new();
    assert_eq!(limits.check_duration(0), Ok(()));
    assert_eq!(limits.check_duration(6 * 3600 * 10_000_000), Ok(()));
    assert_eq!(
        limits.check_duration(6 * 3600 * 10_000_000 + 1),
        Err(DecodeError::SourceOutOfBounds {
            bound: SourceBound::Duration,
        })
    );
    // Not a short file: a file lying about itself.
    assert_eq!(
        limits.check_duration(-1),
        Err(DecodeError::SourceOutOfBounds {
            bound: SourceBound::Duration,
        })
    );
}

#[test]
fn a_caller_can_lower_a_bound_but_never_raise_one() {
    // A configuration mistake must not be able to widen what this build was audited for.
    let limits = DecodeLimits::new().with_max_dimensions(u32::MAX, u32::MAX);
    assert_eq!(limits.max_width(), 7680);
    assert_eq!(limits.max_height(), 7680);

    let limits = DecodeLimits::new().with_max_duration_100ns(i64::MAX);
    assert_eq!(limits.max_duration_100ns(), 6 * 3600 * 10_000_000);

    let limits = DecodeLimits::new().with_max_decode_walk(u32::MAX);
    assert_eq!(limits.max_decode_walk(), 30_000);

    let tightened = DecodeLimits::new().with_max_dimensions(640, 480);
    assert_eq!(tightened.max_width(), 640);
    assert_eq!(
        tightened.check_geometry(1920, 1080),
        Err(DecodeError::SourceOutOfBounds {
            bound: SourceBound::Width,
        })
    );
}

#[test]
fn a_relative_path_is_refused_before_the_platform_sees_it() {
    assert_eq!(
        check_source_path(Path::new("media/source.mp4")),
        Err(DecodeError::SourceUnusable {
            reason: SourceRejection::NotAbsolute,
        })
    );
}

#[cfg(windows)]
#[test]
fn an_absolute_path_passes_the_structural_check() {
    assert_eq!(
        check_source_path(Path::new(r"C:\media\opaque-id.mp4")),
        Ok(())
    );
    // The decoder does not care what a source is called; the extension is the encoder's contract,
    // not this one's.
    assert_eq!(check_source_path(Path::new(r"C:\media\opaque-id")), Ok(()));
}

#[cfg(not(windows))]
#[test]
fn an_absolute_path_passes_the_structural_check() {
    assert_eq!(check_source_path(Path::new("/media/opaque-id.mp4")), Ok(()));
}

#[test]
fn a_path_with_no_file_name_is_refused() {
    #[cfg(windows)]
    let root = Path::new(r"C:\");
    #[cfg(not(windows))]
    let root = Path::new("/");

    assert_eq!(
        check_source_path(root),
        Err(DecodeError::SourceUnusable {
            reason: SourceRejection::NoFileName,
        })
    );
}
