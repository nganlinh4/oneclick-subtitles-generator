//! Database connection setup: single-writer lease, open/validate/migrate, health, backup.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use fs2::FileExt;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags, params};
use uuid::Uuid;

use super::{APPLICATION_ID, DatabaseHealth, MINIMUM_SQLITE_VERSION, SCHEMA_VERSION, now_ms};
use crate::storage::active_workspace;
use crate::storage::artifacts;
use crate::storage::error::DatabaseError;
use crate::storage::jobs;
use crate::storage::legacy;
use crate::storage::migrations::migrations;
use crate::storage::projects;

static PROCESS_WRITER_LEASES: LazyLock<std::sync::Mutex<BTreeSet<PathBuf>>> =
    LazyLock::new(|| std::sync::Mutex::new(BTreeSet::new()));

pub(super) struct WriterLease {
    file: File,
    database_path: PathBuf,
}

impl std::fmt::Debug for WriterLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WriterLease")
            .field("file", &"<locked>")
            .field("database_path", &"<redacted>")
            .finish()
    }
}

impl Drop for WriterLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
        if let Ok(mut leases) = PROCESS_WRITER_LEASES.lock() {
            leases.remove(&self.database_path);
        }
    }
}

pub(super) fn open_connection(
    path: &Path,
    artifact_root: &Path,
) -> Result<(Connection, artifacts::ArtifactRoot, WriterLease), DatabaseError> {
    let path = canonical_database_path(path)?;
    // Recovery is intentionally destructive to stale in-flight jobs and pending artifacts.  The
    // lease therefore has to be acquired before SQLite is opened or any startup migration,
    // interruption, or reconciliation can run.
    let writer_lease = acquire_writer_lease(&path)?;
    let mut connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    validate_database_identity(&connection)?;
    validate_sqlite_version(&connection)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    if !connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)? {
        return Err(DatabaseError::Integrity(
            "SQLite defensive mode could not be enabled".to_owned(),
        ));
    }
    if connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)? {
        return Err(DatabaseError::Integrity(
            "SQLite trusted-schema mode could not be disabled".to_owned(),
        ));
    }
    if connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?
        || connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?
    {
        return Err(DatabaseError::Integrity(
            "SQLite double-quoted string compatibility could not be disabled".to_owned(),
        ));
    }
    let journal_mode: String =
        connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        let requested: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if !requested.eq_ignore_ascii_case("wal") {
            return Err(DatabaseError::WalUnavailable(requested));
        }
    }
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "journal_size_limit", 64 * 1024 * 1024_i64)?;
    migrations().to_latest(&mut connection)?;
    projects::reconcile_revision_retention(&mut connection)?;
    active_workspace::migrate_legacy_project_alias_index(&mut connection)?;
    connection.pragma_update(None, "application_id", APPLICATION_ID)?;
    initialize_runtime_state(&mut connection)?;
    legacy::interrupt_running(&connection)?;
    let artifact_root = artifacts::ArtifactRoot::prepare(artifact_root)?;
    artifacts::reconcile(&connection, &artifact_root)?;
    let integrity = quick_check(&connection)?;
    if integrity != "ok" {
        return Err(DatabaseError::Integrity(integrity));
    }
    let mut foreign_key_check = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_key_check.exists([])? {
        return Err(DatabaseError::Integrity(
            "foreign key validation failed".to_owned(),
        ));
    }
    drop(foreign_key_check);
    Ok((connection, artifact_root, writer_lease))
}

fn acquire_writer_lease(database_path: &Path) -> Result<WriterLease, DatabaseError> {
    {
        let mut leases = PROCESS_WRITER_LEASES
            .lock()
            .map_err(|_| DatabaseError::WriterLeaseUnavailable)?;
        if !leases.insert(database_path.to_owned()) {
            return Err(DatabaseError::WriterLeaseUnavailable);
        }
    }
    match acquire_writer_lease_file(database_path) {
        Ok(file) => Ok(WriterLease {
            file,
            database_path: database_path.to_owned(),
        }),
        Err(error) => {
            if let Ok(mut leases) = PROCESS_WRITER_LEASES.lock() {
                leases.remove(database_path);
            }
            Err(error)
        }
    }
}

fn acquire_writer_lease_file(database_path: &Path) -> Result<File, DatabaseError> {
    let file_name = database_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            DatabaseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "database file path is invalid",
            ))
        })?;
    let lease_path = database_path.with_file_name(format!(".{file_name}.writer.lock"));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;

        // Windows file locks can be reacquired by another handle in surprising same-process and
        // inherited-handle cases.  Denying every share mode makes ownership an open-handle
        // invariant as well as a byte-range lock invariant.
        options.share_mode(0);
    }
    let lease = options.open(&lease_path).map_err(|error| {
        #[cfg(windows)]
        if matches!(error.raw_os_error(), Some(32 | 33)) {
            return DatabaseError::WriterLeaseUnavailable;
        }
        DatabaseError::Io(error)
    })?;
    let metadata = fs::symlink_metadata(&lease_path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(DatabaseError::WriterLeaseUnavailable);
    }
    FileExt::try_lock_exclusive(&lease).map_err(|error| {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            DatabaseError::WriterLeaseUnavailable
        } else {
            DatabaseError::Io(error)
        }
    })?;
    Ok(lease)
}

fn canonical_database_path(path: &Path) -> Result<PathBuf, DatabaseError> {
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            DatabaseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "database file path is invalid",
            ))
        })?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    Ok(fs::canonicalize(parent)?.join(file_name))
}

pub(super) fn database_health(connection: &Connection) -> Result<DatabaseHealth, DatabaseError> {
    let schema_version = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let sqlite_version = connection.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
    let application_id = connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let journal_mode = connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    let previous_shutdown_clean = connection.query_row(
        "SELECT previous_shutdown_clean FROM app_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(DatabaseHealth {
        schema_version,
        sqlite_version,
        application_id,
        journal_mode,
        integrity: quick_check(connection)?,
        previous_shutdown_clean,
    })
}

fn validate_database_identity(connection: &Connection) -> Result<(), DatabaseError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(DatabaseError::WrongApplicationId(application_id));
    }
    let schema_version: u32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if schema_version > SCHEMA_VERSION {
        return Err(DatabaseError::FutureSchema {
            found: schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(())
}

fn validate_sqlite_version(connection: &Connection) -> Result<(), DatabaseError> {
    let version: String = connection.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
    let parse = |value: &str| {
        let mut parts = value.split('.').map(str::parse::<u32>);
        Some((
            parts.next()?.ok()?,
            parts.next()?.ok()?,
            parts.next()?.ok()?,
        ))
    };
    if parse(&version) < parse(MINIMUM_SQLITE_VERSION) {
        return Err(DatabaseError::SqliteTooOld {
            found: version,
            required: MINIMUM_SQLITE_VERSION,
        });
    }
    Ok(())
}

fn initialize_runtime_state(connection: &mut Connection) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    let timestamp = now_ms();
    transaction.execute(
        "INSERT OR IGNORE INTO app_meta(
           singleton, install_id, clean_shutdown, previous_shutdown_clean,
           last_writer_version, created_at_ms, updated_at_ms
         ) VALUES (1, ?1, 1, 1, ?2, ?3, ?3)",
        params![Uuid::now_v7(), env!("CARGO_PKG_VERSION"), timestamp],
    )?;
    transaction.execute(
        "UPDATE app_meta
         SET previous_shutdown_clean = clean_shutdown,
             clean_shutdown = 0, last_writer_version = ?1, updated_at_ms = ?2
         WHERE singleton = 1",
        params![env!("CARGO_PKG_VERSION"), timestamp],
    )?;
    jobs::interrupt_in_flight(&transaction, timestamp)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn mark_clean_shutdown(connection: &Connection) -> Result<(), DatabaseError> {
    connection.execute(
        "UPDATE app_meta SET clean_shutdown = 1, updated_at_ms = ?1 WHERE singleton = 1",
        [now_ms()],
    )?;
    Ok(())
}

pub(super) fn backup_database(
    connection: &Connection,
    destination: &Path,
) -> Result<(), DatabaseError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(DatabaseError::InvalidBackupPath)?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or(DatabaseError::InvalidBackupPath)?;
    fs::create_dir_all(parent)?;
    let parent = fs::canonicalize(parent)?;
    let destination = parent.join(file_name);
    if destination.exists() {
        return Err(DatabaseError::BackupDestinationExists);
    }
    let temporary = parent.join(format!(".{file_name}.{}.part", Uuid::now_v7()));
    let result = (|| {
        let mut backup_connection = Connection::open_with_flags(
            &temporary,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        {
            let backup = rusqlite::backup::Backup::new(connection, &mut backup_connection)?;
            backup.run_to_completion(128, Duration::from_millis(5), None)?;
        }
        let integrity = quick_check(&backup_connection)?;
        if integrity != "ok" {
            return Err(DatabaseError::Integrity(integrity));
        }
        let application_id: i64 =
            backup_connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
        if application_id != APPLICATION_ID {
            return Err(DatabaseError::WrongApplicationId(application_id));
        }
        drop(backup_connection);
        fs::hard_link(&temporary, &destination)?;
        let _ = fs::remove_file(&temporary);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn quick_check(connection: &Connection) -> Result<String, DatabaseError> {
    connection
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(Into::into)
}
