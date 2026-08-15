//! Frame and audio buffer validation, and the RGBA-to-BGRA conversion.
//!
//! No GPU and no media platform: these are the checks that run before a single byte reaches a
//! platform buffer, so they have to hold on their own.

use osg_encode::{
    AudioBitrate, AudioBlock, AudioConfig, ChannelCount, EncodeError, FrameBuffer, PixelLayout,
    SampleRate, pixels,
};

fn stereo_48k() -> AudioConfig {
    AudioConfig::new(
        SampleRate::Hz48000,
        ChannelCount::Stereo,
        AudioBitrate::Kbps192,
    )
}

#[test]
fn a_buffer_of_the_wrong_length_is_refused_before_it_is_read() {
    let short = vec![0_u8; 4 * 4 * 4 - 1];
    assert_eq!(
        FrameBuffer::new(&short, 4, 4, PixelLayout::Rgba8),
        Err(EncodeError::FrameSizeMismatch {
            width: 4,
            height: 4,
            expected: 64,
            actual: 63,
        })
    );

    let long = vec![0_u8; 4 * 4 * 4 + 1];
    assert!(FrameBuffer::new(&long, 4, 4, PixelLayout::Rgba8).is_err());

    let exact = vec![0_u8; 4 * 4 * 4];
    assert!(FrameBuffer::new(&exact, 4, 4, PixelLayout::Rgba8).is_ok());
}

#[test]
fn a_zero_dimension_is_refused() {
    let empty: [u8; 0] = [];
    assert_eq!(
        FrameBuffer::new(&empty, 0, 4, PixelLayout::Rgba8),
        Err(EncodeError::UnsupportedConfig {
            field: osg_encode::ConfigField::Width,
        })
    );
    assert_eq!(
        FrameBuffer::new(&empty, 4, 0, PixelLayout::Rgba8),
        Err(EncodeError::UnsupportedConfig {
            field: osg_encode::ConfigField::Height,
        })
    );
}

#[test]
fn required_bytes_is_width_times_height_times_four() {
    assert_eq!(pixels::required_bytes(1920, 1080), Ok(8_294_400));
    assert_eq!(pixels::required_bytes(7680, 4320), Ok(132_710_400));
    assert!(pixels::required_bytes(0, 1080).is_err());
}

#[test]
fn rgba_input_has_its_red_and_blue_exchanged() {
    // One pixel per corner of a 2x2 frame, each with a distinguishable channel.
    let rgba: Vec<u8> = vec![
        10, 20, 30, 40, // R=10 G=20 B=30 A=40
        50, 60, 70, 80, //
        90, 100, 110, 120, //
        130, 140, 150, 160,
    ];
    let frame = FrameBuffer::new(&rgba, 2, 2, PixelLayout::Rgba8).expect("a valid frame");
    let mut bgra = vec![0_u8; rgba.len()];
    frame.copy_as_bgra(&mut bgra).expect("the conversion fits");

    assert_eq!(
        bgra,
        vec![
            30, 20, 10, 40, // B=30 G=20 R=10 A=40
            70, 60, 50, 80, //
            110, 100, 90, 120, //
            150, 140, 130, 160,
        ]
    );
}

#[test]
fn bgra_input_is_copied_unchanged() {
    let bgra: Vec<u8> = (0..16).collect();
    let frame = FrameBuffer::new(&bgra, 2, 2, PixelLayout::Bgra8).expect("a valid frame");
    let mut destination = vec![0xAA_u8; bgra.len()];
    frame
        .copy_as_bgra(&mut destination)
        .expect("the conversion fits");
    assert_eq!(destination, bgra);
}

#[test]
fn the_conversion_writes_every_byte_of_its_destination() {
    let rgba = vec![1_u8; 8 * 8 * 4];
    let frame = FrameBuffer::new(&rgba, 8, 8, PixelLayout::Rgba8).expect("a valid frame");
    // Pre-filled with a sentinel: a partial write would leave some of it behind.
    let mut destination = vec![0xEE_u8; rgba.len()];
    frame
        .copy_as_bgra(&mut destination)
        .expect("the conversion fits");
    assert!(destination.iter().all(|byte| *byte == 1));
}

#[test]
fn the_conversion_refuses_a_destination_of_the_wrong_length() {
    let rgba = vec![0_u8; 2 * 2 * 4];
    let frame = FrameBuffer::new(&rgba, 2, 2, PixelLayout::Rgba8).expect("a valid frame");
    let mut too_small = vec![0_u8; rgba.len() - 4];
    assert!(frame.copy_as_bgra(&mut too_small).is_err());
    let mut too_large = vec![0_u8; rgba.len() + 4];
    assert!(frame.copy_as_bgra(&mut too_large).is_err());
}

#[test]
fn a_frame_keeps_the_dimensions_it_was_validated_against() {
    let rgba = vec![0_u8; 6 * 4 * 4];
    let frame = FrameBuffer::new(&rgba, 6, 4, PixelLayout::Rgba8).expect("a valid frame");
    assert_eq!(frame.width(), 6);
    assert_eq!(frame.height(), 4);
    assert_eq!(frame.layout(), PixelLayout::Rgba8);
    assert_eq!(frame.pixels().len(), 96);
}

#[test]
fn an_audio_block_must_be_whole_interleaved_frames() {
    let config = stereo_48k();
    let odd = [0.0_f32; 5];
    assert_eq!(
        AudioBlock::new(&odd, config),
        Err(EncodeError::AudioBlockMisaligned {
            channels: 2,
            samples: 5,
        })
    );

    let even = [0.0_f32; 6];
    let block = AudioBlock::new(&even, config).expect("a whole number of stereo frames");
    assert_eq!(block.frame_count(), 3);
    assert_eq!(block.byte_len(), 24);
}

#[test]
fn audio_is_packed_as_little_endian_floats() {
    let config = stereo_48k();
    let samples = [1.0_f32, -1.0, 0.5, 0.0];
    let block = AudioBlock::new(&samples, config).expect("a valid block");
    let mut bytes = vec![0_u8; block.byte_len()];
    block
        .copy_as_le_bytes(&mut bytes)
        .expect("the packing fits");

    let mut expected = Vec::with_capacity(16);
    for sample in samples {
        expected.extend_from_slice(&sample.to_le_bytes());
    }
    assert_eq!(bytes, expected);

    let mut wrong_length = vec![0_u8; block.byte_len() + 1];
    assert!(block.copy_as_le_bytes(&mut wrong_length).is_err());
}

#[test]
fn a_mono_block_accepts_any_length() {
    let config = AudioConfig::new(
        SampleRate::Hz44100,
        ChannelCount::Mono,
        AudioBitrate::Kbps128,
    );
    let samples = [0.25_f32; 7];
    let block = AudioBlock::new(&samples, config).expect("mono accepts any count");
    assert_eq!(block.frame_count(), 7);
}
