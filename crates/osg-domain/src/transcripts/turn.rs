//! Speaker turns aggregating consecutive words.

use serde::{Deserialize, Deserializer, Serialize};

use super::{
    MAX_TURN_TEXT_CHARS, ScriptSpacing, TimedWord, TranscriptError, word::normalize_speaker_id,
};
use crate::ids::{TranscriptRevisionId, TurnId, WordId};

/// A speaker turn aggregating consecutive words into an utterance unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurn {
    pub(super) id: TurnId,
    pub(super) revision_id: TranscriptRevisionId,
    pub(super) ordinal: u32,
    pub(super) speaker_id: Option<String>,
    pub(super) start_ms: i64,
    pub(super) end_ms: i64,
    pub(super) text: String,
    pub(super) word_ids: Vec<WordId>,
}

impl TranscriptTurn {
    /// Builds a turn directly from a non-empty slice of consecutive `TimedWord`s.
    pub fn from_words(
        revision_id: TranscriptRevisionId,
        ordinal: u32,
        speaker_id: Option<String>,
        words: &[TimedWord],
        spacing: ScriptSpacing,
    ) -> Result<Self, TranscriptError> {
        Self::from_words_with_id(
            TurnId::new(),
            revision_id,
            ordinal,
            speaker_id,
            words,
            spacing,
        )
    }

    pub fn from_words_with_id(
        id: TurnId,
        revision_id: TranscriptRevisionId,
        ordinal: u32,
        speaker_id: Option<String>,
        words: &[TimedWord],
        spacing: ScriptSpacing,
    ) -> Result<Self, TranscriptError> {
        if words.is_empty() {
            return Err(TranscriptError::EmptyTurn);
        }
        let start_ms = words.first().map_or(0, TimedWord::start_ms);
        let end_ms = words.last().map_or(start_ms, TimedWord::end_ms);
        let word_ids: Vec<WordId> = words.iter().map(TimedWord::id).collect();
        let text = words
            .iter()
            .map(TimedWord::text)
            .collect::<Vec<_>>()
            .join(spacing.separator());

        Self::restore(
            id,
            revision_id,
            ordinal,
            speaker_id,
            start_ms,
            end_ms,
            text,
            word_ids,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn restore(
        id: TurnId,
        revision_id: TranscriptRevisionId,
        ordinal: u32,
        speaker_id: Option<String>,
        start_ms: i64,
        end_ms: i64,
        text: String,
        word_ids: Vec<WordId>,
    ) -> Result<Self, TranscriptError> {
        if start_ms < 0 {
            return Err(TranscriptError::NegativeStart(start_ms));
        }
        if end_ms < start_ms {
            return Err(TranscriptError::InvalidRange { start_ms, end_ms });
        }
        if word_ids.is_empty() {
            return Err(TranscriptError::EmptyTurn);
        }
        let char_count = text.chars().count();
        if char_count > MAX_TURN_TEXT_CHARS {
            return Err(TranscriptError::TurnTextTooLong {
                max_chars: MAX_TURN_TEXT_CHARS,
                actual_chars: char_count,
            });
        }
        let normalized_speaker = normalize_speaker_id(speaker_id)?;

        Ok(Self {
            id,
            revision_id,
            ordinal,
            speaker_id: normalized_speaker,
            start_ms,
            end_ms,
            text,
            word_ids,
        })
    }

    #[must_use]
    pub const fn id(&self) -> TurnId {
        self.id
    }
    #[must_use]
    pub const fn revision_id(&self) -> TranscriptRevisionId {
        self.revision_id
    }
    #[must_use]
    pub const fn ordinal(&self) -> u32 {
        self.ordinal
    }
    #[must_use]
    pub fn speaker_id(&self) -> Option<&str> {
        self.speaker_id.as_deref()
    }
    #[must_use]
    pub const fn start_ms(&self) -> i64 {
        self.start_ms
    }
    #[must_use]
    pub const fn end_ms(&self) -> i64 {
        self.end_ms
    }
    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }
    #[must_use]
    pub fn word_ids(&self) -> &[WordId] {
        &self.word_ids
    }
}

impl<'de> Deserialize<'de> for TranscriptTurn {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawTurn {
            id: TurnId,
            revision_id: TranscriptRevisionId,
            ordinal: u32,
            speaker_id: Option<String>,
            start_ms: i64,
            end_ms: i64,
            text: String,
            word_ids: Vec<WordId>,
        }

        let raw = RawTurn::deserialize(deserializer)?;
        Self::restore(
            raw.id,
            raw.revision_id,
            raw.ordinal,
            raw.speaker_id,
            raw.start_ms,
            raw.end_ms,
            raw.text,
            raw.word_ids,
        )
        .map_err(serde::de::Error::custom)
    }
}
