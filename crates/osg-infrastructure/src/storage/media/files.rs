//! Verified media file access: bounded digests, private snapshots, file identity, and native
//! path encoding.

use std::ffi::OsString;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use osg_domain::MediaKind;

use super::{MAX_PATH_BYTES, MediaFileIdentity, VerifiedMediaFile};
use crate::storage::DatabaseError;
use crate::storage::artifacts::ContentHash;

pub(super) struct MediaSourceSnapshot {
    pub(super) file: std::fs::File,
    pub(super) content_hash: ContentHash,
}

pub(in crate::storage) fn digest_media_file(
    path: &Path,
    expected_size: u64,
) -> Result<VerifiedMediaFile, DatabaseError> {
    digest_media_file_with_post_hash(path, expected_size, || {})
}

pub(super) fn digest_media_file_with_post_hash(
    path: &Path,
    expected_size: u64,
    post_hash: impl FnOnce(),
) -> Result<VerifiedMediaFile, DatabaseError> {
    if !path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let file = open_media_file(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let hashed_handle = same_file::Handle::from_file(
        file.try_clone()
            .map_err(|_| DatabaseError::InvalidMediaLocation)?,
    )
    .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let (content_hash, after_identity) = digest_media_handle(&file, expected_size, post_hash)?;
    let _ = after_identity;
    let current_path_handle =
        same_file::Handle::from_path(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if hashed_handle != current_path_handle {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(VerifiedMediaFile { content_hash, file })
}

/// Copies the exact opened source handle into a private anonymous file while hashing it.  The
/// second source pass proves that a concurrent in-place writer did not produce a mixed snapshot;
/// after this boundary all publication reads come exclusively from the private handle.
pub(super) fn snapshot_media_file(
    path: &Path,
    expected_size: u64,
) -> Result<MediaSourceSnapshot, DatabaseError> {
    snapshot_media_file_with_post_copy(path, expected_size, || {})
}

pub(super) fn snapshot_media_file_with_post_copy(
    path: &Path,
    expected_size: u64,
    post_copy: impl FnOnce(),
) -> Result<MediaSourceSnapshot, DatabaseError> {
    let source_metadata =
        std::fs::symlink_metadata(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if !source_metadata.file_type().is_file()
        || source_metadata.file_type().is_symlink()
        || source_metadata.len() != expected_size
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    let source = open_media_file(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let source_handle = same_file::Handle::from_file(
        source
            .try_clone()
            .map_err(|_| DatabaseError::InvalidArtifactFile)?,
    )
    .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let before = source
        .metadata()
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let before_identity = media_file_identity(&before);
    let mut reader = source
        .try_clone()
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let mut file = tempfile::tempfile().map_err(DatabaseError::Io)?;
    let mut hasher = blake3::Hasher::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| DatabaseError::InvalidArtifactFile)?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(read).map_err(|_| DatabaseError::InvalidArtifactFile)?)
            .filter(|copied| *copied <= expected_size)
            .ok_or(DatabaseError::InvalidArtifactFile)?;
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    }
    if copied != expected_size {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    file.sync_all()
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let content_hash = ContentHash::from_bytes(*hasher.finalize().as_bytes());
    post_copy();
    let (source_hash, after_identity) = digest_media_handle(&source, expected_size, || {})
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    let current_path_handle =
        same_file::Handle::from_path(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if content_hash != source_hash
        || before_identity != after_identity
        || source_handle != current_path_handle
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| DatabaseError::InvalidArtifactFile)?;
    Ok(MediaSourceSnapshot { file, content_hash })
}

pub(super) fn digest_media_handle(
    file: &std::fs::File,
    expected_size: u64,
    post_hash: impl FnOnce(),
) -> Result<(ContentHash, MediaFileIdentity), DatabaseError> {
    let before = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if !before.is_file() || before.len() != expected_size {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let before_identity = media_file_identity(&before);
    let read_limit = expected_size
        .checked_add(1)
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    let mut reader = file
        .try_clone()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let mut bounded = BufReader::new(reader).take(read_limit);
    let content_hash = ContentHash::digest_reader(&mut bounded)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let remaining = bounded.limit();
    drop(bounded);
    post_hash();

    let after = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let after_identity = media_file_identity(&after);
    if remaining != 1
        || !after.is_file()
        || after.len() != expected_size
        || before_identity != after_identity
    {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok((content_hash, after_identity))
}

fn open_media_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        // The verified handle lives for the playback registration, so excluding write sharing
        // prevents a later writer from mutating the bytes behind that exact Windows handle.
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
    }
    options.open(path)
}

fn media_file_identity(metadata: &std::fs::Metadata) -> MediaFileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        MediaFileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        MediaFileIdentity {
            size_bytes: metadata.file_size(),
            modified: metadata.modified().ok(),
            creation_time: metadata.creation_time(),
            last_write_time: metadata.last_write_time(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        MediaFileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

pub(super) fn encode_path(path: &Path) -> Result<Vec<u8>, DatabaseError> {
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(bytes)
}

pub(super) fn decode_path(bytes: &[u8], encoding: &str) -> Option<PathBuf> {
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES || encoding != path_encoding() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let wide = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        Some(PathBuf::from(OsString::from_wide(&wide)))
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
    }
}

pub(super) const fn path_encoding() -> &'static str {
    if cfg!(windows) {
        "windows-utf16le"
    } else {
        "unix-bytes"
    }
}

pub(super) const fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub(super) const fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}
