//! Atomic artifact/media commits and failed-retry recovery across a crash.

use super::*;

#[test]
fn artifact_ready_media_and_link_rows_commit_or_roll_back_together() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let bytes = b"atomic publication";
    let job = JobSnapshot::new(JobKind::DownloadMedia);
    database.create_job(&job).expect("create job");
    let draft = ArtifactDraft::new(
        ArtifactKind::new("downloadMedia").expect("artifact kind"),
        ContentHash::digest(bytes),
        u64::try_from(bytes.len()).expect("fixture size"),
        serde_json::json!({"osgMediaArtifact": true, "commitOnJobSuccess": true}),
    )
    .expect("artifact draft")
    .with_job(job.id());
    let staging = match database
        .register_artifact(&draft)
        .expect("register artifact")
    {
        ArtifactRegistration::Staging(staging) => staging,
        ArtifactRegistration::Existing(_) | ArtifactRegistration::Pending(_) => {
            panic!("fresh artifact must stage")
        }
    };
    std::fs::write(staging.path(), bytes).expect("write staging bytes");
    let artifact_id = staging.record().id();
    let invalid_asset = MediaAsset::new(
        "download.mp4",
        "mp4",
        u64::try_from(bytes.len() + 1).expect("invalid size"),
        MediaKind::Video,
    )
    .expect("invalid asset fixture");

    assert!(matches!(
        database.commit_media_artifact(&invalid_asset, artifact_id, job.id(), true),
        Err(DatabaseError::InvalidArtifactFile)
    ));
    let record = database
        .get_artifact(artifact_id)
        .expect("artifact lookup")
        .expect("pending artifact");
    assert_eq!(record.state(), ArtifactState::Pending);
    let connection = rusqlite::Connection::open(database_path).expect("inspect transaction");
    let rows: i64 = connection
        .query_row(
            "SELECT
                   (SELECT count(*) FROM media_assets WHERE id = ?1) +
                   (SELECT count(*) FROM media_artifacts WHERE artifact_id = ?2)",
            params![invalid_asset.id().as_uuid(), artifact_id.as_uuid()],
            |row| row.get(0),
        )
        .expect("atomic rows");
    assert_eq!(rows, 0);
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the retry crash fixture verifies every shared edge, claim, cache key, and project revision across restart"
)]
fn failed_retry_keeps_shared_media_cache_and_claim_edges_across_a_crash() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("db/osg.sqlite3");
    let artifact_root = directory.path().join("artifacts");
    let source_path = directory.path().join("shared.mp4");
    let bytes = vec![0x79; 96 * 1024];
    std::fs::write(&source_path, &bytes).expect("source fixture");
    let size = u64::try_from(bytes.len()).expect("fixture size");
    let first_asset =
        MediaAsset::new("first.mp4", "mp4", size, MediaKind::Video).expect("first asset");
    let second_asset =
        MediaAsset::new("second.mp4", "mp4", size, MediaKind::Video).expect("second asset");
    let kind = ArtifactKind::new("sharedRetryMediaFixture").expect("kind");
    let metadata = serde_json::json!({"source": "shared-retry"});
    let project_id;
    let project_version;
    let artifact_id;
    let cache_key;
    let crash_job_id;
    {
        let database =
            crate::storage::Database::open_with_artifact_root(&database_path, &artifact_root)
                .expect("database");
        let mut first_job = JobSnapshot::new(JobKind::DownloadMedia);
        let mut second_job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&first_job).expect("first job");
        database.create_job(&second_job).expect("second job");
        let first = publish_durable_media_candidate(
            &database,
            first_job.id(),
            kind.clone(),
            first_asset.clone(),
            &source_path,
            metadata.clone(),
        )
        .expect("first publication");
        let second = publish_durable_media_candidate(
            &database,
            second_job.id(),
            kind.clone(),
            second_asset.clone(),
            &source_path,
            metadata.clone(),
        )
        .expect("second publication");
        artifact_id = first.artifact_id();
        assert_eq!(artifact_id, second.artifact_id());
        complete_queued_job(&database, &mut first_job);
        complete_queued_job(&database, &mut second_job);

        let project = ProjectMetadata::new("shared retry owner").expect("project");
        project_id = project.id();
        let base = database.create_project(&project).expect("create project");
        let snapshot = ProjectSnapshot::new(
            project,
            base.state_version(),
            vec![first_asset.clone()],
            Vec::new(),
        )
        .expect("project snapshot");
        project_version = database
            .commit_project(
                &snapshot,
                &RevisionReason::new("own shared retry media").expect("reason"),
            )
            .expect("commit project")
            .state_version;

        let category = CacheCategory::new("sharedRetryMedia").expect("category");
        cache_key = CacheKey::derive(&category, 1, &[b"shared-retry"]).expect("cache key");
        database
            .put_cache_entry(
                &CacheWrite::new(cache_key, artifact_id, category, 1, None).expect("cache write"),
            )
            .expect("cache edge");

        make_test_file_writable(first.path());
        let mut corrupt = bytes.clone();
        let midpoint = corrupt.len() / 2;
        corrupt[midpoint] ^= 0xff;
        std::fs::write(first.path(), corrupt).expect("corrupt ready artifact");
        assert!(
            database
                .resolve_artifact(artifact_id)
                .expect("detect corruption")
                .is_none()
        );
        assert_eq!(
            database
                .get_artifact(artifact_id)
                .expect("artifact lookup")
                .expect("failed artifact")
                .state(),
            ArtifactState::Failed
        );

        let crash_job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&crash_job).expect("crash job");
        crash_job_id = crash_job.id();
        let crash_draft = ArtifactDraft::new(
            kind.clone(),
            ContentHash::digest(&bytes),
            size,
            serde_json::json!({
                "source": "shared-retry",
                "osgMediaArtifact": true,
                "commitOnJobSuccess": true
            }),
        )
        .expect("crash retry draft")
        .with_job(crash_job.id());
        let crash_stage = match database
            .register_media_artifact(&crash_draft, second_asset.id(), crash_job.id())
            .expect("reserve crash retry")
        {
            ArtifactRegistration::Staging(staging) => staging,
            ArtifactRegistration::Existing(_) | ArtifactRegistration::Pending(_) => {
                panic!("failed retry must acquire the preserved row")
            }
        };
        assert_eq!(crash_stage.record().id(), artifact_id);
        assert_eq!(crash_stage.record().state(), ArtifactState::Pending);
        // Simulate process death after the failed row was reset but before any bytes or a new
        // media claim were committed.  Startup must fail the reservation without deleting
        // the already durable project/media/cache ownership graph.
    }

    let database =
        crate::storage::Database::open_with_artifact_root(&database_path, &artifact_root)
            .expect("restart after retry crash");
    assert_eq!(
        database
            .get_artifact(artifact_id)
            .expect("artifact lookup after crash")
            .expect("preserved failed row")
            .state(),
        ArtifactState::Failed
    );
    let mut crash_job = database
        .get_job(crash_job_id)
        .expect("crash job lookup")
        .expect("crash job");
    assert_eq!(crash_job.state(), osg_domain::JobState::Queued);
    assert!(
        !database
            .discard_media_candidate(second_asset.id())
            .expect("transactional retry claim protects after restart")
    );
    let sequence = crash_job.sequence();
    crash_job.start().expect("start crash job");
    database
        .compare_and_swap_job(sequence, &crash_job)
        .expect("persist crash job running");
    let sequence = crash_job.sequence();
    crash_job.fail().expect("fail crash job");
    database
        .compare_and_swap_job(sequence, &crash_job)
        .expect("persist crash job failure");
    let connection = rusqlite::Connection::open(&database_path).expect("inspect edges");
    let (media_edges, cache_edges, old_claims): (i64, i64, i64) = connection
        .query_row(
            "SELECT
                   (SELECT COUNT(*) FROM media_artifacts WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM cache_entries WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM media_artifact_job_claims WHERE artifact_id = ?1)",
            [artifact_id.as_uuid()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("preserved ownership graph");
    assert_eq!((media_edges, cache_edges, old_claims), (2, 1, 3));
    drop(connection);

    let mut retry_job = JobSnapshot::new(JobKind::DownloadMedia);
    database.create_job(&retry_job).expect("retry job");
    let retry = publish_durable_media_candidate(
        &database,
        retry_job.id(),
        kind,
        second_asset.clone(),
        &source_path,
        metadata,
    )
    .expect("retry publication");
    assert_eq!(retry.artifact_id(), artifact_id);
    assert_eq!(std::fs::read(retry.path()).expect("retry bytes"), bytes);
    complete_queued_job(&database, &mut retry_job);
    let connection = rusqlite::Connection::open(&database_path).expect("inspect retry graph");
    let (media_edges, cache_edges, claims): (i64, i64, i64) = connection
        .query_row(
            "SELECT
                   (SELECT COUNT(*) FROM media_artifacts WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM cache_entries WHERE artifact_id = ?1),
                   (SELECT COUNT(*) FROM media_artifact_job_claims WHERE artifact_id = ?1)",
            [artifact_id.as_uuid()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("retry ownership graph");
    assert_eq!((media_edges, cache_edges, claims), (2, 1, 4));
    drop(connection);
    assert!(
        database
            .discard_media_candidate(second_asset.id())
            .expect("discard retry loser")
    );
    assert!(
        database
            .resolve_project_media_revision(project_id, project_version, first_asset.id())
            .expect("exact project resolve")
            .is_some()
    );
    assert_eq!(
        database
            .lookup_cache(cache_key)
            .expect("cache lookup")
            .expect("preserved cache artifact")
            .record()
            .id(),
        artifact_id
    );
    drop(database);

    let reopened =
        crate::storage::Database::open_with_artifact_root(&database_path, &artifact_root)
            .expect("final restart");
    let resolved = reopened
        .resolve_project_media_revision(project_id, project_version, first_asset.id())
        .expect("resolve project after restart")
        .expect("project media after restart");
    assert_eq!(
        std::fs::read(resolved.path()).expect("project bytes"),
        bytes
    );
    assert_eq!(
        reopened
            .lookup_cache(cache_key)
            .expect("cache after restart")
            .expect("cache artifact after restart")
            .record()
            .id(),
        artifact_id
    );
}
