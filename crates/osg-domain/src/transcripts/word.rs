//! Timed provider word observations and the shared speaker-label normalization.

use serde::{Deserialize, Deserializer, Serialize};

use super::{
    AlignmentStatus, MAX_SPEAKER_ID_CHARS, MAX_WORD_TEXT_CHARS, TranscriptError, WordProvenance,
};
use crate::ids::{TranscriptRevisionId, WordId};

/// An immutable provider word observation with validated timing and speaker assignment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedWord {
    pub(super) id: WordId,
    pub(super) revision_id: TranscriptRevisionId,
    pub(super) ordinal: u32,
    pub(super) text: String,
    pub(super) raw_start_offset: String,
    pub(super) raw_end_offset: String,
    pub(super) start_ms: i64,
    pub(super) end_ms: i64,
    pub(super) speaker_id: Option<String>,
    pub(super) confidence: Option<f32>,
    pub(super) provenance: WordProvenance,
    pub(super) alignment_status: AlignmentStatus,
}

impl TimedWord {
    /// Creates a newly recognized provider word with a fresh `UUIDv7`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        revision_id: TranscriptRevisionId,
        ordinal: u32,
        text: impl Into<String>,
        raw_start_offset: impl Into<String>,
        raw_end_offset: impl Into<String>,
        start_ms: i64,
        end_ms: i64,
        speaker_id: Option<String>,
        confidence: Option<f32>,
    ) -> Result<Self, TranscriptError> {
        Self::with_id(
            WordId::new(),
            revision_id,
            ordinal,
            text,
            raw_start_offset,
            raw_end_offset,
            start_ms,
            end_ms,
            speaker_id,
            confidence,
            WordProvenance::Provider,
            AlignmentStatus::Aligned,
        )
    }

    /// Full constructor with explicit ID and provenance.
    #[allow(clippy::too_many_arguments)]
    pub fn with_id(
        id: WordId,
        revision_id: TranscriptRevisionId,
        ordinal: u32,
        text: impl Into<String>,
        raw_start_offset: impl Into<String>,
        raw_end_offset: impl Into<String>,
        start_ms: i64,
        end_ms: i64,
        speaker_id: Option<String>,
        confidence: Option<f32>,
        provenance: WordProvenance,
        alignment_status: AlignmentStatus,
    ) -> Result<Self, TranscriptError> {
        Self::restore(
            id,
            revision_id,
            ordinal,
            text.into(),
            raw_start_offset.into(),
            raw_end_offset.into(),
            start_ms,
            end_ms,
            speaker_id,
            confidence,
            provenance,
            alignment_status,
        )
    }

    /// Restores from storage or wire with strict domain validation.
    #[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
    pub fn restore(
        id: WordId,
        revision_id: TranscriptRevisionId,
        ordinal: u32,
        text: String,
        raw_start_offset: String,
        raw_end_offset: String,
        start_ms: i64,
        end_ms: i64,
        speaker_id: Option<String>,
        confidence: Option<f32>,
        provenance: WordProvenance,
        alignment_status: AlignmentStatus,
    ) -> Result<Self, TranscriptError> {
        if start_ms < 0 {
            return Err(TranscriptError::NegativeStart(start_ms));
        }
        if end_ms < start_ms {
            return Err(TranscriptError::InvalidRange { start_ms, end_ms });
        }
        let trimmed_text = text.trim();
        if trimmed_text.is_empty() {
            return Err(TranscriptError::WordTextBlank);
        }
        let char_count = trimmed_text.chars().count();
        if char_count > MAX_WORD_TEXT_CHARS {
            return Err(TranscriptError::WordTextTooLong {
                max_chars: MAX_WORD_TEXT_CHARS,
                actual_chars: char_count,
            });
        }
        if let Some(conf) = confidence.filter(|c| c.is_nan() || !(0.0..=1.0).contains(c)) {
            return Err(TranscriptError::InvalidConfidence(conf));
        }
        let normalized_speaker = normalize_speaker_id(speaker_id)?;

        Ok(Self {
            id,
            revision_id,
            ordinal,
            text: trimmed_text.to_owned(),
            raw_start_offset,
            raw_end_offset,
            start_ms,
            end_ms,
            speaker_id: normalized_speaker,
            confidence,
            provenance,
            alignment_status,
        })
    }

    #[must_use]
    pub const fn id(&self) -> WordId {
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
    pub fn text(&self) -> &str {
        &self.text
    }
    #[must_use]
    pub fn raw_start_offset(&self) -> &str {
        &self.raw_start_offset
    }
    #[must_use]
    pub fn raw_end_offset(&self) -> &str {
        &self.raw_end_offset
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
    pub const fn duration_ms(&self) -> i64 {
        self.end_ms - self.start_ms
    }
    #[must_use]
    pub const fn is_zero_duration(&self) -> bool {
        self.start_ms == self.end_ms
    }
    #[must_use]
    pub fn speaker_id(&self) -> Option<&str> {
        self.speaker_id.as_deref()
    }
    #[must_use]
    pub const fn confidence(&self) -> Option<f32> {
        self.confidence
    }
    #[must_use]
    pub const fn provenance(&self) -> WordProvenance {
        self.provenance
    }
    #[must_use]
    pub const fn alignment_status(&self) -> AlignmentStatus {
        self.alignment_status
    }

    /// Creates a user-corrected version of this word with updated text while retaining
    /// the source timing anchor.
    pub fn with_manual_text(&self, new_text: impl Into<String>) -> Result<Self, TranscriptError> {
        let mut clone = self.clone();
        let new_text = new_text.into();
        let trimmed = new_text.trim();
        if trimmed.is_empty() {
            return Err(TranscriptError::WordTextBlank);
        }
        let char_count = trimmed.chars().count();
        if char_count > MAX_WORD_TEXT_CHARS {
            return Err(TranscriptError::WordTextTooLong {
                max_chars: MAX_WORD_TEXT_CHARS,
                actual_chars: char_count,
            });
        }
        trimmed.clone_into(&mut clone.text);
        clone.provenance = WordProvenance::Manual;
        clone.alignment_status = AlignmentStatus::Modified;
        Ok(clone)
    }

    /// Adjusts boundaries, marking the word as unaligned.
    pub fn with_adjusted_timing(
        &self,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Self, TranscriptError> {
        let mut clone = self.clone();
        if start_ms < 0 {
            return Err(TranscriptError::NegativeStart(start_ms));
        }
        if end_ms < start_ms {
            return Err(TranscriptError::InvalidRange { start_ms, end_ms });
        }
        clone.start_ms = start_ms;
        clone.end_ms = end_ms;
        clone.provenance = WordProvenance::Manual;
        clone.alignment_status = AlignmentStatus::Unaligned;
        Ok(clone)
    }
}

impl<'de> Deserialize<'de> for TimedWord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawWord {
            id: WordId,
            revision_id: TranscriptRevisionId,
            ordinal: u32,
            text: String,
            raw_start_offset: String,
            raw_end_offset: String,
            start_ms: i64,
            end_ms: i64,
            speaker_id: Option<String>,
            confidence: Option<f32>,
            provenance: WordProvenance,
            alignment_status: AlignmentStatus,
        }

        let raw = RawWord::deserialize(deserializer)?;
        Self::restore(
            raw.id,
            raw.revision_id,
            raw.ordinal,
            raw.text,
            raw.raw_start_offset,
            raw.raw_end_offset,
            raw.start_ms,
            raw.end_ms,
            raw.speaker_id,
            raw.confidence,
            raw.provenance,
            raw.alignment_status,
        )
        .map_err(serde::de::Error::custom)
    }
}

/// Trims a speaker label, maps blank to `None`, and rejects control characters or overlong labels.
pub(super) fn normalize_speaker_id(
    speaker_id: Option<String>,
) -> Result<Option<String>, TranscriptError> {
    let Some(speaker) = speaker_id else {
        return Ok(None);
    };
    let s = speaker.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.chars().any(char::is_control) {
        return Err(TranscriptError::InvalidSpeakerId(s.to_owned()));
    }
    let speaker_chars = s.chars().count();
    if speaker_chars > MAX_SPEAKER_ID_CHARS {
        return Err(TranscriptError::SpeakerIdTooLong {
            max_chars: MAX_SPEAKER_ID_CHARS,
            actual_chars: speaker_chars,
        });
    }
    Ok(Some(s.to_owned()))
}
