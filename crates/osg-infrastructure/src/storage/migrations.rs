use rusqlite_migration::{M, Migrations};

pub(super) fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("sql/0001_initial.sql")),
        M::up(include_str!("sql/0002_youtube_oauth_token.sql")),
        M::up(include_str!("sql/0003_job_restore_window.sql")),
        M::up(include_str!("sql/0004_editor_track_history.sql")),
        M::up(include_str!("sql/0005_process_media_job.sql")),
        M::up(include_str!("sql/0006_media_artifact_ownership.sql")),
        M::up(include_str!("sql/0007_media_artifact_repair.sql")),
        M::up(include_str!(
            "sql/0008_media_artifact_duplicate_key_repair.sql"
        )),
        M::up(include_str!("sql/0009_job_result_deliveries.sql")),
        M::up(include_str!("sql/0010_project_speech_references.sql")),
        M::up(include_str!("sql/0011_project_render_scenes.sql")),
        M::up(include_str!("sql/0012_project_create_receipts.sql")),
        M::up(include_str!("sql/0013_legacy_default_subtitle_scale.sql")),
        M::up(include_str!(
            "sql/0014_sparse_legacy_default_subtitle_scale.sql"
        )),
    ])
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::time::{Duration, Instant};

    use osg_domain::JobId;
    use rusqlite::{Connection, params};
    use serde_json::{Value, json};
    use tempfile::NamedTempFile;
    use uuid::Uuid;

    use super::migrations;
    use crate::storage::ArtifactId;

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
        assert_eq!(version, 14);
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

    #[test]
    fn every_prior_schema_version_upgrades_to_v14_idempotently() {
        for prior_version in 1..=13 {
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
            assert_eq!(version, 14, "failed to upgrade schema v{prior_version}");
        }
    }

    fn legacy_default_subtitle_scene() -> serde_json::Value {
        json!({
            "customization": {
                "fontSize": 28,
                "fontFamily": "'Google Sans', sans-serif",
                "fontWeight": 400,
                "textColor": "#ffffff",
                "textAlign": "center",
                "lineHeight": 1.2,
                "letterSpacing": 0,
                "backgroundColor": "#000000",
                "backgroundOpacity": 70,
                "backgroundPaddingX": 16,
                "backgroundPaddingY": 8,
                "borderWidth": 0,
                "textShadowEnabled": true,
                "glowEnabled": false,
                "gradientEnabled": false,
                "strokeEnabled": false,
                "multiShadowEnabled": false,
                "pulseEnabled": false,
                "shakeEnabled": false,
                "position": "bottom",
                "marginBottom": 80,
                "marginTop": 80,
                "marginLeft": 0,
                "marginRight": 0,
                "maxWidth": 80,
                "fadeInDuration": 0.3,
                "fadeOutDuration": 0.3,
                "animationType": "fade",
                "wordWrap": true,
                "maxLines": 3,
                "preset": "default"
            }
        })
    }

    #[test]
    fn legacy_default_subtitle_scale_migrates_once_without_overwriting_custom_styles() {
        let mut connection = Connection::open_in_memory().expect("open database");
        migrations()
            .to_version(&mut connection, 12)
            .expect("prepare v12 database");
        let legacy_default = legacy_default_subtitle_scene();
        let customized = {
            let mut value = legacy_default.clone();
            value["customization"]["textColor"] = json!("#ff00ff");
            value
        };
        let current_default = {
            let mut value = legacy_default.clone();
            value["customization"]["fontSize"] = json!(48);
            value
        };
        let sparse_legacy_default = {
            let mut value = legacy_default.clone();
            value["customization"]
                .as_object_mut()
                .expect("customization object")
                .remove("backgroundPaddingX");
            value["customization"]
                .as_object_mut()
                .expect("customization object")
                .remove("backgroundPaddingY");
            value
        };

        let fixtures = [
            legacy_default,
            customized,
            current_default,
            sparse_legacy_default,
        ];
        let project_ids = [
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
        ];
        for (index, (project_id, scene)) in project_ids.iter().zip(fixtures).enumerate() {
            connection
                .execute(
                    "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 0, 1, 1)",
                    params![project_id, format!("project {index}")],
                )
                .expect("seed project");
            connection
                .execute(
                    "INSERT INTO project_render_scenes(
                        project_id, scene_revision, schema_version, scene_json, updated_at_ms
                     ) VALUES (?1, 1, 1, ?2, 1)",
                    params![project_id, scene.to_string()],
                )
                .expect("seed scene");
        }

        migrations()
            .to_latest(&mut connection)
            .expect("upgrade v12 database");

        {
            let read_scene = |project_id: Uuid| -> (i64, i64) {
                connection
                    .query_row(
                        "SELECT scene_revision,
                                json_extract(scene_json, '$.customization.fontSize')
                         FROM project_render_scenes WHERE project_id = ?1",
                        [project_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .expect("read migrated scene")
            };
            assert_eq!(read_scene(project_ids[0]), (2, 48));
            assert_eq!(read_scene(project_ids[1]), (1, 28));
            assert_eq!(read_scene(project_ids[2]), (1, 48));
            assert_eq!(read_scene(project_ids[3]), (2, 48));
        }

        migrations()
            .to_latest(&mut connection)
            .expect("repeat latest migration");
        let revision: i64 = connection
            .query_row(
                "SELECT scene_revision FROM project_render_scenes WHERE project_id = ?1",
                [project_ids[0]],
                |row| row.get(0),
            )
            .expect("read scene after repeated migration");
        assert_eq!(revision, 2);
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "persistent v7 duplicate-key repair fixture"
    )]
    fn already_opened_v7_rejects_duplicate_keys_and_preserves_exact_claims() {
        let database_file = NamedTempFile::new().expect("database file");
        let database_path = database_file.path().to_owned();
        let producer_job;
        let retry_job;
        let valid_pairs;
        let duplicate_operation_pair;
        let reverse_duplicate_operation_pair;
        let marker_true_false_pair;
        let marker_false_true_pair;
        let duplicate_unknown_pair;
        let oversized_duplicate_pair;
        let unrelated_artifact = Uuid::now_v7();
        let unrelated_metadata =
            r#"{"category":"document","nested":{"keep":null},"items":[1,true,"x"]}"#;

        {
            let mut connection = Connection::open(&database_path).expect("open v5 database");
            connection
                .pragma_update(None, "foreign_keys", "ON")
                .expect("foreign keys");
            migrations()
                .to_version(&mut connection, 5)
                .expect("create v5 database");
            producer_job = seed_job(&connection, "processMedia", "failed");
            retry_job = seed_job(&connection, "processMedia", "succeeded");
            let source = Uuid::now_v7();
            let source_text = source.to_string();
            seed_source_media(&connection, source);

            let valid_analysis = seed_writer_pair(
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
                0x41,
                Some(producer_job),
            );
            let valid_audio = seed_writer_pair(
                &connection,
                "audio",
                "extracted-audio.m4a",
                "m4a",
                "extractedAudio",
                &json!({
                    "operation": "extractAudio", "sourceAssetId": source,
                    "format": "m4a", "startUs": 0, "endUs": null,
                    "osgMediaArtifact": true, "commitOnJobSuccess": true
                }),
                0x42,
                Some(producer_job),
            );
            valid_pairs = [valid_analysis, valid_audio];
            duplicate_operation_pair = seed_writer_pair(
                &connection,
                "video",
                "analysis-clip.mp4",
                "mp4",
                "analysisClip",
                &json!({
                    "operation": "analysisClip", "sourceAssetId": source,
                    "startUs": 1, "endUs": 2, "osgMediaArtifact": true
                }),
                0x43,
                Some(producer_job),
            );
            reverse_duplicate_operation_pair = seed_writer_pair(
                &connection,
                "video",
                "analysis-clip.mp4",
                "mp4",
                "analysisClip",
                &json!({
                    "operation": "analysisClip", "sourceAssetId": source,
                    "startUs": 1, "endUs": 2, "osgMediaArtifact": true
                }),
                0x48,
                Some(producer_job),
            );
            marker_true_false_pair = seed_writer_pair(
                &connection,
                "video",
                "analysis-clip.mp4",
                "mp4",
                "analysisClip",
                &json!({
                    "operation": "analysisClip", "sourceAssetId": source,
                    "startUs": 1, "endUs": 2, "osgMediaArtifact": true
                }),
                0x44,
                Some(producer_job),
            );
            marker_false_true_pair = seed_writer_pair(
                &connection,
                "video",
                "analysis-clip.mp4",
                "mp4",
                "analysisClip",
                &json!({
                    "operation": "analysisClip", "sourceAssetId": source,
                    "startUs": 1, "endUs": 2, "osgMediaArtifact": true
                }),
                0x45,
                Some(producer_job),
            );
            duplicate_unknown_pair = seed_writer_pair(
                &connection,
                "video",
                "analysis-clip.mp4",
                "mp4",
                "analysisClip",
                &json!({
                    "operation": "analysisClip", "sourceAssetId": source,
                    "startUs": 1, "endUs": 2, "osgMediaArtifact": true
                }),
                0x46,
                Some(producer_job),
            );
            oversized_duplicate_pair = seed_writer_pair(
                &connection,
                "video",
                "analysis-clip.mp4",
                "mp4",
                "analysisClip",
                &json!({
                    "operation": "analysisClip", "sourceAssetId": source,
                    "startUs": 1, "endUs": 2, "osgMediaArtifact": true
                }),
                0x49,
                Some(producer_job),
            );

            let duplicate_operation_metadata = r#"{"operation":"analysisClip","operati\u006fn":"preparePlayback","sourceAssetId":"$SOURCE","startUs":1,"endUs":2,"osgMediaArtifact":true}"#
                .replace("$SOURCE", &source_text);
            let reverse_duplicate_operation_metadata = r#"{"operati\u006fn":"analysisClip","operation":"preparePlayback","sourceAssetId":"$SOURCE","startUs":1,"endUs":2,"osgMediaArtifact":true}"#
                .replace("$SOURCE", &source_text);
            let marker_true_false_metadata = r#"{"operation":"analysisClip","sourceAssetId":"$SOURCE","startUs":1,"endUs":2,"osgMediaArtifact":1,"osgMediaArtif\u0061ct":false}"#
                .replace("$SOURCE", &source_text);
            let marker_false_true_metadata = r#"{"operation":"analysisClip","sourceAssetId":"$SOURCE","startUs":1,"endUs":2,"osgMediaArtif\u0061ct":false,"osgMediaArtifact":true}"#
                .replace("$SOURCE", &source_text);
            let duplicate_unknown_metadata = r#"{"operation":"analysisClip","operation":"analysisClip","sourceAssetId":"$SOURCE","startUs":1,"endUs":2,"future":"discarded","future":{"string":"kept","integer":9007199254740993,"real":1.25,"boolean":false,"nullable":null,"array":[1,true,"x"],"object":{"n":null}},"topInteger":18446744073709551615,"topNegativeZero":-0.0,"topNull":null,"osgMediaArtifact":true}"#
                .replace("$SOURCE", &source_text);
            let mut oversized_duplicate_metadata = String::with_capacity(200_000);
            oversized_duplicate_metadata.push('{');
            for value in 0..10_000 {
                if value > 0 {
                    oversized_duplicate_metadata.push(',');
                }
                write!(&mut oversized_duplicate_metadata, "\"duplicate\":{value}")
                    .expect("build oversized metadata");
            }
            oversized_duplicate_metadata.push_str(",\"osgMediaArtifact\":true}");
            for (artifact_id, metadata) in [
                (duplicate_operation_pair.1, duplicate_operation_metadata),
                (
                    reverse_duplicate_operation_pair.1,
                    reverse_duplicate_operation_metadata,
                ),
                (marker_true_false_pair.1, marker_true_false_metadata),
                (marker_false_true_pair.1, marker_false_true_metadata),
                (duplicate_unknown_pair.1, duplicate_unknown_metadata),
                (oversized_duplicate_pair.1, oversized_duplicate_metadata),
            ] {
                connection
                    .execute(
                        "UPDATE artifacts SET metadata_json = ?1 WHERE id = ?2",
                        params![metadata, artifact_id],
                    )
                    .expect("install raw duplicate-key metadata");
            }
            connection
                .execute(
                    "INSERT INTO artifacts(
                       id, kind, relative_path, content_hash, size_bytes, retention, state,
                       metadata_json, created_at_ms, updated_at_ms
                     ) VALUES (?1, 'unrelatedDocument', 'documents/unrelated-v8', ?2, 8,
                               'durable', 'ready', ?3, 3, 3)",
                    params![
                        unrelated_artifact,
                        [0x47_u8; 32].as_slice(),
                        unrelated_metadata
                    ],
                )
                .expect("seed unrelated artifact");

            migrations()
                .to_version(&mut connection, 6)
                .expect("create v6 database");
            for (media_id, artifact_id) in valid_pairs {
                connection
                    .execute(
                        "UPDATE media_artifacts SET job_id = ?1
                         WHERE media_id = ?2 AND artifact_id = ?3",
                        params![retry_job.as_uuid(), media_id, artifact_id],
                    )
                    .expect("install retry claim");
            }
            migrations()
                .to_version(&mut connection, 7)
                .expect("create vulnerable v7 database");
            let version: i64 = connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("v7 schema version");
            assert_eq!(version, 7);

            // These two rows fail v7's first-occurrence checks, but represent possible persisted
            // v7 state.  v8 must reject every duplicate-key edge independent of key order.
            for (media_id, artifact_id) in [
                marker_false_true_pair,
                duplicate_unknown_pair,
                oversized_duplicate_pair,
            ] {
                connection
                    .execute(
                        "INSERT INTO media_artifacts(media_id, artifact_id, created_at_ms)
                         VALUES (?1, ?2, 3)",
                        params![media_id, artifact_id],
                    )
                    .expect("install non-exact v7 edge");
            }
            for (media_id, artifact_id) in [
                duplicate_operation_pair,
                reverse_duplicate_operation_pair,
                marker_true_false_pair,
                marker_false_true_pair,
                duplicate_unknown_pair,
                oversized_duplicate_pair,
            ] {
                connection
                    .execute(
                        "INSERT OR IGNORE INTO media_artifact_job_claims(
                           media_id, artifact_id, job_id, created_at_ms
                         ) VALUES (?1, ?2, ?3, 3)",
                        params![media_id, artifact_id, retry_job.as_uuid()],
                    )
                    .expect("install non-exact v7 claim");
                let edge_exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM media_artifacts
                         WHERE media_id = ?1 AND artifact_id = ?2)",
                        params![media_id, artifact_id],
                        |row| row.get(0),
                    )
                    .expect("read v7 edge");
                assert!(edge_exists, "fixture must contain the non-exact v7 edge");
            }
            let sqlite_operation: String = connection
                .query_row(
                    "SELECT json_extract(metadata_json, '$.operation')
                     FROM artifacts WHERE id = ?1",
                    [duplicate_operation_pair.1],
                    |row| row.get(0),
                )
                .expect("SQLite operation");
            let raw_operation: String = connection
                .query_row(
                    "SELECT metadata_json FROM artifacts WHERE id = ?1",
                    [duplicate_operation_pair.1],
                    |row| row.get(0),
                )
                .expect("raw operation metadata");
            let serde_operation = serde_json::from_str::<Value>(&raw_operation)
                .expect("parse operation metadata")["operation"]
                .as_str()
                .expect("serde operation")
                .to_owned();
            assert_eq!(sqlite_operation, "analysisClip");
            assert_eq!(serde_operation, "preparePlayback");
            let raw_marker: String = connection
                .query_row(
                    "SELECT metadata_json FROM artifacts WHERE id = ?1",
                    [marker_true_false_pair.1],
                    |row| row.get(0),
                )
                .expect("raw marker metadata");
            assert_eq!(
                serde_json::from_str::<Value>(&raw_marker).expect("parse marker metadata")["osgMediaArtifact"],
                json!(false),
                "v7 must reproduce SQLite-first/serde-last marker disagreement"
            );
        }

        {
            let mut connection = Connection::open(&database_path).expect("reopen v7 database");
            connection
                .pragma_update(None, "foreign_keys", "ON")
                .expect("foreign keys");
            let migration_started = Instant::now();
            migrations()
                .to_latest(&mut connection)
                .expect("repair v7 database");
            let migration_elapsed = migration_started.elapsed();
            assert!(
                migration_elapsed < Duration::from_secs(5),
                "oversized duplicate-key repair took {migration_elapsed:?}"
            );

            for (media_id, artifact_id) in [
                duplicate_operation_pair,
                reverse_duplicate_operation_pair,
                marker_true_false_pair,
                marker_false_true_pair,
                duplicate_unknown_pair,
                oversized_duplicate_pair,
            ] {
                let (edge_count, claim_count): (i64, i64) = connection
                    .query_row(
                        "SELECT
                           (SELECT COUNT(*) FROM media_artifacts
                            WHERE media_id = ?1 AND artifact_id = ?2),
                           (SELECT COUNT(*) FROM media_artifact_job_claims
                            WHERE media_id = ?1 AND artifact_id = ?2)",
                        params![media_id, artifact_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .expect("repaired edge and claims");
                assert_eq!(edge_count, 0);
                assert_eq!(claim_count, 0);
                let metadata: String = connection
                    .query_row(
                        "SELECT metadata_json FROM artifacts WHERE id = ?1",
                        [artifact_id],
                        |row| row.get(0),
                    )
                    .expect("repaired metadata");
                let parsed: Value = serde_json::from_str(&metadata).expect("parse repaired JSON");
                assert!(parsed.get("osgMediaArtifact").is_none());
                let (marker_type, marker_count): (Option<String>, i64) = connection
                    .query_row(
                        "SELECT json_type(metadata_json, '$.osgMediaArtifact'),
                                (SELECT COUNT(*) FROM json_each(metadata_json)
                                 WHERE key = 'osgMediaArtifact')
                         FROM artifacts WHERE id = ?1",
                        [artifact_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .expect("unbranded invalid metadata");
                assert_eq!(marker_type, None);
                assert_eq!(marker_count, 0);
            }

            for (_, artifact_id) in [duplicate_operation_pair, reverse_duplicate_operation_pair] {
                let sqlite_operation_after: String = connection
                    .query_row(
                        "SELECT json_extract(metadata_json, '$.operation')
                         FROM artifacts WHERE id = ?1",
                        [artifact_id],
                        |row| row.get(0),
                    )
                    .expect("SQLite operation after repair");
                let operation_metadata: String = connection
                    .query_row(
                        "SELECT metadata_json FROM artifacts WHERE id = ?1",
                        [artifact_id],
                        |row| row.get(0),
                    )
                    .expect("operation metadata after repair");
                assert_eq!(sqlite_operation_after, "analysisClip");
                assert_eq!(
                    serde_json::from_str::<Value>(&operation_metadata)
                        .expect("parse preserved operation")["operation"],
                    json!("preparePlayback")
                );
                let operation_count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM json_each(?1) WHERE key = 'operation'",
                        [&operation_metadata],
                        |row| row.get(0),
                    )
                    .expect("preserved operation count");
                assert_eq!(operation_count, 2);
            }

            let preserved_metadata: String = connection
                .query_row(
                    "SELECT metadata_json FROM artifacts WHERE id = ?1",
                    [duplicate_unknown_pair.1],
                    |row| row.get(0),
                )
                .expect("preserved metadata");
            let preserved: Value =
                serde_json::from_str(&preserved_metadata).expect("parse preserved metadata");
            assert_eq!(
                preserved["future"],
                json!({
                    "string": "kept",
                    "integer": 9_007_199_254_740_993_u64,
                    "real": 1.25,
                    "boolean": false,
                    "nullable": null,
                    "array": [1, true, "x"],
                    "object": {"n": null}
                })
            );
            assert_eq!(preserved["topInteger"], json!(u64::MAX));
            assert!(
                preserved["topNegativeZero"]
                    .as_f64()
                    .expect("negative zero")
                    .is_sign_negative()
            );
            assert!(preserved["topNull"].is_null());
            assert!(
                preserved_metadata.contains("\"topInteger\":18446744073709551615"),
                "out-of-i64 integer must retain its exact JSON token"
            );
            assert!(
                preserved_metadata.contains("\"topNegativeZero\":-0.0"),
                "signed zero must retain its exact JSON token"
            );
            let oversized_after: String = connection
                .query_row(
                    "SELECT metadata_json FROM artifacts WHERE id = ?1",
                    [oversized_duplicate_pair.1],
                    |row| row.get(0),
                )
                .expect("oversized metadata");
            assert_eq!(oversized_after, "{}");
            let preserved_types: (String, String, String, String, String, String, String) =
                connection
                    .query_row(
                        "SELECT json_type(future.value, '$.string'),
                                json_type(future.value, '$.integer'),
                                json_type(future.value, '$.real'),
                                json_type(future.value, '$.boolean'),
                                json_type(future.value, '$.nullable'),
                                json_type(future.value, '$.array'),
                                json_type(future.value, '$.object')
                         FROM artifacts AS artifact,
                              json_each(artifact.metadata_json) AS future
                         WHERE artifact.id = ?1
                           AND future.key = 'future'
                           AND future.type = 'object'",
                        [duplicate_unknown_pair.1],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                                row.get(6)?,
                            ))
                        },
                    )
                    .expect("preserved JSON types");
            assert_eq!(
                preserved_types,
                (
                    "text".to_owned(),
                    "integer".to_owned(),
                    "real".to_owned(),
                    "false".to_owned(),
                    "null".to_owned(),
                    "array".to_owned(),
                    "object".to_owned(),
                )
            );

            for (media_id, artifact_id) in valid_pairs {
                let claims: Vec<Uuid> = connection
                    .prepare(
                        "SELECT job_id FROM media_artifact_job_claims
                         WHERE media_id = ?1 AND artifact_id = ?2 ORDER BY job_id",
                    )
                    .expect("prepare exact claims")
                    .query_map(params![media_id, artifact_id], |row| row.get(0))
                    .expect("query exact claims")
                    .collect::<Result<_, _>>()
                    .expect("collect exact claims");
                assert_eq!(claims.len(), 2);
                assert!(claims.contains(&producer_job.into_uuid()));
                assert!(claims.contains(&retry_job.into_uuid()));
                let (marker_type, marker_count, marker_value, raw_metadata): (
                    String,
                    i64,
                    bool,
                    String,
                ) = connection
                    .query_row(
                        "SELECT json_type(metadata_json, '$.osgMediaArtifact'),
                                (SELECT COUNT(*) FROM json_each(metadata_json)
                                 WHERE key = 'osgMediaArtifact'),
                                json_extract(metadata_json, '$.osgMediaArtifact'),
                                metadata_json
                         FROM artifacts WHERE id = ?1",
                        [artifact_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .expect("canonical exact marker");
                assert_eq!(marker_type, "true");
                assert_eq!(marker_count, 1);
                assert!(marker_value);
                assert_eq!(
                    serde_json::from_str::<Value>(&raw_metadata).expect("parse exact metadata")["osgMediaArtifact"],
                    json!(marker_value)
                );
            }
            let valid_audio_metadata: String = connection
                .query_row(
                    "SELECT metadata_json FROM artifacts WHERE id = ?1",
                    [valid_pairs[1].1],
                    |row| row.get(0),
                )
                .expect("valid audio metadata");
            assert!(
                serde_json::from_str::<Value>(&valid_audio_metadata)
                    .expect("parse valid audio metadata")["endUs"]
                    .is_null()
            );
            let unrelated_after: String = connection
                .query_row(
                    "SELECT metadata_json FROM artifacts WHERE id = ?1",
                    [unrelated_artifact],
                    |row| row.get(0),
                )
                .expect("unrelated metadata");
            assert_eq!(unrelated_after, unrelated_metadata);
        }

        let mut connection = Connection::open(&database_path).expect("reopen v14 database");
        migrations()
            .to_latest(&mut connection)
            .expect("repeat latest after reopen");
        migrations()
            .to_latest(&mut connection)
            .expect("repeat latest again");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, 14);
        for (media_id, artifact_id) in valid_pairs {
            let claim_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM media_artifact_job_claims
                     WHERE media_id = ?1 AND artifact_id = ?2",
                    params![media_id, artifact_id],
                    |row| row.get(0),
                )
                .expect("exact claim count after repeat");
            assert_eq!(claim_count, 2);
        }
    }
}
