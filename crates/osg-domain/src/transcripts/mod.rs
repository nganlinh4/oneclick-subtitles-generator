//! Transcript domain: provider word observations, speaker turns, durable revisions, and the
//! offline caption projections derived from them.

mod error;
mod grouping;
mod projection;
mod revision;
mod turn;
mod word;

pub use error::TranscriptError;
pub use grouping::{CustomGroupingConfig, GroupingPolicy};
pub use projection::{
    AlignmentState, CaptionProjection, ManualEditState, ProjectedCue, SourceWordSpan,
};
pub use revision::TranscriptRevision;
pub use turn::TranscriptTurn;
pub use word::TimedWord;

use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests;
