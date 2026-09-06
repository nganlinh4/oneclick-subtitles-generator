use osg_domain::{
    CaptionProjection, CompletionState, CueId, CustomGroupingConfig, GroupingPolicy,
    ManualEditState, ProjectId, ScriptSpacing, TimedWord, TrackId, TrackOrigin,
    TranscriptError, TranscriptRevision, TranscriptRevisionId, TranscriptTurn, TurnId, WordId,
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

fn make_revision(
    words: Vec<TimedWord>,
    turns: Vec<TranscriptTurn>,
) -> TranscriptRevision {
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

    println!("active_turn_at(4500) = {:?}", active_turn.map(|t| (t.ordinal(), t.start_ms(), t.end_ms())));
    assert!(active_turn.is_some(), "Turn 0 (0..5000) must be active at 4500ms");
    assert_eq!(active_turn.unwrap().ordinal(), 1);

    // Multi-speaker concurrent turns lookup:
    let active_turns = rev.active_turns_at(2500);
    assert_eq!(active_turns.len(), 2, "Both Turn 0 and Turn 1 must be active at 2500ms");
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
fn stress_test_split_cue_zero_duration_invalidates_track() {
    let rev_id = TranscriptRevisionId::new();
    // Zero duration word w1: 1000..1000
    let w1 = TimedWord::new(
        rev_id,
        1,
        "instant",
        "1.0s",
        "1.0s",
        1000,
        1000,
        None,
        None,
    )
    .unwrap();
    let w2 = make_word(rev_id, 2, "normal", 1000, 2000);

    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w1, w2], vec![t1]);

    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Natural {
            pause_threshold_ms: 300,
            max_words: 10,
            max_characters: 40,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let cue_id = proj.cues()[0].id;
    let (c1, c2) = proj
        .split_cue(cue_id, 1, &rev, ScriptSpacing::SpaceSeparated)
        .expect("split_cue should succeed");

    let cue1 = proj.cues().iter().find(|c| c.id == c1).unwrap();
    let cue2 = proj.cues().iter().find(|c| c.id == c2).unwrap();
    println!("After split: cue1 start={} end={}", cue1.start_ms, cue1.end_ms);
    println!("After split: cue2 start={} end={}", cue2.start_ms, cue2.end_ms);

    // Verification: cue1 duration clamped to at least start_ms + 50
    assert_eq!(cue1.start_ms, 1000);
    assert_eq!(cue1.end_ms, 1050);
    assert!(cue1.end_ms > cue1.start_ms);
    assert!(cue2.end_ms > cue2.start_ms);

    // Convert to SubtitleTrack succeeds:
    let track = proj
        .to_subtitle_track("Track", TrackOrigin::Srt)
        .expect("to_subtitle_track must succeed for clamped split cues");
    assert_eq!(track.cues().len(), 2);
}

#[test]
fn stress_test_merge_cues_erases_user_text() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = make_word(rev_id, 1, "raw1", 0, 500);
    let w2 = make_word(rev_id, 2, "raw2", 600, 1000);

    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w1, w2], vec![t1]);

    let proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord { min_duration_ms: 50 },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    // Roundtrip through JSON to simulate user editing cue text in UI
    let mut val = serde_json::to_value(&proj).unwrap();
    val["cues"][0]["text"] = serde_json::Value::String("USER_CUSTOM_TEXT".into());
    val["cues"][0]["manualState"] = serde_json::Value::String("edited_text".into());
    let mut proj: CaptionProjection = serde_json::from_value(val).unwrap();

    let c0_id = proj.cues()[0].id;
    let c1_id = proj.cues()[1].id;

    let merged_id = proj
        .merge_cues(c0_id, c1_id, &rev, ScriptSpacing::SpaceSeparated)
        .expect("merge succeeds");

    let merged_cue = proj.cues().iter().find(|c| c.id == merged_id).unwrap();
    println!("Merged cue text: '{}'", merged_cue.text);
    // Verification: user text is preserved!
    assert_eq!(merged_cue.text, "USER_CUSTOM_TEXT raw2");
    assert_eq!(merged_cue.manual_state, ManualEditState::EditedText);
}

#[test]
fn stress_test_create_cue_truncates_overlapping_word_duration() {
    let rev_id = TranscriptRevisionId::new();
    // Word 0 spans 0..5000 (long sustained word or phrase)
    let w0 = make_word(rev_id, 1, "long_word", 0, 5000);
    // Word 1 starts at 500 and ends at 1000
    let w1 = make_word(rev_id, 2, "short_word", 500, 1000);

    let t0 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w0.clone(), w1.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w0, w1], vec![t0]);

    let proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 5,
            max_duration_ms: 10000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    assert_eq!(proj.cues().len(), 1);
    let cue = &proj.cues()[0];
    println!("Grouped cue bounds: start_ms={} end_ms={}", cue.start_ms, cue.end_ms);

    // Verification: create_cue_from_slice covers the longest word end_ms (5000ms)
    assert_eq!(cue.start_ms, 0);
    assert_eq!(cue.end_ms, 5000, "cue.end_ms must equal max(w.end_ms) across the slice");
}

#[test]
fn stress_test_offline_regrouping_extreme_inputs() {
    let rev_id = TranscriptRevisionId::new();

    // Extreme case 1: CJK without spaces (Chinese, Korean, Japanese)
    let cjk_words = vec![
        make_word(rev_id, 1, "안녕하세요", 0, 500),
        make_word(rev_id, 2, "세상입니다。", 500, 1000),
        make_word(rev_id, 3, "반갑습니다！", 1000, 1500),
        make_word(rev_id, 4, "你好世界", 1500, 2000),
    ];
    let t_cjk = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &cjk_words,
        ScriptSpacing::NoSpaces,
    )
    .unwrap();
    let rev_cjk = make_revision(cjk_words, vec![t_cjk]);

    let proj_cjk = CaptionProjection::project(
        &rev_cjk,
        TrackId::new(),
        GroupingPolicy::Natural {
            pause_threshold_ms: 300,
            max_words: 10,
            max_characters: 40,
        },
        ScriptSpacing::NoSpaces,
    )
    .unwrap();

    assert_eq!(proj_cjk.cues()[0].text, "안녕하세요세상입니다。");
    assert_eq!(proj_cjk.cues()[1].text, "반갑습니다！");

    // Extreme case 2: Punctuation cascade
    let punct_words = vec![
        make_word(rev_id, 1, "what", 0, 200),
        make_word(rev_id, 2, "?!?!", 200, 400),
        make_word(rev_id, 3, "really", 400, 600),
        make_word(rev_id, 4, "....", 600, 800),
    ];
    let t_punct = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &punct_words,
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let rev_punct = make_revision(punct_words, vec![t_punct]);

    let proj_punct = CaptionProjection::project(
        &rev_punct,
        TrackId::new(),
        GroupingPolicy::Natural {
            pause_threshold_ms: 300,
            max_words: 10,
            max_characters: 40,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert!(!proj_punct.cues().is_empty());
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

    let turn = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &words,
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
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
        (0, 2500),  // all words
        (2500, 3000), // beyond all words
        (-100, -10), // negative range
        (-100, 50),  // crosses 0
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
                        && (w.end_ms() > q_start || (w.is_zero_duration() && w.start_ms() >= q_start))
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
    assert_eq!(rev.active_turn_at(2000).unwrap().speaker_id(), Some("spk_b"));

    // t = 3000: Turn 1 active, Turn 2 ended, Turn 3 not started
    assert_eq!(rev.active_turn_at(3000).unwrap().speaker_id(), Some("spk_a"));
    assert_eq!(rev.active_turns_at(3000).len(), 1);

    // t = 4000: Turn 1 and Turn 3 active
    let active_4000 = rev.active_turns_at(4000);
    assert_eq!(active_4000.len(), 2);
    assert_eq!(active_4000[0].speaker_id(), Some("spk_a"));
    assert_eq!(active_4000[1].speaker_id(), Some("spk_c"));
    assert_eq!(rev.active_turn_at(4000).unwrap().speaker_id(), Some("spk_c"));

    // t = 5000: Turn 1 at exact boundary
    assert_eq!(rev.active_turn_at(5000).unwrap().speaker_id(), Some("spk_a"));

    // t = 5001: After all turns
    assert!(rev.active_turn_at(5001).is_none());
    assert!(rev.active_turns_at(5001).is_empty());
}

#[test]
fn stress_test_split_cue_comprehensive_boundaries() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = make_word(rev_id, 1, "first", 0, 500);
    let w2 = make_word(rev_id, 2, "second", 500, 1000);
    let w3 = make_word(rev_id, 3, "third", 1000, 1500);

    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone(), w3.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w1, w2, w3], vec![t1]);

    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Natural {
            pause_threshold_ms: 300,
            max_words: 10,
            max_characters: 40,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    assert_eq!(proj.cues().len(), 1);
    let cue_id = proj.cues()[0].id;

    // 1. Boundary: split at index 0 must fail
    assert_eq!(
        proj.split_cue(cue_id, 0, &rev, ScriptSpacing::SpaceSeparated),
        Err(TranscriptError::InvalidSplitIndex)
    );

    // 2. Boundary: split at index == len (3) must fail
    assert_eq!(
        proj.split_cue(cue_id, 3, &rev, ScriptSpacing::SpaceSeparated),
        Err(TranscriptError::InvalidSplitIndex)
    );

    // 3. Boundary: split at index > len (10) must fail
    assert_eq!(
        proj.split_cue(cue_id, 10, &rev, ScriptSpacing::SpaceSeparated),
        Err(TranscriptError::InvalidSplitIndex)
    );

    // 4. Valid split at index 1 -> produces cues with 1 word and 2 words
    let (c1, c2) = proj.split_cue(cue_id, 1, &rev, ScriptSpacing::SpaceSeparated).unwrap();
    assert_eq!(proj.cues().len(), 2);
    assert_eq!(proj.cues()[0].id, c1);
    assert_eq!(proj.cues()[0].text, "first");
    assert_eq!(proj.cues()[0].ordinal, 1);
    assert_eq!(proj.cues()[0].manual_state, ManualEditState::EditedText);
    assert_eq!(proj.cues()[1].id, c2);
    assert_eq!(proj.cues()[1].text, "second third");
    assert_eq!(proj.cues()[1].ordinal, 2);

    // 5. Splitting single-word cue c1 must fail (len == 1, split at 1 is at boundary)
    let res_single = proj.split_cue(c1, 1, &rev, ScriptSpacing::SpaceSeparated);
    assert_eq!(res_single, Err(TranscriptError::InvalidSplitIndex));

    // 6. Split c2 at index 1 -> produces 3 total cues
    let (c2_1, c2_2) = proj.split_cue(c2, 1, &rev, ScriptSpacing::SpaceSeparated).unwrap();
    assert_eq!(proj.cues().len(), 3);
    assert_eq!(proj.cues()[1].id, c2_1);
    assert_eq!(proj.cues()[1].text, "second");
    assert_eq!(proj.cues()[2].id, c2_2);
    assert_eq!(proj.cues()[2].text, "third");

    // Ordinals are 1, 2, 3
    for (i, cue) in proj.cues().iter().enumerate() {
        assert_eq!(cue.ordinal, u32::try_from(i + 1).unwrap());
    }
}

#[test]
fn stress_test_merge_cues_comprehensive_boundaries() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = make_word(rev_id, 1, "alpha", 0, 500);
    let w2 = make_word(rev_id, 2, "beta", 500, 1000);
    let w3 = make_word(rev_id, 3, "gamma", 1000, 1500);

    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone(), w3.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(vec![w1, w2, w3], vec![t1]);

    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord { min_duration_ms: 50 },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    assert_eq!(proj.cues().len(), 3);
    let id0 = proj.cues()[0].id;
    let id1 = proj.cues()[1].id;
    let id2 = proj.cues()[2].id;

    // 1. Non-adjacent merge (id0 with id2) must fail
    let err_non_adj = proj.merge_cues(id0, id2, &rev, ScriptSpacing::SpaceSeparated);
    assert_eq!(err_non_adj, Err(TranscriptError::CuesNotAdjacent));

    // 2. Inverted order (id1 with id0) must fail
    let err_inv = proj.merge_cues(id1, id0, &rev, ScriptSpacing::SpaceSeparated);
    assert_eq!(err_inv, Err(TranscriptError::CuesNotAdjacent));

    // 3. Unknown cue ID must fail
    let fake_id = CueId::new();
    let err_unknown = proj.merge_cues(id0, fake_id, &rev, ScriptSpacing::SpaceSeparated);
    assert_eq!(err_unknown, Err(TranscriptError::CueNotFound(fake_id)));

    // 4. Test ScriptSpacing::NoSpaces (CJK)
    let merged_id = proj.merge_cues(id0, id1, &rev, ScriptSpacing::NoSpaces).unwrap();
    assert_eq!(proj.cues().len(), 2);
    let merged_cue = proj.cues().iter().find(|c| c.id == merged_id).unwrap();
    assert_eq!(merged_cue.text, "alphabeta");

    // 5. Test merging with remaining cue (id2) using SpaceSeparated
    let final_id = proj.merge_cues(merged_id, id2, &rev, ScriptSpacing::SpaceSeparated).unwrap();
    assert_eq!(proj.cues().len(), 1);
    let final_cue = &proj.cues()[0];
    assert_eq!(final_cue.id, final_id);
    assert_eq!(final_cue.text, "alphabeta gamma");
    assert_eq!(final_cue.start_ms, 0);
    assert_eq!(final_cue.end_ms, 1500);
}

#[test]
fn stress_test_restore_validation_boundary_conditions() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = make_word(rev_id, 1, "w1", 100, 200);
    let w2 = make_word(rev_id, 2, "w2", 200, 300);

    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    // 1. Duplicate word ID rejected:
    let res_dup_word = TranscriptRevision::restore(
        rev_id,
        ProjectId::new(),
        None,
        0,
        1000,
        "gemini".into(),
        "gemini-3.5-transcribe".into(),
        1,
        CompletionState::Completed,
        "fp".into(),
        1000,
        vec![w1.clone(), w1.clone()], // duplicate word
        vec![t1.clone()],
    );
    assert!(matches!(res_dup_word, Err(TranscriptError::DuplicateWord(_))));

    // 2. Out-of-order words rejected with UnsortedWords:
    let w_late = make_word(rev_id, 1, "late", 500, 600);
    let w_early = make_word(rev_id, 2, "early", 100, 200);
    let t_order = TranscriptTurn::restore(
        TurnId::new(),
        rev_id,
        1,
        None,
        0,
        1000,
        "text".into(),
        vec![w_late.id(), w_early.id()],
    )
    .unwrap();

    let res_unsorted = TranscriptRevision::restore(
        rev_id,
        ProjectId::new(),
        None,
        0,
        1000,
        "gemini".into(),
        "gemini-3.5-transcribe".into(),
        1,
        CompletionState::Completed,
        "fp".into(),
        1000,
        vec![w_late, w_early],
        vec![t_order],
    );
    assert!(matches!(res_unsorted, Err(TranscriptError::UnsortedWords { .. })));

    // 3. Word referenced in multiple turns rejected:
    let t_dup1 = TranscriptTurn::restore(
        TurnId::new(),
        rev_id,
        1,
        None,
        100,
        200,
        "w1".into(),
        vec![w1.id()],
    )
    .unwrap();
    let t_dup2 = TranscriptTurn::restore(
        TurnId::new(),
        rev_id,
        2,
        None,
        100,
        300,
        "w1 w2".into(),
        vec![w1.id(), w2.id()], // w1 claimed again!
    )
    .unwrap();

    let res_multi_turn = TranscriptRevision::restore(
        rev_id,
        ProjectId::new(),
        None,
        0,
        1000,
        "gemini".into(),
        "gemini-3.5-transcribe".into(),
        1,
        CompletionState::Completed,
        "fp".into(),
        1000,
        vec![w1.clone(), w2.clone()],
        vec![t_dup1, t_dup2],
    );
    assert!(matches!(res_multi_turn, Err(TranscriptError::WordInMultipleTurns(_))));
}

#[test]
fn stress_test_grouping_policies_extreme_scale() {
    let rev_id = TranscriptRevisionId::new();
    let mut words = Vec::with_capacity(1000);

    for i in 0u32..1000u32 {
        let start = i64::from(i) * 100;
        let end = start + 80;
        words.push(make_word(rev_id, i + 1, &format!("w{i}"), start, end));
    }

    let turn = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &words,
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = make_revision(words, vec![turn]);

    // Test OneWord grouping across 1,000 words
    let proj_one = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord { min_duration_ms: 50 },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert_eq!(proj_one.cues().len(), 1000);

    // Test Short grouping (5 words per cue -> 200 cues)
    let proj_short = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 5,
            max_duration_ms: 5000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert_eq!(proj_short.cues().len(), 200);

    // Test Custom grouping with multiple constraints
    let proj_custom = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Custom(CustomGroupingConfig {
            pause_threshold_ms: 50,
            split_on_punctuation: true,
            max_words: Some(10),
            max_characters: Some(100),
            max_duration_ms: Some(2000),
        }),
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert!(!proj_custom.cues().is_empty());

    // Verify all generated cues convert to valid SubtitleTrack
    let track = proj_short.to_subtitle_track("Track", TrackOrigin::Srt).unwrap();
    assert_eq!(track.cues().len(), 200);
    for cue in track.cues() {
        assert!(cue.end_ms() > cue.start_ms());
    }
}

