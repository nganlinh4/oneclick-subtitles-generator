//! ASR status DTOs, validated start requests and job events.

use osg_asr::{
    AsrEngineId, AsrEngineInfo, AsrError, LanguageCode, ProgressPhase, SegmentStrategy,
    SegmentationOptions, Transcription, TranscriptionOptions,
};
use osg_domain::{JobId, JobSnapshot};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::MAX_TRANSCRIPTION_RANGE_MS;
use crate::error::{CommandError, CommandResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsrStatus {
    pub(super) worker_available: bool,
    pub(super) engines: Vec<AsrEngineStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AsrEngineStatus {
    #[serde(flatten)]
    pub(super) info: AsrEngineInfo,
    #[serde(flatten)]
    pub(super) availability: AsrEngineAvailability,
    #[serde(flatten)]
    pub(super) runtime: AsrEngineRuntimeStatus,
}

#[derive(Debug, Serialize)]
pub(super) struct AsrEngineAvailability {
    pub(super) installed: bool,
    pub(super) ready: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct AsrEngineRuntimeStatus {
    pub(super) warm: bool,
    pub(super) starting: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub(super) enum AsrEngineInput {
    #[serde(rename = "parakeet", alias = "nvidia-parakeet")]
    Parakeet,
    #[serde(rename = "faster-whisper-turbo")]
    FasterWhisperTurbo,
    #[serde(rename = "faster-whisper-large-v3")]
    FasterWhisperLargeV3,
    #[serde(rename = "qwen3-asr-1.7b")]
    Qwen3Asr1_7b,
    #[serde(rename = "qwen3-asr-0.6b")]
    Qwen3Asr0_6b,
}

impl From<AsrEngineInput> for AsrEngineId {
    fn from(value: AsrEngineInput) -> Self {
        match value {
            AsrEngineInput::Parakeet => Self::Parakeet,
            AsrEngineInput::FasterWhisperTurbo => Self::FasterWhisperTurbo,
            AsrEngineInput::FasterWhisperLargeV3 => Self::FasterWhisperLargeV3,
            AsrEngineInput::Qwen3Asr1_7b => Self::Qwen3Asr1_7b,
            AsrEngineInput::Qwen3Asr0_6b => Self::Qwen3Asr0_6b,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub(super) enum AsrStrategyInput {
    #[default]
    #[serde(rename = "sentence")]
    Sentence,
    #[serde(rename = "word")]
    Word,
    #[serde(rename = "character", alias = "char")]
    Character,
}

impl From<AsrStrategyInput> for SegmentStrategy {
    fn from(value: AsrStrategyInput) -> Self {
        match value {
            AsrStrategyInput::Sentence => Self::Sentence,
            AsrStrategyInput::Word => Self::Word,
            AsrStrategyInput::Character => Self::Character,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AsrRangeInput {
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsrStartRequest {
    pub(super) engine: AsrEngineInput,
    #[serde(default, alias = "segmentStrategy")]
    pub(super) strategy: AsrStrategyInput,
    #[serde(default = "default_max_characters", alias = "maxChars")]
    max_characters: u16,
    #[serde(default = "default_max_words")]
    max_words: Option<u8>,
    #[serde(default = "default_pause_threshold_ms")]
    pause_threshold_ms: u32,
    pub(super) language: Option<String>,
    pub(super) range: Option<AsrRangeInput>,
}

const fn default_max_characters() -> u16 {
    60
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "Serde's default hook must distinguish an absent field from an explicit null"
)]
const fn default_max_words() -> Option<u8> {
    Some(7)
}

const fn default_pause_threshold_ms() -> u32 {
    800
}

impl AsrStartRequest {
    pub(super) fn engine(&self) -> AsrEngineId {
        self.engine.into()
    }

    pub(super) fn options(&self) -> Result<TranscriptionOptions, AsrError> {
        let segmentation = SegmentationOptions::new(
            self.strategy.into(),
            self.max_characters,
            self.max_words,
            self.pause_threshold_ms,
        )?;
        let mut options = TranscriptionOptions::new(segmentation);
        if let Some(language) = self.language.as_deref()
            && !language.eq_ignore_ascii_case("auto")
        {
            options = options.with_language(LanguageCode::new(language)?);
        }
        Ok(options)
    }

    pub(super) fn range_us(&self) -> CommandResult<Option<RequestedRange>> {
        self.range
            .map(|range| {
                if range.end_ms <= range.start_ms
                    || range.end_ms - range.start_ms > MAX_TRANSCRIPTION_RANGE_MS
                {
                    return Err(CommandError::invalid_input(
                        "The ASR time range must be positive and no longer than 24 hours.",
                    ));
                }
                let start_us = range.start_ms.checked_mul(1_000).ok_or_else(|| {
                    CommandError::invalid_input("The ASR time range is too large.")
                })?;
                let end_us = range.end_ms.checked_mul(1_000).ok_or_else(|| {
                    CommandError::invalid_input("The ASR time range is too large.")
                })?;
                Ok(RequestedRange {
                    start_us,
                    end_us,
                    timeline_offset_ms: range.start_ms,
                })
            })
            .transpose()
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct RequestedRange {
    pub(super) start_us: u64,
    pub(super) end_us: u64,
    pub(super) timeline_offset_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AsrJobPhase {
    PreparingAudio,
    ModelLoading,
    Transcribing,
    Finalizing,
}

impl From<ProgressPhase> for AsrJobPhase {
    fn from(value: ProgressPhase) -> Self {
        match value {
            ProgressPhase::ModelLoading => Self::ModelLoading,
            ProgressPhase::Transcribing => Self::Transcribing,
            ProgressPhase::Finalizing => Self::Finalizing,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AsrJobEvent {
    Progress {
        job_id: JobId,
        phase: AsrJobPhase,
        fraction: Option<f64>,
    },
    Completed {
        job: JobSnapshot,
        delivery_id: Uuid,
        transcription: Transcription,
        timeline_offset_ms: u64,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}
