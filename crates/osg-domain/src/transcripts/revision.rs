//! The durable transcript revision aggregate, its validation, and its indexed lookups.

use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize};

use super::{
    CompletionState, MAX_MODEL_NAME_CHARS, MAX_PROVIDER_NAME_CHARS, TimedWord, TranscriptError,
    TranscriptTurn,
};
use crate::ids::{AssetId, ProjectId, TranscriptRevisionId, TurnId, WordId};

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
