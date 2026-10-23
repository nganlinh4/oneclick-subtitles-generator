use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use osg_application::JobRegistry;
use osg_domain::{JobKind, JobUpdate};
use osg_engine_packages::{
    OperationPhase, OperationProgress, SpeechPackageId, SpeechPackageManager,
    SpeechRuntimeCoordinator,
};
use osg_infrastructure::storage::Database;
use tauri::ipc::Channel;

use super::types::{SpeechPackageAction, SpeechPackagePhase, SpeechPackageRuntime};
use super::{SCHEMA_VERSION, map_progress};

#[derive(Debug)]
struct NoopCoordinator;

impl SpeechRuntimeCoordinator for NoopCoordinator {
    fn quiesce(&self, _: SpeechPackageId) -> osg_engine_packages::Result<()> {
        Ok(())
    }
}

fn runtime_fixture() -> (tempfile::TempDir, SpeechPackageRuntime) {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(temporary.path().join("db.sqlite3")).expect("database");
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database)).expect("jobs"));
    let manager =
        SpeechPackageManager::new(temporary.path().join("packages"), Arc::new(NoopCoordinator))
            .expect("package manager");
    (temporary, SpeechPackageRuntime::new(manager, jobs))
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
            map_progress(SpeechPackageAction::Install, progress)
                .expect("valid progress")
                .1
        })
        .collect::<Vec<_>>();
    assert_eq!(mapped, vec![5_000, 5_000, 7_500, 9_900]);
    assert!(mapped.windows(2).all(|pair| pair[0] <= pair[1]));
}

#[test]
fn reviewed_catalog_matches_the_current_platform_without_phantom_state() {
    let (_temporary, runtime) = runtime_fixture();
    let status = runtime.status().expect("status");
    let delivery_expected = cfg!(all(target_os = "windows", target_arch = "x86_64"));

    assert_eq!(status.schema_version, SCHEMA_VERSION);
    assert_eq!(status.packages.len(), 5);
    assert!(status.packages.iter().all(|entry| {
        entry.package.delivery_available == delivery_expected
            && !entry.package.installed
            && entry.operation.is_none()
    }));
}

#[test]
fn invalid_action_phase_pairs_fail_closed() {
    let error = map_progress(
        SpeechPackageAction::Remove,
        OperationProgress {
            phase: OperationPhase::Downloading,
            basis_points: 0,
            bytes_done: 0,
            total_bytes: 1,
        },
    );
    assert!(error.is_err());
    assert_eq!(
        super::phase_rank(SpeechPackageAction::Remove, SpeechPackagePhase::Publishing),
        u8::MAX
    );
}

#[test]
fn unchanged_durable_progress_is_not_replayed_on_the_channel() {
    let (_temporary, runtime) = runtime_fixture();
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
    let mut reservation = runtime.reserve(SpeechPackageId::Gtts).expect("reserve");
    runtime
        .activate(
            &mut reservation,
            running.snapshot(),
            SpeechPackageAction::Install,
            osg_engine_packages::CancellationToken::default(),
        )
        .expect("activate");

    let sent = Arc::new(AtomicUsize::new(0));
    let sent_from_channel = Arc::clone(&sent);
    let channel = Channel::new(move |_| {
        sent_from_channel.fetch_add(1, Ordering::Relaxed);
        Ok(())
    });
    runtime
        .report_progress(
            running.snapshot().id(),
            SpeechPackageAction::Install,
            OperationProgress {
                phase: OperationPhase::Preparing,
                basis_points: 0,
                bytes_done: 0,
                total_bytes: 0,
            },
            &channel,
        )
        .expect("unchanged preparing progress");
    assert_eq!(sent.load(Ordering::Relaxed), 0);

    runtime
        .report_progress(
            running.snapshot().id(),
            SpeechPackageAction::Install,
            OperationProgress {
                phase: OperationPhase::Downloading,
                basis_points: 100,
                bytes_done: 1,
                total_bytes: 100,
            },
            &channel,
        )
        .expect("advanced download progress");
    assert_eq!(sent.load(Ordering::Relaxed), 1);
}
