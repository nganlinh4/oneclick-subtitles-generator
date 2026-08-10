use std::{collections::HashMap, fmt, sync::Arc, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures_util::StreamExt;
use reqwest::{StatusCode, header::HeaderMap};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    ApiKey, Error, GenerateRequest, GenerateResponse, MediaInput, Model, Result, RetryPolicy,
    retry::{parse_provider_error, retry_delay, transport_kind},
    types::is_loopback_host,
};

const OFFICIAL_API_BASE: &str = "https://generativelanguage.googleapis.com/";
const DEFAULT_MAX_INLINE_REQUEST_BYTES: usize = 20_000_000;
const DEFAULT_MAX_UPLOAD_BYTES: u64 = 2_000_000_000;
const DEFAULT_UPLOAD_CHUNK_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_ERROR_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct ClientOptions {
    pub api_base: Url,
    pub request_timeout: Duration,
    pub upload_request_timeout: Duration,
    pub processing_timeout: Duration,
    pub poll_interval: Duration,
    pub max_inline_request_bytes: usize,
    pub max_upload_bytes: u64,
    pub upload_chunk_bytes: usize,
    pub max_response_bytes: usize,
    pub max_error_bytes: usize,
    pub max_server_retry_after: Duration,
    pub default_rate_limit_cooldown: Duration,
    pub max_cooldown_wait: Duration,
    pub retry: RetryPolicy,
    pub max_concurrent_requests: usize,
    pub allow_loopback_http: bool,
}

/// Builder with bounded production defaults. Endpoint overrides allow an HTTPS
/// proxy or a loopback-only test server; plaintext remote origins are rejected.
#[derive(Clone)]
pub struct GeminiClientBuilder {
    api_key: ApiKey,
    options: ClientOptions,
}

impl fmt::Debug for GeminiClientBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiClientBuilder")
            .field("api_key", &"[REDACTED]")
            .field("options", &self.options)
            .finish()
    }
}

impl GeminiClientBuilder {
    #[must_use]
    pub fn new(api_key: ApiKey) -> Self {
        Self {
            api_key,
            options: ClientOptions {
                api_base: Url::parse(OFFICIAL_API_BASE).expect("official Gemini URL is valid"),
                request_timeout: Duration::from_mins(3),
                upload_request_timeout: Duration::from_mins(2),
                processing_timeout: Duration::from_mins(15),
                poll_interval: Duration::from_secs(2),
                max_inline_request_bytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
                max_upload_bytes: DEFAULT_MAX_UPLOAD_BYTES,
                upload_chunk_bytes: DEFAULT_UPLOAD_CHUNK_BYTES,
                max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
                max_error_bytes: DEFAULT_MAX_ERROR_BYTES,
                max_server_retry_after: Duration::from_mins(15),
                default_rate_limit_cooldown: Duration::from_secs(30),
                max_cooldown_wait: Duration::from_mins(1),
                retry: RetryPolicy::default(),
                max_concurrent_requests: 4,
                allow_loopback_http: false,
            },
        }
    }

    pub fn api_base(mut self, api_base: Url) -> Result<Self> {
        validate_api_base(&api_base)?;
        self.options.allow_loopback_http = api_base.scheme() == "http";
        self.options.api_base = api_base;
        Ok(self)
    }

    #[must_use]
    pub fn request_timeout(mut self, timeout: Duration) -> Self {
        self.options.request_timeout = timeout;
        self
    }

    #[must_use]
    pub fn upload_request_timeout(mut self, timeout: Duration) -> Self {
        self.options.upload_request_timeout = timeout;
        self
    }

    #[must_use]
    pub fn processing_timeout(mut self, timeout: Duration) -> Self {
        self.options.processing_timeout = timeout;
        self
    }

    #[must_use]
    pub fn poll_interval(mut self, interval: Duration) -> Self {
        self.options.poll_interval = interval;
        self
    }

    #[must_use]
    pub fn retry_policy(mut self, policy: RetryPolicy) -> Self {
        self.options.retry = policy;
        self
    }

    #[must_use]
    pub fn max_inline_request_bytes(mut self, limit: usize) -> Self {
        self.options.max_inline_request_bytes = limit;
        self
    }

    #[must_use]
    pub fn max_upload_bytes(mut self, limit: u64) -> Self {
        self.options.max_upload_bytes = limit;
        self
    }

    #[must_use]
    pub fn upload_chunk_bytes(mut self, size: usize) -> Self {
        self.options.upload_chunk_bytes = size;
        self
    }

    #[must_use]
    pub fn max_concurrent_requests(mut self, limit: usize) -> Self {
        self.options.max_concurrent_requests = limit;
        self
    }

    #[must_use]
    pub fn max_cooldown_wait(mut self, duration: Duration) -> Self {
        self.options.max_cooldown_wait = duration;
        self
    }

    pub fn build(self) -> Result<GeminiClient> {
        validate_options(&self.options)?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .https_only(!self.options.allow_loopback_http)
            .user_agent(concat!("osg-gemini/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| Error::Transport(transport_kind(&error)))?;
        let concurrency = self.options.max_concurrent_requests;
        Ok(GeminiClient {
            inner: Arc::new(Inner {
                http,
                api_key: self.api_key,
                options: self.options,
                semaphore: Arc::new(Semaphore::new(concurrency)),
                cooldowns: Mutex::new(HashMap::new()),
            }),
        })
    }
}

pub(crate) struct Inner {
    pub(crate) http: reqwest::Client,
    pub(crate) api_key: ApiKey,
    pub(crate) options: ClientOptions,
    pub(crate) semaphore: Arc<Semaphore>,
    pub(crate) cooldowns: Mutex<HashMap<Model, Instant>>,
}

/// Cloneable, backend-only asynchronous Gemini REST client.
#[derive(Clone)]
pub struct GeminiClient {
    pub(crate) inner: Arc<Inner>,
}

impl fmt::Debug for GeminiClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiClient")
            .field("api_base", &self.inner.options.api_base)
            .field("api_key", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl GeminiClient {
    #[must_use]
    pub fn builder(api_key: ApiKey) -> GeminiClientBuilder {
        GeminiClientBuilder::new(api_key)
    }

    pub fn new(api_key: ApiKey) -> Result<Self> {
        Self::builder(api_key).build()
    }

    /// Sends one bounded `generateContent` request. Dropping this future or
    /// cancelling the supplied token stops in-flight I/O, cooldown waits, and
    /// retry sleeps.
    pub async fn generate(
        &self,
        request: GenerateRequest,
        cancel: &CancellationToken,
    ) -> Result<GenerateResponse> {
        validate_generate_request(&request)?;
        self.wait_for_cooldown(request.model, cancel).await?;
        let _permit = self.acquire(cancel).await?;

        let payload = build_generate_payload(&request);
        let payload =
            Arc::new(serde_json::to_vec(&payload).map_err(|_| {
                Error::InvalidRequest("failed to encode Gemini request".to_owned())
            })?);
        if payload.len() > self.inner.options.max_inline_request_bytes {
            return Err(Error::InlineRequestTooLarge {
                actual_bytes: payload.len(),
                limit_bytes: self.inner.options.max_inline_request_bytes,
            });
        }

        let endpoint = self.endpoint(&format!(
            "v1beta/models/{}:generateContent",
            request.model.api_id()
        ))?;
        let body = self
            .send_with_retry(
                "generation",
                self.inner.options.request_timeout,
                self.inner.options.max_response_bytes,
                Some(request.model),
                cancel,
                || {
                    self.authenticated(self.inner.http.post(endpoint.clone()))
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(Arc::clone(&payload).as_ref().clone())
                },
            )
            .await?
            .body;
        self.inner.cooldowns.lock().await.remove(&request.model);
        serde_json::from_slice(&body).map_err(|_| Error::Transport(crate::TransportKind::Decode))
    }

    pub(crate) fn endpoint(&self, path: &str) -> Result<Url> {
        self.inner
            .options
            .api_base
            .join(path)
            .map_err(|_| Error::InvalidConfig("invalid Gemini endpoint path".to_owned()))
    }

    pub(crate) fn authenticated(
        &self,
        builder: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        builder.header("x-goog-api-key", self.inner.api_key.expose())
    }

    pub(crate) async fn acquire(&self, cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
        tokio::select! {
            () = cancel.cancelled() => Err(Error::Cancelled),
            permit = Arc::clone(&self.inner.semaphore).acquire_owned() => {
                permit.map_err(|_| Error::InvalidConfig("Gemini client is closed".to_owned()))
            }
        }
    }

    pub(crate) async fn send_with_retry<F>(
        &self,
        operation: &'static str,
        timeout: Duration,
        success_body_limit: usize,
        model: Option<Model>,
        cancel: &CancellationToken,
        build: F,
    ) -> Result<ResponseData>
    where
        F: Fn() -> reqwest::RequestBuilder,
    {
        let mut retry_index = 0;
        loop {
            let result = self
                .send_once(operation, timeout, success_body_limit, cancel, build())
                .await;
            match result {
                Ok(response) => return Ok(response),
                Err(error) => {
                    if let (Some(model), Error::Provider(provider)) = (model, &error)
                        && provider.http_status == StatusCode::TOO_MANY_REQUESTS.as_u16()
                    {
                        self.note_cooldown(model, provider.retry_after).await;
                    }
                    if !error.is_retryable() || retry_index >= self.inner.options.retry.max_retries
                    {
                        return Err(error);
                    }
                    let server_delay = match &error {
                        Error::Provider(provider) => provider.retry_after,
                        _ => None,
                    };
                    if server_delay.is_some_and(|delay| delay > self.inner.options.retry.max_delay)
                    {
                        return Err(error);
                    }
                    let delay = retry_delay(&self.inner.options.retry, retry_index, server_delay);
                    cancellable_sleep(delay, cancel).await?;
                    retry_index += 1;
                }
            }
        }
    }

    pub(crate) async fn send_once(
        &self,
        operation: &'static str,
        timeout: Duration,
        success_body_limit: usize,
        cancel: &CancellationToken,
        builder: reqwest::RequestBuilder,
    ) -> Result<ResponseData> {
        let action = async {
            let response = builder
                .send()
                .await
                .map_err(|error| Error::Transport(transport_kind(&error)))?;
            let status = response.status();
            let headers = response.headers().clone();
            let limit = if status.is_success() {
                success_body_limit
            } else {
                self.inner.options.max_error_bytes
            };
            let (body, truncated) = read_bounded(response, limit).await?;
            if status.is_success() {
                if truncated {
                    return Err(Error::ResponseTooLarge { limit_bytes: limit });
                }
                Ok(ResponseData { headers, body })
            } else {
                let mut provider = parse_provider_error(
                    status,
                    &headers,
                    &body,
                    self.inner.options.max_server_retry_after,
                );
                let api_key = self.inner.api_key.expose();
                if api_key.len() >= 8 && provider.message.contains(api_key) {
                    provider.message = provider.message.replace(api_key, "[REDACTED]");
                }
                Err(Error::Provider(provider))
            }
        };

        tokio::select! {
            () = cancel.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(timeout, action) => {
                result.unwrap_or(Err(Error::Timeout { operation, timeout }))
            }
        }
    }

    pub(crate) async fn wait_for_cooldown(
        &self,
        model: Model,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let remaining = {
            let mut cooldowns = self.inner.cooldowns.lock().await;
            match cooldowns.get(&model).copied() {
                Some(until) if until > Instant::now() => until - Instant::now(),
                Some(_) => {
                    cooldowns.remove(&model);
                    Duration::ZERO
                }
                None => Duration::ZERO,
            }
        };
        if remaining.is_zero() {
            return Ok(());
        }
        if remaining > self.inner.options.max_cooldown_wait {
            return Err(Error::CooldownActive {
                retry_after: remaining,
            });
        }
        cancellable_sleep(remaining, cancel).await
    }

    pub(crate) async fn note_cooldown(&self, model: Model, requested: Option<Duration>) {
        let duration = requested
            .unwrap_or(self.inner.options.default_rate_limit_cooldown)
            .min(self.inner.options.max_server_retry_after);
        self.inner
            .cooldowns
            .lock()
            .await
            .insert(model, Instant::now() + duration);
    }
}

pub(crate) struct ResponseData {
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireGenerateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<WireContent>,
    contents: Vec<WireContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<WireGenerationConfig>,
}

#[derive(Serialize)]
struct WireContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'static str>,
    parts: Vec<WirePart>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum WirePart {
    Text {
        text: String,
    },
    InlineData {
        #[serde(rename = "inlineData")]
        inline_data: WireInlineData,
    },
    FileData {
        #[serde(rename = "fileData")]
        file_data: WireFileData,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireInlineData {
    mime_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireFileData {
    mime_type: String,
    file_uri: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_config: Option<WireThinkingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_resolution: Option<crate::MediaResolution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_mime_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_json_schema: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireThinkingConfig {
    thinking_level: crate::ThinkingLevel,
}

fn build_generate_payload(request: &GenerateRequest) -> WireGenerateRequest {
    let mut parts = Vec::with_capacity(request.media.len().saturating_add(1));
    for media in &request.media {
        match media {
            MediaInput::Inline(media) => parts.push(WirePart::InlineData {
                inline_data: WireInlineData {
                    mime_type: media.mime_type().to_owned(),
                    data: BASE64_STANDARD.encode(media.bytes()),
                },
            }),
            MediaInput::Uploaded(media) => parts.push(WirePart::FileData {
                file_data: WireFileData {
                    mime_type: media.mime_type().to_owned(),
                    file_uri: media.uri().as_str().to_owned(),
                },
            }),
        }
    }
    parts.push(WirePart::Text {
        text: request.prompt.clone(),
    });

    let schema = request.generation.response_json_schema.clone();
    let has_generation = request.generation.max_output_tokens.is_some()
        || request.generation.thinking_level.is_some()
        || request.generation.media_resolution.is_some()
        || schema.is_some();
    WireGenerateRequest {
        system_instruction: request
            .system_instruction
            .as_ref()
            .map(|instruction| WireContent {
                role: None,
                parts: vec![WirePart::Text {
                    text: instruction.clone(),
                }],
            }),
        contents: vec![WireContent {
            role: Some("user"),
            parts,
        }],
        generation_config: has_generation.then_some(WireGenerationConfig {
            max_output_tokens: request.generation.max_output_tokens,
            thinking_config: request
                .generation
                .thinking_level
                .map(|thinking_level| WireThinkingConfig { thinking_level }),
            media_resolution: request.generation.media_resolution,
            response_mime_type: schema.as_ref().map(|_| "application/json"),
            response_json_schema: schema,
        }),
    }
}

pub(crate) fn encode_generate_request(request: &GenerateRequest) -> Result<Vec<u8>> {
    serde_json::to_vec(&build_generate_payload(request))
        .map_err(|_| Error::InvalidRequest("failed to encode Gemini request".to_owned()))
}

pub(crate) fn validate_generate_request(request: &GenerateRequest) -> Result<()> {
    let prompt_chars = request.prompt.chars().count();
    if request.prompt.trim().is_empty() || prompt_chars > 1_048_576 {
        return Err(Error::InvalidRequest(
            "prompt must contain 1 to 1,048,576 characters".to_owned(),
        ));
    }
    if request
        .system_instruction
        .as_ref()
        .is_some_and(|value| value.chars().count() > 1_048_576)
    {
        return Err(Error::InvalidRequest(
            "system instruction exceeds 1,048,576 characters".to_owned(),
        ));
    }
    if request.media.len() > 10 {
        return Err(Error::InvalidRequest(
            "Gemini supports at most 10 media files per request".to_owned(),
        ));
    }
    for media in &request.media {
        if let MediaInput::Uploaded(file) = media
            && file.state() != crate::FileState::Active
        {
            return Err(Error::InvalidRequest(
                "uploaded Gemini file is not ACTIVE".to_owned(),
            ));
        }
    }
    request.generation.validate(request.model)
}

pub(crate) async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
) -> Result<(Vec<u8>, bool)> {
    if response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .is_some_and(|length| length > limit)
    {
        return Ok((Vec::new(), true));
    }
    let mut body = Vec::with_capacity(limit.min(64 * 1024));
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| Error::Transport(transport_kind(&error)))?;
        let remaining = limit.saturating_sub(body.len());
        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

pub(crate) async fn cancellable_sleep(
    duration: Duration,
    cancel: &CancellationToken,
) -> Result<()> {
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        () = tokio::time::sleep(duration) => Ok(()),
    }
}

fn validate_api_base(api_base: &Url) -> Result<()> {
    if api_base.cannot_be_a_base()
        || api_base.username() != ""
        || api_base.password().is_some()
        || api_base.query().is_some()
        || api_base.fragment().is_some()
    {
        return Err(Error::InvalidConfig(
            "unsafe Gemini API base URL".to_owned(),
        ));
    }
    let secure = api_base.scheme() == "https";
    let loopback = api_base.scheme() == "http" && api_base.host_str().is_some_and(is_loopback_host);
    if !secure && !loopback {
        return Err(Error::InvalidConfig(
            "Gemini API base must be HTTPS or loopback HTTP".to_owned(),
        ));
    }
    Ok(())
}

fn validate_options(options: &ClientOptions) -> Result<()> {
    validate_api_base(&options.api_base)?;
    options.retry.validate()?;
    if options.request_timeout.is_zero()
        || options.upload_request_timeout.is_zero()
        || options.processing_timeout.is_zero()
        || options.poll_interval.is_zero()
        || options.max_inline_request_bytes == 0
        || options.max_inline_request_bytes > DEFAULT_MAX_INLINE_REQUEST_BYTES
        || options.max_upload_bytes == 0
        || options.max_upload_bytes > 20_000_000_000
        || !(256 * 1024..=16 * 1024 * 1024).contains(&options.upload_chunk_bytes)
        || options.max_concurrent_requests == 0
        || options.max_concurrent_requests > 64
    {
        return Err(Error::InvalidConfig("client bounds are invalid".to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[test]
    fn wire_payload_uses_toolbox_thinking_and_structured_output() {
        let request = GenerateRequest {
            model: Model::Gemini35FlashLite,
            prompt: "transcribe".to_owned(),
            system_instruction: None,
            media: vec![MediaInput::Inline(
                crate::InlineMedia::new("audio/mpeg", Bytes::from_static(b"audio")).unwrap(),
            )],
            generation: crate::GenerationConfig {
                thinking_level: Some(crate::ThinkingLevel::Minimal),
                response_json_schema: Some(serde_json::json!({"type": "array"})),
                ..crate::GenerationConfig::default()
            },
        };
        let value = serde_json::to_value(build_generate_payload(&request)).unwrap();
        assert_eq!(
            value["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "MINIMAL"
        );
        assert_eq!(
            value["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            value["contents"][0]["parts"][0]["inlineData"]["mimeType"],
            "audio/mpeg"
        );
        assert!(value.get("temperature").is_none());
    }

    #[test]
    fn endpoint_rejects_plaintext_remote_origins() {
        let key = ApiKey::new("secret").unwrap();
        let remote = Url::parse("http://example.com/").unwrap();
        assert!(GeminiClient::builder(key).api_base(remote).is_err());
    }
}
