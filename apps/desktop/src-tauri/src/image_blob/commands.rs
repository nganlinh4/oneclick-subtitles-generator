//! Image reference selection, playback import/release and export commands.

use std::path::Path;

use osg_domain::{AssetId, ProjectId};
use osg_gemini::MAX_REFERENCE_IMAGE_BYTES;
use osg_media_server::MediaServer;
use osg_runtime_staging::RuntimeStagingAuthority;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::export::{
    invalid_image_blob, prepare_reference_image_export, reference_project_unavailable,
    write_reference_image_export,
};
use super::requests::{
    ImageBlobDescriptor, ImageBlobPlaybackImportRequest, ImagePlaybackReleaseRequest,
    ImageReferenceExportRequest, ImageReferenceSelectRequest,
};
use super::{ImageBlobStore, LOCAL_IMAGE_EXTENSIONS};
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[tauri::command]
pub(crate) async fn image_reference_select(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    request: ImageReferenceSelectRequest,
) -> CommandResult<Option<osg_media_server::RegisteredMedia>> {
    ensure_reference_project(&state, request.project_id)?;
    let selected = dialog_paths::pick_file_with_window(
        window,
        "Choose album art",
        "PNG, JPEG, or WebP image",
        LOCAL_IMAGE_EXTENSIONS,
    )
    .await?;
    let Some(path) = selected else {
        return Ok(None);
    };
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let playback = tauri::async_runtime::spawn_blocking(move || {
        if database.load_project(request.project_id)?.is_none() {
            return Err(reference_project_unavailable());
        }
        register_local_reference(&media_server, &path, request.project_id)
    })
    .await
    .map_err(|_| CommandError::internal("The image selection task stopped unexpectedly."))??;
    Ok(Some(playback))
}

fn ensure_reference_project(state: &DesktopState, project_id: ProjectId) -> CommandResult<()> {
    if state.database.load_project(project_id)?.is_none() {
        return Err(reference_project_unavailable());
    }
    Ok(())
}

pub(super) fn register_local_reference(
    media_server: &MediaServer,
    path: &Path,
    project_id: ProjectId,
) -> CommandResult<osg_media_server::RegisteredMedia> {
    let mime_type = local_image_mime_type(path).ok_or_else(invalid_image_blob)?;
    let playback = media_server.register_owned_image_file(
        path,
        mime_type,
        project_id.into_uuid(),
        MAX_REFERENCE_IMAGE_BYTES,
    )?;
    let valid_length = usize::try_from(playback.byte_length)
        .is_ok_and(|length| length > 0 && length <= MAX_REFERENCE_IMAGE_BYTES);
    if playback.mime_type != mime_type || !valid_length {
        let _ = media_server.unregister_owned_image(playback.id, project_id.into_uuid());
        return Err(invalid_image_blob());
    }
    Ok(playback)
}

pub(super) fn local_image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes command arguments by value"
)]
pub(crate) async fn image_blob_import_playback(
    state: State<'_, DesktopState>,
    store: State<'_, ImageBlobStore>,
    request: ImageBlobPlaybackImportRequest,
) -> CommandResult<ImageBlobDescriptor> {
    let media_server = state.media_server.clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_registered_image(&media_server, &store, &request)
    })
    .await
    .map_err(|_| CommandError::internal("The image import task stopped unexpectedly."))?
}

pub(super) fn import_registered_image(
    media_server: &MediaServer,
    store: &ImageBlobStore,
    request: &ImageBlobPlaybackImportRequest,
) -> CommandResult<ImageBlobDescriptor> {
    let image = media_server
        .copy_registered_image_for_owner(
            request.playback_id,
            request.project_id.into_uuid(),
            MAX_REFERENCE_IMAGE_BYTES,
        )?
        .ok_or_else(invalid_image_blob)?;
    let descriptor = store.import(request.project_id, image.mime_type(), image.bytes())?;
    if let Err(error) = image.commit() {
        let _ = store.release(descriptor.asset_id);
        return Err(error.into());
    }
    Ok(descriptor)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn image_blob_release(
    store: State<'_, ImageBlobStore>,
    asset_id: AssetId,
) -> CommandResult<bool> {
    store.release(asset_id)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes command arguments by value"
)]
pub(crate) fn image_reference_playback_release(
    state: State<'_, DesktopState>,
    request: ImagePlaybackReleaseRequest,
) -> CommandResult<bool> {
    state
        .media_server
        .unregister_owned_image(request.playback_id, request.project_id.into_uuid())
        .map_err(Into::into)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and State and deserializes command arguments by value"
)]
pub(crate) async fn image_reference_export(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: ImageReferenceExportRequest,
) -> CommandResult<bool> {
    ensure_reference_project(&state, request.project_id)?;
    let media_server = state.media_server.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || {
        prepare_reference_image_export(&media_server, &request)
    })
    .await
    .map_err(|_| CommandError::internal("The album-art export lookup stopped unexpectedly."))??;

    let selected = dialog_paths::save_file(
        &app,
        "Export album art",
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
            "The album-art export file type is invalid.",
        ));
    }
    let staging_authority = app.state::<RuntimeStagingAuthority>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_reference_image_export(&staging_authority, plan.image.bytes(), &destination)?;
        plan.image.commit().map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError::internal("The album-art export task stopped unexpectedly."))??;
    Ok(true)
}
