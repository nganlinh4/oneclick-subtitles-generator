//! The private deletion authority: its secret, journal publication, and startup reconciliation.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fs2::FileExt;
use uuid::Uuid;

use crate::filesystem::{
    decode_path, reject_unsafe_metadata, remove_owned_entry, root_identity, sync_directory,
    validated_root, validated_root_or_absent,
};
use crate::journal::{OwnershipJournal, invalid_journal};
use crate::kind::{EntryType, StagingKind};
use crate::locks::{
    is_exact_write_sidecar, is_lock_contended, lock_metadata, release_and_remove_journal_locked,
    remove_unlocked_sidecar,
};
use crate::{
    AUTHORITY_BYTES, AUTHORITY_FILE, AUTHORITY_MAGIC, AUTHORITY_TEMP_PREFIX, JOURNAL_PREFIX,
    JOURNAL_TEMP_PREFIX, MAX_JOURNAL_BYTES,
};
pub(crate) struct AuthorityInner {
    pub(crate) root: PathBuf,
    pub(crate) secret: [u8; 32],
}

/// Private deletion authority shared by every runtime that may create a large temporary entry.
#[derive(Clone)]
pub struct RuntimeStagingAuthority {
    pub(crate) inner: Arc<AuthorityInner>,
}

/// Bounded reconciliation telemetry. No path, filename, or journal contents are exposed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Exact authenticated entries reclaimed after their owning process ended.
    pub reclaimed: usize,
    /// Authenticated journals retained because their destination root is absent or was replaced.
    pub deferred: usize,
    /// Entries left alone because a live process still holds their journal lock.
    pub active: usize,
}

impl RuntimeStagingAuthority {
    /// Opens or creates the private authority and reconciles every stale journal at startup.
    pub fn prepare(root: &Path) -> io::Result<Self> {
        Self::prepare_with_report(root).map(|(authority, _)| authority)
    }

    /// Opens the authority and returns path-free startup reconciliation telemetry.
    pub fn prepare_with_report(root: &Path) -> io::Result<(Self, ReconcileReport)> {
        fs::create_dir_all(root)?;
        let root = validated_root(root)?;
        let metadata_lock = lock_metadata(&root)?;
        recover_authority_writes(&root)?;
        let secret = load_or_create_authority(&root)?;
        let authority = Self {
            inner: Arc::new(AuthorityInner { root, secret }),
        };
        drop(metadata_lock);
        let report = authority.reconcile_all()?;
        Ok((authority, report))
    }

    /// Reclaims every stale exact entry, including exports in directories that are not revisited.
    pub fn reconcile_all(&self) -> io::Result<ReconcileReport> {
        let _metadata_lock = lock_metadata(&self.inner.root)?;
        let mut report = ReconcileReport::default();
        self.recover_journal_writes()?;
        for entry in fs::read_dir(&self.inner.root)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid_journal())?;
            if !name.starts_with(JOURNAL_PREFIX) || name.starts_with(JOURNAL_TEMP_PREFIX) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            reject_unsafe_metadata(&metadata, EntryType::File)?;
            if metadata.len() > MAX_JOURNAL_BYTES {
                return Err(invalid_journal());
            }
            let mut journal = OpenOptions::new()
                .read(true)
                .write(true)
                .open(entry.path())?;
            match journal.try_lock_exclusive() {
                Ok(()) => {}
                Err(error) if is_lock_contended(&error) => {
                    report.active = report.active.saturating_add(1);
                    continue;
                }
                Err(error) => return Err(error),
            }
            let capacity = usize::try_from(metadata.len()).map_err(|_| invalid_journal())?;
            let mut encoded = Vec::with_capacity(capacity);
            journal.read_to_end(&mut encoded)?;
            let record: OwnershipJournal =
                serde_json::from_slice(&encoded).map_err(|_| invalid_journal())?;
            record.validate(self, &name)?;
            let target_root = decode_path(&record.target_root)?;
            let target_root = validated_root_or_absent(&target_root)?;
            let Some(target_root) = target_root else {
                // A removable/offline volume may return later. Keep the authenticated journal so
                // that future startup reconciliation still has deletion authority.
                let _ = FileExt::unlock(&journal);
                drop(journal);
                report.deferred = report.deferred.saturating_add(1);
                continue;
            };
            if root_identity(&target_root)? != record.target_identity {
                // The spelling now names a different directory. Preserve both it and the journal;
                // deleting either would discard the only evidence needed if the original volume
                // is mounted again under its former path.
                let _ = FileExt::unlock(&journal);
                drop(journal);
                report.deferred = report.deferred.saturating_add(1);
                continue;
            }
            remove_owned_entry(&target_root.join(&record.entry_name), record.entry_type)?;
            release_and_remove_journal_locked(journal, &entry.path(), &self.inner.root);
            report.reclaimed = report.reclaimed.saturating_add(1);
        }
        Ok(report)
    }

    pub(crate) fn create_journal(
        &self,
        target_root: &Path,
        kind: StagingKind,
    ) -> io::Result<(OwnershipJournal, PathBuf, File)> {
        let _metadata_lock = lock_metadata(&self.inner.root)?;
        for _ in 0..16 {
            let nonce = Uuid::new_v4().simple().to_string();
            let record = OwnershipJournal::new(self, kind, nonce.clone(), target_root)?;
            let journal_path = self.inner.root.join(kind.journal_name(&nonce));
            let temporary_path = self
                .inner
                .root
                .join(format!("{JOURNAL_TEMP_PREFIX}{nonce}.tmp"));
            let mut temporary = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            };
            // Lock the inode before its final name becomes visible. The hard link below refers to
            // this same locked inode, so another process can never observe an unlocked deletion
            // authority between publication and the caller receiving the live guard.
            temporary.lock_exclusive()?;
            let encoded = serde_json::to_vec(&record)
                .map_err(|_| io::Error::other("runtime staging journal could not be encoded"))?;
            temporary.write_all(&encoded)?;
            temporary.sync_all()?;
            match fs::hard_link(&temporary_path, &journal_path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let _ = FileExt::unlock(&temporary);
                    drop(temporary);
                    let _ = fs::remove_file(&temporary_path);
                    continue;
                }
                Err(error) => {
                    let _ = FileExt::unlock(&temporary);
                    drop(temporary);
                    let _ = fs::remove_file(&temporary_path);
                    return Err(error);
                }
            }
            fs::remove_file(&temporary_path)?;
            sync_directory(&self.inner.root)?;
            return Ok((record, journal_path, temporary));
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "runtime staging nonce collisions exceeded the bound",
        ))
    }

    fn recover_journal_writes(&self) -> io::Result<()> {
        let mut removed_any = false;
        for entry in fs::read_dir(&self.inner.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !is_exact_write_sidecar(name, JOURNAL_TEMP_PREFIX) {
                continue;
            }
            // The large entry is created only after the complete journal is hard-linked to its
            // final name. An *unlocked* write-sidecar therefore never authorizes an external
            // deletion. A locked one belongs to a concurrent begin and must remain untouched.
            removed_any |= remove_unlocked_sidecar(&entry.path())?;
        }
        if removed_any {
            sync_directory(&self.inner.root)?;
        }
        Ok(())
    }
}

impl std::fmt::Debug for RuntimeStagingAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeStagingAuthority")
            .field("root", &"<redacted>")
            .finish_non_exhaustive()
    }
}

fn load_or_create_authority(root: &Path) -> io::Result<[u8; 32]> {
    let authority_path = root.join(AUTHORITY_FILE);
    if !authority_path.exists() {
        let nonce = Uuid::new_v4().simple().to_string();
        let temporary_path = root.join(format!("{AUTHORITY_TEMP_PREFIX}{nonce}.tmp"));
        let mut secret = [0_u8; 32];
        secret[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        secret[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        temporary.lock_exclusive()?;
        temporary.write_all(AUTHORITY_MAGIC)?;
        temporary.write_all(&secret)?;
        temporary.sync_all()?;
        match fs::hard_link(&temporary_path, &authority_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                let _ = FileExt::unlock(&temporary);
                drop(temporary);
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
        }
        let _ = FileExt::unlock(&temporary);
        drop(temporary);
        let _ = fs::remove_file(temporary_path);
        sync_directory(root)?;
    }
    let metadata = fs::symlink_metadata(&authority_path)?;
    reject_unsafe_metadata(&metadata, EntryType::File)?;
    if metadata.len() != AUTHORITY_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runtime staging authority is invalid",
        ));
    }
    let bytes = fs::read(authority_path)?;
    if bytes.get(..AUTHORITY_MAGIC.len()) != Some(AUTHORITY_MAGIC) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runtime staging authority is invalid",
        ));
    }
    let mut secret = [0_u8; 32];
    secret.copy_from_slice(&bytes[AUTHORITY_MAGIC.len()..]);
    Ok(secret)
}

fn recover_authority_writes(root: &Path) -> io::Result<()> {
    let mut removed_any = false;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_exact_write_sidecar(&name, AUTHORITY_TEMP_PREFIX) {
            continue;
        }
        // No journal can exist before the final authority is published. This sidecar therefore
        // carries no deletion power once unlocked. A locked file belongs to another concurrent
        // authority opener and must remain untouched until that opener publishes or retires it.
        removed_any |= remove_unlocked_sidecar(&entry.path())?;
    }
    if removed_any {
        sync_directory(root)?;
    }
    Ok(())
}
