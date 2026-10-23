//! Provider response shapes decoded from `generateContent` and streamed chunks.

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{Error, Result};

/// A single recognized word with provider timing offsets and optional speaker label.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionWord {
    pub word: String,
    #[serde(alias = "start_offset")]
    pub start_offset: String,
    #[serde(alias = "end_offset")]
    pub end_offset: String,
    #[serde(
        default,
        alias = "speaker_label",
        skip_serializing_if = "Option::is_none"
    )]
    pub speaker_label: Option<String>,
}

/// Transcription container within a response content part.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTranscription {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub words: Vec<TranscriptionWord>,
}

/// A response content part. Unknown provider fields are ignored for forward
/// compatibility; thought text remains identifiable and is excluded by
/// `GenerateResponse::text`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub text: Option<String>,
    #[serde(default)]
    pub thought: bool,
    pub thought_signature: Option<String>,
    #[serde(
        default,
        alias = "audio_transcription",
        skip_serializing_if = "Option::is_none"
    )]
    pub audio_transcription: Option<AudioTranscription>,
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

    /// Extract all transcribed words from the first candidate in this response chunk.
    #[must_use]
    pub fn transcription_words(&self) -> Vec<TranscriptionWord> {
        self.candidates
            .first()
            .and_then(|c| c.content.as_ref())
            .map(|c| {
                c.parts
                    .iter()
                    .filter_map(|p| p.audio_transcription.as_ref())
                    .flat_map(|at| at.words.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Extract full transcribed text if provided by the model.
    #[must_use]
    pub fn transcription_text(&self) -> Option<String> {
        self.candidates
            .first()
            .and_then(|c| c.content.as_ref())
            .and_then(|c| {
                c.parts
                    .iter()
                    .filter_map(|p| p.audio_transcription.as_ref())
                    .find_map(|at| at.text.clone())
            })
    }

    pub fn required_text(&self) -> Result<String> {
        self.text().ok_or(Error::NoTextOutput)
    }

    pub fn parse_json<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_str(&self.required_text()?)
            .map_err(|_| Error::InvalidRequest("Gemini output is not valid schema JSON".to_owned()))
    }
}
