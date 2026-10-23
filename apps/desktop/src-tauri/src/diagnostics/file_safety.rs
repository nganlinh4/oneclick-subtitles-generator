//! Path-safe log file access: no links, reparse points, hard links or redirecting ancestors.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use same_file::Handle;

use super::{LOG_FILE_NAME, MAX_FIELD_BYTES, PREVIOUS_LOG_FILE_NAME, ROTATION_BACKUP_FILE_NAME};

pub(super) fn open_log_directory(directory: &Path) -> io::Result<Handle> {
    reject_redirecting_ancestors(directory)?;
    match fs::symlink_metadata(directory) {
        Ok(metadata) => reject_unsafe_metadata(&metadata, true)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(directory)?;
        }
        Err(error) => return Err(error),
    }
    reject_redirecting_ancestors(directory)?;
    let metadata = fs::symlink_metadata(directory)?;
    reject_unsafe_metadata(&metadata, true)?;
    let handle = Handle::from_path(directory)?;
    verify_directory_path(directory, &handle)?;
    Ok(handle)
}

pub(super) fn verify_directory_path(path: &Path, expected: &Handle) -> io::Result<()> {
    reject_redirecting_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, true)?;
    let actual = Handle::from_path(path)?;
    if actual != *expected {
        return Err(unsafe_path_error());
    }
    Ok(())
}

pub(super) fn preflight_managed_paths(
    directory: &Path,
    directory_handle: &Handle,
) -> io::Result<()> {
    verify_directory_path(directory, directory_handle)?;
    for file_name in [
        LOG_FILE_NAME,
        PREVIOUS_LOG_FILE_NAME,
        ROTATION_BACKUP_FILE_NAME,
    ] {
        open_existing_file(&directory.join(file_name), FileSharing::Observation)?;
    }
    verify_directory_path(directory, directory_handle)
}

#[derive(Clone, Copy, Debug)]
pub(super) enum FileSharing {
    Observation,
    Protected,
    ProcessLock,
    Rotation,
}

pub(super) fn open_owned_file<F>(
    path: &Path,
    sharing: FileSharing,
    configure: F,
) -> io::Result<File>
where
    F: FnOnce(&mut OpenOptions),
{
    match fs::symlink_metadata(path) {
        Ok(metadata) => reject_unsafe_metadata(&metadata, false)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let mut options = OpenOptions::new();
    configure(&mut options);
    configure_file_sharing(&mut options, sharing);
    configure_no_follow(&mut options);
    let file = options.open(path)?;
    verify_open_file_path(path, &file)?;
    Ok(file)
}

pub(super) fn verify_open_file_path(path: &Path, file: &File) -> io::Result<()> {
    let opened_metadata = file.metadata()?;
    reject_unsafe_metadata(&opened_metadata, false)?;
    reject_multiple_hard_links(file, &opened_metadata)?;
    let path_metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&path_metadata, false)?;

    let opened = Handle::from_file(file.try_clone()?)?;
    let current_path = Handle::from_path(path)?;
    if opened != current_path {
        return Err(unsafe_path_error());
    }
    reject_multiple_hard_links(file, &file.metadata()?)?;
    Ok(())
}

pub(super) fn validated_existing_file(path: &Path) -> io::Result<Option<fs::Metadata>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    reject_unsafe_metadata(&metadata, false)?;
    let file = open_owned_file(path, FileSharing::Protected, |options| {
        options.read(true);
    })?;
    let opened_metadata = file.metadata()?;
    drop(file);
    Ok(Some(opened_metadata))
}

pub(super) struct ValidatedFile {
    pub(super) file: File,
    pub(super) metadata: fs::Metadata,
}

pub(super) fn open_existing_file(
    path: &Path,
    sharing: FileSharing,
) -> io::Result<Option<ValidatedFile>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    reject_unsafe_metadata(&metadata, false)?;
    let file = open_owned_file(path, sharing, |options| {
        options.read(true);
    })?;
    let metadata = file.metadata()?;
    Ok(Some(ValidatedFile { file, metadata }))
}

fn reject_unsafe_metadata(metadata: &fs::Metadata, directory: bool) -> io::Result<()> {
    if metadata.file_type().is_symlink()
        || is_reparse_point(metadata)
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
        || (!directory && metadata_has_multiple_hard_links(metadata))
    {
        Err(unsafe_path_error())
    } else {
        Ok(())
    }
}

fn reject_redirecting_ancestors(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors().filter(|path| !path.as_os_str().is_empty()) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                    return Err(unsafe_path_error());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn metadata_has_multiple_hard_links(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.nlink() != 1
}

#[cfg(not(unix))]
const fn metadata_has_multiple_hard_links(_: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn reject_multiple_hard_links(file: &File, _: &fs::Metadata) -> io::Result<()> {
    let information = winapi_util::file::information(file)?;
    if information.number_of_links() == 1 {
        Ok(())
    } else {
        Err(unsafe_path_error())
    }
}

#[cfg(unix)]
fn reject_multiple_hard_links(_: &File, metadata: &fs::Metadata) -> io::Result<()> {
    if metadata_has_multiple_hard_links(metadata) {
        Err(unsafe_path_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
const fn reject_multiple_hard_links(_: &File, _: &fs::Metadata) -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_: &fs::Metadata) -> bool {
    false
}

pub(super) fn configure_file_sharing(options: &mut OpenOptions, sharing: FileSharing) {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        let share_mode = match sharing {
            FileSharing::Observation => FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FileSharing::Protected => FILE_SHARE_READ,
            FileSharing::ProcessLock => FILE_SHARE_READ | FILE_SHARE_WRITE,
            FileSharing::Rotation => FILE_SHARE_READ | FILE_SHARE_DELETE,
        };
        options.share_mode(share_mode);
    }
    #[cfg(not(windows))]
    let _ = (options, sharing);
}

pub(super) fn configure_no_follow(options: &mut OpenOptions) {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;

        const O_NOFOLLOW: i32 = 0x0002_0000;
        options.custom_flags(O_NOFOLLOW);
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        use std::os::unix::fs::OpenOptionsExt;

        const O_NOFOLLOW: i32 = 0x0000_0100;
        options.custom_flags(O_NOFOLLOW);
    }
    #[cfg(not(any(
        windows,
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    )))]
    let _ = options;
}

pub(super) fn unsafe_path_error() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "diagnostic log path is unsafe")
}

pub(super) fn sanitize(value: &str) -> String {
    if value.is_empty()
        || value.len() > MAX_FIELD_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return "redacted".to_owned();
    }
    value.to_owned()
}
