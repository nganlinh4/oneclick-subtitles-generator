use crate::compatibility::{CompatibilityDecision, ConversionAction};
use crate::{MediaError, MediaInput, MediaOutput, Result};
use std::ffi::OsStr;

mod args;

pub const MAX_NARRATION_MIX_INPUTS: usize = 64;
pub const MAX_NARRATION_MIX_DURATION_US: u64 = 4 * 60 * 60 * 1_000_000;

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

/// A bounded narration edit expressed entirely as typed timing and speed
/// values. The resulting `FFmpeg` filter graph is derived internally; callers
/// cannot provide filter names or process arguments.
#[derive(Clone, Debug)]
pub struct NarrationAudioEditPlan {
    input: MediaInput,
    output: MediaOutput,
    start_us: u64,
    end_us: u64,
    speed_milli: u16,
    expected_duration_us: u64,
}

impl NarrationAudioEditPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        start_us: u64,
        end_us: u64,
        speed_milli: u16,
    ) -> Result<Self> {
        if start_us >= end_us {
            return Err(MediaError::InvalidOption(
                "narration edit start must precede its end",
            ));
        }
        if !(250..=4_000).contains(&speed_milli) {
            return Err(MediaError::InvalidOption(
                "narration edit speed must be between 0.25x and 4x",
            ));
        }
        if !has_extension(&output, &["wav"]) {
            return Err(MediaError::InvalidOption(
                "narration edit output must use WAV",
            ));
        }
        let trimmed_duration = end_us - start_us;
        let expected_duration_us =
            u64::try_from(u128::from(trimmed_duration) * 1_000 / u128::from(speed_milli))
                .map_err(|_| MediaError::InvalidOption("narration edit duration overflow"))?;
        if expected_duration_us == 0 || expected_duration_us > MAX_NARRATION_MIX_DURATION_US {
            return Err(MediaError::InvalidOption(
                "narration edit duration is outside the supported range",
            ));
        }
        Ok(Self {
            input,
            output,
            start_us,
            end_us,
            speed_milli,
            expected_duration_us,
        })
    }
}

/// One internally-authorized audio input on a narration timeline. The path is
/// retained as a native capability and the offset is represented in integer
/// microseconds until the fixed 48 kHz render graph is built.
#[derive(Clone, Debug)]
pub struct NarrationMixClip {
    input: MediaInput,
    start_us: u64,
}

impl NarrationMixClip {
    #[must_use]
    pub const fn new(input: MediaInput, start_us: u64) -> Self {
        Self { input, start_us }
    }
}

/// A bounded narration timeline mix. `FFmpeg` arguments and filters are derived
/// exclusively from these typed values; callers cannot supply a filter graph.
#[derive(Clone, Debug)]
pub struct NarrationMixPlan {
    clips: Vec<NarrationMixClip>,
    output: MediaOutput,
    format: AudioOutput,
    duration_us: u64,
}

impl NarrationMixPlan {
    pub fn new(
        clips: Vec<NarrationMixClip>,
        output: MediaOutput,
        format: AudioOutput,
        duration_us: u64,
    ) -> Result<Self> {
        if clips.is_empty() || clips.len() > MAX_NARRATION_MIX_INPUTS {
            return Err(MediaError::InvalidOption(
                "narration mix requires between one and 64 clips",
            ));
        }
        if duration_us == 0 || duration_us > MAX_NARRATION_MIX_DURATION_US {
            return Err(MediaError::InvalidOption(
                "narration mix duration must be between one microsecond and four hours",
            ));
        }
        if clips.iter().any(|clip| clip.start_us >= duration_us) {
            return Err(MediaError::InvalidOption(
                "narration clip starts outside the output timeline",
            ));
        }
        let extensions: &[&str] = match format {
            AudioOutput::WavPcm16 { .. } => &["wav"],
            AudioOutput::M4aAac { .. } => &["m4a", "mp4"],
            AudioOutput::Flac { .. } => &["flac"],
            AudioOutput::Mp3 { .. } => {
                return Err(MediaError::InvalidOption(
                    "narration mix output must use WAV, FLAC, or M4A",
                ));
            }
        };
        if !has_extension(&output, extensions) {
            return Err(MediaError::InvalidOption(
                "narration mix output extension does not match its codec",
            ));
        }
        Ok(Self {
            clips,
            output,
            format,
            duration_us,
        })
    }
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
mod tests {
    use super::*;
    use crate::{CompatibilityProfile, MediaMetadata, parse_ffprobe_json};
    use std::path::Path;

    fn paths(extension: &str) -> (tempfile::TempDir, MediaInput, MediaOutput) {
        let directory = tempfile::tempdir().unwrap();
        let input_path = directory.path().join("input;$(unsafe).mp4");
        std::fs::write(&input_path, b"media").unwrap();
        let input = MediaInput::from_native_selection(&input_path).unwrap();
        let output = MediaOutput::within_root(
            directory.path().join(format!("output.{extension}")),
            directory.path(),
        )
        .unwrap();
        (directory, input, output)
    }

    fn incompatible_metadata() -> MediaMetadata {
        parse_ffprobe_json(
            br#"{"streams":[{"index":0,"codec_type":"video","codec_name":"vp9","width":1920,"height":1080,"pix_fmt":"yuv444p"},{"index":1,"codec_type":"audio","codec_name":"vorbis"}],"format":{"format_name":"webm","duration":"5"}}"#,
        )
        .unwrap()
    }

    #[test]
    fn conversion_args_are_typed_and_keep_metacharacter_path_in_one_argument() {
        let (_directory, input, output) = paths("mp4");
        let decision = CompatibilityDecision::analyze(
            &incompatible_metadata(),
            CompatibilityProfile::PortableWebView,
        );
        let operation = MediaOperation::CompatibilityConversion(
            CompatibilityConversionPlan::new(
                input.clone(),
                output,
                &decision,
                ConversionOptions::default(),
                Some(5_000_000),
            )
            .unwrap(),
        );
        let args = operation.build_args(Path::new("staging.mp4"));
        let input_position = args.iter().position(|arg| arg == "-i").unwrap() + 1;
        assert_eq!(args[input_position], input.as_path().as_os_str());
        assert!(args.iter().any(|arg| arg == "libx264"));
        assert!(args.iter().any(|arg| arg == "aac"));
    }

    #[test]
    fn asr_plan_is_fixed_mono_16khz_pcm() {
        let (_directory, input, output) = paths("wav");
        let operation = MediaOperation::AudioExtraction(
            AudioExtractionPlan::asr_wav(input, output, MediaTimeRange::default()).unwrap(),
        );
        let joined = operation
            .build_args(Path::new("staging.wav"))
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("-c:a pcm_s16le -ar 16000 -ac 1"));
    }

    #[test]
    fn narration_mix_is_bounded_and_uses_sample_precise_closed_filters() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first;$(private).wav");
        let second_path = directory.path().join("second.wav");
        std::fs::write(&first_path, b"audio").unwrap();
        std::fs::write(&second_path, b"audio").unwrap();
        let first = MediaInput::from_native_selection(&first_path).unwrap();
        let second = MediaInput::from_native_selection(&second_path).unwrap();
        let output =
            MediaOutput::within_root(directory.path().join("aligned.m4a"), directory.path())
                .unwrap();
        let operation = MediaOperation::NarrationMix(
            NarrationMixPlan::new(
                vec![
                    NarrationMixClip::new(first.clone(), 0),
                    NarrationMixClip::new(second.clone(), 1_234_567),
                ],
                output,
                AudioOutput::M4aAac {
                    bitrate: AudioBitrate::new(192).unwrap(),
                },
                2_000_001,
            )
            .unwrap(),
        );
        let args = operation.build_args(Path::new("staging.m4a"));
        let inputs = args
            .windows(2)
            .filter(|pair| pair[0] == "-i")
            .map(|pair| pair[1].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            inputs,
            vec![
                first.as_path().as_os_str().to_owned(),
                second.as_path().as_os_str().to_owned(),
            ]
        );
        let graph = args
            .windows(2)
            .find(|pair| pair[0] == "-filter_complex")
            .map(|pair| pair[1].to_string_lossy())
            .unwrap();
        assert!(graph.contains("adelay=59259S:all=1"));
        assert!(graph.contains("apad=whole_len=96001"));
        assert!(graph.contains("atrim=end_sample=96001"));
        assert!(!graph.contains("private"));
        assert!(
            NarrationMixPlan::new(
                Vec::new(),
                MediaOutput::within_root(directory.path().join("empty.wav"), directory.path())
                    .unwrap(),
                AudioOutput::WavPcm16 {
                    sample_rate: AudioSampleRate::new(48_000).unwrap(),
                    channels: ChannelCount::new(2).unwrap(),
                },
                1,
            )
            .is_err()
        );
    }

    #[test]
    fn narration_audio_edit_uses_closed_sample_precise_filters() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source;$(private).wav");
        std::fs::write(&source_path, b"audio").unwrap();
        let input = MediaInput::from_native_selection(&source_path).unwrap();
        let output =
            MediaOutput::within_root(directory.path().join("edited.wav"), directory.path())
                .unwrap();
        let operation = MediaOperation::NarrationAudioEdit(
            NarrationAudioEditPlan::new(input, output, 250_001, 1_750_001, 3_000).unwrap(),
        );
        let args = operation.build_args(Path::new("staging.wav"));
        let filter = args
            .windows(2)
            .find(|pair| pair[0] == "-af")
            .map(|pair| pair[1].to_string_lossy())
            .unwrap();
        assert!(filter.contains("atrim=start_sample=12000:end_sample=84001"));
        assert!(filter.contains("atempo=2.000,atempo=1.500"));
        assert!(!filter.contains("private"));
        assert_eq!(operation.expected_duration_us(), Some(500_000));
    }

    #[test]
    fn narration_audio_edit_rejects_invalid_ranges_speeds_and_formats() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.wav");
        std::fs::write(&source_path, b"audio").unwrap();
        let input = MediaInput::from_native_selection(&source_path).unwrap();
        let output = || {
            MediaOutput::within_root(directory.path().join("edited.wav"), directory.path()).unwrap()
        };
        assert!(NarrationAudioEditPlan::new(input.clone(), output(), 1, 1, 1_000).is_err());
        assert!(NarrationAudioEditPlan::new(input.clone(), output(), 0, 1_000, 249).is_err());
        let wrong = MediaOutput::within_root(directory.path().join("edited.mp3"), directory.path())
            .unwrap();
        assert!(NarrationAudioEditPlan::new(input, wrong, 0, 1_000, 1_000).is_err());
    }

    #[test]
    fn audio_visualization_is_a_fixed_safe_legacy_compatible_canvas() {
        let (_directory, input, output) = paths("mp4");
        let operation = MediaOperation::AudioVisualization(
            AudioVisualizationPlan::new(input.clone(), output, Some(5_000_000)).unwrap(),
        );
        let args = operation.build_args(Path::new("staging.mp4"));
        let input_position = args.iter().position(|arg| arg == "-i").unwrap() + 1;
        assert_eq!(args[input_position], input.as_path().as_os_str());
        let joined = args
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("color=c=black:s=256x144:r=15"));
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("-c:a aac -b:a 128k"));
    }

    #[test]
    fn video_clip_is_accurate_portable_and_requires_a_bounded_range() {
        let (_directory, input, output) = paths("mp4");
        let range = MediaTimeRange::new(1_250_000, Some(2_500_000)).unwrap();
        let operation = MediaOperation::VideoClip(
            VideoClipPlan::new(input, output, range, ConversionOptions::default()).unwrap(),
        );
        let joined = operation
            .build_args(Path::new("staging.mp4"))
            .iter()
            .map(|argument| argument.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("-ss 1.250000 -t 2.500000"));
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("-c:a aac"));
        assert!(joined.contains("-reset_timestamps 1"));

        let (_directory, input, output) = paths("mp4");
        assert!(
            VideoClipPlan::new(
                input,
                output,
                MediaTimeRange::default(),
                ConversionOptions::default()
            )
            .is_err()
        );
        assert!(MediaTimeRange::new(u64::MAX, Some(1)).is_err());
    }

    #[test]
    fn waveform_density_is_capped_for_long_media() {
        let (_directory, input, output) = paths("pcm");
        let plan = WaveformPlan::new(
            input,
            output,
            Some(10 * 60 * 60 * 1_000_000),
            200,
            1_000_000,
            MediaTimeRange::default(),
        )
        .unwrap();
        assert!(plan.points_per_second() < 200);
        assert!(plan.sample_rate_hz() >= 400);
    }
}
