//! Word and turn construction tests.

use crate::ids::TranscriptRevisionId;
use crate::transcripts::*;

#[test]
fn test_word_rejects_negative_start_ms() {
    let rev_id = TranscriptRevisionId::new();
    let res = TimedWord::new(rev_id, 1, "hello", "0.0s", "0.5s", -10, 500, None, None);
    assert_eq!(res, Err(TranscriptError::NegativeStart(-10)));
}

#[test]
fn test_word_rejects_reversed_time_range() {
    let rev_id = TranscriptRevisionId::new();
    let res = TimedWord::new(rev_id, 1, "hello", "0.5s", "0.4s", 500, 400, None, None);
    assert_eq!(
        res,
        Err(TranscriptError::InvalidRange {
            start_ms: 500,
            end_ms: 400
        })
    );
}

#[test]
fn test_word_accepts_zero_duration_observation() {
    let rev_id = TranscriptRevisionId::new();
    let word = TimedWord::new(rev_id, 1, "instant", "0.3s", "0.3s", 300, 300, None, None)
        .expect("zero-duration word is valid");
    assert!(word.is_zero_duration());
    assert_eq!(word.duration_ms(), 0);
}

#[test]
fn test_word_rejects_blank_or_whitespace_text() {
    let rev_id = TranscriptRevisionId::new();
    assert_eq!(
        TimedWord::new(rev_id, 1, "", "0.0s", "0.5s", 0, 500, None, None),
        Err(TranscriptError::WordTextBlank)
    );
    assert_eq!(
        TimedWord::new(rev_id, 1, "   \t \n", "0.0s", "0.5s", 0, 500, None, None),
        Err(TranscriptError::WordTextBlank)
    );
}

#[test]
fn test_word_rejects_excessive_text_length() {
    let rev_id = TranscriptRevisionId::new();
    let long_text = "a".repeat(MAX_WORD_TEXT_CHARS + 1);
    assert_eq!(
        TimedWord::new(rev_id, 1, long_text, "0.0s", "0.5s", 0, 500, None, None),
        Err(TranscriptError::WordTextTooLong {
            max_chars: MAX_WORD_TEXT_CHARS,
            actual_chars: MAX_WORD_TEXT_CHARS + 1
        })
    );
}

#[test]
fn test_word_validates_confidence_bounds() {
    let rev_id = TranscriptRevisionId::new();
    assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(-0.1)).is_err());
    assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(1.01)).is_err());
    assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(f32::NAN)).is_err());
    assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(0.0)).is_ok());
    assert!(TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, None, Some(1.0)).is_ok());
}

#[test]
fn test_word_normalizes_speaker_and_rejects_control_characters() {
    let rev_id = TranscriptRevisionId::new();
    let word_ctrl = TimedWord::new(
        rev_id,
        1,
        "w",
        "0s",
        "1s",
        0,
        1000,
        Some("spk\n1".into()),
        None,
    );
    assert!(matches!(
        word_ctrl,
        Err(TranscriptError::InvalidSpeakerId(_))
    ));

    let word_blank_spk =
        TimedWord::new(rev_id, 1, "w", "0s", "1s", 0, 1000, Some("  ".into()), None)
            .expect("blank speaker normalizes to None");
    assert_eq!(word_blank_spk.speaker_id(), None);
}

#[test]
fn test_word_manual_edit_mutation_sets_provenance() {
    let rev_id = TranscriptRevisionId::new();
    let word = TimedWord::new(rev_id, 1, "original", "0s", "1s", 0, 1000, None, None).unwrap();
    let edited = word.with_manual_text("correction").unwrap();
    assert_eq!(edited.text(), "correction");
    assert_eq!(edited.provenance(), WordProvenance::Manual);
    assert_eq!(edited.alignment_status(), AlignmentStatus::Modified);
    assert_eq!(edited.start_ms(), 0);
    assert_eq!(edited.end_ms(), 1000);
}

#[test]
fn test_word_drag_timing_mutation_sets_unaligned() {
    let rev_id = TranscriptRevisionId::new();
    let word = TimedWord::new(rev_id, 1, "word", "0s", "1s", 0, 1000, None, None).unwrap();
    let dragged = word.with_adjusted_timing(200, 1200).unwrap();
    assert_eq!(dragged.start_ms(), 200);
    assert_eq!(dragged.end_ms(), 1200);
    assert_eq!(dragged.provenance(), WordProvenance::Manual);
    assert_eq!(dragged.alignment_status(), AlignmentStatus::Unaligned);
}

#[test]
fn test_turn_rejects_empty_words() {
    let rev_id = TranscriptRevisionId::new();
    let res = TranscriptTurn::from_words(rev_id, 1, None, &[], ScriptSpacing::SpaceSeparated);
    assert_eq!(res, Err(TranscriptError::EmptyTurn));
}

#[test]
fn test_turn_joins_text_with_script_spacing() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "Hello", "0s", "0.5s", 0, 500, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "world", "0.5s", "1.0s", 500, 1000, None, None).unwrap();

    let turn_latin = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert_eq!(turn_latin.text(), "Hello world");

    let c1 = TimedWord::new(rev_id, 1, "你好", "0s", "0.5s", 0, 500, None, None).unwrap();
    let c2 = TimedWord::new(rev_id, 2, "世界", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
    let turn_cjk =
        TranscriptTurn::from_words(rev_id, 1, None, &[c1, c2], ScriptSpacing::NoSpaces).unwrap();
    assert_eq!(turn_cjk.text(), "你好世界");
}

#[test]
fn test_turn_derives_start_and_end_from_words() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "first", "0.1s", "0.4s", 100, 400, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "second", "0.6s", "0.9s", 600, 900, None, None).unwrap();
    let turn = TranscriptTurn::from_words(
        rev_id,
        1,
        Some("spk1".into()),
        &[w1, w2],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert_eq!(turn.start_ms(), 100);
    assert_eq!(turn.end_ms(), 900);
    assert_eq!(turn.speaker_id(), Some("spk1"));
}
