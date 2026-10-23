//! Provider and durable raster-image capabilities with transactional project ownership.

use std::collections::HashMap;
use std::fs::File;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use uuid::Uuid;

use crate::range::positioned_read;
use crate::{
    CloneableEntry, CloneableSource, IMAGE_LIFETIME, ImageOwnership, MAX_IMAGE_BYTES,
    MAX_PROVIDER_IMAGE_REGISTRY_BYTES, MAX_REGISTERED_ASSETS, MAX_REGISTERED_IMAGES, MediaEntry,
    MediaServer, MediaServerError, MediaSource, RegisteredMedia,
};

/// A signature-checked native image copy with a transactional project-owner claim.
///
/// Dropping this value rolls back a newly-created claim unless another same-owner operation has
/// committed it. Calling [`Self::commit`] makes the owner binding durable for the capability's
/// remaining registry lifetime.
pub struct RegisteredImageCopy {
    mime_type: String,
    bytes: Vec<u8>,
    claim: Option<ImageOwnerClaim>,
}

impl std::fmt::Debug for RegisteredImageCopy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegisteredImageCopy")
            .field("mime_type", &self.mime_type)
            .field("byte_length", &self.bytes.len())
            .field("owner", &"<opaque>")
            .finish_non_exhaustive()
    }
}

impl RegisteredImageCopy {
    #[must_use]
    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn commit(mut self) -> Result<(), MediaServerError> {
        self.claim
            .take()
            .ok_or(MediaServerError::RegistryUnavailable)?
            .commit()
    }
}

struct ImageOwnerClaim {
    server: MediaServer,
    id: Uuid,
    owner: Uuid,
    active: bool,
}

impl ImageOwnerClaim {
    fn commit(mut self) -> Result<(), MediaServerError> {
        self.server
            .finish_image_owner_claim(self.id, self.owner, true)?;
        self.active = false;
        Ok(())
    }
}

impl Drop for ImageOwnerClaim {
    fn drop(&mut self) {
        if self.active {
            let _ = self
                .server
                .finish_image_owner_claim(self.id, self.owner, false);
            self.active = false;
        }
    }
}

impl MediaServer {
    /// Registers a provider-fetched raster image in the process-scoped capability registry.
    ///
    /// Image bytes never touch a caller-selected path. Exact MIME/signature validation, per-entry
    /// and aggregate memory bounds, LRU eviction, and a fixed lifetime keep the WebView-facing URL
    /// both opaque and short-lived.
    pub fn register_image(
        &self,
        mime_type: &str,
        bytes: Vec<u8>,
    ) -> Result<RegisteredMedia, MediaServerError> {
        self.register_image_with_lifetime(mime_type, bytes, IMAGE_LIFETIME)
    }

    /// Atomically registers a bounded group of provider images.
    ///
    /// Existing least-recently-used images may be evicted to make room, but images in this batch
    /// are either all retained or none are inserted. This prevents a multi-result provider command
    /// from returning a capability that another insertion in the same response already evicted.
    pub fn register_images(
        &self,
        images: Vec<(String, Vec<u8>)>,
    ) -> Result<Vec<RegisteredMedia>, MediaServerError> {
        self.register_images_with_lifetime(images, IMAGE_LIFETIME)
    }

    pub(crate) fn register_image_with_lifetime(
        &self,
        mime_type: &str,
        bytes: Vec<u8>,
        lifetime: Duration,
    ) -> Result<RegisteredMedia, MediaServerError> {
        let mut registered =
            self.register_images_with_lifetime(vec![(mime_type.to_owned(), bytes)], lifetime)?;
        registered.pop().ok_or(MediaServerError::InvalidPath)
    }

    fn register_images_with_lifetime(
        &self,
        images: Vec<(String, Vec<u8>)>,
        lifetime: Duration,
    ) -> Result<Vec<RegisteredMedia>, MediaServerError> {
        if images.is_empty() || images.len() > MAX_REGISTERED_IMAGES || lifetime.is_zero() {
            return Err(MediaServerError::InvalidPath);
        }
        let mut incoming_bytes = 0_usize;
        let mut prepared = Vec::with_capacity(images.len());
        for (mime_type, bytes) in images {
            if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
                return Err(MediaServerError::InvalidPath);
            }
            let Some(mime_type) = canonical_image_mime_type(&mime_type, &bytes) else {
                return Err(MediaServerError::InvalidPath);
            };
            incoming_bytes = incoming_bytes
                .checked_add(bytes.len())
                .filter(|total| *total <= MAX_PROVIDER_IMAGE_REGISTRY_BYTES)
                .ok_or(MediaServerError::RegistryFull)?;
            let byte_length =
                u64::try_from(bytes.len()).map_err(|_| MediaServerError::InvalidPath)?;
            prepared.push((mime_type.to_owned(), Arc::<[u8]>::from(bytes), byte_length));
        }

        let now = Instant::now();
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        purge_expired_images(&mut assets, now);
        make_image_capacity(&mut assets, prepared.len(), incoming_bytes)?;

        let mut registered = Vec::with_capacity(prepared.len());
        for (mime_type, bytes, byte_length) in prepared {
            let id = Uuid::new_v4();
            assets.insert(
                id,
                MediaEntry {
                    source: MediaSource::Image {
                        bytes,
                        expires_at: now + lifetime,
                        last_accessed: now,
                    },
                    mime_type: mime_type.clone(),
                    byte_length,
                    image_owner: None,
                },
            );
            registered.push(RegisteredMedia {
                id,
                playback_url: format!(
                    "http://127.0.0.1:{}/asset/{id}?token={}",
                    self.inner.context.port, self.inner.context.token
                ),
                mime_type,
                byte_length,
            });
        }
        drop(assets);
        Ok(registered)
    }

    /// Copies an already-authorized raster-image capability for another native subsystem.
    ///
    /// The caller supplies only the opaque registry ID. Provider bytes and file paths never cross
    /// the `WebView` boundary, while the destination subsystem still gets to apply its own tighter
    /// size, MIME, signature, lifetime, and ownership rules.
    pub fn copy_registered_image_for_owner(
        &self,
        id: Uuid,
        owner: Uuid,
        maximum_bytes: usize,
    ) -> Result<Option<RegisteredImageCopy>, MediaServerError> {
        if maximum_bytes == 0 || maximum_bytes > MAX_PROVIDER_IMAGE_REGISTRY_BYTES {
            return Err(MediaServerError::InvalidPath);
        }
        let (entry, claim) = {
            let mut assets = self
                .inner
                .context
                .assets
                .write()
                .map_err(|_| MediaServerError::RegistryUnavailable)?;
            let now = Instant::now();
            purge_expired_images(&mut assets, now);
            let Some(entry) = assets.get_mut(&id) else {
                return Ok(None);
            };
            if !entry.mime_type.starts_with("image/") {
                return Err(MediaServerError::InvalidPath);
            }
            match &mut entry.image_owner {
                Some(binding) if binding.owner != owner || binding.release_requested => {
                    return Err(MediaServerError::InvalidPath);
                }
                Some(binding) => {
                    binding.active_claims = binding
                        .active_claims
                        .checked_add(1)
                        .ok_or(MediaServerError::RegistryFull)?;
                }
                slot @ None => {
                    *slot = Some(ImageOwnership {
                        owner,
                        committed: false,
                        active_claims: 1,
                        release_requested: false,
                    });
                }
            }
            if let MediaSource::Image { last_accessed, .. } = &mut entry.source {
                *last_accessed = now;
            }
            (
                CloneableEntry::from(&*entry),
                ImageOwnerClaim {
                    server: self.clone(),
                    id,
                    owner,
                    active: true,
                },
            )
        };
        let expected_length = usize::try_from(entry.byte_length)
            .ok()
            .filter(|length| *length > 0 && *length <= maximum_bytes)
            .ok_or(MediaServerError::InvalidPath)?;
        let bytes = match &entry.source {
            CloneableSource::Image(bytes) => {
                if bytes.len() != expected_length {
                    return Err(MediaServerError::InvalidPath);
                }
                bytes.to_vec()
            }
            CloneableSource::File { file, modified } => {
                copy_registered_file(file, *modified, expected_length)?
            }
        };
        if canonical_image_mime_type(&entry.mime_type, &bytes).is_none() {
            return Err(MediaServerError::InvalidPath);
        }
        Ok(Some(RegisteredImageCopy {
            mime_type: entry.mime_type,
            bytes,
            claim: Some(claim),
        }))
    }

    fn finish_image_owner_claim(
        &self,
        id: Uuid,
        owner: Uuid,
        commit: bool,
    ) -> Result<(), MediaServerError> {
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        let entry = assets.get_mut(&id).ok_or(MediaServerError::InvalidPath)?;
        let remove_entry = {
            let binding = entry
                .image_owner
                .as_mut()
                .filter(|binding| binding.owner == owner && binding.active_claims > 0)
                .ok_or(MediaServerError::InvalidPath)?;
            binding.active_claims -= 1;
            if commit {
                binding.committed = true;
            }
            binding.active_claims == 0 && binding.release_requested
        };
        if remove_entry {
            assets.remove(&id);
        } else if entry
            .image_owner
            .is_some_and(|binding| binding.active_claims == 0 && !binding.committed)
        {
            entry.image_owner = None;
        }
        Ok(())
    }

    /// Removes an image capability only when the exact committed project owner matches.
    pub fn unregister_owned_image(&self, id: Uuid, owner: Uuid) -> Result<bool, MediaServerError> {
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        let Some(entry) = assets.get(&id) else {
            return Ok(false);
        };
        let Some(binding) = entry.image_owner else {
            return Err(MediaServerError::InvalidPath);
        };
        if binding.owner != owner {
            return Err(MediaServerError::InvalidPath);
        }
        if binding.active_claims != 0 {
            assets
                .get_mut(&id)
                .and_then(|entry| entry.image_owner.as_mut())
                .ok_or(MediaServerError::RegistryUnavailable)?
                .release_requested = true;
            return Ok(true);
        }
        if !binding.committed {
            return Err(MediaServerError::InvalidPath);
        }
        Ok(assets.remove(&id).is_some())
    }
}

pub(crate) fn copy_registered_file(
    file: &File,
    expected_modified: Option<SystemTime>,
    expected_length: usize,
) -> Result<Vec<u8>, MediaServerError> {
    let expected_length_u64 =
        u64::try_from(expected_length).map_err(|_| MediaServerError::InvalidPath)?;
    let metadata = file.metadata().map_err(|_| MediaServerError::InvalidPath)?;
    if !metadata.is_file()
        || metadata.len() != expected_length_u64
        || metadata.modified().ok() != expected_modified
    {
        return Err(MediaServerError::InvalidPath);
    }
    let mut bytes = vec![0_u8; expected_length];
    let mut offset = 0_usize;
    while offset < bytes.len() {
        let offset_u64 = u64::try_from(offset).map_err(|_| MediaServerError::InvalidPath)?;
        let read = positioned_read(file, &mut bytes[offset..], offset_u64)
            .map_err(|_| MediaServerError::InvalidPath)?;
        if read == 0 {
            return Err(MediaServerError::InvalidPath);
        }
        offset = offset
            .checked_add(read)
            .ok_or(MediaServerError::InvalidPath)?;
    }
    let metadata = file.metadata().map_err(|_| MediaServerError::InvalidPath)?;
    if metadata.len() != expected_length_u64 || metadata.modified().ok() != expected_modified {
        return Err(MediaServerError::InvalidPath);
    }
    Ok(bytes)
}

pub(crate) fn canonical_image_mime_type(value: &str, bytes: &[u8]) -> Option<&'static str> {
    osg_formats::image::verified_mime_type(value, bytes)
}

pub(crate) fn purge_expired_images(assets: &mut HashMap<Uuid, MediaEntry>, now: Instant) {
    assets.retain(|_, entry| {
        let claimed = entry
            .image_owner
            .is_some_and(|binding| binding.active_claims != 0);
        !matches!(
            &entry.source,
            MediaSource::Image { expires_at, .. } if *expires_at <= now && !claimed
        )
    });
}

pub(crate) fn make_image_capacity(
    assets: &mut HashMap<Uuid, MediaEntry>,
    incoming_count: usize,
    incoming_bytes: usize,
) -> Result<(), MediaServerError> {
    if incoming_count == 0
        || incoming_count > MAX_REGISTERED_IMAGES
        || incoming_bytes > MAX_PROVIDER_IMAGE_REGISTRY_BYTES
    {
        return Err(MediaServerError::RegistryFull);
    }
    loop {
        let image_count = assets
            .values()
            .filter(|entry| matches!(&entry.source, MediaSource::Image { .. }))
            .count();
        let image_bytes = assets
            .values()
            .filter_map(|entry| match &entry.source {
                MediaSource::Image { .. } => usize::try_from(entry.byte_length).ok(),
                MediaSource::File { .. } => None,
            })
            .try_fold(0_usize, usize::checked_add)
            .ok_or(MediaServerError::RegistryFull)?;
        let has_capacity = assets
            .len()
            .checked_add(incoming_count)
            .is_some_and(|total| total <= MAX_REGISTERED_ASSETS)
            && image_count
                .checked_add(incoming_count)
                .is_some_and(|total| total <= MAX_REGISTERED_IMAGES)
            && image_bytes
                .checked_add(incoming_bytes)
                .is_some_and(|total| total <= MAX_PROVIDER_IMAGE_REGISTRY_BYTES);
        if has_capacity {
            return Ok(());
        }
        let oldest = assets
            .iter()
            .filter_map(|(id, entry)| match &entry.source {
                MediaSource::Image { last_accessed, .. }
                    if entry
                        .image_owner
                        .is_none_or(|binding| binding.active_claims == 0) =>
                {
                    Some((*id, *last_accessed))
                }
                MediaSource::File { .. } | MediaSource::Image { .. } => None,
            })
            .min_by_key(|(_, last_accessed)| *last_accessed)
            .map(|(id, _)| id)
            .ok_or(MediaServerError::RegistryFull)?;
        assets.remove(&oldest);
    }
}
