use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use same_file::Handle;
use serde_json::{Map, Value};
use uuid::Uuid;

const LOG_FILE_NAME: &str = "osg.log";
const PREVIOUS_LOG_FILE_NAME: &str = "osg.previous.log";
const LOCK_FILE_NAME: &str = ".osg.log.lock";
const ROTATION_BACKUP_FILE_NAME: &str = ".osg.previous.log.rotation";
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 128;
const MAX_RECORD_BYTES: usize = 64 * 1024;

static DIAGNOSTICS: DiagnosticRegistry = DiagnosticRegistry::new();

struct DiagnosticRegistry {
    initialization: Mutex<()>,
    initialized: OnceLock<InitializedDiagnostics>,
}

impl DiagnosticRegistry {
    const fn new() -> Self {
        Self {
            initialization: Mutex::new(()),
            initialized: OnceLock::new(),
        }
    }

    fn initialize(&self, directory: &Path) -> io::Result<()> {
        let _initialization = self
            .initialization
            .lock()
            .map_err(|_| io::Error::other("diagnostic initialization is unavailable"))?;
        if self.initialized.get().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "diagnostics were already initialized",
            ));
        }

        let mut log = DiagnosticLog::open(directory)?;
        let app_instance_id = new_app_instance_id();
        let start = encode_record("app.start", &[], &app_instance_id)?;
        log.append(&start)?;
        self.initialized
            .set(InitializedDiagnostics {
                app_instance_id,
                log: Mutex::new(log),
            })
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "diagnostics were already initialized",
                )
            })
    }

    fn record(&self, event: &'static str, fields: &[(&'static str, String)]) {
        let Some(initialized) = self.initialized.get() else {
            return;
        };
        let Ok(encoded) = encode_record(event, fields, &initialized.app_instance_id) else {
            return;
        };
        if let Ok(mut log) = initialized.log.lock() {
            let _ = log.append(&encoded);
        }
    }
}

struct InitializedDiagnostics {
    app_instance_id: String,
    log: Mutex<DiagnosticLog>,
}

struct DiagnosticLog {
    directory: PathBuf,
    directory_handle: Handle,
    current: PathBuf,
    file: Option<File>,
    length: u64,
    process_lock: ProcessLock,
}

impl DiagnosticLog {
    fn open(directory: &Path) -> io::Result<Self> {
        let directory_handle = open_log_directory(directory)?;
        preflight_managed_paths(directory, &directory_handle)?;
        let process_lock = ProcessLock::acquire(directory, &directory_handle)?;
        let current = directory.join(LOG_FILE_NAME);
        let mut log = Self {
            directory: directory.to_path_buf(),
            directory_handle,
            current,
            file: None,
            length: MAX_LOG_BYTES,
            process_lock,
        };
        log.rotate_on_startup_if_needed()?;
        log.reopen_current()?;
        Ok(log)
    }

    fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.append_with_io(bytes, Write::write_all, |file| {
            file.metadata().map(|metadata| metadata.len())
        })
    }

    fn append_with_io<W, M>(
        &mut self,
        bytes: &[u8],
        write: W,
        length_after_error: M,
    ) -> io::Result<()>
    where
        W: FnOnce(&mut File, &[u8]) -> io::Result<()>,
        M: FnOnce(&File) -> io::Result<u64>,
    {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "diagnostic record exceeded its bound",
            ));
        }
        self.verify_ownership_or_disable()?;
        let record_bytes = u64::try_from(bytes.len())
            .map_err(|_| io::Error::other("diagnostic record length overflow"))?;
        if self.length.saturating_add(record_bytes) > MAX_LOG_BYTES {
            self.rotate()?;
        }

        let write_result = {
            let file = self
                .file
                .as_mut()
                .ok_or_else(|| io::Error::other("diagnostic log is unavailable"))?;
            write(file, bytes)
        };
        if let Err(error) = write_result {
            let measured = self.file.as_ref().map_or_else(
                || Err(io::Error::other("diagnostic log is unavailable")),
                length_after_error,
            );
            match measured {
                Ok(length) => {
                    self.length = self.length.saturating_add(record_bytes).max(length);
                }
                Err(_) => self.disable(),
            }
            return Err(error);
        }

        self.length = self.length.saturating_add(record_bytes);
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("diagnostic log is unavailable"))?
            .flush()
    }

    fn rotate_on_startup_if_needed(&mut self) -> io::Result<()> {
        self.verify_directory_and_lock()?;
        recover_interrupted_rotation(&self.directory, &self.directory_handle, &self.current)?;
        let previous = self.directory.join(PREVIOUS_LOG_FILE_NAME);
        validated_existing_file(&previous)?;
        let Some(metadata) = validated_existing_file(&self.current)? else {
            return Ok(());
        };
        if metadata.len() < MAX_LOG_BYTES {
            return Ok(());
        }
        rotate_paths(&self.directory, &self.directory_handle, &self.current)
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.verify_ownership_or_disable()?;
        let flush_result = if let Some(mut file) = self.file.take() {
            let result = file.flush();
            drop(file);
            result
        } else {
            Ok(())
        };
        if let Err(error) = flush_result {
            self.disable();
            return Err(error);
        }

        if let Err(error) = self.verify_directory_and_lock() {
            self.disable();
            return Err(error);
        }
        if let Err(error) = rotate_paths(&self.directory, &self.directory_handle, &self.current) {
            self.disable();
            return Err(error);
        }
        if let Err(error) = self.reopen_current() {
            self.disable();
            return Err(error);
        }
        Ok(())
    }

    fn reopen_current(&mut self) -> io::Result<()> {
        self.verify_directory_and_lock()?;
        let file = open_owned_file(&self.current, FileSharing::Protected, |options| {
            options.create(true).append(true);
        })?;
        self.install_reopened_file(file)
    }

    fn install_reopened_file(&mut self, file: File) -> io::Result<()> {
        self.install_reopened_file_with(file, |file| file.metadata().map(|metadata| metadata.len()))
    }

    fn install_reopened_file_with<M>(&mut self, file: File, metadata_length: M) -> io::Result<()>
    where
        M: FnOnce(&File) -> io::Result<u64>,
    {
        match metadata_length(&file) {
            Ok(length) => {
                self.file = Some(file);
                self.length = length;
                Ok(())
            }
            Err(error) => {
                drop(file);
                self.disable();
                Err(error)
            }
        }
    }

    fn verify_directory_and_lock(&self) -> io::Result<()> {
        verify_directory_path(&self.directory, &self.directory_handle)?;
        self.process_lock.verify()
    }

    fn verify_ownership_or_disable(&mut self) -> io::Result<()> {
        let result = (|| {
            self.verify_directory_and_lock()?;
            let file = self
                .file
                .as_ref()
                .ok_or_else(|| io::Error::other("diagnostic log is unavailable"))?;
            verify_open_file_path(&self.current, file)
        })();
        if result.is_err() {
            self.disable();
        }
        result
    }

    fn disable(&mut self) {
        self.file = None;
        self.length = MAX_LOG_BYTES;
    }
}

struct ProcessLock {
    path: PathBuf,
    file: File,
}

impl ProcessLock {
    fn acquire(directory: &Path, directory_handle: &Handle) -> io::Result<Self> {
        verify_directory_path(directory, directory_handle)?;
        let path = directory.join(LOCK_FILE_NAME);
        let file = open_owned_file(&path, FileSharing::ProcessLock, |options| {
            options.read(true).write(true).create(true);
        })?;
        if let Err(error) = fs2::FileExt::try_lock_exclusive(&file) {
            let contended = fs2::lock_contended_error();
            if error.kind() == io::ErrorKind::WouldBlock
                || error.raw_os_error() == contended.raw_os_error()
            {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "diagnostic log is owned by another process",
                ));
            }
            return Err(error);
        }
        let process_lock = Self { path, file };
        process_lock.verify()?;
        verify_directory_path(directory, directory_handle)?;
        Ok(process_lock)
    }

    fn verify(&self) -> io::Result<()> {
        verify_open_file_path(&self.path, &self.file)
    }
}

pub(crate) fn initialize(directory: &Path) -> io::Result<()> {
    DIAGNOSTICS.initialize(directory)
}

pub(crate) fn record(event: &'static str, fields: &[(&'static str, String)]) {
    DIAGNOSTICS.record(event, fields);
}

/// Per-process memory of which managed package components have already had a failed fast-path
/// verification-receipt write (`osg_engine_packages::verified_install::write`, surfaced through
/// `receipt_write_degraded`) reported through the diagnostic log. That write is best-effort by
/// design -- a failure never blocks install, adoption, or verification -- which is exactly why it
/// stays invisible unless something reports it, and exactly why that report must never become a
/// log storm: an engine or speech card's status is polled by the UI every few seconds, and a
/// launch can retry the same component many times in one session.
static RECEIPT_WRITE_DEGRADED_REPORTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// `true` only the first time `component` is marked -- every later call for the same component
/// returns `false`, poisoning aside (a poisoned lock never reports, matching this module's other
/// best-effort failure handling).
fn receipt_write_degraded_mark_if_first(component: &str) -> bool {
    let reported = RECEIPT_WRITE_DEGRADED_REPORTED.get_or_init(|| Mutex::new(HashSet::new()));
    reported
        .lock()
        .is_ok_and(|mut reported| reported.insert(component.to_owned()))
}

/// Reports a permanently-failing fast-path receipt write for `component`, at most once per
/// component per process. Called from every engine/speech status probe and launch resolution that
/// already reaches the package manager (see `asr.rs::resolve_runtime` and its speech equivalent);
/// `degraded` is that call's own `receipt_write_degraded(component)` read, so a healthy component
/// costs nothing beyond the read already being made for other reasons.
pub(crate) fn record_receipt_write_degraded(component: &str, degraded: bool) {
    record_receipt_write_degraded_with(component, degraded, record);
}

fn record_receipt_write_degraded_with(
    component: &str,
    degraded: bool,
    mut emit: impl FnMut(&'static str, &[(&'static str, String)]),
) {
    if degraded && receipt_write_degraded_mark_if_first(component) {
        emit(
            "engine-packages.receipt_write_degraded",
            &[("component", component.to_owned())],
        );
    }
}

fn encode_record(
    event: &'static str,
    fields: &[(&'static str, String)],
    app_instance_id: &str,
) -> io::Result<Vec<u8>> {
    let mut entry = Map::new();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    entry.insert(
        "timestampMs".to_owned(),
        Value::String(timestamp.to_string()),
    );
    entry.insert("event".to_owned(), Value::String(event.to_owned()));
    for (key, value) in fields {
        entry.insert((*key).to_owned(), Value::String(sanitize(value)));
    }
    entry.insert(
        "appInstanceId".to_owned(),
        Value::String(app_instance_id.to_owned()),
    );
    let mut encoded = serde_json::to_vec(&Value::Object(entry)).map_err(io::Error::other)?;
    encoded.push(b'\n');
    Ok(encoded)
}

fn new_app_instance_id() -> String {
    Uuid::now_v7().to_string()
}

fn open_log_directory(directory: &Path) -> io::Result<Handle> {
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

fn verify_directory_path(path: &Path, expected: &Handle) -> io::Result<()> {
    reject_redirecting_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    reject_unsafe_metadata(&metadata, true)?;
    let actual = Handle::from_path(path)?;
    if actual != *expected {
        return Err(unsafe_path_error());
    }
    Ok(())
}

fn preflight_managed_paths(directory: &Path, directory_handle: &Handle) -> io::Result<()> {
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
enum FileSharing {
    Observation,
    Protected,
    ProcessLock,
    Rotation,
}

fn open_owned_file<F>(path: &Path, sharing: FileSharing, configure: F) -> io::Result<File>
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

fn verify_open_file_path(path: &Path, file: &File) -> io::Result<()> {
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

fn validated_existing_file(path: &Path) -> io::Result<Option<fs::Metadata>> {
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

fn rotate_paths(directory: &Path, directory_handle: &Handle, current: &Path) -> io::Result<()> {
    rotate_paths_with_hook(directory, directory_handle, current, |_| Ok(()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RotationPoint {
    Validated,
    PreviousMoved,
    CurrentMoved,
    CurrentCreated,
    BeforeCommit,
}

fn rotate_paths_with_hook<H>(
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

struct RotationTransaction<'a> {
    directory: &'a Path,
    directory_handle: &'a Handle,
    current: PathBuf,
    previous: PathBuf,
    backup: PathBuf,
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

    fn commit(&mut self) -> io::Result<()> {
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

fn recover_interrupted_rotation(
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

struct ValidatedFile {
    file: File,
    metadata: fs::Metadata,
}

fn open_existing_file(path: &Path, sharing: FileSharing) -> io::Result<Option<ValidatedFile>> {
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

fn configure_file_sharing(options: &mut OpenOptions, sharing: FileSharing) {
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

fn configure_no_follow(options: &mut OpenOptions) {
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

fn unsafe_path_error() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "diagnostic log path is unsafe")
}

fn sanitize(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::env;
    use std::fs::{self, OpenOptions};
    use std::io::{self, Write};
    use std::process::Command;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[cfg(windows)]
    use super::recover_interrupted_rotation;
    use super::{
        DiagnosticLog, DiagnosticRegistry, LOCK_FILE_NAME, LOG_FILE_NAME, MAX_FIELD_BYTES,
        MAX_LOG_BYTES, MAX_RECORD_BYTES, PREVIOUS_LOG_FILE_NAME, ProcessLock,
        ROTATION_BACKUP_FILE_NAME, RotationPoint, new_app_instance_id, open_log_directory,
        record_receipt_write_degraded_with, rotate_paths_with_hook, sanitize,
    };
    use uuid::Uuid;

    const PROCESS_LOCK_PROBE_DIRECTORY: &str = "OSG_TEST_DIAGNOSTIC_LOCK_DIRECTORY";
    const PROCESS_LOCK_PROBE_EXPECTATION: &str = "OSG_TEST_DIAGNOSTIC_LOCK_EXPECTATION";

    #[test]
    fn diagnostic_fields_accept_identifiers_and_redact_paths_or_secrets() {
        assert_eq!(sanitize("media-tools"), "media-tools");
        assert_eq!(sanitize("019c:completed"), "019c:completed");
        assert_eq!(sanitize("C:\\private\\tool.exe"), "redacted");
        assert_eq!(sanitize("token=value"), "redacted");
        assert_eq!(sanitize(&"a".repeat(MAX_FIELD_BYTES + 1)), "redacted");
    }

    #[test]
    fn application_instance_identifier_is_uuid_v7_and_log_safe() {
        let identifier = new_app_instance_id();
        assert_eq!(Uuid::parse_str(&identifier).unwrap().get_version_num(), 7);
        assert_eq!(sanitize(&identifier), identifier);
    }

    /// `RECEIPT_WRITE_DEGRADED_REPORTED` is one process-wide static; every test below uses its own
    /// fresh UUID as the component id so parallel test threads can never collide on it.
    fn unique_test_component() -> String {
        format!("test-component-{}", Uuid::new_v4().simple())
    }

    #[test]
    fn receipt_write_degraded_event_fires_exactly_once_per_component_when_degraded() {
        let component = unique_test_component();
        let mut emitted = Vec::new();
        for _ in 0..3 {
            record_receipt_write_degraded_with(&component, true, |event, fields| {
                emitted.push((event, fields.to_vec()));
            });
        }
        assert_eq!(emitted.len(), 1, "repeated degraded reads must report once");
        let (event, fields) = &emitted[0];
        assert_eq!(*event, "engine-packages.receipt_write_degraded");
        assert_eq!(fields, &[("component", component)]);
    }

    #[test]
    fn receipt_write_degraded_event_never_fires_when_healthy() {
        let component = unique_test_component();
        let mut emitted: Vec<(&'static str, Vec<(&'static str, String)>)> = Vec::new();
        for _ in 0..3 {
            record_receipt_write_degraded_with(&component, false, |event, fields| {
                emitted.push((event, fields.to_vec()));
            });
        }
        assert!(
            emitted.is_empty(),
            "a healthy component must never be reported"
        );

        // A healthy read never consumes the per-component "already reported" slot: a later
        // degraded read for the SAME component must still fire.
        record_receipt_write_degraded_with(&component, true, |event, fields| {
            emitted.push((event, fields.to_vec()));
        });
        assert_eq!(emitted.len(), 1);
    }

    #[test]
    fn receipt_write_degraded_event_reports_each_distinct_component_independently() {
        let first = unique_test_component();
        let second = unique_test_component();
        let mut emitted = Vec::new();
        record_receipt_write_degraded_with(&first, true, |event, fields| {
            emitted.push((event, fields.to_vec()));
        });
        record_receipt_write_degraded_with(&second, true, |event, fields| {
            emitted.push((event, fields.to_vec()));
        });
        assert_eq!(
            emitted.len(),
            2,
            "distinct components must each be reported"
        );
        let reported_components = emitted
            .iter()
            .map(|(_, fields)| fields[0].1.clone())
            .collect::<BTreeSet<_>>();
        assert_eq!(reported_components, BTreeSet::from([first, second]));
    }

    #[test]
    fn running_log_allows_the_exact_bound_then_rotates_before_one_more_byte() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        let record = vec![b'a'; MAX_RECORD_BYTES];
        let record_count = MAX_LOG_BYTES / u64::try_from(MAX_RECORD_BYTES).expect("bounded record");
        for _ in 0..record_count {
            log.append(&record).expect("append through exact bound");
        }

        let current = directory.path().join(LOG_FILE_NAME);
        let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
        assert_eq!(
            fs::metadata(&current).expect("current metadata").len(),
            MAX_LOG_BYTES
        );
        assert!(!previous.exists());

        log.append(b"b").expect("rotate beyond exact bound");
        assert_eq!(
            fs::metadata(&previous).expect("previous metadata").len(),
            MAX_LOG_BYTES
        );
        assert_eq!(fs::read(&current).expect("fresh current"), b"b");
    }

    #[test]
    fn startup_rotation_occurs_at_the_exact_bound_but_not_one_byte_below() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let below = temporary.path().join("below");
        fs::create_dir(&below).expect("create below-bound directory");
        fs::write(
            below.join(LOG_FILE_NAME),
            vec![b'a'; usize::try_from(MAX_LOG_BYTES - 1).expect("bounded fixture")],
        )
        .expect("write below-bound log");
        let below_log = DiagnosticLog::open(&below).expect("open below-bound log");
        assert_eq!(below_log.length, MAX_LOG_BYTES - 1);
        assert!(!below.join(PREVIOUS_LOG_FILE_NAME).exists());
        drop(below_log);

        let exact = temporary.path().join("exact");
        fs::create_dir(&exact).expect("create exact-bound directory");
        fs::write(
            exact.join(LOG_FILE_NAME),
            vec![b'b'; usize::try_from(MAX_LOG_BYTES).expect("bounded fixture")],
        )
        .expect("write exact-bound log");
        let exact_log = DiagnosticLog::open(&exact).expect("open exact-bound log");
        assert_eq!(exact_log.length, 0);
        assert_eq!(
            fs::metadata(exact.join(PREVIOUS_LOG_FILE_NAME))
                .expect("rotated exact-bound log")
                .len(),
            MAX_LOG_BYTES
        );
    }

    #[test]
    fn interrupted_rotation_states_restore_both_prior_logs_before_opening() {
        enum InterruptedState {
            PreviousMoved,
            CurrentMoved,
            FreshCurrentCreated,
        }

        for (index, state) in [
            InterruptedState::PreviousMoved,
            InterruptedState::CurrentMoved,
            InterruptedState::FreshCurrentCreated,
        ]
        .into_iter()
        .enumerate()
        {
            let temporary = tempfile::tempdir().expect("temporary root");
            let directory = temporary.path().join(format!("state-{index}"));
            fs::create_dir(&directory).expect("create interrupted log directory");
            let current = directory.join(LOG_FILE_NAME);
            let previous = directory.join(PREVIOUS_LOG_FILE_NAME);
            let backup = directory.join(ROTATION_BACKUP_FILE_NAME);
            match state {
                InterruptedState::PreviousMoved => {
                    fs::write(&current, b"prior-current").expect("seed current");
                    fs::write(&backup, b"prior-previous").expect("seed backup");
                }
                InterruptedState::CurrentMoved => {
                    fs::write(&previous, b"prior-current").expect("seed moved current");
                    fs::write(&backup, b"prior-previous").expect("seed backup");
                }
                InterruptedState::FreshCurrentCreated => {
                    fs::write(&current, b"").expect("seed fresh current");
                    fs::write(&previous, b"prior-current").expect("seed moved current");
                    fs::write(&backup, b"prior-previous").expect("seed backup");
                }
            }

            let log = DiagnosticLog::open(&directory).expect("recover interrupted rotation");
            assert_eq!(
                fs::read(&current).expect("restored current"),
                b"prior-current"
            );
            assert_eq!(
                fs::read(&previous).expect("restored previous"),
                b"prior-previous"
            );
            assert!(!backup.exists());
            drop(log);
        }
    }

    #[test]
    fn injected_rotation_failures_restore_both_prior_logs_at_every_boundary() {
        for point in [
            RotationPoint::Validated,
            RotationPoint::PreviousMoved,
            RotationPoint::CurrentMoved,
            RotationPoint::CurrentCreated,
            RotationPoint::BeforeCommit,
        ] {
            let directory = tempfile::tempdir().expect("temporary log directory");
            let current = directory.path().join(LOG_FILE_NAME);
            let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
            let backup = directory.path().join(ROTATION_BACKUP_FILE_NAME);
            fs::write(&current, b"prior-current").expect("seed current");
            fs::write(&previous, b"prior-previous").expect("seed previous");
            let directory_handle = open_log_directory(directory.path()).expect("open directory");
            let process_lock = ProcessLock::acquire(directory.path(), &directory_handle)
                .expect("acquire process lock");

            let error =
                rotate_paths_with_hook(directory.path(), &directory_handle, &current, |observed| {
                    if observed == point {
                        Err(io::Error::other("injected rotation failure"))
                    } else {
                        Ok(())
                    }
                })
                .expect_err("injected rotation must fail");
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(
                fs::read(&current).expect("restored current"),
                b"prior-current"
            );
            assert_eq!(
                fs::read(&previous).expect("restored previous"),
                b"prior-previous"
            );
            assert!(!backup.exists());
            drop(process_lock);
        }
    }

    #[test]
    fn running_log_rotates_repeatedly_and_keeps_two_log_files_plus_the_lock() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        let first = vec![b'a'; usize::try_from(MAX_LOG_BYTES - 2).expect("bounded fixture")];
        for record in first.chunks(MAX_RECORD_BYTES) {
            log.append(record).expect("append bounded first log");
        }
        log.append(b"bcd").expect("rotate and append next record");

        let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
        let current = directory.path().join(LOG_FILE_NAME);
        assert_eq!(fs::read(&previous).expect("previous log"), first);
        assert_eq!(fs::read(&current).expect("current log"), b"bcd");

        let second = vec![b'e'; usize::try_from(MAX_LOG_BYTES - 3).expect("bounded fixture")];
        for record in second.chunks(MAX_RECORD_BYTES) {
            log.append(record).expect("fill current log exactly");
        }
        log.append(b"f").expect("rotate a second time");
        assert_eq!(
            fs::metadata(&previous)
                .expect("replaced previous log")
                .len(),
            MAX_LOG_BYTES,
        );
        assert_eq!(fs::read(&current).expect("fresh current log"), b"f");
        let names = fs::read_dir(directory.path())
            .expect("log directory")
            .map(|entry| {
                entry
                    .expect("directory entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            names,
            BTreeSet::from([
                LOCK_FILE_NAME.to_owned(),
                LOG_FILE_NAME.to_owned(),
                PREVIOUS_LOG_FILE_NAME.to_owned(),
            ])
        );
    }

    #[test]
    fn running_log_rejects_one_oversized_record_without_writing_it() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        let oversized = vec![b'x'; MAX_RECORD_BYTES + 1];
        assert_eq!(
            log.append(&oversized).expect_err("oversized record").kind(),
            io::ErrorKind::InvalidData,
        );
        assert!(
            fs::read(directory.path().join(LOG_FILE_NAME))
                .expect("current log")
                .is_empty()
        );
    }

    #[test]
    fn partial_write_with_unknown_disk_length_disables_the_logger() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        let error = log
            .append_with_io(
                b"abcdef",
                |file, _| {
                    file.write_all(b"abc")?;
                    Err(io::Error::other("injected partial write failure"))
                },
                |_| Err(io::Error::other("injected metadata failure")),
            )
            .expect_err("partial write must fail");
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(log.length, MAX_LOG_BYTES);
        assert!(log.file.is_none());
        assert_eq!(
            fs::read(directory.path().join(LOG_FILE_NAME)).expect("partially written log"),
            b"abc"
        );
        assert!(log.append(b"z").is_err());
        assert_eq!(
            fs::read(directory.path().join(LOG_FILE_NAME)).expect("unchanged partial log"),
            b"abc"
        );
    }

    #[test]
    fn partial_write_with_a_stale_measured_length_uses_the_full_record_upper_bound() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        log.append_with_io(
            b"abcdef",
            |file, _| {
                file.write_all(b"abc")?;
                Err(io::Error::other("injected partial write failure"))
            },
            |_| Ok(0),
        )
        .expect_err("partial write must fail");

        assert_eq!(log.length, 6);
        assert!(log.file.is_some());
        assert_eq!(
            fs::read(directory.path().join(LOG_FILE_NAME)).expect("partially written log"),
            b"abc"
        );
    }

    #[test]
    fn reopened_file_with_unknown_length_disables_the_logger() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        log.file = None;
        let replacement = OpenOptions::new()
            .append(true)
            .open(directory.path().join(LOG_FILE_NAME))
            .expect("open replacement handle");
        let error = log
            .install_reopened_file_with(replacement, |_| {
                Err(io::Error::other("injected reopened metadata failure"))
            })
            .expect_err("metadata failure must reject reopened file");
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(log.length, MAX_LOG_BYTES);
        assert!(log.file.is_none());
    }

    #[test]
    fn registry_reinitialization_fails_before_mutating_same_or_different_directory() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        let registry = DiagnosticRegistry::new();
        registry.initialize(&first).expect("initialize registry");
        let before = fs::read(first.join(LOG_FILE_NAME)).expect("initial app start");
        let entries_before = directory_snapshot(&first);

        assert_eq!(
            registry
                .initialize(&first)
                .expect_err("same-directory reinitialization")
                .kind(),
            io::ErrorKind::AlreadyExists,
        );
        assert_eq!(
            registry
                .initialize(&second)
                .expect_err("different-directory reinitialization")
                .kind(),
            io::ErrorKind::AlreadyExists,
        );
        assert_eq!(
            fs::read(first.join(LOG_FILE_NAME)).expect("unchanged log"),
            before
        );
        assert_eq!(directory_snapshot(&first), entries_before);
        assert!(!second.exists());
        assert_eq!(
            before
                .split(|byte| *byte == b'\n')
                .filter(|record| !record.is_empty())
                .count(),
            1
        );
    }

    #[test]
    fn concurrent_registry_initialization_has_one_owner_and_no_loser_directory() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let directories = [temporary.path().join("one"), temporary.path().join("two")];
        let registry = Arc::new(DiagnosticRegistry::new());
        let barrier = Arc::new(Barrier::new(3));
        let workers = directories
            .iter()
            .cloned()
            .map(|directory| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    registry.initialize(&directory).map(|()| directory)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("initializer thread"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.kind() == io::ErrorKind::AlreadyExists)
                .count(),
            1
        );
        assert_eq!(directories.iter().filter(|path| path.exists()).count(), 1);
    }

    #[test]
    fn process_lock_contention_cannot_rotate_or_append_logs() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut owner = DiagnosticLog::open(directory.path()).expect("first process owner");
        owner.append(b"owned").expect("owner append");
        let before = directory_snapshot(directory.path());

        run_process_lock_probe(directory.path(), "contended");
        assert_eq!(directory_snapshot(directory.path()), before);

        drop(owner);
        run_process_lock_probe(directory.path(), "available");
    }

    #[cfg(windows)]
    #[test]
    fn sharing_denied_rotation_keeps_both_logs_and_recovers_the_transaction() {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;

        let directory = tempfile::tempdir().expect("temporary log directory");
        let current = directory.path().join(LOG_FILE_NAME);
        let previous = directory.path().join(PREVIOUS_LOG_FILE_NAME);
        let backup = directory.path().join(ROTATION_BACKUP_FILE_NAME);
        fs::write(&current, b"prior-current").expect("seed current");
        fs::write(&previous, b"prior-previous").expect("seed previous");
        let directory_handle = open_log_directory(directory.path()).expect("open directory");
        let process_lock =
            ProcessLock::acquire(directory.path(), &directory_handle).expect("acquire lock");

        let current_blocker = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&current)
            .expect("hold current without delete sharing");
        rotate_paths_with_hook(directory.path(), &directory_handle, &current, |_| Ok(()))
            .expect_err("sharing-denied current rename must fail");
        assert_eq!(
            fs::read(&current).expect("current remains"),
            b"prior-current"
        );
        assert_eq!(
            fs::read(&previous).expect("previous restored"),
            b"prior-previous"
        );
        assert!(!backup.exists());
        drop(current_blocker);

        let mut backup_blocker = None;
        rotate_paths_with_hook(directory.path(), &directory_handle, &current, |point| {
            if point == RotationPoint::BeforeCommit {
                backup_blocker = Some(
                    OpenOptions::new()
                        .read(true)
                        .share_mode(FILE_SHARE_READ)
                        .open(&backup)?,
                );
            }
            Ok(())
        })
        .expect_err("sharing-denied commit must fail");
        assert_eq!(
            fs::read(&current).expect("restored current"),
            b"prior-current"
        );
        assert_eq!(
            fs::read(&backup).expect("preserved backup"),
            b"prior-previous"
        );
        assert!(!previous.exists());

        drop(backup_blocker);
        recover_interrupted_rotation(directory.path(), &directory_handle, &current)
            .expect("recover sharing-denied transaction");
        assert_eq!(
            fs::read(&current).expect("recovered current"),
            b"prior-current"
        );
        assert_eq!(
            fs::read(&previous).expect("recovered previous"),
            b"prior-previous"
        );
        assert!(!backup.exists());
        drop(process_lock);
    }

    #[test]
    fn diagnostic_process_lock_probe_child() {
        let Some(directory) = env::var_os(PROCESS_LOCK_PROBE_DIRECTORY) else {
            return;
        };
        let expectation = env::var(PROCESS_LOCK_PROBE_EXPECTATION).expect("lock expectation");
        let result = DiagnosticLog::open(std::path::Path::new(&directory));
        match expectation.as_str() {
            "contended" => assert_eq!(
                result.err().expect("lock must be contended").kind(),
                io::ErrorKind::WouldBlock
            ),
            "available" => assert!(result.is_ok()),
            _ => panic!("unexpected diagnostic lock probe expectation"),
        }
    }

    #[test]
    fn existing_lock_data_is_never_truncated_or_deleted() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let lock = directory.path().join(LOCK_FILE_NAME);
        fs::write(&lock, b"unknown-owner-data").expect("seed lock data");
        let log = DiagnosticLog::open(directory.path()).expect("open with existing lock data");
        drop(log);
        assert_eq!(
            fs::read(lock).expect("read lock data"),
            b"unknown-owner-data"
        );
    }

    #[test]
    fn file_symlinks_are_rejected_without_touching_their_targets() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let directory = temporary.path().join("logs");
        fs::create_dir(&directory).expect("create log directory");
        let external = temporary.path().join("external.log");
        fs::write(&external, b"outside").expect("write external file");
        if create_file_symlink(&external, &directory.join(LOG_FILE_NAME)).is_err() {
            return;
        }

        let error = DiagnosticLog::open(&directory)
            .err()
            .expect("symlinked current log must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            fs::read(external).expect("external remains readable"),
            b"outside"
        );
    }

    #[test]
    fn lock_symlinks_are_rejected_without_touching_their_targets() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let directory = temporary.path().join("logs");
        fs::create_dir(&directory).expect("create log directory");
        let external = temporary.path().join("external.lock");
        fs::write(&external, b"outside-lock").expect("write external lock");
        if create_file_symlink(&external, &directory.join(LOCK_FILE_NAME)).is_err() {
            return;
        }

        let error = DiagnosticLog::open(&directory)
            .err()
            .expect("symlinked process lock must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            fs::read(external).expect("external lock remains readable"),
            b"outside-lock"
        );
        assert!(!directory.join(LOG_FILE_NAME).exists());
    }

    #[test]
    fn replacing_the_open_log_path_disables_logging_before_writing_the_replacement() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let mut log = DiagnosticLog::open(directory.path()).expect("open diagnostic log");
        log.append(b"owned").expect("owner append");
        let current = directory.path().join(LOG_FILE_NAME);
        let displaced = directory.path().join("displaced.log");
        if fs::rename(&current, &displaced).is_err() {
            return;
        }
        fs::write(&current, b"replacement").expect("write replacement path");

        assert_eq!(
            log.append(b"must-not-be-written")
                .expect_err("replaced path must fail")
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert!(log.file.is_none());
        assert_eq!(
            fs::read(current).expect("replacement remains"),
            b"replacement"
        );
        assert_eq!(fs::read(displaced).expect("owned log remains"), b"owned");
    }

    #[test]
    fn directory_symlinks_are_rejected_before_creating_any_log_entry() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let target = temporary.path().join("target");
        let alias = temporary.path().join("alias");
        fs::create_dir(&target).expect("create target directory");
        if create_directory_symlink(&target, &alias).is_err() {
            return;
        }

        let error = DiagnosticLog::open(&alias)
            .err()
            .expect("symlinked log directory must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_dir(target).expect("target directory").count(), 0);
    }

    #[test]
    fn symlinked_directory_ancestor_is_rejected_before_creating_any_log_entry() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let target = temporary.path().join("target");
        let alias = temporary.path().join("alias");
        fs::create_dir(&target).expect("create target directory");
        if create_directory_symlink(&target, &alias).is_err() {
            return;
        }
        let nested = alias.join("logs");

        let error = DiagnosticLog::open(&nested)
            .err()
            .expect("redirected log ancestor must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_dir(target).expect("target directory").count(), 0);
    }

    #[test]
    fn previous_log_symlink_blocks_rotation_without_touching_external_data() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let directory = temporary.path().join("logs");
        fs::create_dir(&directory).expect("create log directory");
        fs::write(
            directory.join(LOG_FILE_NAME),
            vec![b'x'; usize::try_from(MAX_LOG_BYTES).expect("bounded diagnostic log fixture")],
        )
        .expect("write full current log");
        let external = temporary.path().join("external.previous");
        fs::write(&external, b"outside-previous").expect("write external previous");
        if create_file_symlink(&external, &directory.join(PREVIOUS_LOG_FILE_NAME)).is_err() {
            return;
        }

        let error = DiagnosticLog::open(&directory)
            .err()
            .expect("symlinked previous log must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            fs::read(external).expect("external previous remains readable"),
            b"outside-previous"
        );
        assert_eq!(
            fs::metadata(directory.join(LOG_FILE_NAME))
                .expect("current remains")
                .len(),
            MAX_LOG_BYTES
        );
    }

    #[test]
    fn unsafe_rotation_target_created_during_runtime_disables_logging() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let directory = temporary.path().join("logs");
        let mut log = DiagnosticLog::open(&directory).expect("open diagnostic log");
        let record = vec![b'x'; MAX_RECORD_BYTES];
        let record_count = MAX_LOG_BYTES / u64::try_from(MAX_RECORD_BYTES).expect("bounded record");
        for _ in 0..record_count {
            log.append(&record).expect("fill current log exactly");
        }
        let external = temporary.path().join("external.previous");
        fs::write(&external, b"outside-previous").expect("write external previous");
        if create_file_symlink(&external, &directory.join(PREVIOUS_LOG_FILE_NAME)).is_err() {
            return;
        }

        assert_eq!(
            log.append(b"must-not-be-written")
                .expect_err("unsafe rotation must fail")
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert!(log.file.is_none());
        assert_eq!(log.length, MAX_LOG_BYTES);
        assert_eq!(
            fs::read(external).expect("external previous remains readable"),
            b"outside-previous"
        );
        assert_eq!(
            fs::metadata(directory.join(LOG_FILE_NAME))
                .expect("current remains")
                .len(),
            MAX_LOG_BYTES
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn existing_hardlinked_current_previous_and_lock_paths_are_rejected() {
        let temporary = tempfile::tempdir().expect("temporary root");
        for file_name in [LOG_FILE_NAME, PREVIOUS_LOG_FILE_NAME, LOCK_FILE_NAME] {
            let directory = temporary.path().join(file_name.replace('.', "_"));
            fs::create_dir(&directory).expect("create log directory");
            let external = temporary.path().join(format!("external-{file_name}"));
            fs::write(&external, b"outside").expect("write external file");
            fs::hard_link(&external, directory.join(file_name)).expect("create hardlink");

            let error = DiagnosticLog::open(&directory)
                .err()
                .expect("hardlinked diagnostic path must fail");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(fs::read(external).expect("external remains"), b"outside");
            if file_name != LOCK_FILE_NAME {
                assert!(!directory.join(LOCK_FILE_NAME).exists());
            }
            if file_name != LOG_FILE_NAME {
                assert!(!directory.join(LOG_FILE_NAME).exists());
            }
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn hardlink_added_after_open_is_rejected_before_the_next_write() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let directory = temporary.path().join("logs");
        let mut log = DiagnosticLog::open(&directory).expect("open diagnostic log");
        let current = directory.join(LOG_FILE_NAME);
        let alias = temporary.path().join("external-current.log");
        fs::hard_link(&current, &alias).expect("create runtime hardlink");

        assert_eq!(
            log.append(b"must-not-be-written")
                .expect_err("runtime hardlink must disable logging")
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert!(log.file.is_none());
        assert!(fs::read(&current).expect("current remains").is_empty());
        assert!(fs::read(&alias).expect("alias remains").is_empty());
    }

    fn directory_snapshot(directory: &std::path::Path) -> Vec<(String, u64, Option<Vec<u8>>)> {
        let mut entries = fs::read_dir(directory)
            .expect("snapshot directory")
            .map(|entry| {
                let entry = entry.expect("snapshot entry");
                let name = entry.file_name().to_string_lossy().into_owned();
                (
                    name.clone(),
                    fs::metadata(entry.path()).expect("snapshot metadata").len(),
                    (name != LOCK_FILE_NAME)
                        .then(|| fs::read(entry.path()).expect("snapshot file")),
                )
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        entries
    }

    fn run_process_lock_probe(directory: &std::path::Path, expectation: &str) {
        let output = Command::new(env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "diagnostics::tests::diagnostic_process_lock_probe_child",
                "--nocapture",
            ])
            .env(PROCESS_LOCK_PROBE_DIRECTORY, directory)
            .env(PROCESS_LOCK_PROBE_EXPECTATION, expectation)
            .output()
            .expect("run diagnostic lock probe process");
        assert!(
            output.status.success(),
            "diagnostic lock probe failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn create_directory_symlink(
        target: &std::path::Path,
        link: &std::path::Path,
    ) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_symlink(
        target: &std::path::Path,
        link: &std::path::Path,
    ) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }
}
