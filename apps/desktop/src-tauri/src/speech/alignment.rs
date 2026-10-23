//! Alignment request validation, result types and the alignment job manifest.

use std::collections::HashMap;

use osg_domain::{JobId, JobSnapshot, ProjectId};
use osg_infrastructure::storage::Database;
use osg_media::MediaInput;
use osg_speech::{AlignmentPlan, AlignmentPolicy, NarrationClip, SegmentId, TimeMicros};
use serde::{Deserialize, Serialize};

use super::alignment_job::{alignment_project_write_failure, ensure_alignment_project_current};
use super::artifact_types::{
    SpeechAlignmentClipRequest, SpeechAlignmentStartRequest, SpeechArtifactDescriptor,
    SpeechArtifactFormatResponse,
};
use super::artifacts::{descriptor_from_record, parse_artifact_id, resolve_alignment_audio};
use super::lifecycle::SpeechProjectAuthority;
use super::reference::require_reference_project_state;
use super::{
    ALIGNMENT_MANIFEST_SCHEMA_VERSION, ALIGNMENT_MANIFEST_SCOPE, MAX_ALIGNMENT_DURATION_MICROS,
    MAX_ALIGNMENT_INPUT_BYTES, MAX_SEGMENTS,
};
use crate::error::{CommandError, CommandResult};

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechAlignmentResult {
    pub(super) artifact: SpeechArtifactDescriptor,
    pub(super) clip_count: usize,
    pub(super) adjusted_count: usize,
    pub(super) requested_duration_micros: u64,
    pub(super) natural_duration_micros: u64,
    pub(super) rendered_duration_micros: u64,
    pub(super) maximum_shift_micros: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechAlignmentFailureCode {
    Cancelled,
    ProjectChanged,
    InvalidRequest,
    RuntimeUnavailable,
    TimedOut,
    MediaFailed,
    ArtifactStorage,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechAlignmentPhase {
    Planning,
    Mixing,
    Publishing,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpeechAlignmentManifest {
    pub(super) schema_version: u32,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) result: Option<SpeechAlignmentResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechAlignmentResultResponse {
    pub(super) job: JobSnapshot,
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) result: Option<SpeechAlignmentResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SpeechAlignmentEvent {
    Progress {
        job_id: JobId,
        phase: SpeechAlignmentPhase,
        fraction_millionths: u32,
    },
    Completed {
        job: JobSnapshot,
        project_id: ProjectId,
        expected_project_state_version: u64,
        result: SpeechAlignmentResult,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        code: SpeechAlignmentFailureCode,
    },
}

#[derive(Clone)]
pub(super) struct AlignmentRenderClip {
    pub(super) input: MediaInput,
    pub(super) start_micros: u64,
    pub(super) end_micros: u64,
}

#[derive(Clone, Copy)]
pub(super) struct AlignmentResultStats {
    pub(super) clip_count: usize,
    pub(super) adjusted_count: usize,
    pub(super) requested_duration_micros: u64,
    pub(super) natural_duration_micros: u64,
    pub(super) rendered_duration_micros: u64,
    pub(super) maximum_shift_micros: u64,
}

pub(super) struct ValidatedAlignmentStart {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) clips: Vec<AlignmentRenderClip>,
    pub(super) stats: AlignmentResultStats,
}

pub(super) struct ResolvedAlignmentClip {
    id_key: String,
    media_input: MediaInput,
    native_clip: NarrationClip,
    pub(super) project_id: ProjectId,
    pub(super) bytes: u64,
}

fn resolve_alignment_request_clip(
    database: &Database,
    request: SpeechAlignmentClipRequest,
) -> CommandResult<ResolvedAlignmentClip> {
    let id = SegmentId::new(request.id)
        .map_err(|_| CommandError::invalid_input("The alignment segment identifier is invalid."))?;
    if request.start_micros > MAX_ALIGNMENT_DURATION_MICROS
        || request.cue_end_micros > MAX_ALIGNMENT_DURATION_MICROS
        || request.cue_end_micros < request.start_micros
    {
        return Err(CommandError::invalid_input(
            "The alignment timing is invalid or exceeds four hours.",
        ));
    }
    let (asset, media_input, descriptor, project_id) =
        resolve_alignment_audio(database, &request.artifact_id)?;
    let project_id = project_id.ok_or_else(|| {
        CommandError::invalid_input("Narration alignment requires project-owned audio.")
    })?;
    let measured_duration = descriptor.duration_micros.ok_or_else(|| {
        CommandError::invalid_input("The narration clip has no measured duration.")
    })?;
    if measured_duration == 0 || measured_duration > MAX_ALIGNMENT_DURATION_MICROS {
        return Err(CommandError::invalid_input(
            "The narration clip duration is invalid or exceeds four hours.",
        ));
    }
    let id_key = id.as_str().to_owned();
    let native_clip = NarrationClip::new(
        id,
        asset,
        TimeMicros::new(request.start_micros)
            .map_err(|_| CommandError::invalid_input("The alignment start time is invalid."))?,
        TimeMicros::new(request.cue_end_micros)
            .map_err(|_| CommandError::invalid_input("The alignment cue end is invalid."))?,
        TimeMicros::new(measured_duration)
            .map_err(|_| CommandError::invalid_input("The narration clip duration is invalid."))?,
    )
    .map_err(|_| CommandError::invalid_input("The alignment clip is invalid."))?;
    Ok(ResolvedAlignmentClip {
        id_key,
        media_input,
        native_clip,
        project_id,
        bytes: descriptor.bytes,
    })
}

pub(super) fn validate_alignment_start(
    database: &Database,
    request: SpeechAlignmentStartRequest,
) -> CommandResult<ValidatedAlignmentStart> {
    if request.expected_project_state_version > i64::MAX as u64 {
        return Err(CommandError::invalid_input(
            "The narration alignment project state version is invalid.",
        ));
    }
    require_reference_project_state(
        database,
        request.project_id,
        request.expected_project_state_version,
    )?;
    if request.clips.is_empty() || request.clips.len() > MAX_SEGMENTS {
        return Err(CommandError::invalid_input(
            "Alignment requires between one and 1000 narration clips.",
        ));
    }

    let mut input_bytes = 0_u64;
    let mut native_clips = Vec::with_capacity(request.clips.len());
    let mut media_inputs = HashMap::with_capacity(request.clips.len());
    let mut project_id = None;
    for request_clip in request.clips {
        let resolved = resolve_alignment_request_clip(database, request_clip)?;
        match project_id {
            None => project_id = Some(resolved.project_id),
            Some(owner) if owner == resolved.project_id => {}
            Some(_) => {
                return Err(CommandError::invalid_input(
                    "Narration alignment cannot combine audio from different projects.",
                ));
            }
        }
        input_bytes = input_bytes
            .checked_add(resolved.bytes)
            .filter(|bytes| *bytes <= MAX_ALIGNMENT_INPUT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The alignment audio exceeds the safe input limit.")
            })?;
        if media_inputs
            .insert(resolved.id_key, resolved.media_input)
            .is_some()
        {
            return Err(CommandError::invalid_input(
                "The alignment contains a duplicate segment identifier.",
            ));
        }
        native_clips.push(resolved.native_clip);
    }

    let plan = AlignmentPlan::build(native_clips, AlignmentPolicy::default())
        .map_err(|_| CommandError::invalid_input("The narration alignment plan is invalid."))?;
    if plan.stats().rendered_duration().get() > MAX_ALIGNMENT_DURATION_MICROS {
        return Err(CommandError::invalid_input(
            "The aligned narration would exceed four hours.",
        ));
    }
    let clips = plan
        .clips()
        .iter()
        .map(|clip| {
            let input = media_inputs.remove(clip.id().as_str()).ok_or_else(|| {
                CommandError::internal("The alignment input plan is inconsistent.")
            })?;
            Ok(AlignmentRenderClip {
                input,
                start_micros: clip.start().get(),
                end_micros: clip.end().get(),
            })
        })
        .collect::<CommandResult<Vec<_>>>()?;
    let stats = AlignmentResultStats {
        clip_count: plan.stats().clip_count(),
        adjusted_count: plan.stats().adjusted_count(),
        requested_duration_micros: plan.stats().requested_duration().get(),
        natural_duration_micros: plan.stats().natural_duration().get(),
        rendered_duration_micros: plan.stats().rendered_duration().get(),
        maximum_shift_micros: plan.stats().maximum_shift().get(),
    };
    let resolved_project_id = project_id.ok_or_else(|| {
        CommandError::invalid_input("Narration alignment requires a durable project.")
    })?;
    if resolved_project_id != request.project_id {
        return Err(CommandError::invalid_input(
            "Narration alignment audio does not belong to the requested project.",
        ));
    }
    Ok(ValidatedAlignmentStart {
        project_id: resolved_project_id,
        expected_project_state_version: request.expected_project_state_version,
        clips,
        stats,
    })
}

pub(super) async fn initialize_alignment_manifest(
    database: &Database,
    job_id: JobId,
    authority: SpeechProjectAuthority,
) -> CommandResult<()> {
    let database = database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = SpeechAlignmentManifest {
            schema_version: ALIGNMENT_MANIFEST_SCHEMA_VERSION,
            project_id: authority.project_id,
            expected_project_state_version: authority.expected_state_version,
            result: None,
        };
        let value = serde_json::to_value(manifest)
            .map_err(|_| CommandError::internal("The alignment manifest is invalid."))?;
        database.put_project_setting(
            ALIGNMENT_MANIFEST_SCOPE,
            &job_id.to_string(),
            &value,
            authority.project_id,
            authority.expected_state_version,
        )?;
        Ok(())
    })
    .await
    .map_err(|_| CommandError::internal("The alignment manifest task stopped unexpectedly."))?
}

pub(super) fn read_alignment_manifest(
    database: &Database,
    job_id: JobId,
) -> CommandResult<SpeechAlignmentManifest> {
    let value = database
        .get_setting(ALIGNMENT_MANIFEST_SCOPE, &job_id.to_string())?
        .ok_or_else(|| CommandError::invalid_input("The alignment result is unavailable."))?;
    let manifest: SpeechAlignmentManifest = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The stored alignment result is invalid."))?;
    if manifest.schema_version != ALIGNMENT_MANIFEST_SCHEMA_VERSION
        || manifest.expected_project_state_version > i64::MAX as u64
    {
        return Err(invalid_alignment_manifest_error());
    }
    require_reference_project_state(
        database,
        manifest.project_id,
        manifest.expected_project_state_version,
    )
    .map_err(|_| invalid_alignment_manifest_error())?;
    if let Some(result) = &manifest.result {
        if result.clip_count == 0
            || result.clip_count > MAX_SEGMENTS
            || result.adjusted_count > result.clip_count
            || result.rendered_duration_micros == 0
            || result.rendered_duration_micros > MAX_ALIGNMENT_DURATION_MICROS
            || result.requested_duration_micros > result.rendered_duration_micros
            || result.natural_duration_micros > result.rendered_duration_micros
            || result.maximum_shift_micros > result.rendered_duration_micros
            || result.artifact.format != SpeechArtifactFormatResponse::M4a
            || result.artifact.duration_micros != Some(result.rendered_duration_micros)
            || result.artifact.sample_rate_hz != Some(48_000)
            || result.artifact.channels != Some(2)
        {
            return Err(invalid_alignment_manifest_error());
        }
        let id = parse_artifact_id(&result.artifact.artifact_id)
            .map_err(|_| invalid_alignment_manifest_error())?;
        let resolved = database
            .resolve_artifact(id)
            .map_err(|_| invalid_alignment_manifest_error())?
            .ok_or_else(invalid_alignment_manifest_error)?;
        if resolved.record().kind().as_str() != "alignedNarration"
            || resolved.record().project_id() != Some(manifest.project_id)
        {
            return Err(invalid_alignment_manifest_error());
        }
        let descriptor = descriptor_from_record(resolved.record())
            .map_err(|_| invalid_alignment_manifest_error())?;
        if descriptor != result.artifact {
            return Err(invalid_alignment_manifest_error());
        }
    }
    Ok(manifest)
}

pub(super) fn store_alignment_result(
    database: &Database,
    job_id: JobId,
    authority: SpeechProjectAuthority,
    result: SpeechAlignmentResult,
) -> Result<(), SpeechAlignmentFailureCode> {
    ensure_alignment_project_current(database, authority)?;
    let Ok(mut manifest) = read_alignment_manifest(database, job_id) else {
        ensure_alignment_project_current(database, authority)?;
        return Err(SpeechAlignmentFailureCode::ArtifactStorage);
    };
    if manifest.project_id != authority.project_id
        || manifest.expected_project_state_version != authority.expected_state_version
    {
        return Err(SpeechAlignmentFailureCode::ArtifactStorage);
    }
    if manifest.result.is_some() {
        return Err(SpeechAlignmentFailureCode::ArtifactStorage);
    }
    manifest.result = Some(result);
    let value =
        serde_json::to_value(manifest).map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
    database
        .put_project_setting(
            ALIGNMENT_MANIFEST_SCOPE,
            &job_id.to_string(),
            &value,
            authority.project_id,
            authority.expected_state_version,
        )
        .map_err(|error| alignment_project_write_failure(&error))
}

fn invalid_alignment_manifest_error() -> CommandError {
    CommandError::internal("The stored alignment result is invalid.")
}
