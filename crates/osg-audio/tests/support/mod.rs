//! Fixtures shared by the integration tests.
//!
//! WAV fixtures are synthesised here rather than committed, so the bytes under test are generated
//! by code the reader can check. The compressed fixtures in `tests/fixtures` cannot be synthesised
//! without an encoder, so they are committed; they are quarter-second 440 Hz tones at half scale.

#![allow(
    dead_code,
    reason = "each test binary uses a different subset of these helpers"
)]

use std::path::{Path, PathBuf};

/// Where the committed fixtures live.
pub(crate) fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// Read a committed fixture.
pub(crate) fn fixture_bytes(name: &str) -> Vec<u8> {
    std::fs::read(fixture(name)).expect("the fixture is committed next to this test")
}

/// A 16-bit PCM WAV holding `samples`, interleaved.
pub(crate) fn wav_pcm16(sample_rate: u32, channels: u16, samples: &[f32]) -> Vec<u8> {
    let mut data = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        data.extend_from_slice(&to_i16(*sample).to_le_bytes());
    }
    riff(sample_rate, channels, 1, 16, &data)
}

/// A 32-bit float WAV holding `samples`, interleaved.
pub(crate) fn wav_f32(sample_rate: u32, channels: u16, samples: &[f32]) -> Vec<u8> {
    let mut data = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        data.extend_from_slice(&sample.to_le_bytes());
    }
    riff(sample_rate, channels, 3, 32, &data)
}

fn to_i16(sample: f32) -> i16 {
    let scaled = f64::from(sample.clamp(-1.0, 1.0)) * 32_767.0;
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the value is clamped to +/-32767 before the cast"
    )]
    let rounded = scaled.round() as i16;
    rounded
}

fn riff(sample_rate: u32, channels: u16, format_tag: u16, bits: u16, data: &[u8]) -> Vec<u8> {
    let block_align = channels * bits / 8;
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = u32::try_from(data.len()).expect("fixtures are small");
    let mut wav = Vec::with_capacity(data.len() + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&format_tag.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(data);
    wav
}

/// `frames` frames of a sine at `frequency`, the same in every channel.
pub(crate) fn tone(
    sample_rate: u32,
    channels: u16,
    frames: usize,
    frequency: f64,
    amplitude: f64,
) -> Vec<f32> {
    let mut samples = Vec::with_capacity(frames * usize::from(channels));
    for frame in 0..frames {
        let phase =
            2.0 * std::f64::consts::PI * frequency * index_as_f64(frame) / f64::from(sample_rate);
        let value = narrow(amplitude * phase.sin());
        for _ in 0..channels {
            samples.push(value);
        }
    }
    samples
}

/// `frames` frames whose channel `c` holds `values[c]`.
pub(crate) fn per_channel(frames: usize, values: &[f32]) -> Vec<f32> {
    let mut samples = Vec::with_capacity(frames * values.len());
    for _ in 0..frames {
        samples.extend_from_slice(values);
    }
    samples
}

/// `frames` frames of a constant value in every channel.
pub(crate) fn constant(channels: u16, frames: usize, value: f32) -> Vec<f32> {
    vec![value; frames * usize::from(channels)]
}

/// The root mean square of a block, for comparing a lossy decode with what was encoded.
pub(crate) fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples
        .iter()
        .map(|sample| f64::from(*sample).powi(2))
        .sum();
    (sum / index_as_f64(samples.len())).sqrt()
}

/// The largest magnitude in a block.
pub(crate) fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0_f32, |largest, sample| largest.max(sample.abs()))
}

/// Write bytes to a uniquely named file under the system temporary directory.
pub(crate) fn write_temp(name: &str, bytes: &[u8]) -> PathBuf {
    let path = std::env::temp_dir().join(format!("osg-audio-test-{name}"));
    std::fs::write(&path, bytes).expect("the temporary directory is writable");
    path
}

#[expect(
    clippy::cast_precision_loss,
    reason = "test buffers are far below 2^53 samples"
)]
fn index_as_f64(index: usize) -> f64 {
    index as f64
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "fixtures are generated at f32 sample precision by design"
)]
fn narrow(value: f64) -> f32 {
    value as f32
}
