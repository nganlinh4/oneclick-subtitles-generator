use crate::{AudioFormat, Result, SpeechBackend, SpeechError};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::PathBuf;

pub(crate) const PROTOCOL_VERSION: u16 = 1;
pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
pub(crate) struct CommandFrame {
    pub(crate) protocol: u16,
    pub(crate) request_id: u64,
    #[serde(flatten)]
    pub(crate) command: WorkerCommand,
}

#[derive(Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub(crate) enum WorkerCommand {
    Synthesize {
        backend: SpeechBackend,
        segment_id: String,
        text: String,
        settings: Value,
        reference_path: Option<PathBuf>,
        output_path: PathBuf,
        output_format: AudioFormat,
    },
    ConvertVoice {
        backend: SpeechBackend,
        input_path: PathBuf,
        target_voice_path: PathBuf,
        output_path: PathBuf,
        output_format: AudioFormat,
    },
    PrepareReference {
        backend: SpeechBackend,
        input_path: PathBuf,
        filters: Value,
        output_path: PathBuf,
        output_format: AudioFormat,
    },
    ListVoices {
        backend: SpeechBackend,
    },
    Shutdown,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WorkerResponse {
    Hello {
        protocol: u16,
        backend: SpeechBackend,
        worker_version: String,
        max_text_bytes: u32,
    },
    Progress {
        protocol: u16,
        request_id: u64,
        phase: WirePhase,
        fraction_millionths: u32,
    },
    Complete {
        protocol: u16,
        request_id: u64,
        artifact: WireArtifact,
    },
    Voices {
        protocol: u16,
        request_id: u64,
        voices: Vec<WireVoice>,
    },
    Error {
        protocol: u16,
        request_id: u64,
        code: String,
        retryable: bool,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WirePhase {
    LoadingModel,
    Synthesizing,
    Encoding,
}

#[derive(Clone, Copy, Deserialize)]
pub(crate) struct WireArtifact {
    pub(crate) bytes: u64,
    pub(crate) duration_micros: u64,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channels: u8,
}

#[derive(Deserialize)]
pub(crate) struct WireVoice {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) language: String,
    pub(crate) gender: String,
}

pub(crate) fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<()> {
    let payload =
        serde_json::to_vec(value).map_err(|_| SpeechError::Protocol("failed to encode command"))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(SpeechError::FrameLimit);
    }
    let length = u32::try_from(payload.len()).map_err(|_| SpeechError::FrameLimit)?;
    writer
        .write_all(&length.to_be_bytes())
        .and_then(|()| writer.write_all(&payload))
        .and_then(|()| writer.flush())
        .map_err(SpeechError::WorkerIo)
}

pub(crate) fn read_frame<T: DeserializeOwned>(reader: &mut impl Read) -> Result<T> {
    let mut length = [0_u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(SpeechError::WorkerIo)?;
    let length =
        usize::try_from(u32::from_be_bytes(length)).map_err(|_| SpeechError::FrameLimit)?;
    if length == 0 {
        return Err(SpeechError::Protocol("empty worker frame"));
    }
    if length > MAX_FRAME_BYTES {
        return Err(SpeechError::FrameLimit);
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(SpeechError::WorkerIo)?;
    serde_json::from_slice(&payload).map_err(|_| SpeechError::Protocol("malformed worker frame"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_is_length_delimited() {
        #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
        struct Fixture {
            value: String,
        }
        let expected = Fixture {
            value: "line one\nline two".into(),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &expected).unwrap();
        let mut cursor = std::io::Cursor::new(bytes);
        assert_eq!(read_frame::<Fixture>(&mut cursor).unwrap(), expected);
    }

    #[test]
    fn oversized_length_is_rejected_before_allocation() {
        let length = u32::try_from(MAX_FRAME_BYTES + 1).unwrap().to_be_bytes();
        assert!(matches!(
            read_frame::<Value>(&mut std::io::Cursor::new(length)),
            Err(SpeechError::FrameLimit)
        ));
    }

    #[test]
    fn malformed_json_is_reported_without_echoing_it() {
        let hostile = b"{secret-path:C:\\\\private}";
        let mut frame = u32::try_from(hostile.len()).unwrap().to_be_bytes().to_vec();
        frame.extend_from_slice(hostile);
        let error = read_frame::<Value>(&mut std::io::Cursor::new(frame)).unwrap_err();
        let debug = format!("{error:?}");
        assert!(!debug.contains("private"));
    }
}
