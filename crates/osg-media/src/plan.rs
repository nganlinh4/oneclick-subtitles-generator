use crate::compatibility::{CompatibilityDecision, ConversionAction};
use crate::{MediaError, MediaInput, MediaOutput, Result};
use std::ffi::OsStr;

mod args;
mod narration;

pub use narration::{
    MAX_NARRATION_MIX_DURATION_US, MAX_NARRATION_MIX_INPUTS, NarrationAudioEditPlan,
    NarrationMixClip, NarrationMixPlan,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioSampleRate(u32);

impl AudioSampleRate {
    pub fn new(hertz: u32) -> Result<Self> {
        if !(8_000..=192_000).contains(&hertz) {
            return Err(MediaError::InvalidOption(
                "audio sample rate must be between 8,000 and 192,000 Hz",
            ));
        }
        Ok(Self(hertz))
    }

    #[must_use]
    pub fn hertz(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelCount(u8);

impl ChannelCount {
    pub fn new(channels: u8) -> Result<Self> {
        if !(1..=8).contains(&channels) {
            return Err(MediaError::InvalidOption(
                "channel count must be between one and eight",
            ));
        }
        Ok(Self(channels))
    }

    #[must_use]
    pub fn get(self) -> u8 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioBitrate(u32);

impl AudioBitrate {
    pub fn new(kilobits_per_second: u32) -> Result<Self> {
        if !(32..=512).contains(&kilobits_per_second) {
            return Err(MediaError::InvalidOption(
                "audio bitrate must be between 32 and 512 kbps",
            ));
        }
        Ok(Self(kilobits_per_second))
    }

    #[must_use]
    pub fn kilobits_per_second(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MediaTimeRange {
    pub start_us: u64,
    pub duration_us: Option<u64>,
}

impl MediaTimeRange {
    pub fn new(start_us: u64, duration_us: Option<u64>) -> Result<Self> {
        if duration_us == Some(0) {
            return Err(MediaError::InvalidOption(
                "media range duration must be positive",
            ));
        }
        if duration_us.is_some_and(|duration| start_us.checked_add(duration).is_none()) {
            return Err(MediaError::InvalidOption(
                "media range exceeds the time limit",
            ));
        }
        Ok(Self {
            start_us,
            duration_us,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EncoderPreset {
    Ultrafast,
    Veryfast,
    #[default]
    Faster,
    Fast,
    Medium,
    Slow,
}

impl EncoderPreset {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ultrafast => "ultrafast",
            Self::Veryfast => "veryfast",
            Self::Faster => "faster",
            Self::Fast => "fast",
            Self::Medium => "medium",
            Self::Slow => "slow",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConversionOptions {
    pub crf: u8,
    pub preset: EncoderPreset,
    pub audio_bitrate: AudioBitrate,
    pub audio_sample_rate: AudioSampleRate,
}

impl Default for ConversionOptions {
    fn default() -> Self {
        Self {
            crf: 23,
            preset: EncoderPreset::Faster,
            audio_bitrate: AudioBitrate(128),
            audio_sample_rate: AudioSampleRate(48_000),
        }
    }
}

impl ConversionOptions {
    pub fn new(
        crf: u8,
        preset: EncoderPreset,
        audio_bitrate: AudioBitrate,
        audio_sample_rate: AudioSampleRate,
    ) -> Result<Self> {
        if crf > 51 {
            return Err(MediaError::InvalidOption(
                "H.264 CRF must be between 0 and 51",
            ));
        }
        Ok(Self {
            crf,
            preset,
            audio_bitrate,
            audio_sample_rate,
        })
    }
}

#[derive(Clone, Debug)]
pub struct CompatibilityConversionPlan {
    input: MediaInput,
    output: MediaOutput,
    action: ConversionAction,
    options: ConversionOptions,
    expected_duration_us: Option<u64>,
}

impl CompatibilityConversionPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        decision: &CompatibilityDecision,
        options: ConversionOptions,
        expected_duration_us: Option<u64>,
    ) -> Result<Self> {
        if !has_extension(&output, &["mp4", "m4v"]) {
            return Err(MediaError::InvalidOption(
                "compatibility conversion output must be MP4",
            ));
        }
        if matches!(
            decision.action,
            ConversionAction::Direct | ConversionAction::Reject
        ) {
            return Err(MediaError::UnsupportedConversion);
        }
        Ok(Self {
            input,
            output,
            action: decision.action,
            options,
            expected_duration_us,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioOutput {
    WavPcm16 {
        sample_rate: AudioSampleRate,
        channels: ChannelCount,
    },
    M4aAac {
        bitrate: AudioBitrate,
    },
    Mp3 {
        bitrate: AudioBitrate,
    },
    Flac {
        sample_rate: AudioSampleRate,
        channels: ChannelCount,
    },
}

#[derive(Clone, Debug)]
pub struct AudioExtractionPlan {
    input: MediaInput,
    output: MediaOutput,
    format: AudioOutput,
    range: MediaTimeRange,
}

/// Produces a small, standards-compatible black video for an audio-only input.
/// This preserves the legacy application's observable 256x144/15fps behavior
/// without accepting arbitrary filter graphs from an untrusted boundary.
#[derive(Clone, Debug)]
pub struct AudioVisualizationPlan {
    input: MediaInput,
    output: MediaOutput,
    expected_duration_us: Option<u64>,
}

impl AudioVisualizationPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        expected_duration_us: Option<u64>,
    ) -> Result<Self> {
        if !has_extension(&output, &["mp4", "m4v"]) {
            return Err(MediaError::InvalidOption(
                "audio visualization output must be MP4",
            ));
        }
        if expected_duration_us == Some(0) {
            return Err(MediaError::InvalidOption(
                "audio visualization duration must be positive",
            ));
        }
        Ok(Self {
            input,
            output,
            expected_duration_us,
        })
    }
}

/// Creates an accurate, independently uploadable MP4 clip from a bounded time
/// range. Re-encoding avoids keyframe-aligned seek drift and guarantees the
/// portable H.264/AAC contract used by both webviews and Gemini.
#[derive(Clone, Debug)]
pub struct VideoClipPlan {
    input: MediaInput,
    output: MediaOutput,
    range: MediaTimeRange,
    options: ConversionOptions,
}

impl VideoClipPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        range: MediaTimeRange,
        options: ConversionOptions,
    ) -> Result<Self> {
        if !has_extension(&output, &["mp4", "m4v"]) {
            return Err(MediaError::InvalidOption("video clip output must be MP4"));
        }
        if range.duration_us.is_none() {
            return Err(MediaError::InvalidOption(
                "video clip duration must be specified",
            ));
        }
        Ok(Self {
            input,
            output,
            range,
            options,
        })
    }
}

impl AudioExtractionPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        format: AudioOutput,
        range: MediaTimeRange,
    ) -> Result<Self> {
        let extensions: &[&str] = match format {
            AudioOutput::WavPcm16 { .. } => &["wav"],
            AudioOutput::M4aAac { .. } => &["m4a", "mp4"],
            AudioOutput::Mp3 { .. } => &["mp3"],
            AudioOutput::Flac { .. } => &["flac"],
        };
        if !has_extension(&output, extensions) {
            return Err(MediaError::InvalidOption(
                "audio output extension does not match its codec",
            ));
        }
        Ok(Self {
            input,
            output,
            format,
            range,
        })
    }

    pub fn asr_wav(input: MediaInput, output: MediaOutput, range: MediaTimeRange) -> Result<Self> {
        Self::new(
            input,
            output,
            AudioOutput::WavPcm16 {
                sample_rate: AudioSampleRate(16_000),
                channels: ChannelCount(1),
            },
            range,
        )
    }
}

#[derive(Clone, Debug)]
pub struct WaveformPlan {
    input: MediaInput,
    output: MediaOutput,
    sample_rate_hz: u32,
    points_per_second: u32,
    max_points: usize,
    range: MediaTimeRange,
}

impl WaveformPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        duration_us: Option<u64>,
        desired_points_per_second: u32,
        max_points: usize,
        range: MediaTimeRange,
    ) -> Result<Self> {
        if !has_extension(&output, &["pcm", "s16le"]) {
            return Err(MediaError::InvalidOption(
                "waveform extraction output must use .pcm or .s16le",
            ));
        }
        if !(1..=400).contains(&desired_points_per_second)
            || !(1_000..=10_000_000).contains(&max_points)
        {
            return Err(MediaError::InvalidOption(
                "invalid waveform density or point limit",
            ));
        }
        let effective_duration = range.duration_us.or(duration_us);
        let points_per_second = effective_duration.map_or(desired_points_per_second, |duration| {
            let seconds = duration.div_ceil(1_000_000).max(1);
            let capped = u64::try_from(max_points)
                .unwrap_or(u64::MAX)
                .checked_div(seconds)
                .unwrap_or_default()
                .max(1);
            desired_points_per_second.min(u32::try_from(capped).unwrap_or(u32::MAX))
        });
        let sample_rate_hz = points_per_second.saturating_mul(4).clamp(400, 4_000);
        Ok(Self {
            input,
            output,
            sample_rate_hz,
            points_per_second,
            max_points,
            range,
        })
    }

    #[must_use]
    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    #[must_use]
    pub fn points_per_second(&self) -> u32 {
        self.points_per_second
    }

    #[must_use]
    pub fn max_points(&self) -> usize {
        self.max_points
    }

    pub(crate) fn output(&self) -> &MediaOutput {
        &self.output
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThumbnailFormat {
    Jpeg { quality: u8 },
    Png { compression: u8 },
    WebP { quality: u8 },
}

#[derive(Clone, Debug)]
pub struct ThumbnailPlan {
    input: MediaInput,
    output: MediaOutput,
    at_us: u64,
    max_width: u16,
    max_height: u16,
    format: ThumbnailFormat,
}

impl ThumbnailPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        at_us: u64,
        max_width: u16,
        max_height: u16,
        format: ThumbnailFormat,
    ) -> Result<Self> {
        if !(16..=8_192).contains(&max_width) || !(16..=8_192).contains(&max_height) {
            return Err(MediaError::InvalidOption(
                "thumbnail dimensions must be between 16 and 8,192 pixels",
            ));
        }
        let (extensions, quality_ok): (&[&str], bool) = match format {
            ThumbnailFormat::Jpeg { quality } => (&["jpg", "jpeg"], (1..=31).contains(&quality)),
            ThumbnailFormat::Png { compression } => (&["png"], compression <= 9),
            ThumbnailFormat::WebP { quality } => (&["webp"], quality <= 100),
        };
        if !quality_ok || !has_extension(&output, extensions) {
            return Err(MediaError::InvalidOption(
                "thumbnail format, quality, or extension is invalid",
            ));
        }
        Ok(Self {
            input,
            output,
            at_us,
            max_width,
            max_height,
            format,
        })
    }
}

#[derive(Clone, Debug)]
pub enum MediaOperation {
    CompatibilityConversion(CompatibilityConversionPlan),
    AudioExtraction(AudioExtractionPlan),
    NarrationAudioEdit(NarrationAudioEditPlan),
    NarrationMix(NarrationMixPlan),
    AudioVisualization(AudioVisualizationPlan),
    VideoClip(VideoClipPlan),
    Waveform(WaveformPlan),
    Thumbnail(ThumbnailPlan),
}

fn has_extension(output: &MediaOutput, allowed: &[&str]) -> bool {
    output
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            allowed
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

#[cfg(test)]
mod tests;
