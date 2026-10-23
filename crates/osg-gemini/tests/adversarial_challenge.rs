//! Adversarial Gemini provider tests: duration parsing and overshoot policy live in
//! `duration_policy`; this root holds the mock quota, retry, and redaction challenges.

#[path = "adversarial_challenge/duration_policy.rs"]
mod duration_policy;

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use osg_gemini::{
    ApiKey, AudioTranscriptionConfig, CancellationToken, Error, GeminiClient, InlineMedia,
    MediaInput, RetryPolicy, TranscribeRequest,
};
use serde_json::json;
use url::Url;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

fn challenge_client(server: &MockServer, retry: RetryPolicy) -> GeminiClient {
    GeminiClient::builder(ApiKey::new("adversarial-secret-key-12345").unwrap())
        .api_base(Url::parse(&format!("{}/", server.uri())).unwrap())
        .unwrap()
        .retry_policy(retry)
        .poll_interval(Duration::from_millis(1))
        .request_timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

fn mock_transcribe_request() -> TranscribeRequest {
    let media = MediaInput::Inline(
        InlineMedia::new("audio/wav", Bytes::from_static(b"RIFF....WAVEfmt ")).unwrap(),
    );
    TranscribeRequest::new(media).with_config(
        AudioTranscriptionConfig::new()
            .with_diarization(true)
            .with_language_hints(["en"]),
    )
}

// =========================================================================
// SECTION 3: MOCK QUOTA REFUSAL AND RETRY BEHAVIORS
// =========================================================================

#[tokio::test]
async fn mock_quota_429_transient_retry_succeeds_and_clears_cooldown() {
    let server = MockServer::start().await;
    let hit_counter = Arc::new(AtomicUsize::new(0));
    let hit_clone = Arc::clone(&hit_counter);

    // Call 1: 429 with short Retry-After: 0.02s
    // Call 2: 200 OK with valid response
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(move |_: &wiremock::Request| {
            let n = hit_clone.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                ResponseTemplate::new(429)
                    .insert_header("retry-after", "0.02")
                    .set_body_json(json!({
                        "error": {
                            "code": 429,
                            "message": "Resource exhausted",
                            "status": "RESOURCE_EXHAUSTED"
                        }
                    }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "id": "v1_quota_recovered",
                    "model": "gemini-3.5-transcribe",
                    "status": "completed",
                    "steps": [{"type":"model_output","content":[{
                        "type":"text","text":"success_after_quota","annotations":[{
                            "type":"word_info","text":"success_after_quota",
                            "start_offset":"0.100s","end_offset":"0.500s"
                        }]
                    }]}],
                    "usage": {"total_input_tokens":20,"total_tokens":20}
                }))
            }
        })
        .expect(3)
        .mount(&server)
        .await;

    let retry = RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(5),
        max_delay: Duration::from_millis(100),
        jitter_percent: 0,
    };
    let client = challenge_client(&server, retry);
    let cancel = CancellationToken::new();

    let start = Instant::now();
    let resp = client
        .transcribe(mock_transcribe_request(), &cancel)
        .await
        .unwrap();
    let elapsed = start.elapsed();

    // Verify words recovered
    let words = resp.transcription_words();
    assert_eq!(words.len(), 1);
    assert_eq!(words[0].word, "success_after_quota");
    assert_eq!(hit_counter.load(Ordering::SeqCst), 2);
    // At least 20ms waited due to retry-after
    assert!(elapsed >= Duration::from_millis(20));

    // Verify cooldown was cleared upon 200 OK:
    // A follow-up request must NOT fail with CooldownActive
    let resp2 = client
        .transcribe(mock_transcribe_request(), &cancel)
        .await
        .unwrap();
    assert_eq!(resp2.transcription_words()[0].word, "success_after_quota");
}

#[tokio::test]
async fn mock_quota_429_large_retry_after_fails_fast_with_cooldown() {
    let server = MockServer::start().await;

    // 429 with retry-after = 120s (> max_delay)
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "120")
                .set_body_json(json!({
                    "error": {
                        "code": 429,
                        "message": "Resource exhausted, wait 120 seconds",
                        "status": "RESOURCE_EXHAUSTED"
                    }
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let retry = RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(5),
        max_delay: Duration::from_millis(100), // max_delay is 100ms, much smaller than 120s
        jitter_percent: 0,
    };
    let client = challenge_client(&server, retry);
    let cancel = CancellationToken::new();

    // First request should fail immediately with Provider error because server_delay > max_delay
    let start = Instant::now();
    let err1 = client
        .transcribe(mock_transcribe_request(), &cancel)
        .await
        .unwrap_err();
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "Must fail fast without waiting 120s"
    );
    assert!(matches!(err1, Error::Provider(_)));

    // Second request should fail immediately with CooldownActive without touching network
    let err2 = client
        .transcribe(mock_transcribe_request(), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err2, Error::CooldownActive { .. }));

    // Verify network only received 1 request
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
}

#[tokio::test]
async fn mock_quota_429_exhausts_max_retries() {
    let server = MockServer::start().await;

    // Always returns 429 with small retry-after: 0.005s
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "0.005")
                .set_body_json(json!({
                    "error": {
                        "code": 429,
                        "message": "Quota limit reached",
                        "status": "RESOURCE_EXHAUSTED"
                    }
                })),
        )
        .expect(3) // 1 initial + 2 retries
        .mount(&server)
        .await;

    let retry = RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(2),
        max_delay: Duration::from_millis(50),
        jitter_percent: 0,
    };
    let client = challenge_client(&server, retry);
    let cancel = CancellationToken::new();

    let err = client
        .transcribe(mock_transcribe_request(), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Provider(p) if p.http_status == 429));

    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 3);
}

#[tokio::test]
async fn mock_503_service_unavailable_transient_retry_succeeds() {
    let server = MockServer::start().await;
    let hit_counter = Arc::new(AtomicUsize::new(0));
    let hit_clone = Arc::clone(&hit_counter);

    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(move |_: &wiremock::Request| {
            let n = hit_clone.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                ResponseTemplate::new(503).set_body_raw("Service Unavailable", "text/plain")
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "id":"v1_recovered","model":"gemini-3.5-transcribe","status":"completed",
                    "steps":[{"type":"model_output","content":[{
                        "type":"text","text":"recovered","annotations":[{
                            "type":"word_info","text":"recovered",
                            "start_offset":"0.100s","end_offset":"0.300s"
                        }]
                    }]}],
                    "usage":{"total_input_tokens":10,"total_tokens":10}
                }))
            }
        })
        .expect(2)
        .mount(&server)
        .await;

    let retry = RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(5),
        max_delay: Duration::from_millis(50),
        jitter_percent: 0,
    };
    let client = challenge_client(&server, retry);
    let resp = client
        .transcribe(mock_transcribe_request(), &CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(resp.transcription_words()[0].word, "recovered");
    assert_eq!(hit_counter.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn mock_cancellation_aborts_quota_retry_sleep_promptly() {
    let server = MockServer::start().await;

    // Server returns 429 with 0.8s retry delay
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "0.80")
                .set_body_json(json!({
                    "error": {"code": 429, "message": "Rate limited"}
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let retry = RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(10),
        max_delay: Duration::from_secs(2),
        jitter_percent: 0,
    };
    let client = challenge_client(&server, retry);
    let cancel = CancellationToken::new();

    let cancel_trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel_trigger.cancel();
    });

    let start = Instant::now();
    let err = client
        .transcribe(mock_transcribe_request(), &cancel)
        .await
        .unwrap_err();
    let elapsed = start.elapsed();

    assert!(matches!(err, Error::Cancelled));
    assert!(
        elapsed < Duration::from_millis(500),
        "Cancellation must abort retry sleep in < 500ms, elapsed: {elapsed:?}"
    );
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
}

#[tokio::test]
async fn mock_transcribe_stream_429_quota_refusal_sets_cooldown() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "90")
                .set_body_json(json!({
                    "error": {
                        "code": 429,
                        "message": "Stream quota exceeded",
                        "status": "RESOURCE_EXHAUSTED"
                    }
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let retry = RetryPolicy {
        max_retries: 2,
        initial_delay: Duration::from_millis(5),
        max_delay: Duration::from_millis(100),
        jitter_percent: 0,
    };
    let client = challenge_client(&server, retry);
    let cancel = CancellationToken::new();

    // First call should fail with Provider error
    let res1 = client
        .transcribe_stream(mock_transcribe_request(), &cancel)
        .await;
    match res1 {
        Err(Error::Provider(_)) => {}
        other => panic!(
            "Expected Err(Error::Provider), got is_ok: {}",
            other.is_ok()
        ),
    }

    // Second call should fail fast with CooldownActive without network request
    let res2 = client
        .transcribe_stream(mock_transcribe_request(), &cancel)
        .await;
    match res2 {
        Err(Error::CooldownActive { .. }) => {}
        other => panic!(
            "Expected Err(Error::CooldownActive), got is_ok: {}",
            other.is_ok()
        ),
    }

    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
}

#[tokio::test]
async fn mock_api_key_redaction_in_provider_error() {
    let server = MockServer::start().await;
    let secret_key = "adversarial-secret-key-12345";

    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "error": {
                "code": 403,
                "message": format!("The provided API key '{secret_key}' is forbidden"),
                "status": "PERMISSION_DENIED"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = challenge_client(&server, RetryPolicy::default());
    let err = client
        .transcribe(mock_transcribe_request(), &CancellationToken::new())
        .await
        .unwrap_err();

    if let Error::Provider(p) = err {
        assert!(
            !p.message.contains(secret_key),
            "API key leaked in provider error message: {}",
            p.message
        );
        assert!(
            p.message.contains("[REDACTED]"),
            "Expected [REDACTED] in error message: {}",
            p.message
        );
    } else {
        panic!("Expected Error::Provider, got {err:?}");
    }
}
