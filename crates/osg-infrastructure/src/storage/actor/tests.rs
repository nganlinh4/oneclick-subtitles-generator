use std::collections::BTreeMap;
use std::process::Command;
use std::sync::mpsc::sync_channel;
use std::{env, fs};

use osg_domain::{JobKind, JobSnapshot, JobState};
use rusqlite::params;
use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;

use super::artifact_requests::ArtifactRequest;
use super::{APPLICATION_ID, Database, Request, SCHEMA_VERSION};
use crate::secrets::{CredentialId, CredentialPurpose, CredentialState};
use crate::storage::{
    ArtifactDraft, ArtifactId, ArtifactKind, ArtifactRegistration, CacheCategory, CacheKey,
    CacheWrite, ContentHash, DatabaseError,
};

mod credentials;
mod handles;
mod settings;

const WRITER_LEASE_PROBE_PATH: &str = "OSG_WRITER_LEASE_PROBE_PATH";
const WRITER_LEASE_PROBE_EXPECTATION: &str = "OSG_WRITER_LEASE_PROBE_EXPECTATION";

fn database() -> (TempDir, Database) {
    let directory = TempDir::new().expect("temporary directory");
    let database =
        Database::open(directory.path().join("db/osg.sqlite3")).expect("open migrated database");
    (directory, database)
}

fn publish_durable_artifact(database: &Database, bytes: &[u8]) -> ArtifactId {
    let draft = ArtifactDraft::new(
        ArtifactKind::new("testArtifact").expect("artifact kind"),
        ContentHash::digest(bytes),
        bytes.len() as u64,
        json!({"fixture": true}),
    )
    .expect("artifact draft");
    let ArtifactRegistration::Staging(staging) = database
        .register_artifact(&draft)
        .expect("register artifact")
    else {
        panic!("test content must create a new artifact");
    };
    fs::write(staging.path(), bytes).expect("write staged artifact");
    let id = staging.record().id();
    database.mark_artifact_ready(id).expect("publish artifact");
    id
}

#[test]
fn initializes_a_wal_database_with_a_valid_schema() {
    let (_directory, database) = database();

    let health = database.health().expect("database health");

    assert_eq!(health.schema_version, SCHEMA_VERSION);
    assert_eq!(health.application_id, APPLICATION_ID);
    assert!(health.sqlite_version.starts_with("3."));
    assert_eq!(health.journal_mode.to_ascii_lowercase(), "wal");
    assert_eq!(health.integrity, "ok");
    assert!(health.previous_shutdown_clean);
}

#[cfg(unix)]
#[test]
fn opens_beneath_a_symlinked_ancestor_without_disabling_sqlite_nofollow() {
    use std::os::unix::fs::symlink;

    let directory = TempDir::new().expect("temporary directory");
    let real = directory.path().join("real");
    fs::create_dir_all(&real).expect("real directory");
    let alias = directory.path().join("alias");
    symlink(&real, &alias).expect("directory alias");

    let database = Database::open(alias.join("db/osg.sqlite3"))
        .expect("open through a trusted symlinked ancestor");

    assert_eq!(
        database.health().expect("database health").application_id,
        APPLICATION_ID
    );
    assert!(real.join("db/osg.sqlite3").is_file());
}

#[test]
fn migrates_v1_credentials_and_cooldowns_before_accepting_oauth_tokens() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("db/osg.sqlite3");
    fs::create_dir_all(path.parent().expect("database parent")).expect("create database directory");
    let legacy_id = CredentialId::new();
    let connection = rusqlite::Connection::open(&path).expect("create v1 database");
    connection
        .execute_batch(include_str!("../sql/0001_initial.sql"))
        .expect("install v1 schema");
    connection
        .pragma_update(None, "user_version", 1_u32)
        .expect("mark v1 schema");
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .expect("set application id");
    connection
        .execute(
            "INSERT INTO credential_refs(
                   id, purpose, status, last_four, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'youtube_oauth_client', 'ready', 'ient', 10, 20)",
            [legacy_id.as_uuid()],
        )
        .expect("insert v1 credential");
    connection
        .execute(
            "INSERT INTO credential_cooldowns(credential_id, resource, until_ms, reason)
                 VALUES (?1, ?2, ?3, ?4)",
            params![legacy_id.as_uuid(), "youtube", 9_999_i64, "fixture"],
        )
        .expect("insert v1 cooldown");
    drop(connection);

    let database = Database::open(&path).expect("upgrade v1 database");
    assert_eq!(
        database.health().expect("database health").schema_version,
        SCHEMA_VERSION
    );
    let clients = database
        .credential_list(Some(CredentialPurpose::YouTubeOauthClient))
        .expect("list migrated client");
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].id, legacy_id);
    assert_eq!(clients[0].state, CredentialState::Ready);
    database
        .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeOauthToken)
        .expect("new OAuth token purpose works after migration");
    drop(database);

    let upgraded = rusqlite::Connection::open(path).expect("inspect upgraded database");
    let cooldown_count: i64 = upgraded
        .query_row(
            "SELECT COUNT(*) FROM credential_cooldowns
                 WHERE credential_id = ?1 AND resource = 'youtube' AND reason = 'fixture'",
            [legacy_id.as_uuid()],
            |row| row.get(0),
        )
        .expect("read migrated cooldown");
    assert_eq!(cooldown_count, 1);
    let restore_index_count: i64 = upgraded
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema
                 WHERE type = 'index' AND name = 'jobs_state_updated_idx'",
            [],
            |row| row.get(0),
        )
        .expect("read bounded job restore index");
    assert_eq!(restore_index_count, 1);
}

#[test]
fn records_a_clean_actor_shutdown_for_the_next_start() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("db/osg.sqlite3");
    let database = Database::open(&path).expect("first open");
    drop(database);

    let reopened = Database::open(&path).expect("reopen after clean shutdown");

    assert!(
        reopened
            .health()
            .expect("database health")
            .previous_shutdown_clean
    );
}

#[test]
fn writer_lease_prevents_a_second_startup_from_interrupting_live_work() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("db/osg.sqlite3");
    let first = Database::open(&path).expect("first writer");
    let mut running = JobSnapshot::new(JobKind::DownloadMedia);
    first.create_job(&running).expect("create job");
    let sequence = running.sequence();
    running.start().expect("start job");
    first
        .compare_and_swap_job(sequence, &running)
        .expect("persist running job");

    assert!(matches!(
        Database::open(&path),
        Err(DatabaseError::WriterLeaseUnavailable)
    ));
    assert_eq!(
        first
            .get_job(running.id())
            .expect("read live job")
            .expect("live job exists")
            .state(),
        JobState::Running
    );

    drop(first);
    let recovered = Database::open(&path).expect("writer after lease release");
    assert_eq!(
        recovered
            .get_job(running.id())
            .expect("read recovered job")
            .expect("recovered job exists")
            .state(),
        JobState::Interrupted
    );
}

#[test]
fn writer_lease_probe_child() {
    let Some(path) = env::var_os(WRITER_LEASE_PROBE_PATH) else {
        return;
    };
    let expectation = env::var(WRITER_LEASE_PROBE_EXPECTATION).expect("probe expectation");
    let result = Database::open(path);
    match expectation.as_str() {
        "contended" => assert!(matches!(result, Err(DatabaseError::WriterLeaseUnavailable))),
        "available" => assert!(result.is_ok()),
        _ => panic!("unexpected writer lease probe expectation"),
    }
}

#[test]
fn writer_lease_is_enforced_across_processes_before_recovery() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("db/osg.sqlite3");
    let database = Database::open(&path).expect("first writer");
    let mut running = JobSnapshot::new(JobKind::DownloadMedia);
    database.create_job(&running).expect("create job");
    let sequence = running.sequence();
    running.start().expect("start job");
    database
        .compare_and_swap_job(sequence, &running)
        .expect("persist running job");

    run_writer_lease_probe(&path, "contended");
    assert_eq!(
        database
            .get_job(running.id())
            .expect("read live job")
            .expect("live job exists")
            .state(),
        JobState::Running
    );
    drop(database);

    run_writer_lease_probe(&path, "available");
    let recovered = Database::open(&path).expect("inspect child recovery");
    assert_eq!(
        recovered
            .get_job(running.id())
            .expect("read recovered job")
            .expect("recovered job exists")
            .state(),
        JobState::Interrupted
    );
}

fn run_writer_lease_probe(path: &std::path::Path, expectation: &str) {
    let output = Command::new(env::current_exe().expect("current test executable"))
        .args([
            "--exact",
            "storage::actor::tests::writer_lease_probe_child",
            "--nocapture",
        ])
        .env(WRITER_LEASE_PROBE_PATH, path)
        .env(WRITER_LEASE_PROBE_EXPECTATION, expectation)
        .output()
        .expect("run writer lease probe process");
    assert!(
        output.status.success(),
        "writer lease probe failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn refuses_a_database_owned_by_another_application() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("foreign.sqlite3");
    let connection = rusqlite::Connection::open(&path).expect("create foreign database");
    connection
        .pragma_update(None, "application_id", 123_i64)
        .expect("set foreign application id");
    drop(connection);

    assert!(matches!(
        Database::open(path),
        Err(DatabaseError::WrongApplicationId(123))
    ));
}

#[test]
fn refuses_a_schema_created_by_a_newer_application() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("future.sqlite3");
    let connection = rusqlite::Connection::open(&path).expect("create future database");
    connection
        .pragma_update(None, "user_version", 99_u32)
        .expect("set future schema version");
    drop(connection);

    assert!(matches!(
        Database::open(path),
        Err(DatabaseError::FutureSchema {
            found: 99,
            supported: SCHEMA_VERSION
        })
    ));
}
