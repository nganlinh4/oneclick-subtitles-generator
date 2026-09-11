use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::{
    ids::{AssetId, CueId, ProjectId, ProjectionId, TrackId, TranscriptRevisionId, TurnId, WordId},
    subtitles::{SubtitleCue, SubtitleError, SubtitleTrack, TrackOrigin},
};

pub const MAX_WORD_TEXT_CHARS: usize = 1_000;
pub const MAX_SPEAKER_ID_CHARS: usize = 64;
pub const MAX_TURN_TEXT_CHARS: usize = 100_000;
pub const MAX_PROVIDER_NAME_CHARS: usize = 64;
pub const MAX_MODEL_NAME_CHARS: usize = 128;

/// Provenance of the word's recognized text and timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WordProvenance {
    /// Recognized directly by speech recognition provider (e.g. Gemini 3.5 Transcribe).
    Provider,
    /// Corrected or manually inserted by user in the subtitle editor.
    Manual,
    /// Inferred or interpolated during split/merge operations.
    Interpolated,
}

/// Synchronization alignment status of this word relative to source audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentStatus {
    /// Perfectly aligned to original provider audio timestamp.
    Aligned,
    /// Text was edited or corrected, but original timing anchor is retained.
    Modified,
    /// Boundary was manually dragged or inserted without audio timing anchor.
    Unaligned,
}

/// Language script spacing policy for assembling words into turns and cues.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScriptSpacing {
    /// Standard space separator for Latin, Cyrillic, Greek, Arabic, Hebrew, Vietnamese, etc.
    #[default]
    SpaceSeparated,
    /// No space separator for CJK scripts (Chinese, Japanese, Korean without spaces).
    NoSpaces,
}

impl ScriptSpacing {
    #[must_use]
    pub const fn separator(self) -> &'static str {
        match self {
            Self::SpaceSeparated => " ",
            Self::NoSpaces => "",
        }
    }
}

/// Completion state of a transcript revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionState {
    InProgress,
    Completed,
    Partial,
    Failed,
}

/// An immutable provider word observation with validated timing and speaker assignment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedWord {
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
        let normalized_speaker = if let Some(speaker) = speaker_id {
            let s = speaker.trim();
            if s.is_empty() {
                None
            } else {
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
                Some(s.to_owned())
            }
        } else {
            None
        };

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

/// A speaker turn aggregating consecutive words into an utterance unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurn {
    id: TurnId,
    revision_id: TranscriptRevisionId,
    ordinal: u32,
    speaker_id: Option<String>,
    start_ms: i64,
    end_ms: i64,
    text: String,
    word_ids: Vec<WordId>,
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
        let normalized_speaker = if let Some(speaker) = speaker_id {
            let s = speaker.trim();
            if s.is_empty() {
                None
            } else {
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
                Some(s.to_owned())
            }
        } else {
            None
        };

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

/// Durable aggregate root representing a complete transcription execution.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRevision {
    id: TranscriptRevisionId,
    project_id: ProjectId,
    media_asset_id: Option<AssetId>,
    range_start_ms: i64,
    range_end_ms: i64,
    provider: String,
    model: String,
    contract_version: u32,
    completion_state: CompletionState,
    request_fingerprint: String,
    created_at_ms: i64,
    words: Vec<TimedWord>,
    turns: Vec<TranscriptTurn>,
    #[serde(skip_serializing)]
    word_prefix_max_end_ms: Vec<i64>,
    #[serde(skip_serializing)]
    turn_prefix_max_end_ms: Vec<i64>,
}

impl TranscriptRevision {
    /// Creates a new revision and automatically sorts and indexes words and turns.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        project_id: ProjectId,
        media_asset_id: impl Into<Option<AssetId>>,
        range_start_ms: i64,
        range_end_ms: i64,
        provider: impl Into<String>,
        model: impl Into<String>,
        contract_version: u32,
        completion_state: CompletionState,
        request_fingerprint: impl Into<String>,
        created_at_ms: i64,
        mut words: Vec<TimedWord>,
        mut turns: Vec<TranscriptTurn>,
    ) -> Result<Self, TranscriptError> {
        let revision_id = TranscriptRevisionId::new();

        // Sort words chronologically and assign canonical 1-based ordinals
        words.sort_by_key(|w| (w.start_ms, w.end_ms, w.ordinal));
        for (idx, w) in words.iter_mut().enumerate() {
            w.revision_id = revision_id;
            w.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyWords)?;
        }

        // Sort turns chronologically and assign canonical 1-based ordinals
        turns.sort_by_key(|t| (t.start_ms, t.end_ms, t.ordinal));
        for (idx, t) in turns.iter_mut().enumerate() {
            t.revision_id = revision_id;
            t.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyTurns)?;
        }

        Self::build(
            revision_id,
            project_id,
            media_asset_id.into(),
            range_start_ms,
            range_end_ms,
            provider.into(),
            model.into(),
            contract_version,
            completion_state,
            request_fingerprint.into(),
            created_at_ms,
            words,
            turns,
            true,
        )
    }

    /// Restores an existing revision from persistence with strict validation.
    #[allow(clippy::too_many_arguments)]
    pub fn restore(
        id: TranscriptRevisionId,
        project_id: ProjectId,
        media_asset_id: Option<AssetId>,
        range_start_ms: i64,
        range_end_ms: i64,
        provider: String,
        model: String,
        contract_version: u32,
        completion_state: CompletionState,
        request_fingerprint: String,
        created_at_ms: i64,
        words: Vec<TimedWord>,
        turns: Vec<TranscriptTurn>,
    ) -> Result<Self, TranscriptError> {
        Self::build(
            id,
            project_id,
            media_asset_id,
            range_start_ms,
            range_end_ms,
            provider,
            model,
            contract_version,
            completion_state,
            request_fingerprint,
            created_at_ms,
            words,
            turns,
            false,
        )
    }

    /// Reconstructs a revision with an existing ID, canonicalizing and sorting
    /// words and turns chronologically and reassigning canonical 1-based ordinals.
    #[allow(clippy::too_many_arguments)]
    pub fn reconstruct(
        id: TranscriptRevisionId,
        project_id: ProjectId,
        media_asset_id: impl Into<Option<AssetId>>,
        range_start_ms: i64,
        range_end_ms: i64,
        provider: impl Into<String>,
        model: impl Into<String>,
        contract_version: u32,
        completion_state: CompletionState,
        request_fingerprint: impl Into<String>,
        created_at_ms: i64,
        mut words: Vec<TimedWord>,
        mut turns: Vec<TranscriptTurn>,
    ) -> Result<Self, TranscriptError> {
        // Sort words chronologically and assign canonical 1-based ordinals
        words.sort_by_key(|w| (w.start_ms, w.end_ms, w.ordinal));
        for (idx, w) in words.iter_mut().enumerate() {
            w.revision_id = id;
            w.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyWords)?;
        }

        // Sort turns chronologically and assign canonical 1-based ordinals
        turns.sort_by_key(|t| (t.start_ms, t.end_ms, t.ordinal));
        for (idx, t) in turns.iter_mut().enumerate() {
            t.revision_id = id;
            t.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyTurns)?;
        }

        Self::build(
            id,
            project_id,
            media_asset_id.into(),
            range_start_ms,
            range_end_ms,
            provider.into(),
            model.into(),
            contract_version,
            completion_state,
            request_fingerprint.into(),
            created_at_ms,
            words,
            turns,
            true,
        )
    }

    #[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
    fn build(
        id: TranscriptRevisionId,
        project_id: ProjectId,
        media_asset_id: Option<AssetId>,
        range_start_ms: i64,
        range_end_ms: i64,
        provider: String,
        model: String,
        contract_version: u32,
        completion_state: CompletionState,
        request_fingerprint: String,
        created_at_ms: i64,
        words: Vec<TimedWord>,
        turns: Vec<TranscriptTurn>,
        ordinals_are_normalized: bool,
    ) -> Result<Self, TranscriptError> {
        if range_start_ms < 0 {
            return Err(TranscriptError::NegativeStart(range_start_ms));
        }
        if range_end_ms <= range_start_ms {
            return Err(TranscriptError::InvalidRange {
                start_ms: range_start_ms,
                end_ms: range_end_ms,
            });
        }
        let provider_trimmed = provider.trim();
        if provider_trimmed.is_empty()
            || provider_trimmed.chars().any(char::is_control)
            || provider_trimmed.chars().count() > MAX_PROVIDER_NAME_CHARS
        {
            return Err(TranscriptError::InvalidProvider(
                provider_trimmed.to_owned(),
            ));
        }
        let model_trimmed = model.trim();
        if model_trimmed.is_empty()
            || model_trimmed.chars().any(char::is_control)
            || model_trimmed.chars().count() > MAX_MODEL_NAME_CHARS
        {
            return Err(TranscriptError::InvalidModel(model_trimmed.to_owned()));
        }
        if contract_version == 0 {
            return Err(TranscriptError::InvalidContractVersion(contract_version));
        }
        if request_fingerprint.trim().is_empty() {
            return Err(TranscriptError::InvalidFingerprint(request_fingerprint));
        }

        validate_words(&words, ordinals_are_normalized)?;
        validate_turns(&turns, &words, ordinals_are_normalized)?;

        // Build prefix_max_end_ms for O(log N) spatial lookup
        let mut running_max = i64::MIN;
        let word_prefix_max_end_ms = words
            .iter()
            .map(|w| {
                running_max = running_max.max(w.end_ms);
                running_max
            })
            .collect();

        let mut running_turn_max = i64::MIN;
        let turn_prefix_max_end_ms = turns
            .iter()
            .map(|t| {
                running_turn_max = running_turn_max.max(t.end_ms);
                running_turn_max
            })
            .collect();

        Ok(Self {
            id,
            project_id,
            media_asset_id,
            range_start_ms,
            range_end_ms,
            provider: provider_trimmed.to_owned(),
            model: model_trimmed.to_owned(),
            contract_version,
            completion_state,
            request_fingerprint,
            created_at_ms,
            words,
            turns,
            word_prefix_max_end_ms,
            turn_prefix_max_end_ms,
        })
    }

    #[must_use]
    pub const fn id(&self) -> TranscriptRevisionId {
        self.id
    }
    #[must_use]
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }
    #[must_use]
    pub const fn media_asset_id(&self) -> Option<AssetId> {
        self.media_asset_id
    }
    #[must_use]
    pub const fn range_start_ms(&self) -> i64 {
        self.range_start_ms
    }
    #[must_use]
    pub const fn range_end_ms(&self) -> i64 {
        self.range_end_ms
    }
    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }
    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }
    #[must_use]
    pub const fn contract_version(&self) -> u32 {
        self.contract_version
    }
    #[must_use]
    pub const fn completion_state(&self) -> CompletionState {
        self.completion_state
    }
    #[must_use]
    pub fn request_fingerprint(&self) -> &str {
        &self.request_fingerprint
    }
    #[must_use]
    pub const fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }
    #[must_use]
    pub fn words(&self) -> &[TimedWord] {
        &self.words
    }
    #[must_use]
    pub fn turns(&self) -> &[TranscriptTurn] {
        &self.turns
    }
    #[must_use]
    pub fn total_words(&self) -> usize {
        self.words.len()
    }

    /// O(log N) spatial lookup for the word actively spoken at `time_ms`.
    #[must_use]
    pub fn active_word_at(&self, time_ms: i64) -> Option<&TimedWord> {
        let upper_bound = self.words.partition_point(|w| w.start_ms <= time_ms);
        if upper_bound == 0 {
            return None;
        }

        let mut index = upper_bound - 1;
        loop {
            let word = &self.words[index];
            if word.end_ms > time_ms {
                return Some(word);
            }
            if index == 0 || self.word_prefix_max_end_ms[index - 1] <= time_ms {
                return None;
            }
            index -= 1;
        }
    }

    /// O(log N) lookup for the speaker turn active at `time_ms`.
    #[must_use]
    pub fn active_turn_at(&self, time_ms: i64) -> Option<&TranscriptTurn> {
        let upper_bound = self.turns.partition_point(|t| t.start_ms <= time_ms);
        if upper_bound == 0 {
            return None;
        }
        let mut index = upper_bound - 1;
        loop {
            let turn = &self.turns[index];
            if turn.end_ms >= time_ms && turn.start_ms <= time_ms {
                return Some(turn);
            }
            if index == 0 || self.turn_prefix_max_end_ms[index - 1] < time_ms {
                return None;
            }
            index -= 1;
        }
    }

    /// O(log N) lookup for all speaker turns actively speaking at `time_ms`.
    #[must_use]
    pub fn active_turns_at(&self, time_ms: i64) -> Vec<&TranscriptTurn> {
        let upper_bound = self.turns.partition_point(|t| t.start_ms <= time_ms);
        if upper_bound == 0 {
            return Vec::new();
        }
        let mut active = Vec::new();
        let mut index = upper_bound - 1;
        loop {
            let turn = &self.turns[index];
            if turn.end_ms >= time_ms && turn.start_ms <= time_ms {
                active.push(turn);
            }
            if index == 0 || self.turn_prefix_max_end_ms[index - 1] < time_ms {
                break;
            }
            index -= 1;
        }
        active.reverse();
        active
    }

    /// Efficient range query for all words intersecting [`start_ms`, `end_ms`).
    #[must_use]
    pub fn words_in_range(&self, start_ms: i64, end_ms: i64) -> Vec<&TimedWord> {
        if start_ms >= end_ms || self.words.is_empty() {
            return Vec::new();
        }
        let lower = self
            .word_prefix_max_end_ms
            .partition_point(|&max_end| max_end < start_ms);
        let upper = self.words.partition_point(|w| w.start_ms < end_ms);
        if lower >= upper {
            return Vec::new();
        }
        self.words[lower..upper]
            .iter()
            .filter(|w| {
                w.start_ms < end_ms
                    && (w.end_ms > start_ms || (w.is_zero_duration() && w.start_ms >= start_ms))
            })
            .collect()
    }

    /// Looks up a word by its unique `UUIDv7`.
    #[must_use]
    pub fn find_word(&self, word_id: WordId) -> Option<&TimedWord> {
        self.words.iter().find(|w| w.id == word_id)
    }

    /// Looks up a turn by its unique `UUIDv7`.
    #[must_use]
    pub fn find_turn(&self, turn_id: TurnId) -> Option<&TranscriptTurn> {
        self.turns.iter().find(|t| t.id == turn_id)
    }
}

impl<'de> Deserialize<'de> for TranscriptRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawRevision {
            id: TranscriptRevisionId,
            project_id: ProjectId,
            media_asset_id: Option<AssetId>,
            range_start_ms: i64,
            range_end_ms: i64,
            provider: String,
            model: String,
            contract_version: u32,
            completion_state: CompletionState,
            request_fingerprint: String,
            created_at_ms: i64,
            words: Vec<TimedWord>,
            turns: Vec<TranscriptTurn>,
        }

        let raw = RawRevision::deserialize(deserializer)?;
        Self::restore(
            raw.id,
            raw.project_id,
            raw.media_asset_id,
            raw.range_start_ms,
            raw.range_end_ms,
            raw.provider,
            raw.model,
            raw.contract_version,
            raw.completion_state,
            raw.request_fingerprint,
            raw.created_at_ms,
            raw.words,
            raw.turns,
        )
        .map_err(serde::de::Error::custom)
    }
}

fn validate_words(
    words: &[TimedWord],
    ordinals_are_normalized: bool,
) -> Result<(), TranscriptError> {
    let mut ids = HashSet::with_capacity(words.len());
    let mut prev: Option<&TimedWord> = None;
    for (index, word) in words.iter().enumerate() {
        if !ids.insert(word.id) {
            return Err(TranscriptError::DuplicateWord(word.id));
        }
        if !ordinals_are_normalized {
            let expected = u32::try_from(index + 1).map_err(|_| TranscriptError::TooManyWords)?;
            if word.ordinal != expected {
                return Err(TranscriptError::InvalidWordOrdinal {
                    expected,
                    received: word.ordinal,
                });
            }
        }
        if let Some(prev_w) = prev
            && (word.start_ms < prev_w.start_ms
                || (word.start_ms == prev_w.start_ms && word.end_ms < prev_w.end_ms))
        {
            return Err(TranscriptError::UnsortedWords {
                prev_ordinal: prev_w.ordinal,
                prev_start_ms: prev_w.start_ms,
                current_ordinal: word.ordinal,
                current_start_ms: word.start_ms,
            });
        }
        prev = Some(word);
    }
    Ok(())
}

fn validate_turns(
    turns: &[TranscriptTurn],
    words: &[TimedWord],
    ordinals_are_normalized: bool,
) -> Result<(), TranscriptError> {
    let word_id_set: HashSet<WordId> = words.iter().map(TimedWord::id).collect();
    let mut turn_ids = HashSet::with_capacity(turns.len());
    let mut claimed_words = HashSet::with_capacity(words.len());
    let mut prev: Option<&TranscriptTurn> = None;

    for (index, turn) in turns.iter().enumerate() {
        if !turn_ids.insert(turn.id) {
            return Err(TranscriptError::DuplicateTurn(turn.id));
        }
        if !ordinals_are_normalized {
            let expected = u32::try_from(index + 1).map_err(|_| TranscriptError::TooManyTurns)?;
            if turn.ordinal != expected {
                return Err(TranscriptError::InvalidTurnOrdinal {
                    expected,
                    received: turn.ordinal,
                });
            }
        }
        if let Some(prev_t) = prev
            && (turn.start_ms < prev_t.start_ms
                || (turn.start_ms == prev_t.start_ms && turn.end_ms < prev_t.end_ms))
        {
            return Err(TranscriptError::UnsortedTurns {
                prev_ordinal: prev_t.ordinal,
                prev_start_ms: prev_t.start_ms,
                current_ordinal: turn.ordinal,
                current_start_ms: turn.start_ms,
            });
        }
        prev = Some(turn);

        for word_id in &turn.word_ids {
            if !word_id_set.contains(word_id) {
                return Err(TranscriptError::UnknownWordInTurn {
                    turn_id: turn.id,
                    word_id: *word_id,
                });
            }
            if !claimed_words.insert(*word_id) {
                return Err(TranscriptError::WordInMultipleTurns(*word_id));
            }
        }
    }
    Ok(())
}

/// Local offline regrouping policies supported without network calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GroupingPolicy {
    /// Natural phrasing based on pause duration and sentence punctuation.
    Natural {
        /// Pause between words in milliseconds to trigger a split (default: 300 ms).
        pause_threshold_ms: u32,
        /// Maximum words per cue (default: 12).
        max_words: u32,
        /// Maximum characters per line/cue (default: 42).
        max_characters: u32,
    },
    /// Short subtitle chunks for rapid speech or mobile views.
    Short {
        /// Maximum words per cue (default: 5).
        max_words: u32,
        /// Maximum cue duration in milliseconds (default: 2,500 ms).
        max_duration_ms: i64,
    },
    /// Rapid dynamic captioning: exactly one word per cue.
    OneWord {
        /// Minimum duration in milliseconds to avoid zero-duration cues (default: 50 ms).
        min_duration_ms: i64,
    },
    /// User customized parameters via UI sliders.
    Custom(CustomGroupingConfig),
}

impl Default for GroupingPolicy {
    fn default() -> Self {
        Self::Natural {
            pause_threshold_ms: 300,
            max_words: 12,
            max_characters: 42,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGroupingConfig {
    pub max_words: Option<u32>,
    pub max_characters: Option<u32>,
    pub max_duration_ms: Option<i64>,
    pub pause_threshold_ms: u32,
    pub split_on_punctuation: bool,
}

/// Tracking state of manual user edits on a projected cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ManualEditState {
    /// Pure projection derived directly from words; can be freely reflowed.
    #[default]
    Clean,
    /// User edited the cue text; protected from automatic reflow overwrite.
    EditedText,
    /// User dragged timeline start/end boundaries.
    AdjustedTiming,
    /// Explicitly locked by user against any grouping changes.
    Locked,
}

/// Synchronization alignment state of a projected cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentState {
    /// All underlying words are verbatim provider aligned.
    #[default]
    FullyAligned,
    /// Some words were manually edited or inserted.
    PartiallyAligned,
    /// Cue boundary dragged or synthetic interval without direct word timing.
    Unaligned,
}

/// Link to source word span for translation tracks (prevents fake target word timestamps).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceWordSpan {
    pub revision_id: TranscriptRevisionId,
    pub start_word_id: WordId,
    pub end_word_id: WordId,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// A subtitle cue projected from one or more words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedCue {
    pub id: CueId,
    pub ordinal: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub word_ids: Vec<WordId>,
    pub manual_state: ManualEditState,
    pub alignment_state: AlignmentState,
    pub source_span: Option<SourceWordSpan>,
}

/// Derived caption projection over a durable transcript revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionProjection {
    id: ProjectionId,
    revision_id: TranscriptRevisionId,
    track_id: TrackId,
    policy: GroupingPolicy,
    cues: Vec<ProjectedCue>,
}

impl CaptionProjection {
    /// Creates a complete caption projection from a revision using the given policy.
    /// Runs 100% offline with zero network calls.
    pub fn project(
        revision: &TranscriptRevision,
        track_id: TrackId,
        policy: GroupingPolicy,
        spacing: ScriptSpacing,
    ) -> Result<Self, TranscriptError> {
        let words = revision.words();
        if words.is_empty() {
            return Ok(Self {
                id: ProjectionId::new(),
                revision_id: revision.id(),
                track_id,
                policy,
                cues: Vec::new(),
            });
        }

        let cues = match &policy {
            GroupingPolicy::OneWord { min_duration_ms } => {
                Self::project_one_word(words, *min_duration_ms)?
            }
            GroupingPolicy::Short {
                max_words,
                max_duration_ms,
            } => Self::project_short(words, *max_words, *max_duration_ms, spacing)?,
            GroupingPolicy::Natural {
                pause_threshold_ms,
                max_words,
                max_characters,
            } => Self::project_natural(
                words,
                *pause_threshold_ms,
                *max_words,
                *max_characters,
                spacing,
            )?,
            GroupingPolicy::Custom(config) => Self::project_custom(words, config, spacing)?,
        };

        Ok(Self {
            id: ProjectionId::new(),
            revision_id: revision.id(),
            track_id,
            policy,
            cues,
        })
    }

    /// Regroups captions under a new policy while strictly preserving manual user edits.
    pub fn regroup_preserving_edits(
        &self,
        revision: &TranscriptRevision,
        new_policy: GroupingPolicy,
        spacing: ScriptSpacing,
    ) -> Result<Self, TranscriptError> {
        let mut preserved: Vec<ProjectedCue> = self
            .cues
            .iter()
            .filter(|c| c.manual_state != ManualEditState::Clean)
            .cloned()
            .collect();

        if preserved.is_empty() {
            return Self::project(revision, self.track_id, new_policy, spacing);
        }

        let preserved_word_ids: HashSet<WordId> = preserved
            .iter()
            .flat_map(|c| c.word_ids.iter().copied())
            .collect();

        let mut unprojected_slices: Vec<Vec<TimedWord>> = Vec::new();
        let mut current_slice: Vec<TimedWord> = Vec::new();

        for word in revision.words() {
            if preserved_word_ids.contains(&word.id()) {
                if !current_slice.is_empty() {
                    unprojected_slices.push(std::mem::take(&mut current_slice));
                }
            } else {
                current_slice.push(word.clone());
            }
        }
        if !current_slice.is_empty() {
            unprojected_slices.push(current_slice);
        }

        let mut fresh_cues: Vec<ProjectedCue> = Vec::new();
        for slice in unprojected_slices {
            let slice_cues = Self::project_slice(&slice, &new_policy, spacing)?;
            fresh_cues.extend(slice_cues);
        }

        preserved.extend(fresh_cues);
        preserved.sort_by_key(|c| (c.start_ms, c.end_ms));
        for (idx, cue) in preserved.iter_mut().enumerate() {
            cue.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?;
        }

        Ok(Self {
            id: ProjectionId::new(),
            revision_id: revision.id(),
            track_id: self.track_id,
            policy: new_policy,
            cues: preserved,
        })
    }

    /// Splits an existing cue at the given word index into two new cues.
    #[allow(clippy::similar_names)]
    pub fn split_cue(
        &mut self,
        cue_id: CueId,
        at_word_index: usize,
        revision: &TranscriptRevision,
        spacing: ScriptSpacing,
    ) -> Result<(CueId, CueId), TranscriptError> {
        let pos = self
            .cues
            .iter()
            .position(|c| c.id == cue_id)
            .ok_or(TranscriptError::CueNotFound(cue_id))?;
        let cue = &self.cues[pos];
        if at_word_index == 0 || at_word_index >= cue.word_ids.len() {
            return Err(TranscriptError::InvalidSplitIndex);
        }

        let first_word_ids = cue.word_ids[..at_word_index].to_vec();
        let second_word_ids = cue.word_ids[at_word_index..].to_vec();

        let first_words: Vec<&TimedWord> = first_word_ids
            .iter()
            .filter_map(|id| revision.find_word(*id))
            .collect();
        let second_words: Vec<&TimedWord> = second_word_ids
            .iter()
            .filter_map(|id| revision.find_word(*id))
            .collect();

        if first_words.is_empty() || second_words.is_empty() {
            return Err(TranscriptError::WordNotFound);
        }

        let cue1_id = CueId::new();
        let cue2_id = CueId::new();

        let start_ms1 = first_words[0].start_ms();
        let mut end_ms1 = first_words
            .iter()
            .map(|w| w.end_ms())
            .max()
            .unwrap_or(start_ms1);
        if end_ms1 <= start_ms1 {
            end_ms1 = start_ms1 + 50;
        }

        let start_ms2 = second_words[0].start_ms();
        let mut end_ms2 = second_words
            .iter()
            .map(|w| w.end_ms())
            .max()
            .unwrap_or(start_ms2);
        if end_ms2 <= start_ms2 {
            end_ms2 = start_ms2 + 50;
        }

        let source_span1 = cue.source_span.as_ref().map(|s| SourceWordSpan {
            revision_id: s.revision_id,
            start_word_id: first_word_ids[0],
            end_word_id: *first_word_ids.last().unwrap(),
            start_ms: start_ms1,
            end_ms: end_ms1,
        });

        let source_span2 = cue.source_span.as_ref().map(|s| SourceWordSpan {
            revision_id: s.revision_id,
            start_word_id: second_word_ids[0],
            end_word_id: *second_word_ids.last().unwrap(),
            start_ms: start_ms2,
            end_ms: end_ms2,
        });

        let cue1 = ProjectedCue {
            id: cue1_id,
            ordinal: cue.ordinal,
            start_ms: start_ms1,
            end_ms: end_ms1,
            text: first_words
                .iter()
                .map(|w| w.text())
                .collect::<Vec<_>>()
                .join(spacing.separator()),
            word_ids: first_word_ids,
            manual_state: ManualEditState::EditedText,
            alignment_state: cue.alignment_state,
            source_span: source_span1,
        };

        let cue2 = ProjectedCue {
            id: cue2_id,
            ordinal: cue.ordinal + 1,
            start_ms: start_ms2,
            end_ms: end_ms2,
            text: second_words
                .iter()
                .map(|w| w.text())
                .collect::<Vec<_>>()
                .join(spacing.separator()),
            word_ids: second_word_ids,
            manual_state: ManualEditState::EditedText,
            alignment_state: cue.alignment_state,
            source_span: source_span2,
        };

        self.cues.remove(pos);
        self.cues.insert(pos, cue2);
        self.cues.insert(pos, cue1);

        for (idx, c) in self.cues.iter_mut().enumerate() {
            c.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?;
        }

        Ok((cue1_id, cue2_id))
    }

    /// Merges two adjacent cues into one.
    pub fn merge_cues(
        &mut self,
        first_cue_id: CueId,
        second_cue_id: CueId,
        _revision: &TranscriptRevision,
        spacing: ScriptSpacing,
    ) -> Result<CueId, TranscriptError> {
        let pos1 = self
            .cues
            .iter()
            .position(|c| c.id == first_cue_id)
            .ok_or(TranscriptError::CueNotFound(first_cue_id))?;
        let pos2 = self
            .cues
            .iter()
            .position(|c| c.id == second_cue_id)
            .ok_or(TranscriptError::CueNotFound(second_cue_id))?;

        if pos1 + 1 != pos2 {
            return Err(TranscriptError::CuesNotAdjacent);
        }

        let cue1 = &self.cues[pos1];
        let cue2 = &self.cues[pos2];

        let mut merged_word_ids = cue1.word_ids.clone();
        merged_word_ids.extend_from_slice(&cue2.word_ids);

        let text = match (cue1.text.is_empty(), cue2.text.is_empty()) {
            (true, true) => String::new(),
            (true, false) => cue2.text.clone(),
            (false, true) => cue1.text.clone(),
            (false, false) => {
                let sep = spacing.separator();
                if sep.is_empty()
                    || cue1.text.ends_with(char::is_whitespace)
                    || cue2.text.starts_with(char::is_whitespace)
                {
                    format!("{}{}", cue1.text, cue2.text)
                } else {
                    format!("{}{}{}", cue1.text, sep, cue2.text)
                }
            }
        };

        let start_ms = cue1.start_ms.min(cue2.start_ms);
        let mut end_ms = cue1.end_ms.max(cue2.end_ms);
        if end_ms <= start_ms {
            end_ms = start_ms + 50;
        }

        let manual_state = if cue1.manual_state == ManualEditState::Locked
            || cue2.manual_state == ManualEditState::Locked
        {
            ManualEditState::Locked
        } else {
            ManualEditState::EditedText
        };

        let source_span = match (&cue1.source_span, &cue2.source_span) {
            (Some(s1), Some(s2)) if s1.revision_id == s2.revision_id => Some(SourceWordSpan {
                revision_id: s1.revision_id,
                start_word_id: s1.start_word_id,
                end_word_id: s2.end_word_id,
                start_ms: s1.start_ms.min(s2.start_ms),
                end_ms: s1.end_ms.max(s2.end_ms),
            }),
            (Some(s1), None) => Some(s1.clone()),
            (None, Some(s2)) => Some(s2.clone()),
            _ => None,
        };

        let new_cue_id = CueId::new();
        let merged_cue = ProjectedCue {
            id: new_cue_id,
            ordinal: cue1.ordinal,
            start_ms,
            end_ms,
            text,
            word_ids: merged_word_ids,
            manual_state,
            alignment_state: if cue1.alignment_state == AlignmentState::FullyAligned
                && cue2.alignment_state == AlignmentState::FullyAligned
            {
                AlignmentState::FullyAligned
            } else {
                AlignmentState::PartiallyAligned
            },
            source_span,
        };

        self.cues.remove(pos2);
        self.cues[pos1] = merged_cue;

        for (idx, c) in self.cues.iter_mut().enumerate() {
            c.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?;
        }

        Ok(new_cue_id)
    }

    /// Converts this projection into a standard `SubtitleTrack` for editor preview and export.
    pub fn to_subtitle_track(
        &self,
        label: impl Into<String>,
        origin: TrackOrigin,
    ) -> Result<SubtitleTrack, SubtitleError> {
        let mut subtitle_cues = Vec::with_capacity(self.cues.len());
        for cue in &self.cues {
            let subtitle_cue = SubtitleCue::restore(
                cue.id,
                cue.ordinal,
                cue.start_ms,
                cue.end_ms,
                cue.text.clone(),
                None,
            )?;
            subtitle_cues.push(subtitle_cue);
        }
        SubtitleTrack::new(label, origin, subtitle_cues)
    }

    /// Extracts relational cue-word mappings for the `cue_word_mappings` `SQLite` table.
    #[must_use]
    pub fn cue_word_mappings(&self) -> Vec<(CueId, Vec<WordId>)> {
        self.cues
            .iter()
            .map(|c| (c.id, c.word_ids.clone()))
            .collect()
    }

    /// Finds the active word inside a cue at playback time `time_ms` for word-synchronized reveal styling.
    #[must_use]
    pub fn active_word_in_cue<'a>(
        &self,
        cue: &ProjectedCue,
        revision: &'a TranscriptRevision,
        time_ms: i64,
    ) -> Option<&'a TimedWord> {
        if time_ms < cue.start_ms || time_ms >= cue.end_ms {
            return None;
        }
        for word_id in &cue.word_ids {
            if let Some(word) = revision
                .find_word(*word_id)
                .filter(|w| w.start_ms() <= time_ms && time_ms < w.end_ms())
            {
                return Some(word);
            }
        }
        None
    }

    #[must_use]
    pub const fn id(&self) -> ProjectionId {
        self.id
    }
    #[must_use]
    pub const fn revision_id(&self) -> TranscriptRevisionId {
        self.revision_id
    }
    #[must_use]
    pub const fn track_id(&self) -> TrackId {
        self.track_id
    }
    #[must_use]
    pub fn policy(&self) -> &GroupingPolicy {
        &self.policy
    }
    #[must_use]
    pub fn cues(&self) -> &[ProjectedCue] {
        &self.cues
    }
}

impl CaptionProjection {
    fn project_one_word(
        words: &[TimedWord],
        min_duration_ms: i64,
    ) -> Result<Vec<ProjectedCue>, TranscriptError> {
        let mut cues = Vec::with_capacity(words.len());
        for (idx, word) in words.iter().enumerate() {
            let start_ms = word.start_ms();
            let mut end_ms = word.end_ms();
            if end_ms <= start_ms {
                end_ms = start_ms + min_duration_ms.max(1);
            }
            cues.push(ProjectedCue {
                id: CueId::new(),
                ordinal: u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?,
                start_ms,
                end_ms,
                text: word.text().to_owned(),
                word_ids: vec![word.id()],
                manual_state: ManualEditState::Clean,
                alignment_state: AlignmentState::FullyAligned,
                source_span: None,
            });
        }
        Ok(cues)
    }

    fn project_natural(
        words: &[TimedWord],
        pause_threshold_ms: u32,
        max_words: u32,
        max_characters: u32,
        spacing: ScriptSpacing,
    ) -> Result<Vec<ProjectedCue>, TranscriptError> {
        let mut cues = Vec::new();
        let mut start_idx = 0;

        for (idx, word) in words.iter().enumerate() {
            let is_last = idx + 1 == words.len();
            let pause = words
                .get(idx + 1)
                .map_or(0, |next| (next.start_ms() - word.end_ms()).max(0));
            let word_count = u32::try_from(idx + 1 - start_idx).unwrap_or(u32::MAX);
            let current_text_len: usize = words[start_idx..=idx]
                .iter()
                .map(|w| w.text().chars().count())
                .sum::<usize>()
                + spacing.separator().chars().count() * (idx - start_idx);

            let is_sentence_end = ends_sentence(word.text());
            let exceeds_pause = pause >= i64::from(pause_threshold_ms);
            let exceeds_words = word_count >= max_words;
            let exceeds_chars = current_text_len >= max_characters as usize;

            if is_last || exceeds_pause || is_sentence_end || exceeds_words || exceeds_chars {
                cues.push(Self::create_cue_from_slice(
                    &words[start_idx..=idx],
                    cues.len() + 1,
                    spacing,
                )?);
                start_idx = idx + 1;
            }
        }
        Ok(cues)
    }

    fn project_short(
        words: &[TimedWord],
        max_words: u32,
        max_duration_ms: i64,
        spacing: ScriptSpacing,
    ) -> Result<Vec<ProjectedCue>, TranscriptError> {
        let mut cues = Vec::new();
        let mut start_idx = 0;
        let mut slice_max_end = i64::MIN;

        for (idx, word) in words.iter().enumerate() {
            let is_last = idx + 1 == words.len();
            let word_count = u32::try_from(idx + 1 - start_idx).unwrap_or(u32::MAX);
            slice_max_end = slice_max_end.max(word.end_ms());
            let duration = slice_max_end - words[start_idx].start_ms();

            if is_last || word_count >= max_words || duration >= max_duration_ms {
                cues.push(Self::create_cue_from_slice(
                    &words[start_idx..=idx],
                    cues.len() + 1,
                    spacing,
                )?);
                start_idx = idx + 1;
                slice_max_end = i64::MIN;
            }
        }
        Ok(cues)
    }

    fn project_custom(
        words: &[TimedWord],
        config: &CustomGroupingConfig,
        spacing: ScriptSpacing,
    ) -> Result<Vec<ProjectedCue>, TranscriptError> {
        let mut cues = Vec::new();
        let mut start_idx = 0;
        let mut slice_max_end = i64::MIN;

        for (idx, word) in words.iter().enumerate() {
            let is_last = idx + 1 == words.len();
            let pause = words
                .get(idx + 1)
                .map_or(0, |next| (next.start_ms() - word.end_ms()).max(0));
            let word_count = u32::try_from(idx + 1 - start_idx).unwrap_or(u32::MAX);
            slice_max_end = slice_max_end.max(word.end_ms());
            let duration = slice_max_end - words[start_idx].start_ms();
            let current_text_len: usize = words[start_idx..=idx]
                .iter()
                .map(|w| w.text().chars().count())
                .sum::<usize>()
                + spacing.separator().chars().count() * (idx - start_idx);

            let pause_hit = pause >= i64::from(config.pause_threshold_ms);
            let punct_hit = config.split_on_punctuation && ends_sentence(word.text());
            let words_hit = config.max_words.is_some_and(|m| word_count >= m);
            let chars_hit = config
                .max_characters
                .is_some_and(|m| current_text_len >= m as usize);
            let dur_hit = config.max_duration_ms.is_some_and(|d| duration >= d);

            if is_last || pause_hit || punct_hit || words_hit || chars_hit || dur_hit {
                cues.push(Self::create_cue_from_slice(
                    &words[start_idx..=idx],
                    cues.len() + 1,
                    spacing,
                )?);
                start_idx = idx + 1;
                slice_max_end = i64::MIN;
            }
        }
        Ok(cues)
    }

    fn project_slice(
        words: &[TimedWord],
        policy: &GroupingPolicy,
        spacing: ScriptSpacing,
    ) -> Result<Vec<ProjectedCue>, TranscriptError> {
        match policy {
            GroupingPolicy::OneWord { min_duration_ms } => {
                Self::project_one_word(words, *min_duration_ms)
            }
            GroupingPolicy::Short {
                max_words,
                max_duration_ms,
            } => Self::project_short(words, *max_words, *max_duration_ms, spacing),
            GroupingPolicy::Natural {
                pause_threshold_ms,
                max_words,
                max_characters,
            } => Self::project_natural(
                words,
                *pause_threshold_ms,
                *max_words,
                *max_characters,
                spacing,
            ),
            GroupingPolicy::Custom(cfg) => Self::project_custom(words, cfg, spacing),
        }
    }

    fn create_cue_from_slice(
        words: &[TimedWord],
        ordinal: usize,
        spacing: ScriptSpacing,
    ) -> Result<ProjectedCue, TranscriptError> {
        let start_ms = words[0].start_ms();
        let mut end_ms = words
            .iter()
            .map(TimedWord::end_ms)
            .max()
            .unwrap_or(start_ms);
        if end_ms <= start_ms {
            end_ms = start_ms + 50;
        }
        let text = words
            .iter()
            .map(TimedWord::text)
            .collect::<Vec<_>>()
            .join(spacing.separator());
        let word_ids = words.iter().map(TimedWord::id).collect();

        Ok(ProjectedCue {
            id: CueId::new(),
            ordinal: u32::try_from(ordinal).map_err(|_| TranscriptError::TooManyCues)?,
            start_ms,
            end_ms,
            text,
            word_ids,
            manual_state: ManualEditState::Clean,
            alignment_state: AlignmentState::FullyAligned,
            source_span: None,
        })
    }
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end().ends_with(['.', '?', '!', '。', '？', '！'])
}

/// Errors raised when validating or operating on transcript domain models.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum TranscriptError {
    #[error("timestamp cannot be negative (received {0} ms)")]
    NegativeStart(i64),

    #[error(
        "invalid time range: end timestamp ({end_ms} ms) must be >= start timestamp ({start_ms} ms)"
    )]
    InvalidRange { start_ms: i64, end_ms: i64 },

    #[error("word text cannot be empty or solely whitespace")]
    WordTextBlank,

    #[error("word text too long: {actual_chars} characters exceeds limit of {max_chars}")]
    WordTextTooLong {
        max_chars: usize,
        actual_chars: usize,
    },

    #[error("turn text too long: {actual_chars} characters exceeds limit of {max_chars}")]
    TurnTextTooLong {
        max_chars: usize,
        actual_chars: usize,
    },

    #[error("invalid confidence value: {0} (must be between 0.0 and 1.0)")]
    InvalidConfidence(f32),

    #[error("invalid speaker identifier: `{0}` contains control characters")]
    InvalidSpeakerId(String),

    #[error("speaker identifier too long: {actual_chars} characters exceeds limit of {max_chars}")]
    SpeakerIdTooLong {
        max_chars: usize,
        actual_chars: usize,
    },

    #[error("invalid provider name: `{0}`")]
    InvalidProvider(String),

    #[error("invalid model name: `{0}`")]
    InvalidModel(String),

    #[error("invalid contract version: {0} (must be >= 1)")]
    InvalidContractVersion(u32),

    #[error("invalid request fingerprint: `{0}`")]
    InvalidFingerprint(String),

    #[error("turn cannot be empty")]
    EmptyTurn,

    #[error("duplicate word ID `{0}`")]
    DuplicateWord(WordId),

    #[error("duplicate turn ID `{0}`")]
    DuplicateTurn(TurnId),

    #[error("invalid word ordinal: expected {expected}, received {received}")]
    InvalidWordOrdinal { expected: u32, received: u32 },

    #[error("invalid turn ordinal: expected {expected}, received {received}")]
    InvalidTurnOrdinal { expected: u32, received: u32 },

    #[error("turn `{turn_id}` references unknown word `{word_id}`")]
    UnknownWordInTurn { turn_id: TurnId, word_id: WordId },

    #[error("word `{0}` is referenced in multiple turns")]
    WordInMultipleTurns(WordId),

    #[error("cue `{0}` was not found")]
    CueNotFound(CueId),

    #[error("word was not found in revision")]
    WordNotFound,

    #[error("split index is out of bounds for the cue")]
    InvalidSplitIndex,

    #[error("cues selected for merge are not adjacent")]
    CuesNotAdjacent,

    #[error("too many words to fit in u32 ordinal range")]
    TooManyWords,

    #[error("too many turns to fit in u32 ordinal range")]
    TooManyTurns,

    #[error("too many cues to fit in u32 ordinal range")]
    TooManyCues,

    #[error(
        "words in revision must be sorted chronologically: word at ordinal {current_ordinal} (start {current_start_ms} ms) appears after word at ordinal {prev_ordinal} (start {prev_start_ms} ms)"
    )]
    UnsortedWords {
        prev_ordinal: u32,
        prev_start_ms: i64,
        current_ordinal: u32,
        current_start_ms: i64,
    },

    #[error(
        "turns in revision must be sorted chronologically: turn at ordinal {current_ordinal} (start {current_start_ms} ms) appears after turn at ordinal {prev_ordinal} (start {prev_start_ms} ms)"
    )]
    UnsortedTurns {
        prev_ordinal: u32,
        prev_start_ms: i64,
        current_ordinal: u32,
        current_start_ms: i64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{AssetId, ProjectId, TrackId};

    #[test]
    fn test_word_rejects_negative_start_ms() {
        let rev_id = TranscriptRevisionId::new();
        let res = TimedWord::new(rev_id, 1, "hello", "0.0s", "0.5s", -10, 500, None, None);
        assert_eq!(res, Err(TranscriptError::NegativeStart(-10)));
    }

    #[test]
    fn test_word_rejects_reversed_time_range() {
        let rev_id = TranscriptRevisionId::new();
        let res = TimedWord::new(rev_id, 1, "hello", "0.5s", "0.4s", 500, 400, None, None);
        assert_eq!(
            res,
            Err(TranscriptError::InvalidRange {
                start_ms: 500,
                end_ms: 400
            })
        );
    }

    #[test]
    fn test_word_accepts_zero_duration_observation() {
        let rev_id = TranscriptRevisionId::new();
        let word = TimedWord::new(rev_id, 1, "instant", "0.3s", "0.3s", 300, 300, None, None)
            .expect("zero-duration word is valid");
        assert!(word.is_zero_duration());
        assert_eq!(word.duration_ms(), 0);
    }

    #[test]
    fn test_word_rejects_blank_or_whitespace_text() {
        let rev_id = TranscriptRevisionId::new();
        assert_eq!(
            TimedWord::new(rev_id, 1, "", "0.0s", "0.5s", 0, 500, None, None),
            Err(TranscriptError::WordTextBlank)
        );
        assert_eq!(
            TimedWord::new(rev_id, 1, "   \t \n", "0.0s", "0.5s", 0, 500, None, None),
            Err(TranscriptError::WordTextBlank)
        );
    }

    #[test]
    fn test_word_rejects_excessive_text_length() {
        let rev_id = TranscriptRevisionId::new();
        let long_text = "a".repeat(MAX_WORD_TEXT_CHARS + 1);
        assert_eq!(
            TimedWord::new(rev_id, 1, long_text, "0.0s", "0.5s", 0, 500, None, None),
            Err(TranscriptError::WordTextTooLong {
                max_chars: MAX_WORD_TEXT_CHARS,
                actual_chars: MAX_WORD_TEXT_CHARS + 1
            })
        );
    }

    #[test]
    fn test_word_validates_confidence_bounds() {
        let rev_id = TranscriptRevisionId::new();
        assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(-0.1)).is_err());
        assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(1.01)).is_err());
        assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(f32::NAN)).is_err());
        assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(0.0)).is_ok());
        assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(1.0)).is_ok());
    }

    #[test]
    fn test_word_normalizes_speaker_and_rejects_control_characters() {
        let rev_id = TranscriptRevisionId::new();
        let word_ctrl = TimedWord::new(
            rev_id,
            1,
            "w",
            "0s",
            "1s",
            0,
            1000,
            Some("spk\n1".into()),
            None,
        );
        assert!(matches!(
            word_ctrl,
            Err(TranscriptError::InvalidSpeakerId(_))
        ));

        let word_blank_spk =
            TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, Some("  ".into()), None)
                .expect("blank speaker normalizes to None");
        assert_eq!(word_blank_spk.speaker_id(), None);
    }

    #[test]
    fn test_word_manual_edit_mutation_sets_provenance() {
        let rev_id = TranscriptRevisionId::new();
        let word = TimedWord::new(rev_id, 1, "original", "0s", "1s", 0, 1000, None, None).unwrap();
        let edited = word.with_manual_text("correction").unwrap();
        assert_eq!(edited.text(), "correction");
        assert_eq!(edited.provenance(), WordProvenance::Manual);
        assert_eq!(edited.alignment_status(), AlignmentStatus::Modified);
        assert_eq!(edited.start_ms(), 0);
        assert_eq!(edited.end_ms(), 1000);
    }

    #[test]
    fn test_word_drag_timing_mutation_sets_unaligned() {
        let rev_id = TranscriptRevisionId::new();
        let word = TimedWord::new(rev_id, 1, "word", "0s", "1s", 0, 1000, None, None).unwrap();
        let dragged = word.with_adjusted_timing(200, 1200).unwrap();
        assert_eq!(dragged.start_ms(), 200);
        assert_eq!(dragged.end_ms(), 1200);
        assert_eq!(dragged.provenance(), WordProvenance::Manual);
        assert_eq!(dragged.alignment_status(), AlignmentStatus::Unaligned);
    }

    #[test]
    fn test_turn_rejects_empty_words() {
        let rev_id = TranscriptRevisionId::new();
        let res = TranscriptTurn::from_words(rev_id, 1, None, &[], ScriptSpacing::SpaceSeparated);
        assert_eq!(res, Err(TranscriptError::EmptyTurn));
    }

    #[test]
    fn test_turn_joins_text_with_script_spacing() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "Hello", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "world", "0.5s", "1.0s", 500, 1000, None, None).unwrap();

        let turn_latin = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();
        assert_eq!(turn_latin.text(), "Hello world");

        let c1 = TimedWord::new(rev_id, 1, "你好", "0s", "0.5s", 0, 500, None, None).unwrap();
        let c2 = TimedWord::new(rev_id, 2, "世界", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
        let turn_cjk =
            TranscriptTurn::from_words(rev_id, 1, None, &[c1, c2], ScriptSpacing::NoSpaces)
                .unwrap();
        assert_eq!(turn_cjk.text(), "你好世界");
    }

    #[test]
    fn test_turn_derives_start_and_end_from_words() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "first", "0.1s", "0.4s", 100, 400, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "second", "0.6s", "0.9s", 600, 900, None, None).unwrap();
        let turn = TranscriptTurn::from_words(
            rev_id,
            1,
            Some("spk1".into()),
            &[w1, w2],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();
        assert_eq!(turn.start_ms(), 100);
        assert_eq!(turn.end_ms(), 900);
        assert_eq!(turn.speaker_id(), Some("spk1"));
    }

    #[test]
    fn test_revision_sorts_and_reindexes_words_and_turns() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w2 = TimedWord::new(rev_id, 99, "two", "0.6s", "0.9s", 600, 900, None, None).unwrap();
        let w1 = TimedWord::new(rev_id, 50, "one", "0.1s", "0.5s", 100, 500, None, None).unwrap();

        let t1 = TranscriptTurn::from_words(
            rev_id,
            88,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();
        let t2 = TranscriptTurn::from_words(
            rev_id,
            44,
            None,
            std::slice::from_ref(&w2),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w2, w1],
            vec![t2, t1],
        )
        .unwrap();

        assert_eq!(rev.words()[0].text(), "one");
        assert_eq!(rev.words()[0].ordinal(), 1);
        assert_eq!(rev.words()[1].text(), "two");
        assert_eq!(rev.words()[1].ordinal(), 2);

        assert_eq!(rev.turns()[0].ordinal(), 1);
        assert_eq!(rev.turns()[1].ordinal(), 2);
    }

    #[test]
    fn test_active_word_at_logarithmic_lookup() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "word1", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "word2", "0.6s", "1.0s", 600, 1000, None, None).unwrap();
        let w3 =
            TimedWord::new(rev_id, 3, "word3", "1.2s", "1.5s", 1200, 1500, None, None).unwrap();

        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone(), w3.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2, w3],
            vec![t1],
        )
        .unwrap();

        assert_eq!(rev.active_word_at(250).map(TimedWord::text), Some("word1"));
        assert_eq!(rev.active_word_at(550).map(TimedWord::text), None);
        assert_eq!(rev.active_word_at(1000).map(TimedWord::text), None);
        assert_eq!(rev.active_word_at(1200).map(TimedWord::text), Some("word3"));
    }

    #[test]
    fn test_active_word_at_handles_overlapping_words() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "long", "0s", "1.0s", 0, 1000, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "nested", "0.2s", "0.5s", 200, 500, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2],
            vec![t1],
        )
        .unwrap();

        let active = rev.active_word_at(300);
        assert!(active.is_some());
    }

    #[test]
    fn test_words_in_range_slice_query() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "w2", "0.6s", "1.0s", 600, 1000, None, None).unwrap();
        let w3 = TimedWord::new(rev_id, 3, "w3", "1.2s", "1.5s", 1200, 1500, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone(), w3.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2, w3],
            vec![t1],
        )
        .unwrap();

        let slice = rev.words_in_range(400, 1100);
        assert_eq!(slice.len(), 2);
        assert_eq!(slice[0].text(), "w1");
        assert_eq!(slice[1].text(), "w2");
    }

    #[test]
    fn test_revision_enforces_referential_integrity_between_turns_and_words() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
        let unknown_word_id = WordId::new();

        let bad_turn = TranscriptTurn::restore(
            TurnId::new(),
            rev_id,
            1,
            None,
            0,
            500,
            "w1".into(),
            vec![unknown_word_id],
        )
        .unwrap();

        let res = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1],
            vec![bad_turn],
        );
        assert!(matches!(
            res,
            Err(TranscriptError::UnknownWordInTurn { .. })
        ));
    }

    #[test]
    fn test_revision_rejects_word_in_multiple_turns() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "shared", "0s", "0.5s", 0, 500, None, None).unwrap();

        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();
        let t2 = TranscriptTurn::from_words(
            rev_id,
            2,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let res = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1],
            vec![t1, t2],
        );
        assert!(matches!(res, Err(TranscriptError::WordInMultipleTurns(_))));
    }

    #[test]
    fn test_project_one_word_policy() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "one", "0.1s", "0.5s", 100, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "zero", "0.6s", "0.6s", 600, 600, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2],
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::OneWord {
                min_duration_ms: 60,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        assert_eq!(proj.cues().len(), 2);
        assert_eq!(proj.cues()[0].text, "one");
        assert_eq!(proj.cues()[1].text, "zero");
        assert_eq!(proj.cues()[1].start_ms, 600);
        assert_eq!(proj.cues()[1].end_ms, 660); // padded to min_duration_ms
    }

    #[test]
    fn test_project_natural_policy_splits_on_punctuation_and_pause() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "Hello.", "0s", "0.4s", 0, 400, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "World", "0.5s", "0.8s", 500, 800, None, None).unwrap();
        let w3 =
            TimedWord::new(rev_id, 3, "pause", "1.5s", "1.8s", 1500, 1800, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone(), w3.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            3000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2, w3],
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::Natural {
                pause_threshold_ms: 300,
                max_words: 10,
                max_characters: 40,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        assert_eq!(proj.cues().len(), 3);
        assert_eq!(proj.cues()[0].text, "Hello.");
        assert_eq!(proj.cues()[1].text, "World");
        assert_eq!(proj.cues()[2].text, "pause");
    }

    #[test]
    fn test_project_short_policy_splits_on_word_count() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let mut words = Vec::new();
        for i in 1..=12 {
            words.push(
                TimedWord::new(
                    rev_id,
                    i,
                    format!("w{i}"),
                    format!("{}s", i - 1),
                    format!("{i}s"),
                    (i64::from(i) - 1) * 1000,
                    i64::from(i) * 1000,
                    None,
                    None,
                )
                .unwrap(),
            );
        }
        let t1 = TranscriptTurn::from_words(rev_id, 1, None, &words, ScriptSpacing::SpaceSeparated)
            .unwrap();
        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            15000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            words,
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::Short {
                max_words: 5,
                max_duration_ms: 10000,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        assert_eq!(proj.cues().len(), 3);
        assert_eq!(proj.cues()[0].word_ids.len(), 5);
        assert_eq!(proj.cues()[1].word_ids.len(), 5);
        assert_eq!(proj.cues()[2].word_ids.len(), 2);
    }

    #[test]
    fn test_regroup_preserving_edits_leaves_user_cues_untouched() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "w2", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
        let w3 = TimedWord::new(rev_id, 3, "w3", "1.0s", "1.5s", 1000, 1500, None, None).unwrap();
        let w4 = TimedWord::new(rev_id, 4, "w4", "1.5s", "2.0s", 1500, 2000, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone(), w3.clone(), w4.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            3000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2, w3, w4],
            vec![t1],
        )
        .unwrap();

        let mut proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::Short {
                max_words: 2,
                max_duration_ms: 5000,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        assert_eq!(proj.cues().len(), 2);
        // User edits cue #2
        proj.cues[1].text = "USER EDITED".into();
        proj.cues[1].manual_state = ManualEditState::EditedText;

        // Regroup under OneWord
        let regrouped = proj
            .regroup_preserving_edits(
                &rev,
                GroupingPolicy::OneWord {
                    min_duration_ms: 50,
                },
                ScriptSpacing::SpaceSeparated,
            )
            .unwrap();

        // Cues 1 and 2 (from w1 and w2) become 2 one-word cues; cue 2 is preserved with USER EDITED!
        assert_eq!(regrouped.cues().len(), 3);
        assert_eq!(regrouped.cues()[0].text, "w1");
        assert_eq!(regrouped.cues()[1].text, "w2");
        assert_eq!(regrouped.cues()[2].text, "USER EDITED");
    }

    #[test]
    fn test_split_cue_at_word_boundary() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "w2", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
        let w3 = TimedWord::new(rev_id, 3, "w3", "1.0s", "1.5s", 1000, 1500, None, None).unwrap();
        let w4 = TimedWord::new(rev_id, 4, "w4", "1.5s", "2.0s", 1500, 2000, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone(), w3.clone(), w4.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            3000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2, w3, w4],
            vec![t1],
        )
        .unwrap();

        let mut proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::Short {
                max_words: 10,
                max_duration_ms: 10000,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let cue_id = proj.cues()[0].id;
        let (c1, c2) = proj
            .split_cue(cue_id, 2, &rev, ScriptSpacing::SpaceSeparated)
            .unwrap();
        assert_eq!(proj.cues().len(), 2);
        assert_eq!(proj.cues()[0].id, c1);
        assert_eq!(proj.cues()[0].text, "w1 w2");
        assert_eq!(proj.cues()[1].id, c2);
        assert_eq!(proj.cues()[1].text, "w3 w4");
    }

    #[test]
    fn test_merge_adjacent_cues() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "w2", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            3000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2],
            vec![t1],
        )
        .unwrap();

        let mut proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::OneWord {
                min_duration_ms: 50,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let c1_id = proj.cues()[0].id;
        let c2_id = proj.cues()[1].id;

        let merged_id = proj
            .merge_cues(c1_id, c2_id, &rev, ScriptSpacing::SpaceSeparated)
            .unwrap();
        assert_eq!(proj.cues().len(), 1);
        assert_eq!(proj.cues()[0].id, merged_id);
        assert_eq!(proj.cues()[0].text, "w1 w2");
        assert_eq!(proj.cues()[0].start_ms, 0);
        assert_eq!(proj.cues()[0].end_ms, 1000);
    }

    #[test]
    fn test_to_subtitle_track_conversion() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "test", "0s", "0.5s", 0, 500, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1],
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::OneWord {
                min_duration_ms: 50,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let track = proj.to_subtitle_track("English", TrackOrigin::Srt).unwrap();
        assert_eq!(track.label(), "English");
        assert_eq!(track.cues().len(), 1);
        assert_eq!(track.cues()[0].text(), "test");
    }

    #[test]
    fn test_cue_word_mappings_extraction() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "test", "0s", "0.5s", 0, 500, None, None).unwrap();
        let w1_id = w1.id();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1],
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::OneWord {
                min_duration_ms: 50,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let mappings = proj.cue_word_mappings();
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].1, vec![w1_id]);
    }

    #[test]
    fn test_active_word_in_cue_highlighting() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "hello", "0.1s", "0.4s", 100, 400, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "world", "0.5s", "0.9s", 500, 900, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2],
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::Natural {
                pause_threshold_ms: 1000,
                max_words: 10,
                max_characters: 40,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let cue = &proj.cues()[0];
        assert_eq!(
            proj.active_word_in_cue(cue, &rev, 250).map(TimedWord::text),
            Some("hello")
        );
        assert_eq!(
            proj.active_word_in_cue(cue, &rev, 450).map(TimedWord::text),
            None
        );
        assert_eq!(
            proj.active_word_in_cue(cue, &rev, 700).map(TimedWord::text),
            Some("world")
        );
    }

    #[test]
    fn test_revision_serde_round_trip() {
        let proj_id = ProjectId::new();
        let asset_id = AssetId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(
            rev_id,
            1,
            "word",
            "0.1s",
            "0.5s",
            100,
            500,
            Some("spk1".into()),
            Some(0.95),
        )
        .unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            Some("spk1".into()),
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            Some(asset_id),
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fingerprint123",
            1_234_567,
            vec![w1],
            vec![t1],
        )
        .unwrap();

        let json = serde_json::to_string(&rev).expect("serialize revision");
        let decoded: TranscriptRevision =
            serde_json::from_str(&json).expect("deserialize revision");
        assert_eq!(rev, decoded);
    }

    #[test]
    fn test_projection_serde_round_trip() {
        let proj_id = ProjectId::new();
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "word", "0.1s", "0.5s", 100, 500, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            proj_id,
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1],
            vec![t1],
        )
        .unwrap();

        let proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::OneWord {
                min_duration_ms: 50,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let json = serde_json::to_string(&proj).expect("serialize projection");
        let decoded: CaptionProjection =
            serde_json::from_str(&json).expect("deserialize projection");
        assert_eq!(proj, decoded);
    }

    #[test]
    fn test_tampered_json_with_duplicate_word_ids_rejected() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "word", "0.1s", "0.5s", 100, 500, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            ProjectId::new(),
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1],
            vec![t1],
        )
        .unwrap();

        let mut val = serde_json::to_value(&rev).unwrap();
        // Duplicate word into words array
        let words = val.get_mut("words").unwrap().as_array_mut().unwrap();
        let dup = words[0].clone();
        words.push(dup);

        let tampered_str = serde_json::to_string(&val).unwrap();
        assert!(serde_json::from_str::<TranscriptRevision>(&tampered_str).is_err());
    }

    #[test]
    fn test_tampered_json_with_null_ordinal_rejected() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "word", "0.1s", "0.5s", 100, 500, None, None).unwrap();
        let mut val = serde_json::to_value(&w1).unwrap();
        val["ordinal"] = serde_json::Value::Null;

        let tampered_str = serde_json::to_string(&val).unwrap();
        assert!(serde_json::from_str::<TimedWord>(&tampered_str).is_err());
    }

    #[test]
    fn test_pre_change_cue_only_tracks_unaffected() {
        let cue =
            SubtitleCue::restore(CueId::new(), 1, 0, 1000, "legacy cue".into(), None).unwrap();
        let track =
            SubtitleTrack::restore(TrackId::new(), "Legacy Track", TrackOrigin::Srt, vec![cue])
                .unwrap();
        assert_eq!(track.origin(), TrackOrigin::Srt);
        assert_eq!(track.cues().len(), 1);
        assert_eq!(track.cues()[0].text(), "legacy cue");
    }

    #[test]
    fn test_words_in_range_with_overlapping_words() {
        let rev_id = TranscriptRevisionId::new();
        let w0 = TimedWord::new(rev_id, 1, "long", "0s", "1s", 0, 1000, None, None).unwrap();
        let w1 = TimedWord::new(rev_id, 2, "short1", "0.1s", "0.2s", 100, 200, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 3, "short2", "0.2s", "0.3s", 200, 300, None, None).unwrap();
        let t0 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w0.clone(), w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            ProjectId::new(),
            None,
            0,
            2000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w0, w1, w2],
            vec![t0],
        )
        .unwrap();

        let mid = rev.words_in_range(500, 600);
        assert_eq!(mid.len(), 1);
        assert_eq!(mid[0].text(), "long");

        let overlap = rev.words_in_range(150, 250);
        assert_eq!(overlap.len(), 3);
        assert_eq!(overlap[0].text(), "long");
        assert_eq!(overlap[1].text(), "short1");
        assert_eq!(overlap[2].text(), "short2");

        let past = rev.words_in_range(1000, 1500);
        assert!(past.is_empty());
    }

    #[test]
    fn test_active_turn_at_overlapping_speakers() {
        let rev_id = TranscriptRevisionId::new();
        let w0 = TimedWord::new(rev_id, 1, "spk1", "0s", "5s", 0, 5000, None, None).unwrap();
        let w1 = TimedWord::new(rev_id, 2, "spk2", "2s", "3s", 2000, 3000, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 3, "spk3", "3.5s", "4s", 3500, 4000, None, None).unwrap();

        let t0 = TranscriptTurn::from_words(
            rev_id,
            1,
            Some("spk1".into()),
            std::slice::from_ref(&w0),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            2,
            Some("spk2".into()),
            std::slice::from_ref(&w1),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();
        let t2 = TranscriptTurn::from_words(
            rev_id,
            3,
            Some("spk3".into()),
            std::slice::from_ref(&w2),
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            ProjectId::new(),
            None,
            0,
            6000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w0, w1, w2],
            vec![t0, t1, t2],
        )
        .unwrap();

        let active = rev.active_turn_at(4500);
        assert!(active.is_some());
        assert_eq!(active.unwrap().ordinal(), 1);

        let all_active = rev.active_turns_at(2500);
        assert_eq!(all_active.len(), 2);
        assert_eq!(all_active[0].ordinal(), 1);
        assert_eq!(all_active[1].ordinal(), 2);
    }

    #[test]
    fn test_restore_rejects_unsorted_turns() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "first", "0.5s", "1.5s", 500, 1500, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "second", "2s", "3s", 2000, 3000, None, None).unwrap();

        let t1 = TranscriptTurn::restore(
            TurnId::new(),
            rev_id,
            1,
            None,
            2000,
            3000,
            "second".into(),
            vec![w2.id()],
        )
        .unwrap();
        let t2 = TranscriptTurn::restore(
            TurnId::new(),
            rev_id,
            2,
            None,
            500,
            1500,
            "first".into(),
            vec![w1.id()],
        )
        .unwrap();

        let res = TranscriptRevision::restore(
            rev_id,
            ProjectId::new(),
            None,
            0,
            4000,
            "gemini".into(),
            "gemini-3.5-transcribe".into(),
            1,
            CompletionState::Completed,
            "fp".into(),
            1000,
            vec![w1, w2],
            vec![t1, t2],
        );
        assert!(matches!(res, Err(TranscriptError::UnsortedTurns { .. })));
    }

    #[test]
    fn test_reconstruct_canonicalizes_unsorted_turns_and_words() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "late", "2s", "3s", 2000, 3000, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "early", "0.5s", "1.5s", 500, 1500, None, None).unwrap();

        let t1 = TranscriptTurn::restore(
            TurnId::new(),
            rev_id,
            1,
            None,
            2000,
            3000,
            "late".into(),
            vec![w1.id()],
        )
        .unwrap();
        let t2 = TranscriptTurn::restore(
            TurnId::new(),
            rev_id,
            2,
            None,
            500,
            1500,
            "early".into(),
            vec![w2.id()],
        )
        .unwrap();

        let reconstructed = TranscriptRevision::reconstruct(
            rev_id,
            ProjectId::new(),
            None,
            0,
            4000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2],
            vec![t1, t2],
        )
        .expect("reconstruct canonicalizes");

        assert_eq!(reconstructed.words()[0].text(), "early");
        assert_eq!(reconstructed.words()[0].ordinal(), 1);
        assert_eq!(reconstructed.turns()[0].text(), "early");
        assert_eq!(reconstructed.turns()[0].ordinal(), 1);
    }

    #[test]
    fn test_split_cue_duration_clamp_with_zero_duration() {
        let rev_id = TranscriptRevisionId::new();
        let w1 = TimedWord::new(rev_id, 1, "zero", "1s", "1s", 1000, 1000, None, None).unwrap();
        let w2 = TimedWord::new(rev_id, 2, "word", "1s", "2s", 1000, 2000, None, None).unwrap();
        let t1 = TranscriptTurn::from_words(
            rev_id,
            1,
            None,
            &[w1.clone(), w2.clone()],
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let rev = TranscriptRevision::new(
            ProjectId::new(),
            None,
            0,
            3000,
            "gemini",
            "gemini-3.5-transcribe",
            1,
            CompletionState::Completed,
            "fp",
            1000,
            vec![w1, w2],
            vec![t1],
        )
        .unwrap();

        let mut proj = CaptionProjection::project(
            &rev,
            TrackId::new(),
            GroupingPolicy::Natural {
                pause_threshold_ms: 300,
                max_words: 10,
                max_characters: 40,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

        let cue_id = proj.cues()[0].id;
        let (c1, c2) = proj
            .split_cue(cue_id, 1, &rev, ScriptSpacing::SpaceSeparated)
            .unwrap();

        let cue1 = proj.cues().iter().find(|c| c.id == c1).unwrap();
        let cue2 = proj.cues().iter().find(|c| c.id == c2).unwrap();
        assert_eq!(cue1.start_ms, 1000);
        assert_eq!(cue1.end_ms, 1050);
        assert!(cue1.end_ms > cue1.start_ms);
        assert!(cue2.end_ms > cue2.start_ms);

        let track = proj.to_subtitle_track("Track", TrackOrigin::Srt).unwrap();
        assert_eq!(track.cues().len(), 2);
    }
}
