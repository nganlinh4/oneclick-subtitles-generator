//! Local ASR process boundary for the OSG desktop rewrite.
//!
//! ML runtimes stay out of the desktop process. This crate owns a lazy,
//! supervised worker over framed pipes; it exposes no TCP listener.

mod audio;
mod catalog;
mod engine;
mod error;
mod options;
mod process;
mod program;
mod protocol;
mod segment;

pub use audio::NormalizedAudio;
pub use catalog::{AsrEngineId, AsrEngineInfo, AsrRuntimeKind, catalog};
pub use engine::{
    AsrProgress, AsrService, CancellationToken, ExecutionBackend, ProgressPhase, ProgressSink,
    RunControl, Transcription, TranscriptionRequest,
};
pub use error::{AsrError, Result};
pub use options::{LanguageCode, SegmentStrategy, SegmentationOptions, TranscriptionOptions};
pub use program::{ModelAssets, WorkerProgram};
pub use segment::Segment;
