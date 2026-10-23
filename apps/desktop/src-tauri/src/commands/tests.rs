mod activation;
mod candidates;
mod relaunch;

use std::{
    fs,
    sync::{Arc, RwLock},
};

use osg_application::{JobRegistry, ProjectSnapshot, inspect_media};
use osg_domain::{
    AssetId, JobKind, JobSnapshot, JobUpdate, MediaAsset, MediaKind, ProjectMetadata,
    RevisionReason,
};
use osg_infrastructure::storage::Database;
use osg_media_server::MediaServer;

use super::jobs::{abandon_orphaned_transcribe, bounded_job_list};
use super::media_activation::{
    ProjectMediaAuthorization, begin_media_activation, clear_activated_media,
    commit_activated_media, commit_authorized_activated_media, invalidate_pending_media_activation,
    reopen_media_asset,
};
use super::{MAX_EXPOSED_ACTIVE_JOBS, MAX_EXPOSED_TERMINAL_JOBS, media_picker_outcome};
use crate::state::EditorSession;

#[test]
fn media_picker_diagnostic_outcome_is_categorical_and_path_free() {
    assert_eq!(media_picker_outcome(Some(&"private-path")), "selected");
    assert_eq!(media_picker_outcome::<&str>(None), "none");
}

#[test]
fn orphaned_transcription_recovery_terminalizes_queued_and_running_work_only() {
    let directory = tempfile::tempdir().expect("temporary jobs directory");
    let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database)).expect("job registry"));

    let queued = jobs
        .register(JobKind::Transcribe)
        .expect("queued transcription");
    let queued_id = queued.snapshot().id();
    let cancelled =
        abandon_orphaned_transcribe(&jobs, queued_id).expect("abandon queued transcription");
    assert_eq!(cancelled.state(), osg_domain::JobState::Cancelled);

    let running = jobs
        .register(JobKind::Transcribe)
        .expect("running transcription");
    let running_id = running.snapshot().id();
    let running = jobs
        .apply(running_id, JobUpdate::Start)
        .expect("start transcription");
    let cancellation = running.cancellation().clone();
    let cancelling =
        abandon_orphaned_transcribe(&jobs, running_id).expect("abandon running transcription");
    assert_eq!(cancelling.state(), osg_domain::JobState::Cancelling);
    assert!(cancellation.is_cancelled());
    let cancelled = jobs
        .apply(running_id, JobUpdate::ConfirmCancelled)
        .expect("worker confirms cancellation");
    assert_eq!(
        cancelled.snapshot().state(),
        osg_domain::JobState::Cancelled
    );

    let foreign = jobs.register(JobKind::RenderVideo).expect("foreign job");
    assert!(abandon_orphaned_transcribe(&jobs, foreign.snapshot().id()).is_err());
}

fn attach_media_to_project(database: &Database, asset: &MediaAsset) -> ProjectMediaAuthorization {
    let metadata = ProjectMetadata::new("Media activation fixture").expect("project metadata");
    let base = database.create_project(&metadata).expect("create project");
    let snapshot = ProjectSnapshot::new(
        metadata,
        base.state_version(),
        vec![asset.clone()],
        Vec::new(),
    )
    .expect("project snapshot");
    let commit = database
        .commit_project(
            &snapshot,
            &RevisionReason::new("attach media fixture").expect("revision reason"),
        )
        .expect("attach media");
    ProjectMediaAuthorization {
        project_id: snapshot.metadata().id(),
        expected_state_version: commit.state_version,
    }
}

#[test]
fn exposed_job_list_keeps_active_work_and_bounds_terminal_history() {
    let active = JobSnapshot::new(JobKind::SynthesizeNarration);
    let mut terminals = Vec::new();
    for _ in 0..(MAX_EXPOSED_TERMINAL_JOBS + 17) {
        let mut terminal = JobSnapshot::new(JobKind::RenderVideo);
        terminal.start().expect("start terminal fixture");
        terminal.succeed().expect("finish terminal fixture");
        terminals.push(terminal);
    }
    let oldest = terminals[0].id();
    let newest = terminals.last().expect("newest terminal job").id();
    terminals.push(active.clone());

    let exposed = bounded_job_list(terminals).expect("bounded job exposure");

    assert_eq!(exposed.len(), MAX_EXPOSED_TERMINAL_JOBS + 1);
    assert!(exposed.iter().any(|job| job.id() == active.id()));
    assert!(exposed.iter().any(|job| job.id() == newest));
    assert!(!exposed.iter().any(|job| job.id() == oldest));
}

#[test]
fn exposed_job_list_fails_closed_instead_of_omitting_active_work() {
    let active = (0..=MAX_EXPOSED_ACTIVE_JOBS)
        .map(|_| JobSnapshot::new(JobKind::SynthesizeNarration))
        .collect();

    assert!(bounded_job_list(active).is_err());
}
