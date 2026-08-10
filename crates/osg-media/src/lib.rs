//! Native media probing and processing for OSG.
//!
//! The public API deliberately accepts typed operations instead of arbitrary
//! process arguments. Paths are native-only capability values: they do not
//! implement serde and their debug output is redacted.

mod binary;
mod compatibility;
mod engine;
mod error;
mod metadata;
mod path;
mod plan;
mod process;
mod progress;
mod waveform;

pub use binary::{
    BinaryKind, BinaryOrigin, BinarySearch, ResolvedBinary, Toolchain, ToolchainResolver,
};
pub use compatibility::{
    CompatibilityDecision, CompatibilityIssue, CompatibilityProfile, ConversionAction, IssueKind,
    IssueSeverity,
};
pub use engine::{ExecutionReport, MediaEngine, ToolHealth, ToolVersion};
pub use error::{MediaError, Result};
pub use metadata::{
    AudioMetadata, Disposition, FormatMetadata, FrameRate, MediaMetadata, MediaStream, StreamKind,
    VideoMetadata, parse_ffprobe_json,
};
pub use path::{MediaInput, MediaOutput};
pub use plan::{
    AudioBitrate, AudioExtractionPlan, AudioOutput, AudioSampleRate, AudioVisualizationPlan,
    ChannelCount, CompatibilityConversionPlan, ConversionOptions, EncoderPreset,
    MAX_NARRATION_MIX_DURATION_US, MAX_NARRATION_MIX_INPUTS, MediaOperation, MediaTimeRange,
    NarrationAudioEditPlan, NarrationMixClip, NarrationMixPlan, ThumbnailFormat, ThumbnailPlan,
    VideoClipPlan, WaveformPlan,
};
pub use process::{CancellationToken, RunControl};
pub use progress::{FfmpegProgress, ProgressSink};
pub use waveform::{WaveformLevel, WaveformPoint, WaveformPyramid};
