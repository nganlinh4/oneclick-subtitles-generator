//! The artifact root directory: identity pinning, confined child paths, and sealed regular-file
//! helpers.

use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use uuid::Uuid;

use super::rows::hex;
use super::{ArtifactId, ArtifactKind, ArtifactRecord, ContentHash, ROOT_IDENTITY_FILE};
use crate::storage::DatabaseError;

#[derive(Clone)]
pub(in crate::storage) struct ArtifactRoot {
    pub(super) canonical: PathBuf,
    identity: RootIdentity,
}

impl std::fmt::Debug for ArtifactRoot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtifactRoot")
            .field("canonical", &"<redacted>")
            .finish()
    }
}

impl ArtifactRoot {
    pub(in crate::storage) fn prepare(path: &Path) -> Result<Self, DatabaseError> {
        fs::create_dir_all(path)?;
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(DatabaseError::InvalidArtifactRoot);
        }
        let canonical = fs::canonicalize(path)?;
        let identity = RootIdentity::load_or_create(&canonical)?;
        Ok(Self {
            canonical,
            identity,
        })
    }

    pub(super) fn verify(&self) -> Result<(), DatabaseError> {
        let metadata = fs::symlink_metadata(&self.canonical)
            .map_err(|_| DatabaseError::InvalidArtifactRoot)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || RootIdentity::load(&self.canonical).ok().as_ref() != Some(&self.identity)
            || fs::canonicalize(&self.canonical).ok().as_deref() != Some(self.canonical.as_path())
        {
            return Err(DatabaseError::InvalidArtifactRoot);
        }
        Ok(())
    }

    pub(super) fn child(&self, name: &str) -> Result<PathBuf, DatabaseError> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(DatabaseError::InvalidArtifactMetadata);
        }
        Ok(self.canonical.join(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RootIdentity([u8; 16]);

impl RootIdentity {
    fn load_or_create(root: &Path) -> Result<Self, DatabaseError> {
        match Self::load(root) {
            Ok(identity) => Ok(identity),
            Err(DatabaseError::InvalidArtifactRoot) if !root.join(ROOT_IDENTITY_FILE).exists() => {
                let identity = Self(*Uuid::now_v7().as_bytes());
                let temporary = root.join(format!(".root-identity-{}.pending", Uuid::now_v7()));
                let result = (|| {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temporary)?;
                    file.write_all(&identity.0)?;
                    file.sync_all()?;
                    match fs::hard_link(&temporary, root.join(ROOT_IDENTITY_FILE)) {
                        Ok(()) => Ok(identity),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            Self::load(root)
                        }
                        Err(error) => Err(error.into()),
                    }
                })();
                let _ = fs::remove_file(temporary);
                result
            }
            Err(error) => Err(error),
        }
    }

    fn load(root: &Path) -> Result<Self, DatabaseError> {
        let path = root.join(ROOT_IDENTITY_FILE);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| DatabaseError::InvalidArtifactRoot)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 16 {
            return Err(DatabaseError::InvalidArtifactRoot);
        }
        let bytes = fs::read(path).map_err(|_| DatabaseError::InvalidArtifactRoot)?;
        Ok(Self(
            bytes
                .try_into()
                .map_err(|_| DatabaseError::InvalidArtifactRoot)?,
        ))
    }
}

pub(super) fn final_path(
    root: &ArtifactRoot,
    record: &ArtifactRecord,
) -> Result<PathBuf, DatabaseError> {
    if record.relative_path != final_name(&record.kind, record.content_hash) {
        return Err(DatabaseError::InvalidArtifactMetadata);
    }
    root.child(&record.relative_path)
}

pub(super) fn final_name(kind: &ArtifactKind, content_hash: ContentHash) -> String {
    let kind_hash = blake3::hash(kind.as_str().as_bytes());
    format!(
        "o-{}-{}",
        hex(&kind_hash.as_bytes()[..8]),
        hex(content_hash.as_bytes())
    )
}

pub(super) fn staging_name(id: ArtifactId) -> String {
    format!(".pending-{}", id.as_uuid())
}
pub(super) fn trash_name(id: ArtifactId) -> String {
    format!(".trash-{}", id.as_uuid())
}

pub(super) fn validate_file(path: &Path, record: &ArtifactRecord) -> Result<(), DatabaseError> {
    let metadata = require_regular_file(path)?;
    if metadata.len() != record.size_bytes {
        return Err(DatabaseError::ArtifactContentMismatch(record.id));
    }
    let file = OpenOptions::new().read(true).open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hasher.finalize().as_bytes() != record.content_hash.as_bytes()
        || fs::symlink_metadata(path)?.len() != record.size_bytes
    {
        return Err(DatabaseError::ArtifactContentMismatch(record.id));
    }
    Ok(())
}

pub(super) fn seal_file(path: &Path) -> Result<(), DatabaseError> {
    let metadata = require_regular_file(path)?;
    if metadata.permissions().readonly() {
        return Ok(());
    }
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;
    let mut permissions = metadata.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

fn require_regular_file(path: &Path) -> Result<fs::Metadata, DatabaseError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    Ok(metadata)
}

pub(super) fn remove_if_regular(path: &Path) -> Result<(), DatabaseError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            if metadata.permissions().readonly() {
                let mut permissions = metadata.permissions();
                #[cfg(windows)]
                {
                    // Windows exposes a read-only file attribute rather than Unix mode bits.
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    permissions.set_mode(permissions.mode() | 0o200);
                }
                fs::set_permissions(path, permissions)?;
            }
            fs::remove_file(path)?;
            Ok(())
        }
        Ok(_) => Err(DatabaseError::InvalidArtifactFile),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn remove_owned_entry(path: &Path) -> Result<(), DatabaseError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)?;
        Ok(())
    } else {
        Err(DatabaseError::InvalidArtifactFile)
    }
}
