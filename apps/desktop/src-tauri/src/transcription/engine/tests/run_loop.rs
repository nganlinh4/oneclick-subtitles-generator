//! Run-loop behaviour with a scripted executor and store: no network, no ffmpeg.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_application::JobRegistry;
use osg_domain::{JobKind, JobState, TranscriptRevisionId};
use osg_infrastructure::storage::{
    Database, DatabaseError, TranscriptRevisionState, TranscriptTurnRecord, TranscriptWordRecord,
};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio_util::sync::CancellationToken;

use super::super::executor::{WindowExecutor, WindowFuture};
use super::super::run_loop::{EngineRun, run_engine_loop};
use super::super::store::RevisionStore;
use crate::background::{self, DesktopJobs};
use crate::transcription::planner::WindowRange;
use crate::transcription::projection::{ProjectedWordResult, WordProjectionStatus};
use crate::transcription::staging::StagedWindowResult;
use crate::transcription::worker::{TimedWindowCallback, WorkerError};

#[derive(Clone, Copy)]
enum Step {
    /// Finish after `delay_ms` with `words` accepted words.
    Words { words: usize, delay_ms: u64 },
    /// Fail with an error whose raw text carries a native path.
    Fail,
    /// Never finish until the run is cancelled.
    Hang,
}

#[derive(Default)]
struct Executor {
    steps: HashMap<usize, Step>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
}

impl WindowExecutor for Executor {
    fn prepare(
        &self,
        window: WindowRange,
        cancellation: CancellationToken,
        _on_timed_window: TimedWindowCallback,
    ) -> WindowFuture {
        let step = self.steps[&window.index];
        let in_flight = Arc::clone(&self.in_flight);
        let max_in_flight = Arc::clone(&self.max_in_flight);
        Box::pin(async move {
            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            max_in_flight.fetch_max(now, Ordering::SeqCst);
            let result = match step {
                Step::Words { words, delay_ms } => {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    Ok(staged(window, words))
                }
                Step::Fail => Err(WorkerError::Io(std::io::Error::other(
                    "C:\\Users\\victim\\temp\\window.wav",
                ))),
                Step::Hang => {
                    cancellation.cancelled().await;
                    Err(WorkerError::Cancelled)
                }
            };
            in_flight.fetch_sub(1, Ordering::SeqCst);
            result
        })
    }
}

fn staged(window: WindowRange, words: usize) -> StagedWindowResult {
    let words = (0..words)
        .map(|index| {
            let start = window.start_ms + i64::try_from(index).unwrap() * 500;
            ProjectedWordResult {
                status: WordProjectionStatus::Accepted,
                text: format!("w{}x{index}.", window.index),
                raw_start_ns: 0,
                raw_end_ns: 400_000_000,
                project_start_ms: start,
                project_end_ms: start + 400,
                speaker_id: Some("w0:spk0".to_owned()),
                is_unaligned: false,
                alignment_status: "aligned".to_owned(),
            }
        })
        .collect();
    StagedWindowResult {
        window_index: window.index,
        window,
        words,
    }
}

#[derive(Default)]
struct Store {
    fail_on_call: Option<usize>,
    promotions: Mutex<Vec<usize>>,
    states: Mutex<Vec<TranscriptRevisionState>>,
}

impl RevisionStore for Store {
    fn promote_window(
        &self,
        _revision_id: TranscriptRevisionId,
        _turns: &[TranscriptTurnRecord],
        words: &[TranscriptWordRecord],
    ) -> Result<(), DatabaseError> {
        let mut promotions = self.promotions.lock().unwrap();
        if self.fail_on_call == Some(promotions.len()) {
            return Err(DatabaseError::Integrity(
                "disk I/O error at C:\\Users\\victim\\osg.sqlite3".to_owned(),
            ));
        }
        promotions.push(words.len());
        Ok(())
    }

    fn set_state(
        &self,
        _revision_id: TranscriptRevisionId,
        state: TranscriptRevisionState,
    ) -> Result<(), DatabaseError> {
        self.states.lock().unwrap().push(state);
        Ok(())
    }
}

struct Harness {
    _directory: tempfile::TempDir,
    jobs: DesktopJobs,
    store: Arc<Store>,
    executor: Arc<Executor>,
    events: Arc<Mutex<Vec<Value>>>,
}

impl Harness {
    fn new(steps: &[Step], fail_on_call: Option<usize>) -> Self {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let database = Database::open(directory.path().join("jobs.sqlite3")).expect("database");
        Self {
            _directory: directory,
            jobs: Arc::new(JobRegistry::restore(Arc::new(database)).expect("job registry")),
            store: Arc::new(Store {
                fail_on_call,
                ..Store::default()
            }),
            executor: Arc::new(Executor {
                steps: steps.iter().copied().enumerate().collect(),
                ..Executor::default()
            }),
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    async fn start(&self, provider_sessions: usize) -> (EngineRun, CancellationToken) {
        let ticket = background::register_running(&self.jobs, JobKind::Transcribe)
            .await
            .expect("running job");
        let sink = Arc::clone(&self.events);
        let events = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        let count = self.executor.steps.len();
        let windows = (0..count)
            .map(|index| {
                let start = i64::try_from(index).unwrap() * 60_000;
                WindowRange::new(index, start, start + 60_000)
            })
            .collect();
        let cancellation = ticket.cancellation().clone();
        let run = EngineRun {
            jobs: Arc::clone(&self.jobs),
            store: Arc::clone(&self.store) as Arc<dyn RevisionStore>,
            executor: Arc::clone(&self.executor) as Arc<dyn WindowExecutor>,
            job_id: ticket.snapshot().id(),
            revision_id: TranscriptRevisionId::new(),
            windows,
            provider_sessions,
            cancellation: cancellation.clone(),
            events,
        };
        (run, cancellation)
    }

    async fn run(&self, provider_sessions: usize) -> JobState {
        let (run, _) = self.start(provider_sessions).await;
        let job_id = run.job_id;
        run_engine_loop(run).await;
        self.job_state(job_id)
    }

    fn job_state(&self, job_id: osg_domain::JobId) -> JobState {
        self.jobs.get(job_id).unwrap().snapshot().state()
    }

    fn events_named(&self, name: &str) -> Vec<Value> {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .filter(|event| event["event"] == name)
            .cloned()
            .collect()
    }

    fn states(&self) -> Vec<TranscriptRevisionState> {
        self.store.states.lock().unwrap().clone()
    }
}

const fn words(words: usize, delay_ms: u64) -> Step {
    Step::Words { words, delay_ms }
}

#[tokio::test]
async fn windows_promote_in_order_even_when_they_finish_out_of_order() {
    let harness = Harness::new(&[words(2, 90), words(3, 50), words(1, 10)], None);
    assert_eq!(harness.run(3).await, JobState::Succeeded);

    let promoted = harness.events_named("windowPromoted");
    let order: Vec<_> = promoted.iter().map(|e| e["windowIndex"].clone()).collect();
    assert_eq!(order, [0, 1, 2]);
    assert_eq!(*harness.store.promotions.lock().unwrap(), [2, 3, 1]);
    let completed = harness.events_named("completed");
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0]["totalWords"], 6);
    assert_eq!(harness.states(), [TranscriptRevisionState::Completed]);
    assert!(harness.events_named("failed").is_empty());
}

#[tokio::test]
async fn provider_sessions_bound_how_many_windows_run_at_once() {
    let steps = vec![words(1, 25); 12];
    let harness = Harness::new(&steps, None);
    assert_eq!(harness.run(3).await, JobState::Succeeded);
    let max = harness.executor.max_in_flight.load(Ordering::SeqCst);
    assert!((1..=3).contains(&max), "observed {max} concurrent windows");
    assert_eq!(harness.events_named("windowPromoted").len(), 12);
    // Every planned range is published up front, not only once a session admits it.
    let progress = harness.events_named("windowProgress");
    let queued = progress.iter().filter(|e| e["phase"] == "queued");
    assert_eq!(queued.count(), 12);
}

#[tokio::test]
async fn a_failed_window_yields_a_partial_revision_with_a_path_free_error() {
    let harness = Harness::new(&[words(2, 5), Step::Fail, words(2, 5)], None);
    assert_eq!(harness.run(3).await, JobState::Failed);

    let failures = harness.events_named("failed");
    let window_failure = failures
        .iter()
        .find(|e| e["error"]["code"] == "window_failed")
        .expect("window failure event");
    assert_eq!(window_failure["error"]["windowIndex"], 1);
    let message = window_failure["error"]["message"].as_str().unwrap();
    assert!(
        !message.contains("victim"),
        "raw error text leaked: {message}"
    );
    assert!(
        failures
            .iter()
            .any(|e| e["error"]["code"] == "partial_transcription_failure")
    );
    // Window 2 still promotes past the failed window 1.
    assert_eq!(harness.events_named("windowPromoted").len(), 2);
    assert_eq!(harness.states(), [TranscriptRevisionState::Partial]);
}

#[tokio::test]
async fn all_windows_failing_or_silent_yields_a_failed_revision() {
    let failing = Harness::new(&[Step::Fail, Step::Fail], None);
    assert_eq!(failing.run(2).await, JobState::Failed);
    assert_eq!(failing.states(), [TranscriptRevisionState::Failed]);
    let last = failing.events_named("failed").pop().unwrap();
    assert_eq!(last["error"]["code"], "window_failed");
    assert!(last["error"]["windowIndex"].is_null());

    let silent = Harness::new(&[words(0, 1), words(0, 1)], None);
    assert_eq!(silent.run(2).await, JobState::Failed);
    assert_eq!(silent.states(), [TranscriptRevisionState::Failed]);
    let last = silent.events_named("failed").pop().unwrap();
    assert_eq!(last["error"]["code"], "zero_words_transcribed");
}

#[tokio::test]
async fn a_database_failure_stops_the_run_with_a_mapped_error() {
    let harness = Harness::new(&[words(2, 1), words(2, 30), Step::Hang], Some(1));
    assert_eq!(harness.run(3).await, JobState::Failed);

    let failures = harness.events_named("failed");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["error"]["code"], "database_error");
    assert_eq!(failures[0]["error"]["windowIndex"], 1);
    let message = failures[0]["error"]["message"].as_str().unwrap();
    assert!(
        !message.contains("victim") && !message.contains("disk I/O"),
        "{message}"
    );
    // The hanging window is cancelled rather than left running.
    for _ in 0..400 {
        if harness.executor.in_flight.load(Ordering::SeqCst) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(harness.executor.in_flight.load(Ordering::SeqCst), 0);
    assert_eq!(harness.states(), [TranscriptRevisionState::Partial]);
}

#[tokio::test]
async fn cancellation_settles_the_job_and_keeps_promoted_words_as_partial() {
    let harness = Harness::new(&[words(3, 1), Step::Hang, Step::Hang], None);
    let (run, cancellation) = harness.start(3).await;
    let job_id = run.job_id;
    let loop_task = tokio::spawn(run_engine_loop(run));
    for _ in 0..400 {
        if !harness.store.promotions.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    cancellation.cancel();
    loop_task.await.expect("run loop finished");

    assert_eq!(harness.job_state(job_id), JobState::Cancelled);
    assert_eq!(harness.events_named("cancelled").len(), 1);
    assert!(harness.events_named("completed").is_empty());
    assert_eq!(harness.states(), [TranscriptRevisionState::Partial]);
}

#[tokio::test]
async fn cancellation_before_any_promotion_marks_the_revision_failed() {
    let harness = Harness::new(&[Step::Hang, Step::Hang], None);
    let (run, cancellation) = harness.start(1).await;
    let job_id = run.job_id;
    cancellation.cancel();
    run_engine_loop(run).await;
    assert_eq!(harness.job_state(job_id), JobState::Cancelled);
    assert_eq!(harness.states(), [TranscriptRevisionState::Failed]);
}
