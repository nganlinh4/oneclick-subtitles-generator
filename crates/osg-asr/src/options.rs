use crate::{AsrEngineId, AsrError, Result};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct LanguageCode(String);

impl LanguageCode {
    pub fn new(value: &str) -> Result<Self> {
        let value = value.trim().to_ascii_lowercase();
        if value.len() != 2 || !value.bytes().all(|byte| byte.is_ascii_lowercase()) {
            return Err(AsrError::InvalidOption(
                "language must be a two-letter ISO 639-1 code",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SegmentStrategy {
    #[default]
    Sentence,
    Word,
    Character,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentationOptions {
    strategy: SegmentStrategy,
    max_characters: u16,
    max_words: Option<u8>,
    pause_threshold_ms: u32,
}

impl Default for SegmentationOptions {
    fn default() -> Self {
        Self {
            strategy: SegmentStrategy::Sentence,
            max_characters: 60,
            max_words: Some(7),
            pause_threshold_ms: 800,
        }
    }
}

impl SegmentationOptions {
    pub fn new(
        strategy: SegmentStrategy,
        max_characters: u16,
        max_words: Option<u8>,
        pause_threshold_ms: u32,
    ) -> Result<Self> {
        if !(5..=200).contains(&max_characters) {
            return Err(AsrError::InvalidOption(
                "max characters must be between 5 and 200",
            ));
        }
        if max_words.is_some_and(|value| !(1..=50).contains(&value)) {
            return Err(AsrError::InvalidOption(
                "max words must be between 1 and 50, or absent",
            ));
        }
        if !(100..=5_000).contains(&pause_threshold_ms) {
            return Err(AsrError::InvalidOption(
                "pause threshold must be between 100 and 5000 milliseconds",
            ));
        }
        Ok(Self {
            strategy,
            max_characters,
            max_words,
            pause_threshold_ms,
        })
    }

    #[must_use]
    pub const fn strategy(&self) -> SegmentStrategy {
        self.strategy
    }

    #[must_use]
    pub const fn max_characters(&self) -> u16 {
        self.max_characters
    }

    #[must_use]
    pub const fn max_words(&self) -> Option<u8> {
        self.max_words
    }

    #[must_use]
    pub const fn pause_threshold_ms(&self) -> u32 {
        self.pause_threshold_ms
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptions {
    segmentation: SegmentationOptions,
    language: Option<LanguageCode>,
}

impl TranscriptionOptions {
    #[must_use]
    pub fn new(segmentation: SegmentationOptions) -> Self {
        Self {
            segmentation,
            language: None,
        }
    }

    #[must_use]
    pub fn with_language(mut self, language: LanguageCode) -> Self {
        self.language = Some(language);
        self
    }

    pub(crate) fn validate_for(&self, engine: AsrEngineId) -> Result<()> {
        let Some(language) = &self.language else {
            return Ok(());
        };
        if !engine.supports_forced_language() {
            return Err(AsrError::LanguageUnsupported);
        }
        if matches!(
            engine,
            AsrEngineId::Qwen3Asr1_7b | AsrEngineId::Qwen3Asr0_6b
        ) && !matches!(
            language.as_str(),
            "zh" | "en" | "fr" | "de" | "it" | "ja" | "ko" | "pt" | "ru" | "es"
        ) {
            return Err(AsrError::LanguageUnavailable);
        }
        Ok(())
    }

    pub(crate) fn segmentation(&self) -> &SegmentationOptions {
        &self.segmentation
    }

    pub(crate) fn language(&self) -> Option<&LanguageCode> {
        self.language.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes_are_strict_and_normalized() {
        assert_eq!(LanguageCode::new(" EN ").unwrap().as_str(), "en");
        for invalid in ["", "eng", "e1", "éé", "en-US"] {
            assert!(LanguageCode::new(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn forced_language_contract_matches_the_runtimes() {
        let options =
            TranscriptionOptions::default().with_language(LanguageCode::new("en").unwrap());
        assert!(matches!(
            options.validate_for(AsrEngineId::Parakeet),
            Err(AsrError::LanguageUnsupported)
        ));
        assert!(
            options
                .validate_for(AsrEngineId::FasterWhisperTurbo)
                .is_ok()
        );

        let qwen = TranscriptionOptions::default().with_language(LanguageCode::new("vi").unwrap());
        assert!(matches!(
            qwen.validate_for(AsrEngineId::Qwen3Asr0_6b),
            Err(AsrError::LanguageUnavailable)
        ));
    }

    #[test]
    fn segmentation_limits_match_the_existing_ui_without_silent_clamping() {
        assert!(SegmentationOptions::new(SegmentStrategy::Word, 60, Some(0), 800).is_err());
        assert!(SegmentationOptions::new(SegmentStrategy::Word, 4, Some(7), 800).is_err());
        assert!(SegmentationOptions::new(SegmentStrategy::Word, 60, Some(7), 99).is_err());
        assert!(SegmentationOptions::new(SegmentStrategy::Word, 5, Some(7), 100).is_ok());
    }
}
