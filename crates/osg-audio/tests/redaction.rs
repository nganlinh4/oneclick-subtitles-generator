//! Errors may name what went wrong and nothing else.
//!
//! A failure from this crate can reach a log or the `WebView`, so it may not carry a filesystem path,
//! a directory name, a decoder's own message, or any of the media's content. Both `Display` and
//! `Debug` are checked, because a diagnostic is as likely to be formatted with `{:?}` as with `{}`.

mod support;

use osg_audio::{AudioDecoder, AudioError, AudioSource, MixPlan, Mixer, OutputFormat, Volume};
use osg_scene::ExactTime;
use support::{constant, wav_f32};

/// A path whose every component is distinctive enough to spot in any rendering.
const SECRET_PATH: &str =
    "Z:/osg-audio-tests/kunden-projekt-geheim/folge-07-bekenntnis/quelle-tonspur.wav";
const SECRET_COMPONENTS: [&str; 5] = [
    "osg-audio-tests",
    "kunden-projekt-geheim",
    "folge-07-bekenntnis",
    "quelle-tonspur",
    "Z:/",
];
/// A marker planted inside the media's bytes.
const SECRET_CONTENT: &str = "SUBTITLE-TEXT-DO-NOT-LEAK";

fn assert_redacted(error: &AudioError) {
    let displayed = error.to_string();
    let debugged = format!("{error:?}");
    for rendering in [&displayed, &debugged] {
        for component in SECRET_COMPONENTS {
            assert!(
                !rendering.contains(component),
                "error leaked the path component {component}: {rendering}"
            );
        }
        assert!(
            !rendering.contains(SECRET_CONTENT),
            "error leaked media content: {rendering}"
        );
        assert!(
            !rendering.contains(".wav"),
            "error leaked a file name: {rendering}"
        );
        assert!(
            !rendering.contains('\\'),
            "error rendering looks like a path: {rendering}"
        );
    }
}

#[test]
fn a_missing_file_names_no_path() {
    let error = AudioDecoder::open_path(std::path::Path::new(SECRET_PATH))
        .expect_err("the path does not exist");
    assert!(matches!(error, AudioError::SourceUnavailable { .. }));
    assert_redacted(&error);
}

#[test]
fn a_missing_file_names_no_path_through_the_mixer_either() {
    let format = OutputFormat::new(48_000, 2).expect("a supported format");
    let duration = ExactTime::new(1, 10).expect("a representable instant");
    let source = AudioSource::from_path(SECRET_PATH).with_volume(Volume::FULL);
    let error = Mixer::new(MixPlan::new(format, duration, vec![source]).expect("a plan"))
        .expect_err("the source cannot be opened");
    assert_redacted(&error);
}

#[test]
fn corrupt_media_does_not_quote_itself() {
    // Bytes that look like a container long enough to be probed, carrying a marker.
    let mut bytes = b"RIFF\x00\x00\x00\x00WAVEfmt ".to_vec();
    bytes.extend_from_slice(SECRET_CONTENT.as_bytes());
    bytes.extend_from_slice(&[0x7f; 512]);
    let error = AudioDecoder::open_bytes(bytes).expect_err("the bytes are not decodable media");
    assert_redacted(&error);
}

#[test]
fn a_stream_that_stops_mid_packet_does_not_quote_itself() {
    let mut bytes = wav_f32(48_000, 1, &constant(1, 4_800, 0.5));
    bytes.extend_from_slice(SECRET_CONTENT.as_bytes());
    bytes.truncate(60);
    match AudioDecoder::open_bytes(bytes) {
        Ok(mut decoder) => while let Ok(Some(_)) = decoder.next_frames() {},
        Err(error) => assert_redacted(&error),
    }
}

#[test]
fn an_unsupported_codec_names_neither_the_codec_nor_the_file() {
    let error = AudioDecoder::open_path(&support::fixture("tone_mono_48k_opus.webm"))
        .expect_err("opus is not decodable in this build");
    assert_eq!(error, AudioError::UnsupportedCodec);
    let rendering = format!("{error} / {error:?}");
    assert!(!rendering.contains("tone_mono"), "leaked a file name");
    assert!(!rendering.contains(".webm"), "leaked an extension");
}

#[test]
fn every_error_reachable_from_the_public_api_renders_without_a_path() {
    let format = OutputFormat::new(48_000, 2).expect("a supported format");
    let duration = ExactTime::new(1, 10).expect("a representable instant");
    let errors = [
        AudioDecoder::open_path(std::path::Path::new(SECRET_PATH)).expect_err("missing"),
        AudioDecoder::open_bytes(Vec::new()).expect_err("not a container"),
        OutputFormat::new(1, 2).expect_err("rate below the floor"),
        OutputFormat::new(48_000, 0).expect_err("no channels"),
        Volume::from_percent(200).expect_err("above the shipped range"),
        MixPlan::new(format, ExactTime::ZERO, Vec::new()).expect_err("no duration"),
        Mixer::new(
            MixPlan::new(format, duration, vec![AudioSource::from_path(SECRET_PATH)])
                .expect("a plan"),
        )
        .expect_err("the source cannot be opened"),
    ];
    for error in &errors {
        assert_redacted(error);
        assert!(
            !error.to_string().is_empty(),
            "an error must still say something"
        );
    }
}
