//! Media pipeline requests, validation, progress events and inspection DTOs.

use osg_domain::{AssetId, JobKind, JobSnapshot, MediaAsset};
use osg_media::{
    AudioBitrate, AudioOutput, AudioSampleRate, ChannelCount, ConversionAction, IssueKind,
    MediaError, MediaTimeRange, WaveformPyramid,
};
use osg_media_pipeline::MediaInspection;
use osg_media_server::RegisteredMedia;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{MAX_OPERATION_TIME_US, MAX_WAVEFORM_POINTS};
use crate::error::{CommandError, CommandResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaPipelineOperation {
    PreparePlayback,
    AnalysisClip,
    ExtractAudio,
    GenerateWaveform,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AudioFormatRequest {
    Wav,
    Mp3,
    Flac,
}

impl AudioFormatRequest {
    fn output(self) -> Result<AudioOutput, MediaError> {
        Ok(match self {
            Self::Wav => AudioOutput::WavPcm16 {
                sample_rate: AudioSampleRate::new(48_000)?,
                channels: ChannelCount::new(2)?,
            },
            Self::Mp3 => AudioOutput::Mp3 {
                bitrate: AudioBitrate::new(192)?,
            },
            Self::Flac => AudioOutput::Flac {
                sample_rate: AudioSampleRate::new(48_000)?,
                channels: ChannelCount::new(2)?,
            },
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MediaPipelineRequest {
    PreparePlayback {
        asset_id: AssetId,
    },
    AnalysisClip {
        asset_id: AssetId,
        start_us: u64,
        end_us: u64,
    },
    ExtractAudio {
        asset_id: AssetId,
        format: AudioFormatRequest,
        start_us: u64,
        end_us: Option<u64>,
    },
    GenerateWaveform {
        asset_id: AssetId,
        points_per_second: u32,
        max_points: usize,
        start_us: u64,
        end_us: Option<u64>,
    },
}

impl MediaPipelineRequest {
    pub(super) fn validate(self) -> CommandResult<ValidatedRequest> {
        match self {
            Self::PreparePlayback { asset_id } => Ok(ValidatedRequest {
                asset_id,
                operation: ValidatedOperation::PreparePlayback,
            }),
            Self::AnalysisClip {
                asset_id,
                start_us,
                end_us,
            } => Ok(ValidatedRequest {
                asset_id,
                operation: ValidatedOperation::AnalysisClip {
                    range: bounded_range(start_us, Some(end_us), true)?,
                },
            }),
            Self::ExtractAudio {
                asset_id,
                format,
                start_us,
                end_us,
            } => Ok(ValidatedRequest {
                asset_id,
                operation: ValidatedOperation::ExtractAudio {
                    format: format.output()?,
                    range: bounded_range(start_us, end_us, false)?,
                },
            }),
            Self::GenerateWaveform {
                asset_id,
                points_per_second,
                max_points,
                start_us,
                end_us,
            } => {
                if !(1..=400).contains(&points_per_second)
                    || !(1_000..=MAX_WAVEFORM_POINTS).contains(&max_points)
                {
                    return Err(CommandError::invalid_input(
                        "The waveform resolution is outside the supported range.",
                    ));
                }
                Ok(ValidatedRequest {
                    asset_id,
                    operation: ValidatedOperation::GenerateWaveform {
                        points_per_second,
                        max_points,
                        range: bounded_range(start_us, end_us, false)?,
                    },
                })
            }
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ValidatedRequest {
    pub(super) asset_id: AssetId,
    pub(super) operation: ValidatedOperation,
}

#[derive(Clone, Debug)]
pub(super) enum ValidatedOperation {
    PreparePlayback,
    AnalysisClip {
        range: MediaTimeRange,
    },
    ExtractAudio {
        format: AudioOutput,
        range: MediaTimeRange,
    },
    GenerateWaveform {
        points_per_second: u32,
        max_points: usize,
        range: MediaTimeRange,
    },
}

impl ValidatedOperation {
    pub(super) const fn wire_operation(&self) -> MediaPipelineOperation {
        match self {
            Self::PreparePlayback => MediaPipelineOperation::PreparePlayback,
            Self::AnalysisClip { .. } => MediaPipelineOperation::AnalysisClip,
            Self::ExtractAudio { .. } => MediaPipelineOperation::ExtractAudio,
            Self::GenerateWaveform { .. } => MediaPipelineOperation::GenerateWaveform,
        }
    }

    pub(super) const fn job_kind(&self) -> JobKind {
        match self {
            Self::GenerateWaveform { .. } => JobKind::GenerateWaveform,
            Self::PreparePlayback | Self::AnalysisClip { .. } | Self::ExtractAudio { .. } => {
                JobKind::ProcessMedia
            }
        }
    }

    pub(super) fn publication_metadata(&self, source_asset_id: AssetId) -> serde_json::Value {
        match self {
            Self::PreparePlayback => json!({
                "operation": "preparePlayback",
                "sourceAssetId": source_asset_id,
            }),
            Self::AnalysisClip { range } => json!({
                "operation": "analysisClip",
                "sourceAssetId": source_asset_id,
                "startUs": range.start_us,
                "endUs": range.duration_us.map(|duration| range.start_us + duration),
            }),
            Self::ExtractAudio { format, range } => json!({
                "operation": "extractAudio",
                "sourceAssetId": source_asset_id,
                "format": audio_output_name(*format),
                "startUs": range.start_us,
                "endUs": range.duration_us.map(|duration| range.start_us + duration),
            }),
            Self::GenerateWaveform {
                points_per_second,
                max_points,
                range,
            } => json!({
                "operation": "generateWaveform",
                "sourceAssetId": source_asset_id,
                "pointsPerSecond": points_per_second,
                "maxPoints": max_points,
                "startUs": range.start_us,
                "endUs": range.duration_us.map(|duration| range.start_us + duration),
            }),
        }
    }
}

const fn audio_output_name(format: AudioOutput) -> &'static str {
    match format {
        AudioOutput::WavPcm16 { .. } => "wav",
        AudioOutput::M4aAac { .. } => "m4a",
        AudioOutput::Mp3 { .. } => "mp3",
        AudioOutput::Flac { .. } => "flac",
    }
}

fn bounded_range(
    start_us: u64,
    end_us: Option<u64>,
    end_required: bool,
) -> CommandResult<MediaTimeRange> {
    if start_us > MAX_OPERATION_TIME_US
        || end_us.is_some_and(|end| end > MAX_OPERATION_TIME_US || end <= start_us)
        || (end_required && end_us.is_none())
        || (end_us.is_none() && start_us != 0)
    {
        return Err(CommandError::invalid_input(
            "The media time range is invalid or too large.",
        ));
    }
    let duration_us = end_us.map(|end| end - start_us);
    MediaTimeRange::new(start_us, duration_us).map_err(Into::into)
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaPipelinePhase {
    Probing,
    Processing,
    Publishing,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum MediaPipelineEvent {
    Progress {
        job: JobSnapshot,
        operation: MediaPipelineOperation,
        phase: MediaPipelinePhase,
        fraction: Option<f64>,
    },
    Completed {
        job: JobSnapshot,
        operation: MediaPipelineOperation,
        result: Box<MediaPipelineResult>,
    },
    Cancelled {
        job: JobSnapshot,
        operation: MediaPipelineOperation,
    },
    Failed {
        job: Option<JobSnapshot>,
        operation: MediaPipelineOperation,
        error: CommandError,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum MediaPipelineResult {
    Media {
        media: Box<MediaDescriptor>,
        inspection: Box<MediaInspectionResponse>,
    },
    Waveform {
        asset_id: AssetId,
        cache_hit: bool,
        waveform: Box<WaveformPyramid>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaDescriptor {
    pub(super) asset: MediaAsset,
    pub(super) playback: RegisteredMedia,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CompatibilityActionResponse {
    Direct,
    Remux,
    TranscodeAudio,
    TranscodeVideo,
    TranscodeAll,
    Reject,
}

impl From<ConversionAction> for CompatibilityActionResponse {
    fn from(value: ConversionAction) -> Self {
        match value {
            ConversionAction::Direct => Self::Direct,
            ConversionAction::Remux => Self::Remux,
            ConversionAction::TranscodeAudio => Self::TranscodeAudio,
            ConversionAction::TranscodeVideo => Self::TranscodeVideo,
            ConversionAction::TranscodeAll => Self::TranscodeAll,
            ConversionAction::Reject => Self::Reject,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CompatibilityIssueResponse {
    NoPlayableStream,
    UnsupportedContainer,
    UnsupportedVideoCodec,
    UnsupportedAudioCodec,
    ProblematicAudioProfile,
    UnsupportedPixelFormat,
    AudioPrecedesVideo,
    MissingDuration,
    LegacyHevcAssumption,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaInspectionResponse {
    pub(super) asset_id: AssetId,
    pub(super) duration_us: Option<u64>,
    has_video: bool,
    has_audio: bool,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    frame_rate: Option<f64>,
    compatibility_action: CompatibilityActionResponse,
    issues: Vec<CompatibilityIssueResponse>,
}

impl MediaInspectionResponse {
    pub(super) fn from_inspection(asset_id: AssetId, inspection: &MediaInspection) -> Self {
        let video = inspection.metadata.primary_video();
        let audio = inspection.metadata.primary_audio();
        let video_details = video.and_then(|stream| stream.video.as_ref());
        Self {
            asset_id,
            duration_us: inspection.metadata.duration_us(),
            has_video: video.is_some(),
            has_audio: audio.is_some(),
            video_codec: video.and_then(|stream| stream.codec.clone()),
            audio_codec: audio.and_then(|stream| stream.codec.clone()),
            width: video_details.map(|details| details.width),
            height: video_details.map(|details| details.height),
            frame_rate: video_details
                .and_then(|details| details.frame_rate.map(osg_media::FrameRate::as_f64)),
            compatibility_action: inspection.compatibility.action.into(),
            issues: inspection
                .compatibility
                .issues
                .iter()
                .map(|issue| issue_code(&issue.issue))
                .collect(),
        }
    }
}

const fn issue_code(issue: &IssueKind) -> CompatibilityIssueResponse {
    match issue {
        IssueKind::NoPlayableStream => CompatibilityIssueResponse::NoPlayableStream,
        IssueKind::UnsupportedContainer { .. } => CompatibilityIssueResponse::UnsupportedContainer,
        IssueKind::UnsupportedVideoCodec { .. } => {
            CompatibilityIssueResponse::UnsupportedVideoCodec
        }
        IssueKind::UnsupportedAudioCodec { .. } => {
            CompatibilityIssueResponse::UnsupportedAudioCodec
        }
        IssueKind::ProblematicAudioProfile { .. } => {
            CompatibilityIssueResponse::ProblematicAudioProfile
        }
        IssueKind::UnsupportedPixelFormat { .. } => {
            CompatibilityIssueResponse::UnsupportedPixelFormat
        }
        IssueKind::AudioPrecedesVideo => CompatibilityIssueResponse::AudioPrecedesVideo,
        IssueKind::MissingDuration => CompatibilityIssueResponse::MissingDuration,
        IssueKind::LegacyHevcAssumption => CompatibilityIssueResponse::LegacyHevcAssumption,
    }
}
