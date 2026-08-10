use crate::binary::{BinaryKind, BinaryOrigin, ResolvedBinary, Toolchain};
use crate::process::{ProcessRequest, RunControl, run};
use crate::{MediaError, MediaInput, MediaMetadata, MediaOperation, Result, parse_ffprobe_json};
use serde::Serialize;
use std::ffi::OsString;
use std::path::Path;

const TOOL_VERSION_OUTPUT_LIMIT: usize = 64 * 1024;
const MIN_ARTIFACT_BYTES: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ToolVersion {
    pub tool: BinaryKind,
    pub origin: BinaryOrigin,
    pub version_line: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ToolHealth {
    pub ffmpeg: ToolVersion,
    pub ffprobe: ToolVersion,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ExecutionReport {
    pub elapsed_ms: u64,
    pub output_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct MediaEngine {
    toolchain: Toolchain,
}

impl MediaEngine {
    #[must_use]
    pub fn new(toolchain: Toolchain) -> Self {
        Self { toolchain }
    }

    pub fn probe(&self, input: &MediaInput, control: &RunControl) -> Result<MediaMetadata> {
        probe_with(self.toolchain.ffprobe(), input, control)
    }

    pub fn health(&self, control: &RunControl) -> Result<ToolHealth> {
        Ok(ToolHealth {
            ffmpeg: tool_version(self.toolchain.ffmpeg(), control)?,
            ffprobe: tool_version(self.toolchain.ffprobe(), control)?,
        })
    }

    /// Executes a typed operation into a same-directory temporary artifact,
    /// validates the result, then persists it without clobbering a late writer.
    pub fn execute(
        &self,
        operation: &MediaOperation,
        control: &RunControl,
    ) -> Result<ExecutionReport> {
        let final_path = operation.output().as_path();
        if final_path.exists() {
            return Err(MediaError::OutputExists);
        }
        let parent = final_path.parent().ok_or(MediaError::InvalidPath {
            role: "output",
            reason: "parent directory is missing",
        })?;
        let extension = final_path
            .extension()
            .and_then(|value| value.to_str())
            .ok_or(MediaError::InvalidOption("output extension is missing"))?;
        let temporary = tempfile::Builder::new()
            .prefix(".osg-media-")
            .suffix(&format!(".{extension}"))
            .tempfile_in(parent)
            .map_err(MediaError::Finalize)?;
        let temporary = temporary.into_temp_path();
        let args = operation.build_args(&temporary);
        let mut request = ProcessRequest::new(self.toolchain.ffmpeg(), args, control);
        request.expected_duration_us = operation.expected_duration_us();
        request.stdout_limit = TOOL_VERSION_OUTPUT_LIMIT;
        let process = run(request)?;
        if !process.status.success() {
            // The bounded tail is consumed here but deliberately not placed in
            // the public error because FFmpeg commonly echoes local paths.
            drop(process.stderr_tail);
            return Err(MediaError::ProcessFailed {
                tool: BinaryKind::Ffmpeg,
                code: process.status.code(),
            });
        }
        let metadata = std::fs::metadata(&temporary).map_err(|_| MediaError::MissingArtifact)?;
        if metadata.len() < MIN_ARTIFACT_BYTES {
            return Err(MediaError::MissingArtifact);
        }
        validate_artifact(self, operation, &temporary, control)?;
        temporary.persist_noclobber(final_path).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                MediaError::OutputExists
            } else {
                MediaError::Finalize(error.error)
            }
        })?;
        Ok(ExecutionReport {
            elapsed_ms: u64::try_from(process.elapsed.as_millis()).unwrap_or(u64::MAX),
            output_bytes: metadata.len(),
        })
    }
}

fn probe_with(
    binary: &ResolvedBinary,
    input: &MediaInput,
    control: &RunControl,
) -> Result<MediaMetadata> {
    let args = vec![
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_streams".into(),
        "-show_format".into(),
        "-show_entries".into(),
        "format=format_name,duration,start_time,size,bit_rate,probe_score:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,bit_rate,sample_rate,channels,channel_layout:stream_disposition=default,attached_pic:stream_tags=rotate:stream_side_data=rotation".into(),
        "-i".into(),
        input.as_path().as_os_str().to_owned(),
    ];
    let output = run(ProcessRequest::new(binary, args, control))?;
    if !output.status.success() {
        return Err(MediaError::ProcessFailed {
            tool: BinaryKind::Ffprobe,
            code: output.status.code(),
        });
    }
    if output.stdout_truncated {
        return Err(MediaError::OutputLimit {
            tool: BinaryKind::Ffprobe,
        });
    }
    parse_ffprobe_json(&output.stdout)
}

fn tool_version(binary: &ResolvedBinary, control: &RunControl) -> Result<ToolVersion> {
    let mut request = ProcessRequest::new(binary, vec![OsString::from("-version")], control);
    request.stdout_limit = TOOL_VERSION_OUTPUT_LIMIT;
    let output = run(request)?;
    if !output.status.success() {
        return Err(MediaError::ProcessFailed {
            tool: binary.kind(),
            code: output.status.code(),
        });
    }
    if output.stdout_truncated {
        return Err(MediaError::OutputLimit {
            tool: binary.kind(),
        });
    }
    let version_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(sanitize_version_line)
        .filter(|line| !line.is_empty())
        .ok_or(MediaError::InvalidProbe("tool version line is missing"))?;
    Ok(ToolVersion {
        tool: binary.kind(),
        origin: binary.origin(),
        version_line,
    })
}

fn sanitize_version_line(line: &str) -> String {
    line.chars()
        .filter(|character| character.is_ascii_graphic() || *character == ' ')
        .take(200)
        .collect()
}

fn validate_artifact(
    engine: &MediaEngine,
    operation: &MediaOperation,
    temporary: &Path,
    control: &RunControl,
) -> Result<()> {
    if matches!(operation, MediaOperation::Waveform(_)) {
        return Ok(());
    }
    let input = MediaInput::from_native_selection(temporary)?;
    let metadata = engine.probe(&input, control)?;
    let valid = match operation {
        MediaOperation::CompatibilityConversion(_)
        | MediaOperation::VideoClip(_)
        | MediaOperation::Thumbnail(_) => metadata.primary_video().is_some(),
        MediaOperation::AudioExtraction(_)
        | MediaOperation::NarrationAudioEdit(_)
        | MediaOperation::NarrationMix(_) => metadata.primary_audio().is_some(),
        MediaOperation::AudioVisualization(_) => {
            metadata.primary_video().is_some() && metadata.primary_audio().is_some()
        }
        MediaOperation::Waveform(_) => true,
    };
    valid.then_some(()).ok_or(MediaError::MissingArtifact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::Toolchain;
    use crate::process::test_support::mock_binary;
    use crate::{
        AudioExtractionPlan, CompatibilityConversionPlan, CompatibilityDecision,
        CompatibilityProfile, ConversionOptions, MediaOutput, MediaTimeRange,
    };
    use std::time::Duration;

    fn engine() -> MediaEngine {
        MediaEngine::new(Toolchain {
            ffmpeg: mock_binary(BinaryKind::Ffmpeg),
            ffprobe: mock_binary(BinaryKind::Ffprobe),
        })
    }

    #[test]
    fn probe_executes_fixed_json_contract() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"media").unwrap();
        let metadata = engine()
            .probe(
                &MediaInput::from_native_selection(source).unwrap(),
                &RunControl::new(Duration::from_secs(5)).unwrap(),
            )
            .unwrap();
        assert_eq!(metadata.duration_us(), Some(4_250_000));
        assert_eq!(
            metadata.primary_video().unwrap().codec.as_deref(),
            Some("h264")
        );
    }

    #[test]
    fn operation_uses_staging_and_no_clobber_finalization() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.mp4");
        let output_path = directory.path().join("audio.wav");
        std::fs::write(&source, b"media").unwrap();
        let operation = MediaOperation::AudioExtraction(
            AudioExtractionPlan::asr_wav(
                MediaInput::from_native_selection(source).unwrap(),
                MediaOutput::within_root(&output_path, directory.path()).unwrap(),
                MediaTimeRange::default(),
            )
            .unwrap(),
        );
        let report = engine()
            .execute(
                &operation,
                &RunControl::new(Duration::from_secs(5)).unwrap(),
            )
            .unwrap();
        assert!(report.output_bytes > 0);
        assert_eq!(std::fs::read(&output_path).unwrap(), b"mock-media-artifact");

        let error = engine()
            .execute(
                &operation,
                &RunControl::new(Duration::from_secs(5)).unwrap(),
            )
            .unwrap_err();
        assert!(matches!(error, MediaError::OutputExists));
    }

    #[test]
    fn health_exposes_origin_and_version_but_not_paths() {
        let health = engine()
            .health(&RunControl::new(Duration::from_secs(5)).unwrap())
            .unwrap();
        let json = serde_json::to_string(&health).unwrap();
        assert!(json.contains("osg-mock-1.0"));
        assert!(!json.contains("temp"));
    }

    #[test]
    fn conversion_output_is_validated_before_publish() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.webm");
        std::fs::write(&source, b"media").unwrap();
        let metadata = engine()
            .probe(
                &MediaInput::from_native_selection(&source).unwrap(),
                &RunControl::new(Duration::from_secs(5)).unwrap(),
            )
            .unwrap();
        let mut decision =
            CompatibilityDecision::analyze(&metadata, CompatibilityProfile::PortableWebView);
        decision.action = crate::ConversionAction::Remux;
        let operation = MediaOperation::CompatibilityConversion(
            CompatibilityConversionPlan::new(
                MediaInput::from_native_selection(source).unwrap(),
                MediaOutput::within_root(directory.path().join("out.mp4"), directory.path())
                    .unwrap(),
                &decision,
                ConversionOptions::default(),
                metadata.duration_us(),
            )
            .unwrap(),
        );
        assert!(
            engine()
                .execute(
                    &operation,
                    &RunControl::new(Duration::from_secs(5)).unwrap()
                )
                .is_ok()
        );
    }
}
