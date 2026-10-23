//! Natural cue grouping and bulk promotion of finalized words.

use super::*;

#[test]
fn adjacent_speakers_produce_separate_cues_without_invented_confidence() {
    let staging = StagingBuffer::new();
    let first = make_test_word("Hello", 0, 500);
    let mut second = make_test_word("Goodbye", 500, 1000);
    second.speaker_id = Some("speaker_1".to_owned());
    let mut unknown = make_test_word("Unidentified", 1000, 1500);
    unknown.speaker_id = None;
    let promoted = staging.prepare_promotion(
        TranscriptRevisionId::new(),
        StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![first, second, unknown],
        },
    );
    assert_eq!(promoted.projected_cues.len(), 3);
    for (cue, (text, speaker, start)) in promoted.projected_cues.iter().zip([
        ("Hello", Some("speaker_0"), 0),
        ("Goodbye", Some("speaker_1"), 500),
        ("Unidentified", None, 1000),
    ]) {
        assert_eq!(cue.text, text);
        assert_eq!(cue.speaker_id.as_deref(), speaker);
        assert_eq!(cue.start_ms, start);
        assert_eq!(cue.end_ms, start + 500);
        assert_eq!(cue.word_ids.len(), 1);
    }
    assert!(
        promoted
            .word_records
            .iter()
            .all(|word| word.confidence.is_none())
    );
    assert!(
        promoted
            .word_dtos
            .iter()
            .all(|word| word.confidence.is_none())
    );
}

#[test]
fn natural_grouping_ignores_brief_hesitation_but_splits_a_substantial_pause() {
    let promoted = StagingBuffer::new().prepare_promotion(
        TranscriptRevisionId::new(),
        StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![
                make_test_word("Hello", 0, 500),
                make_test_word("there", 500, 1000),
                make_test_word("Again", 1300, 1800),
                make_test_word("later", 2800, 3200),
            ],
        },
    );
    assert_eq!(promoted.projected_cues.len(), 2);
    assert_eq!(promoted.projected_cues[0].text, "Hello there Again");
    assert_eq!(promoted.projected_cues[0].word_ids.len(), 3);
    assert_eq!(promoted.projected_cues[1].text, "later");
}

#[test]
fn natural_grouping_merges_tiny_finalized_sentences_into_a_readable_tail() {
    let promoted = StagingBuffer::new().prepare_promotion(
        TranscriptRevisionId::new(),
        StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![
                make_test_word("Yes.", 0, 300),
                make_test_word("I", 320, 450),
                make_test_word("agree.", 450, 800),
                make_test_word("Let's", 820, 1_050),
                make_test_word("continue.", 1_050, 1_500),
            ],
        },
    );
    assert_eq!(promoted.projected_cues.len(), 1);
    assert_eq!(
        promoted.projected_cues[0].text,
        "Yes. I agree. Let's continue."
    );
}

#[test]
#[allow(clippy::too_many_lines)]
fn thousands_of_live_interpolated_words_promote_into_sqlite() {
    use osg_domain::ProjectMetadata;
    use osg_infrastructure::storage::{Database, TranscriptRevisionRecord};
    use tempfile::tempdir;

    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("live-promotion.db")).unwrap();
    let project = ProjectMetadata::new("Live promotion").unwrap();
    database.create_project(&project).unwrap();
    let revision_id = TranscriptRevisionId::new();
    database
        .transcript_insert_revision(&TranscriptRevisionRecord {
            id: revision_id,
            project_id: project.id(),
            media_id: None,
            provider: "gemini".to_owned(),
            model: "gemini-3.5-transcribe-live".to_owned(),
            source_range_start_ms: 0,
            source_range_end_ms: 600_000,
            state: "in_progress".to_owned(),
            fingerprint: "live-promotion".to_owned(),
            word_count: 0,
            metadata_json: "{}".to_owned(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
    let words = (0_i64..3_500)
        .map(|index| ProjectedWordResult {
            status: WordProjectionStatus::Interpolated,
            text: format!("w{index}"),
            raw_start_ns: (index * 100_000_000).cast_unsigned(),
            raw_end_ns: (index * 100_000_000 + 90_000_000).cast_unsigned(),
            project_start_ms: index * 100,
            project_end_ms: index * 100 + 90,
            speaker_id: None,
            is_unaligned: true,
            alignment_status: "unaligned".to_owned(),
        })
        .collect();
    let promoted = StagingBuffer::new().prepare_promotion(
        revision_id,
        StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 600_000),
            words,
        },
    );
    assert!(promoted.word_records.iter().all(|word| {
        word.alignment_status == "unaligned"
            && word.provenance == "interpolated"
            && word.metadata_json == r#"{"timing":"utterance_interpolated"}"#
    }));
    database
        .transcript_promote_window(revision_id, &promoted.turn_records, &promoted.word_records)
        .unwrap();
    assert_eq!(
        database
            .transcript_get_revision(revision_id)
            .unwrap()
            .unwrap()
            .word_count,
        3_500
    );
}
