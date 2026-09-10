use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use osg_gemini::{
    AudioTranscriptionConfig, GeminiClient, InlineMedia, LiveTranscriptionKind,
    MediaInput as GeminiMediaInput, TranscribeRequest, TranscriptionStreamCompletion,
};
use osg_media::{
    AudioOutput, AudioSampleRate, CancellationToken as MediaCancellationToken, ChannelCount,
    MediaError, MediaInput as NativeMediaInput, MediaTimeRange, RunControl,
};
use osg_media_pipeline::{MediaPipeline, PipelineError};
use thiserror::Error;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use super::planner::WindowRange;
use super::projection::{
    ProjectedWordResult, ProjectionError, WordProjectionStatus, project_window_word,
};
use super::staging::StagedWindowResult;

#[derive(Debug, Error)]
pub(crate) enum WorkerError {
    #[error("transcription was cancelled")]
    Cancelled,
    #[error("audio extraction failed: {0}")]
    Pipeline(#[from] PipelineError),
    #[error("media range error: {0}")]
    Media(#[from] MediaError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("gemini provider error: {0}")]
    Gemini(#[from] osg_gemini::Error),
    #[error("word projection error: {0}")]
    Projection(#[from] ProjectionError),
    #[error("internal worker error: {0}")]
    Internal(String),
}

impl WorkerError {
    pub(crate) const fn diagnostic_kind(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Pipeline(_) => "pipeline",
            Self::Media(_) => "media",
            Self::Io(_) => "io",
            Self::Gemini(_) => "gemini",
            Self::Projection(_) => "projection",
            Self::Internal(_) => "internal",
        }
    }

    fn is_output_limit(&self) -> bool {
        matches!(
            self,
            Self::Gemini(osg_gemini::Error::IncompleteTextOutput {
                reason: "outputLimit"
            })
        )
    }
}

/// RAII guard that aborts an asynchronous task when dropped, guaranteeing clean termination on all error and early-exit paths.
struct AbortOnDrop<T>(Option<tauri::async_runtime::JoinHandle<T>>);

impl<T> AbortOnDrop<T> {
    fn new(handle: tauri::async_runtime::JoinHandle<T>) -> Self {
        Self(Some(handle))
    }

    fn abort(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Clone)]
pub(crate) struct WorkerPool {
    semaphore: Arc<Semaphore>,
}

impl Default for WorkerPool {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkerPool {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(2)),
        }
    }

    pub(crate) async fn acquire_permit(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit, WorkerError> {
        if cancellation.is_cancelled() {
            return Err(WorkerError::Cancelled);
        }

        tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(WorkerError::Cancelled),
            permit = self.semaphore.clone().acquire_owned() => {
                permit.map_err(|_| WorkerError::Internal("worker pool semaphore closed".to_owned()))
            }
        }
    }
}

pub(crate) type TimedWindowCallback = Arc<dyn Fn(StagedWindowResult) + Send + Sync>;

/// Extracts 16kHz mono WAV, streams provider-timed words, and projects their coordinates.
/// Temporary audio is removed after reading; transport retries stop once a stream is accepted.
// The explicit extraction permit ties admission to this worker's audio preparation lifetime.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_transcription_window(
    client: &GeminiClient,
    pipeline: &MediaPipeline,
    input: &NativeMediaInput,
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    live_mode: bool,
    extraction_permit: OwnedSemaphorePermit,
    on_timed_window: TimedWindowCallback,
) -> Result<StagedWindowResult, WorkerError> {
    if cancellation.is_cancelled() {
        return Err(WorkerError::Cancelled);
    }

    // 1. Audio Extraction: 16kHz Mono WAV
    let range = MediaTimeRange::new(window.start_us(), Some(window.duration_us()))
        .map_err(WorkerError::Media)?;
    let format = AudioOutput::WavPcm16 {
        sample_rate: AudioSampleRate::new(16_000).map_err(WorkerError::Media)?,
        channels: ChannelCount::new(1).map_err(WorkerError::Media)?,
    };

    let media_cancel = MediaCancellationToken::default();
    let cancel_bridge = media_cancel.clone();
    let worker_cancel = cancellation.clone();

    let mut cancel_bridge_task = AbortOnDrop::new(tauri::async_runtime::spawn(async move {
        worker_cancel.cancelled().await;
        cancel_bridge.cancel();
    }));

    let run_control = RunControl::new(Duration::from_mins(2))
        .map_err(WorkerError::Media)?
        .with_cancellation(media_cancel);

    let pipeline = pipeline.clone();
    let input = input.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        pipeline.extract_audio(input, format, range, &run_control)
    })
    .await
    .map_err(|error| WorkerError::Internal(error.to_string()))??;

    // 2. Read bytes into memory
    let wav_bytes = std::fs::read(prepared.path()).map_err(WorkerError::Io)?;

    // 3. Explicit RAII cleanup: drop PreparedMedia immediately so temporary WAV is unlinked from disk
    drop(prepared);
    // Network sessions do not consume a local extraction slot. Otherwise two source-paced Live
    // sessions hold the slots for minutes and prevent the other requested windows from starting.
    drop(extraction_permit);
    cancel_bridge_task.abort();

    if cancellation.is_cancelled() {
        return Err(WorkerError::Cancelled);
    }

    if live_mode {
        return execute_live_window(
            client,
            &wav_bytes,
            window,
            config,
            cancellation,
            Arc::clone(&on_timed_window),
        )
        .await;
    }

    execute_standard_window_resilient(
        client,
        wav_bytes,
        window,
        config,
        cancellation,
        on_timed_window,
        0,
    )
    .await
}

// One retry subdivision bounds recovery within the ordinary Transcribe model.
// Recursive binary fan-out can exhaust the key needed to finish the job,
// especially when music makes a model repeat output. Live never enters this path.
const MAX_OUTPUT_SPLIT_DEPTH: u8 = 1;
const MIN_OUTPUT_SPLIT_MS: i64 = 4_000;
const STANDARD_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(15);

fn execute_standard_window_resilient<'a>(
    client: &'a GeminiClient,
    wav_bytes: Vec<u8>,
    window: &'a WindowRange,
    config: &'a AudioTranscriptionConfig,
    cancellation: &'a CancellationToken,
    on_timed_window: TimedWindowCallback,
    depth: u8,
) -> BoxFuture<'a, Result<StagedWindowResult, WorkerError>> {
    Box::pin(async move {
        let latest_partial = Arc::new(std::sync::Mutex::new(None));
        let attempt_partial = Arc::clone(&latest_partial);
        let attempt_downstream = Arc::clone(&on_timed_window);
        let attempt_callback: TimedWindowCallback = Arc::new(move |result| {
            *attempt_partial
                .lock()
                .expect("transcription partial-result mutex poisoned") = Some(result.clone());
            attempt_downstream(result);
        });
        let attempt = tokio::time::timeout(
            STANDARD_ATTEMPT_TIMEOUT,
            execute_standard_window(
                client,
                wav_bytes.clone(),
                window,
                config,
                cancellation,
                attempt_callback,
            ),
        )
        .await;
        let split_reason = match attempt {
            Ok(Ok(result)) => return Ok(result),
            Ok(Err(error)) if error.is_output_limit() => "output_limit",
            Ok(Err(error)) => return Err(error),
            Err(_) => "attempt_timeout",
        };
        if depth < MAX_OUTPUT_SPLIT_DEPTH && window.duration_ms() >= MIN_OUTPUT_SPLIT_MS * 2 {
            let (left_wav, right_wav) = split_pcm_wav(&wav_bytes)?;
            let midpoint = window.start_ms + window.duration_ms() / 2;
            let left_window = WindowRange::new(window.index, window.start_ms, midpoint);
            let right_window = WindowRange::new(window.index, midpoint, window.end_ms);
            crate::diagnostics::record(
                "transcribe.window.output_limit_split",
                &[
                    ("window", window.index.to_string()),
                    ("depth", (depth + 1).to_string()),
                    ("reason", split_reason.to_owned()),
                    ("split_ms", midpoint.to_string()),
                ],
            );

            // A retry publishes only complete subdivision results. The original truncated
            // prefix may already be visible, but the final aggregate replaces it atomically.
            let no_op: TimedWindowCallback = Arc::new(|_| {});
            let left = execute_standard_window_resilient(
                client,
                left_wav,
                &left_window,
                config,
                cancellation,
                Arc::clone(&no_op),
                depth + 1,
            );
            let right = execute_standard_window_resilient(
                client,
                right_wav,
                &right_window,
                config,
                cancellation,
                no_op,
                depth + 1,
            );
            let (left, right) = tokio::join!(left, right);
            let left = left?;
            let right = right?;
            let mut words = left.words;
            words.extend(right.words);
            let result = StagedWindowResult {
                window_index: window.index,
                window: *window,
                words,
            };
            on_timed_window(result.clone());
            Ok(result)
        } else {
            // A bounded retry may still encounter repetitive music that never reaches a
            // provider stop condition. Preserve any timestamped words already accepted;
            // otherwise this subdivision truthfully contributes no speech. Failing the
            // parent would discard valid subtitles from every other completed window.
            let partial = latest_partial
                .lock()
                .expect("transcription partial-result mutex poisoned")
                .clone()
                .unwrap_or_else(|| StagedWindowResult {
                    window_index: window.index,
                    window: *window,
                    words: Vec::new(),
                });
            crate::diagnostics::record(
                "transcribe.window.bounded_recovery_finished",
                &[
                    ("window", window.index.to_string()),
                    ("depth", depth.to_string()),
                    ("reason", split_reason.to_owned()),
                    ("words", partial.words.len().to_string()),
                ],
            );
            Ok(partial)
        }
    })
}

fn split_pcm_wav(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>), WorkerError> {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WorkerError::Internal(
            "transcription retry received a malformed WAV".to_owned(),
        ));
    }
    let mut cursor = 12_usize;
    let mut data = None;
    let mut block_align = None;
    while cursor.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let size = u32::from_le_bytes(bytes[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
        let payload = cursor + 8;
        let end = payload
            .checked_add(size)
            .ok_or_else(|| WorkerError::Internal("WAV chunk size overflow".to_owned()))?;
        if end > bytes.len() {
            return Err(WorkerError::Internal(
                "WAV chunk exceeds payload".to_owned(),
            ));
        }
        if &bytes[cursor..cursor + 4] == b"fmt " && size >= 16 {
            block_align = Some(u16::from_le_bytes(
                bytes[payload + 12..payload + 14].try_into().unwrap(),
            ) as usize);
        }
        if &bytes[cursor..cursor + 4] == b"data" {
            data = Some((cursor, payload, end));
            break;
        }
        cursor = end + (size & 1);
    }
    let (data_header, data_start, data_end) =
        data.ok_or_else(|| WorkerError::Internal("WAV has no data chunk".to_owned()))?;
    let align = block_align
        .filter(|value| *value > 0)
        .ok_or_else(|| WorkerError::Internal("WAV has no valid PCM block alignment".to_owned()))?;
    let data_len = data_end - data_start;
    let midpoint = (data_len / 2 / align) * align;
    if midpoint == 0 || midpoint == data_len {
        return Err(WorkerError::Internal(
            "WAV is too short to subdivide".to_owned(),
        ));
    }
    let build = |samples: &[u8]| {
        let mut wav = bytes[..data_start].to_vec();
        wav.extend_from_slice(samples);
        let riff_size = u32::try_from(wav.len() - 8).unwrap();
        let sample_size = u32::try_from(samples.len()).unwrap();
        wav[4..8].copy_from_slice(&riff_size.to_le_bytes());
        wav[data_header + 4..data_header + 8].copy_from_slice(&sample_size.to_le_bytes());
        wav
    };
    Ok((
        build(&bytes[data_start..data_start + midpoint]),
        build(&bytes[data_start + midpoint..data_end]),
    ))
}

async fn execute_standard_window(
    client: &GeminiClient,
    wav_bytes: Vec<u8>,
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    on_timed_window: TimedWindowCallback,
) -> Result<StagedWindowResult, WorkerError> {
    // Regular Gemini Transcribe owns a distinct inline-media transport and word timestamps.
    let inline_media = InlineMedia::new("audio/wav", wav_bytes)?;
    let request =
        TranscribeRequest::new(GeminiMediaInput::Inline(inline_media)).with_config(config.clone());

    // The existing transport retries only before accepting a stream. Never replay a body after
    // publishing its words. The caller rolls back presentation on failure/cancellation.
    let mut stream = client.transcribe_stream(request, cancellation).await?;
    let mut completion = TranscriptionStreamCompletion::default();
    let mut projected_words = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        completion.observe(&chunk)?;
        let words = chunk.transcription_words();
        if words.is_empty() {
            continue;
        }
        for word in &words {
            projected_words.push(project_window_word(word, window)?);
        }
        on_timed_window(StagedWindowResult {
            window_index: window.index,
            window: *window,
            words: projected_words.clone(),
        });
    }
    completion.finish()?;

    Ok(StagedWindowResult {
        window_index: window.index,
        window: *window,
        words: projected_words,
    })
}

const LIVE_SPARSE_MIN_WINDOW_MS: i64 = 15_000;

fn live_attempt_is_sparse(result: &StagedWindowResult) -> bool {
    let owned_duration_ms = result.window.duration_ms();
    let minimum_words = usize::try_from((owned_duration_ms / 1_000).cast_unsigned())
        .unwrap_or(usize::MAX);
    owned_duration_ms >= LIVE_SPARSE_MIN_WINDOW_MS
        && result.words.len() < minimum_words
}

fn prefer_more_complete_live_attempt(
    first: StagedWindowResult,
    second: StagedWindowResult,
) -> StagedWindowResult {
    if second.words.len() > first.words.len() {
        second
    } else {
        first
    }
}

async fn execute_live_window(
    client: &GeminiClient,
    wav_bytes: &[u8],
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    on_timed_window: TimedWindowCallback,
) -> Result<StagedWindowResult, WorkerError> {
    let first = execute_live_window_once(
        client,
        wav_bytes,
        window,
        config,
        cancellation,
        Arc::clone(&on_timed_window),
        1,
    )
    .await?;
    if !live_attempt_is_sparse(&first) {
        return Ok(first);
    }

    crate::diagnostics::record(
        "transcribe.live.sparse_retry",
        &[
            ("window", window.index.to_string()),
            ("first_words", first.words.len().to_string()),
        ],
    );
    // The retry uses the same Live model and audio. Do not intermingle two stochastic attempts on
    // screen; publish the replacement atomically only when it is demonstrably more complete.
    let second = execute_live_window_once(
        client,
        wav_bytes,
        window,
        config,
        cancellation,
        Arc::new(|_| {}),
        2,
    )
    .await?;
    let selected = prefer_more_complete_live_attempt(first, second);
    on_timed_window(selected.clone());
    crate::diagnostics::record(
        "transcribe.live.sparse_retry_finished",
        &[
            ("window", window.index.to_string()),
            ("selected_words", selected.words.len().to_string()),
        ],
    );
    Ok(selected)
}

async fn execute_live_window_once(
    client: &GeminiClient,
    wav_bytes: &[u8],
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    on_timed_window: TimedWindowCallback,
    attempt: u8,
) -> Result<StagedWindowResult, WorkerError> {
    let started = std::time::Instant::now();
    let mut finalized = Vec::new();
    let mut first_final_seen = false;
    let window_index = window.index;
    let audio_start_ms = window.context_start_ms;
    let window_duration_ms = (window.end_ms - audio_start_ms).cast_unsigned();
    crate::diagnostics::record(
        "transcribe.live.started",
        &[
            ("window", window_index.to_string()),
            ("attempt", attempt.to_string()),
        ],
    );
    client
        .transcribe_live(wav_bytes, &config.language_hints, cancellation, |event| {
            if event.text.trim().is_empty() {
                return;
            }
            if event.kind != LiveTranscriptionKind::Final {
                return;
            }
            let start_ms = event.start_ms.min(window_duration_ms.saturating_sub(1));
            let end_ms = event.end_ms.min(window_duration_ms).max(start_ms + 1);
            let owned_words = project_live_utterance(&event.text, start_ms, end_ms, audio_start_ms)
                .into_iter()
                .filter(|word| live_word_is_owned(word, window));
            finalized.extend(owned_words);
            if !first_final_seen {
                first_final_seen = true;
                crate::diagnostics::record(
                    "transcribe.live.first_final",
                    &[
                        ("window", window_index.to_string()),
                        ("elapsed_ms", started.elapsed().as_millis().to_string()),
                    ],
                );
            }
            on_timed_window(StagedWindowResult {
                window_index,
                window: WindowRange::new(window_index, window.start_ms, window.end_ms),
                words: finalized.clone(),
            });
        })
        .await?;
    crate::diagnostics::record(
        "transcribe.live.finished",
        &[
            ("window", window_index.to_string()),
            ("attempt", attempt.to_string()),
            ("finalized", finalized.len().to_string()),
            ("elapsed_ms", started.elapsed().as_millis().to_string()),
            (
                "outcome",
                if finalized.is_empty() { "empty" } else { "ok" }.to_owned(),
            ),
        ],
    );
    Ok(StagedWindowResult {
        window_index,
        window: *window,
        words: finalized,
    })
}

fn live_word_is_owned(word: &ProjectedWordResult, window: &WindowRange) -> bool {
    let midpoint = word.project_start_ms + (word.project_end_ms - word.project_start_ms) / 2;
    midpoint >= window.start_ms && midpoint < window.end_ms
}

fn project_live_utterance(
    text: &str,
    start_ms: u64,
    end_ms: u64,
    window_start_ms: i64,
) -> Vec<ProjectedWordResult> {
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return Vec::new();
    }
    let weights = tokens
        .iter()
        .map(|token| token.chars().count().max(1) as u64)
        .collect::<Vec<_>>();
    let total_weight = weights.iter().sum::<u64>().max(1);
    let duration = end_ms.saturating_sub(start_ms).max(tokens.len() as u64);
    let mut elapsed_weight = 0_u64;
    tokens
        .into_iter()
        .zip(weights)
        .map(|(token, weight)| {
            let token_start = start_ms + duration.saturating_mul(elapsed_weight) / total_weight;
            elapsed_weight += weight;
            let token_end = (start_ms + duration.saturating_mul(elapsed_weight) / total_weight)
                .max(token_start + 1)
                .min(end_ms);
            ProjectedWordResult {
                status: WordProjectionStatus::Interpolated,
                text: token.to_owned(),
                raw_start_ns: token_start.saturating_mul(1_000_000),
                raw_end_ns: token_end.saturating_mul(1_000_000),
                project_start_ms: window_start_ms + token_start.cast_signed(),
                project_end_ms: window_start_ms + token_end.cast_signed(),
                speaker_id: None,
                is_unaligned: true,
                alignment_status: "unaligned".to_owned(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm_wav(samples: &[u8]) -> Vec<u8> {
        let mut wav = Vec::with_capacity(44 + samples.len());
        let sample_bytes = u32::try_from(samples.len()).expect("test WAV length fits u32");
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36_u32 + sample_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&32_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&sample_bytes.to_le_bytes());
        wav.extend_from_slice(samples);
        wav
    }

    #[test]
    fn live_overlap_context_never_owns_duplicate_boundary_words() {
        let word = |start, end| ProjectedWordResult {
            status: WordProjectionStatus::Interpolated,
            text: "boundary".to_owned(),
            raw_start_ns: 0,
            raw_end_ns: 1,
            project_start_ms: start,
            project_end_ms: end,
            speaker_id: None,
            is_unaligned: true,
            alignment_status: "unaligned".to_owned(),
        };
        let left = WindowRange::new(0, 0, 57_000);
        let mut right = WindowRange::new(1, 57_000, 114_000);
        right.context_start_ms = 54_000;
        assert!(live_word_is_owned(&word(56_900, 57_100), &right));
        assert!(!live_word_is_owned(&word(56_000, 56_900), &right));
        assert!(!live_word_is_owned(&word(57_000, 57_100), &left));
    }

    #[test]
    fn sparse_live_attempts_retry_and_keep_the_more_complete_result() {
        let window = WindowRange::new(3, 0, 60_000);
        let result = |count| StagedWindowResult {
            window_index: window.index,
            window,
            words: (0_usize..count)
                .map(|ordinal| ProjectedWordResult {
                    status: WordProjectionStatus::Interpolated,
                    text: format!("w{ordinal}"),
                    raw_start_ns: u64::try_from(ordinal).unwrap(),
                    raw_end_ns: u64::try_from(ordinal).unwrap() + 1,
                    project_start_ms: i64::try_from(ordinal).unwrap(),
                    project_end_ms: i64::try_from(ordinal).unwrap() + 1,
                    speaker_id: None,
                    is_unaligned: true,
                    alignment_status: "unaligned".to_owned(),
                })
                .collect(),
        };
        assert!(live_attempt_is_sparse(&result(59)));
        assert!(!live_attempt_is_sparse(&result(60)));
        assert_eq!(
            prefer_more_complete_live_attempt(result(11), result(47))
                .words
                .len(),
            47
        );
        assert_eq!(
            prefer_more_complete_live_attempt(result(47), result(11))
                .words
                .len(),
            47
        );
    }

    #[test]
    fn output_limit_retry_splits_pcm_wav_without_losing_samples() {
        let source = pcm_wav(&[0, 1, 2, 3, 4, 5, 6, 7]);
        let (left, right) = split_pcm_wav(&source).expect("split");
        assert_eq!(&left[44..], &[0, 1, 2, 3]);
        assert_eq!(&right[44..], &[4, 5, 6, 7]);
        assert_eq!(u32::from_le_bytes(left[4..8].try_into().unwrap()), 40);
        assert_eq!(u32::from_le_bytes(left[40..44].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(right[4..8].try_into().unwrap()), 40);
        assert_eq!(u32::from_le_bytes(right[40..44].try_into().unwrap()), 4);
    }

    #[tokio::test]
    async fn test_worker_pool_bounded_concurrency() {
        let pool = WorkerPool::new();
        let cancel = CancellationToken::new();

        // Should acquire permit 1 and 2
        let permit1 = pool.acquire_permit(&cancel).await.expect("permit 1");
        let permit2 = pool.acquire_permit(&cancel).await.expect("permit 2");

        // 3rd permit attempt must block
        let pool_clone = pool.clone();
        let cancel_clone = cancel.clone();
        let mut acquire_task =
            tokio::spawn(async move { pool_clone.acquire_permit(&cancel_clone).await });

        // Verify task is waiting (does not complete within 50ms)
        tokio::select! {
            _ = &mut acquire_task => panic!("3rd permit should not be acquired while 2 permits held"),
            () = tokio::time::sleep(Duration::from_millis(50)) => {}
        }

        // Drop permit 1
        drop(permit1);

        // Now acquire_task should immediately succeed
        let permit3 = acquire_task.await.expect("task join").expect("permit 3");
        drop(permit2);
        drop(permit3);
    }

    #[test]
    fn live_utterance_is_split_into_monotonic_words_for_subtitle_grouping() {
        let words = project_live_utterance("one longer three", 1_000, 4_000, 60_000);
        assert_eq!(
            words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            ["one", "longer", "three"]
        );
        assert_eq!(words.first().unwrap().project_start_ms, 61_000);
        assert_eq!(words.last().unwrap().project_end_ms, 64_000);
        assert!(
            words
                .windows(2)
                .all(|pair| pair[0].project_end_ms <= pair[1].project_start_ms)
        );
        assert!(
            words
                .iter()
                .all(|word| word.status == WordProjectionStatus::Interpolated
                    && word.alignment_status == "unaligned"
                    && word.is_unaligned)
        );
    }

    #[tokio::test]
    async fn test_worker_pool_cancellation_while_waiting() {
        let pool = WorkerPool::new();
        let cancel = CancellationToken::new();

        let _permit1 = pool.acquire_permit(&cancel).await.expect("permit 1");
        let _permit2 = pool.acquire_permit(&cancel).await.expect("permit 2");

        let wait_cancel = CancellationToken::new();
        let pool_clone = pool.clone();
        let cancel_for_task = wait_cancel.clone();

        let acquire_task =
            tokio::spawn(async move { pool_clone.acquire_permit(&cancel_for_task).await });

        // Cancel while waiting
        tokio::time::sleep(Duration::from_millis(20)).await;
        wait_cancel.cancel();

        let res = acquire_task.await.expect("task join");
        assert!(matches!(res, Err(WorkerError::Cancelled)));
    }

    #[tokio::test]
    async fn test_worker_pool_pre_cancelled_deterministic() {
        let pool = WorkerPool::new();
        let cancel = CancellationToken::new();
        cancel.cancel();

        // 100 iterations: every single acquire_permit call on a pre-cancelled token
        // MUST deterministically return Err(WorkerError::Cancelled)
        for _ in 0..100 {
            let res = pool.acquire_permit(&cancel).await;
            assert!(
                matches!(res, Err(WorkerError::Cancelled)),
                "acquire_permit must return Err(Cancelled) when token is pre-cancelled"
            );
        }
    }

    #[tokio::test]
    async fn test_abort_on_drop_aborts_spawned_task() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_mins(1)).await;
            let _ = tx.send(());
        });

        {
            let _guard = AbortOnDrop::new(task);
            // Guard goes out of scope here and aborts the task on drop
        }

        tokio::time::sleep(Duration::from_millis(20)).await;
        // Oneshot channel sender was dropped when task was aborted
        assert!(rx.await.is_err(), "task should have been aborted on drop");
    }

    #[tokio::test]
    async fn test_adversarial_permit_acquisition_pre_cancelled_exhaustive() {
        let pool = WorkerPool::new();

        // 1. With 2 permits available (empty pool)
        let cancel_2 = CancellationToken::new();
        cancel_2.cancel();
        for _ in 0..1_000 {
            let res = pool.acquire_permit(&cancel_2).await;
            assert!(matches!(res, Err(WorkerError::Cancelled)));
            assert_eq!(pool.semaphore.available_permits(), 2);
        }

        // 2. With 1 permit available (1 held)
        let permit1 = pool.semaphore.clone().acquire_owned().await.unwrap();
        assert_eq!(pool.semaphore.available_permits(), 1);

        let cancel_1 = CancellationToken::new();
        cancel_1.cancel();
        for _ in 0..1_000 {
            let res = pool.acquire_permit(&cancel_1).await;
            assert!(matches!(res, Err(WorkerError::Cancelled)));
            assert_eq!(pool.semaphore.available_permits(), 1);
        }

        // 3. With 0 permits available (both held, saturated pool)
        let permit2 = pool.semaphore.clone().acquire_owned().await.unwrap();
        assert_eq!(pool.semaphore.available_permits(), 0);

        let cancel_0 = CancellationToken::new();
        cancel_0.cancel();
        for _ in 0..1_000 {
            let res = pool.acquire_permit(&cancel_0).await;
            assert!(matches!(res, Err(WorkerError::Cancelled)));
            assert_eq!(pool.semaphore.available_permits(), 0);
        }

        // Release both permits: verify count returns to exactly 2
        drop(permit1);
        drop(permit2);
        assert_eq!(pool.semaphore.available_permits(), 2);
    }

    #[tokio::test]
    async fn test_adversarial_multithreaded_pre_cancelled_race() {
        let pool = Arc::new(WorkerPool::new());
        let mut handles = Vec::new();

        // 16 concurrent tasks doing 500 acquires each on pre-cancelled tokens = 8,000 requests
        for _ in 0..16 {
            let p = Arc::clone(&pool);
            handles.push(tokio::spawn(async move {
                let cancel = CancellationToken::new();
                cancel.cancel();
                for _ in 0..500 {
                    let res = p.acquire_permit(&cancel).await;
                    assert!(matches!(res, Err(WorkerError::Cancelled)));
                }
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        // Exact permit invariant assertion: exactly 2 permits remain available, 0 leaked
        assert_eq!(pool.semaphore.available_permits(), 2);

        // Verify normal acquisition still works perfectly
        let c = CancellationToken::new();
        let p1 = pool.acquire_permit(&c).await.expect("p1");
        let p2 = pool.acquire_permit(&c).await.expect("p2");
        assert_eq!(pool.semaphore.available_permits(), 0);
        drop(p1);
        drop(p2);
        assert_eq!(pool.semaphore.available_permits(), 2);
    }

    #[tokio::test]
    async fn test_adversarial_permit_acquisition_concurrent_cancellation_race() {
        let pool = Arc::new(WorkerPool::new());
        let cancel = CancellationToken::new();
        let mut handles = Vec::new();

        // Spawn 50 tasks attempting to acquire permits
        for _ in 0..50 {
            let p = Arc::clone(&pool);
            let c = cancel.clone();
            handles.push(tokio::spawn(async move {
                match p.acquire_permit(&c).await {
                    Ok(permit) => {
                        // Hold permit briefly then release
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        drop(permit);
                        Ok(())
                    }
                    Err(WorkerError::Cancelled) => Err(()),
                    Err(e) => panic!("Unexpected error: {e:?}"),
                }
            }));
        }

        // Concurrently trigger cancellation after a tiny delay
        tokio::time::sleep(Duration::from_millis(3)).await;
        cancel.cancel();

        for h in handles {
            let _ = h.await.unwrap();
        }

        // After all tasks settle, exactly 2 permits must be available (0 leaked)
        assert_eq!(pool.semaphore.available_permits(), 2);
    }
}
