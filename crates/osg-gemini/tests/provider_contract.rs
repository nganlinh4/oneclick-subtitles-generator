use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use bytes::Bytes;
use futures_util::StreamExt;
use osg_gemini::{
    ApiKey, AudioTranscriptionConfig, CancellationToken, Error, FileState, GeminiClient,
    GenerateRequest, GenerationConfig, ImageAspectRatio, ImageGenerateRequest, ImageModel,
    ImageSize, InlineMedia, MediaInput, Model, ReferenceImage, RetryPolicy, ThinkingLevel,
    TranscribeRequest, TranscriptionStreamCompletion, UploadRequest,
};
use serde_json::{Value, json};
use tempfile::NamedTempFile;
use url::Url;
use wiremock::{
    Mock, MockServer, Request, Respond, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(5),
        jitter_percent: 0,
    }
}

fn request() -> GenerateRequest {
    GenerateRequest {
        model: Model::Gemini35FlashLite,
        prompt: "Transcribe with timestamps".to_owned(),
        system_instruction: Some("Return only the requested result".to_owned()),
        media: vec![MediaInput::Inline(
            InlineMedia::new("audio/mpeg", Bytes::from_static(b"mock audio")).unwrap(),
        )],
        generation: GenerationConfig {
            thinking_level: Some(ThinkingLevel::Minimal),
            response_json_schema: Some(json!({
                "type": "array",
                "items": {"type": "object"}
            })),
            ..GenerationConfig::default()
        },
    }
}

fn client(server: &MockServer) -> GeminiClient {
    GeminiClient::builder(ApiKey::new("contract-test-secret").unwrap())
        .api_base(Url::parse(&format!("{}/", server.uri())).unwrap())
        .unwrap()
        .retry_policy(fast_retry())
        .poll_interval(Duration::from_millis(1))
        .request_timeout(Duration::from_secs(2))
        .upload_request_timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

#[tokio::test]
async fn generate_uses_header_auth_exact_media_wire_shape_and_typed_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-flash-lite:generateContent"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{
                "content": {"role": "model", "parts": [
                    {"text": "private reasoning", "thought": true},
                    {"text": "[{\"start\":0,\"text\":\"hello\"}]"}
                ]},
                "finishReason": "STOP",
                "index": 0
            }],
            "usageMetadata": {"promptTokenCount": 10, "totalTokenCount": 15},
            "modelVersion": "gemini-3.5-flash-lite"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let response = client(&server)
        .generate(request(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        response.required_text().unwrap(),
        r#"[{"start":0,"text":"hello"}]"#
    );
    assert_eq!(response.usage_metadata.unwrap().total_token_count, Some(15));

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].url.query().is_none());
    assert!(!requests[0].url.as_str().contains("contract-test-secret"));
    let body: Value = requests[0].body_json().unwrap();
    assert_eq!(
        body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "MINIMAL"
    );
    assert_eq!(
        body["generationConfig"]["responseMimeType"],
        "application/json"
    );
    assert_eq!(
        body["contents"][0]["parts"][0]["inlineData"]["mimeType"],
        "audio/mpeg"
    );
    assert_eq!(
        body["contents"][0]["parts"][0]["inlineData"]["data"],
        "bW9jayBhdWRpbw=="
    );
    assert!(body["generationConfig"].get("temperature").is_none());
    assert!(body["generationConfig"].get("topP").is_none());
    assert!(body["generationConfig"].get("topK").is_none());
}

#[tokio::test]
async fn image_generation_uses_stable_video_capable_model_and_bounded_binary_output() {
    let server = MockServer::start().await;
    let png = b"\x89PNG\r\n\x1a\ngenerated";
    Mock::given(method("POST"))
        .and(path("/v1/models/gemini-3.1-flash-image:generateContent"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{"content": {"parts": [{
                "inlineData": {
                    "mimeType": "image/png",
                    "data": "iVBORw0KGgpnZW5lcmF0ZWQ="
                }
            }]}}]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let request = ImageGenerateRequest {
        model: ImageModel::Gemini31FlashImage,
        prompt: "Expand this cover into a cinematic landscape".to_owned(),
        reference: ReferenceImage::new("image/png", Bytes::from_static(b"\x89PNG\r\n\x1a\ncover"))
            .unwrap(),
        aspect_ratio: ImageAspectRatio::Landscape16By9,
        image_size: ImageSize::OneK,
    };
    let image = client(&server)
        .generate_image(request, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(image.mime_type(), "image/png");
    assert_eq!(image.bytes().as_ref(), png);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].url.query().is_none());
    assert!(!requests[0].url.as_str().contains("contract-test-secret"));
    let body: Value = requests[0].body_json().unwrap();
    assert_eq!(body["generationConfig"]["responseModalities"][0], "IMAGE");
    assert_eq!(
        body["generationConfig"]["responseFormat"]["image"]["aspectRatio"],
        "ASPECT_RATIO_SIXTEEN_BY_NINE"
    );
    assert_eq!(
        body["generationConfig"]["responseFormat"]["image"]["imageSize"],
        "IMAGE_SIZE_ONE_K"
    );
}

#[tokio::test]
async fn streaming_generation_uses_sse_header_auth_and_yields_each_chunk_once() {
    let server = MockServer::start().await;
    let body = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"first\"}]}}]}\r\n\r\n",
        ": heartbeat\r\n",
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"second\"}]}}]}\r\n\r\n",
        "data: [DONE]\r\n\r\n"
    );
    Mock::given(method("POST"))
        .and(path(
            "/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent",
        ))
        .and(query_param("alt", "sse"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .and(header("accept", "text/event-stream"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
        .expect(1)
        .mount(&server)
        .await;

    let mut stream = client(&server)
        .generate_stream(request(), &CancellationToken::new())
        .await
        .unwrap();
    let mut text = Vec::new();
    while let Some(response) = stream.next().await {
        text.push(response.unwrap().required_text().unwrap());
    }
    assert_eq!(text, ["first".to_owned(), "second".to_owned()]);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url.query(), Some("alt=sse"));
    assert!(!requests[0].url.as_str().contains("contract-test-secret"));
}

#[tokio::test]
async fn streaming_generation_rejects_a_non_sse_success_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(
            "/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{"content": {"parts": [{"text": "not SSE"}]}}]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = client(&server)
        .generate_stream(request(), &CancellationToken::new())
        .await;
    let Err(error) = result else {
        panic!("a JSON response must not be accepted as SSE");
    };
    assert!(matches!(error, Error::Transport(_)));
}

#[derive(Clone)]
struct FailThenSucceed {
    calls: Arc<AtomicUsize>,
}

impl Respond for FailThenSucceed {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            ResponseTemplate::new(503).set_body_json(json!({
                "error": {"code": 503, "status": "UNAVAILABLE", "message": "overloaded"}
            }))
        } else {
            ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{"content": {"parts": [{"text": "ok"}]}}]
            }))
        }
    }
}

#[tokio::test]
async fn transient_503_is_retried_with_a_fresh_request() {
    let server = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-flash-lite:generateContent"))
        .respond_with(FailThenSucceed {
            calls: Arc::clone(&calls),
        })
        .expect(2)
        .mount(&server)
        .await;

    let response = client(&server)
        .generate(request(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(response.text().as_deref(), Some("ok"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn long_quota_retry_sets_fail_fast_model_cooldown() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-flash-lite:generateContent"))
        .respond_with(ResponseTemplate::new(429).set_body_json(json!({
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "message": "quota exhausted",
                "details": [{
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": "120s"
                }]
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = client(&server);
    let first = client
        .generate(request(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(first, Error::Provider(_)));
    let second = client
        .generate(request(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(second, Error::CooldownActive { .. }));
}

#[tokio::test]
async fn cancellation_interrupts_retry_backoff() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-flash-lite:generateContent"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({
            "error": {"status": "UNAVAILABLE", "message": "overloaded"}
        })))
        .mount(&server)
        .await;
    let policy = RetryPolicy {
        max_retries: 4,
        initial_delay: Duration::from_secs(30),
        max_delay: Duration::from_mins(1),
        jitter_percent: 0,
    };
    let client = GeminiClient::builder(ApiKey::new("contract-test-secret").unwrap())
        .api_base(Url::parse(&format!("{}/", server.uri())).unwrap())
        .unwrap()
        .retry_policy(policy)
        .build()
        .unwrap();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        trigger.cancel();
    });

    let started = tokio::time::Instant::now();
    let error = client.generate(request(), &cancel).await.unwrap_err();
    assert!(matches!(error, Error::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[derive(Clone)]
struct ProcessingThenActive {
    calls: Arc<AtomicUsize>,
    file_uri: String,
}

impl Respond for ProcessingThenActive {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let state = if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            "PROCESSING"
        } else {
            "ACTIVE"
        };
        ResponseTemplate::new(200).set_body_json(json!({
            "name": "files/abc-123",
            "uri": self.file_uri,
            "mimeType": "video/mp4",
            "sizeBytes": "5",
            "state": state,
            "expirationTime": "2026-08-12T00:00:00Z"
        }))
    }
}

#[tokio::test]
async fn resumable_upload_is_bounded_uses_capability_url_and_polls_active() {
    let server = MockServer::start().await;
    let upload_url = format!("{}/upload-session/opaque", server.uri());
    let file_uri = format!("{}/provider-file/opaque", server.uri());

    Mock::given(method("POST"))
        .and(path("/upload/v1beta/files"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .and(header("x-goog-upload-protocol", "resumable"))
        .and(header("x-goog-upload-command", "start"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-goog-upload-url", upload_url.as_str())
                .insert_header("x-goog-upload-chunk-granularity", "262144"),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/upload-session/opaque"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "file": {
                "name": "files/abc-123",
                "uri": file_uri,
                "mimeType": "video/mp4",
                "sizeBytes": "5",
                "state": "PROCESSING",
                "expirationTime": "2026-08-12T00:00:00Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let polling_calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("GET"))
        .and(path("/v1beta/files/abc-123"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .respond_with(ProcessingThenActive {
            calls: Arc::clone(&polling_calls),
            file_uri: format!("{}/provider-file/opaque", server.uri()),
        })
        .expect(2)
        .mount(&server)
        .await;

    let mut temp = NamedTempFile::new().unwrap();
    std::io::Write::write_all(&mut temp, b"video").unwrap();
    let request = UploadRequest::new(temp.path(), "video/mp4")
        .unwrap()
        .with_display_name("clip.mp4")
        .unwrap();
    let uploaded = client(&server)
        .upload_and_wait(request, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(uploaded.state(), FileState::Active);
    assert_eq!(uploaded.size_bytes(), 5);
    assert_eq!(polling_calls.load(Ordering::SeqCst), 2);

    let requests = server.received_requests().await.unwrap();
    let chunk = requests
        .iter()
        .find(|request| request.url.path() == "/upload-session/opaque")
        .unwrap();
    assert_eq!(chunk.body, b"video");
    assert!(chunk.headers.get("x-goog-api-key").is_none());
    assert_eq!(
        chunk
            .headers
            .get("x-goog-upload-command")
            .unwrap()
            .to_str()
            .unwrap(),
        "upload, finalize"
    );
    assert_eq!(
        chunk
            .headers
            .get("x-goog-upload-offset")
            .unwrap()
            .to_str()
            .unwrap(),
        "0"
    );
}

#[tokio::test]
async fn local_size_limits_reject_before_network_io() {
    let server = MockServer::start().await;
    let client = GeminiClient::builder(ApiKey::new("contract-test-secret").unwrap())
        .api_base(Url::parse(&format!("{}/", server.uri())).unwrap())
        .unwrap()
        .max_inline_request_bytes(32)
        .max_upload_bytes(4)
        .build()
        .unwrap();
    let inline_error = client
        .generate(request(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(inline_error, Error::InlineRequestTooLarge { .. }));

    let mut temp = NamedTempFile::new().unwrap();
    std::io::Write::write_all(&mut temp, b"video").unwrap();
    let upload_error = client
        .upload_file(
            UploadRequest::new(temp.path(), "video/mp4").unwrap(),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(upload_error, Error::UploadTooLarge { .. }));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn transcribe_wire_shape_strict_separation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{
                        "text": "Hello world",
                        "audioTranscription": {
                            "text": "Hello world",
                            "words": [
                                {
                                    "word": "Hello",
                                    "startOffset": "0.120s",
                                    "endOffset": "0.450s",
                                    "speakerLabel": "1"
                                },
                                {
                                    "word": "world",
                                    "startOffset": "0.500s",
                                    "endOffset": "0.900s",
                                    "speakerLabel": "1"
                                }
                            ]
                        }
                    }]
                },
                "finishReason": "STOP",
                "index": 0
            }],
            "usageMetadata": {"promptTokenCount": 50, "totalTokenCount": 50},
            "modelVersion": "gemini-3.5-transcribe"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let media = MediaInput::Inline(
        InlineMedia::new("audio/wav", Bytes::from_static(b"RIFF....WAVEfmt ")).unwrap(),
    );
    let req = TranscribeRequest::new(media).with_config(
        AudioTranscriptionConfig::new()
            .with_diarization(true)
            .with_language_hints(["en", "vi"]),
    );

    let client = client(&server);
    let response = client
        .transcribe(req, &CancellationToken::new())
        .await
        .unwrap();

    let words = response.transcription_words();
    assert_eq!(words.len(), 2);
    assert_eq!(words[0].word, "Hello");
    assert_eq!(words[0].start_offset, "0.120s");
    assert_eq!(words[0].end_offset, "0.450s");
    assert_eq!(words[0].speaker_label, Some("1".to_owned()));
    assert_eq!(words[1].word, "world");
    assert_eq!(words[1].start_offset, "0.500s");
    assert_eq!(words[1].end_offset, "0.900s");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body: Value = requests[0].body_json().unwrap();

    // Verify wire shape & strict provider separation
    let parts = body["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["inlineData"]["mimeType"], "audio/wav");
    assert!(parts[0]["text"].is_null());

    let gen_config = &body["generationConfig"];
    assert_eq!(gen_config["maxOutputTokens"], 32_768);
    let asr_config = &gen_config["audioTranscriptionConfig"];
    assert_eq!(asr_config["wordTimestamp"], true);
    assert_eq!(asr_config["diarization"], true);
    assert_eq!(asr_config["languageCodes"], json!(["en", "vi"]));
    assert!(
        asr_config["languageHints"].is_null(),
        "obsolete languageHints must not be emitted"
    );

    // Strict separation: forbidden text generation fields
    assert!(gen_config["thinkingConfig"].is_null());
    assert!(gen_config["responseJsonSchema"].is_null());
    assert!(gen_config["responseMimeType"].is_null());
    assert!(gen_config["mediaResolution"].is_null());
    assert!(body["systemInstruction"].is_null());
}

#[tokio::test]
async fn transcribe_streaming_sse_words_deserialization() {
    let server = MockServer::start().await;
    let sse_body = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"audioTranscription\":{\"words\":[{\"word\":\"Hello\",\"startOffset\":\"0.100s\",\"endOffset\":\"0.400s\",\"speakerLabel\":\"0\"}]}}]}}]}\n\n",
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"audioTranscription\":{\"words\":[{\"word\":\"world\",\"startOffset\":\"0.450s\",\"endOffset\":\"0.800s\",\"speakerLabel\":\"0\"}]}}]},\"finishReason\":\"STOP\"}]}\n\n",
    );

    Mock::given(method("POST"))
        .and(path(
            "/v1beta/models/gemini-3.5-transcribe:streamGenerateContent",
        ))
        .and(query_param("alt", "sse"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse_body, "text/event-stream"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let media =
        MediaInput::Inline(InlineMedia::new("audio/wav", Bytes::from_static(b"wavdata")).unwrap());
    let req = TranscribeRequest::new(media);
    let client = client(&server);

    let mut stream = client
        .transcribe_stream(req, &CancellationToken::new())
        .await
        .unwrap();

    let mut completion = TranscriptionStreamCompletion::default();
    let mut all_words = Vec::new();

    while let Some(chunk) = stream.next().await {
        let resp = chunk.unwrap();
        completion.observe(&resp).unwrap();
        all_words.extend(resp.transcription_words());
    }

    let total = completion.finish().unwrap();
    assert_eq!(total, 2);
    assert_eq!(all_words.len(), 2);
    assert_eq!(all_words[0].word, "Hello");
    assert_eq!(all_words[1].word, "world");
}

#[tokio::test]
async fn transcribe_quota_429_fail_fast_cooldown() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "120")
                .set_body_json(json!({
                    "error": {
                        "code": 429,
                        "message": "Resource exhausted",
                        "status": "RESOURCE_EXHAUSTED"
                    }
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = client(&server);
    let media =
        MediaInput::Inline(InlineMedia::new("audio/wav", Bytes::from_static(b"wavdata")).unwrap());
    let req = TranscribeRequest::new(media);

    let err1 = client
        .transcribe(req.clone(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(err1, Error::Provider(_)));

    // Second call fails fast with CooldownActive without hitting server
    let err2 = client
        .transcribe(req, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(err2, Error::CooldownActive { .. }));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}
