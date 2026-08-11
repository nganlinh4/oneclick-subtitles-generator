use rusqlite_migration::{M, Migrations};

pub(super) fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("sql/0001_initial.sql")),
        M::up(include_str!("sql/0002_youtube_oauth_token.sql")),
        M::up(include_str!("sql/0003_job_restore_window.sql")),
        M::up(include_str!("sql/0004_editor_track_history.sql")),
        M::up(include_str!("sql/0005_process_media_job.sql")),
    ])
}

#[cfg(test)]
mod tests {
    use osg_domain::JobId;
    use rusqlite::{Connection, params};

    use super::migrations;
    use crate::storage::ArtifactId;

    #[test]
    fn process_media_upgrade_preserves_artifact_job_links() {
        let mut connection = Connection::open_in_memory().expect("open database");
        migrations()
            .to_version(&mut connection, 4)
            .expect("create version four database");
        let job_id = JobId::new();
        let artifact_id = ArtifactId::new();
        connection
            .execute(
                "INSERT INTO jobs (
                    id, kind, state, sequence, progress_basis_points, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'renderVideo', 'succeeded', ?2, 10000, 1, 2)",
                params![job_id.as_uuid(), 1_u64.to_be_bytes().as_slice()],
            )
            .expect("seed job");
        connection
            .execute(
                "INSERT INTO artifacts (
                    id, job_id, kind, relative_path, content_hash, size_bytes,
                    retention, state, metadata_json, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, 'test', 'test/artifact', ?3, 1,
                    'durable', 'ready', '{}', 1, 2)",
                params![
                    artifact_id.as_uuid(),
                    job_id.as_uuid(),
                    [7_u8; 32].as_slice()
                ],
            )
            .expect("seed linked artifact");

        migrations()
            .to_latest(&mut connection)
            .expect("upgrade database");

        let linked_job: Vec<u8> = connection
            .query_row(
                "SELECT job_id FROM artifacts WHERE id = ?1",
                [artifact_id.as_uuid()],
                |row| row.get(0),
            )
            .expect("read preserved link");
        assert_eq!(linked_job, job_id.as_uuid().as_bytes());
        connection
            .execute(
                "INSERT INTO jobs (
                    id, kind, state, sequence, progress_basis_points, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'processMedia', 'queued', ?2, 0, 3, 3)",
                params![JobId::new().as_uuid(), 0_u64.to_be_bytes().as_slice()],
            )
            .expect("persist process-media job");
    }
}
