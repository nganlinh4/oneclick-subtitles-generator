//! Revision ordering, integrity, and spatial lookup tests.

use crate::ids::{ProjectId, TranscriptRevisionId, TurnId, WordId};
use crate::transcripts::*;

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
    let w3 = TimedWord::new(rev_id, 3, "word3", "1.2s", "1.5s", 1200, 1500, None, None).unwrap();

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
