use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use osg_application::JobRegistry;
use osg_domain::{JobKind, JobUpdate};
use osg_native_tools::{NativeToolId, OperationPhase, OperationProgress};
use serde_json::json;

use super::SCHEMA_VERSION;
use super::durable::map_progress;
use super::types::{
    ExecutionFailure, NativeToolAction, NativeToolActivator, NativeToolEvent, NativeToolPhase,
    NativeToolRuntime,
};
use crate::error::{CommandError, CommandResult};

#[derive(Debug)]
struct CountingActivator {
    failures_remaining: AtomicUsize,
    refreshes: AtomicUsize,
}

impl CountingActivator {
    fn new(failures: usize) -> Self {
        Self {
            failures_remaining: AtomicUsize::new(failures),
            refreshes: AtomicUsize::new(0),
        }
    }
}

impl NativeToolActivator for CountingActivator {
    fn refresh(&self, _: &NativeToolRuntime) -> CommandResult<()> {
        self.refreshes.fetch_add(1, Ordering::Relaxed);
        if self
            .failures_remaining
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            Err(CommandError::internal("injected activator failure"))
        } else {
            Ok(())
        }
    }

    fn consumers_idle(&self, _: NativeToolId) -> CommandResult<bool> {
        Ok(true)
    }
}

fn runtime_fixture() -> (tempfile::TempDir, NativeToolRuntime) {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let database =
        osg_infrastructure::storage::Database::open(temporary.path().join("database.sqlite3"))
            .expect("database");
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
    let runtime = NativeToolRuntime::new(&temporary.path().join("native-tools"), database, jobs)
        .expect("native tool runtime");
    (temporary, runtime)
}

#[test]
fn catalog_and_status_are_path_free_and_platform_accurate() {
    let (_temporary, runtime) = runtime_fixture();
    let catalog = serde_json::to_string(&NativeToolRuntime::catalog()).expect("catalog");
    let status = serde_json::to_string(&runtime.status().expect("status")).expect("status json");

    assert!(!catalog.contains("http"));
    assert!(!catalog.contains("bin/"));
    assert!(!status.contains("http"));
    assert!(!status.contains("bin/"));
    let decoded: serde_json::Value = serde_json::from_str(&status).expect("valid json");
    assert_eq!(decoded["schemaVersion"], SCHEMA_VERSION);
    assert_eq!(decoded["tools"][0]["id"], "media-tools");
    assert_eq!(
        decoded["tools"][0]["state"],
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "missing"
        } else {
            "unavailable"
        }
    );
    assert_eq!(decoded["tools"][1]["state"], "missing");
    assert_eq!(decoded["tools"][2]["state"], "missing");
}

#[test]
fn progress_mapping_is_monotonic_across_acquisition_and_publication() {
    let phases = [
        OperationProgress {
            phase: OperationPhase::Downloading,
            basis_points: 10_000,
            bytes_done: 10,
            total_bytes: 10,
        },
        OperationProgress {
            phase: OperationPhase::Verifying,
            basis_points: 0,
            bytes_done: 0,
            total_bytes: 10,
        },
        OperationProgress {
            phase: OperationPhase::Extracting,
            basis_points: 5_000,
            bytes_done: 5,
            total_bytes: 10,
        },
        OperationProgress {
            phase: OperationPhase::Publishing,
            basis_points: 10_000,
            bytes_done: 1,
            total_bytes: 1,
        },
    ];
    let mapped = phases
        .into_iter()
        .map(|progress| map_progress(NativeToolAction::Install, progress).expect("progress"))
        .collect::<Vec<_>>();
    assert_eq!(mapped[0], (NativeToolPhase::Downloading, 6_000));
    assert_eq!(mapped[1], (NativeToolPhase::Downloading, 0));
    assert_eq!(mapped[2], (NativeToolPhase::Extracting, 7_500));
    assert_eq!(mapped[3], (NativeToolPhase::Publishing, 9_900));
}

#[test]
fn completed_event_uses_the_exact_camel_case_webview_contract() {
    let (_temporary, runtime) = runtime_fixture();
    let queued = runtime
        .0
        .jobs
        .register(JobKind::InstallEngine)
        .expect("queued job");
    let job_id = queued.snapshot().id();
    runtime
        .0
        .jobs
        .apply(job_id, JobUpdate::Start)
        .expect("running job");
    let succeeded = runtime
        .0
        .jobs
        .apply(job_id, JobUpdate::Succeed)
        .expect("succeeded job");

    let value = serde_json::to_value(NativeToolEvent::Completed {
        job: succeeded.snapshot().clone(),
        tool: NativeToolId::YtDlp,
        action: NativeToolAction::Install,
        restart_required: false,
        deferred: false,
    })
    .expect("serializable event");

    assert_eq!(value["event"], "completed");
    assert_eq!(value["restartRequired"], false);
    assert_eq!(value["deferred"], false);
    assert_eq!(value["tool"], "yt-dlp");
    assert_eq!(value["action"], "install");
    assert_eq!(value["job"]["state"], "succeeded");
    assert_eq!(value.as_object().map(serde_json::Map::len), Some(6));
    assert_eq!(value.get("restart_required"), None);
    assert_ne!(value, json!({ "event": "completed" }));
}

#[test]
fn runtime_debug_never_exposes_its_store_path() {
    let (temporary, runtime) = runtime_fixture();
    let debug = format!("{runtime:?}");
    assert!(!debug.contains(temporary.path().to_string_lossy().as_ref()));
}

#[test]
fn distinct_tools_reserve_concurrently_but_duplicate_tool_work_is_rejected() {
    let (_temporary, runtime) = runtime_fixture();
    let media = runtime
        .reserve(NativeToolId::MediaTools)
        .expect("media reservation");
    let downloader = runtime
        .reserve(NativeToolId::YtDlp)
        .expect("downloader reservation");

    assert_eq!(runtime.0.operations.lock().expect("operations").len(), 2);
    assert!(runtime.reserve(NativeToolId::MediaTools).is_err());

    drop(media);
    drop(downloader);
    assert!(runtime.0.operations.lock().expect("operations").is_empty());
}

#[test]
fn failed_activation_refreshes_restored_state_and_persistent_failure_fails_closed() {
    let (_temporary, runtime) = runtime_fixture();
    let recovers = Arc::new(CountingActivator::new(0));
    runtime
        .attach_activator(recovers.clone())
        .expect("activator");
    let result: Result<(), ExecutionFailure> =
        runtime.restore_lease_after_refresh_failure(NativeToolId::YtDlp, None);
    assert!(matches!(result, Err(ExecutionFailure::Internal)));
    assert_eq!(recovers.refreshes.load(Ordering::Relaxed), 1);
    assert!(runtime.0.active_leases.read().unwrap().is_empty());

    let (_temporary, runtime) = runtime_fixture();
    let persistent = Arc::new(CountingActivator::new(2));
    runtime
        .attach_activator(persistent.clone())
        .expect("activator");
    let result: Result<(), ExecutionFailure> =
        runtime.restore_lease_after_refresh_failure(NativeToolId::YtDlp, None);
    assert!(matches!(result, Err(ExecutionFailure::Internal)));
    assert_eq!(persistent.refreshes.load(Ordering::Relaxed), 2);
    assert!(runtime.0.active_leases.read().unwrap().is_empty());
}

#[test]
fn diagnostic_action_values_are_the_frozen_public_contract() {
    assert_eq!(NativeToolAction::Install.as_str(), "install");
    assert_eq!(NativeToolAction::Remove.as_str(), "remove");
}
