use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{Error, GeminiClient, Result};

const IMAGE_MODEL_ID: &str = "gemini-3.1-flash-image";
/// Maximum reference-image body accepted across the native IPC/provider boundary.
pub const MAX_REFERENCE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_GENERATED_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROMPT_CHARACTERS: usize = 1_048_576;

/// Stable image-output model that also accepts video input. This remains separate from the
/// ordinary text-output model enum so it cannot accidentally be selected for transcription.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ImageModel {
    #[serde(rename = "gemini-3.1-flash-image")]
    Gemini31FlashImage,
}

impl ImageModel {
    #[must_use]
    pub const fn api_id(self) -> &'static str {
        match self {
            Self::Gemini31FlashImage => IMAGE_MODEL_ID,
        }
    }
}

/// Fixed output ratio used by the existing background-image workflow.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ImageAspectRatio {
    #[serde(rename = "16:9")]
    Landscape16By9,
}

impl ImageAspectRatio {
    const fn wire_value(self) -> &'static str {
        match self {
            Self::Landscape16By9 => "16:9",
        }
    }
}

/// Bounded output resolution. One-kilopixel output preserves the legacy feature's memory profile.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ImageSize {
    #[serde(rename = "1K")]
    OneK,
}

impl ImageSize {
    const fn wire_value(self) -> &'static str {
        match self {
            Self::OneK => "1K",
        }
    }
}

/// Validated image bytes used only inside the Rust provider boundary.
#[derive(Clone)]
pub struct ReferenceImage {
    mime_type: &'static str,
    bytes: Bytes,
}

impl ReferenceImage {
    pub fn new(mime_type: &str, bytes: impl Into<Bytes>) -> Result<Self> {
        let bytes = bytes.into();
        if bytes.is_empty() || bytes.len() > MAX_REFERENCE_IMAGE_BYTES {
            return Err(Error::InvalidRequest(
                "reference image size is outside the supported bounds".to_owned(),
            ));
        }
        let mime_type = canonical_image_mime(mime_type)
            .ok_or_else(|| Error::UnsupportedMimeType(mime_type.trim().to_ascii_lowercase()))?;
        if !matches_signature(mime_type, &bytes) {
            return Err(Error::InvalidRequest(
                "reference image bytes do not match the declared format".to_owned(),
            ));
        }
        Ok(Self { mime_type, bytes })
    }

    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        self.mime_type
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl fmt::Debug for ReferenceImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReferenceImage")
            .field("mime_type", &self.mime_type)
            .field("bytes", &format_args!("[{} BYTES]", self.bytes.len()))
            .finish()
    }
}

/// Backend-only image request. Prompt and reference bytes are redacted from debug output.
#[derive(Clone)]
pub struct ImageGenerateRequest {
    pub model: ImageModel,
    pub prompt: String,
    pub reference: ReferenceImage,
    pub aspect_ratio: ImageAspectRatio,
    pub image_size: ImageSize,
}

impl fmt::Debug for ImageGenerateRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageGenerateRequest")
            .field("model", &self.model)
            .field(
                "prompt",
                &format_args!("[{} CHARS]", self.prompt.chars().count()),
            )
            .field("reference", &self.reference)
            .field("aspect_ratio", &self.aspect_ratio)
            .field("image_size", &self.image_size)
            .finish()
    }
}

/// Decoded, bounded provider output. Bytes are intentionally non-serializable.
#[derive(Clone)]
pub struct GeneratedImage {
    mime_type: &'static str,
    bytes: Bytes,
}

impl GeneratedImage {
    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        self.mime_type
    }

    #[must_use]
    pub fn bytes(&self) -> &Bytes {
        &self.bytes
    }
}

impl fmt::Debug for GeneratedImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImage")
            .field("mime_type", &self.mime_type)
            .field("bytes", &format_args!("[{} BYTES]", self.bytes.len()))
            .finish()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireImageRequest {
    contents: Vec<WireContent>,
    generation_config: WireImageGenerationConfig,
}

#[derive(Serialize)]
struct WireContent {
    role: &'static str,
    parts: Vec<WirePart>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum WirePart {
    InlineData {
        #[serde(rename = "inlineData")]
        inline_data: WireInlineData,
    },
    Text {
        text: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireInlineData {
    mime_type: &'static str,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireImageGenerationConfig {
    response_modalities: [&'static str; 1],
    response_format: WireResponseFormat,
}

#[derive(Serialize)]
struct WireResponseFormat {
    image: WireImageFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireImageFormat {
    aspect_ratio: &'static str,
    image_size: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireImageResponse {
    #[serde(default)]
    candidates: Vec<WireCandidate>,
    prompt_feedback: Option<crate::PromptFeedback>,
}

#[derive(Deserialize)]
struct WireCandidate {
    content: Option<WireResponseContent>,
}

#[derive(Deserialize)]
struct WireResponseContent {
    #[serde(default)]
    parts: Vec<WireResponsePart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResponsePart {
    inline_data: Option<WireResponseInlineData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResponseInlineData {
    mime_type: String,
    data: String,
}

impl GeminiClient {
    /// Generates one bounded image while keeping the key, prompt, reference, and provider payload
    /// entirely inside the Rust process.
    pub async fn generate_image(
        &self,
        request: ImageGenerateRequest,
        cancel: &CancellationToken,
    ) -> Result<GeneratedImage> {
        validate_request(&request)?;
        let _permit = self.acquire(cancel).await?;
        let payload = serde_json::to_vec(&build_payload(&request))
            .map_err(|_| Error::InvalidRequest("failed to encode image request".to_owned()))?;
        if payload.len() > self.inner.options.max_inline_request_bytes {
            return Err(Error::InlineRequestTooLarge {
                actual_bytes: payload.len(),
                limit_bytes: self.inner.options.max_inline_request_bytes,
            });
        }

        let endpoint = self.endpoint(&format!(
            "v1/models/{}:generateContent",
            request.model.api_id()
        ))?;
        let response = self
            .send_with_retry(
                "image generation",
                self.inner.options.request_timeout,
                self.inner.options.max_response_bytes,
                None,
                cancel,
                || {
                    self.authenticated(self.inner.http.post(endpoint.clone()))
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(payload.clone())
                },
            )
            .await?;
        decode_response(&response.body)
    }
}

fn validate_request(request: &ImageGenerateRequest) -> Result<()> {
    let prompt_characters = request.prompt.chars().count();
    if request.prompt.trim().is_empty() || prompt_characters > MAX_PROMPT_CHARACTERS {
        return Err(Error::InvalidRequest(
            "image prompt must contain 1 to 1,048,576 characters".to_owned(),
        ));
    }
    Ok(())
}

fn build_payload(request: &ImageGenerateRequest) -> WireImageRequest {
    WireImageRequest {
        contents: vec![WireContent {
            role: "user",
            parts: vec![
                WirePart::InlineData {
                    inline_data: WireInlineData {
                        mime_type: request.reference.mime_type,
                        data: BASE64_STANDARD.encode(&request.reference.bytes),
                    },
                },
                WirePart::Text {
                    text: request.prompt.clone(),
                },
            ],
        }],
        generation_config: WireImageGenerationConfig {
            response_modalities: ["IMAGE"],
            response_format: WireResponseFormat {
                image: WireImageFormat {
                    aspect_ratio: request.aspect_ratio.wire_value(),
                    image_size: request.image_size.wire_value(),
                },
            },
        },
    }
}

fn decode_response(body: &[u8]) -> Result<GeneratedImage> {
    let response: WireImageResponse =
        serde_json::from_slice(body).map_err(|_| Error::Transport(crate::TransportKind::Decode))?;
    if response
        .prompt_feedback
        .as_ref()
        .and_then(|feedback| feedback.block_reason.as_deref())
        .is_some()
    {
        return Err(Error::ImageOutputBlocked);
    }
    let inline = response
        .candidates
        .first()
        .and_then(|candidate| candidate.content.as_ref())
        .and_then(|content| {
            content
                .parts
                .iter()
                .find_map(|part| part.inline_data.as_ref())
        })
        .ok_or(Error::NoImageOutput)?;
    let mime_type = canonical_image_mime(&inline.mime_type)
        .ok_or_else(|| Error::UnsupportedMimeType(inline.mime_type.to_ascii_lowercase()))?;
    let bytes = BASE64_STANDARD
        .decode(inline.data.as_bytes())
        .map_err(|_| Error::InvalidImageOutput)?;
    if bytes.is_empty()
        || bytes.len() > MAX_GENERATED_BYTES
        || !matches_signature(mime_type, &bytes)
    {
        return Err(Error::InvalidImageOutput);
    }
    Ok(GeneratedImage {
        mime_type,
        bytes: Bytes::from(bytes),
    })
}

fn canonical_image_mime(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn matches_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Bytes {
        Bytes::from_static(b"\x89PNG\r\n\x1a\nvalid")
    }

    fn request() -> ImageGenerateRequest {
        ImageGenerateRequest {
            model: ImageModel::Gemini31FlashImage,
            prompt: "Expand this cover into a landscape image".to_owned(),
            reference: ReferenceImage::new("image/png", png()).expect("valid reference"),
            aspect_ratio: ImageAspectRatio::Landscape16By9,
            image_size: ImageSize::OneK,
        }
    }

    #[test]
    fn payload_uses_only_the_stable_video_capable_image_model_contract() {
        let value = serde_json::to_value(build_payload(&request())).expect("serializes");
        assert_eq!(ImageModel::Gemini31FlashImage.api_id(), IMAGE_MODEL_ID);
        assert_eq!(value["generationConfig"]["responseModalities"][0], "IMAGE");
        assert_eq!(
            value["generationConfig"]["responseFormat"]["image"]["aspectRatio"],
            "16:9"
        );
        assert_eq!(
            value["generationConfig"]["responseFormat"]["image"]["imageSize"],
            "1K"
        );
    }

    #[test]
    fn inputs_and_outputs_require_matching_bounded_image_signatures() {
        assert!(ReferenceImage::new("image/png", png()).is_ok());
        assert!(ReferenceImage::new("image/png", Bytes::from_static(b"not png")).is_err());
        let response = serde_json::json!({
            "candidates": [{"content": {"parts": [{
                "inlineData": {
                    "mimeType": "image/png",
                    "data": BASE64_STANDARD.encode(png())
                }
            }]}}]
        });
        let image = decode_response(&serde_json::to_vec(&response).expect("serializes"))
            .expect("valid output");
        assert_eq!(image.mime_type(), "image/png");
        assert_eq!(image.bytes(), &png());
    }

    #[test]
    fn debug_never_contains_prompt_or_bytes() {
        let debug = format!("{:?}", request());
        assert!(!debug.contains("Expand this cover"));
        assert!(!debug.contains("valid"));
    }
}
