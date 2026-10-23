//! Gemini task kinds, validated start requests, usage accounting and job events.

use osg_domain::{AssetId, JobId, JobKind, JobSnapshot, ProjectId};
use osg_gemini::{
    GenerateRequest, GenerationConfig, MediaInput, MediaResolution, Model, ThinkingLevel,
    TokenUsage,
};
use osg_infrastructure::secrets::CredentialId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{MAX_PROMPT_CHARS, MAX_SCHEMA_BYTES};
use crate::error::{CommandError, CommandResult};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum EmptySpeechPolicy {
    ProvenSilence,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GeminiTask {
    Transcribe,
    Translate,
    AnalyzeSubtitles,
}

impl GeminiTask {
    pub(super) const fn job_kind(self) -> JobKind {
        match self {
            Self::Transcribe => JobKind::Transcribe,
            Self::Translate => JobKind::Translate,
            Self::AnalyzeSubtitles => JobKind::AnalyzeSubtitles,
        }
    }

    pub(super) const fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Transcribe => "transcribe",
            Self::Translate => "translate",
            Self::AnalyzeSubtitles => "analyzeSubtitles",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "prompts and response schemas are private user content"
)]
pub(crate) struct GeminiStartRequest {
    pub(super) credential_id: CredentialId,
    pub(super) task: GeminiTask,
    pub(super) model: Model,
    pub(super) prompt: String,
    system_instruction: Option<String>,
    max_output_tokens: Option<u32>,
    thinking_level: Option<ThinkingLevel>,
    media_resolution: Option<MediaResolution>,
    video_fps: Option<f64>,
    response_json_schema: Option<Value>,
    pub(super) media_asset_id: Option<AssetId>,
    pub(super) empty_speech_policy: Option<EmptySpeechPolicy>,
    pub(super) project_id: Option<ProjectId>,
    expected_project_state_version: Option<u64>,
    pub(super) recovery_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct GeminiProjectAuthority {
    pub(super) project_id: ProjectId,
    pub(super) expected_state_version: u64,
}

impl GeminiStartRequest {
    pub(super) fn validate(&self) -> CommandResult<()> {
        if self
            .video_fps
            .is_some_and(|fps| !fps.is_finite() || fps <= 0.0 || fps > 24.0)
            || (self.video_fps.is_some() && self.media_asset_id.is_none())
        {
            return Err(CommandError::invalid_input(
                "Video FPS requires media and must be within (0, 24].",
            ));
        }
        let prompt_chars = self.prompt.chars().count();
        if self.prompt.trim().is_empty() || prompt_chars > MAX_PROMPT_CHARS {
            return Err(CommandError::invalid_input(
                "A Gemini prompt must contain 1 to 1,048,576 characters.",
            ));
        }
        if self
            .system_instruction
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_PROMPT_CHARS)
        {
            return Err(CommandError::invalid_input(
                "The Gemini system instruction is too large.",
            ));
        }
        if self
            .max_output_tokens
            .is_some_and(|limit| limit == 0 || limit > self.model.output_token_limit())
        {
            return Err(CommandError::invalid_input(
                "The Gemini output-token limit is outside the selected model's bounds.",
            ));
        }
        if self
            .thinking_level
            .is_some_and(|level| !self.model.supports_thinking_level(level))
        {
            return Err(CommandError::invalid_input(
                "The selected Gemini model does not support that thinking level.",
            ));
        }
        if let Some(schema) = &self.response_json_schema {
            let size = serde_json::to_vec(schema)
                .map_err(|_| CommandError::invalid_input("The response schema is invalid."))?
                .len();
            if size > MAX_SCHEMA_BYTES {
                return Err(CommandError::invalid_input(
                    "The Gemini response schema exceeds 1 MiB.",
                ));
            }
        }
        if matches!(self.task, GeminiTask::Transcribe) && self.media_asset_id.is_none() {
            return Err(CommandError::invalid_input(
                "A transcription request must identify its media asset.",
            ));
        }
        if self.model.is_custom()
            && (matches!(self.task, GeminiTask::Transcribe)
                || self.media_asset_id.is_some()
                || self.video_fps.is_some()
                || self.media_resolution.is_some())
        {
            return Err(CommandError::invalid_input(
                "Custom Gemini models are available only for text processing.",
            ));
        }
        if self.empty_speech_policy.is_some()
            && (!matches!(self.task, GeminiTask::Transcribe) || self.media_asset_id.is_none())
        {
            return Err(CommandError::invalid_input(
                "The empty-speech policy is only valid for media transcription.",
            ));
        }
        if self.project_id.is_some() != self.expected_project_state_version.is_some()
            || self
                .expected_project_state_version
                .is_some_and(|version| version > i64::MAX as u64)
        {
            return Err(CommandError::invalid_input(
                "Gemini project ownership requires an exact project and state version.",
            ));
        }
        if self.recovery_key.as_ref().is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(CommandError::invalid_input(
                "The Gemini recovery key is invalid.",
            ));
        }
        Ok(())
    }

    pub(super) const fn project_authority(&self) -> Option<GeminiProjectAuthority> {
        match (self.project_id, self.expected_project_state_version) {
            (Some(project_id), Some(expected_state_version)) => Some(GeminiProjectAuthority {
                project_id,
                expected_state_version,
            }),
            (None | Some(_), None) | (None, Some(_)) => None,
        }
    }

    pub(super) fn into_native(self, media: Option<osg_gemini::UploadedFile>) -> GenerateRequest {
        GenerateRequest {
            model: self.model,
            prompt: self.prompt,
            system_instruction: self.system_instruction,
            media: media
                .map(MediaInput::Uploaded)
                .into_iter()
                .collect::<Vec<_>>(),
            generation: GenerationConfig {
                video_fps: self.video_fps,
                max_output_tokens: self.max_output_tokens,
                thinking_level: self.thinking_level,
                media_resolution: self.media_resolution,
                response_json_schema: self.response_json_schema,
            },
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct GeminiUsage {
    #[serde(rename = "promptTokenCount")]
    pub(super) prompt: Option<u64>,
    #[serde(rename = "candidatesTokenCount")]
    candidates: Option<u64>,
    #[serde(rename = "totalTokenCount")]
    total: Option<u64>,
    #[serde(rename = "thoughtsTokenCount")]
    thoughts: Option<u64>,
    #[serde(rename = "cachedContentTokenCount")]
    cached_content: Option<u64>,
}

impl From<&TokenUsage> for GeminiUsage {
    fn from(usage: &TokenUsage) -> Self {
        Self {
            prompt: usage.prompt_token_count,
            candidates: usage.candidates_token_count,
            total: usage.total_token_count,
            thoughts: usage.thoughts_token_count,
            cached_content: usage.cached_content_token_count,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GeminiJobEvent {
    Chunk {
        job_id: JobId,
        text: String,
    },
    Completed {
        job: JobSnapshot,
        delivery_id: Uuid,
        text: String,
        usage: Option<GeminiUsage>,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

pub(super) struct GeminiOutput {
    pub(super) text: String,
    pub(super) usage: Option<GeminiUsage>,
    pub(super) chunk_count: usize,
}
