use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use osg_gemini::{
    ApiKey, AudioTranscriptionConfig, CancellationToken, Error, GeminiClient, InlineMedia,
    MediaInput, RetryPolicy, TranscribeRequest, TranscriptionWord,
    WordProjectionStatus, parse_duration, parse_duration_ms, parse_duration_nanos,
    project_word_with_100ms_overshoot_policy,
};
use serde_json::json;
use url::Url;
use wiremock::{
    matchers::{method, path, query_param},
    Mock, MockServer, ResponseTemplate,
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
// SECTION 1: LOSSLESS INTEGER NANOSECOND DURATION PARSER STRESS TESTS
// =========================================================================

#[test]
fn duration_nanos_zeros_and_subsecond_boundaries() {
    // Exact zero representations
    assert_eq!(parse_duration_nanos("0s").unwrap(), 0);
    assert_eq!(parse_duration_nanos("0.0s").unwrap(), 0);
    assert_eq!(parse_duration_nanos("0.000000000s").unwrap(), 0);
    assert_eq!(parse_duration_nanos(".0s").unwrap(), 0);
    assert_eq!(parse_duration_nanos(".s").unwrap(), 0);
    assert_eq!(parse_duration_nanos("  0s  ").unwrap(), 0);
    assert_eq!(parse_duration_nanos("\t0.000s\n").unwrap(), 0);

    // Exact integer nanoseconds without floating point loss
    assert_eq!(parse_duration_nanos("0.000000001s").unwrap(), 1);
    assert_eq!(parse_duration_nanos("0.000000009s").unwrap(), 9);
    assert_eq!(parse_duration_nanos("0.000000010s").unwrap(), 10);
    assert_eq!(parse_duration_nanos("0.000000100s").unwrap(), 100);
    assert_eq!(parse_duration_nanos("0.000001000s").unwrap(), 1_000); // 1 us
    assert_eq!(parse_duration_nanos("0.000010000s").unwrap(), 10_000);
    assert_eq!(parse_duration_nanos("0.000100000s").unwrap(), 100_000);
    assert_eq!(parse_duration_nanos("0.001000000s").unwrap(), 1_000_000); // 1 ms
    assert_eq!(parse_duration_nanos("0.010000000s").unwrap(), 10_000_000);
    assert_eq!(parse_duration_nanos("0.100000000s").unwrap(), 100_000_000);
    assert_eq!(parse_duration_nanos("0.999999999s").unwrap(), 999_999_999);
    assert_eq!(parse_duration_nanos("1s").unwrap(), 1_000_000_000);
    assert_eq!(parse_duration_nanos("1.000000001s").unwrap(), 1_000_000_001);
}

#[test]
fn duration_nanos_padding_and_sub_nanosecond_truncation() {
    // Subsecond padding (1 to 8 digits padded to 9 digits with trailing zeros)
    assert_eq!(parse_duration_nanos("0.1s").unwrap(), 100_000_000);
    assert_eq!(parse_duration_nanos("0.12s").unwrap(), 120_000_000);
    assert_eq!(parse_duration_nanos("0.123s").unwrap(), 123_000_000);
    assert_eq!(parse_duration_nanos("0.1234s").unwrap(), 123_400_000);
    assert_eq!(parse_duration_nanos("0.12345s").unwrap(), 123_450_000);
    assert_eq!(parse_duration_nanos("0.123456s").unwrap(), 123_456_000);
    assert_eq!(parse_duration_nanos("0.1234567s").unwrap(), 123_456_700);
    assert_eq!(parse_duration_nanos("0.12345678s").unwrap(), 123_456_780);
    assert_eq!(parse_duration_nanos("0.123456789s").unwrap(), 123_456_789);

    // Truncation beyond 9 digits (sub-nanosecond precision truncated, not rounded)
    assert_eq!(parse_duration_nanos("0.1234567891s").unwrap(), 123_456_789);
    assert_eq!(parse_duration_nanos("0.1234567899s").unwrap(), 123_456_789);
    assert_eq!(
        parse_duration_nanos("0.12345678999999999999s").unwrap(),
        123_456_789
    );
    assert_eq!(parse_duration_nanos("0.000000000999s").unwrap(), 0);
}

#[test]
fn duration_nanos_extreme_values_and_u64_boundary() {
    // Large integer values
    assert_eq!(parse_duration_nanos("3600s").unwrap(), 3_600_000_000_000); // 1 hr
    assert_eq!(parse_duration_nanos("86400s").unwrap(), 86_400_000_000_000); // 1 day
    assert_eq!(
        parse_duration_nanos("31536000s").unwrap(),
        31_536_000_000_000_000
    ); // 1 yr

    // Maximum exact value that fits in u64:
    // u64::MAX = 18_446_744_073_709_551_615
    // 18_446_744_073 * 1_000_000_000 = 18_446_744_073_000_000_000
    // Remainder: 709_551_615 nanos
    let max_exact_str = "18446744073.709551615s";
    assert_eq!(parse_duration_nanos(max_exact_str).unwrap(), u64::MAX);

    // Overflow by 1 nanosecond: 709_551_616 nanos causes checked_add overflow
    assert!(parse_duration_nanos("18446744073.709551616s").is_err());

    // Seconds overflow: 18_446_744_074 * 1e9 overflows u64
    assert!(parse_duration_nanos("18446744074s").is_err());
    assert!(parse_duration_nanos("18446744074.0s").is_err());

    // Seconds parse overflow (greater than u64::MAX)
    assert!(parse_duration_nanos("18446744073709551616s").is_err());
    assert!(parse_duration_nanos("9999999999999999999999999999s").is_err());
}

#[test]
fn duration_nanos_malformed_inputs_strictly_rejected() {
    let malformed_cases = [
        "",                             // empty
        "   ",                          // whitespace only
        "s",                            // lone unit
        " s ",                          // lone unit with spaces
        ".",                            // lone dot
        "-0s",                          // negative zero
        "-1s",                          // negative integer
        "-0.5s",                        // negative decimal
        "+0s",                          // explicit plus zero
        "+1s",                          // explicit plus integer
        "+0.5s",                        // explicit plus decimal
        "123",                          // missing unit
        "123.456",                      // missing unit decimal
        "123ms",                        // wrong unit milliseconds
        "123us",                        // wrong unit microseconds
        "123ns",                        // wrong unit nanoseconds
        "123sec",                       // wrong unit sec
        "1.2.3s",                       // double decimal points
        "1..2s",                        // adjacent decimal points
        "..s",                          // only decimal points
        "1s2",                          // trailing characters after unit
        "1s extra",                     // trailing words
        "1s\0",                         // embedded null after unit
        "1\0s",                         // embedded null in digits
        "1a2s",                         // alphabetical character in seconds
        "1.2bs",                        // alphabetical character in fraction
        "1,2s",                         // comma decimal separator
        "1e5s",                         // scientific notation
        "1E-3s",                        // negative scientific notation
        "NaNs",                         // NaN string
        "Infs",                         // Infinity string
        "-Infs",                        // Negative infinity string
        "１２.３s",                     // fullwidth unicode numbers
        "١٢.٣s",                        // Arabic-Indic digits
        "1 2s",                         // space inside seconds
        "1. 2s",                        // space after decimal point
        "1 .2s",                        // space before decimal point
    ];

    for &input in &malformed_cases {
        assert!(
            parse_duration_nanos(input).is_err(),
            "Expected malformed input '{input}' to be rejected, but it was accepted!"
        );
    }
}

#[test]
fn duration_ms_and_std_duration_conversions() {
    assert_eq!(parse_duration_ms("0s").unwrap(), 0);
    assert_eq!(parse_duration_ms("0.000999999s").unwrap(), 0); // integer truncation
    assert_eq!(parse_duration_ms("0.001000000s").unwrap(), 1); // exactly 1ms
    assert_eq!(parse_duration_ms("0.001999999s").unwrap(), 1);
    assert_eq!(parse_duration_ms("0.002000000s").unwrap(), 2);
    assert_eq!(parse_duration_ms("59.999s").unwrap(), 59_999);
    assert_eq!(parse_duration_ms("60.000s").unwrap(), 60_000);
    assert_eq!(parse_duration_ms("60.100s").unwrap(), 60_100);

    // std::time::Duration conversion
    let d = parse_duration("1.234567890s").unwrap();
    assert_eq!(d.as_secs(), 1);
    assert_eq!(d.subsec_nanos(), 234_567_890);
}

// =========================================================================
// SECTION 2: 100MS PROVIDER END-OVERSHOOT CLAMP POLICY AT EXACT BOUNDARIES
// =========================================================================

#[test]
fn overshoot_policy_exact_boundaries_0_99_100_101_ms() {
    let media_dur = 60_000; // 60s media chunk

    // 1. 0ms overshoot (within bounds or exactly at boundary)
    let w_0ms_inside = TranscriptionWord {
        word: "inside".into(),
        start_offset: "59.000s".into(),
        end_offset: "59.800s".into(),
        speaker_label: Some("spk1".into()),
    };
    let p_inside = project_word_with_100ms_overshoot_policy(&w_0ms_inside, media_dur);
    assert_eq!(p_inside.status, WordProjectionStatus::Accepted);
    assert_eq!(p_inside.start_ms, 59_000);
    assert_eq!(p_inside.end_ms, 59_800);

    let w_0ms_boundary = TranscriptionWord {
        word: "boundary_exact".into(),
        start_offset: "59.000s".into(),
        end_offset: "60.000s".into(),
        speaker_label: None,
    };
    let p_0ms = project_word_with_100ms_overshoot_policy(&w_0ms_boundary, media_dur);
    assert_eq!(p_0ms.status, WordProjectionStatus::Accepted);
    assert_eq!(p_0ms.start_ms, 59_000);
    assert_eq!(p_0ms.end_ms, 60_000);

    // 2. 1ms overshoot (strictly clamped)
    let w_1ms = TranscriptionWord {
        word: "overshoot_1ms".into(),
        start_offset: "59.000s".into(),
        end_offset: "60.001s".into(),
        speaker_label: None,
    };
    let p_1ms = project_word_with_100ms_overshoot_policy(&w_1ms, media_dur);
    assert_eq!(
        p_1ms.status,
        WordProjectionStatus::Clamped {
            original_end_ms: 60_001,
            clamped_end_ms: 60_000,
            overshoot_ms: 1,
        }
    );
    assert_eq!(p_1ms.start_ms, 59_000);
    assert_eq!(p_1ms.end_ms, 60_000);

    // 3. 99ms overshoot (strictly clamped)
    let w_99ms = TranscriptionWord {
        word: "overshoot_99ms".into(),
        start_offset: "59.000s".into(),
        end_offset: "60.099s".into(),
        speaker_label: None,
    };
    let p_99ms = project_word_with_100ms_overshoot_policy(&w_99ms, media_dur);
    assert_eq!(
        p_99ms.status,
        WordProjectionStatus::Clamped {
            original_end_ms: 60_099,
            clamped_end_ms: 60_000,
            overshoot_ms: 99,
        }
    );
    assert_eq!(p_99ms.start_ms, 59_000);
    assert_eq!(p_99ms.end_ms, 60_000);

    // 4. 100ms overshoot (EXACT THRESHOLD - MUST BE CLAMPED)
    let w_100ms = TranscriptionWord {
        word: "overshoot_100ms".into(),
        start_offset: "59.000s".into(),
        end_offset: "60.100s".into(),
        speaker_label: None,
    };
    let p_100ms = project_word_with_100ms_overshoot_policy(&w_100ms, media_dur);
    assert_eq!(
        p_100ms.status,
        WordProjectionStatus::Clamped {
            original_end_ms: 60_100,
            clamped_end_ms: 60_000,
            overshoot_ms: 100,
        }
    );
    assert_eq!(p_100ms.start_ms, 59_000);
    assert_eq!(p_100ms.end_ms, 60_000);

    // 5. 101ms overshoot (1MS OVER THRESHOLD - MUST BE QUARANTINED)
    let w_101ms = TranscriptionWord {
        word: "overshoot_101ms".into(),
        start_offset: "59.000s".into(),
        end_offset: "60.101s".into(),
        speaker_label: None,
    };
    let p_101ms = project_word_with_100ms_overshoot_policy(&w_101ms, media_dur);
    assert_eq!(
        p_101ms.status,
        WordProjectionStatus::Quarantined {
            reason: "overshoot_exceeds_100ms_101ms".into(),
        }
    );
    assert_eq!(p_101ms.start_ms, 59_000);
    assert_eq!(p_101ms.end_ms, 60_101); // Quarantined preserves original end
}

#[test]
fn overshoot_policy_out_of_bounds_and_anomalous_conditions() {
    let media_dur = 60_000;

    // Out of bounds: Word starts AFTER media boundary (60_001 > 60_000)
    let w_after = TranscriptionWord {
        word: "starts_after".into(),
        start_offset: "60.001s".into(),
        end_offset: "60.050s".into(),
        speaker_label: None,
    };
    let p_after = project_word_with_100ms_overshoot_policy(&w_after, media_dur);
    assert_eq!(
        p_after.status,
        WordProjectionStatus::Quarantined {
            reason: "starts_after_media_end".into(),
        }
    );

    // Out of bounds: Word starts far beyond media boundary
    let w_far = TranscriptionWord {
        word: "far_beyond".into(),
        start_offset: "120.000s".into(),
        end_offset: "121.000s".into(),
        speaker_label: None,
    };
    let p_far = project_word_with_100ms_overshoot_policy(&w_far, media_dur);
    assert_eq!(
        p_far.status,
        WordProjectionStatus::Quarantined {
            reason: "starts_after_media_end".into(),
        }
    );

    // Out of bounds: Massive overshoot (> 1000ms)
    let w_huge_overshoot = TranscriptionWord {
        word: "huge_overshoot".into(),
        start_offset: "59.000s".into(),
        end_offset: "62.500s".into(),
        speaker_label: None,
    };
    let p_huge = project_word_with_100ms_overshoot_policy(&w_huge_overshoot, media_dur);
    assert_eq!(
        p_huge.status,
        WordProjectionStatus::Quarantined {
            reason: "overshoot_exceeds_100ms_2500ms".into(),
        }
    );

    // Out of bounds: Reversed timestamps (end < start)
    let w_reversed = TranscriptionWord {
        word: "reversed".into(),
        start_offset: "50.000s".into(),
        end_offset: "49.999s".into(),
        speaker_label: None,
    };
    let p_rev = project_word_with_100ms_overshoot_policy(&w_reversed, media_dur);
    assert_eq!(
        p_rev.status,
        WordProjectionStatus::Rejected {
            reason: "reversed_timestamps".into(),
        }
    );

    // Out of bounds: Malformed start string
    let w_bad_start = TranscriptionWord {
        word: "bad_start".into(),
        start_offset: "invalid_time".into(),
        end_offset: "10.000s".into(),
        speaker_label: None,
    };
    let p_bad_start = project_word_with_100ms_overshoot_policy(&w_bad_start, media_dur);
    assert!(matches!(
        p_bad_start.status,
        WordProjectionStatus::Rejected { .. }
    ));

    // Out of bounds: Malformed end string
    let w_bad_end = TranscriptionWord {
        word: "bad_end".into(),
        start_offset: "10.000s".into(),
        end_offset: "not_a_time".into(),
        speaker_label: None,
    };
    let p_bad_end = project_word_with_100ms_overshoot_policy(&w_bad_end, media_dur);
    assert!(matches!(
        p_bad_end.status,
        WordProjectionStatus::Rejected { .. }
    ));

    // Zero-length word at exact boundary: start == end == 60_000
    let w_zero_end = TranscriptionWord {
        word: "zero_at_end".into(),
        start_offset: "60.000s".into(),
        end_offset: "60.000s".into(),
        speaker_label: None,
    };
    let p_zero = project_word_with_100ms_overshoot_policy(&w_zero_end, media_dur);
    assert_eq!(p_zero.status, WordProjectionStatus::Accepted);
    assert_eq!(p_zero.start_ms, 60_000);
    assert_eq!(p_zero.end_ms, 60_000);

    // Zero-length word at origin: start == end == 0
    let w_zero_start = TranscriptionWord {
        word: "zero_at_start".into(),
        start_offset: "0s".into(),
        end_offset: "0s".into(),
        speaker_label: None,
    };
    let p_zero_start = project_word_with_100ms_overshoot_policy(&w_zero_start, media_dur);
    assert_eq!(p_zero_start.status, WordProjectionStatus::Accepted);
    assert_eq!(p_zero_start.start_ms, 0);
    assert_eq!(p_zero_start.end_ms, 0);
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
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
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
                    "candidates": [{
                        "content": {
                            "role": "model",
                            "parts": [{
                                "audioTranscription": {
                                    "words": [{
                                        "word": "success_after_quota",
                                        "startOffset": "0.100s",
                                        "endOffset": "0.500s"
                                    }]
                                }
                            }]
                        },
                        "finishReason": "STOP",
                        "index": 0
                    }],
                    "usageMetadata": {"promptTokenCount": 20, "totalTokenCount": 20},
                    "modelVersion": "gemini-3.5-transcribe"
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
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
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
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
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
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
        .respond_with(move |_: &wiremock::Request| {
            let n = hit_clone.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                ResponseTemplate::new(503).set_body_raw("Service Unavailable", "text/plain")
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "candidates": [{
                        "content": {
                            "role": "model",
                            "parts": [{
                                "audioTranscription": {
                                    "words": [{
                                        "word": "recovered",
                                        "startOffset": "0.100s",
                                        "endOffset": "0.300s"
                                    }]
                                }
                            }]
                        },
                        "finishReason": "STOP",
                        "index": 0
                    }],
                    "usageMetadata": {"promptTokenCount": 10, "totalTokenCount": 10},
                    "modelVersion": "gemini-3.5-transcribe"
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
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
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
        .and(path(
            "/v1beta/models/gemini-3.5-transcribe:streamGenerateContent",
        ))
        .and(query_param("alt", "sse"))
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
        other => panic!("Expected Err(Error::Provider), got is_ok: {}", other.is_ok()),
    }

    // Second call should fail fast with CooldownActive without network request
    let res2 = client
        .transcribe_stream(mock_transcribe_request(), &cancel)
        .await;
    match res2 {
        Err(Error::CooldownActive { .. }) => {}
        other => panic!("Expected Err(Error::CooldownActive), got is_ok: {}", other.is_ok()),
    }

    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
}

#[tokio::test]
async fn mock_api_key_redaction_in_provider_error() {
    let server = MockServer::start().await;
    let secret_key = "adversarial-secret-key-12345";

    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.5-transcribe:generateContent"))
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
