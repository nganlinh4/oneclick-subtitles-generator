//! Regrouping extremes and restore-validation boundary stress tests.

use osg_domain::{
    CaptionProjection, CompletionState, CustomGroupingConfig, GroupingPolicy, ProjectId,
    ScriptSpacing, TimedWord, TrackId, TrackOrigin, TranscriptError, TranscriptRevision,
    TranscriptRevisionId, TranscriptTurn, TurnId,
};

use super::{make_revision, make_word};

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
    let t_cjk =
        TranscriptTurn::from_words(rev_id, 1, None, &cjk_words, ScriptSpacing::NoSpaces).unwrap();
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
    let t_punct =
        TranscriptTurn::from_words(rev_id, 1, None, &punct_words, ScriptSpacing::SpaceSeparated)
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

fn assert_word_cannot_belong_to_multiple_turns(
    rev_id: TranscriptRevisionId,
    w1: &TimedWord,
    w2: &TimedWord,
) {
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
        vec![w1.id(), w2.id()],
    )
    .unwrap();

    let result = TranscriptRevision::restore(
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
    assert!(matches!(
        result,
        Err(TranscriptError::WordInMultipleTurns(_))
    ));
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
    assert!(matches!(
        res_dup_word,
        Err(TranscriptError::DuplicateWord(_))
    ));

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
    assert!(matches!(
        res_unsorted,
        Err(TranscriptError::UnsortedWords { .. })
    ));

    // 3. A word referenced in multiple turns is rejected.
    assert_word_cannot_belong_to_multiple_turns(rev_id, &w1, &w2);
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

    let turn =
        TranscriptTurn::from_words(rev_id, 1, None, &words, ScriptSpacing::SpaceSeparated).unwrap();

    let rev = make_revision(words, vec![turn]);

    // Test OneWord grouping across 1,000 words
    let proj_one = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord {
            min_duration_ms: 50,
        },
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
    let track = proj_short
        .to_subtitle_track("Track", TrackOrigin::Srt)
        .unwrap();
    assert_eq!(track.cues().len(), 200);
    for cue in track.cues() {
        assert!(cue.end_ms() > cue.start_ms());
    }
}
