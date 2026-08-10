use crate::{MediaError, Result, WaveformPlan};
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};

const LOD_GROUP_SIZE: usize = 4;
const READ_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPoint {
    pub minimum: f32,
    pub maximum: f32,
    pub root_mean_square: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLevel {
    pub points_per_second: f64,
    pub points: Vec<WaveformPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPyramid {
    pub duration_us: u64,
    pub source_sample_rate_hz: u32,
    pub levels: Vec<WaveformLevel>,
}

impl WaveformPyramid {
    /// Reads the bounded mono signed-16 PCM artifact produced by a waveform
    /// plan and creates progressively coarser min/max/RMS levels.
    pub fn read_from(plan: &WaveformPlan) -> Result<Self> {
        let path = plan.output().as_path();
        let byte_length = std::fs::metadata(path)
            .map_err(|_| MediaError::InvalidWaveform("PCM artifact is unavailable"))?
            .len();
        if byte_length % 2 != 0 {
            return Err(MediaError::InvalidWaveform(
                "signed-16 PCM must contain complete samples",
            ));
        }

        let samples_per_point = plan
            .sample_rate_hz()
            .div_ceil(plan.points_per_second())
            .max(1);
        let max_samples = u64::try_from(plan.max_points())
            .unwrap_or(u64::MAX)
            .saturating_mul(u64::from(samples_per_point));
        if byte_length / 2 > max_samples.saturating_add(u64::from(samples_per_point)) {
            return Err(MediaError::InvalidWaveform(
                "PCM artifact exceeds the planned point limit",
            ));
        }

        let file = File::open(path)
            .map_err(|_| MediaError::InvalidWaveform("PCM artifact cannot be opened"))?;
        let base = read_base_level(BufReader::new(file), samples_per_point, plan.max_points())?;
        let duration_us = (byte_length / 2)
            .saturating_mul(1_000_000)
            .checked_div(u64::from(plan.sample_rate_hz()))
            .unwrap_or_default();
        let base_rate = f64::from(plan.sample_rate_hz()) / f64::from(samples_per_point);
        let mut levels = vec![WaveformLevel {
            points_per_second: base_rate,
            points: base,
        }];
        while levels
            .last()
            .is_some_and(|level| level.points.len() > 2_000)
        {
            let previous = &levels.last().expect("level exists").points;
            levels.push(WaveformLevel {
                points_per_second: levels.last().expect("level exists").points_per_second / 4.0,
                points: coarsen(previous),
            });
        }
        Ok(Self {
            duration_us,
            source_sample_rate_hz: plan.sample_rate_hz(),
            levels,
        })
    }
}

fn read_base_level(
    mut reader: impl Read,
    samples_per_point: u32,
    max_points: usize,
) -> Result<Vec<WaveformPoint>> {
    let mut output = Vec::new();
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES].into_boxed_slice();
    let mut pending_byte = None;
    let mut bucket = Accumulator::default();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| MediaError::InvalidWaveform("PCM artifact could not be read"))?;
        if read == 0 {
            break;
        }
        let mut offset = 0;
        if let Some(low) = pending_byte.take() {
            let sample = i16::from_le_bytes([low, buffer[0]]);
            add_sample(
                sample,
                &mut bucket,
                samples_per_point,
                &mut output,
                max_points,
            )?;
            offset = 1;
        }
        while offset + 1 < read {
            let sample = i16::from_le_bytes([buffer[offset], buffer[offset + 1]]);
            add_sample(
                sample,
                &mut bucket,
                samples_per_point,
                &mut output,
                max_points,
            )?;
            offset += 2;
        }
        if offset < read {
            pending_byte = Some(buffer[offset]);
        }
    }
    if pending_byte.is_some() {
        return Err(MediaError::InvalidWaveform(
            "signed-16 PCM ended in a partial sample",
        ));
    }
    if bucket.count > 0 {
        output.push(bucket.finish());
    }
    Ok(output)
}

fn add_sample(
    sample: i16,
    bucket: &mut Accumulator,
    samples_per_point: u32,
    output: &mut Vec<WaveformPoint>,
    max_points: usize,
) -> Result<()> {
    bucket.add(sample);
    if bucket.count == samples_per_point {
        if output.len() == max_points {
            return Err(MediaError::InvalidWaveform(
                "waveform point limit was exceeded",
            ));
        }
        output.push(std::mem::take(bucket).finish());
    }
    Ok(())
}

#[derive(Debug)]
struct Accumulator {
    minimum: i16,
    maximum: i16,
    square_sum: f32,
    count: u32,
}

impl Default for Accumulator {
    fn default() -> Self {
        Self {
            minimum: i16::MAX,
            maximum: i16::MIN,
            square_sum: 0.0,
            count: 0,
        }
    }
}

impl Accumulator {
    fn add(&mut self, sample: i16) {
        self.minimum = self.minimum.min(sample);
        self.maximum = self.maximum.max(sample);
        let normalized = normalize(sample);
        self.square_sum += normalized * normalized;
        self.count += 1;
    }

    fn finish(self) -> WaveformPoint {
        WaveformPoint {
            minimum: normalize(self.minimum),
            maximum: normalize(self.maximum),
            root_mean_square: (self.square_sum
                / f32::from(u16::try_from(self.count.max(1)).unwrap_or(u16::MAX)))
            .sqrt(),
        }
    }
}

fn normalize(sample: i16) -> f32 {
    if sample < 0 {
        f32::from(sample) / 32_768.0
    } else {
        f32::from(sample) / 32_767.0
    }
}

fn coarsen(points: &[WaveformPoint]) -> Vec<WaveformPoint> {
    points
        .chunks(LOD_GROUP_SIZE)
        .map(|chunk| WaveformPoint {
            minimum: chunk
                .iter()
                .map(|point| point.minimum)
                .fold(f32::INFINITY, f32::min),
            maximum: chunk
                .iter()
                .map(|point| point.maximum)
                .fold(f32::NEG_INFINITY, f32::max),
            root_mean_square: (chunk
                .iter()
                .map(|point| point.root_mean_square.powi(2))
                .sum::<f32>()
                / f32::from(u16::try_from(chunk.len()).expect("LOD group fits in u16")))
            .sqrt(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MediaInput, MediaOutput, MediaTimeRange};

    #[test]
    fn builds_min_max_rms_and_lod_without_loading_pcm_whole() {
        let directory = tempfile::tempdir().unwrap();
        let input_path = directory.path().join("input.wav");
        std::fs::write(&input_path, b"input").unwrap();
        let output_path = directory.path().join("waveform.pcm");
        let samples = [-32_768_i16, -16_384, 0, 32_767, 8_192, -8_192, 0, 0];
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        std::fs::write(&output_path, bytes).unwrap();
        let plan = WaveformPlan::new(
            MediaInput::from_native_selection(input_path).unwrap(),
            MediaOutput::within_root(output_path, directory.path()).unwrap(),
            Some(20_000),
            100,
            1_000,
            MediaTimeRange::default(),
        )
        .unwrap();

        let waveform = WaveformPyramid::read_from(&plan).unwrap();
        assert_eq!(waveform.duration_us, 20_000);
        assert_eq!(waveform.levels[0].points.len(), 2);
        assert!((waveform.levels[0].points[0].minimum + 1.0).abs() < f32::EPSILON);
        assert!((waveform.levels[0].points[0].maximum - 1.0).abs() < f32::EPSILON);
        assert!(waveform.levels[0].points[0].root_mean_square > 0.5);
    }

    #[test]
    fn rejects_partial_pcm_sample() {
        let error = read_base_level(&[1_u8][..], 4, 10).unwrap_err();
        assert!(matches!(error, MediaError::InvalidWaveform(_)));
    }
}
