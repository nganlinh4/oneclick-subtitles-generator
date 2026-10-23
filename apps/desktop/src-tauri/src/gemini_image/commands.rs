//! Generated-image library commands: list, resolve, export, delete, clear and release.

use osg_domain::ProjectId;
use osg_infrastructure::storage::{ArtifactId, ArtifactKind, Database, ResolvedArtifact};
use osg_runtime_staging::RuntimeStagingAuthority;
use tauri::{AppHandle, Manager, State};

use super::MAX_PROJECT_IMAGES;
use super::format::{
    artifact_kind, descriptor_from_record, generated_image_export_error,
    generated_image_project_full, generated_image_unavailable, parse_artifact_id,
    prepare_image_export,
};
use super::publication::{
    clear_generated_images, delete_generated_image, register_playable_image_record,
    release_generated_image_playback,
};
use super::types::{
    GeneratedImageArtifactRequest, GeneratedImageDescriptor, GeneratedImageExportRequest,
    GeneratedImagePlaybackReleaseRequest, GeneratedImageProjectRequest, GeneratedImageRegistry,
    GeneratedImageRuntime, PlayableGeneratedImage,
};
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::media_export::copy_export;
use crate::state::DesktopState;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_list(
    state: State<'_, DesktopState>,
    request: GeneratedImageProjectRequest,
) -> CommandResult<Vec<GeneratedImageDescriptor>> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_generated_images(&database, request.project_id)
    })
    .await
    .map_err(|_| CommandError::internal("The generated-image list task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_resolve(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageArtifactRequest,
) -> CommandResult<PlayableGeneratedImage> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            let artifact_id = parse_artifact_id(&request.artifact_id)?;
            let resolved = resolve_owned_image(&database, request.project_id, artifact_id)?
                .ok_or_else(generated_image_unavailable)?;
            register_playable_image_record(
                &media_server,
                registry,
                resolved.record(),
                resolved.path(),
                false,
            )
        })
    })
    .await
    .map_err(|_| CommandError::internal("The generated-image resolve task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and State as owned command extractors"
)]
pub(crate) async fn generated_image_export(
    app: AppHandle,
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageExportRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let runtime = runtime.inner().clone();
    let plan = tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|_| prepare_image_export(&database, request))
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image export lookup stopped unexpectedly.")
    })??;

    let selected = dialog_paths::save_file(
        &app,
        "Export generated image",
        &plan.suggested_name,
        plan.format.label(),
        &[plan.format.extension()],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case(plan.format.extension()))
    {
        return Err(CommandError::invalid_input(
            "The generated-image export file type is invalid.",
        ));
    }
    let staging_authority = app.state::<RuntimeStagingAuthority>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        copy_export(
            &staging_authority,
            plan.staging.path(),
            &destination,
            plan.size_bytes,
            || false,
            |_, _| Ok(()),
        )
        .map_err(|_| generated_image_export_error())
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image export task stopped unexpectedly.")
    })??;
    Ok(true)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_delete(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageArtifactRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            let artifact_id = parse_artifact_id(&request.artifact_id)?;
            delete_generated_image(
                &database,
                &media_server,
                registry,
                request.project_id,
                artifact_id,
            )
        })
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-image deletion task stopped unexpectedly.")
    })?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn generated_image_clear(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImageProjectRequest,
) -> CommandResult<u64> {
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.access(|registry| {
            clear_generated_images(&database, &media_server, registry, request.project_id)
        })
    })
    .await
    .map_err(|_| CommandError::internal("The generated-image clear task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn generated_image_playback_release(
    state: State<'_, DesktopState>,
    runtime: State<'_, GeneratedImageRuntime>,
    request: GeneratedImagePlaybackReleaseRequest,
) -> CommandResult<bool> {
    runtime.access(|registry| {
        let artifact_id = parse_artifact_id(&request.artifact_id)?;
        release_generated_image_playback(
            registry,
            &state.media_server,
            request.project_id,
            artifact_id,
            request.playback_id,
        )
    })
}

pub(super) fn ensure_project_exists(
    database: &Database,
    project_id: ProjectId,
) -> CommandResult<()> {
    database
        .load_project(project_id)?
        .map(|_| ())
        .ok_or_else(|| CommandError::invalid_input("The generated-image project is unavailable."))
}

pub(super) fn ensure_project_accepts_generated_image(
    database: &Database,
    project_id: ProjectId,
    provisional_count: usize,
) -> CommandResult<ArtifactKind> {
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let committed_count = database
        .list_ready_artifacts(project_id, &kind, MAX_PROJECT_IMAGES)?
        .len();
    if committed_count.saturating_add(provisional_count) >= MAX_PROJECT_IMAGES {
        return Err(generated_image_project_full());
    }
    Ok(kind)
}

pub(super) fn pending_new_image_count(
    registry: &GeneratedImageRegistry,
    project_id: ProjectId,
) -> usize {
    registry
        .pending_by_job
        .values()
        .filter(|pending| {
            pending.published.newly_created
                && pending.published.image.artifact.project_id == project_id
        })
        .count()
}

pub(super) fn list_generated_images(
    database: &Database,
    project_id: ProjectId,
) -> CommandResult<Vec<GeneratedImageDescriptor>> {
    ensure_project_exists(database, project_id)?;
    let kind = artifact_kind(project_id)?;
    let records = database.list_ready_artifacts(project_id, &kind, MAX_PROJECT_IMAGES)?;
    let mut images = Vec::with_capacity(records.len());
    for record in records {
        let Some(resolved) = database.resolve_artifact(record.id())? else {
            continue;
        };
        images.push(descriptor_from_record(resolved.record(), project_id)?);
    }
    Ok(images)
}

pub(super) fn resolve_owned_image(
    database: &Database,
    project_id: ProjectId,
    artifact_id: ArtifactId,
) -> CommandResult<Option<ResolvedArtifact>> {
    let Some(record) = database.get_artifact(artifact_id)? else {
        return Ok(None);
    };
    descriptor_from_record(&record, project_id)?;
    database.resolve_artifact(artifact_id).map_err(Into::into)
}
