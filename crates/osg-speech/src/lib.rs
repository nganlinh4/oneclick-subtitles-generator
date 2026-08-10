//! Native speech domain, deterministic audio plans, and supervised model workers.
//!
//! Text, secrets, and filesystem paths are capability values with redacted
//! debug output. No public API accepts process arguments or shell fragments.

mod alignment;
mod artifact;
mod asset;
mod edit;
mod error;
mod program;
mod protocol;
mod request;
mod runtime;
mod secret;
mod session;
mod types;
mod worker;

pub use alignment::{
    AlignedClip, AlignmentAdjustment, AlignmentPlan, AlignmentPolicy, AlignmentStats, NarrationClip,
};
pub use artifact::{
    SpeechArtifact, SpeechArtifactSummary, VoiceDescriptor, VoiceGender, VoiceInventory,
};
pub use asset::{AudioAsset, SpeechOutput};
pub use edit::{
    AudioEditPlan, AudioFilter, NormalizedPoint, NormalizedTrim, ReferencePreparationPlan,
    SpeedFactor,
};
pub use error::{Result, SpeechError};
pub use program::{WorkerOrigin, WorkerProgram, WorkerResolver, WorkerSearch};
pub use request::{
    ChatterboxSettings, EdgeSettings, F5Settings, GeminiSettings, GttsDomain, GttsSettings,
    NarrationBatch, SynthesisRequest, SynthesisSettings, VoiceConversionRequest,
};
pub use runtime::{CancellationToken, RunControl, SpeechPhase, SpeechProgress, SpeechProgressSink};
pub use secret::SecretValue;
pub use types::{
    AudioFormat, LanguageTag, ModelId, SegmentId, SpeechBackend, SpeechText, TimeMicros, VoiceId,
};
pub use worker::{LazySpeechWorker, WorkerStatus};
