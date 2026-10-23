#![allow(
    clippy::all,
    clippy::pedantic,
    clippy::restriction,
    clippy::nursery,
    clippy::cast_lossless,
    clippy::cast_possible_truncation,
    clippy::too_many_lines,
    clippy::unnecessary_wraps,
    clippy::shadow_unrelated
)]

//! Adversarial transcript-window promotion checks: atomic rollback on any invalid word or turn,
//! sequential windows with targeted retry, and concurrent promotions against range queries.

mod common;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use osg_domain::{ProjectMetadata, TranscriptRevisionId, TurnId, WordId};
use osg_infrastructure::storage::Database;
use osg_infrastructure::storage::transcripts::{TranscriptTurnRecord, TranscriptWordRecord};
use tempfile::tempdir;

use common::create_sample_revision;

// =========================================================================================
// SECTION 2: Stress-Testing Transactional Integrity
// =========================================================================================

#[test]
fn test_promote_window_atomic_rollback_on_invalid_word() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("promote_rollback.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Promote Rollback Test").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let project_id = meta.id();

    let rev = create_sample_revision(project_id, 0, 10000);
    db.transcript_insert_revision(&rev).unwrap();

    let turn_id = TurnId::new();
    let valid_turn = TranscriptTurnRecord {
        id: turn_id,
        revision_id: rev.id,
        ordinal: 0,
        speaker_id: "Speaker A".to_string(),
        start_ms: 0,
        end_ms: 3000,
        text: "Five words test".to_string(),
        start_word_ordinal: 0,
        end_word_ordinal: 4,
        metadata_json: "{}".to_string(),
    };

    let make_valid_word = |ord: u32, text: &str, start_ms: i64, end_ms: i64| TranscriptWordRecord {
        id: WordId::new(),
        revision_id: rev.id,
        turn_id: Some(turn_id),
        ordinal: ord,
        text: text.to_string(),
        raw_start_ns: (start_ms * 1_000_000) as u64,
        raw_end_ns: (end_ms * 1_000_000) as u64,
        start_ms,
        end_ms,
        speaker_id: Some("Speaker A".to_string()),
        confidence: Some(0.95),
        is_unaligned: false,
        alignment_status: "aligned".to_string(),
        provenance: "provider".to_string(),
        metadata_json: "{}".to_string(),
    };

    // 11 distinct hostile / invalid word injections
    let invalid_word_cases: Vec<(&str, TranscriptWordRecord)> = vec![
        (
            "negative start_ms",
            TranscriptWordRecord {
                start_ms: -100,
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "end_ms < start_ms",
            TranscriptWordRecord {
                start_ms: 500,
                end_ms: 400,
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "raw_end_ns < raw_start_ns",
            TranscriptWordRecord {
                raw_start_ns: 500_000_000,
                raw_end_ns: 100_000_000,
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "empty text",
            TranscriptWordRecord {
                text: "".to_string(),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "oversized text > 1024 chars",
            TranscriptWordRecord {
                text: "a".repeat(1025),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "confidence > 1.0",
            TranscriptWordRecord {
                confidence: Some(1.05),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "confidence < 0.0",
            TranscriptWordRecord {
                confidence: Some(-0.05),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "invalid alignment_status",
            TranscriptWordRecord {
                alignment_status: "bogus_status".to_string(),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "invalid provenance",
            TranscriptWordRecord {
                provenance: "telepathic".to_string(),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "non-existent turn_id",
            TranscriptWordRecord {
                turn_id: Some(TurnId::new()),
                ..make_valid_word(0, "bad", 0, 100)
            },
        ),
        (
            "duplicate ordinal within batch",
            make_valid_word(0, "duplicate", 0, 100), // will be placed alongside another ordinal 0
        ),
    ];

    for (name, invalid_word) in invalid_word_cases {
        let mut words = vec![
            make_valid_word(0, "one", 0, 100),
            make_valid_word(1, "two", 100, 200),
            make_valid_word(2, "three", 200, 300),
        ];
        if name == "duplicate ordinal within batch" {
            words.push(invalid_word);
        } else {
            // Replace word 2 with invalid word
            words[2] = invalid_word;
        }

        let result = db.transcript_promote_window(rev.id, &[valid_turn.clone()], &words);
        assert!(
            result.is_err(),
            "Expected promote_window to fail for case '{name}'"
        );

        // ATOMICITY ASSERTION: Word count on revision must strictly remain 0
        let fetched_rev = db
            .transcript_get_revision(rev.id)
            .unwrap()
            .expect("revision exists");
        assert_eq!(
            fetched_rev.word_count, 0,
            "Revision word count was mutated on failure for case '{name}'!"
        );

        // ATOMICITY ASSERTION: Zero words and zero turns must exist in database for this revision
        let in_range = db
            .transcript_query_words_in_range(rev.id, 0, 10000)
            .unwrap();
        assert_eq!(
            in_range.len(),
            0,
            "Partial words remained after failed transaction in case '{name}'!"
        );

        let turns_in_range = db
            .transcript_query_turns_in_range(rev.id, 0, 10000)
            .unwrap();
        assert_eq!(
            turns_in_range.len(),
            0,
            "Partial turns remained after failed transaction in case '{name}'!"
        );
    }

    // Now promote a completely clean batch to prove database was not poisoned
    let clean_words = vec![
        make_valid_word(0, "clean", 0, 100),
        make_valid_word(1, "words", 100, 200),
    ];
    db.transcript_promote_window(rev.id, &[valid_turn], &clean_words)
        .expect("clean promote must succeed");

    let updated_rev = db
        .transcript_get_revision(rev.id)
        .unwrap()
        .expect("revision exists");
    assert_eq!(updated_rev.word_count, 2);
}

#[test]
fn test_promote_window_atomic_rollback_on_invalid_turn() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("promote_turn_rollback.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Turn Rollback Test").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let rev = create_sample_revision(meta.id(), 0, 10000);
    db.transcript_insert_revision(&rev).unwrap();

    let bad_turn_cases = vec![
        (
            "end_ms < start_ms",
            TranscriptTurnRecord {
                id: TurnId::new(),
                revision_id: rev.id,
                ordinal: 0,
                speaker_id: "Speaker".to_string(),
                start_ms: 500,
                end_ms: 400,
                text: "Text".to_string(),
                start_word_ordinal: 0,
                end_word_ordinal: 1,
                metadata_json: "{}".to_string(),
            },
        ),
        (
            "empty speaker_id",
            TranscriptTurnRecord {
                id: TurnId::new(),
                revision_id: rev.id,
                ordinal: 0,
                speaker_id: "".to_string(),
                start_ms: 0,
                end_ms: 500,
                text: "Text".to_string(),
                start_word_ordinal: 0,
                end_word_ordinal: 1,
                metadata_json: "{}".to_string(),
            },
        ),
    ];

    for (name, bad_turn) in bad_turn_cases {
        let words = vec![TranscriptWordRecord {
            id: WordId::new(),
            revision_id: rev.id,
            turn_id: Some(bad_turn.id),
            ordinal: 0,
            text: "Valid".to_string(),
            raw_start_ns: 0,
            raw_end_ns: 500_000_000,
            start_ms: 0,
            end_ms: 500,
            speaker_id: Some("Speaker".to_string()),
            confidence: Some(0.99),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        }];

        let res = db.transcript_promote_window(rev.id, &[bad_turn], &words);
        assert!(res.is_err(), "Expected turn failure for case '{name}'");

        let rev_check = db.transcript_get_revision(rev.id).unwrap().unwrap();
        assert_eq!(rev_check.word_count, 0);
    }
}

#[test]
fn test_multi_window_sequential_promotion_and_targeted_retry() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("multi_window.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Multi Window Test").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let rev = create_sample_revision(meta.id(), 0, 30000);
    db.transcript_insert_revision(&rev).unwrap();

    // Window 0 (0..10000): 10 words
    let w0_words: Vec<TranscriptWordRecord> = (0..10)
        .map(|i| TranscriptWordRecord {
            id: WordId::new(),
            revision_id: rev.id,
            turn_id: None,
            ordinal: i,
            text: format!("w0_word_{i}"),
            raw_start_ns: (i as u64) * 1_000_000_000,
            raw_end_ns: (i as u64) * 1_000_000_000 + 800_000_000,
            start_ms: (i as i64) * 1000,
            end_ms: (i as i64) * 1000 + 800,
            speaker_id: Some("Speaker 1".to_string()),
            confidence: Some(0.95),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        })
        .collect();

    db.transcript_promote_window(rev.id, &[], &w0_words)
        .expect("promote window 0");
    assert_eq!(
        db.transcript_get_revision(rev.id)
            .unwrap()
            .unwrap()
            .word_count,
        10
    );

    // Window 1 (10000..20000): first attempt FAILS due to bad confidence
    let mut w1_bad_words: Vec<TranscriptWordRecord> = (10..20)
        .map(|i| TranscriptWordRecord {
            id: WordId::new(),
            revision_id: rev.id,
            turn_id: None,
            ordinal: i,
            text: format!("w1_word_{i}"),
            raw_start_ns: (i as u64) * 1_000_000_000,
            raw_end_ns: (i as u64) * 1_000_000_000 + 800_000_000,
            start_ms: (i as i64) * 1000,
            end_ms: (i as i64) * 1000 + 800,
            speaker_id: Some("Speaker 1".to_string()),
            confidence: Some(0.95),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        })
        .collect();
    w1_bad_words[5].confidence = Some(99.0); // Invalid!

    let fail_result = db.transcript_promote_window(rev.id, &[], &w1_bad_words);
    assert!(fail_result.is_err());
    // Word count must still be exactly 10 from Window 0
    assert_eq!(
        db.transcript_get_revision(rev.id)
            .unwrap()
            .unwrap()
            .word_count,
        10
    );

    // Window 1 RETRY with corrected confidence
    w1_bad_words[5].confidence = Some(0.99);
    db.transcript_promote_window(rev.id, &[], &w1_bad_words)
        .expect("retry window 1 must succeed");
    assert_eq!(
        db.transcript_get_revision(rev.id)
            .unwrap()
            .unwrap()
            .word_count,
        20
    );

    // Window 2 (20000..30000): 10 words
    let w2_words: Vec<TranscriptWordRecord> = (20..30)
        .map(|i| TranscriptWordRecord {
            id: WordId::new(),
            revision_id: rev.id,
            turn_id: None,
            ordinal: i,
            text: format!("w2_word_{i}"),
            raw_start_ns: (i as u64) * 1_000_000_000,
            raw_end_ns: (i as u64) * 1_000_000_000 + 800_000_000,
            start_ms: (i as i64) * 1000,
            end_ms: (i as i64) * 1000 + 800,
            speaker_id: Some("Speaker 1".to_string()),
            confidence: Some(0.95),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        })
        .collect();

    db.transcript_promote_window(rev.id, &[], &w2_words)
        .expect("promote window 2");
    assert_eq!(
        db.transcript_get_revision(rev.id)
            .unwrap()
            .unwrap()
            .word_count,
        30
    );

    // Verify all 30 words are returned in strict ordinal order
    let all_words = db
        .transcript_query_words_in_range(rev.id, 0, 35000)
        .unwrap();
    assert_eq!(all_words.len(), 30);
    for (idx, word) in all_words.iter().enumerate() {
        assert_eq!(word.ordinal, idx as u32);
    }
}

#[test]
fn test_concurrent_promotions_and_range_queries_stress() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("stress_concurrency.db");
    let db = Arc::new(Database::open(&db_path).unwrap());

    let meta = ProjectMetadata::new("Concurrency Stress Test").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let project_id = meta.id();

    let rev = create_sample_revision(project_id, 0, 100000);
    db.transcript_insert_revision(&rev).unwrap();
    let rev_id = rev.id;

    let mut handles = Vec::new();

    // 4 Writer Threads: Each promotes non-overlapping ordinal blocks
    for worker_idx in 0..4 {
        let db_clone = Arc::clone(&db);
        let handle = thread::spawn(move || {
            let base_ord = worker_idx * 50;
            let words: Vec<TranscriptWordRecord> = (0..50)
                .map(|i| {
                    let ord = base_ord + i;
                    TranscriptWordRecord {
                        id: WordId::new(),
                        revision_id: rev_id,
                        turn_id: None,
                        ordinal: ord,
                        text: format!("word_{ord}"),
                        raw_start_ns: (ord as u64) * 200_000_000,
                        raw_end_ns: (ord as u64) * 200_000_000 + 150_000_000,
                        start_ms: (ord as i64) * 200,
                        end_ms: (ord as i64) * 200 + 150,
                        speaker_id: Some(format!("spk_{worker_idx}")),
                        confidence: Some(0.99),
                        is_unaligned: false,
                        alignment_status: "aligned".to_string(),
                        provenance: "provider".to_string(),
                        metadata_json: "{}".to_string(),
                    }
                })
                .collect();

            // Promote in 5 batches of 10 words
            for chunk in words.chunks(10) {
                db_clone
                    .transcript_promote_window(rev_id, &[], chunk)
                    .expect("concurrent promote");
                thread::sleep(Duration::from_millis(5));
            }
        });
        handles.push(handle);
    }

    // 4 Reader Threads: Continuously query active words and range queries
    for _ in 0..4 {
        let db_clone = Arc::clone(&db);
        let handle = thread::spawn(move || {
            for t in 0..50 {
                let time_ms = (t % 40) * 200 + 50;
                let _ = db_clone.transcript_query_active_word(rev_id, time_ms);
                let _ = db_clone.transcript_query_words_in_range(rev_id, 0, 5000);
                thread::sleep(Duration::from_millis(2));
            }
        });
        handles.push(handle);
    }

    for h in handles {
        h.join().expect("thread join");
    }

    // After all workers finish: Total words must be exactly 200 (4 * 50)
    let rev_final = db.transcript_get_revision(rev_id).unwrap().unwrap();
    assert_eq!(rev_final.word_count, 200);

    let all_words = db
        .transcript_query_words_in_range(rev_id, 0, 100000)
        .unwrap();
    assert_eq!(all_words.len(), 200);
}

#[test]
fn test_promote_empty_window_on_nonexistent_revision_silently_succeeds() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("empty_nonexistent.db");
    let db = Database::open(&db_path).unwrap();

    let non_existent_rev = TranscriptRevisionId::new();
    // Promoting empty window to non-existent revision succeeds because UPDATE matches 0 rows without failing
    let res = db.transcript_promote_window(non_existent_rev, &[], &[]);
    assert!(
        res.is_ok(),
        "Empirical finding: promote_window with empty batches on non-existent revision succeeds silently"
    );
}
