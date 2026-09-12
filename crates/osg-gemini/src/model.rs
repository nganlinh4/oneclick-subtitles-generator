use std::{fmt, str};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

const MAX_CUSTOM_MODEL_ID_BYTES: usize = 128;
const CUSTOM_MODEL_OUTPUT_TOKEN_LIMIT: u32 = 65_536;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ModelKind {
    Gemini38Flash,
    Gemini35FlashLite,
    Gemini37Flash,
    Gemini36Flash,
    Gemini35Flash,
    Gemini31FlashLite,
    Gemini35Transcribe,
    Custom {
        bytes: [u8; MAX_CUSTOM_MODEL_ID_BYTES],
        len: u8,
    },
}

/// A Gemini REST model identifier. Catalog models may accept media; validated
/// custom identifiers are deliberately text-only until promoted to the catalog.
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub struct Model(ModelKind);

impl fmt::Debug for Model {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Model")
            .field(&self.api_id())
            .finish()
    }
}

#[allow(non_upper_case_globals, reason = "preserve the public enum-like API")]
impl Model {
    pub const Gemini38Flash: Self = Self(ModelKind::Gemini38Flash);
    pub const Gemini35FlashLite: Self = Self(ModelKind::Gemini35FlashLite);
    pub const Gemini37Flash: Self = Self(ModelKind::Gemini37Flash);
    pub const Gemini36Flash: Self = Self(ModelKind::Gemini36Flash);
    pub const Gemini35Flash: Self = Self(ModelKind::Gemini35Flash);
    pub const Gemini31FlashLite: Self = Self(ModelKind::Gemini31FlashLite);
    pub const Gemini35Transcribe: Self = Self(ModelKind::Gemini35Transcribe);

    #[must_use]
    pub const fn kind(&self) -> ModelKind {
        self.0
    }

    /// Parse either one catalog ID or a bounded official-style custom Gemini ID.
    #[must_use]
    pub fn from_api_id(value: &str) -> Option<Self> {
        let built_in = match value {
            "gemini-3.8-flash" => Some(Self::Gemini38Flash),
            "gemini-3.5-flash-lite" => Some(Self::Gemini35FlashLite),
            "gemini-3.7-flash" => Some(Self::Gemini37Flash),
            "gemini-3.6-flash" => Some(Self::Gemini36Flash),
            "gemini-3.5-flash" => Some(Self::Gemini35Flash),
            "gemini-3.1-flash-lite" => Some(Self::Gemini31FlashLite),
            "gemini-3.5-transcribe" => Some(Self::Gemini35Transcribe),
            _ => None,
        };
        if built_in.is_some() {
            return built_in;
        }
        if !is_valid_custom_model_id(value) {
            return None;
        }
        let mut bytes = [0; MAX_CUSTOM_MODEL_ID_BYTES];
        bytes[..value.len()].copy_from_slice(value.as_bytes());
        Some(Self(ModelKind::Custom {
            bytes,
            len: u8::try_from(value.len()).ok()?,
        }))
    }

    /// Provider model ID used in the REST path.
    #[must_use]
    pub fn api_id(&self) -> &str {
        match &self.0 {
            ModelKind::Gemini38Flash => "gemini-3.8-flash",
            ModelKind::Gemini35FlashLite => "gemini-3.5-flash-lite",
            ModelKind::Gemini37Flash => "gemini-3.7-flash",
            ModelKind::Gemini36Flash => "gemini-3.6-flash",
            ModelKind::Gemini35Flash => "gemini-3.5-flash",
            ModelKind::Gemini31FlashLite => "gemini-3.1-flash-lite",
            ModelKind::Gemini35Transcribe => "gemini-3.5-transcribe",
            ModelKind::Custom { bytes, len } => str::from_utf8(&bytes[..usize::from(*len)])
                .expect("custom model IDs are constructed from validated ASCII"),
        }
    }

    /// Centralized provider capabilities and lifecycle metadata.
    #[must_use]
    pub const fn spec(self) -> Option<&'static ModelSpec> {
        model_spec(self)
    }

    /// Whether this model is verified for audio/video input.
    #[must_use]
    pub const fn accepts_media(self) -> bool {
        self.spec().is_some()
    }

    /// Whether the provider contract for this model accepts one thinking level.
    #[must_use]
    pub const fn supports_thinking_level(self, level: ThinkingLevel) -> bool {
        match self.spec() {
            Some(spec) => contains_thinking_level(spec.thinking_levels, level),
            None => false,
        }
    }

    /// Bounded output limit used before contacting the provider.
    #[must_use]
    pub const fn output_token_limit(self) -> u32 {
        match self.spec() {
            Some(spec) => spec.output_token_limit,
            None => CUSTOM_MODEL_OUTPUT_TOKEN_LIMIT,
        }
    }

    /// Whether the identifier is outside the reviewed media catalog.
    #[must_use]
    pub const fn is_custom(self) -> bool {
        matches!(self.0, ModelKind::Custom { .. })
    }
}

impl Serialize for Model {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.api_id())
    }
}

impl<'de> Deserialize<'de> for Model {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_api_id(&value).ok_or_else(|| de::Error::custom("invalid Gemini model ID"))
    }
}

fn is_valid_custom_model_id(value: &str) -> bool {
    if value.len() > MAX_CUSTOM_MODEL_ID_BYTES || !value.starts_with("gemini-") {
        return false;
    }
    let suffix = &value.as_bytes()["gemini-".len()..];
    let is_alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    !suffix.is_empty()
        && suffix.first().is_some_and(|byte| is_alphanumeric(*byte))
        && suffix.last().is_some_and(|byte| is_alphanumeric(*byte))
        && suffix
            .iter()
            .all(|byte| is_alphanumeric(*byte) || matches!(byte, b'-' | b'.'))
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
#[repr(u8)]
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
    pub thinking_levels: &'static [ThinkingLevel],
    pub input_token_limit: u32,
    pub output_token_limit: u32,
    pub toolbox_thinking: ThinkingLevel,
    pub toolbox_role: &'static str,
    pub verified_at: &'static str,
    pub evidence_url: &'static str,
}

const MEDIA_INPUTS: &[InputModality] = &[InputModality::Audio, InputModality::Video];
const ALL_THINKING_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const GEMINI_37_THINKING_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];

const fn contains_thinking_level(levels: &[ThinkingLevel], target: ThinkingLevel) -> bool {
    let mut index = 0;
    while index < levels.len() {
        if levels[index] as u8 == target as u8 {
            return true;
        }
        index += 1;
    }
    false
}

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        model: Model::Gemini35FlashLite,
        api_id: "gemini-3.5-flash-lite",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        thinking_levels: ALL_THINKING_LEVELS,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Minimal,
        toolbox_role: "high-volume text extraction and opt-in media compatibility testing",
        verified_at: "2026-08-10",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite",
    },
    ModelSpec {
        model: Model::Gemini37Flash,
        api_id: "gemini-3.7-flash",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        thinking_levels: GEMINI_37_THINKING_LEVELS,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Low,
        toolbox_role: "newest strong multimodal model for accuracy-sensitive work",
        verified_at: "2026-08-14",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models",
    },
    ModelSpec {
        model: Model::Gemini36Flash,
        api_id: "gemini-3.6-flash",
        lifecycle: Lifecycle::Stable,
        input_modalities: MEDIA_INPUTS,
        output_text: true,
        structured_output: true,
        thinking: true,
        thinking_levels: ALL_THINKING_LEVELS,
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
        thinking_levels: ALL_THINKING_LEVELS,
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
        thinking_levels: ALL_THINKING_LEVELS,
        input_token_limit: 1_048_576,
        output_token_limit: 65_536,
        toolbox_thinking: ThinkingLevel::Minimal,
        toolbox_role: "default low-cost transcription, media analysis, and compatibility path",
        verified_at: "2026-08-12",
        evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite",
    },
    GEMINI_38,
];

const GEMINI_38: ModelSpec = ModelSpec {
    model: Model::Gemini38Flash,
    api_id: "gemini-3.8-flash",
    lifecycle: Lifecycle::Stable,
    input_modalities: MEDIA_INPUTS,
    output_text: true,
    structured_output: true,
    thinking: true,
    thinking_levels: GEMINI_37_THINKING_LEVELS,
    input_token_limit: 1_048_576,
    output_token_limit: 65_536,
    toolbox_thinking: ThinkingLevel::Low,
    toolbox_role: "opt-in multimodal candidate; subtitle quality requires benchmarking",
    verified_at: "2026-09-06",
    evidence_url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash",
};

pub const DEFAULT_MODEL: Model = Model::Gemini31FlashLite;
pub const ACCURATE_MODEL: Model = Model::Gemini36Flash;

/// Stable daily-use order. Automatic fallback is left to the application so a
/// retry cannot silently change cost or behavior.
pub const DAILY_USE_CHAIN: &[Model] = &[
    Model::Gemini31FlashLite,
    Model::Gemini36Flash,
    Model::Gemini37Flash,
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

const AUDIO_ONLY_INPUT: &[InputModality] = &[InputModality::Audio];

pub const GEMINI_35_TRANSCRIBE: ModelSpec = ModelSpec {
    model: Model::Gemini35Transcribe,
    api_id: "gemini-3.5-transcribe",
    lifecycle: Lifecycle::Stable,
    input_modalities: AUDIO_ONLY_INPUT,
    output_text: false,
    structured_output: false,
    thinking: false,
    thinking_levels: &[],
    input_token_limit: 98_304,
    output_token_limit: 32_768,
    toolbox_thinking: ThinkingLevel::Minimal,
    toolbox_role: "dedicated speech transcription with native word timestamps and optional diarization",
    verified_at: "2026-09-06",
    evidence_url: "https://ai.google.dev/gemini-api/docs/transcribe",
};

pub const TRANSCRIPTION_MODELS: &[ModelSpec] = &[GEMINI_35_TRANSCRIBE];

#[must_use]
pub const fn supported_models() -> &'static [ModelSpec] {
    MODELS
}

#[must_use]
pub const fn supported_transcription_models() -> &'static [ModelSpec] {
    TRANSCRIPTION_MODELS
}

#[must_use]
pub const fn model_spec(model: Model) -> Option<&'static ModelSpec> {
    match model.0 {
        ModelKind::Gemini38Flash => Some(&GEMINI_38),
        ModelKind::Gemini35FlashLite => Some(&MODELS[0]),
        ModelKind::Gemini37Flash => Some(&MODELS[1]),
        ModelKind::Gemini36Flash => Some(&MODELS[2]),
        ModelKind::Gemini35Flash => Some(&MODELS[3]),
        ModelKind::Gemini31FlashLite => Some(&MODELS[4]),
        ModelKind::Gemini35Transcribe => Some(&GEMINI_35_TRANSCRIBE),
        ModelKind::Custom { .. } => None,
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
    fn gemini_37_excludes_only_the_provider_rejected_minimal_level() {
        assert!(!Model::Gemini37Flash.supports_thinking_level(ThinkingLevel::Minimal));
        for level in [
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
        ] {
            assert!(Model::Gemini37Flash.supports_thinking_level(level));
        }
        assert_eq!(
            Model::Gemini37Flash.spec().unwrap().toolbox_thinking,
            ThinkingLevel::Low
        );
        assert!(Model::Gemini36Flash.supports_thinking_level(ThinkingLevel::Minimal));
    }

    #[test]
    fn custom_models_are_bounded_text_only_wire_values() {
        let model = Model::from_api_id("gemini-custom-test").expect("valid custom model");
        assert_eq!(model.api_id(), "gemini-custom-test");
        assert!(model.is_custom());
        assert!(!model.accepts_media());
        assert_eq!(model.output_token_limit(), 65_536);
        assert_eq!(
            serde_json::to_string(&model).unwrap(),
            "\"gemini-custom-test\""
        );
        assert_eq!(
            serde_json::from_str::<Model>("\"gemini-custom-test\"").unwrap(),
            model
        );

        for invalid in [
            "models/gemini-3.7-flash",
            "gemini-3.7-flash:generateContent",
            "gemini-../flash",
            "Gemini-3.7-Flash",
            "gemini-",
        ] {
            assert!(Model::from_api_id(invalid).is_none(), "accepted {invalid}");
        }
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
