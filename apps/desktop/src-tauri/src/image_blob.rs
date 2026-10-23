//! Process-scoped image blobs: bounded reference images served as loopback playback capabilities.

mod commands;
mod export;
mod requests;

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use osg_domain::{AssetId, ProjectId};
use osg_gemini::ReferenceImage;

pub(crate) use self::commands::{
    image_blob_import_playback, image_blob_release, image_reference_export,
    image_reference_playback_release, image_reference_select,
};
use self::export::{image_capacity_reached, image_storage_unavailable};
use self::requests::ImageBlobDescriptor;
use crate::error::{CommandError, CommandResult};

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

#[cfg(test)]
mod tests;
