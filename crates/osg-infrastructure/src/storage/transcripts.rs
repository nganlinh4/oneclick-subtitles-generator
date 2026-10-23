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
    transcript_update_revision_state, update_transcript_revision_state,
};

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
    pub state: String,
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
