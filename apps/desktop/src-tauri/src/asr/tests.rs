use std::sync::{Arc, atomic::AtomicBool};

use osg_asr::AsrEngineId;
use osg_asr::CancellationToken as AsrCancellationToken;
use osg_domain::JobId;
use osg_engine_packages::RuntimeCoordinator as _;
use osg_media::CancellationToken as MediaCancellationToken;
use serde_json::json;
use tauri::ipc::Channel;

use super::WORKER_BYTES;
use super::job::{resolve_media_range, send_progress};
use super::request::{AsrJobEvent, AsrJobPhase, AsrStartRequest, RequestedRange};
use super::runtime::AsrRuntimeManager;

#[test]
fn a_closed_webview_channel_does_not_cancel_native_asr_work() {
    let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
    let closed = AtomicBool::new(false);
    let media = MediaCancellationToken::default();
    let asr = AsrCancellationToken::default();

    send_progress(
        &channel,
        &closed,
        &media,
        &asr,
        JobId::new(),
        AsrJobPhase::Transcribing,
        Some(0.5),
    );

    assert!(closed.load(std::sync::atomic::Ordering::Acquire));
    assert!(!media.is_cancelled());
    assert!(!asr.is_cancelled());
}

#[test]
fn job_event_wire_fields_are_camel_case_at_the_real_rust_boundary() {
    let job_id = JobId::new();
    let event = serde_json::to_value(AsrJobEvent::Progress {
        job_id,
        phase: AsrJobPhase::PreparingAudio,
        fraction: None,
    })
    .expect("serializable ASR progress event");

    assert_eq!(event["event"], "progress");
    assert_eq!(event["jobId"], job_id.to_string());
    assert_eq!(event["phase"], "preparingAudio");
    assert_eq!(event["fraction"], serde_json::Value::Null);
    assert!(event.get("job_id").is_none());
}

#[test]
fn request_accepts_the_frozen_ui_aliases_but_rejects_unknown_fields() {
    let request = serde_json::from_value::<AsrStartRequest>(json!({
        "engine": "nvidia-parakeet",
        "strategy": "char",
        "maxChars": 60,
        "maxWords": 7,
        "language": "auto",
        "range": { "startMs": 1_000, "endMs": 2_000 }
    }))
    .expect("legacy-shaped native request");
    assert_eq!(request.engine(), AsrEngineId::Parakeet);
    assert!(request.options().is_ok());
    assert_eq!(
        request.range_us().unwrap().unwrap().timeline_offset_ms,
        1_000
    );

    assert!(
        serde_json::from_value::<AsrStartRequest>(json!({
            "engine": "parakeet",
            "temperature": 0.5
        }))
        .is_err()
    );
}

#[test]
fn media_ranges_are_bounded_and_tolerate_only_rounding_at_the_end() {
    let range = RequestedRange {
        start_us: 1_000_000,
        end_us: 5_100_000,
        timeline_offset_ms: 1_000,
    };
    let resolved = resolve_media_range(Some(5_000_000), Some(range)).unwrap();
    assert_eq!(resolved.start_us, 1_000_000);
    assert_eq!(resolved.duration_us, Some(4_000_000));

    let outside = RequestedRange {
        end_us: 5_300_000,
        ..range
    };
    assert!(resolve_media_range(Some(5_000_000), Some(outside)).is_err());
    assert!(resolve_media_range(None, None).is_err());
}

#[test]
fn manager_reports_all_engines_without_leaking_private_paths() {
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("work");
    let resources = directory.path().join("resources");
    std::fs::create_dir_all(resources.join("workers")).unwrap();
    std::fs::write(resources.join("workers/osg_asr_worker.py"), WORKER_BYTES).unwrap();
    let manager = AsrRuntimeManager::new(&work, Some(resources)).unwrap();
    let status = manager.status();
    assert!(status.worker_available);
    assert_eq!(status.engines.len(), 5);
    let serialized = serde_json::to_value(&status).expect("serializable ASR status");
    for engine in serialized["engines"].as_array().expect("engine array") {
        assert_eq!(engine["installed"], false);
        assert_eq!(engine["ready"], false);
        assert_eq!(engine["warm"], false);
        assert_eq!(engine["starting"], false);
    }
    let debug = format!("{manager:?}");
    assert!(!debug.contains(&directory.path().display().to_string()));
    assert!(debug.contains("<redacted>"));
}

#[test]
fn package_coordinator_is_weak_and_cannot_keep_the_runtime_alive() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AsrRuntimeManager::new(directory.path().join("work"), None).unwrap();
    let strong_before = Arc::strong_count(&manager.0);
    let coordinator = manager.package_coordinator();
    assert_eq!(Arc::strong_count(&manager.0), strong_before);

    drop(manager);
    assert_eq!(
        coordinator.quiesce(osg_engine_packages::EngineId::Parakeet),
        Err(osg_engine_packages::PackageError::StoreUnavailable)
    );
}
