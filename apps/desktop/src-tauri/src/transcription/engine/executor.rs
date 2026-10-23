//! Executes one planned window: bounded local extraction, then a Gemini session on its credential.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use osg_gemini::{AudioTranscriptionConfig, GeminiClient};
use osg_media::MediaInput as NativeMediaInput;
use osg_media_pipeline::MediaPipeline;
use tokio_util::sync::CancellationToken;

use crate::transcription::planner::WindowRange;
use crate::transcription::staging::StagedWindowResult;
use crate::transcription::worker::{
    TimedWindowCallback, WorkerError, WorkerPool, execute_transcription_window,
};

pub(crate) type WindowFuture = BoxFuture<'static, Result<StagedWindowResult, WorkerError>>;

pub(crate) trait WindowExecutor: Send + Sync + 'static {
    /// Prepares the window's work. Called in window order; the returned future does nothing
    /// until the run loop has admitted the window to a provider session.
    fn prepare(
        &self,
        window: WindowRange,
        cancellation: CancellationToken,
        on_timed_window: TimedWindowCallback,
    ) -> WindowFuture;
}

pub(super) struct GeminiWindowExecutor {
    pub(super) clients: Vec<Arc<GeminiClient>>,
    pub(super) pipeline: Arc<MediaPipeline>,
    pub(super) input: Arc<NativeMediaInput>,
    pub(super) config: Arc<AudioTranscriptionConfig>,
    pub(super) live: bool,
    pub(super) extraction: WorkerPool,
}

impl WindowExecutor for GeminiWindowExecutor {
    fn prepare(
        &self,
        window: WindowRange,
        cancellation: CancellationToken,
        on_timed_window: TimedWindowCallback,
    ) -> WindowFuture {
        let slot = credential_slot(window.index, self.clients.len());
        crate::diagnostics::record(
            "transcribe.window.credential_assigned",
            &[
                ("window", window.index.to_string()),
                ("credential_slot", slot.to_string()),
                ("credential_pool_size", self.clients.len().to_string()),
            ],
        );
        let client = Arc::clone(&self.clients[slot]);
        let pipeline = Arc::clone(&self.pipeline);
        let input = Arc::clone(&self.input);
        let config = Arc::clone(&self.config);
        let extraction = self.extraction.clone();
        let live = self.live;
        Box::pin(async move {
            let permit = extraction.acquire_permit(&cancellation).await?;
            execute_transcription_window(
                &client,
                &pipeline,
                &input,
                &window,
                &config,
                &cancellation,
                live,
                permit,
                on_timed_window,
            )
            .await
        })
    }
}

pub(super) fn credential_slot(window_index: usize, credential_count: usize) -> usize {
    debug_assert!(credential_count > 0);
    window_index % credential_count
}
