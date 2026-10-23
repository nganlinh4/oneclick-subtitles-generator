use std::sync::Arc;

use osg_application::JobRegistry;
use osg_domain::{JobKind, JobUpdate};
use osg_engine_packages::{
    EngineId, EnginePackageManager, OperationPhase, OperationProgress, RuntimeCoordinator,
};
use osg_infrastructure::storage::Database;
use serde_json::json;

use super::OPERATION_SCOPE;
use super::durable::map_progress;
use super::types::{
    DurableOperation, EnginePackageAction, EnginePackagePhase, EnginePackageRuntime,
};

#[derive(Debug)]
struct NoopCoordinator;

impl RuntimeCoordinator for NoopCoordinator {
    fn quiesce(&self, _: EngineId) -> osg_engine_packages::Result<()> {
        Ok(())
    }
}

fn runtime_fixture() -> (tempfile::TempDir, EnginePackageRuntime) {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(temporary.path().join("db.sqlite3")).expect("database");
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
    let manager =
        EnginePackageManager::new(temporary.path().join("packages"), Arc::new(NoopCoordinator))
            .expect("package manager");
    let runtime = EnginePackageRuntime::new(manager, database, jobs).expect("runtime");
    (temporary, runtime)
}

#[test]
fn whole_job_progress_is_monotonic_across_package_phases() {
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
        .map(|progress| {
            map_progress(EnginePackageAction::Install, progress)
                .expect("valid progress")
                .1
        })
        .collect::<Vec<_>>();
    assert!(mapped.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(mapped, vec![5_000, 5_000, 7_500, 9_900]);
}

#[test]
fn status_reconnects_from_durable_path_free_operation_metadata() {
    let (_temporary, runtime) = runtime_fixture();
    let mut reservation = runtime.reserve(EngineId::Parakeet).expect("reservation");
    let queued = runtime
        .0
        .jobs
        .register(JobKind::InstallEngine)
        .expect("job");
    let running = runtime
        .0
        .jobs
        .apply(queued.snapshot().id(), JobUpdate::Start)
        .expect("running");
    runtime
        .activate(
            &mut reservation,
            DurableOperation::preparing(
                running.snapshot(),
                EngineId::Parakeet,
                EnginePackageAction::Install,
            ),
            osg_engine_packages::CancellationToken::default(),
        )
        .expect("activate");

    let status = runtime.status().expect("status");
    let operation = status.engines[0]
        .operation
        .as_ref()
        .expect("durable operation");
    assert_eq!(operation.job.id(), running.snapshot().id());
    assert_eq!(operation.engine, EngineId::Parakeet);
    assert_eq!(operation.phase, EnginePackagePhase::Preparing);
    let encoded = serde_json::to_string(&status).expect("serialize status");
    assert!(!encoded.contains("packages"));
    assert!(!encoded.contains("Users"));
    assert!(!encoded.contains("http"));
}

#[test]
fn startup_removes_stale_or_malformed_operation_metadata() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(temporary.path().join("db.sqlite3")).expect("database");
    database
        .put_setting(
            OPERATION_SCOPE,
            "stale",
            &json!({ "privatePath": "hidden" }),
        )
        .expect("stale metadata");
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone())).expect("jobs"));
    let manager =
        EnginePackageManager::new(temporary.path().join("packages"), Arc::new(NoopCoordinator))
            .expect("package manager");
    EnginePackageRuntime::new(manager, database.clone(), jobs).expect("runtime");
    assert!(
        database
            .list_settings(OPERATION_SCOPE)
            .expect("operation settings")
            .is_empty()
    );
}

#[test]
fn completed_publication_wins_a_late_cancellation_request() {
    let (_temporary, runtime) = runtime_fixture();
    let queued = runtime
        .0
        .jobs
        .register(JobKind::InstallEngine)
        .expect("job");
    let job_id = queued.snapshot().id();
    runtime
        .0
        .jobs
        .apply(job_id, JobUpdate::Start)
        .expect("running");
    runtime
        .0
        .jobs
        .apply(job_id, JobUpdate::RequestCancellation)
        .expect("cancelling");

    let event = runtime.terminal_event(
        job_id,
        EngineId::Parakeet,
        EnginePackageAction::Install,
        Ok(()),
    );
    let super::types::EnginePackageEvent::Completed { job, .. } = event else {
        panic!("a published package must complete rather than report a false cancellation");
    };
    assert_eq!(job.state(), osg_domain::JobState::Succeeded);
    assert_eq!(job.progress().basis_points(), 10_000);
}
