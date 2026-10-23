//! Job claims on media candidates across active states, restarts, and failed deduplicated jobs.

use super::*;

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "each active job state is exercised as the sole surviving plural claim"
)]
fn plural_job_claims_protect_each_active_state_from_discard_expiry_and_failure() {
    for active_state in ["queued", "running", "cancelling"] {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = crate::storage::Database::open(&database_path).expect("database");
        let source_path = directory.path().join(format!("{active_state}.mp4"));
        let bytes = format!("plural claim fixture {active_state}").into_bytes();
        std::fs::write(&source_path, &bytes).expect("source fixture");
        let asset = MediaAsset::new(
            format!("{active_state}.mp4"),
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            MediaKind::Video,
        )
        .expect("asset");
        let mut failed_job = JobSnapshot::new(JobKind::DownloadMedia);
        let mut active_job = JobSnapshot::new(JobKind::DownloadMedia);
        database.create_job(&failed_job).expect("failed job");
        database.create_job(&active_job).expect("active job");
        let sequence = failed_job.sequence();
        failed_job.start().expect("start failed job");
        database
            .compare_and_swap_job(sequence, &failed_job)
            .expect("persist failed-job running state");
        if matches!(active_state, "running" | "cancelling") {
            let sequence = active_job.sequence();
            active_job.start().expect("start active job");
            database
                .compare_and_swap_job(sequence, &active_job)
                .expect("persist active running state");
        }
        if active_state == "cancelling" {
            let sequence = active_job.sequence();
            active_job
                .request_cancellation()
                .expect("request cancellation");
            database
                .compare_and_swap_job(sequence, &active_job)
                .expect("persist cancelling state");
        }
        let kind = ArtifactKind::new("downloadMediaClaimFixture").expect("kind");
        let first = publish_durable_media_candidate(
            &database,
            failed_job.id(),
            kind.clone(),
            asset.clone(),
            &source_path,
            serde_json::json!({"source": "plural-claim"}),
        )
        .expect("publish failed owner");
        let second = publish_durable_media_candidate(
            &database,
            active_job.id(),
            kind,
            asset.clone(),
            &source_path,
            serde_json::json!({"source": "plural-claim"}),
        )
        .expect("publish active owner");
        assert_eq!(first.artifact_id(), second.artifact_id());
        let claims: i64 = rusqlite::Connection::open(&database_path)
            .expect("inspect claims")
            .query_row(
                "SELECT COUNT(*) FROM media_artifact_job_claims
                     WHERE media_id = ?1 AND artifact_id = ?2",
                params![asset.id().as_uuid(), first.artifact_id().as_uuid()],
                |row| row.get(0),
            )
            .expect("claim count");
        assert_eq!(claims, 2);
        rusqlite::Connection::open(&database_path)
            .expect("expire candidate")
            .execute(
                "UPDATE media_assets SET metadata_json = json_set(
                       metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                     ) WHERE id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("expire candidate");
        let sequence = failed_job.sequence();
        failed_job.fail().expect("fail owner");
        database
            .compare_and_swap_job(sequence, &failed_job)
            .expect("persist failed owner");

        assert_eq!(
            database
                .reconcile_artifacts()
                .expect("reconcile active claim")
                .removed_expired_media_candidates,
            0
        );
        assert!(
            !database
                .discard_media_candidate(asset.id())
                .expect("active claim blocks discard")
        );
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve")
                .is_some()
        );

        if active_state == "queued" {
            let sequence = active_job.sequence();
            active_job.start().expect("start queued claim");
            database
                .compare_and_swap_job(sequence, &active_job)
                .expect("persist running queued claim");
        }
        let sequence = active_job.sequence();
        if active_state == "cancelling" {
            active_job
                .confirm_cancelled()
                .expect("confirm cancellation");
        } else {
            active_job.fail().expect("fail active claim");
        }
        database
            .compare_and_swap_job(sequence, &active_job)
            .expect("persist terminal active claim");
        let report = database
            .reconcile_artifacts()
            .expect("reconcile terminal claims");
        assert_eq!(report.removed_expired_media_candidates, 1);
        assert!(
            database
                .resolve_media(asset.id())
                .expect("removed media")
                .is_none()
        );
        assert!(
            database
                .resolve_artifact(first.artifact_id())
                .expect("removed artifact")
                .is_none()
        );
    }
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "restart interruption checks every plural claim"
)]
fn restart_interrupts_in_flight_claims_but_a_queued_claim_still_protects_the_candidate() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let source_path = directory.path().join("restart.mp4");
    let bytes = b"plural restart fixture";
    std::fs::write(&source_path, bytes).expect("source fixture");
    let asset = MediaAsset::new(
        "restart.mp4",
        "mp4",
        u64::try_from(bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("asset");
    let queued_id;
    let running_id;
    let cancelling_id;
    let artifact_id;
    {
        let database = crate::storage::Database::open(&database_path).expect("database");
        let queued = JobSnapshot::new(JobKind::DownloadMedia);
        let mut running = JobSnapshot::new(JobKind::DownloadMedia);
        let mut cancelling = JobSnapshot::new(JobKind::DownloadMedia);
        for job in [&queued, &running, &cancelling] {
            database.create_job(job).expect("create job");
        }
        let sequence = running.sequence();
        running.start().expect("start running claim");
        database
            .compare_and_swap_job(sequence, &running)
            .expect("persist running claim");
        let sequence = cancelling.sequence();
        cancelling.start().expect("start cancelling claim");
        database
            .compare_and_swap_job(sequence, &cancelling)
            .expect("persist pre-cancel running claim");
        let sequence = cancelling.sequence();
        cancelling
            .request_cancellation()
            .expect("request cancellation");
        database
            .compare_and_swap_job(sequence, &cancelling)
            .expect("persist cancelling claim");
        let kind = ArtifactKind::new("restartMediaClaimFixture").expect("kind");
        let mut published = None;
        for job in [&queued, &running, &cancelling] {
            published = Some(
                publish_durable_media_candidate(
                    &database,
                    job.id(),
                    kind.clone(),
                    asset.clone(),
                    &source_path,
                    serde_json::json!({"source": "restart"}),
                )
                .expect("publish claim"),
            );
        }
        queued_id = queued.id();
        running_id = running.id();
        cancelling_id = cancelling.id();
        artifact_id = published.expect("publication").artifact_id();
        rusqlite::Connection::open(&database_path)
            .expect("expire candidate")
            .execute(
                "UPDATE media_assets SET metadata_json = json_set(
                       metadata_json, '$.osgMediaCandidateExpiresAtMs', 0
                     ) WHERE id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("expire candidate");
    }

    let database = crate::storage::Database::open(&database_path).expect("restart database");
    assert_eq!(
        database
            .get_job(running_id)
            .expect("running job")
            .expect("running claim")
            .state(),
        osg_domain::JobState::Interrupted
    );
    assert_eq!(
        database
            .get_job(cancelling_id)
            .expect("cancelling job")
            .expect("cancelling claim")
            .state(),
        osg_domain::JobState::Interrupted
    );
    let mut queued = database
        .get_job(queued_id)
        .expect("queued job")
        .expect("queued claim");
    assert_eq!(queued.state(), osg_domain::JobState::Queued);
    assert!(
        database
            .resolve_media(asset.id())
            .expect("protected media")
            .is_some()
    );
    assert!(
        !database
            .discard_media_candidate(asset.id())
            .expect("discard")
    );
    let sequence = queued.sequence();
    queued.start().expect("start queued claim");
    database
        .compare_and_swap_job(sequence, &queued)
        .expect("persist running claim");
    let sequence = queued.sequence();
    queued.fail().expect("fail last claim");
    database
        .compare_and_swap_job(sequence, &queued)
        .expect("persist failed claim");
    database
        .reconcile_artifacts()
        .expect("reconcile all terminal claims");
    assert!(
        database
            .resolve_media(asset.id())
            .expect("removed media")
            .is_none()
    );
    assert!(
        database
            .resolve_artifact(artifact_id)
            .expect("removed artifact")
            .is_none()
    );
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the deduplicated cleanup race must keep both job transitions and both ownership assertions visible"
)]
fn failed_deduplicated_job_cleanup_preserves_the_other_live_candidate() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database =
        crate::storage::Database::open(directory.path().join("osg.sqlite3")).expect("database");
    let source_path = directory.path().join("download.mp4");
    let bytes = vec![0x6c; 48 * 1024];
    std::fs::write(&source_path, &bytes).expect("download fixture");
    let mut failed_job = JobSnapshot::new(JobKind::DownloadMedia);
    let mut live_job = JobSnapshot::new(JobKind::DownloadMedia);
    for job in [&mut failed_job, &mut live_job] {
        database.create_job(job).expect("create job");
        let sequence = job.sequence();
        job.start().expect("start job");
        database
            .compare_and_swap_job(sequence, job)
            .expect("persist running job");
    }
    let size = u64::try_from(bytes.len()).expect("fixture size");
    let failed_asset =
        MediaAsset::new("failed.mp4", "mp4", size, MediaKind::Video).expect("failed asset");
    let live_asset =
        MediaAsset::new("live.mp4", "mp4", size, MediaKind::Video).expect("live asset");
    let kind = ArtifactKind::new("downloadMedia").expect("artifact kind");
    let failed = publish_durable_media_candidate(
        &database,
        failed_job.id(),
        kind.clone(),
        failed_asset.clone(),
        &source_path,
        serde_json::json!({"source": "shared"}),
    )
    .expect("publish failed candidate");
    let live = publish_durable_media_candidate(
        &database,
        live_job.id(),
        kind,
        live_asset.clone(),
        &source_path,
        serde_json::json!({"source": "shared"}),
    )
    .expect("publish live candidate");
    assert_eq!(failed.artifact_id(), live.artifact_id());

    let failed_sequence = failed_job.sequence();
    failed_job.fail().expect("fail first job");
    database
        .compare_and_swap_job(failed_sequence, &failed_job)
        .expect("persist failed job");
    database
        .reconcile_artifacts()
        .expect("reconcile one failed owner");
    assert!(
        database
            .resolve_media(failed_asset.id())
            .expect("failed candidate lookup")
            .is_none()
    );
    assert!(
        database
            .resolve_media(live_asset.id())
            .expect("live candidate lookup")
            .is_some()
    );
    assert!(
        database
            .resolve_artifact(live.artifact_id())
            .expect("shared artifact lookup")
            .is_some()
    );

    let live_sequence = live_job.sequence();
    live_job.fail().expect("fail live job");
    database
        .compare_and_swap_job(live_sequence, &live_job)
        .expect("persist second failed job");
    database
        .reconcile_artifacts()
        .expect("reconcile all failed owners");
    assert!(
        database
            .resolve_media(live_asset.id())
            .expect("cleaned live candidate lookup")
            .is_none()
    );
    assert!(
        database
            .resolve_artifact(live.artifact_id())
            .expect("cleaned artifact lookup")
            .is_none()
    );
}
