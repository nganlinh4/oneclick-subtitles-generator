//! Crash-recoverable rotation between the current and previous log generations.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use same_file::Handle;

use super::file_safety::{
    FileSharing, configure_file_sharing, configure_no_follow, open_existing_file,
    unsafe_path_error, validated_existing_file, verify_directory_path, verify_open_file_path,
};
use super::{PREVIOUS_LOG_FILE_NAME, ROTATION_BACKUP_FILE_NAME};

pub(super) fn rotate_paths(
    directory: &Path,
    directory_handle: &Handle,
    current: &Path,
) -> io::Result<()> {
    rotate_paths_with_hook(directory, directory_handle, current, |_| Ok(()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RotationPoint {
    Validated,
    PreviousMoved,
    CurrentMoved,
    CurrentCreated,
    BeforeCommit,
}

pub(super) fn rotate_paths_with_hook<H>(
    directory: &Path,
    directory_handle: &Handle,
    current: &Path,
    mut hook: H,
) -> io::Result<()>
where
    H: FnMut(RotationPoint) -> io::Result<()>,
{
    verify_directory_path(directory, directory_handle)?;
    recover_interrupted_rotation(directory, directory_handle, current)?;

    let previous = directory.join(PREVIOUS_LOG_FILE_NAME);
    let previous_existed = validated_existing_file(&previous)?.is_some();
    if validated_existing_file(current)?.is_none() {
        return Ok(());
    }
    let backup = directory.join(ROTATION_BACKUP_FILE_NAME);
    if validated_existing_file(&backup)?.is_some() {
        return Err(unsafe_path_error());
    }
    hook(RotationPoint::Validated)?;

    let mut transaction = RotationTransaction {
        directory,
        directory_handle,
        current: current.to_path_buf(),
        previous,
        backup,
        previous_existed,
        previous_moved: false,
        current_moved: false,
        fresh_current: None,
    };

    let operation = (|| {
        if transaction.previous_existed {
            transaction.move_previous_to_backup()?;
            hook(RotationPoint::PreviousMoved)?;
        }
        transaction.move_current_to_previous()?;
        hook(RotationPoint::CurrentMoved)?;
        transaction.create_fresh_current()?;
        hook(RotationPoint::CurrentCreated)?;
        hook(RotationPoint::BeforeCommit)?;
        transaction.commit()
    })();

    match operation {
        Ok(()) => Ok(()),
        Err(error) => transaction.abort(error),
    }
}

pub(super) struct RotationTransaction<'a> {
    pub(super) directory: &'a Path,
    pub(super) directory_handle: &'a Handle,
    pub(super) current: PathBuf,
    pub(super) previous: PathBuf,
    pub(super) backup: PathBuf,
    previous_existed: bool,
    previous_moved: bool,
    current_moved: bool,
    fresh_current: Option<File>,
}

impl RotationTransaction<'_> {
    fn move_previous_to_backup(&mut self) -> io::Result<()> {
        rename_validated_file(
            self.directory,
            self.directory_handle,
            &self.previous,
            &self.backup,
            &mut self.previous_moved,
        )
    }

    fn move_current_to_previous(&mut self) -> io::Result<()> {
        rename_validated_file(
            self.directory,
            self.directory_handle,
            &self.current,
            &self.previous,
            &mut self.current_moved,
        )
    }

    fn create_fresh_current(&mut self) -> io::Result<()> {
        verify_directory_path(self.directory, self.directory_handle)?;
        match fs::symlink_metadata(&self.current) {
            Ok(_) => return Err(unsafe_path_error()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let mut options = OpenOptions::new();
        options.read(true).append(true).create_new(true);
        configure_file_sharing(&mut options, FileSharing::Rotation);
        configure_no_follow(&mut options);
        let file = options.open(&self.current)?;
        self.fresh_current = Some(file);
        let fresh = self
            .fresh_current
            .as_ref()
            .ok_or_else(|| io::Error::other("diagnostic rotation file is unavailable"))?;
        verify_open_file_path(&self.current, fresh)?;
        if fresh.metadata()?.len() != 0 {
            return Err(unsafe_path_error());
        }
        verify_directory_path(self.directory, self.directory_handle)
    }

    pub(super) fn commit(&mut self) -> io::Result<()> {
        if self.previous_moved {
            remove_validated_file(self.directory, self.directory_handle, &self.backup, false)?;
            self.previous_moved = false;
        }
        self.fresh_current = None;
        Ok(())
    }

    fn abort(&mut self, error: io::Error) -> io::Result<()> {
        match self.rollback() {
            Ok(()) => Err(error),
            Err(_) => Err(io::Error::new(
                error.kind(),
                "diagnostic rotation failed; recovery is pending",
            )),
        }
    }

    fn rollback(&mut self) -> io::Result<()> {
        if let Some(fresh) = self.fresh_current.take() {
            verify_open_file_path(&self.current, &fresh)?;
            if fresh.metadata()?.len() != 0 {
                return Err(unsafe_path_error());
            }
            verify_directory_path(self.directory, self.directory_handle)?;
            fs::remove_file(&self.current)?;
            drop(fresh);
        }

        if self.current_moved {
            let mut restored = false;
            let result = rename_validated_file(
                self.directory,
                self.directory_handle,
                &self.previous,
                &self.current,
                &mut restored,
            );
            if restored {
                self.current_moved = false;
            }
            result?;
        }

        if self.previous_moved {
            let mut restored = false;
            let result = rename_validated_file(
                self.directory,
                self.directory_handle,
                &self.backup,
                &self.previous,
                &mut restored,
            );
            if restored {
                self.previous_moved = false;
            }
            result?;
        }
        Ok(())
    }
}

pub(super) fn recover_interrupted_rotation(
    directory: &Path,
    directory_handle: &Handle,
    current: &Path,
) -> io::Result<()> {
    verify_directory_path(directory, directory_handle)?;
    let previous = directory.join(PREVIOUS_LOG_FILE_NAME);
    let backup = directory.join(ROTATION_BACKUP_FILE_NAME);
    if validated_existing_file(&backup)?.is_none() {
        return Ok(());
    }

    let current_metadata = validated_existing_file(current)?;
    let previous_metadata = validated_existing_file(&previous)?;
    if current_metadata.is_some() && previous_metadata.is_some() {
        if current_metadata
            .as_ref()
            .is_some_and(|metadata| metadata.len() != 0)
        {
            return Err(unsafe_path_error());
        }
        remove_validated_file(directory, directory_handle, current, true)?;
    }

    if validated_existing_file(current)?.is_none() && validated_existing_file(&previous)?.is_some()
    {
        let mut restored = false;
        rename_validated_file(
            directory,
            directory_handle,
            &previous,
            current,
            &mut restored,
        )?;
    }

    if validated_existing_file(&previous)?.is_none() {
        let mut restored = false;
        rename_validated_file(
            directory,
            directory_handle,
            &backup,
            &previous,
            &mut restored,
        )?;
    }

    if validated_existing_file(&backup)?.is_some() {
        return Err(unsafe_path_error());
    }
    verify_directory_path(directory, directory_handle)
}

fn rename_validated_file(
    directory: &Path,
    directory_handle: &Handle,
    source: &Path,
    destination: &Path,
    moved: &mut bool,
) -> io::Result<()> {
    verify_directory_path(directory, directory_handle)?;
    if validated_existing_file(destination)?.is_some() {
        return Err(unsafe_path_error());
    }
    let source_file = open_existing_file(source, FileSharing::Rotation)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "diagnostic log disappeared"))?;
    verify_open_file_path(source, &source_file.file)?;
    verify_directory_path(directory, directory_handle)?;
    fs::rename(source, destination)?;
    *moved = true;
    verify_directory_path(directory, directory_handle)?;
    verify_open_file_path(destination, &source_file.file)?;
    match fs::symlink_metadata(source) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(unsafe_path_error()),
        Err(error) => Err(error),
    }
}

fn remove_validated_file(
    directory: &Path,
    directory_handle: &Handle,
    path: &Path,
    require_empty: bool,
) -> io::Result<()> {
    verify_directory_path(directory, directory_handle)?;
    let file = open_existing_file(path, FileSharing::Rotation)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "diagnostic log disappeared"))?;
    if require_empty && file.metadata.len() != 0 {
        return Err(unsafe_path_error());
    }
    verify_open_file_path(path, &file.file)?;
    verify_directory_path(directory, directory_handle)?;
    fs::remove_file(path)
}
