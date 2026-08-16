//! Everything decidable before a job exists.
//!
//! A render that cannot succeed should cost nothing: no job row, no manifest, no channel event and
//! no partially written file. So the media, the project, the narration, the source's real
//! dimensions and duration, the request's own bounds and the staged text are all resolved here,
//! before `render_start` registers anything.
//!
//! The source is probed with [`osg_export::probe_source`] — the export's own decoder — rather than
//! with an external media tool. That is not a simplification: the numbers a request is validated
//! against decide the output size and the frame count, and the export re-validates against exactly
//! these numbers, so probing with anything else would risk planning against dimensions the exporter
//! does not agree with. It is also why a render no longer needs `FFmpeg` to be installed at all.

use std::path::PathBuf;

use osg_domain::MediaKind;
use osg_export::{StagedText, probe_source};
use osg_infrastructure::storage::{ArtifactId, Database};
use osg_render::{RenderPlan, RenderRequest};

use crate::error::{CommandError, CommandResult};

use super::export::NativeExportInputs;
use super::refusal;
use super::text::{ExportTextRequest, StagedAtlases};

/// 100ns units per microsecond, which is the only unit conversion this module performs.
const HUNDRED_NANOS_PER_MICRO: i64 = 10;

/// A request that is ready to become a job.
pub(super) struct ValidatedStart {
    pub(super) plan: RenderPlan,
    pub(super) inputs: NativeExportInputs,
    pub(super) text: StagedText,
}

/// Resolves and validates one render request against what it actually names.
///
/// # Errors
/// Returns an invalid-input refusal for media that is not a video, is not in the project, or names
/// a narration artifact that is not a renderable speech output; the render contract's own refusal
/// for a request outside its bounds; [`refusal::atlas_unknown`] when the staged atlas has been
/// evicted; and a source refusal when the file cannot be probed.
pub(super) fn prepare(
    database: &Database,
    atlases: &dyn StagedAtlases,
    request: RenderRequest,
    text: ExportTextRequest,
    staging_root: PathBuf,
) -> CommandResult<ValidatedStart> {
    let source = database
        .resolve_media(request.source_asset_id)?
        .ok_or_else(CommandError::media_unavailable)?;
    if source.asset().kind() != MediaKind::Video {
        return Err(CommandError::invalid_input(
            "Native rendering requires a video media asset.",
        ));
    }
    let project = database
        .load_project(request.project_id)?
        .ok_or_else(|| CommandError::invalid_input("The render project does not exist."))?;
    if !project
        .media()
        .iter()
        .any(|asset| asset.id() == source.asset().id())
    {
        return Err(CommandError::invalid_input(
            "The video media asset is not part of the render project.",
        ));
    }
    let narration = narration_path(database, request.narration_artifact_id)?;

    let info = probe_source(source.path()).map_err(|error| refusal::from_export(&error))?;
    // The **display** size, not the coded one: pixel aspect and rotation applied, which is what the
    // editor's `<video>` element reports and what `osg-export` validates against. Taking the coded
    // size here would compose an anamorphic clip at the wrong width and a phone clip sideways.
    let duration_us = u64::try_from(info.duration_100ns() / HUNDRED_NANOS_PER_MICRO)
        .map_err(|_| source_unreadable())?;
    let plan =
        request
            .clone()
            .validate(info.display_width(), info.display_height(), duration_us)?;

    // The staged text is checked against the plan's own cues, so a payload describing a different
    // set of subtitles is refused before a job exists rather than after the first frame is drawn.
    let text = text.resolve(atlases, plan.lyrics.len())?;
    let inputs = NativeExportInputs {
        request,
        source: source.path().to_owned(),
        narration,
        staging_root,
        fps: plan.settings.frame_rate.value(),
        duration_in_frames: plan.duration_frames,
    };
    Ok(ValidatedStart { plan, inputs, text })
}

/// Where the project's narration track is, when it has one.
fn narration_path(
    database: &Database,
    narration_artifact_id: Option<uuid::Uuid>,
) -> CommandResult<Option<PathBuf>> {
    let Some(narration_id) = narration_artifact_id else {
        return Ok(None);
    };
    let narration_id = ArtifactId::from_uuid(narration_id)
        .map_err(|_| CommandError::invalid_input("The narration artifact is invalid."))?;
    let narration = database
        .resolve_artifact(narration_id)?
        .ok_or_else(|| CommandError::invalid_input("The narration artifact is unavailable."))?;
    if !matches!(
        narration.record().kind().as_str(),
        "narrationOutput" | "voiceConversion" | "alignedNarration"
    ) {
        return Err(CommandError::invalid_input(
            "The artifact is not a renderable narration output.",
        ));
    }
    // The format is read for the same reason it always was: an artifact whose metadata does not say
    // what it holds is not something to hand to a decoder.
    speech_artifact_format(narration.record().metadata())?;
    Ok(Some(narration.path().to_owned()))
}

/// The declared container of a speech artifact, refused when it is not one this build reads.
fn speech_artifact_format(metadata: &serde_json::Value) -> CommandResult<&'static str> {
    match metadata.get("format").and_then(serde_json::Value::as_str) {
        Some("wav") => Ok("wav"),
        Some("mp3") => Ok("mp3"),
        Some("m4a") => Ok("m4a"),
        _ => Err(CommandError::invalid_input(
            "The narration artifact format is unavailable.",
        )),
    }
}

fn source_unreadable() -> CommandError {
    CommandError::render_refusal(
        "renderSourceUnreadable",
        "The source video could not be read all the way through.",
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::speech_artifact_format;

    #[test]
    fn a_narration_artifact_must_declare_a_container_this_build_reads() {
        for format in ["wav", "mp3", "m4a"] {
            assert_eq!(
                speech_artifact_format(&json!({ "format": format })).expect("a known container"),
                format
            );
        }
        for value in [json!({}), json!({ "format": "ogg" }), json!(null)] {
            let refused = speech_artifact_format(&value).expect_err("an unknown container");
            assert_eq!(refused.code(), "invalidInput");
        }
    }
}
