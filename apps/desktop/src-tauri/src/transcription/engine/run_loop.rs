//! The engine loop: windowed scheduling, staging promotion and revision updates.

use std::sync::Arc;
use std::time::Instant;

use osg_domain::{JobId, JobUpdate, TranscriptRevisionId};
use osg_gemini::{AudioTranscriptionConfig, GeminiClient};
use osg_infrastructure::storage::Database;
use osg_media::MediaInput as NativeMediaInput;
use osg_media_pipeline::MediaPipeline;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use super::TranscriptionModel;
use crate::background;
use crate::transcription::events::{TranscriptionErrorDto, WordNativeTranscriptionEvent};
use crate::transcription::staging::StagingBuffer;
use crate::transcription::worker::{WorkerPool, execute_transcription_window};

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub(super) async fn run_engine_loop(
    jobs: background::DesktopJobs,
    database: Database,
    job_id: JobId,
    revision_id: TranscriptRevisionId,
    total_windows: usize,
    windows: Vec<crate::transcription::planner::WindowRange>,
    clients: Vec<Arc<GeminiClient>>,
    pipeline: Arc<MediaPipeline>,
    native_input: Arc<NativeMediaInput>,
    asr_config: Arc<AudioTranscriptionConfig>,
    transcription_model: TranscriptionModel,
    cancellation: CancellationToken,
    on_event: Channel<WordNativeTranscriptionEvent>,
) {
    let start_time = Instant::now();

    // Initial StageChanged event
    let _ = on_event.send(WordNativeTranscriptionEvent::StageChanged {
        job_id,
        stage: "audio_extracting".to_owned(),
        message: "Extracting audio and initializing transcription".to_owned(),
        window_index: Some(0),
        total_windows: Some(total_windows),
    });

    let staging_buffer = Arc::new(StagingBuffer::new());
    // Preparing a window must not silently reduce the user-visible concurrency. Every planned
    // window is admitted; each releases its local extraction permit before opening the provider
    // session, so this capacity mirrors the exact public window count.
    let worker_pool = Arc::new(WorkerPool::new(total_windows));
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
    let has_failures = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Each requested window owns a concurrent provider session. Only local extraction is bounded.
    for window in windows {
        let pool = Arc::clone(&worker_pool);
        let buffer = Arc::clone(&staging_buffer);
        let credential_slot = credential_slot(window.index, clients.len());
        let client = Arc::clone(&clients[credential_slot]);
        let pipeline = Arc::clone(&pipeline);
        let input = Arc::clone(&native_input);
        let config = Arc::clone(&asr_config);
        let cancel = cancellation.clone();
        let event_channel = on_event.clone();
        let tx = notify_tx.clone();
        let failures = Arc::clone(&has_failures);

        crate::diagnostics::record(
            "transcribe.window.credential_assigned",
            &[
                ("window", window.index.to_string()),
                ("credential_slot", credential_slot.to_string()),
                ("credential_pool_size", clients.len().to_string()),
            ],
        );

        tauri::async_runtime::spawn(async move {
            let Ok(permit) = pool.acquire_permit(&cancel).await else {
                if !cancel.is_cancelled() {
                    failures.store(true, std::sync::atomic::Ordering::Release);
                }
                return;
            };

            let _ = event_channel.send(WordNativeTranscriptionEvent::StageChanged {
                job_id,
                stage: format!("transcribing_window_{}", window.index + 1),
                message: format!("Transcribing window {}/{}", window.index + 1, total_windows),
                window_index: Some(window.index),
                total_windows: Some(total_windows),
            });

            let _ = event_channel.send(WordNativeTranscriptionEvent::WindowProgress {
                job_id,
                window_index: window.index,
                total_windows,
                window_start_ms: window.start_ms,
                window_end_ms: window.end_ms,
                phase: "extracting".to_owned(),
                fraction: Some(0.1),
            });

            let window_index = window.index;
            let timed_channel = event_channel.clone();
            let timed_callback: crate::transcription::worker::TimedWindowCallback =
                Arc::new(move |snapshot| {
                    // Reuse the exact final grouping rules. Prefixes are replaceable presentation,
                    // while canonical SQLite promotion remains ordered and waits for valid STOP.
                    let cues = StagingBuffer::new()
                        .prepare_promotion(revision_id, snapshot)
                        .projected_cues;
                    let _ = timed_channel.send(WordNativeTranscriptionEvent::WindowCues {
                        job_id,
                        window_index,
                        projected_cues: cues,
                    });
                });
            match execute_transcription_window(
                &client,
                &pipeline,
                &input,
                &window,
                &config,
                &cancel,
                transcription_model == TranscriptionModel::Live,
                permit,
                timed_callback,
            )
            .await
            {
                Ok(staged_result) => {
                    buffer.insert(staged_result);
                    let _ = tx.send(window.index);
                }
                Err(_err) if cancel.is_cancelled() => {}
                Err(err) => {
                    crate::diagnostics::record(
                        "transcribe.window.failed",
                        &[
                            ("window", window.index.to_string()),
                            ("kind", err.diagnostic_kind().to_owned()),
                        ],
                    );
                    failures.store(true, std::sync::atomic::Ordering::Release);
                    let _ = event_channel.send(WordNativeTranscriptionEvent::Failed {
                        job_id,
                        error: TranscriptionErrorDto {
                            code: "window_failed".to_owned(),
                            message: err.to_string(),
                            window_index: Some(window.index),
                            retryable: false,
                        },
                    });
                    // Skip failed window so subsequent staged windows are promoted
                    buffer.skip_failed_window(window.index);
                    let _ = tx.send(window.index);
                }
            }
        });
    }

    drop(notify_tx);

    // Head-of-Line Sequenced Promoter Loop
    let mut total_words_promoted = 0_usize;
    let mut total_turns_promoted = 0_usize;
    let mut all_projected_cues = Vec::new();
    let mut promoted_count = 0_usize;

    loop {
        if cancellation.is_cancelled() {
            let _ = background::finish_cancellation(&jobs, job_id).await;
            let _ = on_event.send(WordNativeTranscriptionEvent::Cancelled { job_id });
            update_revision_state_best_effort(
                &database,
                revision_id,
                if total_words_promoted > 0 {
                    "partial"
                } else {
                    "failed"
                },
            )
            .await;
            return;
        }

        // Drain any promotable window results in sequential order
        let mut promoted_any = false;
        while let Some(promotable) = staging_buffer.pop_promotable() {
            promoted_any = true;
            let win_idx = promotable.window_index;
            let win_start = promotable.window.start_ms;
            let win_end = promotable.window.end_ms;

            let _ = on_event.send(WordNativeTranscriptionEvent::StageChanged {
                job_id,
                stage: format!("promoting_window_{}", win_idx + 1),
                message: format!("Promoting window {}/{}", win_idx + 1, total_windows),
                window_index: Some(win_idx),
                total_windows: Some(total_windows),
            });

            let promoted_data = staging_buffer.prepare_promotion(revision_id, promotable);
            let word_count = promoted_data.word_records.len();
            let turn_count = promoted_data.turn_records.len();

            // Atomic commit to SQLite via promote_window_results
            let db = database.clone();
            let turns = promoted_data.turn_records;
            let words = promoted_data.word_records;
            let commit_res = match tauri::async_runtime::spawn_blocking(move || {
                db.transcript_promote_window(revision_id, &turns, &words)
            })
            .await
            {
                Ok(inner) => inner.map_err(|e| e.to_string()),
                Err(join_err) => Err(format!("database promotion task panicked: {join_err}")),
            };

            if let Err(e) = commit_res {
                crate::diagnostics::record(
                    "transcribe.promotion.failed",
                    &[("window", win_idx.to_string())],
                );
                cancellation.cancel();
                let _ = on_event.send(WordNativeTranscriptionEvent::Failed {
                    job_id,
                    error: TranscriptionErrorDto {
                        code: "database_error".to_owned(),
                        message: format!("promotion commit failed: {e}"),
                        window_index: Some(win_idx),
                        retryable: false,
                    },
                });
                let _ = background::finish_failure(&jobs, job_id).await;
                update_revision_state_best_effort(
                    &database,
                    revision_id,
                    if total_words_promoted > 0 {
                        "partial"
                    } else {
                        "failed"
                    },
                )
                .await;
                return;
            }

            total_words_promoted += word_count;
            total_turns_promoted += turn_count;
            all_projected_cues.extend(promoted_data.projected_cues.clone());
            promoted_count += 1;

            // Stream WindowPromoted event with newly committed words and cues
            let _ = on_event.send(WordNativeTranscriptionEvent::WindowPromoted {
                job_id,
                revision_id,
                window_index: win_idx,
                total_windows,
                window_start_ms: win_start,
                window_end_ms: win_end,
                word_count,
                turn_count,
                words: promoted_data.word_dtos,
                turns: promoted_data.turn_dtos,
                projected_cues: promoted_data.projected_cues,
            });

            if promoted_count >= total_windows {
                break;
            }
        }

        if promoted_count >= total_windows {
            break;
        }

        // Wait for next completion notification or cancellation
        tokio::select! {
            () = cancellation.cancelled() => {
                let _ = background::finish_cancellation(&jobs, job_id).await;
                let _ = on_event.send(WordNativeTranscriptionEvent::Cancelled { job_id });
                update_revision_state_best_effort(
                    &database,
                    revision_id,
                    if total_words_promoted > 0 { "partial" } else { "failed" },
                )
                .await;
                return;
            }
            msg = notify_rx.recv() => {
                if msg.is_none() && !promoted_any {
                    break;
                }
            }
        }
    }

    let any_window_failed = has_failures.load(std::sync::atomic::Ordering::Acquire)
        || (promoted_count < total_windows)
        || (staging_buffer.failed_indices_count() > 0);

    if !any_window_failed && total_words_promoted > 0 {
        // Successful completion: all windows promoted, words > 0, zero window failures
        update_revision_state_best_effort(&database, revision_id, "completed").await;

        let _ = background::apply(&jobs, job_id, JobUpdate::Succeed).await;

        let duration_ms = i64::try_from(start_time.elapsed().as_millis()).unwrap_or(0);

        let _ = on_event.send(WordNativeTranscriptionEvent::StageChanged {
            job_id,
            stage: "completed".to_owned(),
            message: "Transcription successfully completed".to_owned(),
            window_index: Some(total_windows.saturating_sub(1)),
            total_windows: Some(total_windows),
        });

        let _ = on_event.send(WordNativeTranscriptionEvent::Completed {
            job_id,
            revision_id,
            total_windows,
            total_words: total_words_promoted,
            total_turns: total_turns_promoted,
            duration_ms,
            projected_cues: all_projected_cues,
        });
    } else if total_words_promoted > 0 {
        // Partial completion: some words promoted, but one or more windows failed
        update_revision_state_best_effort(&database, revision_id, "partial").await;

        let _ = background::finish_failure(&jobs, job_id).await;

        let _ = on_event.send(WordNativeTranscriptionEvent::Failed {
            job_id,
            error: TranscriptionErrorDto {
                code: "partial_transcription_failure".to_owned(),
                message: format!(
                    "Transcription partially succeeded with {total_words_promoted} words ({promoted_count}/{total_windows} windows promoted), but one or more windows failed"
                ),
                window_index: None,
                retryable: false,
            },
        });
    } else {
        // Total failure: zero words promoted or all windows failed
        update_revision_state_best_effort(&database, revision_id, "failed").await;

        let _ = background::finish_failure(&jobs, job_id).await;

        let _ = on_event.send(WordNativeTranscriptionEvent::Failed {
            job_id,
            error: TranscriptionErrorDto {
                code: if any_window_failed {
                    "window_failed".to_owned()
                } else {
                    "zero_words_transcribed".to_owned()
                },
                message: if any_window_failed {
                    "Transcription failed with no words promoted".to_owned()
                } else {
                    "Transcription completed with zero words recognized".to_owned()
                },
                window_index: None,
                retryable: false,
            },
        });
    }
}

pub(super) fn credential_slot(window_index: usize, credential_count: usize) -> usize {
    debug_assert!(credential_count > 0);
    window_index % credential_count
}

async fn update_revision_state_best_effort(
    database: &Database,
    revision_id: TranscriptRevisionId,
    state: &'static str,
) {
    let db = database.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        db.transcript_update_revision_state(revision_id, state)
    })
    .await;
}
