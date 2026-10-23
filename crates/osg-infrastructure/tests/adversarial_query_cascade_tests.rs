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

//! Adversarial transcript range-query edges, cue-mapping uniqueness, and cascading deletes at every
//! entity level.

mod common;

use osg_domain::{CueId, ProjectMetadata, TrackId, TurnId, WordId};
use osg_infrastructure::storage::Database;
use osg_infrastructure::storage::transcripts::{
    CueWordMappingRecord, TranscriptTurnRecord, TranscriptWordRecord,
};
use rusqlite::{Connection, params};
use tempfile::tempdir;
use uuid::Uuid;

use common::create_sample_revision;

#[test]
fn test_range_query_edge_cases_and_intervals() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("intervals.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Intervals Test").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let rev = create_sample_revision(meta.id(), 0, 20000);
    db.transcript_insert_revision(&rev).unwrap();

    let w1_id = WordId::new();
    let w2_id = WordId::new();
    let w3_zero_id = WordId::new();

    let words = vec![
        // Word 1: [1000, 2000]
        TranscriptWordRecord {
            id: w1_id,
            revision_id: rev.id,
            turn_id: None,
            ordinal: 0,
            text: "first".to_string(),
            raw_start_ns: 1_000_000_000,
            raw_end_ns: 2_000_000_000,
            start_ms: 1000,
            end_ms: 2000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        // Word 2: [2000, 3000] (adjacent to Word 1)
        TranscriptWordRecord {
            id: w2_id,
            revision_id: rev.id,
            turn_id: None,
            ordinal: 1,
            text: "second".to_string(),
            raw_start_ns: 2_000_000_000,
            raw_end_ns: 3_000_000_000,
            start_ms: 2000,
            end_ms: 3000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        // Word 3: [5000, 5000] (zero-duration word)
        TranscriptWordRecord {
            id: w3_zero_id,
            revision_id: rev.id,
            turn_id: None,
            ordinal: 2,
            text: "zero".to_string(),
            raw_start_ns: 5_000_000_000,
            raw_end_ns: 5_000_000_000,
            start_ms: 5000,
            end_ms: 5000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
    ];

    db.transcript_promote_window(rev.id, &[], &words).unwrap();

    // 1. Degenerate range [1500, 1500):
    // NOTE: In osg-domain (line 714 of transcripts.rs), `start_ms >= end_ms` returns empty `&[]`.
    // In osg-infrastructure (transcripts.rs line 422), SQL evaluates `start_ms < 1500 AND end_ms > 1500`.
    // Thus it returns words strictly enclosing 1500ms (w1: 1000..2000), deviating from half-open [a, b) interval definition!
    let degen = db
        .transcript_query_words_in_range(rev.id, 1500, 1500)
        .unwrap();
    assert_eq!(
        degen.len(),
        1,
        "Empirical finding: query_words_in_range without start_ms < end_ms guard returns enclosing words on [T, T)"
    );
    assert_eq!(degen[0].id, w1_id);

    // Inverted range [2500, 500):
    // SQL evaluates `start_ms < 500 AND end_ms > 2500`. Since w1 is [1000, 2000], it does not match (start_ms is not < 500).
    let inverted = db
        .transcript_query_words_in_range(rev.id, 2500, 500)
        .unwrap();
    assert_eq!(inverted.len(), 0);

    // 2. Query [500, 1000): ends at 1000. start_ms < 1000 is FALSE for w1 (1000). 0 words.
    let before = db
        .transcript_query_words_in_range(rev.id, 500, 1000)
        .unwrap();
    assert_eq!(before.len(), 0);

    // 3. Query [1000, 2000): matches w1 only! (w2 starts at 2000, not < 2000)
    let q_w1 = db
        .transcript_query_words_in_range(rev.id, 1000, 2000)
        .unwrap();
    assert_eq!(q_w1.len(), 1);
    assert_eq!(q_w1[0].id, w1_id);

    // 4. Query [2000, 3000): matches w2 only! (w1 ends at 2000, not > 2000)
    let q_w2 = db
        .transcript_query_words_in_range(rev.id, 2000, 3000)
        .unwrap();
    assert_eq!(q_w2.len(), 1);
    assert_eq!(q_w2[0].id, w2_id);

    // 5. Query [1500, 2500): intersects both w1 and w2!
    let q_both = db
        .transcript_query_words_in_range(rev.id, 1500, 2500)
        .unwrap();
    assert_eq!(q_both.len(), 2);

    // 6. Active word seeking:
    // NOTE: osg-domain uses half-open interval [start_ms, end_ms) where at t = 2000, Word 2 is active.
    // In osg-infrastructure, SQL uses closed interval [start_ms, end_ms] with ORDER BY start_ms ASC LIMIT 1.
    // Thus at t = 2000, Word 1 (1000..2000) is returned instead of Word 2 (2000..3000).
    assert!(
        db.transcript_query_active_word(rev.id, 999)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        db.transcript_query_active_word(rev.id, 1000)
            .unwrap()
            .unwrap()
            .id,
        w1_id
    );
    assert_eq!(
        db.transcript_query_active_word(rev.id, 1500)
            .unwrap()
            .unwrap()
            .id,
        w1_id
    );
    assert_eq!(
        db.transcript_query_active_word(rev.id, 2000)
            .unwrap()
            .unwrap()
            .id,
        w1_id,
        "SQL returns w1 at t=2000 due to start_ms <= 2000 AND end_ms >= 2000 with start_ms ASC"
    );
    assert_eq!(
        db.transcript_query_active_word(rev.id, 2001)
            .unwrap()
            .unwrap()
            .id,
        w2_id
    );
    assert_eq!(
        db.transcript_query_active_word(rev.id, 3000)
            .unwrap()
            .unwrap()
            .id,
        w2_id
    );
    assert!(
        db.transcript_query_active_word(rev.id, 3001)
            .unwrap()
            .is_none()
    );

    // 7. Zero-duration word at 5000:
    assert_eq!(
        db.transcript_query_active_word(rev.id, 5000)
            .unwrap()
            .unwrap()
            .id,
        w3_zero_id
    );
}

#[test]
fn test_save_cue_mappings_duplicate_fails_unique_constraint() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("cue_map_dup.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Cue Map Dup").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let rev = create_sample_revision(meta.id(), 0, 10000);
    db.transcript_insert_revision(&rev).unwrap();

    let w_id = WordId::new();
    let word = TranscriptWordRecord {
        id: w_id,
        revision_id: rev.id,
        turn_id: None,
        ordinal: 0,
        text: "test".to_string(),
        raw_start_ns: 0,
        raw_end_ns: 500_000_000,
        start_ms: 0,
        end_ms: 500,
        speaker_id: None,
        confidence: None,
        is_unaligned: false,
        alignment_status: "aligned".to_string(),
        provenance: "provider".to_string(),
        metadata_json: "{}".to_string(),
    };
    db.transcript_promote_window(rev.id, &[], &[word]).unwrap();

    let cue_id = CueId::new();
    let track_id = TrackId::new();
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO tracks(id, project_id, ordinal, role, label, origin, state_version, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 0, 'user', 'Subtitles', 'srt', 0, 1000, 1000)",
            params![track_id.as_uuid(), meta.id().as_uuid()],
        ).unwrap();
        conn.execute(
            "INSERT INTO cues(track_id, id, ordinal, start_ms, end_ms, text)
             VALUES (?1, ?2, 1, 0, 500, 'test')",
            params![track_id.as_uuid(), cue_id.as_uuid()],
        )
        .unwrap();
    }

    let mapping = CueWordMappingRecord {
        cue_id,
        word_id: w_id,
        word_ordinal: 0,
        metadata_json: "{}".to_string(),
    };

    // First save succeeds
    db.transcript_save_cue_mappings(&[mapping.clone()])
        .expect("first save");

    // Second save of the exact same mapping fails because of PRIMARY KEY / UNIQUE constraint without UPSERT
    let second_res = db.transcript_save_cue_mappings(&[mapping]);
    assert!(
        second_res.is_err(),
        "Empirical finding: save_cue_word_mappings does not use UPSERT / REPLACE and fails on re-saving mappings"
    );
}

// =========================================================================================
// SECTION 3: Cascade Deletes Across All Entity Levels
// =========================================================================================

#[test]
fn test_cascade_delete_project_purges_all_transcript_entities() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("cascade_project.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Cascade Project").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let project_id = meta.id();

    let rev = create_sample_revision(project_id, 0, 10000);
    db.transcript_insert_revision(&rev).unwrap();

    let turn_id = TurnId::new();
    let turn = TranscriptTurnRecord {
        id: turn_id,
        revision_id: rev.id,
        ordinal: 0,
        speaker_id: "Speaker".to_string(),
        start_ms: 0,
        end_ms: 2000,
        text: "hello world".to_string(),
        start_word_ordinal: 0,
        end_word_ordinal: 1,
        metadata_json: "{}".to_string(),
    };

    let word1_id = WordId::new();
    let word2_id = WordId::new();
    let words = vec![
        TranscriptWordRecord {
            id: word1_id,
            revision_id: rev.id,
            turn_id: Some(turn_id),
            ordinal: 0,
            text: "hello".to_string(),
            raw_start_ns: 0,
            raw_end_ns: 1_000_000_000,
            start_ms: 0,
            end_ms: 1000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: word2_id,
            revision_id: rev.id,
            turn_id: Some(turn_id),
            ordinal: 1,
            text: "world".to_string(),
            raw_start_ns: 1_000_000_000,
            raw_end_ns: 2_000_000_000,
            start_ms: 1000,
            end_ms: 2000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
    ];

    db.transcript_promote_window(rev.id, &[turn], &words)
        .unwrap();

    // Map cues to words
    let cue_id = CueId::new();
    let track_id = TrackId::new();
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO tracks(id, project_id, ordinal, role, label, origin, state_version, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 0, 'user', 'Subtitles', 'srt', 0, 1000, 1000)",
            params![track_id.as_uuid(), project_id.as_uuid()],
        ).unwrap();
        conn.execute(
            "INSERT INTO cues(track_id, id, ordinal, start_ms, end_ms, text)
             VALUES (?1, ?2, 1, 0, 2000, 'hello world')",
            params![track_id.as_uuid(), cue_id.as_uuid()],
        )
        .unwrap();
    }

    let mappings = vec![
        CueWordMappingRecord {
            cue_id,
            word_id: word1_id,
            word_ordinal: 0,
            metadata_json: "{}".to_string(),
        },
        CueWordMappingRecord {
            cue_id,
            word_id: word2_id,
            word_ordinal: 1,
            metadata_json: "{}".to_string(),
        },
    ];
    db.transcript_save_cue_mappings(&mappings).unwrap();
    drop(db);

    // Open raw connection with foreign_keys ON and delete project
    let conn = Connection::open(&db_path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute("DELETE FROM projects WHERE id = ?1", [project_id.as_uuid()])
        .unwrap();

    // Assert ALL child records across all 4 v15 tables were purged
    for table in [
        "transcript_revisions",
        "transcript_turns",
        "transcript_words",
        "cue_word_mappings",
    ] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "Table {table} must have 0 rows after project cascade delete"
        );
    }

    // Verify foreign key integrity
    let fk_violations: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check()", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fk_violations, 0, "No foreign key violations allowed");
}

#[test]
fn test_cascade_delete_granular_entities() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("cascade_granular.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Granular Cascade").unwrap();
    let _ = db.create_project(&meta).unwrap();
    let project_id = meta.id();

    let rev = create_sample_revision(project_id, 0, 10000);
    db.transcript_insert_revision(&rev).unwrap();

    let turn_id = TurnId::new();
    let turn = TranscriptTurnRecord {
        id: turn_id,
        revision_id: rev.id,
        ordinal: 0,
        speaker_id: "Speaker".to_string(),
        start_ms: 0,
        end_ms: 2000,
        text: "test".to_string(),
        start_word_ordinal: 0,
        end_word_ordinal: 0,
        metadata_json: "{}".to_string(),
    };

    let word_id = WordId::new();
    let words = vec![TranscriptWordRecord {
        id: word_id,
        revision_id: rev.id,
        turn_id: Some(turn_id),
        ordinal: 0,
        text: "test".to_string(),
        raw_start_ns: 0,
        raw_end_ns: 1_000_000_000,
        start_ms: 0,
        end_ms: 1000,
        speaker_id: None,
        confidence: None,
        is_unaligned: false,
        alignment_status: "aligned".to_string(),
        provenance: "provider".to_string(),
        metadata_json: "{}".to_string(),
    }];

    db.transcript_promote_window(rev.id, &[turn], &words)
        .unwrap();
    drop(db);

    let conn = Connection::open(&db_path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    // 1. Deleting turn sets turn_id = NULL on words (ON DELETE SET NULL)
    conn.execute(
        "DELETE FROM transcript_turns WHERE id = ?1",
        [turn_id.as_uuid()],
    )
    .unwrap();
    let turn_id_on_word: Option<Uuid> = conn
        .query_row(
            "SELECT turn_id FROM transcript_words WHERE id = ?1",
            [word_id.as_uuid()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(turn_id_on_word.is_none(), "turn_id must be set to NULL");

    let word_still_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM transcript_words WHERE id = ?1)",
            [word_id.as_uuid()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        word_still_exists,
        "Word must NOT be deleted when turn is deleted"
    );

    // 2. Deleting revision cascades to delete words
    conn.execute(
        "DELETE FROM transcript_revisions WHERE id = ?1",
        [rev.id.as_uuid()],
    )
    .unwrap();
    let words_left: i64 = conn
        .query_row("SELECT count(*) FROM transcript_words", [], |r| r.get(0))
        .unwrap();
    assert_eq!(words_left, 0, "Deleting revision must cascade delete words");
}
