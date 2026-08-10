use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use osg_domain::{AssetId, MediaAsset, MediaKind};
use serde::Serialize;
use tauri::State;
use tauri::ipc::{InvokeBody, Request};
use tempfile::{Builder, NamedTempFile, TempDir};

use crate::error::{CommandError, CommandResult};
use crate::state::LocalMedia;

const CONTENT_TYPE_HEADER: &str = "x-osg-content-type";
const MAX_AUDIO_BLOB_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTIVE_BLOBS: usize = 8;
const MAX_ACTIVE_BLOB_BYTES: u64 = 256 * 1024 * 1024;
const BLOB_TTL: Duration = Duration::from_mins(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioBlobFormat {
    Aac,
    Flac,
    M4a,
    Mp3,
    Ogg,
    Wav,
    Webm,
}

impl AudioBlobFormat {
    fn from_mime_type(value: &str) -> Option<Self> {
        match value {
            "audio/aac" => Some(Self::Aac),
            "audio/flac" => Some(Self::Flac),
            "audio/mp4" | "audio/x-m4a" => Some(Self::M4a),
            "audio/mpeg" => Some(Self::Mp3),
            "audio/ogg" => Some(Self::Ogg),
            "audio/wav" | "audio/wave" | "audio/x-wav" => Some(Self::Wav),
            "audio/webm" => Some(Self::Webm),
            _ => None,
        }
    }

    const fn extension(self) -> &'static str {
        match self {
            Self::Aac => "aac",
            Self::Flac => "flac",
            Self::M4a => "m4a",
            Self::Mp3 => "mp3",
            Self::Ogg => "ogg",
            Self::Wav => "wav",
            Self::Webm => "weba",
        }
    }

    const fn suffix(self) -> &'static str {
        match self {
            Self::Aac => ".aac",
            Self::Flac => ".flac",
            Self::M4a => ".m4a",
            Self::Mp3 => ".mp3",
            Self::Ogg => ".ogg",
            Self::Wav => ".wav",
            Self::Webm => ".weba",
        }
    }

    fn has_valid_signature(self, bytes: &[u8]) -> bool {
        match self {
            Self::Aac => is_adts(bytes),
            Self::Flac => bytes.starts_with(b"fLaC"),
            Self::M4a => is_iso_base_media(bytes),
            Self::Mp3 => is_mp3(bytes),
            Self::Ogg => bytes.len() >= 27 && bytes.starts_with(b"OggS\0"),
            Self::Wav => {
                bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE"
            }
            Self::Webm => is_webm(bytes),
        }
    }
}

fn is_adts(bytes: &[u8]) -> bool {
    bytes.len() >= 7 && bytes[0] == 0xff && bytes[1] & 0xf6 == 0xf0 && bytes[2] >> 2 & 0x0f != 0x0f
}

fn is_iso_base_media(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let box_size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    box_size >= 16 && box_size <= bytes.len()
}

fn is_mp3(bytes: &[u8]) -> bool {
    if bytes.len() >= 10 && bytes.starts_with(b"ID3") {
        return bytes[6..10].iter().all(|byte| byte & 0x80 == 0);
    }
    bytes.len() >= 4
        && bytes[0] == 0xff
        && bytes[1] & 0xe0 == 0xe0
        && bytes[1] & 0x18 != 0x08
        && bytes[1] & 0x06 != 0
        && bytes[2] & 0xf0 != 0
        && bytes[2] & 0xf0 != 0xf0
        && bytes[2] & 0x0c != 0x0c
}

fn is_webm(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && bytes
            .get(..bytes.len().min(4096))
            .is_some_and(|prefix| prefix.windows(4).any(|window| window == b"webm"))
}

#[derive(Clone)]
struct BlobEntry {
    asset: MediaAsset,
    file: Arc<NamedTempFile>,
    created_at: Instant,
}

impl fmt::Debug for BlobEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BlobEntry")
            .field("asset", &self.asset)
            .field("file", &"<redacted>")
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Debug, Default)]
struct BlobRegistry {
    entries: BTreeMap<AssetId, BlobEntry>,
    total_bytes: u64,
}

struct MediaBlobStoreInner {
    // Drop the open files before asking TempDir to remove its directory on Windows.
    registry: Mutex<BlobRegistry>,
    directory: TempDir,
}

impl fmt::Debug for MediaBlobStoreInner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaBlobStoreInner")
            .field("registry", &"<redacted>")
            .field("directory", &"<redacted>")
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct MediaBlobStore(Arc<MediaBlobStoreInner>);

impl fmt::Debug for MediaBlobStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaBlobStore")
            .field("inner", &self.0)
            .finish()
    }
}

impl MediaBlobStore {
    pub(crate) fn new(cache_root: &Path) -> io::Result<Self> {
        fs::create_dir_all(cache_root)?;
        let metadata = fs::symlink_metadata(cache_root)?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::other("invalid ephemeral media cache root"));
        }
        let directory = Builder::new().prefix("session-").tempdir_in(cache_root)?;
        Ok(Self(Arc::new(MediaBlobStoreInner {
            registry: Mutex::new(BlobRegistry::default()),
            directory,
        })))
    }

    fn import(&self, format: AudioBlobFormat, bytes: &[u8]) -> CommandResult<MediaAsset> {
        if bytes.is_empty()
            || bytes.len() > MAX_AUDIO_BLOB_BYTES
            || !format.has_valid_signature(bytes)
        {
            return Err(invalid_audio_blob());
        }

        let size_bytes = u64::try_from(bytes.len()).map_err(|_| invalid_audio_blob())?;
        let mut file = Builder::new()
            .prefix("audio-")
            .suffix(format.suffix())
            .tempfile_in(self.0.directory.path())
            .map_err(|_| audio_blob_storage_unavailable())?;
        file.as_file_mut()
            .write_all(bytes)
            .and_then(|()| file.as_file_mut().flush())
            .and_then(|()| file.as_file().sync_all())
            .map_err(|_| audio_blob_storage_unavailable())?;
        if file
            .as_file()
            .metadata()
            .map(|metadata| metadata.len())
            .ok()
            != Some(size_bytes)
        {
            return Err(audio_blob_storage_unavailable());
        }

        let asset = MediaAsset::new(
            format!("recording.{}", format.extension()),
            format.extension(),
            size_bytes,
            MediaKind::Audio,
        )
        .map_err(|_| invalid_audio_blob())?;
        let entry = BlobEntry {
            asset: asset.clone(),
            file: Arc::new(file),
            created_at: Instant::now(),
        };

        let mut registry = self
            .0
            .registry
            .lock()
            .map_err(|_| audio_blob_storage_unavailable())?;
        purge_expired(&mut registry);
        let next_total = registry
            .total_bytes
            .checked_add(size_bytes)
            .ok_or_else(audio_blob_capacity_reached)?;
        if registry.entries.len() >= MAX_ACTIVE_BLOBS || next_total > MAX_ACTIVE_BLOB_BYTES {
            return Err(audio_blob_capacity_reached());
        }
        registry.total_bytes = next_total;
        registry.entries.insert(asset.id(), entry);
        Ok(asset)
    }

    pub(crate) fn resolve(&self, asset_id: AssetId) -> CommandResult<Option<LocalMedia>> {
        let mut registry = self
            .0
            .registry
            .lock()
            .map_err(|_| audio_blob_storage_unavailable())?;
        purge_expired(&mut registry);
        Ok(registry.entries.get(&asset_id).map(|entry| {
            LocalMedia::ephemeral(
                entry.asset.id(),
                entry.asset.kind(),
                entry.asset.extension(),
                Arc::clone(&entry.file),
            )
        }))
    }

    fn release(&self, asset_id: AssetId) -> CommandResult<bool> {
        let mut registry = self
            .0
            .registry
            .lock()
            .map_err(|_| audio_blob_storage_unavailable())?;
        let Some(entry) = registry.entries.remove(&asset_id) else {
            return Ok(false);
        };
        registry.total_bytes = registry
            .total_bytes
            .checked_sub(entry.asset.size_bytes())
            .ok_or_else(audio_blob_storage_unavailable)?;
        Ok(true)
    }
}

fn purge_expired(registry: &mut BlobRegistry) {
    let now = Instant::now();
    registry
        .entries
        .retain(|_, entry| now.duration_since(entry.created_at) < BLOB_TTL);
    registry.total_bytes = registry
        .entries
        .values()
        .map(|entry| entry.asset.size_bytes())
        .sum();
}

#[derive(Debug, Serialize)]
pub(crate) struct MediaBlobImportResponse {
    asset: MediaAsset,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Request as owned command extractors"
)]
pub(crate) async fn media_blob_import(
    store: State<'_, MediaBlobStore>,
    request: Request<'_>,
) -> CommandResult<MediaBlobImportResponse> {
    let mime_type = request
        .headers()
        .get(CONTENT_TYPE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(invalid_audio_blob)?;
    let format = AudioBlobFormat::from_mime_type(mime_type).ok_or_else(invalid_audio_blob)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid_audio_blob());
    };
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_BLOB_BYTES || !format.has_valid_signature(bytes)
    {
        return Err(invalid_audio_blob());
    }
    let bytes = bytes.clone();
    let store = store.inner().clone();
    let asset = tauri::async_runtime::spawn_blocking(move || store.import(format, &bytes))
        .await
        .map_err(|_| CommandError::internal("The audio import task stopped unexpectedly."))??;
    Ok(MediaBlobImportResponse { asset })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn media_blob_release(
    store: State<'_, MediaBlobStore>,
    asset_id: AssetId,
) -> CommandResult<bool> {
    store.release(asset_id)
}

fn invalid_audio_blob() -> CommandError {
    CommandError::invalid_input("The audio recording is empty, unsupported, or malformed.")
}

fn audio_blob_capacity_reached() -> CommandError {
    CommandError::internal("The temporary audio recording limit has been reached.")
}

fn audio_blob_storage_unavailable() -> CommandError {
    CommandError::internal("Temporary audio storage is unavailable.")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use osg_domain::MediaKind;

    use super::{AudioBlobFormat, BLOB_TTL, MediaBlobStore};

    fn fixture(format: AudioBlobFormat) -> Vec<u8> {
        match format {
            AudioBlobFormat::Aac => vec![0xff, 0xf1, 0x50, 0x80, 0, 0, 0],
            AudioBlobFormat::Flac => b"fLaCfixture".to_vec(),
            AudioBlobFormat::M4a => {
                let mut bytes = 16_u32.to_be_bytes().to_vec();
                bytes.extend_from_slice(b"ftypM4A \0\0\0\0");
                bytes
            }
            AudioBlobFormat::Mp3 => b"ID3\x04\0\0\0\0\0\0audio".to_vec(),
            AudioBlobFormat::Ogg => {
                let mut bytes = b"OggS\0".to_vec();
                bytes.resize(27, 0);
                bytes
            }
            AudioBlobFormat::Wav => b"RIFF\x04\0\0\0WAVEdata".to_vec(),
            AudioBlobFormat::Webm => {
                let mut bytes = vec![0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84];
                bytes.extend_from_slice(b"webm");
                bytes
            }
        }
    }

    #[test]
    fn accepted_mime_types_require_the_matching_container_signature() {
        let cases = [
            ("audio/aac", AudioBlobFormat::Aac),
            ("audio/flac", AudioBlobFormat::Flac),
            ("audio/mp4", AudioBlobFormat::M4a),
            ("audio/x-m4a", AudioBlobFormat::M4a),
            ("audio/mpeg", AudioBlobFormat::Mp3),
            ("audio/ogg", AudioBlobFormat::Ogg),
            ("audio/wav", AudioBlobFormat::Wav),
            ("audio/wave", AudioBlobFormat::Wav),
            ("audio/x-wav", AudioBlobFormat::Wav),
            ("audio/webm", AudioBlobFormat::Webm),
        ];
        for (mime_type, format) in cases {
            let bytes = fixture(format);
            assert_eq!(AudioBlobFormat::from_mime_type(mime_type), Some(format));
            assert!(format.has_valid_signature(&bytes));
            assert!(!format.has_valid_signature(b"not audio"));
        }
        assert_eq!(AudioBlobFormat::from_mime_type("video/webm"), None);
        assert_eq!(
            AudioBlobFormat::from_mime_type("audio/webm;codecs=opus"),
            None
        );
        assert!(!AudioBlobFormat::Wav.has_valid_signature(&fixture(AudioBlobFormat::Webm)));
    }

    #[test]
    fn imported_blob_is_path_free_and_release_waits_for_active_native_leases() {
        let parent = tempfile::tempdir().expect("test parent");
        let store = MediaBlobStore::new(&parent.path().join("ephemeral")).expect("blob store");
        let asset = store
            .import(AudioBlobFormat::Webm, &fixture(AudioBlobFormat::Webm))
            .expect("import");

        assert_eq!(asset.kind(), MediaKind::Audio);
        assert_eq!(asset.extension(), "weba");
        let lease = store.resolve(asset.id()).expect("resolve").expect("lease");
        let path = lease.path().to_owned();
        assert!(path.exists());
        assert_eq!(lease.mime_type(), Some("audio/webm"));
        assert!(store.release(asset.id()).expect("release"));
        assert!(
            path.exists(),
            "the running Gemini upload still owns the file"
        );
        drop(lease);
        assert!(!path.exists());
        assert!(!store.release(asset.id()).expect("idempotent release"));
        assert!(!format!("{store:?}").contains(path.to_string_lossy().as_ref()));
    }

    #[test]
    fn expired_entries_are_purged_without_affecting_active_leases() {
        let parent = tempfile::tempdir().expect("test parent");
        let store = MediaBlobStore::new(&parent.path().join("ephemeral")).expect("blob store");
        let asset = store
            .import(AudioBlobFormat::Wav, &fixture(AudioBlobFormat::Wav))
            .expect("import");
        let lease = store.resolve(asset.id()).expect("resolve").expect("lease");
        let path = lease.path().to_owned();
        {
            let mut registry = store.0.registry.lock().expect("registry");
            registry
                .entries
                .get_mut(&asset.id())
                .expect("entry")
                .created_at -= BLOB_TTL + Duration::from_secs(1);
        }

        assert!(store.resolve(asset.id()).expect("purge").is_none());
        assert!(path.exists());
        drop(lease);
        assert!(!path.exists());
    }

    #[test]
    fn cache_root_and_temporary_files_are_never_symlinks() {
        let parent = tempfile::tempdir().expect("test parent");
        let store = MediaBlobStore::new(&parent.path().join("ephemeral")).expect("blob store");
        let asset = store
            .import(AudioBlobFormat::Flac, &fixture(AudioBlobFormat::Flac))
            .expect("import");
        let lease = store.resolve(asset.id()).expect("resolve").expect("lease");
        let metadata = fs::symlink_metadata(lease.path()).expect("metadata");
        assert!(metadata.file_type().is_file());
        assert!(!metadata.file_type().is_symlink());
    }
}
