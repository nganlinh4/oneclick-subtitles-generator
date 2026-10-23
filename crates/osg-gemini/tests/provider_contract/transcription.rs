//! Transcription wire-shape, streaming, and quota contracts.

use bytes::Bytes;
use futures_util::StreamExt;
use osg_gemini::{
    AudioTranscriptionConfig, CancellationToken, Error, InlineMedia, MediaInput, TranscribeRequest,
    TranscriptionStreamCompletion,
};
use serde_json::{Value, json};

use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path},
};

use super::client;

#[tokio::test]
async fn transcribe_wire_shape_strict_separation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .and(header("x-goog-api-key", "contract-test-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id":"v1_transcribe","model":"gemini-3.5-transcribe","status":"completed",
            "steps":[{"type":"model_output","content":[{
                "type":"text","text":"Hello world","annotations":[
                    {"type":"word_info","text":"Hello","start_offset":"0.120s","end_offset":"0.450s","speaker":"1"},
                    {"type":"word_info","text":"world","start_offset":"0.500s","end_offset":"0.900s","speaker":"1"}
                ]
            }]}],
            "usage":{"total_input_tokens":50,"total_tokens":50}
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
    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 1);
    assert_eq!(input[0]["type"], "audio");
    assert_eq!(input[0]["mime_type"], "audio/wav");

    let gen_config = &body["generation_config"];
    assert_eq!(gen_config["max_output_tokens"], 32_768);
    let asr_config = &gen_config["transcription_config"];
    assert_eq!(asr_config["mode"]["type"], "verbatim");
    assert_eq!(asr_config["mode"]["diarization_mode"], "speaker");
    assert_eq!(
        asr_config["mode"]["timestamp_granularities"],
        json!(["word"])
    );
    assert_eq!(asr_config["language_codes"], json!(["en", "vi"]));

    // Strict separation: forbidden text generation fields
    assert!(gen_config["thinking_level"].is_null());
    assert!(body["response_format"].is_null());
    assert!(body["system_instruction"].is_null());
    assert_eq!(body["store"], false);
}

#[tokio::test]
async fn transcribe_streaming_sse_words_deserialization() {
    let server = MockServer::start().await;
    let sse_body = concat!(
        "event: step.delta\ndata: {\"event_type\":\"step.delta\",\"index\":0,\"delta\":{\"type\":\"text_annotation_delta\",\"annotations\":[{\"type\":\"word_info\",\"text\":\"Hello\",\"start_offset\":\"0.100s\",\"end_offset\":\"0.400s\",\"speaker\":\"0\"}]}}\n\n",
        "event: step.delta\ndata: {\"event_type\":\"step.delta\",\"index\":0,\"delta\":{\"type\":\"text_annotation_delta\",\"annotations\":[{\"type\":\"word_info\",\"text\":\"world\",\"start_offset\":\"0.450s\",\"end_offset\":\"0.800s\",\"speaker\":\"0\"}]}}\n\n",
        "event: interaction.completed\ndata: {\"event_type\":\"interaction.completed\",\"interaction\":{\"id\":\"v1_transcribe_stream\",\"model\":\"gemini-3.5-transcribe\",\"status\":\"completed\"}}\n\n",
        "data: [DONE]\n\n",
    );

    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
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
        .and(path("/v1beta/interactions"))
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
