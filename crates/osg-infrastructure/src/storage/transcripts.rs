use osg_domain::{AssetId, CueId, ProjectId, TranscriptRevisionId, TurnId, WordId};
use serde::{Deserialize, Serialize};

mod queries;
mod writes;

pub use queries::{
    get_transcript_revision, list_transcript_revisions_for_project,
    load_cue_word_mappings_for_project, query_active_word, query_turns_in_range,
    query_words_in_range,
};
pub use writes::{
    insert_transcript_revision, promote_window_results, save_cue_word_mappings,
    update_transcript_revision_state,
};

/// Lifecycle of a transcript revision. The stored strings are the `SQLite` CHECK vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRevisionState {
    InProgress,
    Completed,
    Partial,
    Failed,
}

impl TranscriptRevisionState {
    pub const ALL: [Self; 4] = [
        Self::InProgress,
        Self::Completed,
        Self::Partial,
        Self::Failed,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.as_str() == value)
    }

    /// The terminal state of an interrupted run: `Partial` once any words were kept.
    #[must_use]
    pub const fn interrupted(words_promoted: usize) -> Self {
        if words_promoted > 0 {
            Self::Partial
        } else {
            Self::Failed
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRevisionRecord {
    pub id: TranscriptRevisionId,
    pub project_id: ProjectId,
    pub media_id: Option<AssetId>,
    pub provider: String,
    pub model: String,
    pub source_range_start_ms: i64,
    pub source_range_end_ms: i64,
    pub state: TranscriptRevisionState,
    pub fingerprint: String,
    pub word_count: u32,
    pub metadata_json: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWordRecord {
    pub id: WordId,
    pub revision_id: TranscriptRevisionId,
    pub turn_id: Option<TurnId>,
    pub ordinal: u32,
    pub text: String,
    pub raw_start_ns: u64,
    pub raw_end_ns: u64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_id: Option<String>,
    pub confidence: Option<f32>,
    pub is_unaligned: bool,
    pub alignment_status: String,
    pub provenance: String,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurnRecord {
    pub id: TurnId,
    pub revision_id: TranscriptRevisionId,
    pub ordinal: u32,
    pub speaker_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub start_word_ordinal: u32,
    pub end_word_ordinal: u32,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueWordMappingRecord {
    pub cue_id: CueId,
    pub word_id: WordId,
    pub word_ordinal: u32,
    pub metadata_json: String,
}

#[cfg(test)]
#[allow(clippy::too_many_lines)]
mod tests;
