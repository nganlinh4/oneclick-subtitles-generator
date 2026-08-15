//! Every bound the crate declares, exercised through the public API.
//!
//! A bound that is never tested is a bound that does not exist. The two ceilings that cannot be
//! reached without fabricating gigabytes — the per-source frame ceiling and the per-packet frame
//! ceiling — are checked at the arithmetic level here and enforced in `decode.rs`; they are the
//! only ones without an end-to-end case, and that is stated rather than hidden.

mod support;

use osg_audio::{
    AudioError, AudioSource, MAX_BUFFERED_SAMPLES, MAX_CHANNELS, MAX_MIX_DURATION_SECONDS,
    MAX_PACKET_FRAMES, MAX_SAMPLE_RATE, MAX_SOURCE_CHANNELS, MAX_SOURCE_FRAMES, MAX_SOURCES,
    MIN_SAMPLE_RATE, MixPlan, Mixer, OutputFormat, TrimWindow, Volume, mix_to_buffer,
};
use osg_scene::ExactTime;
use support::{constant, wav_f32, wav_pcm16};

fn format() -> OutputFormat {
    OutputFormat::new(48_000, 2).expect("48 kHz stereo is supported")
}

fn seconds(numerator: i64, denominator: i64) -> ExactTime {
    ExactTime::new(numerator, denominator).expect("a representable instant")
}

fn short_source() -> AudioSource {
    AudioSource::from_bytes(wav_f32(48_000, 1, &constant(1, 480, 0.1)))
}

#[test]
fn the_output_sample_rate_is_bounded_on_both_sides() {
    assert!(matches!(
        OutputFormat::new(MIN_SAMPLE_RATE - 1, 2),
        Err(AudioError::OutputSampleRateOutOfRange { .. })
    ));
    assert!(matches!(
        OutputFormat::new(MAX_SAMPLE_RATE + 1, 2),
        Err(AudioError::OutputSampleRateOutOfRange { .. })
    ));
    assert!(OutputFormat::new(MIN_SAMPLE_RATE, 2).is_ok());
    assert!(OutputFormat::new(MAX_SAMPLE_RATE, 2).is_ok());
}

#[test]
fn the_output_channel_count_is_bounded() {
    assert!(matches!(
        OutputFormat::new(48_000, 0),
        Err(AudioError::OutputChannelCountOutOfRange { .. })
    ));
    assert!(matches!(
        OutputFormat::new(48_000, MAX_CHANNELS + 1),
        Err(AudioError::OutputChannelCountOutOfRange { .. })
    ));
    assert!(OutputFormat::new(48_000, MAX_CHANNELS).is_ok());
}

#[test]
fn a_source_sample_rate_outside_the_range_is_refused() {
    // A WAV header may declare any rate at all; the decoder is what refuses it.
    let too_slow = wav_pcm16(4_000, 1, &constant(1, 400, 0.5));
    let error = mix_to_buffer(
        MixPlan::new(
            format(),
            seconds(1, 10),
            vec![AudioSource::from_bytes(too_slow)],
        )
        .expect("the plan itself is valid"),
    )
    .expect_err("4 kHz is below the floor");
    assert!(matches!(
        error,
        AudioError::SourceSampleRateOutOfRange { value: 4_000, .. }
    ));
}

#[test]
fn a_source_channel_count_outside_the_range_is_refused() {
    let too_wide = wav_pcm16(
        48_000,
        MAX_SOURCE_CHANNELS + 1,
        &constant(MAX_SOURCE_CHANNELS + 1, 100, 0.1),
    );
    let result = mix_to_buffer(
        MixPlan::new(
            format(),
            seconds(1, 10),
            vec![AudioSource::from_bytes(too_wide)],
        )
        .expect("the plan itself is valid"),
    );
    match result {
        Err(AudioError::SourceChannelCountOutOfRange { .. }) => {}
        // Some readers refuse a 17 channel layout before the decoder sees it; either refusal is a
        // typed error rather than a panic or an allocation.
        Err(other) => assert!(matches!(
            other,
            AudioError::UnrecognisedContainer | AudioError::UnsupportedCodec
        )),
        Ok(_) => panic!("a 17 channel source must not be accepted"),
    }
}

#[test]
fn a_plan_may_not_carry_more_sources_than_the_ceiling() {
    let sources: Vec<AudioSource> = (0..=MAX_SOURCES).map(|_| short_source()).collect();
    let error = MixPlan::new(format(), seconds(1, 10), sources)
        .expect_err("one more than the ceiling is refused");
    assert!(matches!(
        error,
        AudioError::TooManySources {
            max: MAX_SOURCES,
            ..
        }
    ));
    let at_ceiling: Vec<AudioSource> = (0..MAX_SOURCES).map(|_| short_source()).collect();
    assert!(MixPlan::new(format(), seconds(1, 10), at_ceiling).is_ok());
}

#[test]
fn a_mix_duration_beyond_the_ceiling_is_refused() {
    let too_long = seconds(i64::from(MAX_MIX_DURATION_SECONDS) + 1, 1);
    assert!(matches!(
        MixPlan::new(format(), too_long, vec![short_source()]),
        Err(AudioError::DurationOutOfRange {
            max: MAX_MIX_DURATION_SECONDS
        })
    ));
}

#[test]
fn a_zero_or_negative_mix_duration_is_refused() {
    assert!(matches!(
        MixPlan::new(format(), ExactTime::ZERO, vec![short_source()]),
        Err(AudioError::DurationOutOfRange { .. })
    ));
    let negative = ExactTime::new(-1, 2).expect("a representable instant");
    assert!(matches!(
        MixPlan::new(format(), negative, vec![short_source()]),
        Err(AudioError::DurationOutOfRange { .. })
    ));
}

#[test]
fn an_inverted_or_empty_trim_window_is_refused() {
    assert!(matches!(
        TrimWindow::new(seconds(2, 1), Some(seconds(1, 1))),
        Err(AudioError::InvalidTrim)
    ));
    assert!(matches!(
        TrimWindow::new(seconds(1, 1), Some(seconds(1, 1))),
        Err(AudioError::InvalidTrim)
    ));
    assert!(matches!(
        TrimWindow::new(
            ExactTime::new(-1, 1).expect("a representable instant"),
            None
        ),
        Err(AudioError::InvalidTrim)
    ));
}

#[test]
fn a_trim_window_beyond_the_ceiling_is_refused_when_the_mix_opens() {
    let far = seconds(i64::from(MAX_MIX_DURATION_SECONDS) + 10, 1);
    let source = short_source().with_trim(
        TrimWindow::new(
            far,
            Some(seconds(i64::from(MAX_MIX_DURATION_SECONDS) + 20, 1)),
        )
        .expect("the window itself is forward"),
    );
    let error = Mixer::new(MixPlan::new(format(), seconds(1, 10), vec![source]).expect("a plan"))
        .expect_err("a trim past the ceiling is refused");
    assert_eq!(error, AudioError::InvalidTrim);
}

#[test]
fn a_negative_offset_is_refused() {
    let negative = ExactTime::new(-1, 30).expect("a representable instant");
    assert!(matches!(
        short_source().with_offset(negative),
        Err(AudioError::InvalidOffset)
    ));
}

#[test]
fn an_offset_beyond_the_ceiling_is_refused_when_the_mix_opens() {
    let far = seconds(i64::from(MAX_MIX_DURATION_SECONDS) + 10, 1);
    let source = short_source()
        .with_offset(far)
        .expect("the offset itself is positive");
    let error = Mixer::new(MixPlan::new(format(), seconds(1, 10), vec![source]).expect("a plan"))
        .expect_err("an offset past the ceiling is refused");
    assert_eq!(error, AudioError::InvalidOffset);
}

#[test]
fn a_volume_outside_the_shipped_range_is_refused() {
    assert!(matches!(
        Volume::from_percent(101),
        Err(AudioError::VolumeOutOfRange { value: 101 })
    ));
    assert!(matches!(
        Volume::from_percent(u32::MAX),
        Err(AudioError::VolumeOutOfRange { .. })
    ));
    assert!(Volume::from_percent(100).is_ok());
    assert!(Volume::from_percent(0).is_ok());
}

#[test]
fn a_mix_too_large_to_buffer_is_refused_rather_than_allocated() {
    // Two hours of 48 kHz stereo is far past the whole-buffer ceiling but well inside the mix
    // duration ceiling, so this is the buffering bound and nothing else.
    let plan = MixPlan::new(format(), seconds(7_200, 1), vec![short_source()]).expect("a plan");
    assert!(plan.frames() * 2 > MAX_BUFFERED_SAMPLES);
    assert!(matches!(
        mix_to_buffer(plan),
        Err(AudioError::MixTooLargeToBuffer {
            max: MAX_BUFFERED_SAMPLES
        })
    ));
}

#[test]
fn a_long_mix_still_streams_in_blocks() {
    // The same duration the whole-buffer path refuses is fine block by block; only the first few
    // blocks are read here, which is the point: memory does not grow with duration.
    let plan = MixPlan::new(format(), seconds(7_200, 1), vec![short_source()]).expect("a plan");
    let mut mixer = Mixer::new(plan).expect("the mixer opens");
    for _ in 0..4 {
        let block = mixer.next_block().expect("the mix runs");
        assert!(block.is_some());
    }
    assert_eq!(mixer.total_frames(), 7_200 * 48_000);
}

#[test]
fn the_declared_ceilings_are_consistent_with_each_other() {
    // MAX_SOURCE_FRAMES is the mix ceiling at the highest rate: a source can never outlast a mix.
    assert_eq!(
        MAX_SOURCE_FRAMES,
        u64::from(MAX_MIX_DURATION_SECONDS) * u64::from(MAX_SAMPLE_RATE)
    );
    // A packet ceiling below the source ceiling means the packet bound always bites first.
    const { assert!(MAX_PACKET_FRAMES < MAX_SOURCE_FRAMES) };
    // The whole-buffer ceiling is well below the streaming ceiling, so the two are distinct bounds.
    const { assert!(MAX_BUFFERED_SAMPLES < MAX_SOURCE_FRAMES) };
}

#[test]
fn a_mix_of_the_maximum_number_of_sources_runs() {
    let sources: Vec<AudioSource> = (0..MAX_SOURCES)
        .map(|index| {
            let level = 0.1_f32 * (1.0 + f32::from(u8::try_from(index).expect("a small index")));
            AudioSource::from_bytes(wav_f32(48_000, 1, &constant(1, 4_800, level / 10.0)))
        })
        .collect();
    let mixed = mix_to_buffer(MixPlan::new(format(), seconds(1, 10), sources).expect("a plan"))
        .expect("the mix runs");
    assert_eq!(mixed.frames(), 4_800);
    assert!(!mixed.stats().clipped());
}
