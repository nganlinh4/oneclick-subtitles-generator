//! The durable record of what a render produced.
//!
//! A job's result outlives the process that made it, so it is written to a setting rather than held
//! in memory: a render that finished before a crash is still answerable afterwards. The manifest
//! carries identifiers and measurements only — never a path — and is re-checked against the artifact
//! store every time it is read, so a record that no longer describes reality is refused rather than
//! believed.
//!
//! `deny_unknown_fields` is load-bearing here, not decoration: it is what stops a field added by a
//! future build, or a path smuggled in by hand, from being silently ignored on the way back in.

use osg_domain::{AssetId, JobId, JobSnapshot, JobState, MediaAsset, MediaKind, ProjectId};
use osg_infrastructure::storage::{ArtifactId, Database, ResolvedMedia};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::{CommandError, CommandResult};

/// The settings scope render manifests are written under.
const MANIFEST_SCOPE: &str = "renderJobs";
/// The manifest shape version. An unknown one is refused rather than migrated.
const MANIFEST_SCHEMA_VERSION: u32 = 1;
/// The engine marker written into every rendered artifact's metadata.
///
/// It is checked on the way back out: a rendered artifact this build did not produce is refused
/// rather than handed back, because its pixels are not the ones the preview now shows.
pub(super) const RENDER_ENGINE: &str = "native";

/// What one finished render produced.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RenderManifestResult {
    pub(super) artifact_id: String,
    pub(super) asset: MediaAsset,
    pub(super) source_asset_id: AssetId,
    pub(super) project_id: ProjectId,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) fps: u16,
    pub(super) duration_in_frames: u32,
}

/// The stored manifest: a version, and a result once there is one.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderManifest {
    schema_version: u32,
    result: Option<RenderManifestResult>,
}

/// The metadata a rendered artifact is registered with.
pub(super) fn artifact_metadata(
    source_asset_id: AssetId,
    project_id: ProjectId,
    width: u32,
    height: u32,
    fps: u16,
    duration_in_frames: u32,
) -> serde_json::Value {
    json!({
        "schemaVersion": 1,
        "sourceAssetId": source_asset_id,
        "projectId": project_id,
        "width": width,
        "height": height,
        "fps": fps,
        "durationInFrames": duration_in_frames,
        "engine": RENDER_ENGINE,
    })
}

/// Writes the empty manifest a running job starts from.
pub(super) fn initialize(database: &Database, job_id: JobId) -> CommandResult<()> {
    store(
        database,
        job_id,
        &RenderManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            result: None,
        },
    )
}

/// Commits a result, refusing to overwrite one that was already committed.
pub(super) fn store_result(
    database: &Database,
    job_id: JobId,
    result: RenderManifestResult,
) -> CommandResult<()> {
    let current = read(database, job_id)?;
    if current.result.is_some() {
        return Err(CommandError::internal(
            "The render result was already committed.",
        ));
    }
    store(
        database,
        job_id,
        &RenderManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            result: Some(result),
        },
    )
}

/// Rolls a committed result back to the empty manifest.
pub(super) fn clear_result(database: &Database, job_id: JobId) -> CommandResult<()> {
    initialize(database, job_id)
}

fn store(database: &Database, job_id: JobId, manifest: &RenderManifest) -> CommandResult<()> {
    let value = serde_json::to_value(manifest)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    database.put_setting(MANIFEST_SCOPE, &job_id.to_string(), &value)?;
    Ok(())
}

fn read(database: &Database, job_id: JobId) -> CommandResult<RenderManifest> {
    let value = database
        .get_setting(MANIFEST_SCOPE, &job_id.to_string())?
        .ok_or_else(|| CommandError::internal("The render result manifest is missing."))?;
    let manifest: RenderManifest = serde_json::from_value(value)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(CommandError::internal(
            "The render result manifest is invalid.",
        ));
    }
    Ok(manifest)
}

/// The committed result for a job, checked against the state that job is actually in.
pub(super) fn read_result(
    database: &Database,
    job: &JobSnapshot,
) -> CommandResult<Option<RenderManifestResult>> {
    let manifest = read(database, job.id())?;
    match job.state() {
        JobState::Succeeded => manifest
            .result
            .map(Some)
            .ok_or_else(|| CommandError::internal("The completed render result is missing.")),
        JobState::Queued | JobState::Running | JobState::Cancelling => Ok(None),
        JobState::Failed | JobState::Cancelled | JobState::Interrupted => {
            if manifest.result.is_some() {
                Err(CommandError::internal(
                    "The render result manifest is inconsistent.",
                ))
            } else {
                Ok(None)
            }
        }
    }
}

/// Re-derives a committed result from the artifact store, refusing anything that disagrees.
///
/// The manifest is a record, not an authority: the artifact, the media entry and the metadata are
/// all read back and cross-checked, so a manifest that has drifted from what is actually stored
/// fails here rather than being handed to the `WebView` as a playable file.
pub(super) fn validate_result(
    database: &Database,
    job_id: JobId,
    result: &RenderManifestResult,
) -> CommandResult<ResolvedMedia> {
    let artifact_uuid = Uuid::parse_str(&result.artifact_id)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    let artifact_id = ArtifactId::from_uuid(artifact_uuid)
        .map_err(|_| CommandError::internal("The render result manifest is invalid."))?;
    let artifact = database
        .resolve_artifact(artifact_id)?
        .ok_or_else(|| CommandError::internal("The rendered artifact is unavailable."))?;
    let media = database
        .resolve_media(result.asset.id())?
        .ok_or_else(|| CommandError::internal("The rendered media is unavailable."))?;
    if artifact.record().kind().as_str() != "renderedVideo"
        || artifact.record().job_id() != Some(job_id)
        || artifact.record().project_id() != Some(result.project_id)
        || artifact.record().size_bytes() != result.asset.size_bytes()
        || result.asset.kind() != MediaKind::Video
        || result.asset.extension() != "mp4"
        || media.asset() != &result.asset
        || !same_file::is_same_file(artifact.path(), media.path()).unwrap_or(false)
    {
        return Err(CommandError::internal(
            "The render result manifest is invalid.",
        ));
    }
    let metadata = artifact
        .record()
        .metadata()
        .as_object()
        .ok_or_else(|| CommandError::internal("The render result manifest is invalid."))?;
    let metadata_matches = metadata.get("sourceAssetId") == Some(&json!(result.source_asset_id))
        && metadata.get("projectId") == Some(&json!(result.project_id))
        && metadata.get("width").and_then(serde_json::Value::as_u64)
            == Some(u64::from(result.width))
        && metadata.get("height").and_then(serde_json::Value::as_u64)
            == Some(u64::from(result.height))
        && metadata.get("fps").and_then(serde_json::Value::as_u64) == Some(u64::from(result.fps))
        && metadata
            .get("durationInFrames")
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(result.duration_in_frames))
        && metadata.get("engine").and_then(serde_json::Value::as_str) == Some(RENDER_ENGINE);
    if result.width == 0
        || result.height == 0
        || result.fps == 0
        || result.duration_in_frames == 0
        || !metadata_matches
    {
        return Err(CommandError::internal(
            "The render result manifest is invalid.",
        ));
    }
    Ok(media)
}

#[cfg(test)]
mod tests {
    use osg_domain::{AssetId, MediaAsset, MediaKind, ProjectId};
    use osg_infrastructure::storage::ArtifactId;
    use serde_json::json;

    use super::{MANIFEST_SCHEMA_VERSION, RenderManifest};

    #[test]
    fn manifest_contract_rejects_paths_and_unknown_fields() {
        let asset =
            MediaAsset::new("rendered-video.mp4", "mp4", 32, MediaKind::Video).expect("asset");
        let value = json!({
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "result": {
                "artifactId": ArtifactId::new().to_string(),
                "asset": asset,
                "sourceAssetId": AssetId::new(),
                "projectId": ProjectId::new(),
                "width": 1280,
                "height": 720,
                "fps": 30,
                "durationInFrames": 60,
                "outputPath": "C:\\private\\render.mp4"
            }
        });

        assert!(serde_json::from_value::<RenderManifest>(value).is_err());
    }
}
