//! Full-range Rec.709, on both media types.
//!
//! Getting this wrong is silent: the export still encodes and still plays, it is just washed out
//! against the preview it is required to match. So the choice is asserted three ways — against the
//! documented enumerants, against the platform bindings, and against what the platform actually
//! stored on the two real media types.

use osg_encode::{
    Colorimetry, NOMINAL_RANGE_0_255, NOMINAL_RANGE_16_235, TRANSFER_MATRIX_BT709,
    VIDEO_PRIMARIES_BT709, full_range_bt709, studio_range_bt709,
};

#[test]
fn the_named_function_returns_full_range_bt709() {
    let colorimetry = full_range_bt709();
    assert_eq!(colorimetry, Colorimetry::FULL_RANGE_BT709);
    assert_eq!(colorimetry.nominal_range, NOMINAL_RANGE_0_255);
    assert_eq!(colorimetry.primaries, VIDEO_PRIMARIES_BT709);
    assert_eq!(colorimetry.transfer_matrix, TRANSFER_MATRIX_BT709);
}

#[test]
fn studio_range_is_distinct_and_named() {
    assert_eq!(NOMINAL_RANGE_16_235, 2);
    assert_eq!(studio_range_bt709(), Colorimetry::STUDIO_RANGE_BT709);
}

#[test]
fn the_nominal_range_is_the_full_one_and_not_the_studio_one() {
    // MFNominalRange_0_255 is 1 and MFNominalRange_16_235 is 2. Transposing them is the exact
    // mistake that compresses 0-255 into 16-235 and washes the export out.
    assert_eq!(NOMINAL_RANGE_0_255, 1);
    assert_ne!(NOMINAL_RANGE_0_255, 2);
}

#[cfg(windows)]
#[test]
fn the_platform_bindings_still_agree_with_our_constants() {
    use windows::Win32::Media::MediaFoundation::{
        MFNominalRange_0_255, MFVideoPrimaries_BT709, MFVideoTransferMatrix_BT709,
    };

    assert_eq!(
        u32::try_from(MFNominalRange_0_255.0).expect("a non-negative enumerant"),
        NOMINAL_RANGE_0_255
    );
    assert_eq!(
        u32::try_from(MFVideoPrimaries_BT709.0).expect("a non-negative enumerant"),
        VIDEO_PRIMARIES_BT709
    );
    assert_eq!(
        u32::try_from(MFVideoTransferMatrix_BT709.0).expect("a non-negative enumerant"),
        TRANSFER_MATRIX_BT709
    );
}

#[cfg(windows)]
#[test]
fn both_media_types_really_carry_full_range_bt709() {
    use osg_encode::{VideoConfig, read_back_video_media_types};

    let config = VideoConfig::new(1920, 1080, 30_000, 1_001, 60)
        .expect("a supported configuration")
        .with_bitrate_kbps(16_000)
        .expect("16 Mbit/s is in range")
        .with_keyframe_interval(45)
        .expect("45 frames is in range");

    let readback = read_back_video_media_types(config)
        .expect("Media Foundation must be available to assert the encoder's media types");

    // Both sides. Declaring only one lets the colour-conversion transform reintroduce the remap.
    assert_eq!(readback.encoded_colorimetry, full_range_bt709());
    assert_eq!(readback.uncompressed_colorimetry, full_range_bt709());
}

#[cfg(windows)]
#[test]
fn gpu_surface_input_is_full_range_but_its_h264_output_is_studio_range() {
    use osg_encode::{VideoConfig, read_back_gpu_video_media_types};

    let config = VideoConfig::new(1920, 1080, 30, 1, 60).expect("a supported configuration");
    let readback = read_back_gpu_video_media_types(config)
        .expect("Media Foundation must expose the GPU path media types");

    assert_eq!(readback.uncompressed_colorimetry, full_range_bt709());
    assert_eq!(readback.encoded_colorimetry, studio_range_bt709());
}

#[cfg(windows)]
#[test]
fn the_encoded_stream_settings_are_the_ones_the_design_requires() {
    use osg_encode::{VideoConfig, read_back_video_media_types};

    let config = VideoConfig::new(1280, 720, 30, 1, 60)
        .expect("a supported configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(60)
        .expect("60 frames is in range");

    let readback = read_back_video_media_types(config)
        .expect("Media Foundation must be available to assert the encoder's media types");

    // H.264 High profile.
    assert_eq!(readback.profile, 100);
    // Progressive on both types: MFVideoInterlace_Progressive is 2.
    assert_eq!(readback.encoded_interlace_mode, 2);
    assert_eq!(readback.uncompressed_interlace_mode, 2);
    // Bounded keyframe spacing, so scrubbing the export stays responsive.
    assert_eq!(readback.max_keyframe_spacing, 60);
    // Configurable bitrate, in bits per second.
    assert_eq!(readback.average_bitrate, 8_000_000);
    // A positive stride is a top-down frame, which is what the compositor reads back.
    assert_eq!(readback.default_stride, 1280 * 4);
}
