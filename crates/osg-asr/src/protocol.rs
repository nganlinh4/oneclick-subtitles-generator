use crate::program::native_process_path;
use crate::{AsrEngineId, AsrError, LanguageCode, ModelAssets, NormalizedAudio, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

pub(crate) const PROTOCOL_VERSION: u16 = 2;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireRequest<'a> {
    protocol_version: u16,
    request_id: u64,
    operation: WireOperation,
    engine: AsrEngineId,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_duration_ms: Option<u64>,
    model_path: PathBuf,
    aligner_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireOperation {
    WarmUp,
    Transcribe,
}

impl<'a> WireRequest<'a> {
    pub(crate) fn new(
        request_id: u64,
        assets: &'a ModelAssets,
        audio: &'a NormalizedAudio,
        language: Option<&'a LanguageCode>,
    ) -> Result<Self> {
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            operation: WireOperation::Transcribe,
            engine: assets.engine(),
            input_path: Some(native_process_path(audio.path())?),
            input_duration_ms: Some(audio.duration_ms()),
            model_path: native_process_path(assets.model_directory())?,
            aligner_path: assets
                .aligner_directory()
                .map(native_process_path)
                .transpose()?,
            language: language.map(LanguageCode::as_str),
        })
    }

    pub(crate) fn warm_up(request_id: u64, assets: &'a ModelAssets) -> Result<Self> {
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            operation: WireOperation::WarmUp,
            engine: assets.engine(),
            input_path: None,
            input_duration_ms: None,
            model_path: native_process_path(assets.model_directory())?,
            aligner_path: assets
                .aligner_directory()
                .map(native_process_path)
                .transpose()?,
            language: None,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum WireEvent {
    Phase {
        protocol_version: u16,
        request_id: u64,
        sequence: u16,
        phase: WirePhase,
    },
    Complete {
        protocol_version: u16,
        request_id: u64,
        sequence: u16,
        transcript: String,
        language: Option<String>,
        backend: WireBackend,
        words: Vec<WireWord>,
        join_without_spaces: bool,
    },
    Ready {
        protocol_version: u16,
        request_id: u64,
        sequence: u16,
        backend: WireBackend,
    },
    Error {
        protocol_version: u16,
        request_id: u64,
        sequence: u16,
        code: WireFailure,
    },
}

impl WireEvent {
    pub(crate) const fn version(&self) -> u16 {
        match self {
            Self::Phase {
                protocol_version, ..
            }
            | Self::Complete {
                protocol_version, ..
            }
            | Self::Ready {
                protocol_version, ..
            }
            | Self::Error {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    pub(crate) const fn request_id(&self) -> u64 {
        match self {
            Self::Phase { request_id, .. }
            | Self::Complete { request_id, .. }
            | Self::Ready { request_id, .. }
            | Self::Error { request_id, .. } => *request_id,
        }
    }

    pub(crate) const fn sequence(&self) -> u16 {
        match self {
            Self::Phase { sequence, .. }
            | Self::Complete { sequence, .. }
            | Self::Ready { sequence, .. }
            | Self::Error { sequence, .. } => *sequence,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WirePhase {
    ModelLoading,
    Transcribing,
    Finalizing,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WireBackend {
    Cuda,
    DirectMl,
    CoreMl,
    Metal,
    Cpu,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireWord {
    pub(crate) text: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WireFailure {
    InvalidRequest,
    ModelUnavailable,
    ModelLoadFailed,
    AudioFailed,
    InferenceFailed,
    Internal,
}

impl WireFailure {
    pub(crate) const fn safe_message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "worker rejected the request",
            Self::ModelUnavailable => "model assets are unavailable",
            Self::ModelLoadFailed => "model loading failed",
            Self::AudioFailed => "audio decoding failed",
            Self::InferenceFailed => "speech inference failed",
            Self::Internal => "worker internal failure",
        }
    }
}

#[derive(Debug)]
pub(crate) enum ReaderMessage {
    Event(WireEvent),
    Failed(AsrError),
}

pub(crate) fn write_request(writer: &mut impl Write, request: &WireRequest<'_>) -> Result<()> {
    let body = serde_json::to_vec(request).map_err(|_| AsrError::Protocol("request encoding"))?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(AsrError::OutputLimit);
    }
    let length = u32::try_from(body.len()).map_err(|_| AsrError::OutputLimit)?;
    writer
        .write_all(&length.to_be_bytes())
        .and_then(|()| writer.write_all(&body))
        .and_then(|()| writer.flush())
        .map_err(|source| AsrError::ProcessIo {
            action: "request write",
            source,
        })
}

pub(crate) fn read_event(reader: &mut impl Read) -> Result<Option<WireEvent>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(source) => {
            return Err(AsrError::ProcessIo {
                action: "response read",
                source,
            });
        }
    }
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_RESPONSE_BYTES {
        return Err(AsrError::OutputLimit);
    }
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|source| AsrError::ProcessIo {
            action: "response read",
            source,
        })?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| AsrError::Protocol("invalid response frame"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_and_unframed_worker_output() {
        let oversized_length = u32::try_from(MAX_RESPONSE_BYTES + 1).unwrap();
        let mut oversized = Vec::from(oversized_length.to_be_bytes());
        oversized.extend_from_slice(b"ignored");
        assert!(matches!(
            read_event(&mut oversized.as_slice()),
            Err(AsrError::OutputLimit)
        ));

        let mut log = b"this is a stdout log, not a protocol frame".as_slice();
        assert!(read_event(&mut log).is_err());
    }
}
