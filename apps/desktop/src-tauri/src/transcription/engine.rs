use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use osg_domain::{
    AssetId, JobId, JobKind, JobSnapshot, JobUpdate, ProjectId, TranscriptRevisionId,
};
use osg_gemini::{ApiKey, AudioTranscriptionConfig, GeminiClient};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose, CredentialState};
use osg_infrastructure::storage::{Database, TranscriptRevisionRecord};
use osg_media::{MediaInput as NativeMediaInput, RunControl};
use osg_media_pipeline::MediaPipeline;
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::media_blob::MediaBlobStore;
use crate::state::{DesktopState, LocalMedia};

use super::events::{TranscriptionErrorDto, WordNativeTranscriptionEvent};
use super::planner::plan_windows;
use super::staging::StagingBuffer;
use super::worker::{WorkerPool, execute_transcription_window};

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WordNativeTranscriptionConfig {
    pub(crate) model: Option<TranscriptionModel>,
    pub(crate) credential_id: Option<CredentialId>,
    pub(crate) language_hints: Option<Vec<String>>,
    pub(crate) diarization: Option<bool>,
    pub(crate) window_duration_secs: Option<u32>,
    pub(crate) window_duration_ms: Option<u64>,
    pub(crate) range_start_ms: Option<i64>,
    pub(crate) range_end_ms: Option<i64>,
    #[allow(dead_code)]
    pub(crate) prompt_preset: Option<String>,
    #[allow(dead_code)]
    pub(crate) grouping_policy: Option<Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Default, PartialEq, Eq)]
pub(crate) enum TranscriptionModel {
    #[default]
    #[serde(rename = "gemini-3.5-transcribe")]
    Transcribe,
    #[serde(rename = "gemini-3.5-transcribe-live")]
    Live,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartWordNativeTranscriptionRequest {
    pub(crate) project_id: ProjectId,
    pub(crate) expected_project_state_version: Option<u64>,
    pub(crate) media_asset_id: Option<AssetId>,
    pub(crate) file_path: Option<PathBuf>,
    pub(crate) config: Option<WordNativeTranscriptionConfig>,
    pub(crate) credential_id: Option<CredentialId>,
    pub(crate) language_hints: Option<Vec<String>>,
    pub(crate) diarization: Option<bool>,
    pub(crate) window_duration_secs: Option<u32>,
    pub(crate) window_duration_ms: Option<u64>,
    pub(crate) range_start_ms: Option<i64>,
    pub(crate) range_end_ms: Option<i64>,
    #[allow(dead_code)]
    pub(crate) prompt_preset: Option<String>,
    #[allow(dead_code)]
    pub(crate) grouping_policy: Option<Value>,
}

impl StartWordNativeTranscriptionRequest {
    #[must_use]
    pub(crate) fn model(&self) -> TranscriptionModel {
        self.config
            .as_ref()
            .and_then(|config| config.model)
            .unwrap_or_default()
    }
    #[must_use]
    pub(crate) fn credential_id(&self) -> Option<CredentialId> {
        self.credential_id
            .or_else(|| self.config.as_ref().and_then(|c| c.credential_id))
    }

    #[must_use]
    pub(crate) fn language_hints(&self) -> Vec<String> {
        self.language_hints
            .clone()
            .or_else(|| self.config.as_ref().and_then(|c| c.language_hints.clone()))
            .unwrap_or_default()
    }

    #[must_use]
    pub(crate) fn diarization(&self) -> bool {
        self.diarization
            .or_else(|| self.config.as_ref().and_then(|c| c.diarization))
            .unwrap_or(false)
    }

    #[must_use]
    pub(crate) fn window_duration_ms(&self) -> Option<u64> {
        self.window_duration_ms
            .or_else(|| self.window_duration_secs.map(|s| u64::from(s) * 1_000))
            .or_else(|| {
                self.config.as_ref().and_then(|c| {
                    c.window_duration_ms
                        .or_else(|| c.window_duration_secs.map(|s| u64::from(s) * 1_000))
                })
            })
    }

    #[must_use]
    pub(crate) fn range_start_ms(&self) -> Option<i64> {
        self.range_start_ms
            .or_else(|| self.config.as_ref().and_then(|c| c.range_start_ms))
    }

    #[must_use]
    pub(crate) fn range_end_ms(&self) -> Option<i64> {
        self.range_end_ms
            .or_else(|| self.config.as_ref().and_then(|c| c.range_end_ms))
    }
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn start_transcription_engine(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    request: StartWordNativeTranscriptionRequest,
    on_event: Channel<WordNativeTranscriptionEvent>,
) -> CommandResult<JobSnapshot> {
    // 1. Resolve media: either from media_asset_id or file_path
    let local_media = resolve_transcription_media(state, media_blobs, &request).await?;

    let media_engine = state
        .media_engine()
        .ok_or_else(CommandError::media_tools_unavailable)?;
    let pipeline = MediaPipeline::new(media_engine);

    // 2. Resolve native media input capability
    let native_input = NativeMediaInput::from_native_selection(local_media.path())
        .map_err(|e| CommandError::invalid_input(e.to_string()))?;

    // 3. Inspect media duration
    let inspect_control = RunControl::new(Duration::from_secs(30))
        .map_err(|e| CommandError::internal(e.to_string()))?;
    let inspection = pipeline
        .inspect(&native_input, &inspect_control)
        .map_err(|e| CommandError::internal(format!("media inspection failed: {e}")))?;

    if inspection.metadata.primary_audio().is_none() {
        return Err(CommandError::invalid_input(
            "the selected media has no audio track",
        ));
    }

    let duration_us = inspection.metadata.duration_us().unwrap_or(0);
    let media_duration_ms = (duration_us / 1_000).cast_signed();
    let range_start_ms = request.range_start_ms().unwrap_or(0).max(0);
    let range_end_ms = request
        .range_end_ms()
        .unwrap_or(media_duration_ms)
        .min(media_duration_ms);

    if range_end_ms <= range_start_ms {
        return Err(CommandError::invalid_input(format!(
            "invalid transcription range: start ({range_start_ms}ms) must be less than end ({range_end_ms}ms)"
        )));
    }

    // 4. Plan windows
    let windows = plan_windows(range_start_ms, range_end_ms, request.window_duration_ms())
        .map_err(|e| CommandError::invalid_input(e.to_string()))?;
    let total_windows = windows.len();

    // 5. Resolve Gemini API credential
    let credentials = state.credentials.clone();
    let request_credential_id = request.credential_id();
    let secret = tauri::async_runtime::spawn_blocking(move || {
        let cred_id = if let Some(id) = request_credential_id {
            id
        } else {
            let report = credentials
                .status(Some(CredentialPurpose::GeminiApiKey))
                .map_err(|e| CommandError::internal(e.to_string()))?;
            report
                .credentials
                .into_iter()
                .find(|c| c.state == CredentialState::Ready)
                .map(|c| c.id)
                .ok_or_else(|| {
                    CommandError::invalid_input(
                        "No ready Gemini API key found. Please configure an API key in Settings.",
                    )
                })?
        };
        credentials
            .resolve(cred_id, CredentialPurpose::GeminiApiKey)
            .map_err(|e| CommandError::internal(e.to_string()))
    })
    .await
    .map_err(|_| CommandError::internal("credential resolution task failed"))??;

    let api_key = ApiKey::new(secret.expose_secret().to_owned())
        .map_err(|e| CommandError::invalid_input(e.to_string()))?;
    let client = Arc::new(
        GeminiClient::new(api_key).map_err(|e| CommandError::invalid_input(e.to_string()))?,
    );

    // 6. Register running background job
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::Transcribe).await?;
    let initial_snapshot = ticket.snapshot().clone();
    let job_id = initial_snapshot.id();
    let cancellation = ticket.cancellation().clone();

    // 7. Insert initial TranscriptRevision into SQLite
    let revision_id = TranscriptRevisionId::new();
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(0);

    let planned_windows_json = serde_json::to_string(&serde_json::json!({
        "model": match request.model() { TranscriptionModel::Transcribe => "gemini-3.5-transcribe", TranscriptionModel::Live => "gemini-3.5-transcribe-live" },
        "plannedWindows": windows.iter().map(|w| serde_json::json!({
            "index": w.index,
            "startMs": w.start_ms,
            "endMs": w.end_ms,
        })).collect::<Vec<_>>(),
        "totalWindows": total_windows,
        "windowDurationMs": request.window_duration_ms(),
    }))
    .unwrap_or_else(|_| "{}".to_owned());

    let initial_revision = TranscriptRevisionRecord {
        id: revision_id,
        project_id: request.project_id,
        media_id: request.media_asset_id,
        provider: "gemini".to_owned(),
        model: match request.model() {
            TranscriptionModel::Transcribe => "gemini-3.5-transcribe",
            TranscriptionModel::Live => "gemini-3.5-transcribe-live",
        }
        .to_owned(),
        source_range_start_ms: range_start_ms,
        source_range_end_ms: range_end_ms,
        state: "in_progress".to_owned(),
        fingerprint: format!("{}_{}_{}", request.project_id, range_start_ms, range_end_ms),
        word_count: 0,
        metadata_json: planned_windows_json,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };

    let database = state.database.clone();
    let db_insert = database.clone();
    let rev_record = initial_revision.clone();
    tauri::async_runtime::spawn_blocking(move || db_insert.transcript_insert_revision(&rev_record))
        .await
        .map_err(|_| CommandError::internal("database task stopped unexpectedly"))?
        .map_err(|e| {
            CommandError::internal(format!("failed to insert transcript revision: {e}"))
        })?;

    // 8. Prepare transcription config
    let mut asr_config = AudioTranscriptionConfig::new();
    if request.diarization() {
        asr_config = asr_config.with_diarization(true);
    }
    let language_hints = request.language_hints();
    if !language_hints.is_empty() {
        asr_config = asr_config.with_language_hints(language_hints);
    }

    // 9. Spawn the native transcription orchestrator task
    let pipeline = Arc::new(pipeline);
    let native_input = Arc::new(native_input);
    let asr_config = Arc::new(asr_config);
    let transcription_model = request.model();

    tauri::async_runtime::spawn(async move {
        run_engine_loop(
            jobs,
            database,
            job_id,
            revision_id,
            total_windows,
            windows,
            client,
            pipeline,
            native_input,
            asr_config,
            transcription_model,
            cancellation,
            on_event,
        )
        .await;
    });

    Ok(initial_snapshot)
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn run_engine_loop(
    jobs: background::DesktopJobs,
    database: Database,
    job_id: JobId,
    revision_id: TranscriptRevisionId,
    total_windows: usize,
    windows: Vec<super::planner::WindowRange>,
    client: Arc<GeminiClient>,
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
    let worker_pool = Arc::new(WorkerPool::new());
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
    let has_failures = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Each requested window owns a concurrent provider session. Only local extraction is bounded.
    for window in windows {
        let pool = Arc::clone(&worker_pool);
        let buffer = Arc::clone(&staging_buffer);
        let client = Arc::clone(&client);
        let pipeline = Arc::clone(&pipeline);
        let input = Arc::clone(&native_input);
        let config = Arc::clone(&asr_config);
        let cancel = cancellation.clone();
        let event_channel = on_event.clone();
        let tx = notify_tx.clone();
        let failures = Arc::clone(&has_failures);

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
            let timed_callback: super::worker::TimedWindowCallback = Arc::new(move |snapshot| {
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

async fn resolve_transcription_media(
    state: &State<'_, DesktopState>,
    media_blobs: &State<'_, MediaBlobStore>,
    request: &StartWordNativeTranscriptionRequest,
) -> CommandResult<LocalMedia> {
    if let Some(asset_id) = request.media_asset_id {
        if let Some(media) = media_blobs.resolve(asset_id)? {
            return Ok(media);
        }
        let database = state.database.clone();
        let expected_version = request.expected_project_state_version;
        let project_id = request.project_id;
        let media = tauri::async_runtime::spawn_blocking(move || {
            let resolved = match expected_version {
                Some(ver) => database.resolve_project_media_revision(project_id, ver, asset_id)?,
                None => database.resolve_media(asset_id)?,
            }
            .ok_or_else(CommandError::media_unavailable)?;
            Ok::<_, CommandError>(LocalMedia::new(
                resolved.asset().id(),
                resolved.path().to_owned(),
                resolved.asset().kind(),
                resolved.asset().extension(),
            ))
        })
        .await
        .map_err(|_| CommandError::internal("media resolution task failed"))??;
        return Ok(media);
    }

    if let Some(file_path) = &request.file_path {
        let extension = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4");
        let media = LocalMedia::new(
            AssetId::new(),
            file_path.clone(),
            osg_domain::media_kind_for_extension(extension).unwrap_or(osg_domain::MediaKind::Audio),
            extension,
        );
        return Ok(media);
    }

    Err(CommandError::invalid_input(
        "transcription requires either mediaAssetId or filePath",
    ))
}
