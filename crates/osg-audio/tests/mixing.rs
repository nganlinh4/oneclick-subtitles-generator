//! Mixing: determinism, the shipped volume semantics, clipping, trim and offset exactness,
//! channel mapping and rate conversion.
//!
//! Where the source and output rates match, the pipeline is sample exact, so those assertions
//! compare bit patterns rather than tolerances. Where a rate conversion is involved the filter is
//! doing real work and the assertions are numeric, with the tolerance stated.

mod support;

use osg_audio::{
    AudioSource, MIX_BLOCK_FRAMES, MixPlan, Mixer, OutputFormat, TrimWindow, Volume, mix_to_buffer,
};
use osg_scene::{ExactTime, FrameTimeline};
use support::{constant, per_channel, tone, wav_f32, wav_pcm16};

fn format(sample_rate: u32, channels: u16) -> OutputFormat {
    OutputFormat::new(sample_rate, channels).expect("a supported output format")
}

fn seconds(numerator: i64, denominator: i64) -> ExactTime {
    ExactTime::new(numerator, denominator).expect("a representable instant")
}

fn plan(output: OutputFormat, duration: ExactTime, sources: Vec<AudioSource>) -> MixPlan {
    MixPlan::new(output, duration, sources).expect("a valid plan")
}

fn samples_of(output: OutputFormat, duration: ExactTime, sources: Vec<AudioSource>) -> Vec<f32> {
    mix_to_buffer(plan(output, duration, sources))
        .expect("the mix runs")
        .into_samples()
}

/// A constant-valued float WAV, so every assertion about gain is exact.
fn flat_wav(sample_rate: u32, channels: u16, frames: usize, value: f32) -> Vec<u8> {
    wav_f32(sample_rate, channels, &constant(channels, frames, value))
}

fn assert_bit_identical(left: &[f32], right: &[f32]) {
    assert_eq!(left.len(), right.len(), "sample counts differ");
    for (index, (first, second)) in left.iter().zip(right).enumerate() {
        assert_eq!(
            first.to_bits(),
            second.to_bits(),
            "sample {index} differs: {first} vs {second}"
        );
    }
}

#[test]
fn the_same_plan_twice_is_bit_identical() {
    let output = format(48_000, 2);
    let original = wav_pcm16(48_000, 2, &tone(48_000, 2, 24_000, 440.0, 0.5));
    // A different rate so the resampler is part of what is being repeated.
    let narration = wav_pcm16(44_100, 1, &tone(44_100, 1, 11_025, 220.0, 0.4));
    let build = || {
        vec![
            AudioSource::from_bytes(original.clone()),
            AudioSource::from_bytes(narration.clone())
                .with_volume(Volume::from_percent(70).expect("a valid volume"))
                .with_offset(seconds(1, 10))
                .expect("a valid offset"),
        ]
    };
    let first = samples_of(output, seconds(1, 2), build());
    let second = samples_of(output, seconds(1, 2), build());
    assert_bit_identical(&first, &second);
    assert_eq!(first.len(), 24_000 * 2);
}

#[test]
fn reading_in_blocks_is_the_same_as_reading_it_whole() {
    let output = format(48_000, 2);
    let source = wav_pcm16(44_100, 2, &tone(44_100, 2, 22_050, 330.0, 0.6));
    let whole = samples_of(
        output,
        seconds(1, 2),
        vec![AudioSource::from_bytes(source.clone())],
    );

    let mut mixer = Mixer::new(plan(
        output,
        seconds(1, 2),
        vec![AudioSource::from_bytes(source)],
    ))
    .expect("the mixer opens");
    let mut blocks = Vec::new();
    let mut block_count = 0_u64;
    while let Some(block) = mixer.next_block().expect("the mix runs") {
        blocks.extend_from_slice(block);
        block_count += 1;
    }
    assert_eq!(block_count, 24_000_u64.div_ceil(MIX_BLOCK_FRAMES));
    assert_bit_identical(&whole, &blocks);
}

#[test]
fn full_volume_passes_the_source_through_unchanged() {
    let output = format(48_000, 1);
    let source = flat_wav(48_000, 1, 4_800, 0.25);
    let mixed = samples_of(
        output,
        seconds(1, 10),
        vec![AudioSource::from_bytes(source).with_volume(Volume::FULL)],
    );
    assert_eq!(mixed.len(), 4_800);
    for sample in &mixed {
        assert_eq!(sample.to_bits(), 0.25_f32.to_bits());
    }
}

#[test]
fn volume_is_the_shipped_linear_percentage() {
    let output = format(48_000, 1);
    let source = flat_wav(48_000, 1, 4_800, 0.5);
    for (percent, expected) in [(100_u32, 0.5_f32), (50, 0.25), (25, 0.125)] {
        let mixed = samples_of(
            output,
            seconds(1, 10),
            vec![
                AudioSource::from_bytes(source.clone())
                    .with_volume(Volume::from_percent(percent).expect("a valid volume")),
            ],
        );
        for sample in &mixed {
            assert_eq!(
                sample.to_bits(),
                expected.to_bits(),
                "{percent} percent should scale 0.5 to {expected}"
            );
        }
    }
}

#[test]
fn a_muted_source_contributes_silence_and_is_never_opened() {
    let output = format(48_000, 1);
    // The path does not exist. A muted source must not be opened, so this must still succeed.
    let missing = AudioSource::from_path("Z:/osg-audio/no-such-source.wav")
        .with_volume(Volume::from_percent(0).expect("a valid volume"));
    let audible = AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.4));
    let mixed = samples_of(output, seconds(1, 10), vec![missing, audible]);
    assert_eq!(mixed.len(), 4_800);
    for sample in &mixed {
        assert_eq!(sample.to_bits(), 0.4_f32.to_bits());
    }
}

#[test]
fn muting_every_source_leaves_exact_silence() {
    let output = format(48_000, 2);
    let source =
        AudioSource::from_bytes(flat_wav(48_000, 2, 4_800, 0.9)).with_volume(Volume::MUTED);
    let mixed = samples_of(output, seconds(1, 10), vec![source]);
    assert_eq!(mixed.len(), 9_600);
    for sample in &mixed {
        assert_eq!(sample.to_bits(), 0.0_f32.to_bits());
    }
}

#[test]
fn sources_sum() {
    let output = format(48_000, 1);
    let mixed = samples_of(
        output,
        seconds(1, 10),
        vec![
            AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.25)),
            AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.5)),
        ],
    );
    for sample in &mixed {
        assert_eq!(sample.to_bits(), 0.75_f32.to_bits());
    }
}

#[test]
fn a_sum_over_full_scale_saturates_and_is_reported() {
    let output = format(48_000, 1);
    let mixed = mix_to_buffer(plan(
        output,
        seconds(1, 10),
        vec![
            AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.75)),
            AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.75)),
        ],
    ))
    .expect("the mix runs");

    for sample in mixed.samples() {
        // Saturated, not wrapped: a wrap would put a large positive sum somewhere negative.
        assert_eq!(sample.to_bits(), 1.0_f32.to_bits());
    }
    let stats = mixed.stats();
    assert!(stats.clipped());
    assert_eq!(stats.clipped_samples(), 4_800);
    assert_eq!(stats.non_finite_samples(), 0);
    assert_eq!(stats.peak().to_bits(), 1.5_f32.to_bits());
}

#[test]
fn a_negative_sum_over_full_scale_saturates_the_same_way() {
    let output = format(48_000, 1);
    let mixed = mix_to_buffer(plan(
        output,
        seconds(1, 10),
        vec![
            AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, -0.8)),
            AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, -0.8)),
        ],
    ))
    .expect("the mix runs");
    for sample in mixed.samples() {
        assert_eq!(sample.to_bits(), (-1.0_f32).to_bits());
    }
    assert_eq!(mixed.stats().clipped_samples(), 4_800);
}

#[test]
fn a_mix_that_does_not_clip_reports_its_headroom() {
    let output = format(48_000, 1);
    let mixed = mix_to_buffer(plan(
        output,
        seconds(1, 10),
        vec![AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.5))],
    ))
    .expect("the mix runs");
    assert!(!mixed.stats().clipped());
    assert_eq!(mixed.stats().clipped_samples(), 0);
    assert_eq!(mixed.stats().peak().to_bits(), 0.5_f32.to_bits());
}

#[test]
fn an_offset_starts_the_source_on_an_exact_video_frame_boundary() {
    let output = format(48_000, 1);
    // 30 fps: frame 45 is exactly 1.5 s, which is exactly sample 72_000.
    let timeline = FrameTimeline::new(30, 1, 90, ExactTime::ZERO).expect("a timeline");
    let start = timeline.frame_time(45).expect("frame 45");
    let narration = AudioSource::from_bytes(flat_wav(48_000, 1, 48_000, 0.6))
        .with_offset(start)
        .expect("a valid offset");
    let mixed =
        mix_to_buffer(MixPlan::from_timeline(output, timeline, vec![narration]).expect("a plan"))
            .expect("the mix runs");
    let samples = mixed.samples();
    assert_eq!(samples.len(), 144_000);

    let first_audible = samples
        .iter()
        .position(|sample| *sample != 0.0)
        .expect("the narration is audible");
    assert_eq!(first_audible, 72_000);
    assert_eq!(samples[71_999].to_bits(), 0.0_f32.to_bits());
    assert_eq!(samples[72_000].to_bits(), 0.6_f32.to_bits());
    // One second of narration, so it stops at sample 120_000 and the rest is silence again.
    assert_eq!(samples[119_999].to_bits(), 0.6_f32.to_bits());
    assert_eq!(samples[120_000].to_bits(), 0.0_f32.to_bits());
}

#[test]
fn an_offset_on_a_fractional_frame_rate_lands_on_the_floor_of_the_exact_instant() {
    let output = format(48_000, 1);
    // 30000/1001 fps: frame 1 is 1001/30000 s, which is 1601.6 samples.
    let timeline = FrameTimeline::new(30_000, 1_001, 60, ExactTime::ZERO).expect("a timeline");
    let start = timeline.frame_time(1).expect("frame 1");
    let source = AudioSource::from_bytes(flat_wav(48_000, 1, 48_000, 0.5))
        .with_offset(start)
        .expect("a valid offset");
    let mixed = samples_of(output, seconds(1, 2), vec![source]);
    assert_eq!(mixed[1_600].to_bits(), 0.0_f32.to_bits());
    assert_eq!(mixed[1_601].to_bits(), 0.5_f32.to_bits());
}

#[test]
fn a_trim_window_takes_exactly_the_part_of_the_source_it_names() {
    let output = format(48_000, 1);
    // A ramp that identifies every frame: frame n holds n / 48000.
    let mut ramp = Vec::with_capacity(48_000);
    for frame in 0..48_000_u32 {
        ramp.push(f64_to_f32(f64::from(frame) / 48_000.0));
    }
    let source = AudioSource::from_bytes(wav_f32(48_000, 1, &ramp))
        .with_trim(TrimWindow::new(seconds(1, 4), Some(seconds(1, 2))).expect("a valid trim"));
    let mixed = samples_of(output, seconds(1, 2), vec![source]);
    assert_eq!(mixed.len(), 24_000);
    // The window is a quarter second starting a quarter second in: source frames 12000..24000.
    assert_eq!(mixed[0].to_bits(), ramp[12_000].to_bits());
    assert_eq!(mixed[11_999].to_bits(), ramp[23_999].to_bits());
    // Past the trim end the source contributes nothing, even though it has more frames.
    assert_eq!(mixed[12_000].to_bits(), 0.0_f32.to_bits());
    assert_eq!(mixed[23_999].to_bits(), 0.0_f32.to_bits());
}

#[test]
fn a_trim_and_an_offset_compose() {
    let output = format(48_000, 1);
    let source = AudioSource::from_bytes(flat_wav(48_000, 1, 48_000, 0.5))
        .with_trim(TrimWindow::new(seconds(1, 4), Some(seconds(1, 2))).expect("a valid trim"))
        .with_offset(seconds(1, 10))
        .expect("a valid offset");
    let mixed = samples_of(output, seconds(1, 2), vec![source]);
    // Starts at 0.1 s = sample 4800, runs for 0.25 s = 12000 samples, then stops.
    assert_eq!(mixed[4_799].to_bits(), 0.0_f32.to_bits());
    assert_eq!(mixed[4_800].to_bits(), 0.5_f32.to_bits());
    assert_eq!(mixed[16_799].to_bits(), 0.5_f32.to_bits());
    assert_eq!(mixed[16_800].to_bits(), 0.0_f32.to_bits());
}

#[test]
fn a_source_shorter_than_the_mix_leaves_silence_behind_it() {
    let output = format(48_000, 1);
    let source = AudioSource::from_bytes(flat_wav(48_000, 1, 2_400, 0.5));
    let mixed = samples_of(output, seconds(1, 10), vec![source]);
    assert_eq!(mixed.len(), 4_800);
    assert_eq!(mixed[2_399].to_bits(), 0.5_f32.to_bits());
    for sample in &mixed[2_400..] {
        assert_eq!(sample.to_bits(), 0.0_f32.to_bits());
    }
}

#[test]
fn a_mono_source_fills_every_output_channel() {
    let output = format(48_000, 2);
    let source = AudioSource::from_bytes(flat_wav(48_000, 1, 4_800, 0.3));
    let mixed = samples_of(output, seconds(1, 10), vec![source]);
    assert_eq!(mixed.len(), 9_600);
    for sample in &mixed {
        assert_eq!(sample.to_bits(), 0.3_f32.to_bits());
    }
}

#[test]
fn a_stereo_source_downmixes_to_the_mean_in_mono() {
    let output = format(48_000, 1);
    let stereo = wav_f32(48_000, 2, &per_channel(4_800, &[0.8, 0.2]));
    let mixed = samples_of(
        output,
        seconds(1, 10),
        vec![AudioSource::from_bytes(stereo)],
    );
    assert_eq!(mixed.len(), 4_800);
    for sample in &mixed {
        assert_eq!(sample.to_bits(), 0.5_f32.to_bits());
    }
}

#[test]
fn a_stereo_source_keeps_its_channels_apart() {
    let output = format(48_000, 2);
    let stereo = wav_f32(48_000, 2, &per_channel(4_800, &[0.8, 0.2]));
    let mixed = samples_of(
        output,
        seconds(1, 10),
        vec![AudioSource::from_bytes(stereo)],
    );
    for frame in mixed.chunks_exact(2) {
        assert_eq!(frame[0].to_bits(), 0.8_f32.to_bits());
        assert_eq!(frame[1].to_bits(), 0.2_f32.to_bits());
    }
}

#[test]
fn a_source_at_another_rate_is_converted_and_keeps_its_level() {
    let output = format(48_000, 1);
    let source = AudioSource::from_bytes(flat_wav(24_000, 1, 24_000, 0.5));
    let mixed = samples_of(output, seconds(1, 2), vec![source]);
    assert_eq!(mixed.len(), 24_000);
    // Away from the edges, where the filter reads real samples on both sides, the constant holds.
    for sample in &mixed[200..23_800] {
        assert!(
            (sample - 0.5).abs() < 1e-5,
            "resampled constant drifted to {sample}"
        );
    }
}

#[test]
fn a_44_1k_source_converts_to_48k_without_changing_its_duration() {
    let output = format(48_000, 1);
    // A quarter second of 44.1 kHz becomes a quarter second of 48 kHz: 12000 output frames.
    let source = AudioSource::from_bytes(flat_wav(44_100, 1, 11_025, 0.5));
    let mixed = samples_of(output, seconds(1, 2), vec![source]);
    assert!((mixed[11_000] - 0.5).abs() < 1e-4);
    // Past the source's own end there is nothing left to read.
    assert!(mixed[13_000].abs() < 1e-3, "value {}", mixed[13_000]);
}

#[test]
fn an_upsampled_and_a_downsampled_source_mix_together() {
    let output = format(48_000, 2);
    let low = AudioSource::from_bytes(flat_wav(8_000, 1, 8_000, 0.25));
    let high = AudioSource::from_bytes(flat_wav(96_000, 2, 96_000, 0.25));
    let mixed = samples_of(output, seconds(1, 2), vec![low, high]);
    for sample in &mixed[2_000..22_000] {
        assert!(
            (sample - 0.5).abs() < 1e-4,
            "mixed constant drifted to {sample}"
        );
    }
}

fn f64_to_f32(value: f64) -> f32 {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the fixture is deliberately generated at f32 precision"
    )]
    let narrowed = value as f32;
    narrowed
}
