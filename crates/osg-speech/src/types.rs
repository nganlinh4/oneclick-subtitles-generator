use crate::{Result, SpeechError};
use serde::{Deserialize, Serialize};
use std::fmt;

const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_TEXT_CHARS: usize = 8_000;
const MAX_TIME_MICROS: u64 = 7 * 24 * 60 * 60 * 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechBackend {
    F5Tts,
    Chatterbox,
    EdgeTts,
    Gtts,
    GeminiLive,
}

impl SpeechBackend {
    pub(crate) fn protocol_name(self) -> &'static str {
        match self {
            Self::F5Tts => "f5_tts",
            Self::Chatterbox => "chatterbox",
            Self::EdgeTts => "edge_tts",
            Self::Gtts => "gtts",
            Self::GeminiLive => "gemini_live",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioFormat {
    Wav,
    Mp3,
    M4a,
}

impl AudioFormat {
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SpeechText(String);

impl SpeechText {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        let value = value.trim();
        if value.is_empty() {
            return Err(SpeechError::InvalidInput("speech text is empty"));
        }
        if value.len() > MAX_TEXT_BYTES || value.chars().count() > MAX_TEXT_CHARS {
            return Err(SpeechError::InvalidInput("speech text is too long"));
        }
        if value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err(SpeechError::InvalidInput(
                "speech text contains control characters",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn bytes_len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn chars_len(&self) -> usize {
        self.0.chars().count()
    }
}

impl fmt::Debug for SpeechText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechText")
            .field("bytes", &self.bytes_len())
            .field("characters", &self.chars_len())
            .field("content", &"<redacted>")
            .finish()
    }
}

macro_rules! validated_identifier {
    ($name:ident, $maximum:expr, $validator:expr, $message:literal) => {
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self> {
                let value = value.into();
                if value.is_empty() || value.len() > $maximum || !value.bytes().all($validator) {
                    return Err(SpeechError::InvalidOption($message));
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter
                    .debug_tuple(stringify!($name))
                    .field(&self.0)
                    .finish()
            }
        }

        impl TryFrom<String> for $name {
            type Error = SpeechError;

            fn try_from(value: String) -> Result<Self> {
                Self::new(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

validated_identifier!(
    SegmentId,
    96,
    |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'),
    "invalid segment ID"
);
validated_identifier!(
    VoiceId,
    128,
    |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'),
    "invalid voice ID"
);

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct LanguageTag(String);

impl LanguageTag {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.len() < 2
            || value.len() > 35
            || value.starts_with('-')
            || value.ends_with('-')
            || value.contains("--")
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(SpeechError::InvalidOption("invalid language tag"));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LanguageTag {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("LanguageTag").field(&self.0).finish()
    }
}

impl TryFrom<String> for LanguageTag {
    type Error = SpeechError;

    fn try_from(value: String) -> Result<Self> {
        Self::new(value)
    }
}

impl From<LanguageTag> for String {
    fn from(value: LanguageTag) -> Self {
        value.0
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ModelId(String);

impl ModelId {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 160
            || value.starts_with('/')
            || value.ends_with('/')
            || value.contains("..")
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/')
            })
        {
            return Err(SpeechError::InvalidOption("invalid model ID"));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ModelId").field(&self.0).finish()
    }
}

impl TryFrom<String> for ModelId {
    type Error = SpeechError;

    fn try_from(value: String) -> Result<Self> {
        Self::new(value)
    }
}

impl From<ModelId> for String {
    fn from(value: ModelId) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TimeMicros(u64);

impl TimeMicros {
    pub const ZERO: Self = Self(0);

    pub fn new(value: u64) -> Result<Self> {
        if value <= MAX_TIME_MICROS {
            Ok(Self(value))
        } else {
            Err(SpeechError::InvalidOption("time exceeds seven days"))
        }
    }

    pub fn from_millis(value: u64) -> Result<Self> {
        value
            .checked_mul(1_000)
            .ok_or(SpeechError::InvalidOption("time overflow"))
            .and_then(Self::new)
    }

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    pub fn from_seconds_f64(value: f64) -> Result<Self> {
        if !value.is_finite() || !(0.0..=7.0 * 24.0 * 60.0 * 60.0).contains(&value) {
            return Err(SpeechError::InvalidOption("invalid time value"));
        }
        Self::new((value * 1_000_000.0).round() as u64)
    }

    #[must_use]
    pub fn get(self) -> u64 {
        self.0
    }

    pub fn checked_add(self, other: Self) -> Result<Self> {
        self.0
            .checked_add(other.0)
            .ok_or(SpeechError::InvalidOption("time overflow"))
            .and_then(Self::new)
    }

    #[must_use]
    pub fn saturating_sub(self, other: Self) -> Self {
        Self(self.0.saturating_sub(other.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_bounded_and_debug_redacted() {
        let text = SpeechText::new("top secret narration").unwrap();
        let debug = format!("{text:?}");
        assert!(!debug.contains("top secret"));
        assert!(debug.contains("<redacted>"));
        assert!(SpeechText::new("\0hostile").is_err());
        assert!(SpeechText::new(" ").is_err());
    }

    #[test]
    fn identifiers_reject_selector_and_path_syntax() {
        assert!(SegmentId::new("subtitle_1").is_ok());
        assert!(VoiceId::new("en-US-AriaNeural").is_ok());
        for value in ["../voice", "voice/name", "x;--flag", "line\nbreak"] {
            assert!(VoiceId::new(value).is_err(), "accepted {value}");
        }
        assert!(ModelId::new("models/gemini-live-2.5-flash-native-audio").is_ok());
        assert!(ModelId::new("../../weights/secret").is_err());
    }

    #[test]
    fn time_uses_checked_integer_microseconds() {
        assert_eq!(TimeMicros::from_seconds_f64(1.25).unwrap().get(), 1_250_000);
        assert!(TimeMicros::from_seconds_f64(f64::NAN).is_err());
        assert!(TimeMicros::new(MAX_TIME_MICROS + 1).is_err());
    }
}
