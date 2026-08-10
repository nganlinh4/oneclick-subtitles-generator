use std::{fmt, path::PathBuf, str::FromStr, time::Duration};

use bytes::Bytes;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use url::Url;

use crate::{DailyUse, Error, Model, Result, ThinkingLevel};

const MAX_API_KEY_BYTES: usize = 4_096;
const MAX_DISPLAY_NAME_CHARS: usize = 512;
const MAX_INLINE_MEDIA_BYTES: usize = 15_000_000;

/// Backend-only Gemini API key. It cannot be serialized and its debug output is
/// always redacted.
#[derive(Clone)]
pub struct ApiKey(SecretString);

impl ApiKey {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_API_KEY_BYTES
            || value.chars().any(char::is_whitespace)
        {
            return Err(Error::InvalidConfig(
                "API key is empty or malformed".to_owned(),
            ));
        }
        Ok(Self(SecretString::from(value)))
    }

    pub(crate) fn expose(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey([REDACTED])")
    }
}

/// Retry policy matching Google's documented bounded exponential-backoff
/// guidance for `408`, `429`, network failures, and `5xx` responses.
#[derive(Clone, Debug)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub jitter_percent: u8,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 4,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_mins(1),
            jitter_percent: 20,
        }
    }
}

impl RetryPolicy {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.max_retries > 10
            || self.initial_delay.is_zero()
            || self.max_delay < self.initial_delay
            || self.max_delay > Duration::from_mins(15)
            || self.jitter_percent > 100
        {
            return Err(Error::InvalidConfig(
                "invalid retry policy bounds".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Media resolution sent as `generationConfig.mediaResolution`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MediaResolution {
    MediaResolutionLow,
    MediaResolutionMedium,
    MediaResolutionHigh,
}

/// Structured-output and reasoning controls. Deprecated sampling parameters
/// are intentionally absent for the current Gemini 3.x endpoints.
#[derive(Clone, Default)]
pub struct GenerationConfig {
    pub max_output_tokens: Option<u32>,
    pub thinking_level: Option<ThinkingLevel>,
    pub media_resolution: Option<MediaResolution>,
    pub response_json_schema: Option<Value>,
}

impl fmt::Debug for GenerationConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GenerationConfig")
            .field("max_output_tokens", &self.max_output_tokens)
            .field("thinking_level", &self.thinking_level)
            .field("media_resolution", &self.media_resolution)
            .field(
                "response_json_schema",
                &self.response_json_schema.as_ref().map(|_| "[SCHEMA]"),
            )
            .finish()
    }
}

impl GenerationConfig {
    #[must_use]
    pub fn for_use(use_case: DailyUse) -> Self {
        Self {
            thinking_level: Some(use_case.thinking_level()),
            media_resolution: match use_case {
                DailyUse::VideoUnderstanding => Some(MediaResolution::MediaResolutionMedium),
                _ => None,
            },
            ..Self::default()
        }
    }

    pub(crate) fn validate(&self, model: Model) -> Result<()> {
        if self
            .max_output_tokens
            .is_some_and(|limit| limit == 0 || limit > model.spec().output_token_limit)
        {
            return Err(Error::InvalidRequest(format!(
                "max output tokens must be within 1..={}",
                model.spec().output_token_limit
            )));
        }
        if let Some(schema) = &self.response_json_schema {
            let size = serde_json::to_vec(schema)
                .map_err(|_| Error::InvalidRequest("response schema is not valid JSON".to_owned()))?
                .len();
            if size > 1_048_576 {
                return Err(Error::InvalidRequest(
                    "response schema exceeds 1 MiB".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

/// Validated inline audio or video. Debug output reports only MIME and size.
#[derive(Clone)]
pub struct InlineMedia {
    mime_type: String,
    bytes: Bytes,
}

impl InlineMedia {
    pub fn new(mime_type: impl Into<String>, bytes: impl Into<Bytes>) -> Result<Self> {
        let raw_mime_type = mime_type.into();
        let mime_type = normalize_media_mime(&raw_mime_type)?;
        let bytes = bytes.into();
        if bytes.is_empty() {
            return Err(Error::InvalidRequest("inline media is empty".to_owned()));
        }
        if bytes.len() > MAX_INLINE_MEDIA_BYTES {
            return Err(Error::InlineRequestTooLarge {
                actual_bytes: bytes.len(),
                limit_bytes: MAX_INLINE_MEDIA_BYTES,
            });
        }
        Ok(Self { mime_type, bytes })
    }

    #[must_use]
    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub(crate) fn bytes(&self) -> &Bytes {
        &self.bytes
    }
}

impl fmt::Debug for InlineMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InlineMedia")
            .field("mime_type", &self.mime_type)
            .field("bytes", &format_args!("[{} BYTES]", self.bytes.len()))
            .finish_non_exhaustive()
    }
}

/// Gemini Files API processing state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FileState {
    #[serde(rename = "STATE_UNSPECIFIED", alias = "UNSPECIFIED")]
    Unspecified,
    Processing,
    Active,
    Failed,
}

/// Provider file capability. It intentionally does not implement `Serialize`;
/// keep it behind an opaque application-owned asset ID.
#[derive(Clone)]
pub struct UploadedFile {
    pub(crate) name: String,
    pub(crate) uri: Url,
    pub(crate) mime_type: String,
    pub(crate) size_bytes: u64,
    pub(crate) state: FileState,
    pub(crate) expiration_time: Option<String>,
    pub(crate) processing_error: Option<String>,
}

impl UploadedFile {
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    #[must_use]
    pub const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    #[must_use]
    pub const fn state(&self) -> FileState {
        self.state
    }

    #[must_use]
    pub fn expiration_time(&self) -> Option<&str> {
        self.expiration_time.as_deref()
    }

    pub(crate) fn uri(&self) -> &Url {
        &self.uri
    }
}

impl fmt::Debug for UploadedFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadedFile")
            .field("name", &self.name)
            .field("uri", &"[PROVIDER FILE URI]")
            .field("mime_type", &self.mime_type)
            .field("size_bytes", &self.size_bytes)
            .field("state", &self.state)
            .field("expiration_time", &self.expiration_time)
            .finish_non_exhaustive()
    }
}

/// An inline blob or previously uploaded provider file.
#[derive(Clone, Debug)]
pub enum MediaInput {
    Inline(InlineMedia),
    Uploaded(UploadedFile),
}

/// High-level generation request. Its `Debug` implementation redacts prompts,
/// instructions, schemas, inline bytes, and provider file URIs.
#[derive(Clone)]
pub struct GenerateRequest {
    pub model: Model,
    pub prompt: String,
    pub system_instruction: Option<String>,
    pub media: Vec<MediaInput>,
    pub generation: GenerationConfig,
}

impl GenerateRequest {
    #[must_use]
    pub fn for_use(use_case: DailyUse, prompt: impl Into<String>) -> Self {
        Self {
            model: use_case.model(),
            prompt: prompt.into(),
            system_instruction: None,
            media: Vec::new(),
            generation: GenerationConfig::for_use(use_case),
        }
    }
}

impl fmt::Debug for GenerateRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GenerateRequest")
            .field("model", &self.model)
            .field(
                "prompt",
                &format_args!("[{} CHARS]", self.prompt.chars().count()),
            )
            .field(
                "system_instruction",
                &self
                    .system_instruction
                    .as_ref()
                    .map(|value| format!("[{} CHARS]", value.chars().count())),
            )
            .field("media_count", &self.media.len())
            .field("generation", &self.generation)
            .finish()
    }
}

/// Backend upload request. The local path is always redacted from debug output.
#[derive(Clone)]
pub struct UploadRequest {
    pub path: PathBuf,
    pub mime_type: String,
    pub display_name: Option<String>,
}

impl UploadRequest {
    pub fn new(path: impl Into<PathBuf>, mime_type: impl Into<String>) -> Result<Self> {
        Ok(Self {
            path: path.into(),
            mime_type: {
                let raw_mime_type = mime_type.into();
                normalize_media_mime(&raw_mime_type)?
            },
            display_name: None,
        })
    }

    pub fn with_display_name(mut self, display_name: impl Into<String>) -> Result<Self> {
        let display_name = display_name.into();
        if display_name.is_empty() || display_name.chars().count() > MAX_DISPLAY_NAME_CHARS {
            return Err(Error::InvalidRequest(
                "display name must contain 1 to 512 characters".to_owned(),
            ));
        }
        self.display_name = Some(display_name);
        Ok(self)
    }
}

impl fmt::Debug for UploadRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadRequest")
            .field("path", &"[LOCAL PATH]")
            .field("mime_type", &self.mime_type)
            .field("display_name", &self.display_name)
            .finish()
    }
}

/// A response content part. Unknown provider fields are ignored for forward
/// compatibility; thought text remains identifiable and is excluded by
/// `GenerateResponse::text`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub text: Option<String>,
    #[serde(default)]
    pub thought: bool,
    pub thought_signature: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Content {
    pub role: Option<String>,
    #[serde(default)]
    pub parts: Vec<Part>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyRating {
    pub category: Option<String>,
    pub probability: Option<String>,
    pub blocked: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub content: Option<Content>,
    pub finish_reason: Option<String>,
    pub index: Option<u32>,
    #[serde(default)]
    pub safety_ratings: Vec<SafetyRating>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFeedback {
    pub block_reason: Option<String>,
    pub block_reason_message: Option<String>,
    #[serde(default)]
    pub safety_ratings: Vec<SafetyRating>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_token_count: Option<u64>,
    pub candidates_token_count: Option<u64>,
    pub total_token_count: Option<u64>,
    pub thoughts_token_count: Option<u64>,
    pub cached_content_token_count: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResponse {
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    pub prompt_feedback: Option<PromptFeedback>,
    pub usage_metadata: Option<TokenUsage>,
    pub model_version: Option<String>,
    pub response_id: Option<String>,
}

impl GenerateResponse {
    /// Concatenates non-thinking text from the first candidate.
    #[must_use]
    pub fn text(&self) -> Option<String> {
        let text = self
            .candidates
            .first()?
            .content
            .as_ref()?
            .parts
            .iter()
            .filter(|part| !part.thought)
            .filter_map(|part| part.text.as_deref())
            .collect::<String>();
        (!text.is_empty()).then_some(text)
    }

    pub fn required_text(&self) -> Result<String> {
        self.text().ok_or(Error::NoTextOutput)
    }

    pub fn parse_json<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_str(&self.required_text()?)
            .map_err(|_| Error::InvalidRequest("Gemini output is not valid schema JSON".to_owned()))
    }
}

pub(crate) fn normalize_media_mime(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if supported_media_mime(&normalized) {
        Ok(normalized)
    } else {
        Err(Error::UnsupportedMimeType(normalized))
    }
}

pub(crate) fn supported_media_mime(value: &str) -> bool {
    matches!(
        value,
        "audio/wav"
            | "audio/x-wav"
            | "audio/mp3"
            | "audio/mpeg"
            | "audio/aiff"
            | "audio/x-aiff"
            | "audio/aac"
            | "audio/ogg"
            | "audio/flac"
            | "video/mp4"
            | "video/mpeg"
            | "video/quicktime"
            | "video/avi"
            | "video/x-flv"
            | "video/mpg"
            | "video/webm"
            | "video/wmv"
            | "video/3gpp"
    )
}

pub(crate) fn validate_file_name(value: &str) -> Result<()> {
    let Some(id) = value.strip_prefix("files/") else {
        return Err(Error::InvalidRequest("invalid Gemini file name".to_owned()));
    };
    if id.is_empty()
        || id.len() > 40
        || id.starts_with('-')
        || id.ends_with('-')
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(Error::InvalidRequest("invalid Gemini file name".to_owned()));
    }
    Ok(())
}

pub(crate) fn parse_provider_uri(value: &str, allow_loopback_http: bool) -> Result<Url> {
    let uri = Url::from_str(value)
        .map_err(|_| Error::UploadProtocol("provider returned an invalid file URI".to_owned()))?;
    let valid = uri.scheme() == "https"
        || (allow_loopback_http
            && uri.scheme() == "http"
            && uri.host_str().is_some_and(is_loopback_host));
    if !valid {
        return Err(Error::UploadProtocol(
            "provider returned an unsafe file URI".to_owned(),
        ));
    }
    Ok(uri)
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_payloads_are_redacted_from_debug() {
        let key = ApiKey::new("super-secret-key").unwrap();
        assert_eq!(format!("{key:?}"), "ApiKey([REDACTED])");

        let request = GenerateRequest {
            model: Model::Gemini35FlashLite,
            prompt: "private transcript".to_owned(),
            system_instruction: Some("private instruction".to_owned()),
            media: vec![MediaInput::Inline(
                InlineMedia::new("audio/mpeg", Bytes::from_static(b"private media")).unwrap(),
            )],
            generation: GenerationConfig::default(),
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("private transcript"));
        assert!(!debug.contains("private instruction"));
        assert!(!debug.contains("private media"));
    }

    #[test]
    fn mime_catalog_is_audio_video_only() {
        assert!(InlineMedia::new("audio/mpeg", Bytes::from_static(b"a")).is_ok());
        assert!(InlineMedia::new("video/mp4", Bytes::from_static(b"v")).is_ok());
        assert!(InlineMedia::new("image/png", Bytes::from_static(b"i")).is_err());
        assert!(InlineMedia::new("text/plain", Bytes::from_static(b"t")).is_err());
    }

    #[test]
    fn response_excludes_thoughts() {
        let response: GenerateResponse = serde_json::from_value(serde_json::json!({
            "candidates": [{"content": {"parts": [
                {"text": "hidden", "thought": true},
                {"text": "visible"},
                {"text": " output"}
            ]}}]
        }))
        .unwrap();
        assert_eq!(response.text().as_deref(), Some("visible output"));
    }
}
