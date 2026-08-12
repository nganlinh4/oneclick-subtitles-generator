use serde::{Deserialize, Serialize};

/// A stable Gemini REST model verified to accept both audio and video input.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum Model {
    #[serde(rename = "gemini-3.5-flash-lite")]
    Gemini35FlashLite,
    #[serde(rename = "gemini-3.6-flash")]
    Gemini36Flash,
    #[serde(rename = "gemini-3.5-flash")]
    Gemini35Flash,
    #[serde(rename = "gemini-3.1-flash-lite")]
    Gemini31FlashLite,
}

impl Model {
    /// Provider model ID used in the REST path.
    #[must_use]
    pub const fn api_id(self) -> &'static str {
        model_spec(self).api_id
    }

    /// Centralized provider capabilities and lifecycle metadata.
    #[must_use]
    pub const fn spec(self) -> &'static ModelSpec {
        model_spec(self)
    }
}

/// Provider lifecycle. Preview and experimental endpoints are intentionally
/// unrepresentable in this crate's model catalog.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Stable,
}

/// Input modalities relevant to this application.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InputModality {
    Audio,
    Video,
}

/// Gemini thinking levels supported by the selected Gemini 3 models.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
}

/// One source of truth for model IDs, capabilities, lifecycle, and toolbox use.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelSpec {
    pub model: Model,
    pub api_id: &'static str,
    pub lifecycle: Lifecycle,
    pub input_modalities: &'static [InputModality],
    pub output_text: bool,
    pub structured_output: bool,
    pub thinking: bool,
    pub input_token_limit: u32,
    pub output_token_limit: u32,
    pub toolbox_thinking: ThinkingLevel,
    pub toolbox_role: &'static str,
    pub verified_at: &'static str,
    pub evidence_url: &'static str,
}

const MEDIA_INPUTS: &[InputModality] = &[InputModality::Audio, InputModality::Video];

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        model: Model::Gemini35FlashLite,
        api_id: "gemini-3.5-flash-lite",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Minimal,
        toolbox_role: "high-volume text extraction and opt-in media compatibility testing",
        verified_at: "2026-08-10",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite",
    },
    ModelSpec {
        model: Model::Gemini36Flash,
        api_id: "gemini-3.6-flash",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Minimal,
        toolbox_role: "strong multimodal analysis and accuracy-sensitive fallback",
        verified_at: "2026-08-10",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash",
    },
    ModelSpec {
        model: Model::Gemini35Flash,
        api_id: "gemini-3.5-flash",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Minimal,
        toolbox_role: "strong legacy production fallback",
        verified_at: "2026-08-10",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash",
    },
    ModelSpec {
        model: Model::Gemini31FlashLite,
        api_id: "gemini-3.1-flash-lite",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Minimal,
        toolbox_role: "default low-cost transcription, media analysis, and compatibility path",
        verified_at: "2026-08-12",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite",
    },
];

pub const DEFAULT_MODEL: Model = Model::Gemini31FlashLite;
pub const ACCURATE_MODEL: Model = Model::Gemini36Flash;

/// Stable daily-use order. Automatic fallback is left to the application so a
/// retry cannot silently change cost or behavior.
pub const DAILY_USE_CHAIN: &[Model] = &[
    Model::Gemini31FlashLite,
    Model::Gemini36Flash,
    Model::Gemini35FlashLite,
    Model::Gemini35Flash,
];

/// Toolbox-derived intent presets. They choose models and reasoning effort,
/// while the caller remains responsible for prompts and schemas.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DailyUse {
    FastTranscription,
    DirectTranslation,
    HighVolumeExtraction,
    AccurateTranscription,
    VideoUnderstanding,
}

impl DailyUse {
    #[must_use]
    pub const fn model(self) -> Model {
        match self {
            Self::FastTranscription | Self::DirectTranslation | Self::HighVolumeExtraction => {
                DEFAULT_MODEL
            }
            Self::AccurateTranscription | Self::VideoUnderstanding => ACCURATE_MODEL,
        }
    }

    #[must_use]
    pub const fn thinking_level(self) -> ThinkingLevel {
        match self {
            Self::FastTranscription | Self::DirectTranslation | Self::HighVolumeExtraction => {
                ThinkingLevel::Minimal
            }
            Self::AccurateTranscription | Self::VideoUnderstanding => ThinkingLevel::Low,
        }
    }
}

#[must_use]
pub const fn supported_models() -> &'static [ModelSpec] {
    MODELS
}

#[must_use]
pub const fn model_spec(model: Model) -> &'static ModelSpec {
    match model {
        Model::Gemini35FlashLite => &MODELS[0],
        Model::Gemini36Flash => &MODELS[1],
        Model::Gemini35Flash => &MODELS[2],
        Model::Gemini31FlashLite => &MODELS[3],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_stable_media_only_and_unique() {
        let mut ids = std::collections::HashSet::new();
        for spec in supported_models() {
            assert_eq!(spec.lifecycle, Lifecycle::Stable);
            assert!(spec.input_modalities.contains(&InputModality::Audio));
            assert!(spec.input_modalities.contains(&InputModality::Video));
            assert!(ids.insert(spec.api_id));
            assert!(spec.structured_output);
        }
    }

    #[test]
    fn toolbox_daily_defaults_are_locked() {
        assert_eq!(DEFAULT_MODEL.api_id(), "gemini-3.1-flash-lite");
        assert_eq!(ACCURATE_MODEL.api_id(), "gemini-3.6-flash");
        assert_eq!(DailyUse::DirectTranslation.model(), DEFAULT_MODEL);
        assert_eq!(DailyUse::VideoUnderstanding.model(), ACCURATE_MODEL);
        assert_eq!(
            serde_json::to_string(&Model::Gemini35FlashLite).unwrap(),
            "\"gemini-3.5-flash-lite\""
        );
    }

    #[test]
    fn frozen_frontend_catalog_matches_the_native_provider_contract() {
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/config/geminiModelCatalog.json"))
                .expect("frontend Gemini catalog is valid JSON");
        let frontend_ids = catalog["models"]
            .as_array()
            .expect("models array")
            .iter()
            .map(|model| model["id"].as_str().expect("model ID"))
            .collect::<Vec<_>>();
        let native_ids = supported_models()
            .iter()
            .map(|model| model.api_id)
            .collect::<Vec<_>>();

        assert_eq!(frontend_ids, native_ids);
        assert_eq!(catalog["defaults"]["ordinary"], DEFAULT_MODEL.api_id());
        for model in catalog["models"].as_array().expect("models array") {
            assert_eq!(model["lifecycle"], "stable");
            let modalities = model["modalities"].as_array().expect("modalities array");
            assert!(modalities.iter().any(|value| value == "audio"));
            assert!(modalities.iter().any(|value| value == "video"));
        }
    }
}
