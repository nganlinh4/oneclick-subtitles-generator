//! Backend-only Gemini media provider.
//!
//! The public catalog intentionally contains only stable Gemini models which
//! accept audio and video. API keys and provider file capabilities are kept in
//! Rust; neither type implements `Serialize`.

mod client;
mod completion;
pub mod duration;
mod error;
mod image;
mod live_transcription;
mod model;
mod retry;
mod stream;
mod types;
mod upload;

pub use client::{GeminiClient, GeminiClientBuilder};
pub use completion::{TextStreamCompletion, TranscriptionStreamCompletion};
pub use duration::{
    MAX_ALLOWED_END_OVERSHOOT_MS, ProjectedWord, WordProjectionStatus, parse_duration,
    parse_duration_ms, parse_duration_nanos, project_word_with_100ms_overshoot_policy,
};
pub use error::{Error, ProviderError, Result, TransportKind};
pub use image::{
    GeneratedImage, ImageAspectRatio, ImageGenerateRequest, ImageModel, ImageSize,
    MAX_REFERENCE_IMAGE_BYTES, ReferenceImage,
};
pub use live_transcription::{LiveTranscriptionEvent, LiveTranscriptionKind};
pub use model::{
    ACCURATE_MODEL, DAILY_USE_CHAIN, DEFAULT_MODEL, DailyUse, GEMINI_35_TRANSCRIBE, InputModality,
    Lifecycle, Model, ModelKind, ModelSpec, TRANSCRIPTION_MODELS, ThinkingLevel, model_spec,
    supported_models, supported_transcription_models,
};
pub use stream::GenerateStream;
pub use tokio_util::sync::CancellationToken;
pub use types::{
    ApiKey, AudioTranscription, AudioTranscriptionConfig, Candidate, Content, FileState,
    GenerateRequest, GenerateResponse, GenerationConfig, InlineMedia, MediaInput, MediaResolution,
    Part, PromptFeedback, RetryPolicy, SafetyRating, TokenUsage, TranscribeRequest,
    TranscriptionWord, UploadRequest, UploadedFile,
};
