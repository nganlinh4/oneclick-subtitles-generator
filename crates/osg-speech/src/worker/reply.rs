//! Request/reply correlation with the speech worker: envelope checks, progress, and typed replies.

use std::time::Instant;

use crate::protocol::{PROTOCOL_VERSION, WirePhase, WorkerResponse};
use crate::session::{WorkerSession, wait_for_response};
use crate::{Result, RunControl, SegmentId, SpeechError, SpeechPhase, SpeechProgress};

#[derive(Clone, Copy)]
pub(super) enum ExpectedReply {
    Artifact,
    Voices,
}

pub(super) enum Reply {
    Artifact(crate::protocol::WireArtifact),
    Voices(Vec<crate::protocol::WireVoice>),
}

pub(super) fn wait_for_reply(
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

pub(super) fn validate_envelope(protocol: u16, expected_id: u64, response_id: u64) -> Result<()> {
    if protocol != PROTOCOL_VERSION || expected_id != response_id {
        return Err(SpeechError::Protocol(
            "worker response envelope does not match",
        ));
    }
    Ok(())
}

pub(super) fn safe_worker_code(value: &str) -> &'static str {
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

pub(super) fn emit(
    control: &RunControl,
    segment_id: &SegmentId,
    phase: SpeechPhase,
    fraction: u32,
) -> Result<()> {
    emit_optional(control, Some(segment_id), phase, fraction)
}

pub(super) fn emit_optional(
    control: &RunControl,
    segment_id: Option<&SegmentId>,
    phase: SpeechPhase,
    fraction: u32,
) -> Result<()> {
    let progress = SpeechProgress::new(segment_id.cloned(), phase, fraction)?;
    control.emit(&progress);
    Ok(())
}
