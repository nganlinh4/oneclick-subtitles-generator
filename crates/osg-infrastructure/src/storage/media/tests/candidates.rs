//! Candidate lifecycle: identity, cache-clear protection, discard, expiry, aliases, and dedup.

use super::*;

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one cache-clear safety scenario verifies every protected storage class and the one disposable class together"
)]
fn cache_clear_preserves_active_project_media_and_shared_package_roots() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("data/db/osg.sqlite3");
    let artifact_root = directory.path().join("data/artifacts");
    let source_path = directory.path().join("user-imports/source.mp4");
    let native_tool_path = directory.path().join("data/native-tools/v1/ffmpeg.exe");
    let model_path = directory.path().join("cache/v1/asr/model.bin");
    for parent in [
        source_path.parent(),
        native_tool_path.parent(),
        model_path.parent(),
    ] {
        std::fs::create_dir_all(parent.expect("sentinel parent")).expect("create sentinel root");
    }
    let source_bytes = vec![0x53; 32 * 1024];
    std::fs::write(&source_path, &source_bytes).expect("write source media");
    std::fs::write(&native_tool_path, b"managed native tool").expect("write tool sentinel");
    std::fs::write(&model_path, b"managed model package").expect("write model sentinel");

    let database =
        crate::storage::Database::open_with_artifact_root(&database_path, &artifact_root)
            .expect("database");
    let asset = MediaAsset::new(
        "downloaded-source.mp4",
        "mp4",
        u64::try_from(source_bytes.len()).expect("source size"),
        MediaKind::Video,
    )
    .expect("media asset");
    let mut job = JobSnapshot::new(JobKind::DownloadMedia);
    database.create_job(&job).expect("download job");
    let published = publish_durable_media_candidate(
        &database,
        job.id(),
        ArtifactKind::new("downloadedMedia").expect("download kind"),
        asset.clone(),
        &source_path,
        serde_json::json!({
            "source": "urlDownload",
            "filename": asset.display_name(),
        }),
    )
    .expect("publish downloaded media");
    complete_queued_job(&database, &mut job);
    let (project, _, attached_version) =
        attach_media_to_new_project(&database, "cache safety", &asset);

    let media_category = CacheCategory::new("downloadedMedia").expect("media category");
    let media_key =
        CacheKey::derive(&media_category, 1, &[b"project-media"]).expect("media cache key");
    database
        .put_cache_entry(
            &CacheWrite::new(media_key, published.artifact_id(), media_category, 1, None)
                .expect("media cache edge"),
        )
        .expect("put media cache edge");

    // Reproduce the invalid ownership shape accepted by versions before the registration
    // guard: the bytes are project media, but the artifact row claims cache retention.
    let legacy = rusqlite::Connection::open(&database_path).expect("legacy repair fixture");
    assert_eq!(
        legacy
            .execute(
                "UPDATE artifacts SET retention = 'cache' WHERE id = ?1",
                [published.artifact_id().as_uuid()],
            )
            .expect("seed legacy cache retention"),
        1
    );
    drop(legacy);

    let transient_bytes = b"rebuildable waveform peaks";
    let transient_draft = ArtifactDraft::new_cache(
        ArtifactKind::new("waveform").expect("waveform kind"),
        ContentHash::digest(transient_bytes),
        u64::try_from(transient_bytes.len()).expect("transient size"),
        serde_json::json!({"fixture": true}),
    )
    .expect("transient draft");
    let transient_stage = match database
        .register_artifact(&transient_draft)
        .expect("register transient")
    {
        ArtifactRegistration::Staging(stage) => stage,
        ArtifactRegistration::Existing(_) | ArtifactRegistration::Pending(_) => {
            panic!("transient fixture must be newly staged")
        }
    };
    std::fs::write(transient_stage.path(), transient_bytes).expect("write transient bytes");
    let transient_id = transient_stage.record().id();
    database
        .mark_artifact_ready(transient_id)
        .expect("publish transient");
    let transient_category = CacheCategory::new("waveform").expect("waveform category");
    let transient_key =
        CacheKey::derive(&transient_category, 1, &[b"waveform"]).expect("waveform cache key");
    database
        .put_cache_entry(
            &CacheWrite::new(transient_key, transient_id, transient_category, 1, None)
                .expect("transient cache edge"),
        )
        .expect("put transient cache edge");

    let cleared = database.clear_all_cache().expect("clear rebuildable cache");
    assert_eq!(cleared.removed_count, 1);
    assert_eq!(cleared.retained_shared_count, 1);
    assert_eq!(
        database
            .get_artifact(published.artifact_id())
            .expect("durable media artifact lookup")
            .expect("durable media artifact survives")
            .retention(),
        ArtifactRetention::Durable
    );
    assert!(
        database
            .lookup_cache(media_key)
            .expect("media cache lookup")
            .is_none()
    );
    assert!(
        database
            .lookup_cache(transient_key)
            .expect("transient cache lookup")
            .is_none()
    );
    assert!(
        database
            .get_artifact(transient_id)
            .expect("transient artifact lookup")
            .is_none()
    );
    let resolved = database
        .resolve_project_media_revision(project.id(), attached_version, asset.id())
        .expect("resolve active project media")
        .expect("active project media survives");
    assert_eq!(
        std::fs::read(resolved.path()).expect("read managed media"),
        source_bytes
    );
    let snapshot = database
        .load_project(project.id())
        .expect("load project")
        .expect("project survives");
    assert_eq!(snapshot.media().len(), 1);
    assert_eq!(snapshot.media()[0].id(), asset.id());
    assert_eq!(
        std::fs::read(&source_path).expect("read imported source"),
        source_bytes
    );
    assert_eq!(
        std::fs::read(&native_tool_path).expect("read native tool"),
        b"managed native tool"
    );
    assert_eq!(
        std::fs::read(&model_path).expect("read managed model"),
        b"managed model package"
    );

    drop(database);
    let reopened =
        crate::storage::Database::open_with_artifact_root(&database_path, &artifact_root)
            .expect("reopen database");
    assert!(
        reopened
            .resolve_project_media_revision(project.id(), attached_version, asset.id())
            .expect("resolve after restart")
            .is_some()
    );
}

#[test]
fn candidate_identity_hashes_the_full_file_and_is_stable_across_paths() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database =
        crate::storage::Database::open(directory.path().join("osg.sqlite3")).expect("database");
    let first_path = directory.path().join("first.mp4");
    let second_path = directory.path().join("renamed.mp4");
    let different_path = directory.path().join("different.mp4");
    let mut shared = vec![0x41; 1024 * 1024 + 1];
    std::fs::write(&first_path, &shared).expect("first fixture");
    std::fs::write(&second_path, &shared).expect("renamed fixture");
    shared[1024 * 1024] = 0x42;
    std::fs::write(&different_path, &shared).expect("different fixture");
    let size = u64::try_from(shared.len()).expect("fixture size");
    let first = MediaAsset::new("first.mp4", "mp4", size, MediaKind::Video).expect("asset");
    let renamed = MediaAsset::new("renamed.mp4", "mp4", size, MediaKind::Video).expect("asset");
    let different = MediaAsset::new("different.mp4", "mp4", size, MediaKind::Video).expect("asset");

    let first_hash = database
        .remember_media_candidate(&first, &first_path)
        .expect("first candidate");
    let repeated_hash = database
        .remember_media_candidate(&first, &first_path)
        .expect("idempotent reselection");
    let renamed_hash = database
        .remember_media_candidate(&renamed, &second_path)
        .expect("same bytes at a different path");
    let different_hash = database
        .remember_media_candidate(&different, &different_path)
        .expect("different tail byte");

    assert_eq!(first_hash, repeated_hash);
    assert_eq!(first_hash, renamed_hash);
    assert_ne!(first_hash, different_hash);
    assert_eq!(first_hash, ContentHash::digest(&vec![0x41; shared.len()]));
}

#[test]
fn expired_detached_picker_candidate_is_reconciled_without_touching_source_bytes() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let source_path = directory.path().join("private.mp4");
    let bytes = vec![0x4a; 16 * 1024];
    std::fs::write(&source_path, &bytes).expect("picker fixture");
    let asset = MediaAsset::new(
        "private.mp4",
        "mp4",
        u64::try_from(bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("asset");
    database
        .remember_media_candidate(&asset, &source_path)
        .expect("stage picker candidate");
    rusqlite::Connection::open(&database_path)
        .expect("expire candidate")
        .execute(
            "UPDATE media_assets
                 SET metadata_json = json_set(
                   metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                 )
                 WHERE id = ?1",
            [asset.id().as_uuid()],
        )
        .expect("expire candidate");

    let report = database
        .reconcile_artifacts()
        .expect("reconcile expired candidate");

    assert_eq!(report.removed_expired_media_candidates, 1);
    assert!(
        database
            .resolve_media(asset.id())
            .expect("expired candidate lookup")
            .is_none()
    );
    assert_eq!(std::fs::read(source_path).expect("source remains"), bytes);
}

#[test]
fn alias_owned_candidate_survives_discard_and_expiry_until_the_alias_is_removed() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let source_path = directory.path().join("aliased.mp4");
    let bytes = vec![0x4b; 8 * 1024];
    std::fs::write(&source_path, &bytes).expect("aliased fixture");
    let asset = MediaAsset::new(
        "aliased.mp4",
        "mp4",
        u64::try_from(bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("asset");
    database
        .remember_media_candidate(&asset, &source_path)
        .expect("stage aliased candidate");
    let connection = rusqlite::Connection::open(&database_path).expect("alias connection");
    connection
        .execute(
            "INSERT INTO media_aliases(namespace, alias, media_id, created_at_ms)
                 VALUES ('url', 'stable-content-alias', ?1, 1)",
            [asset.id().as_uuid()],
        )
        .expect("create alias ownership");
    connection
        .execute(
            "UPDATE media_assets
                 SET metadata_json = json_set(
                   metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                 ) WHERE id = ?1",
            [asset.id().as_uuid()],
        )
        .expect("expire aliased candidate");
    assert!(
        !database
            .discard_media_candidate(asset.id())
            .expect("alias-owned discard")
    );
    assert_eq!(
        database
            .reconcile_artifacts()
            .expect("reconcile alias-owned candidate")
            .removed_expired_media_candidates,
        0
    );
    assert!(
        database
            .resolve_media(asset.id())
            .expect("alias-owned candidate lookup")
            .is_some()
    );

    connection
        .execute(
            "DELETE FROM media_aliases WHERE namespace = 'url' AND alias = ?1",
            ["stable-content-alias"],
        )
        .expect("remove alias ownership");
    assert!(
        database
            .discard_media_candidate(asset.id())
            .expect("discard after alias removal")
    );
}

#[test]
fn content_dedup_links_each_candidate_and_discards_in_either_order() {
    for discard_first in [true, false] {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = crate::storage::Database::open(&database_path).expect("open database");
        let source_path = directory.path().join("download.mp4");
        let bytes = vec![0x6a; 64 * 1024];
        std::fs::write(&source_path, &bytes).expect("download fixture");
        let mut first_job = JobSnapshot::new(JobKind::DownloadMedia);
        let mut second_job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&first_job).expect("first job");
        database.create_job(&second_job).expect("second job");
        let first_asset = MediaAsset::new(
            "first.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("first asset");
        let second_asset = MediaAsset::new(
            "second.mp4",
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("second asset");
        let kind = ArtifactKind::new("downloadMedia").expect("artifact kind");
        let first = publish_durable_media_candidate(
            &database,
            first_job.id(),
            kind.clone(),
            first_asset.clone(),
            &source_path,
            serde_json::json!({"source": "shared"}),
        )
        .expect("publish first candidate");
        let second = publish_durable_media_candidate(
            &database,
            second_job.id(),
            kind,
            second_asset.clone(),
            &source_path,
            serde_json::json!({"source": "shared"}),
        )
        .expect("publish second candidate");
        assert_eq!(first.artifact_id(), second.artifact_id());
        for job in [&mut first_job, &mut second_job] {
            complete_queued_job(&database, job);
        }
        let connection = rusqlite::Connection::open(&database_path).expect("inspect links");
        let link_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM media_artifacts WHERE artifact_id = ?1",
                [first.artifact_id().as_uuid()],
                |row| row.get(0),
            )
            .expect("link count");
        assert_eq!(link_count, 2);
        drop(connection);

        let (discarded, survivor) = if discard_first {
            (&first_asset, &second_asset)
        } else {
            (&second_asset, &first_asset)
        };
        assert!(
            database
                .discard_media_candidate(discarded.id())
                .expect("discard first candidate")
        );
        assert!(
            database
                .resolve_media(survivor.id())
                .expect("resolve survivor")
                .is_some()
        );
        assert!(
            database
                .resolve_artifact(first.artifact_id())
                .expect("resolve shared artifact")
                .is_some()
        );
        assert!(
            database
                .discard_media_candidate(survivor.id())
                .expect("discard final candidate")
        );
        assert!(
            database
                .resolve_artifact(first.artifact_id())
                .expect("resolve removed artifact")
                .is_none()
        );
        assert!(!first.path().exists());
    }
}

#[test]
fn explicit_discard_preserves_a_candidate_owned_by_a_live_job() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database =
        crate::storage::Database::open(directory.path().join("osg.sqlite3")).expect("database");
    let source_path = directory.path().join("live.mp4");
    let bytes = b"live download candidate";
    std::fs::write(&source_path, bytes).expect("download fixture");
    let mut job = JobSnapshot::new(JobKind::DownloadMedia);
    database.create_job(&job).expect("create download job");
    let queued_sequence = job.sequence();
    job.start().expect("start download job");
    database
        .compare_and_swap_job(queued_sequence, &job)
        .expect("persist running download");
    let asset = MediaAsset::new(
        "live.mp4",
        "mp4",
        u64::try_from(bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("asset");
    let published = publish_durable_media_candidate(
        &database,
        job.id(),
        ArtifactKind::new("downloadMedia").expect("artifact kind"),
        asset.clone(),
        &source_path,
        serde_json::json!({"source": "live"}),
    )
    .expect("publish live candidate");

    assert!(
        !database
            .discard_media_candidate(asset.id())
            .expect("live candidate must be protected")
    );
    assert!(
        database
            .resolve_media(asset.id())
            .expect("resolve protected media")
            .is_some()
    );
    assert!(
        database
            .resolve_artifact(published.artifact_id())
            .expect("resolve protected artifact")
            .is_some()
    );

    let running_sequence = job.sequence();
    job.succeed().expect("finish download job");
    database
        .compare_and_swap_job(running_sequence, &job)
        .expect("persist finished download");
    assert!(
        database
            .discard_media_candidate(asset.id())
            .expect("terminal candidate can be discarded")
    );
    assert!(
        database
            .resolve_artifact(published.artifact_id())
            .expect("discarded artifact lookup")
            .is_none()
    );
}
