//! Decoding real files, one per container the crate claims.
//!
//! WAV fixtures are synthesised by the test; the compressed ones are committed because they cannot
//! be produced without an encoder. Every claimed format is exercised here, and the one format that
//! is *not* supported — Opus — is exercised too, so its refusal stays a typed error rather than
//! quietly becoming silence.

mod support;

use osg_audio::{AudioDecoder, AudioError};
use support::{fixture, fixture_bytes, peak, rms, tone, wav_f32, wav_pcm16, write_temp};

/// Decode a whole track into one interleaved buffer.
fn decode_all(decoder: &mut AudioDecoder) -> Vec<f32> {
    let mut samples = Vec::new();
    while let Some(frames) = decoder.next_frames().expect("the fixture decodes") {
        samples.extend_from_slice(frames);
    }
    samples
}

#[test]
fn a_16_bit_wav_decodes_to_the_samples_it_was_built_from() {
    let expected = tone(48_000, 1, 4_800, 440.0, 0.5);
    let mut decoder =
        AudioDecoder::open_bytes(wav_pcm16(48_000, 1, &expected)).expect("the wav opens");
    assert_eq!(decoder.sample_rate(), 48_000);
    assert_eq!(decoder.channels(), 1);
    let pcm = decode_all(&mut decoder);
    assert_eq!(pcm.len(), expected.len());
    for (index, (actual, wanted)) in pcm.iter().zip(&expected).enumerate() {
        assert!(
            (actual - wanted).abs() < 1e-4,
            "sample {index}: {actual} vs {wanted}"
        );
    }
}

#[test]
fn a_float_wav_decodes_bit_exactly() {
    let expected = tone(44_100, 2, 2_205, 220.0, 0.75);
    let mut decoder =
        AudioDecoder::open_bytes(wav_f32(44_100, 2, &expected)).expect("the wav opens");
    assert_eq!(decoder.sample_rate(), 44_100);
    assert_eq!(decoder.channels(), 2);
    let pcm = decode_all(&mut decoder);
    assert_eq!(pcm.len(), expected.len());
    for (actual, wanted) in pcm.iter().zip(&expected) {
        assert_eq!(actual.to_bits(), wanted.to_bits());
    }
}

#[test]
fn a_wav_opens_from_a_path_as_well_as_from_bytes() {
    let samples = tone(48_000, 1, 480, 1_000.0, 0.25);
    let path = write_temp("path-open.wav", &wav_pcm16(48_000, 1, &samples));
    let mut decoder = AudioDecoder::open_path(&path).expect("the wav opens from a path");
    assert_eq!(decoder.sample_rate(), 48_000);
    assert_eq!(decode_all(&mut decoder).len(), samples.len());
    drop(std::fs::remove_file(&path));
}

/// Every committed fixture is a quarter second of 440 Hz at half scale, so a correct decode has an
/// RMS near `0.5 / sqrt(2)` and a peak near 0.5.
fn assert_is_the_committed_tone(name: &str, rate: u32) {
    let mut decoder = AudioDecoder::open_bytes(fixture_bytes(name)).expect("the fixture opens");
    assert_eq!(decoder.sample_rate(), rate, "{name} sample rate");
    assert_eq!(decoder.channels(), 1, "{name} channel count");
    let pcm = decode_all(&mut decoder);
    let expected_frames = usize::try_from(rate).expect("the rate fits") / 4;
    assert!(
        pcm.len() >= expected_frames,
        "{name} decoded {} frames, expected at least {expected_frames}",
        pcm.len()
    );
    // Codec delay padding sits at the start; measure the settled middle.
    let middle = &pcm[expected_frames / 4..expected_frames];
    let level = rms(middle);
    assert!(
        (level - 0.353).abs() < 0.05,
        "{name} rms {level}, expected about 0.353"
    );
    let loudest = peak(middle);
    assert!(
        (0.4..=0.6).contains(&loudest),
        "{name} peak {loudest}, expected about 0.5"
    );
}

#[test]
fn mp3_decodes() {
    assert_is_the_committed_tone("tone_mono_48k.mp3", 48_000);
}

#[test]
fn aac_in_mp4_decodes() {
    assert_is_the_committed_tone("tone_mono_48k_aac.m4a", 48_000);
}

#[test]
fn flac_decodes() {
    assert_is_the_committed_tone("tone_mono_44k1.flac", 44_100);
}

#[test]
fn vorbis_in_ogg_decodes() {
    assert_is_the_committed_tone("tone_mono_48k_vorbis.ogg", 48_000);
}

#[test]
fn vorbis_in_webm_decodes() {
    assert_is_the_committed_tone("tone_mono_48k_vorbis.webm", 48_000);
}

#[test]
fn a_fixture_opens_by_path_with_its_extension_as_a_hint() {
    let mut decoder =
        AudioDecoder::open_path(&fixture("tone_mono_44k1.flac")).expect("the flac opens");
    assert_eq!(decoder.sample_rate(), 44_100);
    assert!(!decode_all(&mut decoder).is_empty());
}

fn video_fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../osg-decode/tests/fixtures")
        .join(name)
}

#[test]
fn a_movie_selects_its_audio_track_instead_of_its_first_video_track() {
    // This committed MP4 is ordered exactly like a customer file: H.264 video first, AAC audio
    // second. Audio-only fixtures cannot catch the bug where "first non-null track" means video.
    let mut decoder = AudioDecoder::open_path(&video_fixture("bars-1s-1920x1080.mp4"))
        .expect("the AAC track after the video track opens");
    assert_eq!(decoder.sample_rate(), 48_000);
    assert_eq!(decoder.channels(), 1);
    assert!(!decode_all(&mut decoder).is_empty());
}

#[test]
fn a_movie_without_an_audio_track_is_silent_not_an_unsupported_codec() {
    let error = AudioDecoder::open_path(&video_fixture("bars-1s-640x360-rotated.mp4"))
        .expect_err("the fixture deliberately carries video only");
    assert_eq!(error, AudioError::NoAudioTrack);
}

#[test]
fn opus_in_webm_decodes_because_downloaded_video_usually_carries_it() {
    // symphonia has no Opus decoder of its own, so this only works because the libopus adapter is
    // registered alongside its codecs. It is not an edge case: osg-download recognises webm/opus,
    // so a video fetched with yt-dlp very often arrives exactly like this, and failing here would
    // fail the export after the user had already waited for the download.
    let mut decoder = AudioDecoder::open_bytes(fixture_bytes("tone_mono_48k_opus.webm"))
        .expect("opus decodes in this build");
    assert_eq!(decoder.sample_rate(), 48_000);
    assert_eq!(decoder.channels(), 1);

    let frames = decode_all(&mut decoder);
    assert!(!frames.is_empty(), "opus produced no audio");
    // A decoded tone must actually carry signal; silence would mean the packets were consumed and
    // thrown away, which is the failure this test exists to rule out.
    assert!(
        frames.iter().any(|sample| sample.abs() > 0.05),
        "opus decoded to silence"
    );
}

#[test]
fn bytes_that_are_not_a_container_are_refused() {
    let error = AudioDecoder::open_bytes(vec![0x13; 4_096])
        .expect_err("a block of one repeated byte is not a container");
    assert_eq!(error, AudioError::UnrecognisedContainer);
}

#[test]
fn an_empty_source_is_refused() {
    let error = AudioDecoder::open_bytes(Vec::new()).expect_err("nothing to probe");
    assert_eq!(error, AudioError::UnrecognisedContainer);
}

#[test]
fn a_truncated_file_fails_or_stops_but_never_panics() {
    let mut bytes = fixture_bytes("tone_mono_48k.mp3");
    bytes.truncate(bytes.len() / 3);
    match AudioDecoder::open_bytes(bytes) {
        Ok(mut decoder) => {
            // Whatever it manages to decode, it must end rather than loop or panic.
            let mut frames = 0_u64;
            while let Ok(Some(block)) = decoder.next_frames() {
                frames += u64::try_from(block.len()).expect("block length fits");
                assert!(frames < 10_000_000, "a truncated file must terminate");
            }
        }
        Err(error) => assert!(matches!(
            error,
            AudioError::CorruptStream
                | AudioError::UnrecognisedContainer
                | AudioError::NoAudioTrack
        )),
    }
}

#[test]
fn a_wav_header_that_lies_about_its_length_does_not_over_read() {
    let samples = tone(48_000, 1, 480, 440.0, 0.5);
    let mut bytes = wav_pcm16(48_000, 1, &samples);
    // Claim 64 MiB of samples in a file that holds 960 bytes.
    let data_len_at = bytes.len() - samples.len() * 2 - 4;
    bytes[data_len_at..data_len_at + 4].copy_from_slice(&67_108_864_u32.to_le_bytes());
    let Ok(mut decoder) = AudioDecoder::open_bytes(bytes) else {
        return;
    };
    let mut frames = 0_usize;
    while let Ok(Some(block)) = decoder.next_frames() {
        frames += block.len();
        assert!(frames <= samples.len(), "no more frames exist to decode");
    }
}
