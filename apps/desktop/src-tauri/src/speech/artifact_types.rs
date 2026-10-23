//! Reference-audio, artifact, export, conversion and alignment request/response DTOs.

use std::fmt;

use osg_domain::{AssetId, JobId, ProjectId};
use osg_media_server::RegisteredMedia;
use osg_speech::AudioFormat;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{MAX_CHATTERBOX_REFERENCE_MS, MAX_F5_REFERENCE_MS};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechReferenceBackend {
    F5Tts,
    Chatterbox,
}

impl SpeechReferenceBackend {
    pub(super) const fn maximum_duration_ms(self) -> u64 {
        match self {
            Self::F5Tts => MAX_F5_REFERENCE_MS,
            Self::Chatterbox => MAX_CHATTERBOX_REFERENCE_MS,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceExtractRequest {
    pub(super) backend: SpeechReferenceBackend,
    pub(super) start_ms: u64,
    pub(super) end_ms: u64,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) expected_reference_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceSelectRequest {
    pub(super) backend: SpeechReferenceBackend,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) expected_reference_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceImportRequest {
    pub(super) backend: SpeechReferenceBackend,
    pub(super) asset_id: AssetId,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) expected_reference_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceProjectRequest {
    pub(super) project_id: ProjectId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceCommitRequest {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) expected_reference_version: u64,
    pub(super) artifact_id: String,
    pub(super) transcript: String,
    pub(super) language: String,
    pub(super) delivery_job_id: Option<JobId>,
    pub(super) delivery_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechReferenceClearRequest {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) expected_reference_version: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactEditRequest {
    pub(super) artifact_id: String,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) normalized_start_millionths: u32,
    pub(super) normalized_end_millionths: u32,
    pub(super) speed_milli: u16,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactExportEntry {
    pub(super) artifact_id: String,
    pub(super) file_name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactExportRequest {
    pub(super) entries: Vec<SpeechArtifactExportEntry>,
    pub(super) archive_name: Option<String>,
}

impl fmt::Debug for SpeechArtifactExportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechArtifactExportRequest")
            .field("entry_count", &self.entries.len())
            .field("archive", &self.archive_name.is_some())
            .finish()
    }
}

impl fmt::Debug for SpeechArtifactEditRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechArtifactEditRequest")
            .field("artifact_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .field(
                "expected_project_state_version",
                &self.expected_project_state_version,
            )
            .field(
                "normalized_start_millionths",
                &self.normalized_start_millionths,
            )
            .field("normalized_end_millionths", &self.normalized_end_millionths)
            .field("speed_milli", &self.speed_milli)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechVoiceConversionStartRequest {
    pub(super) input_artifact_id: String,
    pub(super) target_voice_artifact_id: String,
    pub(super) lifecycle_epoch: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpeechAlignmentClipRequest {
    pub(super) id: String,
    pub(super) artifact_id: String,
    pub(super) start_micros: u64,
    pub(super) cue_end_micros: u64,
}

impl fmt::Debug for SpeechAlignmentClipRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechAlignmentClipRequest")
            .field("id", &self.id)
            .field("artifact_id", &"<opaque>")
            .field("start_micros", &self.start_micros)
            .field("cue_end_micros", &self.cue_end_micros)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechAlignmentStartRequest {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) clips: Vec<SpeechAlignmentClipRequest>,
}

impl fmt::Debug for SpeechAlignmentStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechAlignmentStartRequest")
            .field("project_id", &"<opaque>")
            .field(
                "expected_project_state_version",
                &self.expected_project_state_version,
            )
            .field("clip_count", &self.clips.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SpeechArtifactFormatResponse {
    Wav,
    Mp3,
    M4a,
}

impl From<AudioFormat> for SpeechArtifactFormatResponse {
    fn from(value: AudioFormat) -> Self {
        match value {
            AudioFormat::Wav => Self::Wav,
            AudioFormat::Mp3 => Self::Mp3,
            AudioFormat::M4a => Self::M4a,
        }
    }
}

impl SpeechArtifactFormatResponse {
    pub(super) const fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechArtifactDescriptor {
    pub(super) artifact_id: String,
    pub(super) format: SpeechArtifactFormatResponse,
    pub(super) bytes: u64,
    pub(super) duration_micros: Option<u64>,
    pub(super) sample_rate_hz: Option<u32>,
    pub(super) channels: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechArtifactEditResponse {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) artifact: SpeechArtifactDescriptor,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechPlayableArtifact {
    pub(super) artifact: SpeechArtifactDescriptor,
    pub(super) playback: RegisteredMedia,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechReferenceRecordResponse {
    pub(super) schema_version: u32,
    pub(super) project_id: ProjectId,
    pub(super) project_state_version: u64,
    pub(super) reference_version: u64,
    pub(super) artifact_id: String,
    pub(super) transcript: String,
    pub(super) language: String,
    pub(super) pending_delivery: Option<SpeechReferenceDeliveryResponse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechReferenceDeliveryResponse {
    pub(super) job_id: JobId,
    pub(super) delivery_id: Uuid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechReferencePlayableResponse {
    pub(super) reference: SpeechReferenceRecordResponse,
    pub(super) playable: SpeechPlayableArtifact,
}
