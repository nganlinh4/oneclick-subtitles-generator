//! Crash-recoverable ownership for large runtime staging entries.
//!
//! `tempfile` cleans up only when Rust gets to unwind. A killed desktop process therefore used to
//! strand downloads, renders, multi-gigabyte speech jobs and customer export `.part` files. The
//! authority below lives in OSG's private cache. It publishes and locks a durable central journal
//! *before* creating the large entry, even when that entry is in a user-selected directory. A
//! later process reclaims only an unlocked journal authenticated by the private authority secret;
//! adjacent filenames and public JSON shapes are never deletion authority.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const AUTHORITY_FILE: &str = ".osg-runtime-authority-v1.bin";
const METADATA_LOCK_FILE: &str = ".osg-runtime-metadata.lock";
const AUTHORITY_MAGIC: &[u8; 8] = b"OSGRTA01";
const AUTHORITY_BYTES: usize = AUTHORITY_MAGIC.len() + 32;
const AUTHORITY_TEMP_PREFIX: &str = ".osg-runtime-authority-write-";
const JOURNAL_TEMP_PREFIX: &str = ".osg-runtime-journal-write-";
const JOURNAL_PREFIX: &str = ".osg-runtime-journal-";
const JOURNAL_SCHEMA_VERSION: u32 = 1;
const JOURNAL_OWNER: &str = "one-click-subtitles-generator";
const MAX_JOURNAL_BYTES: u64 = 256 * 1024;
const MAX_ENCODED_PATH_UNITS: usize = 32_768;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StagingKind {
    Download,
    Render,
    SpeechJob,
    SpeechWorkerCache,
    AsrJob,
    AsrWorkerCache,
    MediaExport,
    NativeToolDownload,
    NativeToolExtraction,
    NativeToolQuarantine,
    EnginePackageInstall,
    EnginePackageAdoption,
    EnginePackageQuarantine,
    MediaBlobSession,
    MediaPipelineJob,
}

impl StagingKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Render => "render",
            Self::SpeechJob => "speech-job",
            Self::SpeechWorkerCache => "speech-worker-cache",
            Self::AsrJob => "asr-job",
            Self::AsrWorkerCache => "asr-worker-cache",
            Self::MediaExport => "media-export",
            Self::NativeToolDownload => "native-tool-download",
            Self::NativeToolExtraction => "native-tool-extraction",
            Self::NativeToolQuarantine => "native-tool-quarantine",
            Self::EnginePackageInstall => "engine-package-install",
            Self::EnginePackageAdoption => "engine-package-adoption",
            Self::EnginePackageQuarantine => "engine-package-quarantine",
            Self::MediaBlobSession => "media-blob-session",
            Self::MediaPipelineJob => "media-pipeline-job",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "download" => Some(Self::Download),
            "render" => Some(Self::Render),
            "speech-job" => Some(Self::SpeechJob),
            "speech-worker-cache" => Some(Self::SpeechWorkerCache),
            "asr-job" => Some(Self::AsrJob),
            "asr-worker-cache" => Some(Self::AsrWorkerCache),
            "media-export" => Some(Self::MediaExport),
            "native-tool-download" => Some(Self::NativeToolDownload),
            "native-tool-extraction" => Some(Self::NativeToolExtraction),
            "native-tool-quarantine" => Some(Self::NativeToolQuarantine),
            "engine-package-install" => Some(Self::EnginePackageInstall),
            "engine-package-adoption" => Some(Self::EnginePackageAdoption),
            "engine-package-quarantine" => Some(Self::EnginePackageQuarantine),
            "media-blob-session" => Some(Self::MediaBlobSession),
            "media-pipeline-job" => Some(Self::MediaPipelineJob),
            _ => None,
        }
    }

    const fn entry_type(self) -> EntryType {
        match self {
            Self::Download
            | Self::Render
            | Self::SpeechJob
            | Self::SpeechWorkerCache
            | Self::AsrJob
            | Self::AsrWorkerCache
            | Self::NativeToolDownload
            | Self::NativeToolExtraction
            | Self::NativeToolQuarantine
            | Self::EnginePackageInstall
            | Self::EnginePackageAdoption
            | Self::EnginePackageQuarantine
            | Self::MediaBlobSession
            | Self::MediaPipelineJob => EntryType::Directory,
            Self::MediaExport => EntryType::File,
        }
    }

    fn entry_name(self, nonce: &str) -> String {
        match self {
            Self::Download => format!(".osg-download-attempt-{nonce}"),
            Self::Render => format!(".osg-render-{nonce}"),
            Self::SpeechJob => format!(".osg-speech-job-{nonce}"),
            Self::SpeechWorkerCache => format!(".osg-speech-worker-cache-{nonce}"),
            Self::AsrJob => format!(".osg-asr-job-{nonce}"),
            Self::AsrWorkerCache => format!(".osg-asr-worker-cache-{nonce}"),
            Self::MediaExport => format!(".osg-export-{nonce}.part"),
            Self::NativeToolDownload => format!(".osg-native-tool-download-{nonce}"),
            Self::NativeToolExtraction => format!(".osg-native-tool-extraction-{nonce}"),
            Self::NativeToolQuarantine => format!(".osg-native-tool-quarantine-{nonce}"),
            Self::EnginePackageInstall => format!(".osg-engine-package-install-{nonce}"),
            Self::EnginePackageAdoption => format!(".osg-engine-package-adoption-{nonce}"),
            Self::EnginePackageQuarantine => format!(".osg-engine-package-quarantine-{nonce}"),
            Self::MediaBlobSession => format!("session-{nonce}"),
            Self::MediaPipelineJob => format!(".osg-media-pipeline-job-{nonce}"),
        }
    }

    fn journal_name(self, nonce: &str) -> String {
        format!("{JOURNAL_PREFIX}{}-{nonce}.json", self.label())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum EntryType {
    Directory,
    File,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootIdentity {
    volume: u64,
    file: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipJournal {
    schema_version: u32,
    owner: String,
    kind: String,
    nonce: String,
    entry_type: EntryType,
    entry_name: String,
    target_root: Vec<u16>,
    target_identity: RootIdentity,
    authority_tag: String,
}

impl OwnershipJournal {
    fn new(
        authority: &RuntimeStagingAuthority,
        kind: StagingKind,
        nonce: String,
        target_root: &Path,
    ) -> io::Result<Self> {
        let target_identity = root_identity(target_root)?;
        let target_root = encode_path(target_root)?;
        let mut record = Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            owner: JOURNAL_OWNER.to_owned(),
            kind: kind.label().to_owned(),
            entry_type: kind.entry_type(),
            entry_name: kind.entry_name(&nonce),
            target_root,
            target_identity,
            authority_tag: String::new(),
            nonce,
        };
        record.authority_tag = record.expected_tag(&authority.inner.secret);
        Ok(record)
    }

    fn validate(
        &self,
        authority: &RuntimeStagingAuthority,
        journal_name: &str,
    ) -> io::Result<StagingKind> {
        let kind = StagingKind::parse(&self.kind).ok_or_else(invalid_journal)?;
        let valid_nonce = self.nonce.len() == 32
            && self
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
        if self.schema_version != JOURNAL_SCHEMA_VERSION
            || self.owner != JOURNAL_OWNER
            || self.entry_type != kind.entry_type()
            || !valid_nonce
            || self.entry_name != kind.entry_name(&self.nonce)
            || journal_name != kind.journal_name(&self.nonce)
            || self.target_root.is_empty()
            || self.target_root.len() > MAX_ENCODED_PATH_UNITS
            || self.authority_tag != self.expected_tag(&authority.inner.secret)
        {
            return Err(invalid_journal());
        }
        Ok(kind)
    }

    fn expected_tag(&self, secret: &[u8; 32]) -> String {
        let mut bytes = Vec::with_capacity(256 + self.target_root.len() * 2);
        bytes.extend_from_slice(&self.schema_version.to_le_bytes());
        for value in [
            self.owner.as_bytes(),
            self.kind.as_bytes(),
            self.nonce.as_bytes(),
            self.entry_name.as_bytes(),
        ] {
            bytes.extend_from_slice(&(value.len() as u64).to_le_bytes());
            bytes.extend_from_slice(value);
        }
        bytes.push(match self.entry_type {
            EntryType::Directory => 1,
            EntryType::File => 2,
        });
        bytes.extend_from_slice(&(self.target_root.len() as u64).to_le_bytes());
        for unit in &self.target_root {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&self.target_identity.volume.to_le_bytes());
        bytes.extend_from_slice(&self.target_identity.file.to_le_bytes());
        blake3::keyed_hash(secret, &bytes).to_hex().to_string()
    }
}

struct AuthorityInner {
    root: PathBuf,
    secret: [u8; 32],
}

/// Private deletion authority shared by every runtime that may create a large temporary entry.
#[derive(Clone)]
pub struct RuntimeStagingAuthority {
    inner: Arc<AuthorityInner>,
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

    fn create_journal(
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
    fn abandon_as_if_process_terminated(mut self) {
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
    fn abandon_as_if_process_terminated(mut self) {
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

/// Serializes publication/reconciliation across independent authority handles and processes.
/// Per-entry journal locks still protect live payloads. This guard is never held while downloading,
/// decoding, rendering or otherwise using a staged payload.
struct MetadataLock(File);

impl Drop for MetadataLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock_metadata(root: &Path) -> io::Result<MetadataLock> {
    let path = root.join(METADATA_LOCK_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => reject_unsafe_metadata(&metadata, EntryType::File)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    reject_unsafe_metadata(&fs::symlink_metadata(&path)?, EntryType::File)?;
    file.lock_exclusive()?;
    Ok(MetadataLock(file))
}

fn release_and_remove_journal(journal: File, path: &Path, authority_root: &Path) {
    // If metadata cannot be locked, keep the authenticated journal for recovery rather than race
    // another scanner. Dropping the file releases its live-owner lock without deleting authority.
    let Ok(_metadata_lock) = lock_metadata(authority_root) else {
        return;
    };
    release_and_remove_journal_locked(journal, path, authority_root);
}

fn release_and_remove_journal_locked(journal: File, path: &Path, authority_root: &Path) {
    let _ = FileExt::unlock(&journal);
    drop(journal);
    let _ = fs::remove_file(path);
    let _ = sync_directory(authority_root);
}

fn is_exact_write_sidecar(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|tail| tail.strip_suffix(".tmp"))
        .is_some_and(|nonce| {
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

fn remove_unlocked_sidecar(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    reject_unsafe_metadata(&metadata, EntryType::File)?;
    let sidecar = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match sidecar.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if is_lock_contended(&error) => return Ok(false),
        Err(error) => return Err(error),
    }
    match fs::remove_file(path) {
        Ok(()) => {
            let _ = FileExt::unlock(&sidecar);
            drop(sidecar);
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let _ = FileExt::unlock(&sidecar);
            drop(sidecar);
            Ok(false)
        }
        Err(error) => {
            let _ = FileExt::unlock(&sidecar);
            drop(sidecar);
            Err(error)
        }
    }
}

fn is_lock_contended(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // `fs2` reports Win32 sharing/lock violations without remapping them to WouldBlock.
        matches!(error.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn validated_root(root: &Path) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(root)?;
    reject_unsafe_metadata(&metadata, EntryType::Directory)?;
    let canonical = fs::canonicalize(root)?;
    let canonical_metadata = fs::symlink_metadata(&canonical)?;
    reject_unsafe_metadata(&canonical_metadata, EntryType::Directory)?;
    Ok(canonical)
}

fn validated_root_or_absent(root: &Path) -> io::Result<Option<PathBuf>> {
    match fs::symlink_metadata(root) {
        Ok(_) => validated_root(root).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn validate_live_target_root(root: &Path, expected: RootIdentity) -> io::Result<()> {
    let current = validated_root(root)?;
    if current != root || root_identity(&current)? != expected {
        return Err(io::Error::other(
            "runtime staging destination identity changed",
        ));
    }
    Ok(())
}

fn remove_owned_entry(path: &Path, entry_type: EntryType) -> io::Result<()> {
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

fn reject_unsafe_metadata(metadata: &Metadata, expected: EntryType) -> io::Result<()> {
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
fn root_identity(path: &Path) -> io::Result<RootIdentity> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let directory = OpenOptions::new()
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
fn root_identity(path: &Path) -> io::Result<RootIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    Ok(RootIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn encode_path(path: &Path) -> io::Result<Vec<u16>> {
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
fn decode_path(encoded: &[u16]) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    if encoded.is_empty() || encoded.len() > MAX_ENCODED_PATH_UNITS || encoded.contains(&0) {
        return Err(invalid_journal());
    }
    Ok(std::ffi::OsString::from_wide(encoded).into())
}

#[cfg(not(windows))]
fn encode_path(path: &Path) -> io::Result<Vec<u16>> {
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
fn decode_path(encoded: &[u16]) -> io::Result<PathBuf> {
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
fn sync_directory(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let result = OpenOptions::new()
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
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn invalid_journal() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "runtime staging journal is invalid",
    )
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    const CRASH_AUTHORITY_ROOT: &str = "OSG_RUNTIME_STAGING_TEST_AUTHORITY";
    const CRASH_TARGET_ROOT: &str = "OSG_RUNTIME_STAGING_TEST_TARGET";
    const CRASH_READY_FILE: &str = "OSG_RUNTIME_STAGING_TEST_READY";

    fn fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        RuntimeStagingAuthority,
    ) {
        let authority_root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let authority = RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();
        (authority_root, target_root, authority)
    }

    #[test]
    fn stale_directory_is_reclaimed_but_unjournaled_lookalike_is_not() {
        let (_authority_root, target, authority) = fixture();
        let owned =
            OwnedStagingDirectory::begin(&authority, target.path(), StagingKind::Render).unwrap();
        let owned_path = owned.path().to_owned();
        fs::write(owned.path().join("large.bin"), b"render").unwrap();
        owned.abandon_as_if_process_terminated();
        let lookalike = target.path().join(".osg-render-not-owned");
        fs::create_dir(&lookalike).unwrap();

        authority.reconcile_all().unwrap();

        assert!(!owned_path.exists());
        assert!(lookalike.is_dir());
    }

    #[test]
    fn every_large_runtime_cache_kind_is_reclaimed_only_from_its_authenticated_journal() {
        let (_authority_root, target, authority) = fixture();
        let kinds = [
            StagingKind::SpeechWorkerCache,
            StagingKind::AsrWorkerCache,
            StagingKind::NativeToolDownload,
            StagingKind::NativeToolExtraction,
            StagingKind::NativeToolQuarantine,
            StagingKind::EnginePackageInstall,
            StagingKind::EnginePackageAdoption,
            StagingKind::EnginePackageQuarantine,
            StagingKind::MediaBlobSession,
            StagingKind::MediaPipelineJob,
        ];
        let mut owned_paths = Vec::new();
        for kind in kinds {
            let owned = OwnedStagingDirectory::begin(&authority, target.path(), kind).unwrap();
            fs::write(owned.path().join("large.bin"), vec![0_u8; 4096]).unwrap();
            owned_paths.push(owned.path().to_owned());
            owned.abandon_as_if_process_terminated();
        }
        let foreign = target.path().join("session-not-owned");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("recording.wav"), b"customer").unwrap();

        authority.reconcile_all().unwrap();

        assert!(owned_paths.iter().all(|path| !path.exists()));
        assert_eq!(
            fs::read(foreign.join("recording.wav")).unwrap(),
            b"customer"
        );
    }

    #[test]
    #[ignore = "subprocess helper; the parent test terminates it after its live journal is locked"]
    fn hard_crash_staging_child() {
        let (Ok(authority_root), Ok(target_root), Ok(ready_file)) = (
            std::env::var(CRASH_AUTHORITY_ROOT),
            std::env::var(CRASH_TARGET_ROOT),
            std::env::var(CRASH_READY_FILE),
        ) else {
            return;
        };
        let authority = RuntimeStagingAuthority::prepare(Path::new(&authority_root)).unwrap();
        let owned = OwnedStagingDirectory::begin(
            &authority,
            Path::new(&target_root),
            StagingKind::MediaBlobSession,
        )
        .unwrap();
        fs::write(owned.path().join("recording.wav"), vec![0_u8; 1024 * 1024]).unwrap();
        fs::write(ready_file, b"ready").unwrap();
        loop {
            thread::sleep(Duration::from_mins(1));
        }
    }

    #[test]
    fn killed_process_session_is_reclaimed_on_the_next_startup() {
        let authority_root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let handoff = tempfile::NamedTempFile::new().unwrap();
        let ready_path = handoff.path().to_owned();
        drop(handoff);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::hard_crash_staging_child",
                "--ignored",
                "--nocapture",
            ])
            .env(CRASH_AUTHORITY_ROOT, authority_root.path())
            .env(CRASH_TARGET_ROOT, target_root.path())
            .env(CRASH_READY_FILE, &ready_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !ready_path.exists() && Instant::now() < deadline {
            assert!(
                child.try_wait().unwrap().is_none(),
                "staging child exited early"
            );
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            ready_path.exists(),
            "staging child never published readiness"
        );
        let owned_paths = fs::read_dir(target_root.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(owned_paths.len(), 1);
        let owned_path = owned_paths[0].clone();
        assert!(owned_path.is_dir());
        child.kill().unwrap();
        let _ = child.wait().unwrap();

        RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();

        assert!(!owned_path.exists());
    }

    #[test]
    fn live_journal_prevents_reclamation() {
        let (_authority_root, target, authority) = fixture();
        let owned =
            OwnedStagingDirectory::begin(&authority, target.path(), StagingKind::Download).unwrap();
        let path = owned.path().to_owned();

        let report = authority.reconcile_all().unwrap();
        assert_eq!(report.active, 1);
        assert_eq!(report.deferred, 0);
        assert_eq!(report.reclaimed, 0);
        assert!(path.is_dir());
        drop(owned);
        assert!(!path.exists());
    }

    #[test]
    fn absent_destination_keeps_authority_until_the_same_directory_returns() {
        let (authority_root, target, authority) = fixture();
        let original_root = target.path().to_owned();
        let offline_root = authority_root.path().join("offline-destination");
        let owned = OwnedStagingDirectory::begin(&authority, &original_root, StagingKind::Download)
            .unwrap();
        let entry_name = owned.path().file_name().unwrap().to_owned();
        fs::write(owned.path().join("large.bin"), b"download").unwrap();
        owned.abandon_as_if_process_terminated();
        fs::rename(&original_root, &offline_root).unwrap();

        let deferred = authority.reconcile_all().unwrap();

        assert_eq!(deferred.deferred, 1);
        assert!(offline_root.join(&entry_name).is_dir());
        fs::rename(&offline_root, &original_root).unwrap();

        let reclaimed = authority.reconcile_all().unwrap();
        assert_eq!(reclaimed.reclaimed, 1);
        assert!(!original_root.join(entry_name).exists());
    }

    #[test]
    fn replacement_directory_at_same_spelling_cannot_receive_stale_deletion() {
        let (authority_root, target, authority) = fixture();
        let original_root = target.path().to_owned();
        let offline_root = authority_root.path().join("original-destination");
        let replacement_parking = authority_root.path().join("replacement-destination");
        let owned =
            OwnedStagingDirectory::begin(&authority, &original_root, StagingKind::Render).unwrap();
        let entry_name = owned.path().file_name().unwrap().to_owned();
        fs::write(owned.path().join("old.bin"), b"owned").unwrap();
        owned.abandon_as_if_process_terminated();
        fs::rename(&original_root, &offline_root).unwrap();
        fs::create_dir(&original_root).unwrap();
        let foreign = original_root.join(&entry_name);
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("customer.bin"), b"keep").unwrap();

        let report = authority.reconcile_all().unwrap();

        assert_eq!(report.deferred, 1);
        assert_eq!(fs::read(foreign.join("customer.bin")).unwrap(), b"keep");
        fs::rename(&original_root, &replacement_parking).unwrap();
        fs::rename(&offline_root, &original_root).unwrap();
        let report = authority.reconcile_all().unwrap();
        assert_eq!(report.reclaimed, 1);
        assert!(!original_root.join(entry_name).exists());
        fs::remove_dir_all(replacement_parking).unwrap();
    }

    #[test]
    fn live_guard_cannot_delete_from_a_replacement_directory() {
        let (authority_root, target, authority) = fixture();
        let original_root = target.path().to_owned();
        let offline_root = authority_root.path().join("live-original-destination");
        let replacement_parking = authority_root.path().join("live-replacement-destination");
        let owned =
            OwnedStagingDirectory::begin(&authority, &original_root, StagingKind::Render).unwrap();
        let entry_name = owned.path().file_name().unwrap().to_owned();
        fs::rename(&original_root, &offline_root).unwrap();
        fs::create_dir(&original_root).unwrap();
        let foreign = original_root.join(&entry_name);
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("customer.bin"), b"keep").unwrap();

        drop(owned);

        assert_eq!(fs::read(foreign.join("customer.bin")).unwrap(), b"keep");
        fs::rename(&original_root, &replacement_parking).unwrap();
        fs::rename(&offline_root, &original_root).unwrap();
        authority.reconcile_all().unwrap();
        fs::remove_dir_all(replacement_parking).unwrap();
    }

    #[test]
    fn forged_valid_shaped_journal_cannot_authorize_deletion() {
        let (authority_root, target, authority) = fixture();
        let nonce = "0123456789abcdef0123456789abcdef";
        let foreign = target.path().join(StagingKind::Render.entry_name(nonce));
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("customer.bin"), b"keep").unwrap();
        let mut forged = OwnershipJournal::new(
            &authority,
            StagingKind::Render,
            nonce.to_owned(),
            &fs::canonicalize(target.path()).unwrap(),
        )
        .unwrap();
        forged.authority_tag = "00".repeat(32);
        fs::write(
            authority_root
                .path()
                .join(StagingKind::Render.journal_name(nonce)),
            serde_json::to_vec(&forged).unwrap(),
        )
        .unwrap();

        assert!(authority.reconcile_all().is_err());
        assert_eq!(fs::read(foreign.join("customer.bin")).unwrap(), b"keep");
    }

    #[test]
    fn interrupted_journal_sidecar_never_blocks_or_authorizes_cleanup() {
        let (authority_root, target, authority) = fixture();
        let sidecar = authority_root.path().join(format!(
            "{JOURNAL_TEMP_PREFIX}0123456789abcdef0123456789abcdef.tmp"
        ));
        fs::write(&sidecar, b"{partial").unwrap();
        let foreign = target.path().join(".osg-export-foreign.part");
        fs::write(&foreign, b"keep").unwrap();

        authority.reconcile_all().unwrap();

        assert!(!sidecar.exists());
        assert_eq!(fs::read(foreign).unwrap(), b"keep");
    }

    #[test]
    fn concurrent_begin_sidecars_are_skipped_until_their_owner_unlocks() {
        let (authority_root, _target, authority) = fixture();
        let nonce = "0123456789abcdef0123456789abcdef";
        let journal_sidecar = authority_root
            .path()
            .join(format!("{JOURNAL_TEMP_PREFIX}{nonce}.tmp"));
        let mut writer = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&journal_sidecar)
            .unwrap();
        writer.lock_exclusive().unwrap();
        writer.write_all(b"in progress").unwrap();

        authority.reconcile_all().unwrap();

        assert!(journal_sidecar.is_file());
        FileExt::unlock(&writer).unwrap();
        drop(writer);
        authority.reconcile_all().unwrap();
        assert!(!journal_sidecar.exists());

        let authority_sidecar = authority_root
            .path()
            .join(format!("{AUTHORITY_TEMP_PREFIX}{nonce}.tmp"));
        let mut writer = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&authority_sidecar)
            .unwrap();
        writer.lock_exclusive().unwrap();
        writer.write_all(b"in progress").unwrap();

        RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();

        assert!(authority_sidecar.is_file());
        FileExt::unlock(&writer).unwrap();
        drop(writer);
        RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();
        assert!(!authority_sidecar.exists());
    }

    #[test]
    fn parallel_staging_admission_and_cleanup_preserve_live_owners() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payloads");
        fs::create_dir(&root).unwrap();
        let authority =
            RuntimeStagingAuthority::prepare(&temporary.path().join("authority")).unwrap();
        let barrier = std::sync::Barrier::new(12);
        std::thread::scope(|scope| {
            let barrier = &barrier;
            for _ in 0..12 {
                let root = &root;
                let authority = &authority;
                scope.spawn(move || {
                    // Independent handles must coordinate through the filesystem, not merely
                    // through a mutex shared by clones of one Rust value.
                    let authority =
                        RuntimeStagingAuthority::prepare(&authority.inner.root).unwrap();
                    barrier.wait();
                    for _ in 0..40 {
                        let directory = OwnedStagingDirectory::begin(
                            &authority,
                            root,
                            StagingKind::NativeToolDownload,
                        )
                        .expect("parallel admission must preserve active journal writers");
                        assert!(directory.path().is_dir());
                        directory.remove().expect("owned staging cleanup");
                    }
                });
            }
        });
        authority.reconcile_all().unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn prefix_lookalikes_in_the_private_root_are_never_adopted() {
        let (authority_root, _target, authority) = fixture();
        let journal_lookalike = authority_root
            .path()
            .join(format!("{JOURNAL_TEMP_PREFIX}customer-note.txt"));
        let authority_lookalike = authority_root
            .path()
            .join(format!("{AUTHORITY_TEMP_PREFIX}customer-note.txt"));
        fs::write(&journal_lookalike, b"keep journal lookalike").unwrap();
        fs::write(&authority_lookalike, b"keep authority lookalike").unwrap();

        authority.reconcile_all().unwrap();
        RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();

        assert_eq!(
            fs::read(journal_lookalike).unwrap(),
            b"keep journal lookalike"
        );
        assert_eq!(
            fs::read(authority_lookalike).unwrap(),
            b"keep authority lookalike"
        );
    }

    #[test]
    fn stale_part_is_reclaimed_and_publication_retires_journal() {
        let (authority_root, target, authority) = fixture();
        let mut stale =
            OwnedStagingFile::begin(&authority, target.path(), StagingKind::MediaExport).unwrap();
        stale.file_mut().unwrap().write_all(b"partial").unwrap();
        let stale_path = stale.path().to_owned();
        stale.abandon_as_if_process_terminated();
        authority.reconcile_all().unwrap();
        assert!(!stale_path.exists());

        let destination = target.path().join("video.mp4");
        fs::write(&destination, b"old").unwrap();
        let mut staged =
            OwnedStagingFile::begin(&authority, target.path(), StagingKind::MediaExport).unwrap();
        staged.file_mut().unwrap().write_all(b"new").unwrap();
        staged.replace_atomic(&destination).unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"new");
        assert_eq!(
            fs::read_dir(authority_root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(JOURNAL_PREFIX))
                .count(),
            0
        );
    }

    #[test]
    fn foreign_object_at_exact_owned_path_is_preserved() {
        let (_authority_root, target, authority) = fixture();
        let owned =
            OwnedStagingDirectory::begin(&authority, target.path(), StagingKind::Render).unwrap();
        let path = owned.path().to_owned();
        owned.abandon_as_if_process_terminated();
        fs::remove_dir(&path).unwrap();
        fs::write(&path, b"foreign").unwrap();

        assert!(authority.reconcile_all().is_err());
        assert_eq!(fs::read(path).unwrap(), b"foreign");
    }
}
