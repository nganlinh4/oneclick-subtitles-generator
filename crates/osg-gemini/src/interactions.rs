use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AudioTranscription, Candidate, Content, Error, GenerateRequest, GenerateResponse, MediaInput,
    MediaResolution, Part, ProviderError, Result, TokenUsage, TranscribeRequest, TranscriptionWord,
};

pub(crate) const PATH: &str = "v1beta/interactions";

#[derive(Serialize)]
pub(crate) struct InteractionRequest {
    model: String,
    input: Vec<InteractionInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<InteractionGenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<InteractionTextFormat>,
    stream: bool,
    store: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InteractionInput {
    Text {
        text: String,
    },
    Audio {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
        mime_type: String,
    },
    Video {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        resolution: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        processing: Option<StaticVideoProcessing>,
    },
}

#[derive(Serialize)]
struct StaticVideoProcessing {
    #[serde(rename = "type")]
    kind: &'static str,
    fps: f64,
}

#[derive(Serialize)]
struct InteractionGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_level: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transcription_config: Option<InteractionTranscriptionConfig>,
}

#[derive(Serialize)]
struct InteractionTextFormat {
    #[serde(rename = "type")]
    kind: &'static str,
    mime_type: &'static str,
    schema: Value,
}

#[derive(Serialize)]
struct InteractionTranscriptionConfig {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    language_codes: Vec<String>,
    mode: InteractionTranscriptionMode,
}

#[derive(Serialize)]
struct InteractionTranscriptionMode {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    diarization_mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    timestamp_granularities: Vec<&'static str>,
}

fn thinking_level(level: crate::ThinkingLevel) -> &'static str {
    match level {
        crate::ThinkingLevel::Minimal => "minimal",
        crate::ThinkingLevel::Low => "low",
        crate::ThinkingLevel::Medium => "medium",
        crate::ThinkingLevel::High => "high",
    }
}

fn media_resolution(resolution: MediaResolution) -> &'static str {
    match resolution {
        MediaResolution::MediaResolutionLow => "low",
        MediaResolution::MediaResolutionMedium => "medium",
        MediaResolution::MediaResolutionHigh => "high",
    }
}

fn media_input(
    media: &MediaInput,
    resolution: Option<MediaResolution>,
    fps: Option<f64>,
) -> InteractionInput {
    let (mime_type, data, uri) = match media {
        MediaInput::Inline(media) => (
            media.mime_type().to_owned(),
            Some(BASE64_STANDARD.encode(media.bytes())),
            None,
        ),
        MediaInput::Uploaded(media) => (
            media.mime_type().to_owned(),
            None,
            Some(media.uri().as_str().to_owned()),
        ),
    };
    if mime_type.starts_with("video/") {
        InteractionInput::Video {
            data,
            uri,
            mime_type,
            resolution: resolution.map(media_resolution),
            processing: fps.map(|fps| StaticVideoProcessing {
                kind: "static",
                fps,
            }),
        }
    } else {
        InteractionInput::Audio {
            data,
            uri,
            mime_type,
        }
    }
}

pub(crate) fn encode_generate(request: &GenerateRequest, stream: bool) -> Result<Vec<u8>> {
    let mut input = request
        .media
        .iter()
        .map(|media| {
            media_input(
                media,
                request.generation.media_resolution,
                request.generation.video_fps,
            )
        })
        .collect::<Vec<_>>();
    input.push(InteractionInput::Text {
        text: request.prompt.clone(),
    });
    let generation_config = (request.generation.max_output_tokens.is_some()
        || request.generation.thinking_level.is_some())
    .then(|| InteractionGenerationConfig {
        max_output_tokens: request.generation.max_output_tokens,
        thinking_level: request.generation.thinking_level.map(thinking_level),
        transcription_config: None,
    });
    let response_format = request
        .generation
        .response_json_schema
        .clone()
        .map(|schema| InteractionTextFormat {
            kind: "text",
            mime_type: "application/json",
            schema,
        });
    encode(&InteractionRequest {
        model: request.model.api_id().to_owned(),
        input,
        system_instruction: request.system_instruction.clone(),
        generation_config,
        response_format,
        stream,
        store: false,
    })
}

pub(crate) fn encode_transcribe(request: &TranscribeRequest, stream: bool) -> Result<Vec<u8>> {
    let mode = InteractionTranscriptionMode {
        kind: "verbatim",
        diarization_mode: request.config.diarization.then_some("speaker"),
        timestamp_granularities: request
            .config
            .word_timestamp
            .then_some("word")
            .into_iter()
            .collect(),
    };
    encode(&InteractionRequest {
        model: request.model.api_id().to_owned(),
        input: vec![media_input(&request.media, None, None)],
        system_instruction: None,
        generation_config: Some(InteractionGenerationConfig {
            max_output_tokens: Some(request.model.output_token_limit()),
            thinking_level: None,
            transcription_config: Some(InteractionTranscriptionConfig {
                language_codes: request.config.language_hints.clone(),
                mode,
            }),
        }),
        response_format: None,
        stream,
        store: false,
    })
}

fn encode(value: &InteractionRequest) -> Result<Vec<u8>> {
    serde_json::to_vec(value)
        .map_err(|_| Error::InvalidRequest("failed to encode Gemini interaction".to_owned()))
}

#[derive(Debug, Deserialize)]
pub(crate) struct Interaction {
    pub id: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub steps: Vec<InteractionStep>,
    pub usage: Option<InteractionUsage>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InteractionStep {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub content: Vec<InteractionContent>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct InteractionContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
    #[serde(default)]
    pub annotations: Vec<InteractionAnnotation>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct InteractionAnnotation {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
    pub speaker: Option<String>,
    pub start_offset: Option<String>,
    pub end_offset: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct InteractionUsage {
    #[serde(rename = "total_input_tokens")]
    pub input_tokens: Option<u64>,
    #[serde(rename = "total_output_tokens")]
    pub output_tokens: Option<u64>,
    #[serde(rename = "total_tokens")]
    pub tokens: Option<u64>,
    #[serde(rename = "total_thought_tokens")]
    pub thought_tokens: Option<u64>,
    #[serde(rename = "total_cached_tokens")]
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InteractionEvent {
    pub event_type: String,
    pub interaction: Option<Interaction>,
    pub step: Option<InteractionStep>,
    pub delta: Option<InteractionDelta>,
    pub error: Option<InteractionEventError>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InteractionEventError {
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InteractionDelta {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
    #[serde(default)]
    pub annotations: Vec<InteractionAnnotation>,
}

fn words(annotations: &[InteractionAnnotation]) -> Vec<TranscriptionWord> {
    annotations
        .iter()
        .filter(|annotation| annotation.kind == "word_info")
        .filter_map(|annotation| {
            Some(TranscriptionWord {
                word: annotation.text.clone()?,
                start_offset: annotation.start_offset.clone()?,
                end_offset: annotation.end_offset.clone()?,
                speaker_label: annotation.speaker.clone(),
            })
        })
        .collect()
}

fn response(
    text: Option<String>,
    annotations: &[InteractionAnnotation],
    finish_reason: Option<&str>,
    usage: Option<&InteractionUsage>,
    model: Option<String>,
    id: Option<String>,
) -> GenerateResponse {
    let transcription_words = words(annotations);
    let has_content = text.is_some() || !transcription_words.is_empty() || finish_reason.is_some();
    GenerateResponse {
        candidates: has_content
            .then(|| Candidate {
                content: Some(Content {
                    role: Some("model".to_owned()),
                    parts: vec![Part {
                        text: text.clone(),
                        thought: false,
                        thought_signature: None,
                        audio_transcription: (!transcription_words.is_empty()).then_some({
                            AudioTranscription {
                                text,
                                words: transcription_words,
                            }
                        }),
                    }],
                }),
                finish_reason: finish_reason.map(str::to_owned),
                index: Some(0),
                safety_ratings: Vec::new(),
            })
            .into_iter()
            .collect(),
        prompt_feedback: None,
        usage_metadata: usage.map(|usage| TokenUsage {
            prompt_token_count: usage.input_tokens,
            candidates_token_count: usage.output_tokens,
            total_token_count: usage.tokens,
            thoughts_token_count: usage.thought_tokens,
            cached_content_token_count: usage.cached_tokens,
        }),
        model_version: model,
        response_id: id,
    }
}

fn finish_reason(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("completed") => Some("STOP"),
        Some("incomplete") => Some("MAX_TOKENS"),
        Some("failed" | "cancelled" | "requires_action") => Some("OTHER"),
        _ => None,
    }
}

pub(crate) fn decode_interaction(bytes: &[u8]) -> Result<GenerateResponse> {
    let interaction: Interaction = serde_json::from_slice(bytes)
        .map_err(|_| Error::Transport(crate::TransportKind::Decode))?;
    let mut text = String::new();
    let mut annotations = Vec::new();
    for content in interaction
        .steps
        .iter()
        .filter(|step| step.kind == "model_output")
        .flat_map(|step| &step.content)
    {
        if content.kind == "text" {
            if let Some(value) = &content.text {
                text.push_str(value);
            }
            annotations.extend(content.annotations.iter().cloned());
        }
    }
    Ok(response(
        (!text.is_empty()).then_some(text),
        &annotations,
        finish_reason(interaction.status.as_deref()),
        interaction.usage.as_ref(),
        interaction.model,
        interaction.id,
    ))
}

pub(crate) fn event_response(event: InteractionEvent) -> Result<Option<GenerateResponse>> {
    match event.event_type.as_str() {
        "step.start" => {
            let Some(step) = event.step.filter(|step| step.kind == "model_output") else {
                return Ok(None);
            };
            let mut text = String::new();
            let mut annotations = Vec::new();
            for content in step.content {
                if content.kind == "text" {
                    if let Some(value) = content.text {
                        text.push_str(&value);
                    }
                    annotations.extend(content.annotations);
                }
            }
            Ok((!text.is_empty() || !annotations.is_empty()).then(|| {
                response(
                    (!text.is_empty()).then_some(text),
                    &annotations,
                    None,
                    None,
                    None,
                    None,
                )
            }))
        }
        "step.delta" => {
            let Some(delta) = event.delta else {
                return Ok(None);
            };
            match delta.kind.as_str() {
                "text" => Ok((delta.text.is_some() || !delta.annotations.is_empty())
                    .then(|| response(delta.text, &delta.annotations, None, None, None, None))),
                "text_annotation_delta" => Ok((!delta.annotations.is_empty())
                    .then(|| response(None, &delta.annotations, None, None, None, None))),
                _ => Ok(None),
            }
        }
        "interaction.completed" => {
            let interaction = event
                .interaction
                .ok_or(Error::Transport(crate::TransportKind::Decode))?;
            Ok(Some(response(
                None,
                &[],
                finish_reason(interaction.status.as_deref()),
                interaction.usage.as_ref(),
                interaction.model,
                interaction.id,
            )))
        }
        "error" => {
            let error = event
                .error
                .ok_or(Error::Transport(crate::TransportKind::Decode))?;
            let code = error.code.unwrap_or_else(|| "interaction_error".to_owned());
            let message = error
                .message
                .unwrap_or_else(|| "Gemini interaction failed".to_owned());
            let normalized = format!("{code} {message}").to_ascii_uppercase();
            let http_status =
                if normalized.contains("RESOURCE_EXHAUSTED") || normalized.contains("RATE_LIMIT") {
                    429
                } else if normalized.contains("UNAUTHENTICATED") {
                    401
                } else if normalized.contains("PERMISSION_DENIED") {
                    403
                } else if normalized.contains("INVALID_ARGUMENT") {
                    400
                } else {
                    500
                };
            Err(Error::Provider(ProviderError {
                http_status,
                api_status: Some(code.chars().take(128).collect()),
                // Provider event text is deliberately not exposed: an error may echo request
                // content. The typed code/status is sufficient for product behavior and rotation.
                message: "Gemini interaction stream failed".to_owned(),
                retry_after: None,
                retryable: false,
            }))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GenerationConfig, InlineMedia, Model};
    use bytes::Bytes;

    #[test]
    fn generation_is_stateless_interactions_wire_format() {
        let request = GenerateRequest {
            model: Model::Gemini38Flash,
            prompt: "translate".to_owned(),
            system_instruction: Some("return only JSON".to_owned()),
            media: vec![MediaInput::Inline(
                InlineMedia::new("video/mp4", Bytes::from_static(b"video")).unwrap(),
            )],
            generation: GenerationConfig {
                video_fps: Some(0.5),
                max_output_tokens: Some(100),
                thinking_level: Some(crate::ThinkingLevel::Low),
                media_resolution: Some(MediaResolution::MediaResolutionLow),
                response_json_schema: Some(serde_json::json!({"type":"object"})),
            },
        };
        let value: Value =
            serde_json::from_slice(&encode_generate(&request, true).unwrap()).unwrap();
        assert_eq!(value["model"], "gemini-3.8-flash");
        assert_eq!(value["stream"], true);
        assert_eq!(value["store"], false);
        assert_eq!(value["input"][0]["type"], "video");
        assert_eq!(value["input"][0]["processing"]["fps"], 0.5);
        assert_eq!(value["input"][0]["resolution"], "low");
        assert_eq!(value["response_format"]["mime_type"], "application/json");
        assert!(value.get("contents").is_none());
        assert!(value["generation_config"].get("thinking_config").is_none());
    }

    #[test]
    fn completed_interaction_maps_text_annotations_and_usage() {
        let response = decode_interaction(br#"{
          "id":"v1_abc","model":"gemini-3.5-transcribe","status":"completed",
          "steps":[{"type":"model_output","content":[{"type":"text","text":"Hello", "annotations":[
            {"type":"word_info","text":"Hello","speaker":"spk_1","start_offset":"0.1s","end_offset":"0.4s"}
          ]}]}],
          "usage":{"total_input_tokens":10,"total_output_tokens":2,"total_tokens":12}
        }"#).unwrap();
        assert_eq!(response.text().as_deref(), Some("Hello"));
        assert_eq!(
            response.transcription_words()[0].speaker_label.as_deref(),
            Some("spk_1")
        );
        assert_eq!(
            response.candidates[0].finish_reason.as_deref(),
            Some("STOP")
        );
        assert_eq!(response.usage_metadata.unwrap().total_token_count, Some(12));
    }

    #[test]
    fn text_delta_preserves_inline_word_annotations() {
        let event: InteractionEvent = serde_json::from_str(
            r#"{
          "event_type":"step.delta",
          "delta":{"type":"text","text":"Hello","annotations":[
            {"type":"word_info","text":"Hello","start_offset":"0s","end_offset":"0.4s"}
          ]}
        }"#,
        )
        .unwrap();
        let response = event_response(event).unwrap().unwrap();
        assert_eq!(response.text().as_deref(), Some("Hello"));
        assert_eq!(response.transcription_words().len(), 1);
    }

    #[test]
    fn stream_errors_preserve_class_without_exposing_provider_text() {
        let event: InteractionEvent = serde_json::from_str(
            r#"{
          "event_type":"error",
          "error":{"code":"RESOURCE_EXHAUSTED","message":"echoed private prompt"}
        }"#,
        )
        .unwrap();
        let Error::Provider(error) = event_response(event).unwrap_err() else {
            panic!("expected provider error");
        };
        assert_eq!(error.http_status, 429);
        assert_eq!(error.api_status.as_deref(), Some("RESOURCE_EXHAUSTED"));
        assert!(!error.message.contains("private"));
        assert!(!error.retryable);
    }
}
