//! Native orchestration for media preparation operations.
//!
//! Filesystem paths stay behind native capability types. Public result metadata
//! is serializable, while produced artifacts are intentionally native-only and
//! clean themselves up unless a trusted durable store publishes them.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use osg_media::{
    AudioBitrate, AudioExtractionPlan, AudioOutput, AudioVisualizationPlan,
    CompatibilityConversionPlan, CompatibilityDecision, CompatibilityProfile, ConversionAction,
    ConversionOptions, ExecutionReport, MediaEngine, MediaError, MediaInput, MediaMetadata,
    MediaOperation, MediaOutput, MediaTimeRange, RunControl, VideoClipPlan, WaveformPlan,
    WaveformPyramid,
};
use serde::Serialize;
use tempfile::TempDir;
use thiserror::Error;

const STAGING_MARKER: &str = ".osg-media-pipeline-v1";
const STAGING_MARKER_BYTES: &[u8] = b"oneclick-subtitles-generator:media-pipeline:v1\n";
const STAGING_DIRECTORY_PREFIX: &str = "job-";
const MAX_STAGING_JOBS: usize = 1_024;
const MAX_STAGING_FILES_PER_JOB: usize = 16;

pub type Result<T> = std::result::Result<T, PipelineError>;

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error(transparent)]
    Media(#[from] MediaError),
    #[error("the selected media has no audio stream")]
    MissingAudio,
    #[error("the selected media has no playable stream")]
    NoPlayableStream,
    #[error("the requested clip range is outside the selected media")]
    InvalidClipRange,
    #[error("the native staging directory is unavailable")]
    StagingUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInspection {
    pub metadata: MediaMetadata,
    pub compatibility: CompatibilityDecision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreparedMediaKind {
    CompatibilityConversion,
    AudioVisualization,
    AudioExtraction,
    AnalysisClip,
}

/// A staged native artifact. It is deleted on drop unless a trusted caller
/// copies it into the application's content-addressed artifact store first.
pub struct PreparedMedia {
    directory: TempDir,
    path: PathBuf,
    extension: &'static str,
    kind: PreparedMediaKind,
    metadata: MediaMetadata,
    report: ExecutionReport,
}

impl PreparedMedia {
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn extension(&self) -> &'static str {
        self.extension
    }

    #[must_use]
    pub const fn kind(&self) -> PreparedMediaKind {
        self.kind
    }

    #[must_use]
    pub const fn metadata(&self) -> &MediaMetadata {
        &self.metadata
    }

    #[must_use]
    pub const fn report(&self) -> &ExecutionReport {
        &self.report
    }

    #[must_use]
    pub fn staging_root(&self) -> &Path {
        self.directory.path()
    }
}

impl fmt::Debug for PreparedMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedMedia")
            .field("path", &"<redacted>")
            .field("extension", &self.extension)
            .field("kind", &self.kind)
            .field("metadata", &self.metadata)
            .field("report", &self.report)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum PreparationOutcome {
    Direct(MediaInspection),
    Prepared(PreparedMedia),
}

#[derive(Debug)]
pub struct WaveformOutcome {
    pub inspection: MediaInspection,
    pub waveform: WaveformPyramid,
    pub report: ExecutionReport,
}

#[derive(Clone)]
pub struct MediaPipeline {
    engine: MediaEngine,
    staging: StagingMode,
}

#[derive(Clone)]
enum StagingMode {
    SystemTemporary,
    Managed(Arc<PathBuf>),
}

impl fmt::Debug for StagingMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SystemTemporary => formatter.write_str("SystemTemporary"),
            Self::Managed(_) => formatter.write_str("Managed(<redacted>)"),
        }
    }
}

impl fmt::Debug for MediaPipeline {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaPipeline")
            .field("engine", &self.engine)
            .field("staging", &self.staging)
            .finish()
    }
}

impl MediaPipeline {
    #[must_use]
    pub const fn new(engine: MediaEngine) -> Self {
        Self {
            engine,
            staging: StagingMode::SystemTemporary,
        }
    }

    /// Opens an application-owned staging root and removes bounded stale jobs
    /// left by a prior crash. Unknown entries fail closed instead of being
    /// recursively deleted.
    pub fn with_staging_root(engine: MediaEngine, root: impl AsRef<Path>) -> Result<Self> {
        let root = prepare_staging_root(root.as_ref())?;
        let pipeline = Self {
            engine,
            staging: StagingMode::Managed(Arc::new(root)),
        };
        pipeline.reconcile_staging()?;
        Ok(pipeline)
    }

    pub fn reconcile_staging(&self) -> Result<()> {
        let StagingMode::Managed(root) = &self.staging else {
            return Ok(());
        };
        reconcile_staging_root(root)
    }

    pub fn inspect(&self, input: &MediaInput, control: &RunControl) -> Result<MediaInspection> {
        let metadata = self.engine.probe(input, control)?;
        let compatibility =
            CompatibilityDecision::analyze(&metadata, CompatibilityProfile::PortableWebView);
        Ok(MediaInspection {
            metadata,
            compatibility,
        })
    }

    /// Prepares media for portable `WebView` playback. Compatible video stays
    /// zero-copy; incompatible video is converted once; audio-only input gets
    /// the legacy black 256x144 canvas without browser-side decoding.
    pub fn prepare_playback(
        &self,
        input: MediaInput,
        control: &RunControl,
    ) -> Result<PreparationOutcome> {
        let inspection = self.inspect(&input, control)?;
        if inspection.metadata.primary_video().is_some() {
            return match inspection.compatibility.action {
                ConversionAction::Direct => Ok(PreparationOutcome::Direct(inspection)),
                ConversionAction::Reject => Err(PipelineError::NoPlayableStream),
                _ => self
                    .run_prepared(
                        "prepared.mp4",
                        "mp4",
                        PreparedMediaKind::CompatibilityConversion,
                        |output| {
                            CompatibilityConversionPlan::new(
                                input,
                                output,
                                &inspection.compatibility,
                                ConversionOptions::default(),
                                inspection.metadata.duration_us(),
                            )
                            .map(MediaOperation::CompatibilityConversion)
                        },
                        control,
                    )
                    .map(PreparationOutcome::Prepared),
            };
        }
        if inspection.metadata.primary_audio().is_none() {
            return Err(PipelineError::NoPlayableStream);
        }
        self.run_prepared(
            "audio-visualization.mp4",
            "mp4",
            PreparedMediaKind::AudioVisualization,
            |output| {
                AudioVisualizationPlan::new(input, output, inspection.metadata.duration_us())
                    .map(MediaOperation::AudioVisualization)
            },
            control,
        )
        .map(PreparationOutcome::Prepared)
    }

    pub fn extract_audio(
        &self,
        input: MediaInput,
        format: AudioOutput,
        range: MediaTimeRange,
        control: &RunControl,
    ) -> Result<PreparedMedia> {
        let inspection = self.inspect(&input, control)?;
        if inspection.metadata.primary_audio().is_none() {
            return Err(PipelineError::MissingAudio);
        }
        let extension = audio_extension(format);
        let filename = format!("extracted.{extension}");
        self.run_prepared(
            &filename,
            extension,
            PreparedMediaKind::AudioExtraction,
            |output| {
                AudioExtractionPlan::new(input, output, format, range)
                    .map(MediaOperation::AudioExtraction)
            },
            control,
        )
    }

    /// Materializes an exact time range as a new Gemini-compatible artifact.
    /// Video becomes portable MP4; audio-only input becomes MP3. A trusted
    /// caller publishes the staged bytes and assigns a fresh opaque asset ID.
    pub fn clip_for_analysis(
        &self,
        input: MediaInput,
        range: MediaTimeRange,
        control: &RunControl,
    ) -> Result<PreparedMedia> {
        let inspection = self.inspect(&input, control)?;
        validate_clip_range(&inspection.metadata, range)?;
        if inspection.metadata.primary_video().is_some() {
            return self.run_prepared(
                "analysis-clip.mp4",
                "mp4",
                PreparedMediaKind::AnalysisClip,
                |output| {
                    VideoClipPlan::new(input, output, range, ConversionOptions::default())
                        .map(MediaOperation::VideoClip)
                },
                control,
            );
        }
        if inspection.metadata.primary_audio().is_some() {
            return self.run_prepared(
                "analysis-clip.mp3",
                "mp3",
                PreparedMediaKind::AnalysisClip,
                |output| {
                    AudioExtractionPlan::new(
                        input,
                        output,
                        AudioOutput::Mp3 {
                            bitrate: AudioBitrate::new(192)?,
                        },
                        range,
                    )
                    .map(MediaOperation::AudioExtraction)
                },
                control,
            );
        }
        Err(PipelineError::NoPlayableStream)
    }

    pub fn generate_waveform(
        &self,
        input: MediaInput,
        desired_points_per_second: u32,
        max_points: usize,
        range: MediaTimeRange,
        control: &RunControl,
    ) -> Result<WaveformOutcome> {
        let inspection = self.inspect(&input, control)?;
        if inspection.metadata.primary_audio().is_none() {
            return Err(PipelineError::MissingAudio);
        }
        let directory = self.create_staging_directory()?;
        let output =
            MediaOutput::within_root(directory.path().join("waveform.pcm"), directory.path())?;
        let plan = WaveformPlan::new(
            input,
            output,
            inspection.metadata.duration_us(),
            desired_points_per_second,
            max_points,
            range,
        )?;
        let operation = MediaOperation::Waveform(plan.clone());
        let report = self.engine.execute(&operation, control)?;
        let waveform = WaveformPyramid::read_from(&plan)?;
        Ok(WaveformOutcome {
            inspection,
            waveform,
            report,
        })
    }

    fn run_prepared(
        &self,
        filename: &str,
        extension: &'static str,
        kind: PreparedMediaKind,
        operation: impl FnOnce(MediaOutput) -> osg_media::Result<MediaOperation>,
        control: &RunControl,
    ) -> Result<PreparedMedia> {
        let directory = self.create_staging_directory()?;
        let path = directory.path().join(filename);
        let output = MediaOutput::within_root(&path, directory.path())?;
        let operation = operation(output)?;
        let report = self.engine.execute(&operation, control)?;
        let output_input = MediaInput::from_native_selection(&path)?;
        let metadata = self.engine.probe(&output_input, control)?;
        Ok(PreparedMedia {
            directory,
            path,
            extension,
            kind,
            metadata,
            report,
        })
    }

    fn create_staging_directory(&self) -> Result<TempDir> {
        let mut builder = tempfile::Builder::new();
        builder.prefix(STAGING_DIRECTORY_PREFIX);
        match &self.staging {
            StagingMode::SystemTemporary => builder
                .tempdir()
                .map_err(|_| PipelineError::StagingUnavailable),
            StagingMode::Managed(root) => builder
                .tempdir_in(root.as_path())
                .map_err(|_| PipelineError::StagingUnavailable),
        }
    }
}

const fn audio_extension(format: AudioOutput) -> &'static str {
    match format {
        AudioOutput::WavPcm16 { .. } => "wav",
        AudioOutput::M4aAac { .. } => "m4a",
        AudioOutput::Mp3 { .. } => "mp3",
        AudioOutput::Flac { .. } => "flac",
    }
}

fn validate_clip_range(metadata: &MediaMetadata, range: MediaTimeRange) -> Result<()> {
    let Some(clip_duration) = range.duration_us else {
        return Err(PipelineError::InvalidClipRange);
    };
    let clip_end = range
        .start_us
        .checked_add(clip_duration)
        .ok_or(PipelineError::InvalidClipRange)?;
    if metadata
        .duration_us()
        .is_some_and(|media_duration| range.start_us >= media_duration || clip_end > media_duration)
    {
        return Err(PipelineError::InvalidClipRange);
    }
    Ok(())
}

fn prepare_staging_root(root: &Path) -> Result<PathBuf> {
    fs::create_dir_all(root).map_err(|_| PipelineError::StagingUnavailable)?;
    let root_metadata =
        fs::symlink_metadata(root).map_err(|_| PipelineError::StagingUnavailable)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(PipelineError::StagingUnavailable);
    }
    let root = fs::canonicalize(root).map_err(|_| PipelineError::StagingUnavailable)?;
    let marker = root.join(STAGING_MARKER);
    match fs::read(&marker) {
        Ok(bytes) if bytes == STAGING_MARKER_BYTES => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut entries = fs::read_dir(&root).map_err(|_| PipelineError::StagingUnavailable)?;
            if entries.next().is_some() {
                return Err(PipelineError::StagingUnavailable);
            }
            let mut marker_file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .map_err(|_| PipelineError::StagingUnavailable)?;
            marker_file
                .write_all(STAGING_MARKER_BYTES)
                .and_then(|()| marker_file.sync_all())
                .map_err(|_| PipelineError::StagingUnavailable)?;
        }
        Ok(_) | Err(_) => return Err(PipelineError::StagingUnavailable),
    }
    Ok(root)
}

fn reconcile_staging_root(root: &Path) -> Result<()> {
    let mut entries = fs::read_dir(root).map_err(|_| PipelineError::StagingUnavailable)?;
    for index in 0..=MAX_STAGING_JOBS {
        let Some(entry) = entries.next() else {
            return Ok(());
        };
        let entry = entry.map_err(|_| PipelineError::StagingUnavailable)?;
        if index == MAX_STAGING_JOBS {
            return Err(PipelineError::StagingUnavailable);
        }
        let name = entry.file_name();
        if name == STAGING_MARKER {
            continue;
        }
        let Some(name) = name.to_str() else {
            return Err(PipelineError::StagingUnavailable);
        };
        if !name.starts_with(STAGING_DIRECTORY_PREFIX) {
            return Err(PipelineError::StagingUnavailable);
        }
        remove_stale_job_directory(&entry.path())?;
    }
    Err(PipelineError::StagingUnavailable)
}

fn remove_stale_job_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PipelineError::StagingUnavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PipelineError::StagingUnavailable);
    }
    let mut entries = fs::read_dir(path).map_err(|_| PipelineError::StagingUnavailable)?;
    for index in 0..=MAX_STAGING_FILES_PER_JOB {
        let Some(entry) = entries.next() else {
            fs::remove_dir(path).map_err(|_| PipelineError::StagingUnavailable)?;
            return Ok(());
        };
        let entry = entry.map_err(|_| PipelineError::StagingUnavailable)?;
        if index == MAX_STAGING_FILES_PER_JOB {
            return Err(PipelineError::StagingUnavailable);
        }
        let entry_metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| PipelineError::StagingUnavailable)?;
        if entry_metadata.is_dir() && !entry_metadata.file_type().is_symlink() {
            return Err(PipelineError::StagingUnavailable);
        }
        fs::remove_file(entry.path()).map_err(|_| PipelineError::StagingUnavailable)?;
    }
    Err(PipelineError::StagingUnavailable)
}
