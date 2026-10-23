//! The engine loop: bounded window admission, in-order promotion, and revision outcomes.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use osg_domain::{JobId, JobUpdate, TranscriptRevisionId};
use osg_infrastructure::storage::TranscriptRevisionState;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use super::executor::{WindowExecutor, WindowFuture};
use super::store::{self, RevisionStore};
use crate::background;
use crate::transcription::events::{TranscriptionErrorDto, WordNativeTranscriptionEvent};
use crate::transcription::planner::WindowRange;
use crate::transcription::staging::StagingBuffer;
use crate::transcription::worker::{TimedWindowCallback, WorkerPool};

pub(crate) struct EngineRun {
    pub(crate) jobs: background::DesktopJobs,
    pub(crate) store: Arc<dyn RevisionStore>,
    pub(crate) executor: Arc<dyn WindowExecutor>,
    pub(crate) job_id: JobId,
    pub(crate) revision_id: TranscriptRevisionId,
    pub(crate) windows: Vec<WindowRange>,
    /// Windows that may hold a provider session at once (see `ConcurrencyPlan`).
    pub(crate) provider_sessions: usize,
    pub(crate) cancellation: CancellationToken,
    pub(crate) events: Channel<WordNativeTranscriptionEvent>,
}

impl EngineRun {
    fn emit(&self, event: WordNativeTranscriptionEvent) {
        let _ = self.events.send(event);
    }

    fn fail_event(&self, error: TranscriptionErrorDto) -> WordNativeTranscriptionEvent {
        WordNativeTranscriptionEvent::Failed {
            job_id: self.job_id,
            error,
        }
    }
}

#[derive(Default)]
struct Promoted {
    windows: usize,
    words: usize,
    turns: usize,
    cues: Vec<crate::transcription::events::ProjectedCueDto>,
}

pub(crate) async fn run_engine_loop(run: EngineRun) {
    let start_time = Instant::now();
    let total_windows = run.windows.len();
    run.emit(WordNativeTranscriptionEvent::StageChanged {
        job_id: run.job_id,
        stage: "audio_extracting".to_owned(),
        message: "Extracting audio and initializing transcription".to_owned(),
        window_index: Some(0),
        total_windows: Some(total_windows),
    });

    let staging = Arc::new(StagingBuffer::new());
    let sessions = WorkerPool::new(run.provider_sessions.max(1));
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let has_failures = Arc::new(AtomicBool::new(false));

    // Every window is admitted as a task in order; the session pool bounds how many run at once.
    for window in run.windows.iter().copied() {
        // Publish every planned range up front, even while the window waits for a session.
        run.emit(WordNativeTranscriptionEvent::WindowProgress {
            job_id: run.job_id,
            window_index: window.index,
            total_windows,
            window_start_ms: window.start_ms,
            window_end_ms: window.end_ms,
            phase: "queued".to_owned(),
            fraction: Some(0.0),
        });
        let work = run.executor.prepare(
            window,
            run.cancellation.clone(),
            timed_callback(&run, window.index),
        );
        let task = WindowTask {
            window,
            total_windows,
            job_id: run.job_id,
            sessions: sessions.clone(),
            staging: Arc::clone(&staging),
            cancel: run.cancellation.clone(),
            events: run.events.clone(),
            notify: notify_tx.clone(),
            failures: Arc::clone(&has_failures),
        };
        tauri::async_runtime::spawn(task.run(work));
    }
    drop(notify_tx);

    let mut promoted = Promoted::default();
    loop {
        if run.cancellation.is_cancelled() {
            return finish_cancelled(&run, promoted.words).await;
        }
        if promote_ready(&run, &staging, &mut promoted).await.is_err() {
            return;
        }
        if promoted.windows >= total_windows {
            break;
        }
        // Cancelled windows exit without notifying, so a closed channel can race cancellation;
        // cancellation must win or a cancelled run would be settled as failed.
        tokio::select! {
            biased;
            () = run.cancellation.cancelled() => {
                return finish_cancelled(&run, promoted.words).await;
            }
            message = notify_rx.recv() => {
                // Tasks stage before notifying, so a closed channel leaves nothing to promote.
                if message.is_none() {
                    break;
                }
            }
        }
    }

    if promoted.windows < total_windows && run.cancellation.is_cancelled() {
        return finish_cancelled(&run, promoted.words).await;
    }
    let any_window_failed = has_failures.load(Ordering::Acquire)
        || promoted.windows < total_windows
        || staging.failed_indices_count() > 0;
    finish_settled(&run, promoted, any_window_failed, start_time).await;
}

/// One admitted window: waits for a provider session, runs, then stages or records failure.
struct WindowTask {
    window: WindowRange,
    total_windows: usize,
    job_id: JobId,
    sessions: WorkerPool,
    staging: Arc<StagingBuffer>,
    cancel: CancellationToken,
    events: Channel<WordNativeTranscriptionEvent>,
    notify: tokio::sync::mpsc::UnboundedSender<()>,
    failures: Arc<AtomicBool>,
}

impl WindowTask {
    async fn run(self, work: WindowFuture) {
        let window = self.window;
        let outcome = match self.sessions.acquire_permit(&self.cancel).await {
            Ok(_session) => {
                let _ = self
                    .events
                    .send(WordNativeTranscriptionEvent::StageChanged {
                        job_id: self.job_id,
                        stage: format!("transcribing_window_{}", window.index + 1),
                        message: format!(
                            "Transcribing window {}/{}",
                            window.index + 1,
                            self.total_windows
                        ),
                        window_index: Some(window.index),
                        total_windows: Some(self.total_windows),
                    });
                let _ = self
                    .events
                    .send(WordNativeTranscriptionEvent::WindowProgress {
                        job_id: self.job_id,
                        window_index: window.index,
                        total_windows: self.total_windows,
                        window_start_ms: window.start_ms,
                        window_end_ms: window.end_ms,
                        phase: "extracting".to_owned(),
                        fraction: Some(0.1),
                    });
                work.await
            }
            Err(error) => Err(error),
        };
        match outcome {
            Ok(staged) => self.staging.insert(staged),
            Err(_) if self.cancel.is_cancelled() => return,
            Err(error) => {
                crate::diagnostics::record(
                    "transcribe.window.failed",
                    &[
                        ("window", window.index.to_string()),
                        ("kind", error.diagnostic_kind().to_owned()),
                    ],
                );
                self.failures.store(true, Ordering::Release);
                let message = error.into_command_error();
                let _ = self.events.send(WordNativeTranscriptionEvent::Failed {
                    job_id: self.job_id,
                    error: TranscriptionErrorDto::new(
                        "window_failed",
                        message.message(),
                        Some(window.index),
                    ),
                });
                // Later staged windows still promote past a failed one.
                self.staging.skip_failed_window(window.index);
            }
        }
        let _ = self.notify.send(());
    }
}

/// Commits every window that is next in order. A database failure settles the whole run and
/// returns `Err`.
async fn promote_ready(
    run: &EngineRun,
    staging: &StagingBuffer,
    promoted: &mut Promoted,
) -> Result<(), ()> {
    let total_windows = run.windows.len();
    while let Some(staged) = staging.pop_promotable() {
        let window_index = staged.window_index;
        let window = staged.window;
        run.emit(WordNativeTranscriptionEvent::StageChanged {
            job_id: run.job_id,
            stage: format!("promoting_window_{}", window_index + 1),
            message: format!("Promoting window {}/{}", window_index + 1, total_windows),
            window_index: Some(window_index),
            total_windows: Some(total_windows),
        });
        let data = staging.prepare_promotion(run.revision_id, staged);
        let word_count = data.word_records.len();
        let turn_count = data.turn_records.len();
        let committed = store::promote(
            &run.store,
            run.revision_id,
            data.turn_records,
            data.word_records,
        )
        .await;
        if let Err(error) = committed {
            crate::diagnostics::record(
                "transcribe.promotion.failed",
                &[("window", window_index.to_string())],
            );
            run.cancellation.cancel();
            run.emit(run.fail_event(TranscriptionErrorDto::new(
                "database_error",
                error.message(),
                Some(window_index),
            )));
            let _ = background::finish_failure(&run.jobs, run.job_id).await;
            let state = TranscriptRevisionState::interrupted(promoted.words);
            store::set_state_best_effort(&run.store, run.revision_id, state).await;
            return Err(());
        }

        promoted.windows += 1;
        promoted.words += word_count;
        promoted.turns += turn_count;
        promoted.cues.extend(data.projected_cues.iter().cloned());
        run.emit(WordNativeTranscriptionEvent::WindowPromoted {
            job_id: run.job_id,
            revision_id: run.revision_id,
            window_index,
            total_windows,
            window_start_ms: window.start_ms,
            window_end_ms: window.end_ms,
            word_count,
            turn_count,
            words: data.word_dtos,
            turns: data.turn_dtos,
            projected_cues: data.projected_cues,
        });
    }
    Ok(())
}

fn timed_callback(run: &EngineRun, window_index: usize) -> TimedWindowCallback {
    let events = run.events.clone();
    let job_id = run.job_id;
    let revision_id = run.revision_id;
    Arc::new(move |snapshot| {
        // Reuse the exact final grouping rules. Prefixes are replaceable presentation, while
        // canonical SQLite promotion remains ordered and waits for a valid stop.
        let projected_cues = StagingBuffer::new()
            .prepare_promotion(revision_id, snapshot)
            .projected_cues;
        let _ = events.send(WordNativeTranscriptionEvent::WindowCues {
            job_id,
            window_index,
            projected_cues,
        });
    })
}

async fn finish_cancelled(run: &EngineRun, words_promoted: usize) {
    let _ = background::finish_cancellation(&run.jobs, run.job_id).await;
    run.emit(WordNativeTranscriptionEvent::Cancelled { job_id: run.job_id });
    let state = TranscriptRevisionState::interrupted(words_promoted);
    store::set_state_best_effort(&run.store, run.revision_id, state).await;
}

async fn finish_settled(
    run: &EngineRun,
    promoted: Promoted,
    any_window_failed: bool,
    start_time: Instant,
) {
    let total_windows = run.windows.len();
    if !any_window_failed && promoted.words > 0 {
        store::set_state_best_effort(
            &run.store,
            run.revision_id,
            TranscriptRevisionState::Completed,
        )
        .await;
        let _ = background::apply(&run.jobs, run.job_id, JobUpdate::Succeed).await;
        run.emit(WordNativeTranscriptionEvent::StageChanged {
            job_id: run.job_id,
            stage: "completed".to_owned(),
            message: "Transcription successfully completed".to_owned(),
            window_index: Some(total_windows.saturating_sub(1)),
            total_windows: Some(total_windows),
        });
        run.emit(WordNativeTranscriptionEvent::Completed {
            job_id: run.job_id,
            revision_id: run.revision_id,
            total_windows,
            total_words: promoted.words,
            total_turns: promoted.turns,
            duration_ms: i64::try_from(start_time.elapsed().as_millis()).unwrap_or(0),
            projected_cues: promoted.cues,
        });
        return;
    }

    let state = TranscriptRevisionState::interrupted(promoted.words);
    store::set_state_best_effort(&run.store, run.revision_id, state).await;
    let _ = background::finish_failure(&run.jobs, run.job_id).await;
    let error = if promoted.words > 0 {
        TranscriptionErrorDto::new(
            "partial_transcription_failure",
            format!(
                "Transcription partially succeeded with {} words ({}/{total_windows} windows promoted), but one or more windows failed",
                promoted.words, promoted.windows
            ),
            None,
        )
    } else if any_window_failed {
        TranscriptionErrorDto::new(
            "window_failed",
            "Transcription failed with no words promoted",
            None,
        )
    } else {
        TranscriptionErrorDto::new(
            "zero_words_transcribed",
            "Transcription completed with zero words recognized",
            None,
        )
    };
    run.emit(run.fail_event(error));
}
