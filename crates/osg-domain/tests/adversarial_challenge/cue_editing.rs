//! Split, merge, and cue-creation boundary stress tests.

use osg_domain::{
    CaptionProjection, CueId, GroupingPolicy, ManualEditState, ScriptSpacing, TimedWord, TrackId,
    TrackOrigin, TranscriptError, TranscriptRevisionId, TranscriptTurn,
};

use super::{make_revision, make_word};

#[test]
fn stress_test_split_cue_zero_duration_invalidates_track() {
    let rev_id = TranscriptRevisionId::new();
    // Zero duration word w1: 1000..1000
    let w1 = TimedWord::new(rev_id, 1, "instant", "1.0s", "1.0s", 1000, 1000, None, None).unwrap();
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
    println!(
        "After split: cue1 start={} end={}",
        cue1.start_ms, cue1.end_ms
    );
    println!(
        "After split: cue2 start={} end={}",
        cue2.start_ms, cue2.end_ms
    );

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
        GroupingPolicy::OneWord {
            min_duration_ms: 50,
        },
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
    println!(
        "Grouped cue bounds: start_ms={} end_ms={}",
        cue.start_ms, cue.end_ms
    );

    // Verification: create_cue_from_slice covers the longest word end_ms (5000ms)
    assert_eq!(cue.start_ms, 0);
    assert_eq!(
        cue.end_ms, 5000,
        "cue.end_ms must equal max(w.end_ms) across the slice"
    );
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
    let (c1, c2) = proj
        .split_cue(cue_id, 1, &rev, ScriptSpacing::SpaceSeparated)
        .unwrap();
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
    let (c2_1, c2_2) = proj
        .split_cue(c2, 1, &rev, ScriptSpacing::SpaceSeparated)
        .unwrap();
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
        GroupingPolicy::OneWord {
            min_duration_ms: 50,
        },
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
    let merged_id = proj
        .merge_cues(id0, id1, &rev, ScriptSpacing::NoSpaces)
        .unwrap();
    assert_eq!(proj.cues().len(), 2);
    let merged_cue = proj.cues().iter().find(|c| c.id == merged_id).unwrap();
    assert_eq!(merged_cue.text, "alphabeta");

    // 5. Test merging with remaining cue (id2) using SpaceSeparated
    let final_id = proj
        .merge_cues(merged_id, id2, &rev, ScriptSpacing::SpaceSeparated)
        .unwrap();
    assert_eq!(proj.cues().len(), 1);
    let final_cue = &proj.cues()[0];
    assert_eq!(final_cue.id, final_id);
    assert_eq!(final_cue.text, "alphabeta gamma");
    assert_eq!(final_cue.start_ms, 0);
    assert_eq!(final_cue.end_ms, 1500);
}
