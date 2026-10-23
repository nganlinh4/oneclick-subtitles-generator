//! Projection policy, regrouping, split/merge, and export tests.

use crate::ids::{CueId, ProjectId, TrackId, TranscriptRevisionId};
use crate::subtitles::{SubtitleCue, SubtitleTrack, TrackOrigin};
use crate::transcripts::*;

#[test]
fn test_project_one_word_policy() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "one", "0.1s", "0.5s", 100, 500, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "zero", "0.6s", "0.6s", 600, 600, None, None).unwrap();
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

    let proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord {
            min_duration_ms: 60,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    assert_eq!(proj.cues().len(), 2);
    assert_eq!(proj.cues()[0].text, "one");
    assert_eq!(proj.cues()[1].text, "zero");
    assert_eq!(proj.cues()[1].start_ms, 600);
    assert_eq!(proj.cues()[1].end_ms, 660); // padded to min_duration_ms
}

#[test]
fn test_project_natural_policy_splits_on_punctuation_and_pause() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "Hello.", "0s", "0.4s", 0, 400, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "World", "0.5s", "0.8s", 500, 800, None, None).unwrap();
    let w3 = TimedWord::new(rev_id, 3, "pause", "1.5s", "1.8s", 1500, 1800, None, None).unwrap();
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
        3000,
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

    let proj = CaptionProjection::project(
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

    assert_eq!(proj.cues().len(), 3);
    assert_eq!(proj.cues()[0].text, "Hello.");
    assert_eq!(proj.cues()[1].text, "World");
    assert_eq!(proj.cues()[2].text, "pause");
}

#[test]
fn test_project_short_policy_splits_on_word_count() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let mut words = Vec::new();
    for i in 1..=12 {
        words.push(
            TimedWord::new(
                rev_id,
                i,
                format!("w{i}"),
                format!("{}s", i - 1),
                format!("{i}s"),
                (i64::from(i) - 1) * 1000,
                i64::from(i) * 1000,
                None,
                None,
            )
            .unwrap(),
        );
    }
    let t1 =
        TranscriptTurn::from_words(rev_id, 1, None, &words, ScriptSpacing::SpaceSeparated).unwrap();
    let rev = TranscriptRevision::new(
        proj_id,
        None,
        0,
        15000,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp",
        1000,
        words,
        vec![t1],
    )
    .unwrap();

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

    assert_eq!(proj.cues().len(), 3);
    assert_eq!(proj.cues()[0].word_ids.len(), 5);
    assert_eq!(proj.cues()[1].word_ids.len(), 5);
    assert_eq!(proj.cues()[2].word_ids.len(), 2);
}

#[test]
fn test_regroup_preserving_edits_leaves_user_cues_untouched() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "w2", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
    let w3 = TimedWord::new(rev_id, 3, "w3", "1.0s", "1.5s", 1000, 1500, None, None).unwrap();
    let w4 = TimedWord::new(rev_id, 4, "w4", "1.5s", "2.0s", 1500, 2000, None, None).unwrap();
    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone(), w3.clone(), w4.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = TranscriptRevision::new(
        proj_id,
        None,
        0,
        3000,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp",
        1000,
        vec![w1, w2, w3, w4],
        vec![t1],
    )
    .unwrap();

    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 2,
            max_duration_ms: 5000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    assert_eq!(proj.cues().len(), 2);
    // User edits cue #2
    proj.cues[1].text = "USER EDITED".into();
    proj.cues[1].manual_state = ManualEditState::EditedText;

    // Regroup under OneWord
    let regrouped = proj
        .regroup_preserving_edits(
            &rev,
            GroupingPolicy::OneWord {
                min_duration_ms: 50,
            },
            ScriptSpacing::SpaceSeparated,
        )
        .unwrap();

    // Cues 1 and 2 (from w1 and w2) become 2 one-word cues; cue 2 is preserved with USER EDITED!
    assert_eq!(regrouped.cues().len(), 3);
    assert_eq!(regrouped.cues()[0].text, "w1");
    assert_eq!(regrouped.cues()[1].text, "w2");
    assert_eq!(regrouped.cues()[2].text, "USER EDITED");
}

#[test]
fn test_split_cue_at_word_boundary() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "w2", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
    let w3 = TimedWord::new(rev_id, 3, "w3", "1.0s", "1.5s", 1000, 1500, None, None).unwrap();
    let w4 = TimedWord::new(rev_id, 4, "w4", "1.5s", "2.0s", 1500, 2000, None, None).unwrap();
    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone(), w3.clone(), w4.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = TranscriptRevision::new(
        proj_id,
        None,
        0,
        3000,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp",
        1000,
        vec![w1, w2, w3, w4],
        vec![t1],
    )
    .unwrap();

    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 10,
            max_duration_ms: 10000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let cue_id = proj.cues()[0].id;
    let (c1, c2) = proj
        .split_cue(cue_id, 2, &rev, ScriptSpacing::SpaceSeparated)
        .unwrap();
    assert_eq!(proj.cues().len(), 2);
    assert_eq!(proj.cues()[0].id, c1);
    assert_eq!(proj.cues()[0].text, "w1 w2");
    assert_eq!(proj.cues()[1].id, c2);
    assert_eq!(proj.cues()[1].text, "w3 w4");
}

#[test]
fn test_merge_adjacent_cues() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "w1", "0s", "0.5s", 0, 500, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "w2", "0.5s", "1.0s", 500, 1000, None, None).unwrap();
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
        3000,
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

    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord {
            min_duration_ms: 50,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let c1_id = proj.cues()[0].id;
    let c2_id = proj.cues()[1].id;

    let merged_id = proj
        .merge_cues(c1_id, c2_id, &rev, ScriptSpacing::SpaceSeparated)
        .unwrap();
    assert_eq!(proj.cues().len(), 1);
    assert_eq!(proj.cues()[0].id, merged_id);
    assert_eq!(proj.cues()[0].text, "w1 w2");
    assert_eq!(proj.cues()[0].start_ms, 0);
    assert_eq!(proj.cues()[0].end_ms, 1000);
}

#[test]
fn test_to_subtitle_track_conversion() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "test", "0s", "0.5s", 0, 500, None, None).unwrap();
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

    let track = proj.to_subtitle_track("English", TrackOrigin::Srt).unwrap();
    assert_eq!(track.label(), "English");
    assert_eq!(track.cues().len(), 1);
    assert_eq!(track.cues()[0].text(), "test");
}

#[test]
fn test_cue_word_mappings_extraction() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "test", "0s", "0.5s", 0, 500, None, None).unwrap();
    let w1_id = w1.id();
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

    let mappings = proj.cue_word_mappings();
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].1, vec![w1_id]);
}

#[test]
fn test_active_word_in_cue_highlighting() {
    let proj_id = ProjectId::new();
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "hello", "0.1s", "0.4s", 100, 400, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "world", "0.5s", "0.9s", 500, 900, None, None).unwrap();
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

    let proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Natural {
            pause_threshold_ms: 1000,
            max_words: 10,
            max_characters: 40,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let cue = &proj.cues()[0];
    assert_eq!(
        proj.active_word_in_cue(cue, &rev, 250).map(TimedWord::text),
        Some("hello")
    );
    assert_eq!(
        proj.active_word_in_cue(cue, &rev, 450).map(TimedWord::text),
        None
    );
    assert_eq!(
        proj.active_word_in_cue(cue, &rev, 700).map(TimedWord::text),
        Some("world")
    );
}

#[test]
fn test_pre_change_cue_only_tracks_unaffected() {
    let cue = SubtitleCue::restore(CueId::new(), 1, 0, 1000, "legacy cue".into(), None).unwrap();
    let track = SubtitleTrack::restore(TrackId::new(), "Legacy Track", TrackOrigin::Srt, vec![cue])
        .unwrap();
    assert_eq!(track.origin(), TrackOrigin::Srt);
    assert_eq!(track.cues().len(), 1);
    assert_eq!(track.cues()[0].text(), "legacy cue");
}

#[test]
fn test_split_cue_duration_clamp_with_zero_duration() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(rev_id, 1, "zero", "1s", "1s", 1000, 1000, None, None).unwrap();
    let w2 = TimedWord::new(rev_id, 2, "word", "1s", "2s", 1000, 2000, None, None).unwrap();
    let t1 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w1.clone(), w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = TranscriptRevision::new(
        ProjectId::new(),
        None,
        0,
        3000,
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
        .unwrap();

    let cue1 = proj.cues().iter().find(|c| c.id == c1).unwrap();
    let cue2 = proj.cues().iter().find(|c| c.id == c2).unwrap();
    assert_eq!(cue1.start_ms, 1000);
    assert_eq!(cue1.end_ms, 1050);
    assert!(cue1.end_ms > cue1.start_ms);
    assert!(cue2.end_ms > cue2.start_ms);

    let track = proj.to_subtitle_track("Track", TrackOrigin::Srt).unwrap();
    assert_eq!(track.cues().len(), 2);
}
