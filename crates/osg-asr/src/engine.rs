use crate::process::{SessionPoll, WorkerSession};
use crate::protocol::{
    PROTOCOL_VERSION, ReaderMessage, WireBackend, WireEvent, WirePhase, WireRequest, WireWord,
};
use crate::segment::{Word, segment_words, to_srt};
use crate::{
    AsrEngineId, AsrError, LanguageCode, ModelAssets, NormalizedAudio, Result,
    TranscriptionOptions, WorkerProgram,
};
use serde::Serialize;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_TIMEOUT: Duration = Duration::from_hours(24);
const MAX_EVENTS_PER_JOB: usize = 8;
const MAX_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORDS: usize = 250_000;
const MAX_WORD_BYTES: usize = 4 * 1024;
const MAX_WORD_BYTES_TOTAL: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub trait ProgressSink: Send + Sync {
    fn on_progress(&self, progress: &AsrProgress);
}

impl<F> ProgressSink for F
where
    F: Fn(&AsrProgress) + Send + Sync,
{
    fn on_progress(&self, progress: &AsrProgress) {
        self(progress);
    }
}

#[derive(Clone)]
pub struct RunControl {
    timeout: Duration,
    cancellation: CancellationToken,
    progress: Option<Arc<dyn ProgressSink>>,
}

impl RunControl {
    pub fn new(timeout: Duration) -> Result<Self> {
        if timeout.is_zero() || timeout > MAX_TIMEOUT {
            return Err(AsrError::InvalidOption(
                "timeout must be greater than zero and no longer than 24 hours",
            ));
        }
        Ok(Self {
            timeout,
            cancellation: CancellationToken::default(),
            progress: None,
        })
    }

    #[must_use]
    pub fn with_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    #[must_use]
    pub fn with_progress(mut self, progress: impl ProgressSink + 'static) -> Self {
        self.progress = Some(Arc::new(progress));
        self
    }

    #[must_use]
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl fmt::Debug for RunControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunControl")
            .field("timeout", &self.timeout)
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("has_progress", &self.progress.is_some())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressPhase {
    ModelLoading,
    Transcribing,
    Finalizing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrProgress {
    /// An observed worker phase. No percentage is included because the model
    /// runtimes do not expose a trustworthy denominator.
    pub phase: ProgressPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionBackend {
    Cuda,
    DirectMl,
    CoreMl,
    Metal,
    Cpu,
}

#[derive(Clone, Debug)]
pub struct TranscriptionRequest {
    audio: NormalizedAudio,
    options: TranscriptionOptions,
}

impl TranscriptionRequest {
    #[must_use]
    pub fn new(audio: NormalizedAudio, options: TranscriptionOptions) -> Self {
        Self { audio, options }
    }

    #[must_use]
    pub fn audio(&self) -> &NormalizedAudio {
        &self.audio
    }

    #[must_use]
    pub fn options(&self) -> &TranscriptionOptions {
        &self.options
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub engine: AsrEngineId,
    pub text: String,
    pub segments: Vec<crate::Segment>,
    pub duration_ms: u64,
    pub language: Option<LanguageCode>,
    pub backend: ExecutionBackend,
}

impl Transcription {
    #[must_use]
    pub fn to_srt(&self) -> String {
        to_srt(&self.segments)
    }
}

#[derive(Clone)]
pub struct AsrService(Arc<ServiceInner>);

struct ServiceInner {
    program: WorkerProgram,
    assets: ModelAssets,
    state: Mutex<WorkerState>,
}

#[derive(Debug, Default)]
struct WorkerState {
    session: Option<WorkerSession>,
    next_request_id: u64,
}

impl AsrService {
    #[must_use]
    pub fn new(program: WorkerProgram, assets: ModelAssets) -> Self {
        Self(Arc::new(ServiceInner {
            program,
            assets,
            state: Mutex::new(WorkerState::default()),
        }))
    }

    #[must_use]
    pub fn engine(&self) -> AsrEngineId {
        self.0.assets.engine()
    }

    #[must_use]
    pub fn is_warm(&self) -> bool {
        self.0
            .state
            .try_lock()
            .is_ok_and(|state| state.session.is_some())
    }

    pub fn shutdown(&self) -> Result<()> {
        let mut state = self.0.state.lock().map_err(|_| AsrError::Synchronization)?;
        invalidate_session(&mut state);
        Ok(())
    }

    pub fn transcribe(
        &self,
        request: &TranscriptionRequest,
        control: &RunControl,
    ) -> Result<Transcription> {
        let started = Instant::now();
        request.options.validate_for(self.engine())?;
        request.audio.revalidate()?;
        self.0.assets.revalidate()?;
        if control.cancellation.is_cancelled() {
            return Err(AsrError::Cancelled);
        }
        let mut state = self.lock_cancellable(control, started)?;
        request.audio.revalidate()?;
        if state.session.is_none() {
            state.session = Some(WorkerSession::spawn(&self.0.program)?);
        }
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let request_id = state.next_request_id;
        let wire_request = WireRequest::new(
            request_id,
            &self.0.assets,
            &request.audio,
            request.options.language(),
        )?;
        if let Err(error) = state.session.as_mut().unwrap().send(&wire_request) {
            invalidate_session(&mut state);
            return Err(error);
        }

        let outcome = self.await_response(&mut state, request, control, started, request_id);
        if outcome.is_err() {
            invalidate_session(&mut state);
        }
        outcome
    }

    fn lock_cancellable<'a>(
        &'a self,
        control: &RunControl,
        started: Instant,
    ) -> Result<MutexGuard<'a, WorkerState>> {
        loop {
            match self.0.state.try_lock() {
                Ok(state) => return Ok(state),
                Err(TryLockError::Poisoned(_)) => return Err(AsrError::Synchronization),
                Err(TryLockError::WouldBlock) => {}
            }
            if control.cancellation.is_cancelled() {
                return Err(AsrError::Cancelled);
            }
            if started.elapsed() >= control.timeout {
                return Err(AsrError::TimedOut(control.timeout));
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn await_response(
        &self,
        state: &mut WorkerState,
        request: &TranscriptionRequest,
        control: &RunControl,
        started: Instant,
        request_id: u64,
    ) -> Result<Transcription> {
        let mut expected_sequence = 0_u16;
        let mut phase_rank = None;
        let mut event_count = 0;
        loop {
            let session = state.session.as_mut().ok_or(AsrError::Synchronization)?;
            if session.try_wait()?.is_some() {
                return Err(AsrError::WorkerFailed("worker process exited"));
            }

            match session.receive(POLL_INTERVAL) {
                SessionPoll::Message(ReaderMessage::Failed(error)) => return Err(error),
                SessionPoll::Disconnected => {
                    return Err(AsrError::Protocol("worker response stream closed"));
                }
                SessionPoll::Empty => {}
                SessionPoll::Message(ReaderMessage::Event(event)) => {
                    event_count += 1;
                    if event_count > MAX_EVENTS_PER_JOB
                        || event.version() != PROTOCOL_VERSION
                        || event.request_id() != request_id
                        || event.sequence() != expected_sequence
                    {
                        return Err(AsrError::Protocol("event identity or sequence"));
                    }
                    expected_sequence = expected_sequence
                        .checked_add(1)
                        .ok_or(AsrError::Protocol("event sequence overflow"))?;
                    match event {
                        WireEvent::Phase { phase, .. } => {
                            let rank = phase_rank_value(phase);
                            if phase_rank.is_some_and(|previous| rank <= previous) {
                                return Err(AsrError::Protocol("phase order"));
                            }
                            phase_rank = Some(rank);
                            if let Some(sink) = &control.progress {
                                sink.on_progress(&AsrProgress {
                                    phase: map_phase(phase),
                                });
                            }
                        }
                        WireEvent::Complete {
                            transcript,
                            language,
                            backend,
                            words,
                            join_without_spaces,
                            ..
                        } => {
                            if phase_rank != Some(2) {
                                return Err(AsrError::Protocol("completion before finalization"));
                            }
                            return build_transcription(
                                self.engine(),
                                request,
                                &transcript,
                                language.as_deref(),
                                backend,
                                words,
                                join_without_spaces,
                            );
                        }
                        WireEvent::Error { code, .. } => {
                            return Err(AsrError::WorkerFailed(code.safe_message()));
                        }
                    }
                    continue;
                }
            }

            // A terminal response already dequeued above wins a race with a
            // cancellation set immediately after inference completed.
            if control.cancellation.is_cancelled() {
                return Err(AsrError::Cancelled);
            }
            if started.elapsed() >= control.timeout {
                return Err(AsrError::TimedOut(control.timeout));
            }
        }
    }
}

impl fmt::Debug for AsrService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsrService")
            .field("program", &self.0.program)
            .field("assets", &self.0.assets)
            .field("warm", &self.is_warm())
            .finish()
    }
}

fn invalidate_session(state: &mut WorkerState) {
    if let Some(mut session) = state.session.take() {
        session.terminate();
    }
}

fn map_phase(phase: WirePhase) -> ProgressPhase {
    match phase {
        WirePhase::ModelLoading => ProgressPhase::ModelLoading,
        WirePhase::Transcribing => ProgressPhase::Transcribing,
        WirePhase::Finalizing => ProgressPhase::Finalizing,
    }
}

const fn phase_rank_value(phase: WirePhase) -> u8 {
    match phase {
        WirePhase::ModelLoading => 0,
        WirePhase::Transcribing => 1,
        WirePhase::Finalizing => 2,
    }
}

fn map_backend(backend: WireBackend) -> ExecutionBackend {
    match backend {
        WireBackend::Cuda => ExecutionBackend::Cuda,
        WireBackend::DirectMl => ExecutionBackend::DirectMl,
        WireBackend::CoreMl => ExecutionBackend::CoreMl,
        WireBackend::Metal => ExecutionBackend::Metal,
        WireBackend::Cpu => ExecutionBackend::Cpu,
    }
}

fn build_transcription(
    engine: AsrEngineId,
    request: &TranscriptionRequest,
    transcript: &str,
    language: Option<&str>,
    backend: WireBackend,
    wire_words: Vec<WireWord>,
    join_without_spaces: bool,
) -> Result<Transcription> {
    if transcript.len() > MAX_TRANSCRIPT_BYTES
        || transcript
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AsrError::InvalidOutput);
    }
    let language = language
        .map(LanguageCode::new)
        .transpose()
        .map_err(|_| AsrError::InvalidOutput)?;
    let words = validate_words(wire_words, request.audio.duration_ms())?;
    let mut segments = segment_words(&words, request.options.segmentation(), join_without_spaces);
    let text = transcript.trim().to_owned();
    if segments.is_empty() && !text.is_empty() {
        segments.push(crate::Segment {
            start_ms: 0,
            end_ms: request.audio.duration_ms(),
            text: normalize_word(&text)?,
        });
    }
    Ok(Transcription {
        engine,
        text,
        segments,
        duration_ms: request.audio.duration_ms(),
        language,
        backend: map_backend(backend),
    })
}

fn validate_words(wire_words: Vec<WireWord>, duration_ms: u64) -> Result<Vec<Word>> {
    if wire_words.len() > MAX_WORDS {
        return Err(AsrError::InvalidOutput);
    }
    let mut words = Vec::with_capacity(wire_words.len());
    let mut previous_start = 0;
    let mut text_bytes = 0_usize;
    for word in wire_words {
        let text = normalize_word(&word.text)?;
        text_bytes = text_bytes
            .checked_add(text.len())
            .ok_or(AsrError::InvalidOutput)?;
        if text.is_empty()
            || text.len() > MAX_WORD_BYTES
            || text_bytes > MAX_WORD_BYTES_TOTAL
            || !word.start_seconds.is_finite()
            || !word.end_seconds.is_finite()
            || word.start_seconds < 0.0
            || word.end_seconds < word.start_seconds
        {
            return Err(AsrError::InvalidOutput);
        }
        let start_ms = seconds_to_milliseconds(word.start_seconds)?;
        let end_ms = seconds_to_milliseconds(word.end_seconds)?.min(duration_ms);
        if start_ms > duration_ms || start_ms < previous_start || end_ms < start_ms {
            return Err(AsrError::InvalidOutput);
        }
        previous_start = start_ms;
        words.push(Word {
            text,
            start_ms,
            end_ms,
        });
    }
    Ok(words)
}

fn normalize_word(value: &str) -> Result<String> {
    if value.contains('\0') {
        return Err(AsrError::InvalidOutput);
    }
    Ok(value.split_whitespace().collect::<Vec<_>>().join(" "))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn seconds_to_milliseconds(seconds: f64) -> Result<u64> {
    let milliseconds = seconds * 1_000.0;
    if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
        return Err(AsrError::InvalidOutput);
    }
    Ok(milliseconds.round() as u64)
}
