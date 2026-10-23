//! Transcript validation and editing errors.

use thiserror::Error;

use crate::ids::{CueId, TurnId, WordId};

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
