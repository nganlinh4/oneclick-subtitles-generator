//! Serde round trips and tampered-payload rejection.

use crate::ids::{AssetId, ProjectId, TrackId, TranscriptRevisionId};
use crate::transcripts::*;

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
    let decoded: TranscriptRevision = serde_json::from_str(&json).expect("deserialize revision");
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
    let decoded: CaptionProjection = serde_json::from_str(&json).expect("deserialize projection");
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
