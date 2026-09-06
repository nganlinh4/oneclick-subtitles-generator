use osg_domain::{CueId, JobId, TranscriptRevisionId, TurnId, WordId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimedWordDto {
    pub(crate) id: WordId,
    pub(crate) revision_id: TranscriptRevisionId,
    pub(crate) ordinal: u32,
    pub(crate) text: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) speaker_id: Option<String>,
    pub(crate) confidence: Option<f32>,
    pub(crate) provenance: String,
    pub(crate) alignment_status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptTurnDto {
    pub(crate) id: TurnId,
    pub(crate) revision_id: TranscriptRevisionId,
    pub(crate) ordinal: u32,
    pub(crate) speaker_id: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) text: String,
    pub(crate) start_word_ordinal: u32,
    pub(crate) end_word_ordinal: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedCueDto {
    pub(crate) id: CueId,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) text: String,
    pub(crate) speaker_id: Option<String>,
    pub(crate) word_ids: Vec<WordId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionErrorDto {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) window_index: Option<usize>,
    pub(crate) retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum WordNativeTranscriptionEvent {
    #[serde(rename = "stageChanged")]
    StageChanged {
        job_id: JobId,
        stage: String,
        message: String,
        window_index: Option<usize>,
        total_windows: Option<usize>,
    },
    #[serde(rename = "windowProgress")]
    WindowProgress {
        job_id: JobId,
        window_index: usize,
        total_windows: usize,
        window_start_ms: i64,
        window_end_ms: i64,
        phase: String,
        fraction: Option<f32>,
    },
    #[serde(rename = "windowPromoted")]
    WindowPromoted {
        job_id: JobId,
        revision_id: TranscriptRevisionId,
        window_index: usize,
        total_windows: usize,
        window_start_ms: i64,
        window_end_ms: i64,
        word_count: usize,
        turn_count: usize,
        words: Vec<TimedWordDto>,
        turns: Vec<TranscriptTurnDto>,
        projected_cues: Vec<ProjectedCueDto>,
    },
    #[serde(rename = "completed")]
    Completed {
        job_id: JobId,
        revision_id: TranscriptRevisionId,
        total_windows: usize,
        total_words: usize,
        total_turns: usize,
        duration_ms: i64,
        projected_cues: Vec<ProjectedCueDto>,
    },
    #[serde(rename = "cancelled")]
    Cancelled {
        job_id: JobId,
    },
    #[serde(rename = "failed")]
    Failed {
        job_id: JobId,
        error: TranscriptionErrorDto,
    },
}
