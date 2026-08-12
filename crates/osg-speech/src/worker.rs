use crate::artifact::StagedArtifact;
use crate::program::native_process_path;
use crate::protocol::{
    CommandFrame, PROTOCOL_VERSION, WirePhase, WorkerCommand, WorkerResponse, write_frame,
};
use crate::session::{POLL_INTERVAL, WorkerSession, spawn_group, wait_for_response};
use crate::{
    AudioFormat, ReferencePreparationPlan, Result, RunControl, SecretValue, SegmentId,
    SpeechArtifact, SpeechBackend, SpeechError, SpeechOutput, SpeechPhase, SpeechProgress,
    SynthesisRequest, VoiceConversionRequest, VoiceInventory, WorkerProgram,
};
use serde::Serialize;
use std::fmt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::Instant;

const MAX_WORKER_TEXT_BYTES: u32 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Stopped,
    Ready,
    Unavailable,
}

/// A backend-specific lazy worker. Operations are serialized because model
/// runtimes are generally not re-entrant; separate instances provide bounded
/// parallelism without sharing unsafe Python/model state.
pub struct LazySpeechWorker {
    program: WorkerProgram,
    backend: SpeechBackend,
    provider_secret: Option<SecretValue>,
    next_request_id: AtomicU64,
    session: Mutex<Option<WorkerSession>>,
}

impl LazySpeechWorker {
    #[must_use]
    pub fn new(program: WorkerProgram, backend: SpeechBackend) -> Self {
        Self {
            program,
            backend,
            provider_secret: None,
            next_request_id: AtomicU64::new(1),
            session: Mutex::new(None),
        }
    }

    /// Installs a native-only credential passed through one fixed environment
    /// variable. The value is never serialized or placed in process arguments.
    #[must_use]
    pub fn with_provider_secret(mut self, secret: SecretValue) -> Self {
        self.provider_secret = Some(secret);
        self
    }

    #[must_use]
    pub fn backend(&self) -> SpeechBackend {
        self.backend
    }

    #[must_use]
    pub fn status(&self) -> WorkerStatus {
        let Ok(mut state) = self.session.try_lock() else {
            return WorkerStatus::Unavailable;
        };
        let Some(session) = state.as_mut() else {
            return WorkerStatus::Stopped;
        };
        match session.try_wait() {
            Ok(None) => WorkerStatus::Ready,
            Ok(Some(_)) => {
                session.mark_reaped();
                *state = None;
                WorkerStatus::Stopped
            }
            Err(_) => WorkerStatus::Unavailable,
        }
    }

    pub fn synthesize(
        &self,
        request: &SynthesisRequest,
        output: &SpeechOutput,
        control: &RunControl,
    ) -> Result<SpeechArtifact> {
        if request.backend() != self.backend {
            return Err(SpeechError::BackendMismatch);
        }
        if output.format() != request.output_format() {
            return Err(SpeechError::InvalidDestination(
                "output format does not match speech backend",
            ));
        }
        if self.backend == SpeechBackend::GeminiLive && self.provider_secret.is_none() {
            return Err(SpeechError::InvalidOption(
                "Gemini speech requires a native provider credential",
            ));
        }
        if output.final_path().exists() {
            return Err(SpeechError::OutputExists);
        }
        if let Some(reference) = request.reference() {
            reference.revalidate()?;
        }
        let staged = StagedArtifact::create(output.directory(), output.format())?;
        let settings = serde_json::to_value(request.settings())
            .map_err(|_| SpeechError::Protocol("failed to encode speech settings"))?;
        let command = WorkerCommand::Synthesize {
            backend: self.backend,
            segment_id: request.segment_id().as_str().to_owned(),
            text: request.text().as_str().to_owned(),
            settings,
            reference_path: request
                .reference()
                .map(|asset| native_process_path(asset.path()))
                .transpose()?,
            output_path: native_process_path(staged.path())?,
            output_format: output.format(),
        };
        let reply = self.transact(
            command,
            ExpectedReply::Artifact,
            Some(request.segment_id()),
            Some(request.text().bytes_len()),
            control,
        )?;
        let Reply::Artifact(artifact) = reply else {
            return Err(SpeechError::Protocol("unexpected worker response"));
        };
        emit(control, request.segment_id(), SpeechPhase::Publishing, 0)?;
        let result = staged.verify_and_publish(output.final_path(), output.format(), artifact);
        if matches!(
            result,
            Err(SpeechError::MissingArtifact | SpeechError::InvalidArtifact(_))
        ) {
            self.invalidate();
        }
        let result = result?;
        emit(
            control,
            request.segment_id(),
            SpeechPhase::Publishing,
            1_000_000,
        )?;
        Ok(result)
    }

    pub fn convert_voice(
        &self,
        request: &VoiceConversionRequest,
        output: &SpeechOutput,
        control: &RunControl,
    ) -> Result<SpeechArtifact> {
        if self.backend != SpeechBackend::Chatterbox {
            return Err(SpeechError::BackendMismatch);
        }
        if output.format() != AudioFormat::Wav {
            return Err(SpeechError::InvalidDestination(
                "voice conversion output must be WAV",
            ));
        }
        if output.final_path().exists() {
            return Err(SpeechError::OutputExists);
        }
        request.input().revalidate()?;
        request.target_voice().revalidate()?;
        let staged = StagedArtifact::create(output.directory(), AudioFormat::Wav)?;
        let command = WorkerCommand::ConvertVoice {
            backend: self.backend,
            input_path: native_process_path(request.input().path())?,
            target_voice_path: native_process_path(request.target_voice().path())?,
            output_path: native_process_path(staged.path())?,
            output_format: AudioFormat::Wav,
        };
        let reply = self.transact(command, ExpectedReply::Artifact, None, None, control)?;
        let Reply::Artifact(artifact) = reply else {
            return Err(SpeechError::Protocol("unexpected worker response"));
        };
        let result = staged.verify_and_publish(output.final_path(), AudioFormat::Wav, artifact);
        if matches!(
            result,
            Err(SpeechError::MissingArtifact | SpeechError::InvalidArtifact(_))
        ) {
            self.invalidate();
        }
        result
    }

    /// Normalizes a host-selected F5 reference into the exact worker contract.
    /// The filter plan is constructed by Rust; `WebView` callers cannot supply
    /// paths, filter names, or arbitrary media arguments.
    pub fn prepare_reference(
        &self,
        plan: &ReferencePreparationPlan,
        output: &SpeechOutput,
        control: &RunControl,
    ) -> Result<SpeechArtifact> {
        if self.backend != SpeechBackend::F5Tts {
            return Err(SpeechError::BackendMismatch);
        }
        if output.format() != AudioFormat::Wav {
            return Err(SpeechError::InvalidDestination(
                "prepared references must use WAV",
            ));
        }
        if output.final_path().exists() {
            return Err(SpeechError::OutputExists);
        }
        plan.source().revalidate()?;
        let staged = StagedArtifact::create(output.directory(), AudioFormat::Wav)?;
        let filters = serde_json::to_value(plan.filters())
            .map_err(|_| SpeechError::Protocol("failed to encode reference plan"))?;
        let command = WorkerCommand::PrepareReference {
            backend: self.backend,
            input_path: native_process_path(plan.source().path())?,
            filters,
            output_path: native_process_path(staged.path())?,
            output_format: AudioFormat::Wav,
        };
        let reply = self.transact(command, ExpectedReply::Artifact, None, None, control)?;
        let Reply::Artifact(artifact) = reply else {
            return Err(SpeechError::Protocol("unexpected worker response"));
        };
        let result = staged.verify_and_publish(output.final_path(), AudioFormat::Wav, artifact);
        if matches!(
            result,
            Err(SpeechError::MissingArtifact | SpeechError::InvalidArtifact(_))
        ) {
            self.invalidate();
        }
        result
    }

    pub fn list_voices(&self, control: &RunControl) -> Result<VoiceInventory> {
        let command = WorkerCommand::ListVoices {
            backend: self.backend,
        };
        let reply = self.transact(command, ExpectedReply::Voices, None, None, control)?;
        let Reply::Voices(voices) = reply else {
            return Err(SpeechError::Protocol("unexpected worker response"));
        };
        match VoiceInventory::from_wire(voices) {
            Ok(inventory) => Ok(inventory),
            Err(error) => {
                self.invalidate();
                Err(error)
            }
        }
    }

    pub fn shutdown(&self) {
        let Ok(mut state) = self.session.lock() else {
            return;
        };
        if let Some(mut session) = state.take() {
            let frame = CommandFrame {
                protocol: PROTOCOL_VERSION,
                request_id: self.next_id(),
                command: WorkerCommand::Shutdown,
            };
            let _ = write_frame(&mut session.stdin, &frame);
            session.terminate();
        }
    }

    fn transact(
        &self,
        command: WorkerCommand,
        expected: ExpectedReply,
        segment_id: Option<&SegmentId>,
        text_bytes: Option<usize>,
        control: &RunControl,
    ) -> Result<Reply> {
        let started = Instant::now();
        let deadline = started
            .checked_add(control.timeout())
            .ok_or(SpeechError::InvalidOption("timeout overflow"))?;
        let mut state = lock_with_control(&self.session, control, deadline)?;
        if state.is_none() {
            emit_optional(control, segment_id, SpeechPhase::StartingWorker, 0)?;
            let session = self.start_session(control, deadline)?;
            *state = Some(session);
            emit_optional(control, segment_id, SpeechPhase::StartingWorker, 1_000_000)?;
        }
        let session = state.as_mut().ok_or(SpeechError::StateUnavailable)?;
        if text_bytes.is_some_and(|bytes| bytes > session.max_text_bytes) {
            return Err(SpeechError::InvalidInput(
                "speech text exceeds worker capability",
            ));
        }
        let request_id = self.next_id();
        let frame = CommandFrame {
            protocol: PROTOCOL_VERSION,
            request_id,
            command,
        };
        let outcome = write_frame(&mut session.stdin, &frame).and_then(|()| {
            wait_for_reply(session, request_id, expected, segment_id, control, deadline)
        });
        if outcome.as_ref().is_err_and(is_session_fatal)
            && let Some(mut session) = state.take()
        {
            session.terminate();
        }
        outcome
    }

    fn start_session(&self, control: &RunControl, deadline: Instant) -> Result<WorkerSession> {
        if control.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        self.program.revalidate()?;
        let cache_directory = tempfile::Builder::new()
            .prefix("osg-speech-worker-")
            .tempdir()
            .map_err(SpeechError::Spawn)?;
        let mut command = Command::new(native_process_path(self.program.executable())?);
        if let Some(bootstrap) = self.program.bootstrap_path() {
            // Isolated mode ignores PYTHON* injection and user site packages; `-B` also keeps the
            // read-only application resource directory free of generated bytecode.
            command
                .args(["-I", "-B", "-u", "-X", "utf8"])
                .arg(native_process_path(bootstrap)?);
        }
        command
            .arg("--stdio-worker")
            .arg("--protocol-version")
            .arg(PROTOCOL_VERSION.to_string())
            .arg("--backend")
            .arg(self.backend.protocol_name())
            .env("PYTHONUTF8", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env(
                "NUMBA_CACHE_DIR",
                native_process_path(cache_directory.path())?,
            )
            .env("NO_COLOR", "1")
            .env_remove("OSG_SPEECH_PROVIDER_SECRET")
            .env_remove("OSG_SPEECH_MODEL_ROOT")
            .env_remove("GEMINI_API_KEY")
            .env_remove("GOOGLE_API_KEY")
            .env_remove("HF_HUB_OFFLINE")
            .env_remove("HF_DATASETS_OFFLINE")
            .env_remove("TRANSFORMERS_OFFLINE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(secret) = &self.provider_secret {
            command.env("OSG_SPEECH_PROVIDER_SECRET", secret.expose());
        }
        if let Some(model_root) = self.program.model_root() {
            command
                .env("OSG_SPEECH_MODEL_ROOT", native_process_path(model_root)?)
                .env("HF_HUB_OFFLINE", "1")
                .env("HF_DATASETS_OFFLINE", "1")
                .env("TRANSFORMERS_OFFLINE", "1");
        }
        let child = spawn_group(&mut command)?;
        let mut session = WorkerSession::new(child, cache_directory)?;
        let hello = wait_for_response(&mut session, control, deadline);
        let handshake = match hello {
            Ok(WorkerResponse::Hello {
                protocol,
                backend,
                worker_version,
                max_text_bytes,
            }) => {
                if protocol != PROTOCOL_VERSION || backend != self.backend {
                    Err(SpeechError::Protocol("worker handshake does not match"))
                } else if worker_version.is_empty()
                    || worker_version.len() > 64
                    || !worker_version.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
                {
                    Err(SpeechError::Protocol("invalid worker version"))
                } else if max_text_bytes == 0 || max_text_bytes > MAX_WORKER_TEXT_BYTES {
                    Err(SpeechError::Protocol("invalid worker text limit"))
                } else {
                    session.max_text_bytes = usize::try_from(max_text_bytes)
                        .map_err(|_| SpeechError::Protocol("invalid worker text limit"))?;
                    Ok(())
                }
            }
            Ok(_) => Err(SpeechError::Protocol("worker hello frame was expected")),
            Err(error) => Err(error),
        };
        if let Err(error) = handshake {
            session.terminate();
            return Err(error);
        }
        Ok(session)
    }

    fn next_id(&self) -> u64 {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        } else {
            id
        }
    }

    fn invalidate(&self) {
        if let Ok(mut state) = self.session.lock()
            && let Some(mut session) = state.take()
        {
            session.terminate();
        }
    }
}

impl fmt::Debug for LazySpeechWorker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LazySpeechWorker")
            .field("program", &self.program)
            .field("backend", &self.backend)
            .field(
                "provider_secret",
                &self.provider_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("status", &self.status())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
enum ExpectedReply {
    Artifact,
    Voices,
}

enum Reply {
    Artifact(crate::protocol::WireArtifact),
    Voices(Vec<crate::protocol::WireVoice>),
}

fn wait_for_reply(
    session: &mut WorkerSession,
    request_id: u64,
    expected: ExpectedReply,
    segment_id: Option<&SegmentId>,
    control: &RunControl,
    deadline: Instant,
) -> Result<Reply> {
    loop {
        match wait_for_response(session, control, deadline)? {
            WorkerResponse::Progress {
                protocol,
                request_id: response_id,
                phase,
                fraction_millionths,
            } => {
                validate_envelope(protocol, request_id, response_id)?;
                let phase = match phase {
                    WirePhase::LoadingModel => SpeechPhase::LoadingModel,
                    WirePhase::Synthesizing => SpeechPhase::Synthesizing,
                    WirePhase::Encoding => SpeechPhase::Encoding,
                };
                emit_optional(control, segment_id, phase, fraction_millionths)?;
            }
            WorkerResponse::Complete {
                protocol,
                request_id: response_id,
                artifact,
            } => {
                validate_envelope(protocol, request_id, response_id)?;
                return match expected {
                    ExpectedReply::Artifact => Ok(Reply::Artifact(artifact)),
                    ExpectedReply::Voices => {
                        Err(SpeechError::Protocol("unexpected artifact response"))
                    }
                };
            }
            WorkerResponse::Voices {
                protocol,
                request_id: response_id,
                voices,
            } => {
                validate_envelope(protocol, request_id, response_id)?;
                return match expected {
                    ExpectedReply::Voices => Ok(Reply::Voices(voices)),
                    ExpectedReply::Artifact => {
                        Err(SpeechError::Protocol("unexpected voice response"))
                    }
                };
            }
            WorkerResponse::Error {
                protocol,
                request_id: response_id,
                code,
                retryable,
            } => {
                validate_envelope(protocol, request_id, response_id)?;
                return Err(SpeechError::WorkerRejected {
                    code: safe_worker_code(&code),
                    retryable,
                });
            }
            WorkerResponse::Hello { .. } => {
                return Err(SpeechError::Protocol("duplicate worker hello frame"));
            }
        }
    }
}

fn validate_envelope(protocol: u16, expected_id: u64, response_id: u64) -> Result<()> {
    if protocol != PROTOCOL_VERSION || expected_id != response_id {
        return Err(SpeechError::Protocol(
            "worker response envelope does not match",
        ));
    }
    Ok(())
}

fn safe_worker_code(value: &str) -> &'static str {
    match value {
        "invalid_request" => "invalid_request",
        "model_unavailable" => "model_unavailable",
        "provider_unavailable" => "provider_unavailable",
        "provider_rate_limited" => "provider_rate_limited",
        "authentication_failed" => "authentication_failed",
        "reference_rejected" => "reference_rejected",
        "synthesis_failed" => "synthesis_failed",
        "encoding_failed" => "encoding_failed",
        _ => "worker_error",
    }
}

fn emit(
    control: &RunControl,
    segment_id: &SegmentId,
    phase: SpeechPhase,
    fraction: u32,
) -> Result<()> {
    emit_optional(control, Some(segment_id), phase, fraction)
}

fn emit_optional(
    control: &RunControl,
    segment_id: Option<&SegmentId>,
    phase: SpeechPhase,
    fraction: u32,
) -> Result<()> {
    let progress = SpeechProgress::new(segment_id.cloned(), phase, fraction)?;
    control.emit(&progress);
    Ok(())
}

fn lock_with_control<'a>(
    mutex: &'a Mutex<Option<WorkerSession>>,
    control: &RunControl,
    deadline: Instant,
) -> Result<MutexGuard<'a, Option<WorkerSession>>> {
    loop {
        if control.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(SpeechError::TimedOut {
                timeout: control.timeout(),
            });
        }
        match mutex.try_lock() {
            Ok(guard) => {
                if control.is_cancelled() {
                    return Err(SpeechError::Cancelled);
                }
                if Instant::now() >= deadline {
                    return Err(SpeechError::TimedOut {
                        timeout: control.timeout(),
                    });
                }
                return Ok(guard);
            }
            Err(TryLockError::Poisoned(_)) => return Err(SpeechError::StateUnavailable),
            Err(TryLockError::WouldBlock) => {
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

fn is_session_fatal(error: &SpeechError) -> bool {
    !matches!(
        error,
        SpeechError::WorkerRejected { .. } | SpeechError::InvalidInput(_)
    )
}
