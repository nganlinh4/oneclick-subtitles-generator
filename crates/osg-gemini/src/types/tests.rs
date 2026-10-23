//! Request type tests: redaction, MIME catalog, and model-specific validation.

use super::*;
use crate::GenerateResponse;

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
fn generation_validation_enforces_model_specific_thinking_levels() {
    let rejected = GenerationConfig {
        thinking_level: Some(ThinkingLevel::Minimal),
        ..GenerationConfig::default()
    };
    assert!(rejected.validate(Model::Gemini37Flash).is_err());

    let accepted = GenerationConfig {
        thinking_level: Some(ThinkingLevel::Low),
        ..GenerationConfig::default()
    };
    assert!(accepted.validate(Model::Gemini37Flash).is_ok());
    assert!(rejected.validate(Model::Gemini36Flash).is_ok());
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
