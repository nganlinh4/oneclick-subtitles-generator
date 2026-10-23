//! Client builder and request-validation tests.

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
    let value: serde_json::Value =
        serde_json::from_slice(&crate::interactions::encode_generate(&request, false).unwrap())
            .unwrap();
    assert_eq!(value["generation_config"]["thinking_level"], "minimal");
    assert_eq!(value["response_format"]["mime_type"], "application/json");
    assert_eq!(value["input"][0]["mime_type"], "audio/mpeg");
    assert!(value.get("temperature").is_none());
}

#[test]
fn video_fps_is_serialized_on_video_parts_only() {
    for (mime, expected) in [("video/mp4", true), ("audio/flac", false)] {
        let request = GenerateRequest {
            model: Model::Gemini38Flash,
            prompt: "Transcribe".to_owned(),
            system_instruction: None,
            media: vec![MediaInput::Inline(
                crate::InlineMedia::new(mime, vec![1, 2, 3]).unwrap(),
            )],
            generation: crate::GenerationConfig {
                video_fps: Some(0.25),
                ..crate::GenerationConfig::default()
            },
        };
        let value: serde_json::Value =
            serde_json::from_slice(&crate::interactions::encode_generate(&request, false).unwrap())
                .unwrap();
        let processing = &value["input"][0]["processing"];
        assert_eq!(processing.is_object(), expected);
        if expected {
            assert_eq!(processing["type"], "static");
            assert_eq!(processing["fps"], 0.25);
        }
        assert!(value.get("generation_config").is_none());
    }
}

#[test]
fn endpoint_rejects_plaintext_remote_origins() {
    let key = ApiKey::new("secret").unwrap();
    let remote = Url::parse("http://example.com/").unwrap();
    assert!(GeminiClient::builder(key).api_base(remote).is_err());
}

#[test]
fn custom_models_are_accepted_for_text_and_rejected_for_media() {
    let model = Model::from_api_id("gemini-custom-test").expect("valid custom model");
    let text = GenerateRequest {
        model,
        prompt: "translate".to_owned(),
        system_instruction: None,
        media: Vec::new(),
        generation: crate::GenerationConfig::default(),
    };
    assert!(validate_generate_request(&text).is_ok());

    let mut media = text.clone();
    media.media.push(MediaInput::Inline(
        crate::InlineMedia::new("audio/mpeg", Bytes::from_static(b"audio")).unwrap(),
    ));
    assert!(validate_generate_request(&media).is_err());

    let mut resolution = text;
    resolution.generation.media_resolution = Some(crate::MediaResolution::MediaResolutionMedium);
    assert!(validate_generate_request(&resolution).is_err());
}

#[test]
fn transcribe_payload_emits_language_codes_and_rejects_language_hints() {
    let media = MediaInput::Inline(
        crate::InlineMedia::new("audio/wav", Bytes::from_static(b"RIFF....WAVEfmt ")).unwrap(),
    );
    let req = TranscribeRequest::new(media).with_config(
        crate::AudioTranscriptionConfig::new()
            .with_diarization(true)
            .with_language_hints(["en", "ko"]),
    );
    let json: serde_json::Value =
        serde_json::from_slice(&crate::interactions::encode_transcribe(&req, false).unwrap())
            .unwrap();
    let asr_config = &json["generation_config"]["transcription_config"];

    assert_eq!(json["generation_config"]["max_output_tokens"], 32_768);
    assert_eq!(asr_config["mode"]["type"], "verbatim");
    assert_eq!(asr_config["mode"]["diarization_mode"], "speaker");
    assert_eq!(asr_config["mode"]["timestamp_granularities"][0], "word");
    assert_eq!(
        asr_config["language_codes"],
        serde_json::json!(["en", "ko"])
    );
}
