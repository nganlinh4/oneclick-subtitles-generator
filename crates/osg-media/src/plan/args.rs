use super::{
    AudioExtractionPlan, AudioOutput, AudioVisualizationPlan, CompatibilityConversionPlan,
    ConversionOptions, MediaOperation, MediaTimeRange, NarrationAudioEditPlan, NarrationMixPlan,
    ThumbnailFormat, ThumbnailPlan, VideoClipPlan, WaveformPlan,
};
use crate::compatibility::ConversionAction;
use crate::{MediaInput, MediaOutput};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::Path;

const NARRATION_SAMPLE_RATE_HZ: u64 = 48_000;
const MICROS_PER_SECOND: u64 = 1_000_000;

impl MediaOperation {
    pub(crate) fn output(&self) -> &MediaOutput {
        match self {
            Self::CompatibilityConversion(plan) => &plan.output,
            Self::AudioExtraction(plan) => &plan.output,
            Self::NarrationAudioEdit(plan) => &plan.output,
            Self::NarrationMix(plan) => &plan.output,
            Self::AudioVisualization(plan) => &plan.output,
            Self::VideoClip(plan) => &plan.output,
            Self::Waveform(plan) => &plan.output,
            Self::Thumbnail(plan) => &plan.output,
        }
    }

    pub(crate) fn expected_duration_us(&self) -> Option<u64> {
        match self {
            Self::CompatibilityConversion(plan) => plan.expected_duration_us,
            Self::AudioExtraction(plan) => plan.range.duration_us,
            Self::NarrationAudioEdit(plan) => Some(plan.expected_duration_us),
            Self::NarrationMix(plan) => Some(plan.duration_us),
            Self::AudioVisualization(plan) => plan.expected_duration_us,
            Self::VideoClip(plan) => plan.range.duration_us,
            Self::Waveform(plan) => plan.range.duration_us,
            Self::Thumbnail(_) => None,
        }
    }

    pub(crate) fn build_args(&self, staging_output: &Path) -> Vec<OsString> {
        let mut args = ffmpeg_prefix();
        match self {
            Self::CompatibilityConversion(plan) => add_compatibility_args(&mut args, plan),
            Self::AudioExtraction(plan) => add_audio_extraction_args(&mut args, plan),
            Self::NarrationAudioEdit(plan) => add_narration_audio_edit_args(&mut args, plan),
            Self::NarrationMix(plan) => add_narration_mix_args(&mut args, plan),
            Self::AudioVisualization(plan) => add_audio_visualization_args(&mut args, plan),
            Self::VideoClip(plan) => add_video_clip_args(&mut args, plan),
            Self::Waveform(plan) => add_waveform_args(&mut args, plan),
            Self::Thumbnail(plan) => add_thumbnail_args(&mut args, plan),
        }
        args.push(staging_output.as_os_str().to_owned());
        args
    }
}

fn add_compatibility_args(args: &mut Vec<OsString>, plan: &CompatibilityConversionPlan) {
    add_input(args, &plan.input, MediaTimeRange::default());
    push(args, &["-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"]);
    add_conversion_codecs(args, plan.action, plan.options);
    push(
        args,
        &[
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-max_muxing_queue_size",
            "4096",
            "-movflags",
            "+faststart",
        ],
    );
}

fn add_audio_extraction_args(args: &mut Vec<OsString>, plan: &AudioExtractionPlan) {
    add_input(args, &plan.input, plan.range);
    push(
        args,
        &["-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1"],
    );
    add_audio_output(args, plan.format);
}

fn add_narration_audio_edit_args(args: &mut Vec<OsString>, plan: &NarrationAudioEditPlan) {
    add_input(args, &plan.input, MediaTimeRange::default());
    let start_sample = plan.start_us.saturating_mul(NARRATION_SAMPLE_RATE_HZ) / MICROS_PER_SECOND;
    let end_sample = plan
        .end_us
        .saturating_mul(NARRATION_SAMPLE_RATE_HZ)
        .saturating_add(MICROS_PER_SECOND - 1)
        / MICROS_PER_SECOND;
    let mut filters = vec![
        "aresample=48000".to_owned(),
        "aformat=sample_fmts=s16:channel_layouts=stereo".to_owned(),
        format!("atrim=start_sample={start_sample}:end_sample={end_sample}"),
        "asetpts=N/SR/TB".to_owned(),
    ];
    filters.extend(tempo_factors(plan.speed_milli).map(|factor| format!("atempo={factor}")));
    push(
        args,
        &[
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-af",
        ],
    );
    args.push(filters.join(",").into());
    add_audio_output(
        args,
        AudioOutput::WavPcm16 {
            sample_rate: super::AudioSampleRate(48_000),
            channels: super::ChannelCount(2),
        },
    );
}

fn tempo_factors(speed_milli: u16) -> impl Iterator<Item = String> {
    let factors = if speed_milli < 500 {
        vec![500_u16, speed_milli.saturating_mul(2)]
    } else if speed_milli > 2_000 {
        vec![2_000_u16, speed_milli / 2]
    } else if speed_milli == 1_000 {
        Vec::new()
    } else {
        vec![speed_milli]
    };
    factors
        .into_iter()
        .map(|factor| format!("{}.{:03}", factor / 1_000, factor % 1_000))
}

fn add_narration_mix_args(args: &mut Vec<OsString>, plan: &NarrationMixPlan) {
    for clip in &plan.clips {
        add_input(args, &clip.input, MediaTimeRange::default());
    }

    let mut chains = Vec::with_capacity(plan.clips.len());
    let mut labels = String::new();
    for (index, clip) in plan.clips.iter().enumerate() {
        let delay_samples = clip
            .start_us
            .saturating_mul(NARRATION_SAMPLE_RATE_HZ)
            .saturating_add(MICROS_PER_SECOND / 2)
            / MICROS_PER_SECOND;
        chains.push(format!(
            "[{index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay={delay_samples}S:all=1[n{index}]"
        ));
        write!(labels, "[n{index}]").expect("writing to a string cannot fail");
    }

    let output_samples = plan
        .duration_us
        .saturating_mul(NARRATION_SAMPLE_RATE_HZ)
        .saturating_add(MICROS_PER_SECOND - 1)
        / MICROS_PER_SECOND;
    let tail = if plan.clips.len() == 1 {
        format!(
            "{labels}alimiter=limit=0.95:attack=5:release=50:level=0:latency=1,apad=whole_len={output_samples},atrim=end_sample={output_samples},asetpts=N/SR/TB[out]"
        )
    } else {
        format!(
            "{labels}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:attack=5:release=50:level=0:latency=1,apad=whole_len={output_samples},atrim=end_sample={output_samples},asetpts=N/SR/TB[out]",
            plan.clips.len()
        )
    };
    chains.push(tail);
    push(args, &["-filter_complex"]);
    args.push(chains.join(";").into());
    push(
        args,
        &[
            "-map",
            "[out]",
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
        ],
    );
    add_audio_output(args, plan.format);
}

fn add_audio_visualization_args(args: &mut Vec<OsString>, plan: &AudioVisualizationPlan) {
    add_input(args, &plan.input, MediaTimeRange::default());
    push(
        args,
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x144:r=15",
            "-map",
            "1:v:0",
            "-map",
            "0:a:0",
            "-shortest",
            "-c:v",
            "libx264",
            "-tune",
            "stillimage",
            "-preset",
            "faster",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-movflags",
            "+faststart",
        ],
    );
}

fn add_video_clip_args(args: &mut Vec<OsString>, plan: &VideoClipPlan) {
    add_input(args, &plan.input, plan.range);
    push(
        args,
        &[
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-c:v",
            "libx264",
            "-profile:v",
            "main",
            "-preset",
        ],
    );
    args.push(plan.options.preset.as_str().into());
    push(args, &["-crf"]);
    args.push(plan.options.crf.to_string().into());
    push(
        args,
        &[
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:a",
            "aac",
            "-b:a",
        ],
    );
    args.push(format!("{}k", plan.options.audio_bitrate.0).into());
    push(args, &["-ar"]);
    args.push(plan.options.audio_sample_rate.0.to_string().into());
    push(
        args,
        &[
            "-ac",
            "2",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-reset_timestamps",
            "1",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
        ],
    );
}

fn add_waveform_args(args: &mut Vec<OsString>, plan: &WaveformPlan) {
    add_input(args, &plan.input, plan.range);
    push(
        args,
        &["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar"],
    );
    args.push(plan.sample_rate_hz.to_string().into());
    push(args, &["-c:a", "pcm_s16le", "-f", "s16le"]);
}

fn add_thumbnail_args(args: &mut Vec<OsString>, plan: &ThumbnailPlan) {
    args.push("-ss".into());
    args.push(format_time(plan.at_us).into());
    add_input(args, &plan.input, MediaTimeRange::default());
    push(
        args,
        &[
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
        ],
    );
    args.push(
        format!(
            "scale=w={}:h={}:force_original_aspect_ratio=decrease:force_divisible_by=2",
            plan.max_width, plan.max_height
        )
        .into(),
    );
    match plan.format {
        ThumbnailFormat::Jpeg { quality } => {
            push(args, &["-q:v"]);
            args.push(quality.to_string().into());
        }
        ThumbnailFormat::Png { compression } => {
            push(args, &["-compression_level"]);
            args.push(compression.to_string().into());
        }
        ThumbnailFormat::WebP { quality } => {
            push(args, &["-c:v", "libwebp", "-quality"]);
            args.push(quality.to_string().into());
        }
    }
}

fn ffmpeg_prefix() -> Vec<OsString> {
    [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        "-nostats",
        "-progress",
        "pipe:2",
        "-stats_period",
        "0.25",
        "-y",
    ]
    .into_iter()
    .map(Into::into)
    .collect()
}

fn add_input(args: &mut Vec<OsString>, input: &MediaInput, range: MediaTimeRange) {
    args.push("-i".into());
    args.push(input.as_path().as_os_str().to_owned());
    if range.start_us > 0 {
        args.push("-ss".into());
        args.push(format_time(range.start_us).into());
    }
    if let Some(duration) = range.duration_us {
        args.push("-t".into());
        args.push(format_time(duration).into());
    }
}

fn add_conversion_codecs(
    args: &mut Vec<OsString>,
    action: ConversionAction,
    options: ConversionOptions,
) {
    if matches!(
        action,
        ConversionAction::TranscodeVideo | ConversionAction::TranscodeAll
    ) {
        push(args, &["-c:v", "libx264", "-profile:v", "main", "-preset"]);
        args.push(options.preset.as_str().into());
        push(args, &["-crf"]);
        args.push(options.crf.to_string().into());
        push(
            args,
            &[
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            ],
        );
    } else {
        push(args, &["-c:v", "copy"]);
    }
    if matches!(
        action,
        ConversionAction::TranscodeAudio | ConversionAction::TranscodeAll
    ) {
        push(args, &["-c:a", "aac", "-b:a"]);
        args.push(format!("{}k", options.audio_bitrate.0).into());
        push(args, &["-ar"]);
        args.push(options.audio_sample_rate.0.to_string().into());
        push(args, &["-ac", "2"]);
    } else {
        push(args, &["-c:a", "copy"]);
    }
}

fn add_audio_output(args: &mut Vec<OsString>, output: AudioOutput) {
    match output {
        AudioOutput::WavPcm16 {
            sample_rate,
            channels,
        } => {
            push(args, &["-c:a", "pcm_s16le", "-ar"]);
            args.push(sample_rate.0.to_string().into());
            push(args, &["-ac"]);
            args.push(channels.0.to_string().into());
        }
        AudioOutput::M4aAac { bitrate } => {
            push(args, &["-c:a", "aac", "-b:a"]);
            args.push(format!("{}k", bitrate.0).into());
            push(args, &["-movflags", "+faststart"]);
        }
        AudioOutput::Mp3 { bitrate } => {
            push(args, &["-c:a", "libmp3lame", "-b:a"]);
            args.push(format!("{}k", bitrate.0).into());
        }
        AudioOutput::Flac {
            sample_rate,
            channels,
        } => {
            push(args, &["-c:a", "flac", "-ar"]);
            args.push(sample_rate.0.to_string().into());
            push(args, &["-ac"]);
            args.push(channels.0.to_string().into());
        }
    }
}

fn format_time(microseconds: u64) -> String {
    format!(
        "{}.{:06}",
        microseconds / 1_000_000,
        microseconds % 1_000_000
    )
}

fn push(args: &mut Vec<OsString>, values: &[&str]) {
    args.extend(values.iter().map(OsString::from));
}
