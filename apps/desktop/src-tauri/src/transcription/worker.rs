mod live;

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use osg_formats::wav;
use osg_gemini::{
    AudioTranscriptionConfig, GeminiClient, InlineMedia, MediaInput as GeminiMediaInput,
    TranscribeRequest, TranscriptionStreamCompletion,
};
use osg_media::{
    AudioOutput, AudioSampleRate, CancellationToken as MediaCancellationToken, ChannelCount,
    MediaError, MediaInput as NativeMediaInput, MediaTimeRange, RunControl,
};
use osg_media_pipeline::{MediaPipeline, PipelineError};
use thiserror::Error;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use self::live::execute_live_window;
use super::planner::WindowRange;
use super::projection::{ProjectionError, project_window_word};
use super::staging::StagedWindowResult;
use crate::error::CommandError;

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
    Internal(&'static str),
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

    /// Maps a window failure to the app's fixed, path-safe command vocabulary.
    pub(crate) fn into_command_error(self) -> CommandError {
        match self {
            Self::Cancelled => CommandError::internal("The transcription was cancelled."),
            Self::Pipeline(error) => error.into(),
            Self::Media(error) => error.into(),
            Self::Gemini(error) => error.into(),
            Self::Io(_) => {
                CommandError::internal("The extracted transcription audio could not be read.")
            }
            Self::Projection(_) => {
                CommandError::internal("Gemini returned word timings that could not be placed.")
            }
            Self::Internal(_) => {
                CommandError::internal("The transcription worker failed unexpectedly.")
            }
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

/// A cancellation-aware admission bound: local extraction slots and provider sessions.
#[derive(Clone)]
pub(crate) struct WorkerPool {
    semaphore: Arc<Semaphore>,
}

impl WorkerPool {
    #[must_use]
    pub(crate) fn new(max_concurrent: usize) -> Self {
        debug_assert!(max_concurrent > 0);
        Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
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
                permit.map_err(|_| WorkerError::Internal("worker pool semaphore closed"))
            }
        }
    }
}

pub(crate) type TimedWindowCallback = Arc<dyn Fn(StagedWindowResult) + Send + Sync>;

/// Extracts 16kHz mono WAV, streams provider-timed words, and projects their coordinates.
/// Temporary audio is removed after reading; transport retries stop once a stream is accepted.
/// The extraction permit bounds local ffmpeg work only and is released before the provider call.
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

    // 2. Read the WAV off the async runtime; dropping `prepared` unlinks the temporary file.
    let pipeline = pipeline.clone();
    let input = input.clone();
    let wav_bytes = tauri::async_runtime::spawn_blocking(move || {
        let prepared = pipeline.extract_audio(input, format, range, &run_control)?;
        Ok::<_, WorkerError>(std::fs::read(prepared.path())?)
    })
    .await
    .map_err(|_| WorkerError::Internal("audio extraction task stopped unexpectedly"))??;

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

/// Halves a PCM WAV on a block boundary, keeping the original header chunks in both halves.
fn split_pcm_wav(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>), WorkerError> {
    const MALFORMED: WorkerError =
        WorkerError::Internal("transcription retry received a malformed WAV");
    let file_len = u64::try_from(bytes.len()).map_err(|_| MALFORMED)?;
    let layout = wav::parse_header(bytes, file_len).map_err(|_| MALFORMED)?;
    let samples = layout.samples(bytes).ok_or(MALFORMED)?;
    let align = usize::from(layout.format.block_align);
    if align == 0 {
        return Err(WorkerError::Internal(
            "WAV has no valid PCM block alignment",
        ));
    }
    let midpoint = (samples.len() / 2 / align) * align;
    if midpoint == 0 || midpoint == samples.len() {
        return Err(WorkerError::Internal("WAV is too short to subdivide"));
    }
    let (left, right) = samples.split_at(midpoint);
    let rewrap = |half: &[u8]| layout.with_samples(bytes, half).ok_or(MALFORMED);
    Ok((rewrap(left)?, rewrap(right)?))
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

#[cfg(test)]
mod tests;
