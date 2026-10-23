mod alignment;
mod contracts;
mod export;
mod narration;
mod publication;
mod runtime;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use osg_domain::{JobId, JobKind, JobState, JobUpdate, ProjectId};
use osg_infrastructure::secrets::CredentialId;
use osg_infrastructure::storage::{ArtifactId, ContentHash, Database};
use osg_runtime_staging::RuntimeStagingAuthority;
use osg_speech::{AudioFormat, LazySpeechWorker, SpeechError, WorkerProgram};
use tempfile::TempDir;

use super::alignment::{
    SpeechAlignmentManifest, SpeechAlignmentResult, read_alignment_manifest,
    store_alignment_result, validate_alignment_start,
};
use super::artifact_types::{
    SpeechAlignmentClipRequest, SpeechAlignmentStartRequest, SpeechArtifactExportEntry,
    SpeechArtifactExportRequest, SpeechArtifactFormatResponse, SpeechReferenceBackend,
};
use super::artifacts::{
    SpeechArtifactMetadata, commit_completed_speech_source,
    commit_completed_speech_source_with_hook, parse_artifact_id, publish_durable_artifact,
    publish_project_durable_artifact, register_speech_playback, resolve_audio_artifact,
    rollback_published_speech_artifact,
};
use super::batch::SynthesisConcurrencyProbe;
use super::commands::{ProbeLifecycleOwnership, probe_join_result};
use super::export::{
    SpeechExportPlan, SpeechExportSource, export_speech_plan, is_safe_export_file_name,
    prepare_speech_export,
};
use super::jobs::{
    SpeechFailureCode, SpeechJobEvent, SpeechJobManifest, SpeechPhaseResponse, StoredSpeechResult,
    batch_terminal_failure, read_manifest,
};
use super::lifecycle::{
    SpeechLifecycleOwnership, SpeechProjectAuthority, initialize_manifest_with_hook,
    initialize_registered_speech_job_with_hook, register_owned_speech_job_with_hook,
    worker_join_result,
};
use super::narration::{
    SpeechNarrationCueId, SpeechNarrationSource, SpeechProjectNarrationPutRequest,
    SpeechProjectNarrationResultRequest, get_project_narration, project_narration_storage_key,
    put_project_narration,
};
use super::requests::{
    SpeechBackendRequest, SpeechProfileRequest, SpeechSegmentRequest, SpeechStartRequest,
    SpeechVoiceGenderResponse, SpeechVoiceResponse,
};
use super::runtime::{CachedWorker, ManagedSpeechWorker, SpeechRuntime, WorkerPaths};
use super::*;
use crate::background;

fn standalone_runtime(directory: &TempDir) -> SpeechRuntime {
    SpeechRuntime::new(
        directory.path().join("standalone-install"),
        directory.path().join("standalone-work"),
        None,
    )
    .unwrap()
}

struct SpeechTestFixture {
    directory: TempDir,
    runtime: SpeechRuntime,
    database: Database,
    jobs: background::DesktopJobs,
}

impl SpeechTestFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let runtime = SpeechRuntime::new(
            directory.path().join("install"),
            directory.path().join("work"),
            None,
        )
        .unwrap();
        let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
        let jobs =
            Arc::new(osg_application::JobRegistry::new(Arc::new(database.clone()), []).unwrap());
        Self {
            directory,
            runtime,
            database,
            jobs,
        }
    }

    fn enable(&self, backend: SpeechBackendRequest) -> SpeechLifecycleOwnership {
        let epoch = self.runtime.lifecycle_epoch(backend).unwrap();
        assert!(
            self.runtime
                .commit_voice_inventory_for_epoch(backend, epoch, Vec::new())
        );
        SpeechLifecycleOwnership::capture(&self.runtime, backend, epoch).unwrap()
    }

    fn registered_running_job(&self) -> JobId {
        let queued = self.jobs.register(JobKind::SynthesizeNarration).unwrap();
        let job_id = queued.snapshot().id();
        self.jobs.apply(job_id, JobUpdate::Start).unwrap();
        job_id
    }

    fn running_job(&self, backend: SpeechBackendRequest) -> JobId {
        let job_id = self.registered_running_job();
        self.database
            .put_setting(
                MANIFEST_SCOPE,
                &job_id.to_string(),
                &serde_json::to_value(SpeechJobManifest {
                    schema_version: MANIFEST_SCHEMA_VERSION,
                    backend,
                    project_id: None,
                    expected_project_state_version: None,
                    results: Vec::new(),
                })
                .unwrap(),
            )
            .unwrap();
        job_id
    }
}

fn test_artifact_metadata(source: &'static str) -> SpeechArtifactMetadata {
    SpeechArtifactMetadata {
        format: SpeechArtifactFormatResponse::Wav,
        duration_micros: Some(1_000_000),
        sample_rate_hz: Some(24_000),
        channels: Some(1),
        source,
    }
}

fn commit_empty_project_revision(
    database: &Database,
    project: &osg_application::ProjectSnapshot,
    reason: &str,
) {
    let changed = osg_application::ProjectSnapshot::new(
        project.metadata().clone(),
        project.state_version(),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    database
        .commit_project(&changed, &osg_domain::RevisionReason::new(reason).unwrap())
        .unwrap();
}

struct BlockedSpeechPublication {
    artifact: std::sync::mpsc::Receiver<ArtifactId>,
    release: std::sync::mpsc::Sender<()>,
    event: std::sync::mpsc::Receiver<()>,
    handle: std::thread::JoinHandle<Result<StoredSpeechResult, SpeechFailureCode>>,
}

fn spawn_blocked_speech_publication(
    runtime: SpeechRuntime,
    ownership: SpeechLifecycleOwnership,
    database: Database,
    source: PathBuf,
    job_id: JobId,
) -> BlockedSpeechPublication {
    let (artifact_tx, artifact) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let (event_tx, event) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        commit_completed_speech_source_with_hook(
            &runtime,
            &ownership,
            &database,
            &source,
            test_artifact_metadata("crossBackendStopTest"),
            None,
            job_id,
            "stopped".to_owned(),
            "narrationOutput",
            |published| {
                artifact_tx.send(published.id).unwrap();
                release_rx.recv().unwrap();
            },
            |_| event_tx.send(()).unwrap(),
        )
    });
    BlockedSpeechPublication {
        artifact,
        release,
        event,
        handle,
    }
}

struct LiveSpeechPublication {
    attempted: std::sync::mpsc::Receiver<()>,
    event: std::sync::mpsc::Receiver<()>,
    handle: std::thread::JoinHandle<Result<StoredSpeechResult, SpeechFailureCode>>,
}

fn spawn_live_speech_publication(
    runtime: SpeechRuntime,
    ownership: SpeechLifecycleOwnership,
    database: Database,
    source: PathBuf,
    job_id: JobId,
) -> LiveSpeechPublication {
    let (attempted_tx, attempted) = std::sync::mpsc::channel();
    let (event_tx, event) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        attempted_tx.send(()).unwrap();
        commit_completed_speech_source(
            &runtime,
            &ownership,
            &database,
            &source,
            test_artifact_metadata("crossBackendStopTest"),
            None,
            job_id,
            "live".to_owned(),
            "narrationOutput",
            |_| event_tx.send(()).unwrap(),
        )
    });
    LiveSpeechPublication {
        attempted,
        event,
        handle,
    }
}

async fn assert_stop_during_registration_is_rejected(
    fixture: &SpeechTestFixture,
    backend: SpeechBackendRequest,
) {
    let ownership = fixture.enable(backend);
    let stop_runtime = fixture.runtime.clone();
    let result = register_owned_speech_job_with_hook(
        &fixture.runtime,
        &ownership,
        &fixture.database,
        &fixture.jobs,
        move || stop_runtime.shutdown(backend).unwrap(),
    )
    .await;

    assert_eq!(result.unwrap_err().code(), "internal");
    let jobs = fixture.jobs.list().unwrap();
    assert_eq!(jobs.len(), 1);
    let snapshot = jobs[0].snapshot();
    assert_eq!(snapshot.state(), JobState::Cancelled);
    assert!(
        fixture
            .database
            .get_setting(MANIFEST_SCOPE, &snapshot.id().to_string())
            .unwrap()
            .is_none()
    );
}

async fn assert_manifest_precommit_stall_is_backend_isolated(
    fixture: &SpeechTestFixture,
    backend: SpeechBackendRequest,
) {
    let ownership = fixture.enable(backend);
    let other_backend = SpeechBackendRequest::EdgeTts;
    let other_ownership = fixture.enable(other_backend);
    let job_id = fixture.registered_running_job();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let init_runtime = fixture.runtime.clone();
    let reentry_runtime = fixture.runtime.clone();
    let init_ownership = ownership.clone();
    let init_database = fixture.database.clone();
    let init_jobs = Arc::clone(&fixture.jobs);
    let initializer = tokio::spawn(async move {
        initialize_registered_speech_job_with_hook(
            &init_runtime,
            &init_ownership,
            &init_database,
            &init_jobs,
            job_id,
            move || {
                let _ = reentry_runtime.status(other_backend);
                reentry_runtime.shutdown(other_backend).unwrap();
                let restarted_epoch = reentry_runtime.lifecycle_epoch(other_backend).unwrap();
                assert!(reentry_runtime.commit_voice_inventory_for_epoch(
                    other_backend,
                    restarted_epoch,
                    Vec::new(),
                ));
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            },
        )
        .await
    });
    tokio::task::yield_now().await;
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(other_ownership.ensure_current(&fixture.runtime).is_err());
    let restarted_other_epoch = fixture.runtime.lifecycle_epoch(other_backend).unwrap();
    assert!(
        SpeechLifecycleOwnership::capture(&fixture.runtime, other_backend, restarted_other_epoch,)
            .is_ok()
    );
    fixture.runtime.shutdown(backend).unwrap();
    release_tx.send(()).unwrap();
    assert_eq!(initializer.await.unwrap().unwrap_err().code(), "internal");
    assert!(
        fixture
            .database
            .get_setting(MANIFEST_SCOPE, &job_id.to_string())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture.jobs.get(job_id).unwrap().snapshot().state(),
        JobState::Cancelled
    );
}

fn run_async_speech_test(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future);
}

fn insert_cached_test_worker(
    runtime: &SpeechRuntime,
    backend: SpeechBackendRequest,
    marker: &Path,
) {
    let executable = std::env::current_exe().unwrap();
    let worker = Arc::new(ManagedSpeechWorker {
        worker: LazySpeechWorker::new(
            WorkerProgram::native(&executable).unwrap(),
            backend.native(),
        ),
        managed_runtime: None,
    });
    runtime.0.workers.lock().unwrap().insert(
        backend,
        CachedWorker {
            paths: WorkerPaths {
                python: executable,
                bootstrap: marker.to_owned(),
                model: None,
                model_store: None,
            },
            worker,
        },
    );
}
