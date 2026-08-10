use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use osg_domain::AssetId;
use osg_gemini::{MAX_REFERENCE_IMAGE_BYTES, ReferenceImage};
use serde::Serialize;
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use crate::error::{CommandError, CommandResult};

const CONTENT_TYPE_HEADER: &str = "x-osg-content-type";
const MAX_ACTIVE_IMAGES: usize = 4;
const MAX_ACTIVE_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const IMAGE_TTL: Duration = Duration::from_mins(10);

#[derive(Clone)]
struct ImageEntry {
    image: ReferenceImage,
    created_at: Instant,
}

impl fmt::Debug for ImageEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageEntry")
            .field("image", &self.image)
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
    fn import(&self, mime_type: &str, bytes: &[u8]) -> CommandResult<ImageBlobDescriptor> {
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
                created_at: Instant::now(),
            },
        );
        registry.total_bytes = next_total;
        Ok(descriptor)
    }

    pub(crate) fn resolve(&self, asset_id: AssetId) -> CommandResult<Option<ReferenceImage>> {
        let mut registry = self.0.lock().map_err(|_| image_storage_unavailable())?;
        purge_expired(&mut registry);
        Ok(registry
            .entries
            .get(&asset_id)
            .map(|entry| entry.image.clone()))
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

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Request as owned command extractors"
)]
pub(crate) async fn image_blob_import(
    store: State<'_, ImageBlobStore>,
    request: Request<'_>,
) -> CommandResult<ImageBlobDescriptor> {
    let mime_type = request
        .headers()
        .get(CONTENT_TYPE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(invalid_image_blob)?
        .to_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid_image_blob());
    };
    validate_raw_image_body(bytes)?;
    let bytes = bytes.clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.import(&mime_type, &bytes))
        .await
        .map_err(|_| CommandError::internal("The image import task stopped unexpectedly."))?
}

fn validate_raw_image_body(bytes: &[u8]) -> CommandResult<()> {
    if bytes.is_empty() || bytes.len() > MAX_REFERENCE_IMAGE_BYTES {
        return Err(invalid_image_blob());
    }
    Ok(())
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

fn invalid_image_blob() -> CommandError {
    CommandError::invalid_input("The reference image is empty, unsupported, or malformed.")
}

fn image_capacity_reached() -> CommandError {
    CommandError::internal("The temporary reference-image limit has been reached.")
}

fn image_storage_unavailable() -> CommandError {
    CommandError::internal("Temporary reference-image storage is unavailable.")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use osg_gemini::MAX_REFERENCE_IMAGE_BYTES;

    use super::{IMAGE_TTL, ImageBlobStore, validate_raw_image_body};

    fn png() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\nreference".to_vec()
    }

    #[test]
    fn imports_resolves_and_releases_only_an_opaque_id() {
        let store = ImageBlobStore::default();
        let descriptor = store.import("image/png", &png()).expect("import");
        assert_eq!(descriptor.mime_type, "image/png");
        assert_eq!(descriptor.size_bytes, png().len());
        assert_eq!(
            store
                .resolve(descriptor.asset_id)
                .expect("resolve")
                .expect("image")
                .mime_type(),
            "image/png"
        );
        assert!(store.release(descriptor.asset_id).expect("release"));
        assert!(!store.release(descriptor.asset_id).expect("idempotent"));
        assert!(!format!("{store:?}").contains("reference"));
    }

    #[test]
    fn rejects_signature_mismatch_and_expires_old_entries() {
        let store = ImageBlobStore::default();
        assert!(store.import("image/png", b"not png").is_err());
        let descriptor = store.import("image/png", &png()).expect("import");
        {
            let mut registry = store.0.lock().expect("registry");
            registry
                .entries
                .get_mut(&descriptor.asset_id)
                .expect("entry")
                .created_at -= IMAGE_TTL + Duration::from_secs(1);
        }
        assert!(store.resolve(descriptor.asset_id).expect("purge").is_none());
    }

    #[test]
    fn rejects_empty_and_oversized_ipc_bodies_before_the_owned_clone() {
        assert!(validate_raw_image_body(&[]).is_err());
        let oversized = vec![0_u8; MAX_REFERENCE_IMAGE_BYTES + 1];
        assert!(validate_raw_image_body(&oversized).is_err());
        assert!(validate_raw_image_body(&png()).is_ok());
    }
}
