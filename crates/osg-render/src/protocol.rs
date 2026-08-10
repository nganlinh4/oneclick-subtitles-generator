use std::io::{Read, Write};

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{RenderError, Result};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_PROTOCOL_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_WORKER_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRenderRequest {
    pub protocol_version: u32,
    pub request_type: &'static str,
    pub serve_url: String,
    pub browser_executable: String,
    pub renderer_root: String,
    pub binaries_directory: String,
    pub output_location: String,
    pub composition_id: &'static str,
    pub input_props: Value,
    pub width: u32,
    pub height: u32,
    pub fps: u16,
    pub duration_in_frames: u32,
}

impl std::fmt::Debug for WorkerRenderRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerRenderRequest")
            .field("protocol_version", &self.protocol_version)
            .field("request_type", &self.request_type)
            .field("native_paths", &"<redacted>")
            .field("composition_id", &self.composition_id)
            .field("input_props", &"<redacted>")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .field("duration_in_frames", &self.duration_in_frames)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerPhase {
    LoadingComposition,
    RenderingFrames,
    Encoding,
    Muxing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerFailureCode {
    RuntimeUnavailable,
    InvalidRequest,
    CompositionUnavailable,
    BrowserFailure,
    RenderFailure,
    OutputInvalid,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerMessage {
    Ready {
        protocol_version: u32,
    },
    Progress {
        fraction_millionths: u32,
        rendered_frames: u32,
        encoded_frames: u32,
        duration_in_frames: u32,
        phase: WorkerPhase,
    },
    Completed {
        output_bytes: u64,
    },
    Failed {
        code: WorkerFailureCode,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RawWorkerMessage {
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Progress {
        #[serde(rename = "fractionMillionths")]
        fraction_millionths: u32,
        #[serde(rename = "renderedFrames")]
        rendered_frames: u32,
        #[serde(rename = "encodedFrames")]
        encoded_frames: u32,
        #[serde(rename = "durationInFrames")]
        duration_in_frames: u32,
        phase: WorkerPhase,
    },
    Completed {
        #[serde(rename = "outputBytes")]
        output_bytes: u64,
    },
    Failed {
        code: WorkerFailureCode,
    },
}

impl<'de> Deserialize<'de> for WorkerMessage {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| D::Error::custom("worker message must be an object"))?;
        let message_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| D::Error::custom("worker message type is missing"))?;
        let expected: &[&str] = match message_type {
            "ready" => &["type", "protocolVersion"],
            "progress" => &[
                "type",
                "fractionMillionths",
                "renderedFrames",
                "encodedFrames",
                "durationInFrames",
                "phase",
            ],
            "completed" => &["type", "outputBytes"],
            "failed" => &["type", "code"],
            _ => return Err(D::Error::custom("unknown worker message type")),
        };
        if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
            return Err(D::Error::custom("worker message fields are invalid"));
        }
        let raw: RawWorkerMessage = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(match raw {
            RawWorkerMessage::Ready { protocol_version } => Self::Ready { protocol_version },
            RawWorkerMessage::Progress {
                fraction_millionths,
                rendered_frames,
                encoded_frames,
                duration_in_frames,
                phase,
            } => Self::Progress {
                fraction_millionths,
                rendered_frames,
                encoded_frames,
                duration_in_frames,
                phase,
            },
            RawWorkerMessage::Completed { output_bytes } => Self::Completed { output_bytes },
            RawWorkerMessage::Failed { code } => Self::Failed { code },
        })
    }
}

pub(crate) fn write_json_frame(
    writer: &mut impl Write,
    value: &impl Serialize,
    maximum: usize,
) -> Result<()> {
    let payload = serde_json::to_vec(value).map_err(|_| RenderError::InvalidWorkerProtocol)?;
    if payload.is_empty()
        || payload.len() > maximum
        || payload.len() > usize::try_from(u32::MAX).unwrap_or(usize::MAX)
    {
        return Err(RenderError::InvalidWorkerProtocol);
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| RenderError::InvalidWorkerProtocol)?
        .to_be_bytes();
    writer.write_all(&length)?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

pub(crate) fn read_json_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
    maximum: usize,
) -> Result<Option<T>> {
    let mut length = [0_u8; 4];
    let mut read = 0_usize;
    while read < length.len() {
        match reader.read(&mut length[read..]) {
            Ok(0) if read == 0 => return Ok(None),
            Ok(0) => return Err(RenderError::InvalidWorkerProtocol),
            Ok(count) => read += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    let length = usize::try_from(u32::from_be_bytes(length))
        .map_err(|_| RenderError::InvalidWorkerProtocol)?;
    if length == 0 || length > maximum {
        return Err(RenderError::InvalidWorkerProtocol);
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|_| RenderError::InvalidWorkerProtocol)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use serde_json::json;

    use super::*;

    struct Fragmented {
        inner: Cursor<Vec<u8>>,
        maximum: usize,
    }

    impl Read for Fragmented {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let length = buffer.len().min(self.maximum);
            self.inner.read(&mut buffer[..length])
        }
    }

    #[test]
    fn framed_json_round_trips_across_fragmented_reads() {
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &json!({"hello":"world"}), 1_024).expect("frame");
        let mut reader = Fragmented {
            inner: Cursor::new(bytes),
            maximum: 1,
        };
        let decoded: Value = read_json_frame(&mut reader, 1_024)
            .expect("decode")
            .expect("message");
        assert_eq!(decoded, json!({"hello":"world"}));
        assert!(
            read_json_frame::<Value>(&mut reader, 1_024)
                .expect("eof")
                .is_none()
        );
    }

    #[test]
    fn zero_oversized_truncated_and_unknown_messages_fail_closed() {
        for bytes in [
            0_u32.to_be_bytes().to_vec(),
            65_537_u32.to_be_bytes().to_vec(),
            [3_u32.to_be_bytes().as_slice(), b"{}"].concat(),
        ] {
            assert!(read_json_frame::<Value>(&mut Cursor::new(bytes), 65_536).is_err());
        }

        let mut bytes = Vec::new();
        write_json_frame(
            &mut bytes,
            &json!({"type":"secretPath","path":"C:/private"}),
            1_024,
        )
        .expect("frame");
        assert!(read_json_frame::<WorkerMessage>(&mut Cursor::new(bytes), 1_024).is_err());
    }
}
