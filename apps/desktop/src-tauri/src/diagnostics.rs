//! Bounded, path-free native event log with one rotated previous generation.

mod file_safety;
mod rotation;

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use same_file::Handle;
use serde_json::{Map, Value};
use uuid::Uuid;

use self::file_safety::{
    FileSharing, open_log_directory, open_owned_file, preflight_managed_paths, sanitize,
    validated_existing_file, verify_directory_path, verify_open_file_path,
};
use self::rotation::{recover_interrupted_rotation, rotate_paths};

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

#[cfg(test)]
mod tests;
