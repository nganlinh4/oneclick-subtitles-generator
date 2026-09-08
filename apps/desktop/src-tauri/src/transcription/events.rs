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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum WordNativeTranscriptionEvent {
    /// Provider-timed prefix for immediate presentation; not a durable promotion.
    #[serde(rename = "windowCues", rename_all = "camelCase")]
    WindowCues {
        job_id: JobId,
        window_index: usize,
        projected_cues: Vec<ProjectedCueDto>,
    },
    #[serde(rename = "liveDraft", rename_all = "camelCase")]
    LiveDraft {
        job_id: JobId,
        window_index: usize,
        total_windows: usize,
        window_start_ms: i64,
        window_end_ms: i64,
        text: Option<String>,
    },
    #[serde(rename = "stageChanged", rename_all = "camelCase")]
    StageChanged {
        job_id: JobId,
        stage: String,
        message: String,
        window_index: Option<usize>,
        total_windows: Option<usize>,
    },
    #[serde(rename = "windowProgress", rename_all = "camelCase")]
    WindowProgress {
        job_id: JobId,
        window_index: usize,
        total_windows: usize,
        window_start_ms: i64,
        window_end_ms: i64,
        phase: String,
        fraction: Option<f32>,
    },
    #[serde(rename = "windowPromoted", rename_all = "camelCase")]
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
    #[serde(rename = "completed", rename_all = "camelCase")]
    Completed {
        job_id: JobId,
        revision_id: TranscriptRevisionId,
        total_windows: usize,
        total_words: usize,
        total_turns: usize,
        duration_ms: i64,
        projected_cues: Vec<ProjectedCueDto>,
    },
    #[serde(rename = "cancelled", rename_all = "camelCase")]
    Cancelled {
        job_id: JobId,
    },
    #[serde(rename = "failed", rename_all = "camelCase")]
    Failed {
        job_id: JobId,
        error: TranscriptionErrorDto,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_wire_keys_camel_case() {
        let job_id = JobId::new();
        let rev_id = TranscriptRevisionId::new();
        let word_id = WordId::new();
        let cue_id = CueId::new();
        let turn_id = TurnId::new();

        let event = WordNativeTranscriptionEvent::WindowPromoted {
            job_id,
            revision_id: rev_id,
            window_index: 0,
            total_windows: 2,
            window_start_ms: 0,
            window_end_ms: 60000,
            word_count: 1,
            turn_count: 1,
            words: vec![TimedWordDto {
                id: word_id,
                revision_id: rev_id,
                ordinal: 1,
                text: "hello".to_owned(),
                start_ms: 100,
                end_ms: 400,
                speaker_id: Some("w0:spk0".to_owned()),
                confidence: Some(0.95),
                provenance: "provider".to_owned(),
                alignment_status: "aligned".to_owned(),
            }],
            turns: vec![TranscriptTurnDto {
                id: turn_id,
                revision_id: rev_id,
                ordinal: 1,
                speaker_id: "w0:spk0".to_owned(),
                start_ms: 100,
                end_ms: 400,
                text: "hello".to_owned(),
                start_word_ordinal: 1,
                end_word_ordinal: 1,
            }],
            projected_cues: vec![ProjectedCueDto {
                id: cue_id,
                start_ms: 100,
                end_ms: 400,
                text: "hello".to_owned(),
                speaker_id: Some("w0:spk0".to_owned()),
                word_ids: vec![word_id],
            }],
        };

        let json_val = serde_json::to_value(&event).expect("must serialize");
        assert_eq!(json_val["event"], "windowPromoted");
        assert_eq!(json_val["jobId"], job_id.to_string());
        assert_eq!(json_val["revisionId"], rev_id.to_string());
        assert_eq!(json_val["windowIndex"], 0);
        assert_eq!(json_val["totalWindows"], 2);
        assert_eq!(json_val["windowStartMs"], 0);
        assert_eq!(json_val["windowEndMs"], 60000);
        assert_eq!(json_val["wordCount"], 1);
        assert_eq!(json_val["turnCount"], 1);
        assert!(json_val.get("projected_cues").is_none());
        assert!(json_val.get("projectedCues").is_some());
        assert_eq!(json_val["projectedCues"][0]["id"], cue_id.to_string());
        assert_eq!(json_val["projectedCues"][0]["startMs"], 100);
        assert_eq!(json_val["projectedCues"][0]["endMs"], 400);
        assert_eq!(json_val["projectedCues"][0]["wordIds"][0], word_id.to_string());

        let completed = WordNativeTranscriptionEvent::Completed {
            job_id,
            revision_id: rev_id,
            total_windows: 1,
            total_words: 5,
            total_turns: 1,
            duration_ms: 1234,
            projected_cues: vec![],
        };
        let comp_json = serde_json::to_value(&completed).expect("must serialize");
        assert_eq!(comp_json["event"], "completed");
        assert_eq!(comp_json["totalWindows"], 1);
        assert_eq!(comp_json["totalWords"], 5);
        assert_eq!(comp_json["totalTurns"], 1);
        assert_eq!(comp_json["durationMs"], 1234);
        assert!(comp_json.get("total_words").is_none());
    }
}
