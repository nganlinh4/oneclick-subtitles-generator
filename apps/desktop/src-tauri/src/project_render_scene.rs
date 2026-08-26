//! One durable render scene per subtitle project.
//!
//! The browser-era render tab stored five unrelated globals. A project switch could therefore show
//! A with B's trim/style and a delayed slider effect could write A after B was active. This module is
//! the native authority that replaces those globals: one exact schema, an independent CAS revision,
//! and one scene used by preview, queue admission and `render_start`.

use osg_domain::ProjectId;
use osg_infrastructure::storage::{
    Database, DatabaseError, PROJECT_RENDER_SCENE_SCHEMA_VERSION, ProjectRenderSceneRecord,
    ProjectRenderSceneWrite,
};
use osg_render::{
    CropSettings, FrameRate, RenderNarrationSource, RenderRequest, RenderResolution,
    RenderSettings, RenderSubtitleSource, SubtitleCustomization,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const MAX_RENDER_DURATION_SECONDS: f64 = 24.0 * 60.0 * 60.0;
const MICROS_PER_SECOND: f64 = 1_000_000.0;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectRenderSceneValues {
    pub(crate) selected_subtitles: RenderSubtitleSource,
    pub(crate) selected_narration: RenderNarrationSource,
    pub(crate) render_settings: ProjectRenderSettings,
    pub(crate) customization: SubtitleCustomization,
    pub(crate) crop: CropSettings,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectRenderSceneInput {
    schema_version: u16,
    #[serde(flatten)]
    values: ProjectRenderSceneValues,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRenderSceneResponse {
    schema_version: u16,
    project_id: ProjectId,
    scene_revision: u64,
    #[serde(flatten)]
    pub(crate) values: ProjectRenderSceneValues,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectRenderSettings {
    resolution: RenderResolution,
    frame_rate: u16,
    video_type: RenderVideoType,
    original_audio_volume: u8,
    narration_volume: u8,
    trim_start: f64,
    trim_end: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
enum RenderVideoType {
    #[serde(rename = "Subtitled Video")]
    SubtitledVideo,
}

impl ProjectRenderSceneInput {
    fn validate(&self) -> CommandResult<()> {
        if self.schema_version != PROJECT_RENDER_SCENE_SCHEMA_VERSION {
            return Err(invalid_scene());
        }
        let settings = self.values.render_settings.native()?;
        settings.validate().map_err(|_| invalid_scene())?;
        self.values
            .customization
            .validate()
            .map_err(|_| invalid_scene())?;
        self.values.crop.validate().map_err(|_| invalid_scene())?;
        Ok(())
    }

    fn canonical_json(&self) -> CommandResult<String> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| CommandError::internal("The render scene could not be serialized."))
    }
}

impl ProjectRenderSettings {
    fn native(&self) -> CommandResult<RenderSettings> {
        let trim_start_us = seconds_to_micros(self.trim_start)?;
        let trim_end_us = if self.trim_end == 0.0 {
            None
        } else {
            Some(seconds_to_micros(self.trim_end)?)
        };
        if trim_end_us.is_some_and(|end| end <= trim_start_us) {
            return Err(invalid_scene());
        }
        Ok(RenderSettings {
            resolution: self.resolution,
            frame_rate: FrameRate::try_from(self.frame_rate).map_err(|_| invalid_scene())?,
            original_audio_volume: self.original_audio_volume,
            narration_volume: self.narration_volume,
            trim_start_us,
            trim_end_us,
        })
    }
}

impl ProjectRenderSceneResponse {
    pub(crate) fn matches_request(&self, request: &RenderRequest) -> CommandResult<()> {
        // Revision zero is the virtual default returned only while a project has no durable scene
        // row. The WebView materializes it before publishing the scene as ready. Refuse any caller
        // that bypasses that activation barrier: otherwise an untouched project's pixels could
        // silently change when a future binary changes its built-in defaults.
        if self.scene_revision == 0 {
            return Err(stale_or_mismatched_scene());
        }
        let settings = self.values.render_settings.native()?;
        let exact = request.project_id == self.project_id
            && request.scene_revision == self.scene_revision
            && request.selected_subtitles == self.values.selected_subtitles
            && request.selected_narration == self.values.selected_narration
            && request.settings == settings
            && request.customization == self.values.customization
            && request.crop == self.values.crop
            && (request.narration_artifact_id.is_some()
                == (self.values.selected_narration == RenderNarrationSource::Generated));
        exact.then_some(()).ok_or_else(stale_or_mismatched_scene)
    }
}

fn seconds_to_micros(value: f64) -> CommandResult<u64> {
    if !value.is_finite() || !(0.0..=MAX_RENDER_DURATION_SECONDS).contains(&value) {
        return Err(invalid_scene());
    }
    let micros = (value * MICROS_PER_SECOND).round();
    if !(0.0..=f64::from(u32::MAX) * MICROS_PER_SECOND).contains(&micros) {
        return Err(invalid_scene());
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the finite non-negative microsecond value is bounded before conversion"
    )]
    Ok(micros as u64)
}

fn default_input() -> CommandResult<ProjectRenderSceneInput> {
    serde_json::from_str(DEFAULT_SCENE_INPUT)
        .map_err(|_| CommandError::internal("The built-in render scene is invalid."))
}

fn response_from_record(
    record: &ProjectRenderSceneRecord,
) -> CommandResult<ProjectRenderSceneResponse> {
    if record.schema_version != PROJECT_RENDER_SCENE_SCHEMA_VERSION {
        return Err(corrupt_scene());
    }
    let input: ProjectRenderSceneInput =
        serde_json::from_str(&record.scene_json).map_err(|_| corrupt_scene())?;
    input.validate().map_err(|_| corrupt_scene())?;
    Ok(ProjectRenderSceneResponse {
        schema_version: input.schema_version,
        project_id: record.project_id,
        scene_revision: record.scene_revision,
        values: input.values,
    })
}

pub(crate) fn get_for_database(
    database: &Database,
    project_id: ProjectId,
) -> CommandResult<ProjectRenderSceneResponse> {
    if database.load_project(project_id)?.is_none() {
        return Err(DatabaseError::ProjectNotFound(project_id).into());
    }
    if let Some(record) = database.get_project_render_scene(project_id)? {
        return response_from_record(&record);
    }
    let input = default_input()?;
    input.validate()?;
    Ok(ProjectRenderSceneResponse {
        schema_version: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
        project_id,
        scene_revision: 0,
        values: input.values,
    })
}

pub(crate) fn put_for_database(
    database: &Database,
    project_id: ProjectId,
    expected_scene_revision: u64,
    scene: &ProjectRenderSceneInput,
) -> CommandResult<ProjectRenderSceneResponse> {
    let scene_json = scene.canonical_json()?;
    let stored = database.put_project_render_scene(&ProjectRenderSceneWrite {
        project_id,
        expected_scene_revision,
        schema_version: scene.schema_version,
        scene_json,
    })?;
    response_from_record(&stored)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes scene as owned command inputs"
)]
pub(crate) async fn project_render_scene_get(
    state: State<'_, DesktopState>,
    project_id: ProjectId,
) -> CommandResult<ProjectRenderSceneResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || get_for_database(&database, project_id))
        .await
        .map_err(|_| CommandError::internal("The render scene read task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes scene as owned command inputs"
)]
pub(crate) async fn project_render_scene_put(
    state: State<'_, DesktopState>,
    project_id: ProjectId,
    expected_scene_revision: u64,
    scene: ProjectRenderSceneInput,
) -> CommandResult<ProjectRenderSceneResponse> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        put_for_database(&database, project_id, expected_scene_revision, &scene)
    })
    .await
    .map_err(|_| CommandError::internal("The render scene write task stopped unexpectedly."))?
}

fn invalid_scene() -> CommandError {
    CommandError::invalid_input("The project render scene is invalid.")
}

fn corrupt_scene() -> CommandError {
    DatabaseError::InvalidProjectRenderScene.into()
}

fn stale_or_mismatched_scene() -> CommandError {
    CommandError::render_refusal(
        "staleProjectRenderScene",
        "The project render scene changed before rendering started.",
    )
}

const DEFAULT_SCENE_INPUT: &str = r##"{
  "schemaVersion":1,
  "selectedSubtitles":"original",
  "selectedNarration":"none",
  "renderSettings":{
    "resolution":"1080p","frameRate":30,"videoType":"Subtitled Video",
    "originalAudioVolume":100,"narrationVolume":100,"trimStart":0,"trimEnd":0
  },
  "customization":{
    "fontSize":48,"fontFamily":"'Google Sans', sans-serif","fontWeight":400,
    "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,"letterSpacing":0,
    "textTransform":"none","backgroundColor":"#000000","backgroundOpacity":70,
    "backgroundPaddingX":16,"backgroundPaddingY":8,
    "borderRadius":4,"borderWidth":0,"borderColor":"#ffffff","borderStyle":"none",
    "textShadowEnabled":true,"textShadowColor":"#000000","textShadowBlur":4,
    "textShadowOffsetX":0,"textShadowOffsetY":2,"glowEnabled":false,
    "glowColor":"#ffffff","glowIntensity":10,"gradientEnabled":false,
    "gradientType":"linear","gradientDirection":"45deg","gradientColorStart":"#ffffff",
    "gradientColorEnd":"#cccccc","gradientColorMid":"#eeeeee","strokeEnabled":false,
    "strokeWidth":0,"strokeColor":"#000000","multiShadowEnabled":false,"shadowLayers":1,
    "pulseEnabled":false,"pulseSpeed":1,"shakeEnabled":false,"shakeIntensity":2,
    "position":"bottom","customPositionX":50,"customPositionY":80,"marginBottom":80,
    "marginTop":80,"marginLeft":0,"marginRight":0,"maxWidth":80,"fadeInDuration":0.3,
    "fadeOutDuration":0.3,"animationType":"fade","animationEasing":"ease",
    "wordWrap":true,"maxLines":3,"lineBreakBehavior":"auto","rtlSupport":false,
    "preset":"default"
  },
  "crop":{
    "x":0,"y":0,"width":100,"height":100,"aspectRatio":null,
    "canvasBgMode":"solid","canvasBgColor":"#000000","canvasBgBlur":24,
    "flipX":false,"flipY":false
  }
}"##;

#[cfg(test)]
mod tests {
    use osg_domain::{AssetId, ProjectMetadata};
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;

    fn database() -> (TempDir, Database, ProjectId) {
        let directory = TempDir::new().expect("directory");
        let database = Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let metadata =
            ProjectMetadata::with_id(ProjectId::new(), "Render scene").expect("metadata");
        let project_id = database
            .create_project(&metadata)
            .expect("create project")
            .metadata()
            .id();
        (directory, database, project_id)
    }

    fn input() -> ProjectRenderSceneInput {
        default_input().expect("default scene")
    }

    #[test]
    fn default_new_project_and_crash_relaunch_are_deterministic() {
        let (directory, database, project_id) = database();
        let first = get_for_database(&database, project_id).expect("default scene");
        assert_eq!(first.scene_revision, 0);
        assert_eq!(first.values, input().values);
        let committed = put_for_database(&database, project_id, 0, &input()).expect("commit scene");
        assert_eq!(committed.scene_revision, 1);
        drop(database);
        let reopened = Database::open(directory.path().join("osg.sqlite3")).expect("reopen");
        assert_eq!(
            get_for_database(&reopened, project_id).expect("restored"),
            committed
        );
    }

    #[test]
    fn unknown_corrupt_and_out_of_range_fields_refuse() {
        let mut value: Value = serde_json::from_str(DEFAULT_SCENE_INPUT).expect("scene JSON");
        value["unknown"] = json!(true);
        assert!(serde_json::from_value::<ProjectRenderSceneInput>(value).is_err());

        for mutation in [
            ("renderSettings", "trimStart", json!(-1)),
            ("renderSettings", "trimEnd", json!(90_000)),
            ("customization", "fontSize", json!(0)),
            ("customization", "backgroundPaddingX", json!(-1)),
            ("customization", "backgroundPaddingY", json!(1_001)),
            ("crop", "width", json!(0)),
        ] {
            let mut value: Value = serde_json::from_str(DEFAULT_SCENE_INPUT).expect("scene JSON");
            value[mutation.0][mutation.1] = mutation.2;
            let candidate: ProjectRenderSceneInput =
                serde_json::from_value(value).expect("typed candidate");
            assert!(candidate.validate().is_err());
        }
    }

    #[test]
    fn a_scene_saved_before_padding_was_persisted_loads_with_reviewed_defaults() {
        let mut value: Value = serde_json::from_str(DEFAULT_SCENE_INPUT).expect("scene JSON");
        value["customization"]
            .as_object_mut()
            .expect("customization object")
            .remove("backgroundPaddingX");
        value["customization"]
            .as_object_mut()
            .expect("customization object")
            .remove("backgroundPaddingY");

        let legacy: ProjectRenderSceneInput = serde_json::from_value(value).expect("legacy scene");
        legacy.validate().expect("migrated scene");
        assert_eq!(
            legacy.values.customization.background_padding_x.to_bits(),
            16.0_f64.to_bits()
        );
        assert_eq!(
            legacy.values.customization.background_padding_y.to_bits(),
            8.0_f64.to_bits()
        );
    }

    #[test]
    fn request_must_match_revision_selection_and_every_visual_value() {
        let (_directory, database, project_id) = database();
        let virtual_scene = get_for_database(&database, project_id).expect("virtual scene");
        let virtual_request: RenderRequest = serde_json::from_value(json!({
            "sourceAssetId":AssetId::new(),"projectId":project_id,"sceneRevision":0,
            "selectedSubtitles":"original","selectedNarration":"none",
            "narrationArtifactId":null,
            "lyrics":[{"id":"1","startUs":0,"endUs":1_000_000,"text":"A"}],
            "settings":virtual_scene.values.render_settings.native().expect("settings"),
            "customization":virtual_scene.values.customization,"crop":virtual_scene.values.crop
        }))
        .expect("virtual request");
        assert_eq!(
            virtual_scene
                .matches_request(&virtual_request)
                .expect_err("an undurable virtual scene must never admit a render")
                .code(),
            "staleProjectRenderScene"
        );

        let scene = put_for_database(&database, project_id, 0, &input()).expect("scene");
        let mut request: RenderRequest = serde_json::from_value(json!({
            "sourceAssetId":AssetId::new(),"projectId":project_id,"sceneRevision":1,
            "selectedSubtitles":"original","selectedNarration":"none",
            "narrationArtifactId":null,
            "lyrics":[{"id":"1","startUs":0,"endUs":1_000_000,"text":"A"}],
            "settings":scene.values.render_settings.native().expect("settings"),
            "customization":scene.values.customization,"crop":scene.values.crop
        }))
        .expect("request");
        scene.matches_request(&request).expect("exact scene");
        request.scene_revision = 0;
        assert_eq!(
            scene
                .matches_request(&request)
                .expect_err("stale scene")
                .code(),
            "staleProjectRenderScene"
        );
        request.scene_revision = 1;
        request.settings.original_audio_volume = 99;
        assert_eq!(
            scene
                .matches_request(&request)
                .expect_err("different scene")
                .code(),
            "staleProjectRenderScene"
        );
    }
}
