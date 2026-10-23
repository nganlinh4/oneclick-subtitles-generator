use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use osg_application::inspect_media;
use osg_domain::{JobId, JobKind, JobSnapshot};
use osg_download::DownloadError;
use osg_infrastructure::storage::Database;
use uuid::Uuid;

use super::MAX_SUBTITLE_IPC_BYTES;
use super::commands::status_response;
use super::errors::{download_error_diagnostic, map_download_error};
use super::finish::{
    prepare_durable_download_candidate, publish_durable_media, read_downloaded_subtitle,
    remove_regular_file,
};
#[cfg(feature = "e2e-automation")]
use super::runtime::parse_exact_automation_download_urls;
use super::runtime::{DownloadRuntime, FinalizationRegistry, SlotLimiter};
use super::types::DownloadInspectRequest;
use crate::state::EditorSession;

#[test]
fn request_deserialization_rejects_unknown_fields_and_non_v7_capabilities() {
    assert!(
        serde_json::from_str::<DownloadInspectRequest>(
            r#"{"url":"https://youtube.com/watch?v=x","rawArgs":["--exec"]}"#
        )
        .is_err()
    );
    let legacy = Uuid::new_v4();
    let request = format!(
        r#"{{"inventoryId":"{legacy}","media":{{"kind":"video","quality":{{"mode":"best"}}}},"subtitle":null}}"#
    );
    assert!(serde_json::from_str::<super::types::DownloadStartRequest>(&request).is_err());
    let inventory_id = Uuid::now_v7();
    let path_request = format!(
        r#"{{"inventoryId":"{inventory_id}","media":{{"kind":"video","quality":{{"mode":"best"}},"outputPath":"C:\\private"}},"subtitle":null}}"#
    );
    assert!(serde_json::from_str::<super::types::DownloadStartRequest>(&path_request).is_err());
}

#[cfg(feature = "e2e-automation")]
#[test]
fn automation_download_url_environment_is_a_bounded_json_array() {
    let url = "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert_eq!(
        parse_exact_automation_download_urls(&serde_json::json!([url]).to_string())
            .expect("bounded array"),
        vec![url]
    );
    for invalid in [
        "",
        "null",
        "{}",
        "[]",
        "[1]",
        r#"["a","b","c","d","e","f","g","h","i"]"#,
    ] {
        assert!(
            parse_exact_automation_download_urls(invalid).is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn downloader_process_failures_map_to_actionable_path_free_codes() {
    let spawn = serde_json::to_value(map_download_error(&DownloadError::Spawn(
        std::io::Error::other("private operating-system detail"),
    )))
    .unwrap();
    let process = serde_json::to_value(map_download_error(&DownloadError::ProcessFailed {
        code: Some(1),
        kind: osg_download::ProcessFailureKind::Extractor,
    }))
    .unwrap();
    let timeout = serde_json::to_value(map_download_error(&DownloadError::TimedOut {
        timeout: std::time::Duration::from_secs(1),
    }))
    .unwrap();
    let authentication = serde_json::to_value(map_download_error(&DownloadError::ProcessFailed {
        code: Some(1),
        kind: osg_download::ProcessFailureKind::AuthenticationRequired,
    }))
    .unwrap();
    assert_eq!(spawn["code"], "downloaderExecutionFailed");
    assert_eq!(process["code"], "downloaderExecutionFailed");
    assert_eq!(authentication["code"], "downloaderAuthenticationRequired");
    assert_eq!(timeout["code"], "internal");
    assert_eq!(
        download_error_diagnostic(&DownloadError::ProcessFailed {
            code: Some(1),
            kind: osg_download::ProcessFailureKind::AuthenticationRequired,
        }),
        "authentication-required"
    );
    assert_eq!(
        download_error_diagnostic(&DownloadError::TimedOut {
            timeout: std::time::Duration::from_secs(1),
        }),
        "timed-out"
    );
    assert_eq!(
        download_error_diagnostic(&DownloadError::InvalidInventory("no usable formats")),
        "invalid-inventory-no-usable-formats"
    );
    assert_eq!(
        download_error_diagnostic(&DownloadError::InvalidInventory("future bounded reason")),
        "invalid-inventory"
    );
    assert!(!spawn.to_string().contains("private"));
    assert!(!process.to_string().contains('1'));
    assert!(!authentication.to_string().contains('1'));
}

#[test]
fn inspect_request_debug_redacts_the_url() {
    let request: DownloadInspectRequest = serde_json::from_str(
        r#"{"url":"https://youtube.com/watch?v=private-token","cookieSource":"chrome"}"#,
    )
    .expect("inspect request");
    let debug = format!("{request:?}");
    assert!(!debug.contains("youtube"));
    assert!(!debug.contains("private-token"));
    assert!(debug.contains("Chrome"));
}

#[test]
fn slot_limit_is_atomic_and_reusable() {
    let limiter = SlotLimiter::new(2);
    let first = limiter.acquire().expect("first permit");
    let second = limiter.acquire().expect("second permit");
    assert!(limiter.acquire().is_none());
    drop(first);
    assert!(limiter.acquire().is_some());
    drop(second);
    assert!(Arc::strong_count(&limiter) >= 1);
}

#[test]
fn unavailable_status_is_path_free() {
    let response = status_response(
        false,
        false,
        None,
        Some(super::types::DownloadUnavailableReason::DownloaderUnavailable),
    );
    let json = serde_json::to_string(&response).expect("serialize status");
    assert!(!json.to_ascii_lowercase().contains("path"));
    assert!(!json.contains("3031"));
    assert!(!format!("{:?}", std::mem::size_of::<DownloadRuntime>()).contains("Users"));
}

#[test]
fn subtitle_reader_rejects_oversized_files_before_reading_them() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let subtitle = directory.path().join("track.srt");
    let file = fs::File::create(&subtitle).expect("subtitle file");
    file.set_len(MAX_SUBTITLE_IPC_BYTES + 1)
        .expect("sparse oversized file");

    assert!(matches!(
        read_downloaded_subtitle(
            Some(&subtitle),
            Some(&"track.srt".to_owned()),
            Some(&"en".to_owned())
        ),
        Err(DownloadError::SubtitleArtifactTooLarge)
    ));
}

#[test]
fn cleanup_removes_only_regular_files() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let regular = directory.path().join("media.mp4");
    fs::write(&regular, b"media").expect("write regular file");
    remove_regular_file(&regular);
    assert!(!regular.exists());

    let nested = directory.path().join("not-a-file");
    fs::create_dir(&nested).expect("nested directory");
    remove_regular_file(&nested);
    assert!(nested.is_dir());
}

#[test]
fn durable_publication_survives_source_and_cache_removal() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open_with_artifact_root(
        directory.path().join("db/osg.sqlite3"),
        directory.path().join("artifacts"),
    )
    .expect("database");
    let source = directory.path().join("download.mp4");
    let bytes = vec![0x5a; 128 * 1024];
    fs::write(&source, &bytes).expect("downloaded source");

    let job_id = JobId::new();
    database
        .create_job(&JobSnapshot::with_id(job_id, JobKind::DownloadMedia))
        .expect("durable job");
    let durable = publish_durable_media(
        &database,
        job_id,
        &source,
        u64::try_from(bytes.len()).unwrap(),
        "download.mp4",
    )
    .expect("durable media");
    let durable_path = database
        .resolve_media(durable.asset.id())
        .expect("resolve durable media")
        .expect("durable media location")
        .path()
        .to_owned();
    fs::remove_file(&source).expect("remove source cache file");
    database
        .clear_cache_with_info(None)
        .expect("clear cache entries");

    assert_eq!(fs::read(&durable_path).expect("durable bytes"), bytes);
    assert_eq!(database.cache_info().expect("cache info").total_count, 0);
}

#[test]
fn extensionless_durable_download_candidate_is_path_free_and_discard_cleans_artifact() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open_with_artifact_root(
        directory.path().join("db/osg.sqlite3"),
        directory.path().join("artifacts"),
    )
    .expect("database");
    let source = directory.path().join("download.mp4");
    let bytes = vec![0x5a; 64 * 1024];
    fs::write(&source, &bytes).expect("downloaded source");
    let job_id = JobId::new();
    // `finish_download` publishes the candidate while the download job is still running and
    // only releases it once that job is terminal, so the fixture follows the same lifecycle.
    let mut job = JobSnapshot::with_id(job_id, JobKind::DownloadMedia);
    database.create_job(&job).expect("durable job");
    let queued_sequence = job.sequence();
    job.start().expect("start download job");
    database
        .compare_and_swap_job(queued_sequence, &job)
        .expect("persist running download");
    let durable = publish_durable_media(
        &database,
        job_id,
        &source,
        u64::try_from(bytes.len()).expect("fixture size"),
        "download.mp4",
    )
    .expect("durable media");
    let durable_path = database
        .resolve_media(durable.asset.id())
        .expect("resolve durable media")
        .expect("durable media location")
        .path()
        .to_owned();
    assert!(durable_path.extension().is_none());

    let existing_path = directory.path().join("existing.mp4");
    fs::write(&existing_path, vec![0x33; 16 * 1024]).expect("existing editor media");
    let mut editor = EditorSession::default();
    editor
        .session
        .set_media(inspect_media(&existing_path).expect("inspect existing media"));
    let before = editor.snapshot();
    let candidate = prepare_durable_download_candidate(durable);
    let asset = candidate.asset();
    assert_eq!(asset.display_name(), "download.mp4");
    assert_eq!(asset.extension(), "mp4");
    assert_eq!(editor.snapshot(), before);
    assert_eq!(
        database
            .resolve_media(asset.id())
            .expect("resolve remembered media")
            .expect("remembered media")
            .path(),
        durable_path.as_path()
    );
    let value = serde_json::to_value(&candidate).expect("serialize media candidate");
    assert_eq!(value["contentIdentity"]["algorithm"], "blake3-256");
    assert!(value.get("playback").is_none());
    let json = serde_json::to_string(&value).expect("candidate JSON");
    assert!(!json.contains(directory.path().to_string_lossy().as_ref()));
    assert!(!json.to_ascii_lowercase().contains("path"));

    // A candidate still owned by a live download job stays claimed; the WebView only ever sees
    // one after the job is terminal.
    assert!(
        !database
            .discard_media_candidate(asset.id())
            .expect("live download candidate stays claimed")
    );
    let running_sequence = job.sequence();
    job.succeed().expect("finish download job");
    database
        .compare_and_swap_job(running_sequence, &job)
        .expect("persist finished download");

    assert!(
        database
            .discard_media_candidate(asset.id())
            .expect("discard detached download candidate")
    );
    assert!(
        database
            .resolve_media(asset.id())
            .expect("resolve discarded media")
            .is_none()
    );
    assert!(!durable_path.exists());
}

#[test]
fn finalization_blocks_late_cancellation_until_the_terminal_update() {
    let registry = Arc::new(FinalizationRegistry::default());
    let job_id = JobId::new();
    let finalization = registry.begin(job_id).expect("begin finalization");
    let invoked = AtomicBool::new(false);
    assert!(
        registry
            .run_if_cancellable(job_id, || {
                invoked.store(true, Ordering::SeqCst);
                Ok(())
            })
            .is_err()
    );
    assert!(!invoked.load(Ordering::SeqCst));

    drop(finalization);
    registry
        .run_if_cancellable(job_id, || {
            invoked.store(true, Ordering::SeqCst);
            Ok(())
        })
        .expect("cancellable after finalization");
    assert!(invoked.load(Ordering::SeqCst));
}
