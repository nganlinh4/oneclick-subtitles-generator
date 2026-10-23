use std::fmt::Write as _;
use std::time::{Duration, Instant};

use osg_domain::JobId;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tempfile::NamedTempFile;
use uuid::Uuid;

use super::migrations;
use crate::storage::ArtifactId;

mod duplicate_key_repair;
mod media_ownership;
mod subtitle_scale;
mod transcripts;

fn seed_job(connection: &Connection, kind: &str, state: &str) -> JobId {
    let id = JobId::new();
    connection
        .execute(
            "INSERT INTO jobs (
                    id, kind, state, sequence, progress_basis_points, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, 10000, 1, 2)",
            params![id.as_uuid(), kind, state, 1_u64.to_be_bytes().as_slice()],
        )
        .expect("seed job");
    id
}

fn seed_source_media(connection: &Connection, id: Uuid) {
    connection
        .execute(
            "INSERT INTO media_assets(
                   id, kind, display_name, extension, size_bytes, content_hash,
                   metadata_json, created_at_ms
                 ) VALUES (?1, 'video', 'source.mp4', 'mp4', 1, NULL, '{}', 1)",
            [id],
        )
        .expect("seed source media");
}

#[allow(clippy::too_many_arguments, reason = "migration writer-shape fixture")]
fn seed_writer_pair(
    connection: &Connection,
    media_kind: &str,
    display_name: &str,
    extension: &str,
    artifact_kind: &str,
    metadata: &Value,
    hash_byte: u8,
    job_id: Option<JobId>,
) -> (Uuid, Uuid) {
    let media = Uuid::now_v7();
    let artifact = Uuid::now_v7();
    let content_hash = [hash_byte; 32];
    connection
        .execute(
            "INSERT INTO media_assets(
                   id, kind, display_name, extension, size_bytes, content_hash,
                   metadata_json, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, 8, ?5, '{}', 2)",
            params![
                media,
                media_kind,
                display_name,
                extension,
                content_hash.as_slice()
            ],
        )
        .expect("seed media");
    connection
        .execute(
            "INSERT INTO artifacts(
                   id, job_id, kind, relative_path, content_hash, size_bytes, retention, state,
                   metadata_json, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 8, 'durable', 'ready', ?6, 3, 3)",
            params![
                artifact,
                job_id.map(JobId::into_uuid),
                artifact_kind,
                format!("migration/{artifact}"),
                content_hash.as_slice(),
                metadata.to_string()
            ],
        )
        .expect("seed artifact");
    (media, artifact)
}

#[test]
fn every_prior_schema_version_upgrades_to_v17_idempotently() {
    for prior_version in 1..=16 {
        let database_file = NamedTempFile::new().expect("database file");
        let database_path = database_file.path();
        {
            let mut connection = Connection::open(database_path).expect("open database");
            migrations()
                .to_version(&mut connection, prior_version)
                .expect("create prior-version database");
        }
        {
            let mut connection = Connection::open(database_path).expect("reopen database");
            migrations()
                .to_latest(&mut connection)
                .expect("upgrade prior-version database");
            migrations()
                .to_latest(&mut connection)
                .expect("repeat latest migration");
        }
        let mut connection = Connection::open(database_path).expect("reopen latest database");
        migrations()
            .to_latest(&mut connection)
            .expect("repeat latest after reopen");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, 17, "failed to upgrade schema v{prior_version}");
    }
}
