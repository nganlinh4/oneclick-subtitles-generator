//! Live staging guards: a journal-owned directory or same-directory publication file.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(test)]
use fs2::FileExt;

use crate::authority::RuntimeStagingAuthority;
use crate::filesystem::{
    remove_owned_entry, root_identity, sync_directory, validate_live_target_root, validated_root,
};
use crate::journal::RootIdentity;
use crate::kind::{EntryType, StagingKind};
use crate::locks::release_and_remove_journal;
/// A large directory whose central ownership journal is durable before the directory is created.
pub struct OwnedStagingDirectory {
    authority: RuntimeStagingAuthority,
    target_root: PathBuf,
    target_identity: RootIdentity,
    path: PathBuf,
    journal_path: PathBuf,
    journal: Option<File>,
}

impl OwnedStagingDirectory {
    pub fn begin(
        authority: &RuntimeStagingAuthority,
        root: &Path,
        kind: StagingKind,
    ) -> io::Result<Self> {
        if kind.entry_type() != EntryType::Directory {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "file staging kind used for a directory",
            ));
        }
        authority.reconcile_all()?;
        let root = validated_root(root)?;
        let (record, journal_path, journal) = authority.create_journal(&root, kind)?;
        if root_identity(&root)? != record.target_identity {
            release_and_remove_journal(journal, &journal_path, &authority.inner.root);
            return Err(io::Error::other(
                "runtime staging destination changed during admission",
            ));
        }
        let path = root.join(&record.entry_name);
        if let Err(error) = fs::create_dir(&path) {
            release_and_remove_journal(journal, &journal_path, &authority.inner.root);
            return Err(error);
        }
        sync_directory(&root)?;
        Ok(Self {
            authority: authority.clone(),
            target_root: root,
            target_identity: record.target_identity,
            path,
            journal_path,
            journal: Some(journal),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Removes the staged tree now and reports any safety or filesystem refusal to the caller.
    pub fn remove(mut self) -> io::Result<()> {
        self.cleanup()
    }

    #[cfg(test)]
    pub(crate) fn abandon_as_if_process_terminated(mut self) {
        if let Some(journal) = self.journal.take() {
            let _ = FileExt::unlock(&journal);
            drop(journal);
        }
        std::mem::forget(self);
    }

    fn cleanup(&mut self) -> io::Result<()> {
        if self.journal.is_none() {
            return Ok(());
        }
        validate_live_target_root(&self.target_root, self.target_identity)?;
        remove_owned_entry(&self.path, EntryType::Directory)?;
        let journal = self.journal.take().expect("journal checked above");
        release_and_remove_journal(journal, &self.journal_path, &self.authority.inner.root);
        Ok(())
    }
}

impl Drop for OwnedStagingDirectory {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

impl std::fmt::Debug for OwnedStagingDirectory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OwnedStagingDirectory")
            .field("path", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// A same-directory publication file owned by a central private journal.
pub struct OwnedStagingFile {
    authority: RuntimeStagingAuthority,
    target_root: PathBuf,
    target_identity: RootIdentity,
    path: PathBuf,
    journal_path: PathBuf,
    journal: Option<File>,
    file: Option<File>,
}

impl OwnedStagingFile {
    pub fn begin(
        authority: &RuntimeStagingAuthority,
        root: &Path,
        kind: StagingKind,
    ) -> io::Result<Self> {
        if kind.entry_type() != EntryType::File {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory staging kind used for a file",
            ));
        }
        authority.reconcile_all()?;
        let root = validated_root(root)?;
        let (record, journal_path, journal) = authority.create_journal(&root, kind)?;
        if root_identity(&root)? != record.target_identity {
            release_and_remove_journal(journal, &journal_path, &authority.inner.root);
            return Err(io::Error::other(
                "runtime staging destination changed during admission",
            ));
        }
        let path = root.join(&record.entry_name);
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) => {
                release_and_remove_journal(journal, &journal_path, &authority.inner.root);
                return Err(error);
            }
        };
        sync_directory(&root)?;
        Ok(Self {
            authority: authority.clone(),
            target_root: root,
            target_identity: record.target_identity,
            path,
            journal_path,
            journal: Some(journal),
            file: Some(file),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn file_mut(&mut self) -> io::Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("runtime staging file is closed"))
    }

    pub fn sync_all(&mut self) -> io::Result<()> {
        self.file_mut()?.sync_all()
    }

    pub fn replace_atomic(mut self, destination: &Path) -> io::Result<()> {
        validate_live_target_root(&self.target_root, self.target_identity)?;
        let destination_root = destination.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "staging publication destination has no parent",
            )
        })?;
        if validated_root(destination_root)? != self.target_root {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "staging publication must remain in its admitted directory",
            ));
        }
        self.sync_all()?;
        drop(self.file.take());
        atomicwrites::replace_atomic(&self.path, destination)
            .map_err(|_| io::Error::other("atomic staging publication failed"))?;
        let journal = self
            .journal
            .take()
            .expect("live staging file has a journal");
        release_and_remove_journal(journal, &self.journal_path, &self.authority.inner.root);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn abandon_as_if_process_terminated(mut self) {
        drop(self.file.take());
        if let Some(journal) = self.journal.take() {
            let _ = FileExt::unlock(&journal);
            drop(journal);
        }
        std::mem::forget(self);
    }

    fn cleanup(&mut self) -> io::Result<()> {
        if self.journal.is_none() {
            return Ok(());
        }
        drop(self.file.take());
        validate_live_target_root(&self.target_root, self.target_identity)?;
        remove_owned_entry(&self.path, EntryType::File)?;
        let journal = self.journal.take().expect("journal checked above");
        release_and_remove_journal(journal, &self.journal_path, &self.authority.inner.root);
        Ok(())
    }
}

impl Drop for OwnedStagingFile {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

impl std::fmt::Debug for OwnedStagingFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OwnedStagingFile")
            .field("path", &"<redacted>")
            .finish_non_exhaustive()
    }
}
