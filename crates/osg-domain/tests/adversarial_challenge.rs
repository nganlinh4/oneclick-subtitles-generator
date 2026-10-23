//! Adversarial stress tests for the transcript domain, grouped by subject.

#[path = "adversarial_challenge/cue_editing.rs"]
mod cue_editing;
#[path = "adversarial_challenge/grouping_and_validation.rs"]
mod grouping_and_validation;
#[path = "adversarial_challenge/index_lookups.rs"]
mod index_lookups;

use osg_domain::{
    CompletionState, ProjectId, TimedWord, TranscriptRevision, TranscriptRevisionId, TranscriptTurn,
};

fn make_word(
    rev_id: TranscriptRevisionId,
    ordinal: u32,
    text: &str,
    start_ms: i64,
    end_ms: i64,
) -> TimedWord {
    TimedWord::new(
        rev_id,
        ordinal,
        text,
        format!("{start_ms}ms"),
        format!("{end_ms}ms"),
        start_ms,
        end_ms,
        None,
        None,
    )
    .expect("valid word")
}

fn make_revision(words: Vec<TimedWord>, turns: Vec<TranscriptTurn>) -> TranscriptRevision {
    let max_end = words.iter().map(TimedWord::end_ms).max().unwrap_or(1000);
    TranscriptRevision::new(
        ProjectId::new(),
        None,
        0,
        max_end + 1000,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp",
        1000,
        words,
        turns,
    )
    .expect("valid revision")
}
