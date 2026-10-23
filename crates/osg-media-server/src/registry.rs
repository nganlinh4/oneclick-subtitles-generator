//! Registration of file-backed media capabilities and the registry-wide removal path.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use uuid::Uuid;

use crate::images::canonical_image_mime_type;
use crate::range::positioned_read;
use crate::{
    ImageOwnership, MAX_REGISTERED_ASSETS, MediaEntry, MediaServer, MediaServerError, MediaSource,
    RegisteredMedia, STREAM_BUFFER_BYTES,
};

impl MediaServer {
    pub fn register(&self, path: &Path) -> Result<RegisteredMedia, MediaServerError> {
        let mime_type = mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        self.register_with_mime_type(path, mime_type)
    }

    /// Registers an extensionless native artifact using the extension retained
    /// in its validated, path-free media metadata.
    pub fn register_with_extension(
        &self,
        path: &Path,
        extension: &str,
    ) -> Result<RegisteredMedia, MediaServerError> {
        if extension.is_empty()
            || extension.len() > 16
            || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(MediaServerError::InvalidPath);
        }
        let mime_type = mime_guess::from_ext(extension)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        self.register_with_mime_type(path, mime_type)
    }

    /// Registers the exact native file handle retained by the storage verifier.
    ///
    /// No path is accepted or reopened at this boundary, so a same-path replacement between
    /// verification and playback cannot change the bytes served by the capability.
    pub fn register_verified_file_with_extension(
        &self,
        file: Arc<File>,
        extension: &str,
        expected_length: u64,
    ) -> Result<RegisteredMedia, MediaServerError> {
        if extension.is_empty()
            || extension.len() > 16
            || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(MediaServerError::InvalidPath);
        }
        let mime_type = mime_guess::from_ext(extension)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        self.register_verified_file(file, mime_type, expected_length)
    }

    /// Copies a previously verified handle into a private anonymous snapshot and checks the
    /// snapshot's BLAKE3 identity before publishing its capability.  Subsequent in-place writes to
    /// the caller's file cannot alter full or range responses, including writes racing a request.
    pub fn register_content_snapshot_with_extension(
        &self,
        file: &File,
        extension: &str,
        expected_length: u64,
        expected_content_hash: [u8; 32],
    ) -> Result<RegisteredMedia, MediaServerError> {
        if extension.is_empty()
            || extension.len() > 16
            || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(MediaServerError::InvalidPath);
        }
        let mime_type = mime_guess::from_ext(extension)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        let snapshot = private_content_snapshot(file, expected_length, expected_content_hash)?;
        self.register_verified_file(Arc::new(snapshot), mime_type, expected_length)
    }

    pub fn register_verified_file(
        &self,
        file: Arc<File>,
        mime_type: impl Into<String>,
        expected_length: u64,
    ) -> Result<RegisteredMedia, MediaServerError> {
        let mime_type = mime_type.into();
        if !valid_media_mime_type(&mime_type) || expected_length == 0 {
            return Err(MediaServerError::InvalidPath);
        }
        let metadata = file.metadata().map_err(|_| MediaServerError::InvalidPath)?;
        if !metadata.is_file() || metadata.len() != expected_length {
            return Err(MediaServerError::InvalidPath);
        }
        let id = Uuid::new_v4();
        let entry = MediaEntry {
            source: MediaSource::File {
                file,
                modified: metadata.modified().ok(),
            },
            mime_type: mime_type.clone(),
            byte_length: expected_length,
            image_owner: None,
        };
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        if assets.len() >= MAX_REGISTERED_ASSETS {
            return Err(MediaServerError::RegistryFull);
        }
        assets.insert(id, entry);
        drop(assets);
        Ok(RegisteredMedia {
            id,
            playback_url: format!(
                "http://127.0.0.1:{}/asset/{id}?token={}",
                self.inner.context.port, self.inner.context.token
            ),
            mime_type,
            byte_length: expected_length,
        })
    }

    /// Registers media whose durable, content-addressed path intentionally has
    /// no filename extension. The caller must supply MIME metadata derived from
    /// a previously validated native media asset; the value never comes from
    /// the `WebView`.
    pub fn register_with_mime_type(
        &self,
        path: &Path,
        mime_type: impl Into<String>,
    ) -> Result<RegisteredMedia, MediaServerError> {
        let mime_type = mime_type.into();
        if !valid_media_mime_type(&mime_type) {
            return Err(MediaServerError::InvalidPath);
        }
        self.register_file(path, mime_type, false, None, None)
    }

    /// Registers an extensionless, durable raster-image artifact as a file-backed capability.
    ///
    /// The MIME type and the opened file's signature must agree. Image bytes remain in the native
    /// artifact store instead of being copied into either the `WebView` or the in-memory image pool.
    pub fn register_image_file(
        &self,
        path: &Path,
        mime_type: impl Into<String>,
    ) -> Result<RegisteredMedia, MediaServerError> {
        self.register_file(path, mime_type.into(), true, None, None)
    }

    /// Registers a bounded file-backed image already owned by one native project.
    ///
    /// Size, MIME, and signature validation all use the same opened file handle. The owner is
    /// stored directly in the capability entry and disappears atomically with eviction/removal.
    pub fn register_owned_image_file(
        &self,
        path: &Path,
        mime_type: impl Into<String>,
        owner: Uuid,
        maximum_bytes: usize,
    ) -> Result<RegisteredMedia, MediaServerError> {
        if maximum_bytes == 0 {
            return Err(MediaServerError::InvalidPath);
        }
        self.register_file(
            path,
            mime_type.into(),
            true,
            Some(maximum_bytes),
            Some(owner),
        )
    }

    fn register_file(
        &self,
        path: &Path,
        mime_type: String,
        require_image_signature: bool,
        maximum_bytes: Option<usize>,
        image_owner: Option<Uuid>,
    ) -> Result<RegisteredMedia, MediaServerError> {
        self.register_file_with_observer(
            path,
            mime_type,
            require_image_signature,
            maximum_bytes,
            image_owner,
            |_| {},
        )
    }

    pub(crate) fn register_file_with_observer(
        &self,
        path: &Path,
        mime_type: String,
        require_image_signature: bool,
        maximum_bytes: Option<usize>,
        image_owner: Option<Uuid>,
        after_signature: impl FnOnce(&Path),
    ) -> Result<RegisteredMedia, MediaServerError> {
        if image_owner.is_some() && !require_image_signature {
            return Err(MediaServerError::InvalidPath);
        }
        let canonical_path = fs::canonicalize(path).map_err(|_| MediaServerError::InvalidPath)?;
        let file = File::open(&canonical_path).map_err(|_| MediaServerError::InvalidPath)?;
        let metadata = file.metadata().map_err(|_| MediaServerError::InvalidPath)?;
        if !metadata.is_file() {
            return Err(MediaServerError::InvalidPath);
        }
        if metadata.len() == 0 {
            return Err(MediaServerError::EmptyFile);
        }
        if maximum_bytes.is_some_and(|limit| {
            usize::try_from(metadata.len()).map_or(true, |length| length > limit)
        }) {
            return Err(MediaServerError::InvalidPath);
        }
        if require_image_signature {
            let mut signature = [0_u8; 12];
            let mut count = 0_usize;
            while count < signature.len() {
                let offset = u64::try_from(count).map_err(|_| MediaServerError::InvalidPath)?;
                let read = positioned_read(&file, &mut signature[count..], offset)
                    .map_err(|_| MediaServerError::InvalidPath)?;
                if read == 0 {
                    break;
                }
                count += read;
            }
            if canonical_image_mime_type(&mime_type, &signature[..count]).is_none() {
                return Err(MediaServerError::InvalidPath);
            }
        } else if !valid_media_mime_type(&mime_type) {
            return Err(MediaServerError::InvalidPath);
        }
        after_signature(&canonical_path);
        let final_metadata = file.metadata().map_err(|_| MediaServerError::InvalidPath)?;
        if !final_metadata.is_file()
            || final_metadata.len() != metadata.len()
            || final_metadata.modified().ok() != metadata.modified().ok()
            || maximum_bytes.is_some_and(|limit| {
                usize::try_from(final_metadata.len()).map_or(true, |length| length > limit)
            })
        {
            return Err(MediaServerError::InvalidPath);
        }
        let id = Uuid::new_v4();
        let entry = MediaEntry {
            source: MediaSource::File {
                file: Arc::new(file),
                modified: final_metadata.modified().ok(),
            },
            mime_type: mime_type.clone(),
            byte_length: final_metadata.len(),
            image_owner: image_owner.map(|owner| ImageOwnership {
                owner,
                committed: true,
                active_claims: 0,
                release_requested: false,
            }),
        };
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        if assets.len() >= MAX_REGISTERED_ASSETS {
            return Err(MediaServerError::RegistryFull);
        }
        assets.insert(id, entry);
        drop(assets);

        Ok(RegisteredMedia {
            id,
            playback_url: format!(
                "http://127.0.0.1:{}/asset/{id}?token={}",
                self.inner.context.port, self.inner.context.token
            ),
            mime_type,
            byte_length: final_metadata.len(),
        })
    }

    pub fn unregister(&self, id: Uuid) -> Result<bool, MediaServerError> {
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        if assets
            .get(&id)
            .is_some_and(|entry| entry.image_owner.is_some())
        {
            return Err(MediaServerError::InvalidPath);
        }
        Ok(assets.remove(&id).is_some())
    }
}

pub(crate) fn private_content_snapshot(
    source: &File,
    expected_length: u64,
    expected_content_hash: [u8; 32],
) -> Result<File, MediaServerError> {
    let metadata = source
        .metadata()
        .map_err(|_| MediaServerError::InvalidPath)?;
    if !metadata.is_file() || metadata.len() != expected_length || expected_length == 0 {
        return Err(MediaServerError::InvalidPath);
    }
    let mut snapshot = tempfile::tempfile().map_err(|_| MediaServerError::InvalidPath)?;
    let mut hasher = blake3::Hasher::new();
    let mut offset = 0_u64;
    let mut buffer = vec![0_u8; STREAM_BUFFER_BYTES].into_boxed_slice();
    while offset < expected_length {
        let remaining = expected_length - offset;
        let bounded = usize::try_from(remaining)
            .ok()
            .map_or(buffer.len(), |remaining| remaining.min(buffer.len()));
        let read = positioned_read(source, &mut buffer[..bounded], offset)
            .map_err(|_| MediaServerError::InvalidPath)?;
        if read == 0 {
            return Err(MediaServerError::InvalidPath);
        }
        hasher.update(&buffer[..read]);
        snapshot
            .write_all(&buffer[..read])
            .map_err(|_| MediaServerError::InvalidPath)?;
        offset = offset
            .checked_add(u64::try_from(read).map_err(|_| MediaServerError::InvalidPath)?)
            .ok_or(MediaServerError::InvalidPath)?;
    }
    let mut extra = [0_u8; 1];
    if positioned_read(source, &mut extra, expected_length)
        .map_err(|_| MediaServerError::InvalidPath)?
        != 0
        || hasher.finalize().as_bytes() != &expected_content_hash
    {
        return Err(MediaServerError::InvalidPath);
    }
    snapshot
        .sync_all()
        .map_err(|_| MediaServerError::InvalidPath)?;
    let mut permissions = snapshot
        .metadata()
        .map_err(|_| MediaServerError::InvalidPath)?
        .permissions();
    permissions.set_readonly(true);
    snapshot
        .set_permissions(permissions)
        .map_err(|_| MediaServerError::InvalidPath)?;
    Ok(snapshot)
}

pub(crate) fn valid_media_mime_type(value: &str) -> bool {
    let Some((top_level, subtype)) = value.split_once('/') else {
        return false;
    };
    matches!(top_level, "audio" | "video")
        && !subtype.is_empty()
        && subtype.len() <= 127
        && subtype
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
}
