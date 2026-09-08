use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use osg_gemini::{
    AudioTranscriptionConfig, GeminiClient, InlineMedia, MediaInput as GeminiMediaInput,
    TranscribeRequest,
};
use osg_media::{
    AudioOutput, AudioSampleRate, CancellationToken as MediaCancellationToken, ChannelCount,
    MediaError, MediaInput as NativeMediaInput, MediaTimeRange, RunControl,
};
use osg_media_pipeline::{MediaPipeline, PipelineError};
use thiserror::Error;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use super::planner::WindowRange;
use super::projection::{project_window_word, ProjectionError};
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

/// Executes audio extraction, Gemini transcription, and coordinate projection for a single window.
pub(crate) type LiveDraftCallback = Arc<dyn Fn(Result<String, ()>) + Send + Sync>;

const LIVE_DRAFT_HEAD_START: Duration = Duration::from_secs(3);

#[derive(Default)]
struct FirstLiveDraft {
    observed: AtomicBool,
    notify: Notify,
}

impl FirstLiveDraft {
    fn signal(&self) {
        if !self.observed.swap(true, Ordering::AcqRel) {
            self.notify.notify_one();
        }
    }

    async fn wait(&self) {
        if !self.observed.load(Ordering::Acquire) {
            self.notify.notified().await;
        }
    }
}
///
/// Ensures:
/// - 16kHz mono WAV extraction.
/// - RAII cleanup of temporary extracted audio as soon as bytes are read.
/// - Up to 3 retries with exponential backoff on retryable provider errors.
/// - Bounded disk space usage (< 3.8 MiB across both workers).
pub(crate) async fn execute_transcription_window(
    client: &GeminiClient,
    pipeline: &MediaPipeline,
    input: &NativeMediaInput,
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    live_draft: Option<LiveDraftCallback>,
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

    let prepared = pipeline
        .extract_audio(input.clone(), format, range, &run_control)
        .map_err(WorkerError::Pipeline)?;

    // 2. Read bytes into memory
    let wav_bytes = std::fs::read(prepared.path()).map_err(WorkerError::Io)?;

    // 3. Explicit RAII cleanup: drop PreparedMedia immediately so temporary WAV is unlinked from disk
    drop(prepared);
    cancel_bridge_task.abort();

    if cancellation.is_cancelled() {
        return Err(WorkerError::Cancelled);
    }

    // 4. Formulate inline Gemini TranscribeRequest
    // Optional early drafts have no timestamps. The existing file response remains authoritative.
    // The guard cancels the socket on errors and early returns. The success path explicitly joins
    // it below so the customer sees the complete source-paced stream before timed promotion.
    let first_live_draft = Arc::new(FirstLiveDraft::default());
    let live_requested = live_draft.is_some();
    let mut live_task = live_draft.map(|callback| {
        let client = client.clone();
        let bytes = wav_bytes.clone();
        let language_hints = config.language_hints.clone();
        let cancel = cancellation.clone();
        let first_live_draft = Arc::clone(&first_live_draft);
        AbortOnDrop::new(tauri::async_runtime::spawn(async move {
            let signal = Arc::clone(&first_live_draft);
            let result = client.transcribe_live_draft(&bytes, &language_hints, &cancel, |text| {
                callback(Ok(text));
                signal.signal();
            }).await;
            if result.is_err() && !cancel.is_cancelled() {
                callback(Err(()));
                first_live_draft.signal();
            }
        }))
    });
    if live_requested {
        tokio::select! {
            () = cancellation.cancelled() => return Err(WorkerError::Cancelled),
            () = first_live_draft.wait() => {},
            () = tokio::time::sleep(LIVE_DRAFT_HEAD_START) => {}
        }
    }
    let inline_media = InlineMedia::new("audio/wav", wav_bytes)?;
    let request = TranscribeRequest::new(GeminiMediaInput::Inline(inline_media))
        .with_config(config.clone());

    // 5. Targeted retries with exponential backoff (1s, 2s, 4s) on retryable errors
    let mut attempts = 0_usize;
    let response = loop {
        attempts += 1;
        match client.transcribe(request.clone(), cancellation).await {
            Ok(resp) => break resp,
            Err(_err) if cancellation.is_cancelled() => {
                return Err(WorkerError::Cancelled);
            }
            Err(err) if attempts < 3 && err.is_retryable() => {
                let backoff_ms = 1_000 * (1 << (attempts - 1));
                tokio::select! {
                    () = cancellation.cancelled() => return Err(WorkerError::Cancelled),
                    () = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
            }
            Err(err) => return Err(WorkerError::Gemini(err)),
        }
    };

    // A Live request is a source-paced customer-visible stream, not merely a race against the
    // faster file endpoint. Keep it alive through the complete window before publishing the
    // authoritative timed result. Dropping this guard here used to abort Live after its first
    // phrase and made the batch result appear all at once for longer media.
    if let Some(mut task) = live_task.as_mut().and_then(|task| task.0.take()) {
        tokio::select! {
            () = cancellation.cancelled() => {
                task.abort();
                return Err(WorkerError::Cancelled);
            }
            _ = &mut task => {}
        }
    }

    // 6. Word Projection & Clamp
    let raw_words = response.transcription_words();
    let mut projected_words = Vec::with_capacity(raw_words.len());
    for raw_word in &raw_words {
        let projected = project_window_word(raw_word, window)?;
        projected_words.push(projected);
    }

    Ok(StagedWindowResult {
        window_index: window.index,
        window: *window,
        words: projected_words,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut acquire_task = tokio::spawn(async move {
            pool_clone.acquire_permit(&cancel_clone).await
        });

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

    #[tokio::test]
    async fn test_worker_pool_cancellation_while_waiting() {
        let pool = WorkerPool::new();
        let cancel = CancellationToken::new();

        let _permit1 = pool.acquire_permit(&cancel).await.expect("permit 1");
        let _permit2 = pool.acquire_permit(&cancel).await.expect("permit 2");

        let wait_cancel = CancellationToken::new();
        let pool_clone = pool.clone();
        let cancel_for_task = wait_cancel.clone();

        let acquire_task = tokio::spawn(async move {
            pool_clone.acquire_permit(&cancel_for_task).await
        });

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
