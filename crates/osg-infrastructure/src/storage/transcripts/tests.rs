use osg_domain::{
    CueId, ProjectId, ProjectMetadata, TrackId, TranscriptRevisionId, TurnId, WordId,
};
use rusqlite::{Connection, params};
use tempfile::tempdir;

use super::*;
use crate::storage::DatabaseError;
use crate::storage::actor::Database;
use crate::storage::migrations::migrations;

fn setup_test_db() -> (Connection, ProjectId) {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrations().to_latest(&mut conn).unwrap();

    let project_id = ProjectId::new();
    conn.execute(
        "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
             VALUES (?1, 'Transcript Test Project', 0, 1000, 1000)",
        [project_id.as_uuid()],
    )
    .unwrap();

    (conn, project_id)
}

#[test]
fn test_transcript_revision_insert_get_and_list() {
    let (mut conn, project_id) = setup_test_db();
    let rev1 = TranscriptRevisionRecord {
        id: TranscriptRevisionId::new(),
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 60000,
        state: "completed".to_string(),
        fingerprint: "fp1".to_string(),
        word_count: 10,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    };

    let tx = conn.transaction().expect("start tx1");
    insert_transcript_revision(&tx, &rev1).expect("insert rev1");
    tx.commit().expect("commit tx1");

    let fetched = get_transcript_revision(&conn, rev1.id)
        .expect("get rev1")
        .expect("rev1 exists");
    assert_eq!(fetched.id, rev1.id);
    assert_eq!(fetched.project_id, project_id);
    assert_eq!(fetched.provider, "gemini");
    assert_eq!(fetched.model, "gemini-3.5-transcribe");
    assert_eq!(fetched.word_count, 10);
    assert_eq!(fetched.state, "completed");

    let rev2 = TranscriptRevisionRecord {
        id: TranscriptRevisionId::new(),
        project_id,
        media_id: None,
        provider: "whisper".to_string(),
        model: "large-v3".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 60000,
        state: "completed".to_string(),
        fingerprint: "fp2".to_string(),
        word_count: 12,
        metadata_json: "{}".to_string(),
        created_at_ms: 2000,
        updated_at_ms: 2000,
    };
    let tx = conn.transaction().expect("start tx2");
    insert_transcript_revision(&tx, &rev2).expect("insert rev2");
    tx.commit().expect("commit tx2");

    let list = list_transcript_revisions_for_project(&conn, project_id).expect("list");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, rev1.id);
    assert_eq!(list[1].id, rev2.id);
}

#[test]
fn test_promote_window_and_spatial_queries() {
    let (mut conn, project_id) = setup_test_db();
    let rev_id = TranscriptRevisionId::new();
    let rev = TranscriptRevisionRecord {
        id: rev_id,
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 10000,
        state: "completed".to_string(),
        fingerprint: "fp".to_string(),
        word_count: 4,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    };
    let tx = conn.transaction().unwrap();
    insert_transcript_revision(&tx, &rev).unwrap();
    tx.commit().unwrap();

    let turn1_id = TurnId::new();
    let turn2_id = TurnId::new();
    let turns = vec![
        TranscriptTurnRecord {
            id: turn1_id,
            revision_id: rev_id,
            ordinal: 0,
            speaker_id: "Speaker 1".to_string(),
            start_ms: 0,
            end_ms: 3000,
            text: "Hello world".to_string(),
            start_word_ordinal: 0,
            end_word_ordinal: 1,
            metadata_json: "{}".to_string(),
        },
        TranscriptTurnRecord {
            id: turn2_id,
            revision_id: rev_id,
            ordinal: 1,
            speaker_id: "Speaker 2".to_string(),
            start_ms: 4000,
            end_ms: 8000,
            text: "Rust rocks".to_string(),
            start_word_ordinal: 2,
            end_word_ordinal: 3,
            metadata_json: "{}".to_string(),
        },
    ];

    let w1_id = WordId::new();
    let w2_id = WordId::new();
    let w3_id = WordId::new();
    let w4_id = WordId::new();
    let words = vec![
        TranscriptWordRecord {
            id: w1_id,
            revision_id: rev_id,
            turn_id: Some(turn1_id),
            ordinal: 0,
            text: "Hello".to_string(),
            raw_start_ns: 0,
            raw_end_ns: 500_000_000,
            start_ms: 0,
            end_ms: 500,
            speaker_id: Some("Speaker 1".to_string()),
            confidence: Some(0.99),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w2_id,
            revision_id: rev_id,
            turn_id: Some(turn1_id),
            ordinal: 1,
            text: "world".to_string(),
            raw_start_ns: 600_000_000,
            raw_end_ns: 1_200_000_000,
            start_ms: 600,
            end_ms: 1200,
            speaker_id: Some("Speaker 1".to_string()),
            confidence: Some(0.95),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w3_id,
            revision_id: rev_id,
            turn_id: Some(turn2_id),
            ordinal: 2,
            text: "Rust".to_string(),
            raw_start_ns: 4_000_000_000,
            raw_end_ns: 5_000_000_000,
            start_ms: 4000,
            end_ms: 5000,
            speaker_id: Some("Speaker 2".to_string()),
            confidence: Some(0.98),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w4_id,
            revision_id: rev_id,
            turn_id: Some(turn2_id),
            ordinal: 3,
            text: "rocks".to_string(),
            raw_start_ns: 5_200_000_000,
            raw_end_ns: 6_000_000_000,
            start_ms: 5200,
            end_ms: 6000,
            speaker_id: Some("Speaker 2".to_string()),
            confidence: Some(0.97),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
    ];

    let tx = conn.transaction().unwrap();
    promote_window_results(&tx, rev_id, &turns, &words).unwrap();
    tx.commit().unwrap();

    // 1. Query active word at various timestamps
    let active_at_300 = query_active_word(&conn, rev_id, 300).unwrap().unwrap();
    assert_eq!(active_at_300.id, w1_id);
    assert_eq!(active_at_300.text, "Hello");

    let active_at_800 = query_active_word(&conn, rev_id, 800).unwrap().unwrap();
    assert_eq!(active_at_800.id, w2_id);
    assert_eq!(active_at_800.text, "world");

    let active_at_2000 = query_active_word(&conn, rev_id, 2000).unwrap();
    assert!(active_at_2000.is_none());

    let active_at_4500 = query_active_word(&conn, rev_id, 4500).unwrap().unwrap();
    assert_eq!(active_at_4500.id, w3_id);

    // 2. Query words in range [500, 5100) -> should match w2 ("world") and w3 ("Rust")
    let in_range = query_words_in_range(&conn, rev_id, 500, 5100).unwrap();
    assert_eq!(in_range.len(), 2);
    assert_eq!(in_range[0].id, w2_id);
    assert_eq!(in_range[1].id, w3_id);

    // 3. Query turns in range [2000, 5000) -> should match turn1 (0..3000) and turn2 (4000..8000)
    let turns_in_range = query_turns_in_range(&conn, rev_id, 2000, 5000).unwrap();
    assert_eq!(turns_in_range.len(), 2);
    assert_eq!(turns_in_range[0].id, turn1_id);
    assert_eq!(turns_in_range[1].id, turn2_id);
}

#[test]
fn test_cue_word_mappings_and_cascading_deletes() {
    let (mut conn, project_id) = setup_test_db();

    // Seed track & cues
    let track_id = TrackId::new();
    conn.execute(
        "INSERT INTO tracks(id, project_id, ordinal, role, label, origin, state_version, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 0, 'user', 'Subtitles', 'srt', 0, 1000, 1000)",
        params![track_id.as_uuid(), project_id.as_uuid()],
    ).unwrap();

    let cue1_id = CueId::new();
    let cue2_id = CueId::new();
    conn.execute(
        "INSERT INTO cues(track_id, id, ordinal, start_ms, end_ms, text)
             VALUES (?1, ?2, 1, 0, 2000, 'Hello world'),
                    (?1, ?3, 2, 4000, 6000, 'Rust rocks')",
        params![track_id.as_uuid(), cue1_id.as_uuid(), cue2_id.as_uuid()],
    )
    .unwrap();

    // Seed revision and words
    let rev_id = TranscriptRevisionId::new();
    let rev = TranscriptRevisionRecord {
        id: rev_id,
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 10000,
        state: "completed".to_string(),
        fingerprint: "fp".to_string(),
        word_count: 4,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    };
    let tx = conn.transaction().unwrap();
    insert_transcript_revision(&tx, &rev).unwrap();
    tx.commit().unwrap();

    let w1_id = WordId::new();
    let w2_id = WordId::new();
    let w3_id = WordId::new();
    let w4_id = WordId::new();
    let words = vec![
        TranscriptWordRecord {
            id: w1_id,
            revision_id: rev_id,
            turn_id: None,
            ordinal: 0,
            text: "Hello".to_string(),
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
        },
        TranscriptWordRecord {
            id: w2_id,
            revision_id: rev_id,
            turn_id: None,
            ordinal: 1,
            text: "world".to_string(),
            raw_start_ns: 600_000_000,
            raw_end_ns: 1_200_000_000,
            start_ms: 600,
            end_ms: 1200,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w3_id,
            revision_id: rev_id,
            turn_id: None,
            ordinal: 2,
            text: "Rust".to_string(),
            raw_start_ns: 4_000_000_000,
            raw_end_ns: 5_000_000_000,
            start_ms: 4000,
            end_ms: 5000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w4_id,
            revision_id: rev_id,
            turn_id: None,
            ordinal: 3,
            text: "rocks".to_string(),
            raw_start_ns: 5_200_000_000,
            raw_end_ns: 6_000_000_000,
            start_ms: 5200,
            end_ms: 6000,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
    ];

    let mappings = vec![
        CueWordMappingRecord {
            cue_id: cue1_id,
            word_id: w1_id,
            word_ordinal: 0,
            metadata_json: "{}".to_string(),
        },
        CueWordMappingRecord {
            cue_id: cue1_id,
            word_id: w2_id,
            word_ordinal: 1,
            metadata_json: "{}".to_string(),
        },
        CueWordMappingRecord {
            cue_id: cue2_id,
            word_id: w3_id,
            word_ordinal: 2,
            metadata_json: "{}".to_string(),
        },
        CueWordMappingRecord {
            cue_id: cue2_id,
            word_id: w4_id,
            word_ordinal: 3,
            metadata_json: "{}".to_string(),
        },
    ];

    let tx = conn.transaction().unwrap();
    promote_window_results(&tx, rev_id, &[], &words).unwrap();
    save_cue_word_mappings(&tx, &mappings).unwrap();
    tx.commit().unwrap();

    let loaded = load_cue_word_mappings_for_project(&conn, project_id).unwrap();
    assert_eq!(loaded.len(), 4);
    assert_eq!(loaded[0].cue_id, cue1_id);
    assert_eq!(loaded[0].word_id, w1_id);
    assert_eq!(loaded[1].cue_id, cue1_id);
    assert_eq!(loaded[1].word_id, w2_id);
    assert_eq!(loaded[2].cue_id, cue2_id);
    assert_eq!(loaded[2].word_id, w3_id);
    assert_eq!(loaded[3].cue_id, cue2_id);
    assert_eq!(loaded[3].word_id, w4_id);

    // Test FK cascade: deleting cue1 removes mappings for cue1
    conn.execute("DELETE FROM cues WHERE id = ?1", [cue1_id.as_uuid()])
        .unwrap();
    let loaded_after_cue_delete = load_cue_word_mappings_for_project(&conn, project_id).unwrap();
    assert_eq!(loaded_after_cue_delete.len(), 2);
    assert_eq!(loaded_after_cue_delete[0].cue_id, cue2_id);

    // Test FK cascade: deleting project cascades and removes everything
    conn.execute("DELETE FROM projects WHERE id = ?1", [project_id.as_uuid()])
        .unwrap();
    let rev_count: i64 = conn
        .query_row("SELECT count(*) FROM transcript_revisions", [], |r| {
            r.get(0)
        })
        .unwrap();
    let word_count: i64 = conn
        .query_row("SELECT count(*) FROM transcript_words", [], |r| r.get(0))
        .unwrap();
    let mapping_count: i64 = conn
        .query_row("SELECT count(*) FROM cue_word_mappings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rev_count, 0);
    assert_eq!(word_count, 0);
    assert_eq!(mapping_count, 0);
}

#[test]
fn test_actor_database_transcript_pipeline() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("actor_test.db");
    let db = Database::open(&db_path).unwrap();

    // Let's create a project via actor
    let project_meta = ProjectMetadata::new("Actor Transcript Test").unwrap();
    let _snapshot = db.create_project(&project_meta).unwrap();
    let project_id = project_meta.id();

    let rev_id = TranscriptRevisionId::new();
    let rev = TranscriptRevisionRecord {
        id: rev_id,
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 5000,
        state: "completed".to_string(),
        fingerprint: "actor_fp".to_string(),
        word_count: 2,
        metadata_json: "{}".to_string(),
        created_at_ms: 100,
        updated_at_ms: 100,
    };

    db.transcript_insert_revision(&rev).unwrap();

    let fetched = db.transcript_get_revision(rev_id).unwrap().unwrap();
    assert_eq!(fetched.id, rev_id);

    let list = db.transcript_list_revisions(project_id).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, rev_id);

    let w1_id = WordId::new();
    let w2_id = WordId::new();
    let words = vec![
        TranscriptWordRecord {
            id: w1_id,
            revision_id: rev_id,
            turn_id: None,
            ordinal: 0,
            text: "First".to_string(),
            raw_start_ns: 0,
            raw_end_ns: 400_000_000,
            start_ms: 0,
            end_ms: 400,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w2_id,
            revision_id: rev_id,
            turn_id: None,
            ordinal: 1,
            text: "Second".to_string(),
            raw_start_ns: 500_000_000,
            raw_end_ns: 900_000_000,
            start_ms: 500,
            end_ms: 900,
            speaker_id: None,
            confidence: None,
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
    ];

    db.transcript_promote_window(rev_id, &[], &words).unwrap();

    let active = db
        .transcript_query_active_word(rev_id, 200)
        .unwrap()
        .unwrap();
    assert_eq!(active.id, w1_id);
    assert_eq!(active.text, "First");

    let in_range = db
        .transcript_query_words_in_range(rev_id, 300, 600)
        .unwrap();
    assert_eq!(in_range.len(), 2);
}

#[test]
fn test_update_transcript_revision_state() {
    let (mut conn, project_id) = setup_test_db();
    let rev_id = TranscriptRevisionId::new();
    let rev = TranscriptRevisionRecord {
        id: rev_id,
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 60000,
        state: "in_progress".to_string(),
        fingerprint: "fp_test".to_string(),
        word_count: 0,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    };
    let tx = conn.transaction().unwrap();
    insert_transcript_revision(&tx, &rev).unwrap();
    tx.commit().unwrap();

    // 1. Update to completed
    update_transcript_revision_state(&conn, rev_id, "completed").unwrap();
    let fetched = get_transcript_revision(&conn, rev_id).unwrap().unwrap();
    assert_eq!(fetched.state, "completed");
    assert!(fetched.updated_at_ms >= 1000);

    // 2. Update to partial
    update_transcript_revision_state(&conn, rev_id, "partial").unwrap();
    let fetched = get_transcript_revision(&conn, rev_id).unwrap().unwrap();
    assert_eq!(fetched.state, "partial");

    // 3. Update to failed
    update_transcript_revision_state(&conn, rev_id, "failed").unwrap();
    let fetched = get_transcript_revision(&conn, rev_id).unwrap().unwrap();
    assert_eq!(fetched.state, "failed");

    // 4. Invalid state fails
    let invalid_err = update_transcript_revision_state(&conn, rev_id, "bogus_state").unwrap_err();
    assert!(matches!(invalid_err, DatabaseError::Integrity(_)));

    // 5. Nonexistent revision fails with TranscriptRevisionNotFound
    let missing_id = TranscriptRevisionId::new();
    let not_found_err =
        update_transcript_revision_state(&conn, missing_id, "completed").unwrap_err();
    assert!(matches!(
        not_found_err,
        DatabaseError::TranscriptRevisionNotFound(id) if id == missing_id
    ));
}
