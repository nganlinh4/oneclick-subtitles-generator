//! Backend-only Gemini media provider.
//!
//! The public catalog intentionally contains only stable Gemini models which
//! accept audio and video. API keys and provider file capabilities are kept in
//! Rust; neither type implements `Serialize`.

mod client;
mod error;
mod image;
mod model;
mod retry;
mod stream;
mod types;
mod upload;

pub use client::{GeminiClient, GeminiClientBuilder};
pub use error::{Error, ProviderError, Result, TransportKind};
pub use image::{
    GeneratedImage, ImageAspectRatio, ImageGenerateRequest, ImageModel, ImageSize,
    MAX_REFERENCE_IMAGE_BYTES, ReferenceImage,
};
pub use model::{
    ACCURATE_MODEL, DAILY_USE_CHAIN, DEFAULT_MODEL, DailyUse, InputModality, Lifecycle, Model,
    ModelSpec, ThinkingLevel, model_spec, supported_models,
};
pub use stream::GenerateStream;
pub use tokio_util::sync::CancellationToken;
pub use types::{
    ApiKey, Candidate, Content, FileState, GenerateRequest, GenerateResponse, GenerationConfig,
    InlineMedia, MediaInput, MediaResolution, Part, PromptFeedback, RetryPolicy, SafetyRating,
    TokenUsage, UploadRequest, UploadedFile,
};
