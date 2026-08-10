use crate::{AudioAsset, Result, SpeechError, TimeMicros};
use serde::Serialize;

const NORMALIZED_SCALE: u32 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SpeedFactor(u16);

impl SpeedFactor {
    pub fn from_milli(value: u16) -> Result<Self> {
        if (250..=4_000).contains(&value) {
            Ok(Self(value))
        } else {
            Err(SpeechError::InvalidOption(
                "speed factor must be between 0.25x and 4x",
            ))
        }
    }

    #[must_use]
    pub fn milli(self) -> u16 {
        self.0
    }
}

impl Default for SpeedFactor {
    fn default() -> Self {
        Self(1_000)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct NormalizedPoint(u32);

impl NormalizedPoint {
    pub fn from_millionths(value: u32) -> Result<Self> {
        if value <= NORMALIZED_SCALE {
            Ok(Self(value))
        } else {
            Err(SpeechError::InvalidOption(
                "normalized point must be between zero and one",
            ))
        }
    }

    #[must_use]
    pub fn millionths(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct NormalizedTrim {
    pub start: NormalizedPoint,
    pub end: NormalizedPoint,
}

impl NormalizedTrim {
    pub fn new(start: NormalizedPoint, end: NormalizedPoint) -> Result<Self> {
        if start >= end {
            return Err(SpeechError::InvalidOption(
                "trim start must precede trim end",
            ));
        }
        Ok(Self { start, end })
    }

    #[must_use]
    pub fn full() -> Self {
        Self {
            start: NormalizedPoint(0),
            end: NormalizedPoint(NORMALIZED_SCALE),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum AudioFilter {
    Trim {
        start: TimeMicros,
        end: TimeMicros,
    },
    ResetTimestamps,
    /// One FFmpeg-compatible `atempo` stage in millionths. Each generated
    /// stage is guaranteed to be in the inclusive range 0.5x through 2x.
    Tempo {
        factor_millionths: u32,
    },
    Resample {
        sample_rate: u32,
        channels: u8,
    },
    AppendSilence {
        duration: TimeMicros,
    },
}

#[derive(Clone)]
pub struct AudioEditPlan {
    source: AudioAsset,
    source_duration: TimeMicros,
    trim: NormalizedTrim,
    speed: SpeedFactor,
    filters: Vec<AudioFilter>,
    output_duration: TimeMicros,
}

impl AudioEditPlan {
    pub fn new(
        source: AudioAsset,
        source_duration: TimeMicros,
        trim: NormalizedTrim,
        speed: SpeedFactor,
    ) -> Result<Self> {
        if source_duration == TimeMicros::ZERO {
            return Err(SpeechError::InvalidOption("source duration is zero"));
        }
        let trim_start = scale_time(source_duration, trim.start)?;
        let trim_end = scale_time(source_duration, trim.end)?;
        if trim_start >= trim_end {
            return Err(SpeechError::InvalidOption("trim range is empty"));
        }
        let trimmed = trim_end.get() - trim_start.get();
        let output_micros = u64::try_from(u128::from(trimmed) * 1_000 / u128::from(speed.milli()))
            .map_err(|_| SpeechError::InvalidOption("edited duration overflow"))?;
        let output_duration = TimeMicros::new(output_micros)?;

        let mut filters = vec![
            AudioFilter::Trim {
                start: trim_start,
                end: trim_end,
            },
            AudioFilter::ResetTimestamps,
        ];
        filters.extend(tempo_stages(speed));
        Ok(Self {
            source,
            source_duration,
            trim,
            speed,
            filters,
            output_duration,
        })
    }

    #[must_use]
    pub fn source(&self) -> &AudioAsset {
        &self.source
    }

    #[must_use]
    pub fn source_duration(&self) -> TimeMicros {
        self.source_duration
    }

    #[must_use]
    pub fn trim(&self) -> NormalizedTrim {
        self.trim
    }

    #[must_use]
    pub fn speed(&self) -> SpeedFactor {
        self.speed
    }

    #[must_use]
    pub fn filters(&self) -> &[AudioFilter] {
        &self.filters
    }

    #[must_use]
    pub fn output_duration(&self) -> TimeMicros {
        self.output_duration
    }
}

impl std::fmt::Debug for AudioEditPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AudioEditPlan")
            .field("source", &self.source)
            .field("source_duration", &self.source_duration)
            .field("trim", &self.trim)
            .field("speed", &self.speed)
            .field("filters", &self.filters)
            .field("output_duration", &self.output_duration)
            .finish()
    }
}

#[derive(Clone)]
pub struct ReferencePreparationPlan {
    source: AudioAsset,
    trim: Option<(TimeMicros, TimeMicros)>,
    filters: Vec<AudioFilter>,
}

impl ReferencePreparationPlan {
    #[must_use]
    pub fn for_f5(source: AudioAsset) -> Self {
        Self {
            source,
            trim: None,
            filters: vec![
                AudioFilter::Resample {
                    sample_rate: 44_100,
                    channels: 2,
                },
                AudioFilter::AppendSilence {
                    duration: TimeMicros::from_millis(1_000).expect("one second is valid"),
                },
            ],
        }
    }

    pub fn with_segment(mut self, start: TimeMicros, end: TimeMicros) -> Result<Self> {
        if start >= end {
            return Err(SpeechError::InvalidOption(
                "reference segment start must precede end",
            ));
        }
        self.trim = Some((start, end));
        self.filters.insert(0, AudioFilter::ResetTimestamps);
        self.filters.insert(0, AudioFilter::Trim { start, end });
        Ok(self)
    }

    #[must_use]
    pub fn source(&self) -> &AudioAsset {
        &self.source
    }

    #[must_use]
    pub fn segment(&self) -> Option<(TimeMicros, TimeMicros)> {
        self.trim
    }

    #[must_use]
    pub fn filters(&self) -> &[AudioFilter] {
        &self.filters
    }
}

impl std::fmt::Debug for ReferencePreparationPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReferencePreparationPlan")
            .field("source", &self.source)
            .field("trim", &self.trim)
            .field("filters", &self.filters)
            .finish()
    }
}

fn scale_time(duration: TimeMicros, point: NormalizedPoint) -> Result<TimeMicros> {
    let value = u64::try_from(
        u128::from(duration.get()) * u128::from(point.millionths()) / u128::from(NORMALIZED_SCALE),
    )
    .map_err(|_| SpeechError::InvalidOption("trim time overflow"))?;
    TimeMicros::new(value)
}

fn tempo_stages(speed: SpeedFactor) -> Vec<AudioFilter> {
    let speed = u32::from(speed.milli());
    let factors = if speed < 500 {
        vec![500_000, speed * 2_000]
    } else if speed > 2_000 {
        vec![2_000_000, speed * 500]
    } else if speed == 1_000 {
        Vec::new()
    } else {
        vec![speed * 1_000]
    };
    factors
        .into_iter()
        .map(|factor_millionths| AudioFilter::Tempo { factor_millionths })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset() -> (tempfile::TempDir, AudioAsset) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.wav");
        std::fs::write(&path, b"RIFFfixtureWAVEdata").unwrap();
        let asset = AudioAsset::from_native_file(&path).unwrap();
        (directory, asset)
    }

    #[test]
    fn edit_plan_uses_deterministic_integer_timing() {
        let (_directory, source) = asset();
        let trim = NormalizedTrim::new(
            NormalizedPoint::from_millionths(250_000).unwrap(),
            NormalizedPoint::from_millionths(750_000).unwrap(),
        )
        .unwrap();
        let plan = AudioEditPlan::new(
            source,
            TimeMicros::from_millis(10_000).unwrap(),
            trim,
            SpeedFactor::from_milli(1_250).unwrap(),
        )
        .unwrap();
        assert_eq!(plan.output_duration().get(), 4_000_000);
        assert_eq!(
            plan.filters(),
            &[
                AudioFilter::Trim {
                    start: TimeMicros::from_millis(2_500).unwrap(),
                    end: TimeMicros::from_millis(7_500).unwrap(),
                },
                AudioFilter::ResetTimestamps,
                AudioFilter::Tempo {
                    factor_millionths: 1_250_000,
                },
            ]
        );
    }

    #[test]
    fn extreme_speeds_decompose_into_supported_atempo_stages() {
        let slow = tempo_stages(SpeedFactor::from_milli(250).unwrap());
        let fast = tempo_stages(SpeedFactor::from_milli(4_000).unwrap());
        assert_eq!(
            slow,
            vec![
                AudioFilter::Tempo {
                    factor_millionths: 500_000,
                },
                AudioFilter::Tempo {
                    factor_millionths: 500_000,
                }
            ]
        );
        assert_eq!(
            fast,
            vec![
                AudioFilter::Tempo {
                    factor_millionths: 2_000_000,
                },
                AudioFilter::Tempo {
                    factor_millionths: 2_000_000,
                }
            ]
        );
    }

    #[test]
    fn reference_plan_preserves_f5_silence_padding_capability() {
        let (_directory, source) = asset();
        let plan = ReferencePreparationPlan::for_f5(source)
            .with_segment(
                TimeMicros::from_millis(500).unwrap(),
                TimeMicros::from_millis(2_000).unwrap(),
            )
            .unwrap();
        assert_eq!(plan.filters().len(), 4);
        assert!(matches!(
            plan.filters().last(),
            Some(AudioFilter::AppendSilence { duration }) if duration.get() == 1_000_000
        ));
    }
}
