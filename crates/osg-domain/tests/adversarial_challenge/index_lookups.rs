//! Spatial index and range-query stress tests against exhaustive oracles.

use osg_domain::{
    CompletionState, ProjectId, ScriptSpacing, TimedWord, TranscriptError, TranscriptRevision,
    TranscriptRevisionId, TranscriptTurn, TurnId, WordId,
};

use super::{make_revision, make_word};

#[test]
fn stress_test_spatial_index_active_word_overlapping() {
    let rev_id = TranscriptRevisionId::new();
    let w0 = make_word(rev_id, 1, "long", 0, 1000);
    let w1 = make_word(rev_id, 2, "short", 200, 400);
    let w2 = make_word(rev_id, 3, "nested", 600, 800);

    let t0 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w0.clone(), w1.clone(), w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w0, w1, w2], vec![t0]);

    // t=100: inside w0 only
    assert_eq!(rev.active_word_at(100).map(TimedWord::text), Some("long"));
    // t=300: inside w0 and w1 -> returns w1 (the more recent / specific word)
    assert_eq!(rev.active_word_at(300).map(TimedWord::text), Some("short"));
    // t=500: between w1 and w2, but inside w0 (0..1000)
    assert_eq!(rev.active_word_at(500).map(TimedWord::text), Some("long"));
    // t=700: inside w0 and w2 -> returns w2
    assert_eq!(rev.active_word_at(700).map(TimedWord::text), Some("nested"));
    // t=900: past w2, but inside w0
    assert_eq!(rev.active_word_at(900).map(TimedWord::text), Some("long"));
    // t=1000: at boundary
    assert_eq!(rev.active_word_at(1000), None);
}

#[test]
fn stress_test_words_in_range_fails_on_overlapping_words() {
    let rev_id = TranscriptRevisionId::new();
    // Word 0: 0..1000
    let w0 = make_word(rev_id, 1, "long", 0, 1000);
    // Word 1: 100..200
    let w1 = make_word(rev_id, 2, "w1", 100, 200);
    // Word 2: 200..300
    let w2 = make_word(rev_id, 3, "w2", 200, 300);
    // Word 3: 300..400
    let w3 = make_word(rev_id, 4, "w3", 300, 400);

    let t0 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w0.clone(), w1.clone(), w2.clone(), w3.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w0, w1, w2, w3], vec![t0]);

    // Query range 500..600. Word 0 [0, 1000] intersects [500, 600]!
    let slice = rev.words_in_range(500, 600);

    println!("words_in_range(500, 600) returned {} words", slice.len());
    // Verification: w0 is correctly returned!
    assert_eq!(slice.len(), 1, "Word 0 (0..1000) must intersect [500, 600]");
    assert_eq!(slice[0].text(), "long");
}

#[test]
fn stress_test_active_turn_at_breaks_early_on_overlapping_turns() {
    let rev_id = TranscriptRevisionId::new();
    let w0 = make_word(rev_id, 1, "speaker1_main", 0, 5000);
    let w1 = make_word(rev_id, 2, "speaker2_interrupt", 2000, 3000);
    let w2 = make_word(rev_id, 3, "speaker3_comment", 3500, 4000);

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

    let rev = make_revision(vec![w0, w1, w2], vec![t0, t1, t2]);

    // t=4500: t0 [0, 5000] is active. t1 and t2 ended.
    let active_turn = rev.active_turn_at(4500);

    println!(
        "active_turn_at(4500) = {:?}",
        active_turn.map(|t| (t.ordinal(), t.start_ms(), t.end_ms()))
    );
    assert!(
        active_turn.is_some(),
        "Turn 0 (0..5000) must be active at 4500ms"
    );
    assert_eq!(active_turn.unwrap().ordinal(), 1);

    // Multi-speaker concurrent turns lookup:
    let active_turns = rev.active_turns_at(2500);
    assert_eq!(
        active_turns.len(),
        2,
        "Both Turn 0 and Turn 1 must be active at 2500ms"
    );
    assert_eq!(active_turns[0].ordinal(), 1);
    assert_eq!(active_turns[1].ordinal(), 2);
}

#[test]
fn stress_test_restore_unsorted_words_binary_search_failure() {
    let rev_id = TranscriptRevisionId::new();
    // Words out of order:
    // Index 0: 1000..1100
    let w1 = make_word(rev_id, 1, "late_1", 1000, 1100);
    // Index 1: 1200..1300
    let w2 = make_word(rev_id, 2, "late_2", 1200, 1300);
    // Index 2: 100..300 (earlier start time placed at the end!)
    let w3 = make_word(rev_id, 3, "early_in_back", 100, 300);

    let t1 = TranscriptTurn::restore(
        TurnId::new(),
        rev_id,
        1,
        None,
        0,
        2000,
        "text".into(),
        vec![w1.id(), w2.id(), w3.id()],
    )
    .unwrap();

    // 1. TranscriptRevision::restore must reject unsorted words fail-closed:
    let restore_res = TranscriptRevision::restore(
        rev_id,
        ProjectId::new(),
        None,
        0,
        2000,
        "gemini".into(),
        "gemini-3.5-transcribe".into(),
        1,
        CompletionState::Completed,
        "fp".into(),
        1000,
        vec![w1.clone(), w2.clone(), w3.clone()],
        vec![t1.clone()],
    );
    assert!(
        matches!(restore_res, Err(TranscriptError::UnsortedWords { .. })),
        "restore must reject unsorted words fail-closed"
    );

    // 2. TranscriptRevision::reconstruct canonically sorts and re-ordinals:
    let reconstructed = TranscriptRevision::reconstruct(
        rev_id,
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
        vec![w1, w2, w3],
        vec![t1],
    )
    .expect("reconstruct sorts and reindexes");

    assert_eq!(reconstructed.words()[0].text(), "early_in_back");
    assert_eq!(reconstructed.words()[0].ordinal(), 1);
    assert_eq!(
        reconstructed.active_word_at(200).map(TimedWord::text),
        Some("early_in_back")
    );
}

#[test]
fn stress_test_words_in_range_exhaustive_oracle() {
    let rev_id = TranscriptRevisionId::new();
    let mut words = Vec::new();

    // Construct diverse words: overlapping, nested, zero-duration, identical start
    let timings = vec![
        (0, 1000, "w0_long"),
        (100, 200, "w1_nested"),
        (200, 200, "w2_zero"),
        (200, 500, "w3_overlap"),
        (300, 400, "w4_nested"),
        (500, 500, "w5_zero"),
        (500, 1200, "w6_long"),
        (600, 800, "w7_nested"),
        (1200, 1500, "w8_isolated"),
        (1500, 1500, "w9_zero"),
        (1500, 2000, "w10"),
    ];

    for (i, (start, end, text)) in timings.into_iter().enumerate() {
        words.push(make_word(
            rev_id,
            u32::try_from(i + 1).unwrap(),
            text,
            start,
            end,
        ));
    }

    let turn =
        TranscriptTurn::from_words(rev_id, 1, None, &words, ScriptSpacing::SpaceSeparated).unwrap();
    let rev = make_revision(words.clone(), vec![turn]);

    // Test a sweep of query ranges [q_start, q_end) against a ground-truth naive filter
    let test_ranges = vec![
        (0, 50),
        (0, 200),
        (50, 250),
        (200, 200), // empty range
        (300, 200), // inverted range
        (200, 201), // touches zero-duration w2
        (199, 200), // does not touch zero-duration w2
        (499, 501), // touches zero-duration w5
        (500, 600),
        (0, 2500),    // all words
        (2500, 3000), // beyond all words
        (-100, -10),  // negative range
        (-100, 50),   // crosses 0
    ];

    for (q_start, q_end) in test_ranges {
        let actual = rev.words_in_range(q_start, q_end);
        let actual_ids: Vec<WordId> = actual.iter().map(|w| w.id()).collect();

        let expected: Vec<&TimedWord> = if q_start >= q_end {
            Vec::new()
        } else {
            words
                .iter()
                .filter(|w| {
                    w.start_ms() < q_end
                        && (w.end_ms() > q_start
                            || (w.is_zero_duration() && w.start_ms() >= q_start))
                })
                .collect()
        };
        let expected_ids: Vec<WordId> = expected.iter().map(|w| w.id()).collect();

        assert_eq!(
            actual_ids, expected_ids,
            "Mismatch for query range [{q_start}, {q_end}): got {actual_ids:?}, expected {expected_ids:?}"
        );
    }
}

#[test]
fn stress_test_active_turn_at_exhaustive_oracle() {
    let rev_id = TranscriptRevisionId::new();
    let w0 = make_word(rev_id, 1, "w0", 0, 1000);
    let w1 = make_word(rev_id, 2, "w1", 1000, 2000);
    let w_b = make_word(rev_id, 3, "wb", 1500, 2500);
    let w2 = make_word(rev_id, 4, "w2", 2000, 3000);
    let w3 = make_word(rev_id, 5, "w3", 3000, 4000);
    let w_c = make_word(rev_id, 6, "wc", 3500, 4500);
    let w4 = make_word(rev_id, 7, "w4", 4000, 5000);

    // Turn 1: 0..5000 (Spk A - continuous background/host)
    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        Some("spk_a".into()),
        &[w0.clone(), w1.clone(), w2.clone(), w3.clone(), w4.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    // Turn 2: 1500..2500 (Spk B - interruption)
    let t2 = TranscriptTurn::from_words(
        rev_id,
        2,
        Some("spk_b".into()),
        std::slice::from_ref(&w_b),
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    // Turn 3: 3500..4500 (Spk C - interjection)
    let t3 = TranscriptTurn::from_words(
        rev_id,
        3,
        Some("spk_c".into()),
        std::slice::from_ref(&w_c),
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let turns = vec![t1, t2, t3];
    let all_words = vec![w0, w1, w_b, w2, w3, w_c, w4];

    let rev = make_revision(all_words, turns);

    // Check boundary transitions
    // t = 0: Turn 1 active
    assert_eq!(rev.active_turn_at(0).unwrap().speaker_id(), Some("spk_a"));
    assert_eq!(rev.active_turns_at(0).len(), 1);

    // t = 2000: Turn 1 and Turn 2 active
    let active_2000 = rev.active_turns_at(2000);
    assert_eq!(active_2000.len(), 2);
    assert_eq!(active_2000[0].speaker_id(), Some("spk_a"));
    assert_eq!(active_2000[1].speaker_id(), Some("spk_b"));
    // active_turn_at returns the most recent (Turn 2)
    assert_eq!(
        rev.active_turn_at(2000).unwrap().speaker_id(),
        Some("spk_b")
    );

    // t = 3000: Turn 1 active, Turn 2 ended, Turn 3 not started
    assert_eq!(
        rev.active_turn_at(3000).unwrap().speaker_id(),
        Some("spk_a")
    );
    assert_eq!(rev.active_turns_at(3000).len(), 1);

    // t = 4000: Turn 1 and Turn 3 active
    let active_4000 = rev.active_turns_at(4000);
    assert_eq!(active_4000.len(), 2);
    assert_eq!(active_4000[0].speaker_id(), Some("spk_a"));
    assert_eq!(active_4000[1].speaker_id(), Some("spk_c"));
    assert_eq!(
        rev.active_turn_at(4000).unwrap().speaker_id(),
        Some("spk_c")
    );

    // t = 5000: Turn 1 at exact boundary
    assert_eq!(
        rev.active_turn_at(5000).unwrap().speaker_id(),
        Some("spk_a")
    );

    // t = 5001: After all turns
    assert!(rev.active_turn_at(5001).is_none());
    assert!(rev.active_turns_at(5001).is_empty());
}
