use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use osg_domain::{AssetId, ProjectId};
use osg_gemini::{MAX_REFERENCE_IMAGE_BYTES, ReferenceImage};
use osg_media_server::{MediaServer, RegisteredImageCopy};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::error::{CommandError, CommandResult};
use crate::media_export::{ExportCopyError, copy_export};
use crate::state::DesktopState;

const MAX_ACTIVE_IMAGES: usize = 4;
const MAX_ACTIVE_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const IMAGE_TTL: Duration = Duration::from_mins(10);
const LOCAL_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const MAX_EXPORT_NAME_BYTES: usize = 240;

#[derive(Clone)]
struct ImageEntry {
    image: ReferenceImage,
    project_id: ProjectId,
    created_at: Instant,
}

impl fmt::Debug for ImageEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageEntry")
            .field("image", &self.image)
            .field("project_id", &"<opaque>")
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Debug, Default)]
struct ImageRegistry {
    entries: BTreeMap<AssetId, ImageEntry>,
    total_bytes: usize,
}

#[derive(Clone, Default)]
pub(crate) struct ImageBlobStore(Arc<Mutex<ImageRegistry>>);

impl fmt::Debug for ImageBlobStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageBlobStore")
            .field("registry", &"<redacted>")
            .finish()
    }
}

impl ImageBlobStore {
    fn import(
        &self,
        project_id: ProjectId,
        mime_type: &str,
        bytes: &[u8],
    ) -> CommandResult<ImageBlobDescriptor> {
        let image = ReferenceImage::new(mime_type, bytes.to_vec()).map_err(CommandError::from)?;
        let size_bytes = image.len();
        let mut registry = self.0.lock().map_err(|_| image_storage_unavailable())?;
        purge_expired(&mut registry);
        let next_total = registry
            .total_bytes
            .checked_add(size_bytes)
            .ok_or_else(image_capacity_reached)?;
        if registry.entries.len() >= MAX_ACTIVE_IMAGES || next_total > MAX_ACTIVE_IMAGE_BYTES {
            return Err(image_capacity_reached());
        }
        let asset_id = AssetId::new();
        let descriptor = ImageBlobDescriptor {
            asset_id,
            mime_type: image.mime_type(),
            size_bytes,
        };
        registry.entries.insert(
            asset_id,
            ImageEntry {
                image,
                project_id,
                created_at: Instant::now(),
            },
        );
        registry.total_bytes = next_total;
        Ok(descriptor)
    }

    pub(crate) fn resolve(
        &self,
        asset_id: AssetId,
        project_id: ProjectId,
    ) -> CommandResult<Option<ReferenceImage>> {
        let mut registry = self.0.lock().map_err(|_| image_storage_unavailable())?;
        purge_expired(&mut registry);
        Ok(registry
            .entries
            .get(&asset_id)
            .and_then(|entry| (entry.project_id == project_id).then(|| entry.image.clone())))
    }

    fn release(&self, asset_id: AssetId) -> CommandResult<bool> {
        let mut registry = self.0.lock().map_err(|_| image_storage_unavailable())?;
        let Some(entry) = registry.entries.remove(&asset_id) else {
            return Ok(false);
        };
        registry.total_bytes = registry
            .total_bytes
            .checked_sub(entry.image.len())
            .ok_or_else(image_storage_unavailable)?;
        Ok(true)
    }
}

fn purge_expired(registry: &mut ImageRegistry) {
    let now = Instant::now();
    registry
        .entries
        .retain(|_, entry| now.duration_since(entry.created_at) < IMAGE_TTL);
    registry.total_bytes = registry
        .entries
        .values()
        .map(|entry| entry.image.len())
        .sum();
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageBlobDescriptor {
    asset_id: AssetId,
    mime_type: &'static str,
    size_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageBlobPlaybackImportRequest {
    playback_id: Uuid,
    project_id: ProjectId,
}

impl fmt::Debug for ImageBlobPlaybackImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageBlobPlaybackImportRequest")
            .field("playback_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageReferenceSelectRequest {
    project_id: ProjectId,
}

impl fmt::Debug for ImageReferenceSelectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageReferenceSelectRequest")
            .field("project_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImagePlaybackReleaseRequest {
    playback_id: Uuid,
    project_id: ProjectId,
}

impl fmt::Debug for ImagePlaybackReleaseRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImagePlaybackReleaseRequest")
            .field("playback_id", &"<opaque>")
            .field("project_id", &"<opaque>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageReferenceExportRequest {
    project_id: ProjectId,
    playback_id: Uuid,
    suggested_name: String,
}

impl fmt::Debug for ImageReferenceExportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageReferenceExportRequest")
            .field("project_id", &"<opaque>")
            .field("playback_id", &"<opaque>")
            .field("suggested_name", &"<redacted>")
            .finish()
    }
}

#[tauri::command]
pub(crate) async fn image_reference_select(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    request: ImageReferenceSelectRequest,
) -> CommandResult<Option<osg_media_server::RegisteredMedia>> {
    ensure_reference_project(&state, request.project_id)?;
    let dialog = rfd::FileDialog::new()
        .set_parent(&window)
        .set_title("Choose album art")
        .add_filter("PNG, JPEG, or WebP image", LOCAL_IMAGE_EXTENSIONS);
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.pick_file())
        .await
        .map_err(|_| CommandError::internal("The image picker task stopped unexpectedly."))?;
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

fn register_local_reference(
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

fn local_image_mime_type(path: &Path) -> Option<&'static str> {
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

fn import_registered_image(
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

    let selected = app
        .dialog()
        .file()
        .set_title("Export album art")
        .set_file_name(&plan.suggested_name)
        .add_filter(plan.format.label(), &[plan.format.extension()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| CommandError::media_export_unsafe())?;
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case(plan.format.extension()))
    {
        return Err(CommandError::invalid_input(
            "The album-art export file type is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        write_reference_image_export(plan.image.bytes(), &destination)?;
        plan.image.commit().map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError::internal("The album-art export task stopped unexpectedly."))??;
    Ok(true)
}

#[derive(Debug, Clone, Copy)]
enum ReferenceImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ReferenceImageFormat {
    fn from_mime_type(value: &str) -> Option<Self> {
        match value {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG image",
            Self::Jpeg => "JPEG image",
            Self::Webp => "WebP image",
        }
    }
}

struct ReferenceImageExportPlan {
    image: RegisteredImageCopy,
    suggested_name: String,
    format: ReferenceImageFormat,
}

impl fmt::Debug for ReferenceImageExportPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReferenceImageExportPlan")
            .field("image", &self.image)
            .field("suggested_name", &"<redacted>")
            .field("format", &self.format)
            .finish()
    }
}

fn prepare_reference_image_export(
    media_server: &MediaServer,
    request: &ImageReferenceExportRequest,
) -> CommandResult<ReferenceImageExportPlan> {
    let image = media_server
        .copy_registered_image_for_owner(
            request.playback_id,
            request.project_id.into_uuid(),
            MAX_REFERENCE_IMAGE_BYTES,
        )?
        .ok_or_else(invalid_image_blob)?;
    let format =
        ReferenceImageFormat::from_mime_type(image.mime_type()).ok_or_else(invalid_image_blob)?;
    let suggested_name =
        canonical_export_name(&request.suggested_name, format).ok_or_else(invalid_image_blob)?;
    Ok(ReferenceImageExportPlan {
        image,
        suggested_name,
        format,
    })
}

fn canonical_export_name(value: &str, format: ReferenceImageFormat) -> Option<String> {
    if value.len() < 5 || value.len() > MAX_EXPORT_NAME_BYTES || !value.is_ascii() {
        return None;
    }
    let (stem, extension) = value.rsplit_once('.')?;
    if stem.is_empty()
        || stem.ends_with('.')
        || !matches!(
            extension.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "webp"
        )
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return None;
    }
    Some(format!("{stem}.{}", format.extension()))
}

fn write_reference_image_export(bytes: &[u8], destination: &Path) -> CommandResult<()> {
    let mut staged = tempfile::Builder::new()
        .prefix(".osg-album-art-export-")
        .suffix(".part")
        .tempfile()
        .map_err(|_| CommandError::media_export_failed())?;
    staged
        .as_file_mut()
        .write_all(bytes)
        .map_err(|_| CommandError::media_export_failed())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|_| CommandError::media_export_failed())?;
    copy_export(
        staged.path(),
        destination,
        u64::try_from(bytes.len()).map_err(|_| CommandError::media_export_failed())?,
        || false,
        |_, _| Ok(()),
    )
    .map_err(reference_export_error)
}

fn reference_export_error(error: ExportCopyError) -> CommandError {
    match error {
        ExportCopyError::UnsafeDestination => CommandError::media_export_unsafe(),
        ExportCopyError::SourceChanged => CommandError::media_export_source_changed(),
        ExportCopyError::Cancelled
        | ExportCopyError::ChannelClosed
        | ExportCopyError::JobUpdate
        | ExportCopyError::Io => CommandError::media_export_failed(),
    }
}

fn invalid_image_blob() -> CommandError {
    CommandError::invalid_input("The reference image is empty, unsupported, or malformed.")
}

fn reference_project_unavailable() -> CommandError {
    CommandError::invalid_input("The reference-image project is unavailable.")
}

fn image_capacity_reached() -> CommandError {
    CommandError::internal("The temporary reference-image limit has been reached.")
}

fn image_storage_unavailable() -> CommandError {
    CommandError::internal("Temporary reference-image storage is unavailable.")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    use osg_domain::ProjectId;
    use osg_media_server::MediaServer;
    use tempfile::tempdir;

    use super::{
        IMAGE_TTL, ImageBlobPlaybackImportRequest, ImageBlobStore, ImageReferenceExportRequest,
        MAX_ACTIVE_IMAGES, ReferenceImageFormat, canonical_export_name, import_registered_image,
        local_image_mime_type, prepare_reference_image_export, register_local_reference,
        write_reference_image_export,
    };

    fn png() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\nreference".to_vec()
    }

    fn media_server() -> MediaServer {
        MediaServer::start(["http://127.0.0.1:3030".to_owned()]).expect("media server")
    }

    #[test]
    fn imports_resolves_and_releases_only_an_opaque_id() {
        let store = ImageBlobStore::default();
        let project_id = ProjectId::new();
        let descriptor = store
            .import(project_id, "image/png", &png())
            .expect("import");
        assert_eq!(descriptor.mime_type, "image/png");
        assert_eq!(descriptor.size_bytes, png().len());
        assert_eq!(
            store
                .resolve(descriptor.asset_id, project_id)
                .expect("resolve")
                .expect("image")
                .mime_type(),
            "image/png"
        );
        assert!(
            store
                .resolve(descriptor.asset_id, ProjectId::new())
                .expect("wrong project")
                .is_none()
        );
        assert!(store.release(descriptor.asset_id).expect("release"));
        assert!(!store.release(descriptor.asset_id).expect("idempotent"));
        assert!(!format!("{store:?}").contains("reference"));
    }

    #[test]
    fn rejects_signature_mismatch_and_expires_old_entries() {
        let store = ImageBlobStore::default();
        let project_id = ProjectId::new();
        assert!(store.import(project_id, "image/png", b"not png").is_err());
        let descriptor = store
            .import(project_id, "image/png", &png())
            .expect("import");
        {
            let mut registry = store.0.lock().expect("registry");
            registry
                .entries
                .get_mut(&descriptor.asset_id)
                .expect("entry")
                .created_at -= IMAGE_TTL + Duration::from_secs(1);
        }
        assert!(
            store
                .resolve(descriptor.asset_id, project_id)
                .expect("purge")
                .is_none()
        );
    }

    #[test]
    fn local_picker_formats_and_playback_ownership_are_closed_and_project_bound() {
        assert_eq!(
            local_image_mime_type(Path::new("cover.JPG")),
            Some("image/jpeg")
        );
        assert_eq!(
            local_image_mime_type(Path::new("cover.webp")),
            Some("image/webp")
        );
        assert_eq!(local_image_mime_type(Path::new("cover.gif")), None);
        assert_eq!(local_image_mime_type(Path::new("cover.png.exe")), None);

        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("cover.png");
        fs::write(&path, png()).expect("fixture");
        let server = media_server();
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        let playback = register_local_reference(&server, &path, project_a).expect("register");
        assert!(
            server
                .copy_registered_image_for_owner(playback.id, project_b.into_uuid(), png().len(),)
                .is_err()
        );
        assert!(
            server
                .unregister_owned_image(playback.id, project_b.into_uuid())
                .is_err()
        );
        assert!(
            server
                .unregister_owned_image(playback.id, project_a.into_uuid())
                .expect("exact release")
        );
    }

    #[test]
    fn provider_import_first_binds_reuses_same_project_and_rejects_cross_project() {
        let server = media_server();
        let store = ImageBlobStore::default();
        let playback = server
            .register_image("image/png", png())
            .expect("provider image");
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        let first = import_registered_image(
            &server,
            &store,
            &ImageBlobPlaybackImportRequest {
                playback_id: playback.id,
                project_id: project_a,
            },
        )
        .expect("first import");
        let second = import_registered_image(
            &server,
            &store,
            &ImageBlobPlaybackImportRequest {
                playback_id: playback.id,
                project_id: project_a,
            },
        )
        .expect("same project reuse");
        assert!(
            import_registered_image(
                &server,
                &store,
                &ImageBlobPlaybackImportRequest {
                    playback_id: playback.id,
                    project_id: project_b,
                },
            )
            .is_err()
        );
        assert!(store.release(first.asset_id).expect("first release"));
        assert!(store.release(second.asset_id).expect("second release"));
    }

    #[test]
    fn failed_import_capacity_rolls_back_only_the_new_provider_binding() {
        let server = media_server();
        let store = ImageBlobStore::default();
        let project_a = ProjectId::new();
        for _ in 0..MAX_ACTIVE_IMAGES {
            store
                .import(project_a, "image/png", &png())
                .expect("fill temporary store");
        }
        let playback = server
            .register_image("image/png", png())
            .expect("provider image");
        assert!(
            import_registered_image(
                &server,
                &store,
                &ImageBlobPlaybackImportRequest {
                    playback_id: playback.id,
                    project_id: project_a,
                },
            )
            .is_err()
        );
        let project_b = ProjectId::new();
        let image = server
            .copy_registered_image_for_owner(playback.id, project_b.into_uuid(), png().len())
            .expect("binding rollback")
            .expect("provider remains registered");
        image.commit().expect("new owner commits");
    }

    #[test]
    fn export_cancel_and_preparation_failure_rollback_pending_provider_ownership() {
        let server = media_server();
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        let playback = server
            .register_image("image/png", png())
            .expect("provider image");
        let cancelled = prepare_reference_image_export(
            &server,
            &ImageReferenceExportRequest {
                project_id: project_a,
                playback_id: playback.id,
                suggested_name: "album-art.webp".to_owned(),
            },
        )
        .expect("prepare export");
        assert_eq!(cancelled.suggested_name, "album-art.png");
        drop(cancelled);

        let committed = prepare_reference_image_export(
            &server,
            &ImageReferenceExportRequest {
                project_id: project_b,
                playback_id: playback.id,
                suggested_name: "album-art.jpg".to_owned(),
            },
        )
        .expect("cancel rolled binding back");
        let directory = tempdir().expect("tempdir");
        let destination = directory.path().join("album-art.png");
        write_reference_image_export(committed.image.bytes(), &destination).expect("write export");
        committed.image.commit().expect("commit owner");
        assert_eq!(fs::read(destination).expect("export bytes"), png());
        let repeated = prepare_reference_image_export(
            &server,
            &ImageReferenceExportRequest {
                project_id: project_b,
                playback_id: playback.id,
                suggested_name: "second.png".to_owned(),
            },
        )
        .expect("same-project export reuse");
        drop(repeated);
        assert!(
            prepare_reference_image_export(
                &server,
                &ImageReferenceExportRequest {
                    project_id: project_a,
                    playback_id: playback.id,
                    suggested_name: "cross-project.png".to_owned(),
                },
            )
            .is_err()
        );

        let gif = server
            .register_image("image/gif", b"GIF89a-private".to_vec())
            .expect("gif capability");
        assert!(
            prepare_reference_image_export(
                &server,
                &ImageReferenceExportRequest {
                    project_id: project_a,
                    playback_id: gif.id,
                    suggested_name: "album-art.png".to_owned(),
                },
            )
            .is_err()
        );
        let recovered = server
            .copy_registered_image_for_owner(gif.id, project_b.into_uuid(), 64)
            .expect("failed prep rolls back")
            .expect("gif remains registered");
        recovered.commit().expect("new owner after failed prep");

        let failed_write = server
            .register_image("image/png", png())
            .expect("write-failure capability");
        let failed_plan = prepare_reference_image_export(
            &server,
            &ImageReferenceExportRequest {
                project_id: project_a,
                playback_id: failed_write.id,
                suggested_name: "failed.png".to_owned(),
            },
        )
        .expect("write-failure plan");
        assert!(
            write_reference_image_export(failed_plan.image.bytes(), Path::new("relative.png"))
                .is_err()
        );
        drop(failed_plan);
        let recovered = server
            .copy_registered_image_for_owner(failed_write.id, project_b.into_uuid(), png().len())
            .expect("failed write rolls back")
            .expect("write-failure capability remains");
        recovered.commit().expect("new owner after failed write");

        assert_eq!(
            canonical_export_name("cover.jpeg", ReferenceImageFormat::Webp).as_deref(),
            Some("cover.webp")
        );
        assert!(canonical_export_name("../cover.png", ReferenceImageFormat::Png).is_none());
    }
}
