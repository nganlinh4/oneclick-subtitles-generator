//! Media-ownership upgrades (v5-v6): artifact job links, writer provenance backfill, and link repair.

use super::*;

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

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "exact v5 writer-shape migration fixture"
)]
fn v5_upgrade_backfills_only_genuine_media_writer_provenance() {
    let mut connection = Connection::open_in_memory().expect("open database");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("foreign keys");
    migrations()
        .to_version(&mut connection, 5)
        .expect("create version five database");
    let owner = Uuid::now_v7();
    let other = Uuid::now_v7();
    let source = Uuid::now_v7();
    seed_source_media(&connection, source);
    let download_job = seed_job(&connection, "downloadMedia", "succeeded");
    let process_job = seed_job(&connection, "processMedia", "succeeded");
    let (download_media, download_artifact) = seed_writer_pair(
        &connection,
        "video",
        "legacy.mp4",
        "mp4",
        "downloadedMedia",
        &json!({"source": "urlDownload", "filename": "legacy.mp4"}),
        0x10,
        Some(download_job),
    );
    let pairs = [
        (download_media, download_artifact),
        seed_writer_pair(
            &connection,
            "video",
            "prepared-media.mp4",
            "mp4",
            "preparedMedia",
            &json!({"operation": "preparePlayback", "sourceAssetId": source}),
            0x11,
            Some(process_job),
        ),
        seed_writer_pair(
            &connection,
            "video",
            "analysis-clip.mp4",
            "mp4",
            "analysisClip",
            &json!({
                "operation": "analysisClip", "sourceAssetId": source,
                "startUs": 7, "endUs": 19
            }),
            0x12,
            Some(process_job),
        ),
        seed_writer_pair(
            &connection,
            "audio",
            "extracted-audio.m4a",
            "m4a",
            "extractedAudio",
            &json!({
                "operation": "extractAudio", "sourceAssetId": source,
                "format": "m4a", "startUs": 0, "endUs": null
            }),
            0x13,
            Some(process_job),
        ),
    ];
    let (orphaned_media, orphaned_artifact) = seed_writer_pair(
        &connection,
        "video",
        "prepared-media.mp4",
        "mp4",
        "preparedMedia",
        &json!({
            "operation": "preparePlayback", "sourceAssetId": Uuid::now_v7()
        }),
        0x14,
        Some(process_job),
    );
    let cache_artifact = Uuid::now_v7();
    let unrelated_artifact = Uuid::now_v7();
    let content_hash = [0x10_u8; 32];
    connection
        .execute(
            "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                 VALUES (?1, 'Owner', 0, 1, 1), (?2, 'Other', 0, 1, 1)",
            params![owner, other],
        )
        .expect("seed projects");
    connection
        .execute(
            "INSERT INTO project_media(project_id, media_id, role, ordinal)
                 VALUES (?1, ?2, 'primary', 0)",
            params![owner, download_media],
        )
        .expect("seed project media");
    connection
        .execute(
            "INSERT INTO artifacts(
                   id, kind, relative_path, content_hash, size_bytes, retention, state,
                   metadata_json, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'waveformCache', 'cache/same-content', ?2, 8, 'cache', 'ready',
                           '{}', 3, 3)",
            params![cache_artifact, content_hash.as_slice()],
        )
        .expect("seed same-content cache artifact");
    connection
        .execute(
            "INSERT INTO artifacts(
                   id, kind, relative_path, content_hash, size_bytes, retention, state,
                   metadata_json, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'unrelatedDocument', 'documents/same-content', ?2, 8,
                           'durable', 'ready', '{}', 3, 3)",
            params![unrelated_artifact, content_hash.as_slice()],
        )
        .expect("seed unrelated durable content collision");

    migrations()
        .to_latest(&mut connection)
        .expect("upgrade ownership schema");

    for (media, artifact) in pairs {
        let (linked, branded): (bool, bool) = connection
            .query_row(
                "SELECT EXISTS(
                       SELECT 1 FROM media_artifacts
                       WHERE media_id = ?1 AND artifact_id = ?2
                     ), COALESCE(
                       (SELECT json_extract(metadata_json, '$.osgMediaArtifact')
                        FROM artifacts WHERE id = ?2), false
                     )",
                params![media, artifact],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("genuine artifact ownership");
        assert!(linked, "genuine v5 writer row was not recovered");
        assert!(branded, "recovered row was not branded");
    }
    let orphaned_link: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_artifacts
                 WHERE media_id = ?1 AND artifact_id = ?2)",
            params![orphaned_media, orphaned_artifact],
            |row| row.get(0),
        )
        .expect("orphaned source link");
    assert!(!orphaned_link, "missing source provenance must fail closed");
    let cache_linked: bool = connection
        .query_row(
            "SELECT EXISTS(
                   SELECT 1 FROM media_artifacts
                   WHERE media_id = ?1 AND artifact_id = ?2
                 )",
            params![download_media, cache_artifact],
            |row| row.get(0),
        )
        .expect("cache collision ownership");
    assert!(!cache_linked);
    let unrelated_linked: bool = connection
        .query_row(
            "SELECT EXISTS(
                   SELECT 1 FROM media_artifacts
                   WHERE media_id = ?1 AND artifact_id = ?2
                 )",
            params![download_media, unrelated_artifact],
            |row| row.get(0),
        )
        .expect("unrelated durable collision ownership");
    assert!(!unrelated_linked);
    let unrelated_branded: bool = connection
        .query_row(
            "SELECT COALESCE(json_extract(metadata_json, '$.osgMediaArtifact'), false)
                 FROM artifacts WHERE id = ?1",
            [unrelated_artifact],
            |row| row.get(0),
        )
        .expect("unrelated durable metadata");
    assert!(!unrelated_branded);
    let (project_owner, lifecycle): (Uuid, String) = connection
        .query_row(
            "SELECT owner.project_id,
                        json_extract(media.metadata_json, '$.osgMediaLifecycle')
                 FROM media_project_owners owner
                 JOIN media_assets media ON media.id = owner.media_id
                 WHERE owner.media_id = ?1",
            [download_media],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("project ownership");
    assert_eq!(project_owner, owner);
    assert_eq!(lifecycle, "project");

    connection
        .execute(
            "DELETE FROM project_media WHERE media_id = ?1",
            [download_media],
        )
        .expect("detach current media");
    assert!(
        connection
            .execute(
                "INSERT INTO project_media(project_id, media_id, role, ordinal)
                     VALUES (?1, ?2, 'primary', 0)",
                params![other, download_media],
            )
            .is_err(),
        "history-owned media must not be reassigned after it is detached"
    );
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "persistent v6 repair and plural-claim fixture"
)]
fn already_opened_v6_repairs_invalid_links_and_preserves_plural_claims_once() {
    let database_file = NamedTempFile::new().expect("database file");
    let database_path = database_file.path().to_owned();
    let valid_job;
    let retried_job;
    let valid_media;
    let valid_artifact;
    let invalid_media;
    let invalid_artifact;
    {
        let mut connection = Connection::open(&database_path).expect("open v5 database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys");
        migrations()
            .to_version(&mut connection, 5)
            .expect("create v5 database");
        valid_job = seed_job(&connection, "processMedia", "failed");
        retried_job = seed_job(&connection, "processMedia", "succeeded");
        let source = Uuid::now_v7();
        seed_source_media(&connection, source);
        (valid_media, valid_artifact) = seed_writer_pair(
            &connection,
            "video",
            "analysis-clip.mp4",
            "mp4",
            "analysisClip",
            &json!({
                "operation": "analysisClip", "sourceAssetId": source,
                "startUs": 1, "endUs": 2,
                "osgMediaArtifact": true, "commitOnJobSuccess": true
            }),
            0x31,
            Some(valid_job),
        );
        (invalid_media, invalid_artifact) = seed_writer_pair(
            &connection,
            "video",
            "analysis-clip.mp4",
            "mp4",
            "analysisClip",
            &json!({
                "operation": "analysisClip", "sourceAssetId": source,
                "startUs": 1, "endUs": 2, "attackerControlled": true,
                "osgMediaArtifact": true
            }),
            0x32,
            Some(valid_job),
        );
        migrations()
            .to_version(&mut connection, 6)
            .expect("open v6 database");
        connection
            .execute(
                "UPDATE media_artifacts SET job_id = ?1
                     WHERE media_id = ?2 AND artifact_id = ?3",
                params![retried_job.as_uuid(), valid_media, valid_artifact],
            )
            .expect("simulate v6 retry claim");
        let v6_invalid_link: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM media_artifacts
                     WHERE media_id = ?1 AND artifact_id = ?2)",
                params![invalid_media, invalid_artifact],
                |row| row.get(0),
            )
            .expect("read poisoned v6 link");
        assert!(v6_invalid_link, "fixture must reproduce the v6 over-link");
    }

    {
        let mut connection = Connection::open(&database_path).expect("reopen v6 database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys");
        migrations()
            .to_latest(&mut connection)
            .expect("repair v6 database");
        let valid_link: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM media_artifacts
                     WHERE media_id = ?1 AND artifact_id = ?2)",
                params![valid_media, valid_artifact],
                |row| row.get(0),
            )
            .expect("valid link");
        let invalid_link: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM media_artifacts
                     WHERE media_id = ?1 AND artifact_id = ?2)",
                params![invalid_media, invalid_artifact],
                |row| row.get(0),
            )
            .expect("invalid link");
        let valid_metadata: String = connection
            .query_row(
                "SELECT metadata_json FROM artifacts WHERE id = ?1",
                [valid_artifact],
                |row| row.get(0),
            )
            .expect("valid metadata");
        assert!(valid_link, "valid metadata after repair: {valid_metadata}");
        assert!(!invalid_link, "v7 must remove the poisoned v6 edge");
        let claims: Vec<Uuid> = connection
            .prepare(
                "SELECT job_id FROM media_artifact_job_claims
                     WHERE media_id = ?1 AND artifact_id = ?2 ORDER BY job_id",
            )
            .expect("prepare claims")
            .query_map(params![valid_media, valid_artifact], |row| row.get(0))
            .expect("query claims")
            .collect::<Result<_, _>>()
            .expect("collect claims");
        assert_eq!(claims.len(), 2);
        assert!(claims.contains(&valid_job.into_uuid()));
        assert!(claims.contains(&retried_job.into_uuid()));
    }

    let mut connection = Connection::open(&database_path).expect("reopen v7 database");
    migrations()
        .to_latest(&mut connection)
        .expect("second migration pass");
    migrations()
        .to_latest(&mut connection)
        .expect("third migration pass");
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("schema version");
    assert_eq!(version, 17);
    let claim_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM media_artifact_job_claims
                 WHERE media_id = ?1 AND artifact_id = ?2",
            params![valid_media, valid_artifact],
            |row| row.get(0),
        )
        .expect("claim count");
    assert_eq!(claim_count, 2, "rerunning latest must not duplicate claims");
}
