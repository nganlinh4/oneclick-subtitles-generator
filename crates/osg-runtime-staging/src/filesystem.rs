//! Reparse-point-safe roots, exact entry removal, volume identity, and journal path encoding.

use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};

use crate::MAX_ENCODED_PATH_UNITS;
use crate::journal::{RootIdentity, invalid_journal};
use crate::kind::EntryType;
pub(crate) fn validated_root(root: &Path) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(root)?;
    reject_unsafe_metadata(&metadata, EntryType::Directory)?;
    let canonical = fs::canonicalize(root)?;
    let canonical_metadata = fs::symlink_metadata(&canonical)?;
    reject_unsafe_metadata(&canonical_metadata, EntryType::Directory)?;
    Ok(canonical)
}

pub(crate) fn validated_root_or_absent(root: &Path) -> io::Result<Option<PathBuf>> {
    match fs::symlink_metadata(root) {
        Ok(_) => validated_root(root).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn validate_live_target_root(root: &Path, expected: RootIdentity) -> io::Result<()> {
    let current = validated_root(root)?;
    if current != root || root_identity(&current)? != expected {
        return Err(io::Error::other(
            "runtime staging destination identity changed",
        ));
    }
    Ok(())
}

pub(crate) fn remove_owned_entry(path: &Path, entry_type: EntryType) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    reject_unsafe_metadata(&metadata, entry_type)?;
    match entry_type {
        EntryType::File => fs::remove_file(path),
        EntryType::Directory => remove_tree_without_reparse_points(path),
    }
}

fn remove_tree_without_reparse_points(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, EntryType::Directory)?;
    for child in fs::read_dir(path)? {
        let child = child?;
        let metadata = fs::symlink_metadata(child.path())?;
        if is_reparse_or_symlink(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runtime staging entry contains a reparse point",
            ));
        }
        if metadata.file_type().is_dir() {
            remove_tree_without_reparse_points(&child.path())?;
        } else if metadata.file_type().is_file() {
            fs::remove_file(child.path())?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runtime staging entry contains an unsupported object",
            ));
        }
    }
    fs::remove_dir(path)
}

pub(crate) fn reject_unsafe_metadata(metadata: &Metadata, expected: EntryType) -> io::Result<()> {
    let matches = match expected {
        EntryType::Directory => metadata.file_type().is_dir(),
        EntryType::File => metadata.file_type().is_file(),
    };
    if !matches || is_reparse_or_symlink(metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runtime staging entry has an unsafe type",
        ));
    }
    Ok(())
}

fn is_reparse_or_symlink(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
pub(crate) fn root_identity(path: &Path) -> io::Result<RootIdentity> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let information = winapi_util::file::information(&directory)?;
    Ok(RootIdentity {
        volume: information.volume_serial_number(),
        file: information.file_index(),
    })
}

#[cfg(not(windows))]
pub(crate) fn root_identity(path: &Path) -> io::Result<RootIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    Ok(RootIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
pub(crate) fn encode_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.is_empty() || encoded.len() > MAX_ENCODED_PATH_UNITS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "staging path is invalid",
        ));
    }
    Ok(encoded)
}

#[cfg(windows)]
pub(crate) fn decode_path(encoded: &[u16]) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    if encoded.is_empty() || encoded.len() > MAX_ENCODED_PATH_UNITS || encoded.contains(&0) {
        return Err(invalid_journal());
    }
    Ok(std::ffi::OsString::from_wide(encoded).into())
}

#[cfg(not(windows))]
pub(crate) fn encode_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ENCODED_PATH_UNITS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "staging path is invalid",
        ));
    }
    Ok(bytes.iter().map(|byte| u16::from(*byte)).collect())
}

#[cfg(not(windows))]
pub(crate) fn decode_path(encoded: &[u16]) -> io::Result<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    if encoded.is_empty()
        || encoded.len() > MAX_ENCODED_PATH_UNITS
        || encoded
            .iter()
            .any(|unit| *unit == 0 || *unit > u16::from(u8::MAX))
    {
        return Err(invalid_journal());
    }
    let bytes = encoded
        .iter()
        .map(|unit| u8::try_from(*unit).map_err(|_| invalid_journal()))
        .collect::<io::Result<Vec<_>>>()?;
    Ok(std::ffi::OsString::from_vec(bytes).into())
}

#[cfg(windows)]
pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let result = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?
        .sync_all();
    match result {
        Ok(()) => Ok(()),
        // Windows accepts the directory handle but commonly rejects FlushFileBuffers for it.
        // Every journal file itself is flushed before its hard link becomes visible; the returned
        // hard-link/create/remove calls are the process-crash boundary this crate promises.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::PermissionDenied
                    | io::ErrorKind::InvalidInput
                    | io::ErrorKind::Unsupported
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(windows))]
pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}
