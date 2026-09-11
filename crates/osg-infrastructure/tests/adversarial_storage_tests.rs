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

//! Adversarial empirical verification tests for osg-infrastructure schema v16.
//!
//! Tests:
//! 1. Idempotent migration from versions 1..=14 to 16 under dirty / aborted state simulations.
//! 2. Stress-testing transactional integrity: promote windows (rollback on any failure, constraint checks),
//!    concurrent range queries / promotions stress harness, and cascading deletes across all entity levels.
//! 3. Backward compatibility: ensuring legacy v1-v14 projects load cleanly without synthetic word timings or errors.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use osg_domain::{
    CaptionProjection, CompletionState, CueId, GroupingPolicy, ManualEditState, ProjectId,
    ProjectMetadata, RevisionReason, ScriptSpacing, SubtitleCue, SubtitleTrack, TimedWord, TrackId,
    TrackOrigin, TranscriptRevision, TranscriptRevisionId, TranscriptTurn, TurnId, WordId,
};
use osg_infrastructure::storage::transcripts::{
    CueWordMappingRecord, TranscriptRevisionRecord, TranscriptTurnRecord, TranscriptWordRecord,
};
use osg_infrastructure::storage::{Database, DatabaseError};
use rusqlite::{Connection, params};
use rusqlite_migration::{M, Migrations};
use tempfile::{NamedTempFile, tempdir};
use uuid::Uuid;

fn test_migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../src/storage/sql/0001_initial.sql")),
        M::up(include_str!(
            "../src/storage/sql/0002_youtube_oauth_token.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0003_job_restore_window.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0004_editor_track_history.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0005_process_media_job.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0006_media_artifact_ownership.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0007_media_artifact_repair.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0008_media_artifact_duplicate_key_repair.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0009_job_result_deliveries.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0010_project_speech_references.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0011_project_render_scenes.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0012_project_create_receipts.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0013_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0014_sparse_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0015_word_native_transcripts.sql"
        )),
        M::up(include_str!(
            "../src/storage/sql/0016_late_legacy_default_subtitle_scale.sql"
        )),
    ])
}

fn seed_legacy_project_in_db(
    connection: &Connection,
    project_id: ProjectId,
    title: &str,
    cues_data: &[(i64, i64, &str)],
) -> (TrackId, Vec<CueId>) {
    let timestamp = 1000_i64;
    connection
        .execute(
            "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 0, ?3, ?3)",
            params![project_id.as_uuid(), title, timestamp],
        )
        .expect("seed project");

    let track_id = TrackId::new();
    connection
        .execute(
            "INSERT INTO tracks(id, project_id, ordinal, role, label, origin, state_version, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 0, 'user', 'Subtitles', 'srt', 0, ?3, ?3)",
            params![track_id.as_uuid(), project_id.as_uuid(), timestamp],
        )
        .expect("seed track");

    let mut cue_ids = Vec::new();
    let mut domain_cues = Vec::new();
    for (idx, &(start_ms, end_ms, text)) in cues_data.iter().enumerate() {
        let cue_id = CueId::new();
        cue_ids.push(cue_id);
        connection
            .execute(
                "INSERT INTO cues(track_id, id, ordinal, start_ms, end_ms, text, metadata_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}')",
                params![
                    track_id.as_uuid(),
                    cue_id.as_uuid(),
                    (idx + 1) as i64,
                    start_ms,
                    end_ms,
                    text
                ],
            )
            .expect("seed cue");

        domain_cues.push(
            SubtitleCue::restore(
                cue_id,
                (idx + 1) as u32,
                start_ms,
                end_ms,
                text.to_string(),
                None,
            )
            .expect("valid cue"),
        );
    }

    let track = SubtitleTrack::restore(track_id, "Subtitles", TrackOrigin::Srt, domain_cues)
        .expect("valid track");

    let metadata = ProjectMetadata::with_id(project_id, title).expect("valid metadata");
    let snapshot =
        osg_application::ProjectSnapshot::new(metadata, 0, Vec::new(), vec![track]).expect("snap");

    let raw = serde_json::to_vec(&snapshot).expect("snap json");
    let hash = *blake3::hash(&raw).as_bytes();
    let compressed = zstd::stream::encode_all(raw.as_slice(), 3).expect("snap zstd");
    let rev_id = Uuid::now_v7();

    connection
        .execute(
            "INSERT INTO project_revisions(
               id, project_id, parent_id, reason, state_version, snapshot_zstd, snapshot_hash,
               cue_count, created_at_ms
             ) VALUES (?1, ?2, NULL, 'Initial creation', 0, ?3, ?4, ?5, ?6)",
            params![
                rev_id,
                project_id.as_uuid(),
                compressed,
                hash.as_slice(),
                cues_data.len() as i64,
                timestamp
            ],
        )
        .expect("seed revision");

    connection
        .execute(
            "INSERT INTO revision_navigation(project_id, current_revision_id, redo_stack_json, updated_at_ms)
             VALUES (?1, ?2, '[]', ?3)",
            params![project_id.as_uuid(), rev_id, timestamp],
        )
        .expect("seed navigation");

    connection
        .execute(
            "INSERT INTO project_state(project_id, active_media_id, active_track_id, current_revision_id, state_version, updated_at_ms)
             VALUES (?1, NULL, ?2, ?3, 0, ?4)",
            params![project_id.as_uuid(), track_id.as_uuid(), rev_id, timestamp],
        )
        .expect("seed state");

    (track_id, cue_ids)
}

fn create_sample_revision(
    project_id: ProjectId,
    start_ms: i64,
    end_ms: i64,
) -> TranscriptRevisionRecord {
    TranscriptRevisionRecord {
        id: TranscriptRevisionId::new(),
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: start_ms,
        source_range_end_ms: end_ms,
        state: "completed".to_string(),
        fingerprint: "test_fingerprint".to_string(),
        word_count: 0,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    }
}

// =========================================================================================
// SECTION 1: Idempotent Migration v1..=14 -> 16 under Dirty / Aborted State Simulations
// =========================================================================================

#[test]
fn test_idempotent_migration_v1_to_v14_repeated_reopens() {
    for prior_version in 1..=14 {
        let db_file = NamedTempFile::new().expect("temp db file");
        let db_path = db_file.path().to_owned();
        let project_id = ProjectId::new();

        // 1. Seed database at prior version with real project and cues
        {
            let mut conn = Connection::open(&db_path).expect("open raw db");
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            test_migrations()
                .to_version(&mut conn, prior_version)
                .expect("migrate to prior version");

            seed_legacy_project_in_db(
                &conn,
                project_id,
                &format!("Legacy v{prior_version} Project"),
                &[(0, 1000, "First cue"), (1200, 2500, "Second cue")],
            );
        }

        // 2. Open with production Database::open, upgrading to schema v16
        {
            let db = Database::open(&db_path).expect("Database::open to v16");
            let health = db.health().expect("health");
            assert_eq!(
                health.schema_version, 16,
                "Schema must be v16 after Database::open for v{prior_version}"
            );

            // Verify project loads seamlessly
            let loaded = db
                .load_project(project_id)
                .expect("load project")
                .expect("project exists");
            assert_eq!(
                loaded.metadata().name(),
                format!("Legacy v{prior_version} Project")
            );
            assert_eq!(loaded.tracks().len(), 1);
            assert_eq!(loaded.tracks()[0].cues().len(), 2);
            assert_eq!(loaded.tracks()[0].cues()[0].text(), "First cue");
            assert_eq!(loaded.tracks()[0].cues()[1].text(), "Second cue");
        }

        // 3. Re-run migrations().to_latest on raw connection multiple times to ensure idempotency
        {
            let mut conn = Connection::open(&db_path).expect("reopen raw db");
            test_migrations().to_latest(&mut conn).expect("repeat 1");
            test_migrations().to_latest(&mut conn).expect("repeat 2");
            test_migrations().to_latest(&mut conn).expect("repeat 3");
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, 16);

            let integrity: String = conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .unwrap();
            assert_eq!(integrity, "ok");

            let fk_violations: Vec<String> = conn
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "table={}, rowid={}",
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?
                    ))
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert!(
                fk_violations.is_empty(),
                "Foreign key violations found: {fk_violations:?}"
            );
        }

        // 4. Reopen with Database::open multiple times
        {
            let db1 = Database::open(&db_path).expect("reopen Database 1");
            drop(db1);
            let db2 = Database::open(&db_path).expect("reopen Database 2");
            let loaded = db2.load_project(project_id).expect("load").expect("exists");
            assert_eq!(loaded.tracks()[0].cues().len(), 2);

            // Verify transcript tables remain zero
            let revs = db2
                .transcript_list_revisions(project_id)
                .expect("list revs");
            assert!(
                revs.is_empty(),
                "legacy project must have 0 transcript revisions"
            );

            let mappings = db2
                .transcript_load_cue_mappings(project_id)
                .expect("load mappings");
            assert!(
                mappings.is_empty(),
                "legacy project must have 0 cue word mappings"
            );
        }
    }
}

#[test]
fn test_migration_aborted_transaction_simulation() {
    let db_file = NamedTempFile::new().expect("temp db file");
    let db_path = db_file.path().to_owned();
    let project_id = ProjectId::new();

    // Setup database at v14
    {
        let mut conn = Connection::open(&db_path).expect("open raw db");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        test_migrations()
            .to_version(&mut conn, 14)
            .expect("migrate to v14");
        seed_legacy_project_in_db(
            &conn,
            project_id,
            "Aborted Migration Project",
            &[(100, 500, "Test cue")],
        );

        // Simulate an aborted / interrupted migration attempt (partial table creation rolled back)
        let tx = conn.transaction().expect("start partial tx");
        tx.execute(
            "CREATE TABLE IF NOT EXISTS transcript_revisions (
               id BLOB PRIMARY KEY NOT NULL
             ) STRICT",
            [],
        )
        .unwrap();
        tx.rollback()
            .expect("simulate crash / rollback before commit");

        // Verify partial table was indeed rolled back
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='transcript_revisions')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!table_exists, "partial table must be rolled back by SQLite");
    }

    // Now open with production Database::open, which must complete migration cleanly
    let db = Database::open(&db_path).expect("Database::open after abort");
    let health = db.health().expect("health");
    assert_eq!(health.schema_version, 16);

    // Verify all 4 tables exist and have expected strict definitions
    let conn = Connection::open(&db_path).expect("inspect");
    for table in [
        "transcript_revisions",
        "transcript_turns",
        "transcript_words",
        "cue_word_mappings",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert!(exists, "table {table} must exist after upgrade");
    }
}

#[test]
fn test_migration_refuses_corrupted_foreign_key_legacy_state() {
    let db_file = NamedTempFile::new().expect("temp db file");
    let db_path = db_file.path().to_owned();

    // Create v14 database with deliberate foreign key violation (inserted with foreign_keys=OFF)
    {
        let mut conn = Connection::open(&db_path).expect("open");
        test_migrations()
            .to_version(&mut conn, 14)
            .expect("migrate to v14");
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();

        let orphaned_cue_id = Uuid::now_v7();
        let missing_track_id = Uuid::now_v7();
        conn.execute(
            "INSERT INTO cues(track_id, id, ordinal, start_ms, end_ms, text)
             VALUES (?1, ?2, 1, 0, 1000, 'Orphaned cue')",
            params![missing_track_id, orphaned_cue_id],
        )
        .unwrap();
    }

    // Attempting to open with Database::open MUST fail with integrity error
    let err = Database::open(&db_path).err().expect("must fail integrity");
    match err {
        DatabaseError::Integrity(msg) => {
            assert!(
                msg.contains("foreign key validation failed"),
                "Expected foreign key failure, got: {msg}"
            );
        }
        other => panic!("Unexpected error variant: {other:?}"),
    }
}

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

// =========================================================================================
// SECTION 4: Backward Compatibility (v1..=14 Without Synthetic Timings)
// =========================================================================================

#[test]
fn test_all_v1_to_v14_projects_load_without_synthetic_words_or_errors() {
    for prior_version in 1..=14 {
        let db_file = NamedTempFile::new().expect("temp db file");
        let db_path = db_file.path().to_owned();
        let project_id = ProjectId::new();

        // Seed legacy project at prior version
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            test_migrations()
                .to_version(&mut conn, prior_version)
                .unwrap();

            seed_legacy_project_in_db(
                &conn,
                project_id,
                &format!("Legacy Project v{prior_version}"),
                &[
                    (0, 1500, "Subtitle line one"),
                    (1600, 3200, "Subtitle line two"),
                    (3500, 5000, "Subtitle line three"),
                ],
            );
        }

        // Open with v15 runtime
        let db = Database::open(&db_path).expect("open legacy project in v15 runtime");
        let loaded = db
            .load_project(project_id)
            .unwrap()
            .expect("project loaded");

        // Verify project tracks and cues are preserved byte-for-byte
        assert_eq!(
            loaded.metadata().name(),
            format!("Legacy Project v{prior_version}")
        );
        assert_eq!(loaded.tracks().len(), 1);
        let cues = loaded.tracks()[0].cues();
        assert_eq!(cues.len(), 3);
        assert_eq!(cues[0].text(), "Subtitle line one");
        assert_eq!(cues[0].start_ms(), 0);
        assert_eq!(cues[0].end_ms(), 1500);

        assert_eq!(cues[1].text(), "Subtitle line two");
        assert_eq!(cues[1].start_ms(), 1600);
        assert_eq!(cues[1].end_ms(), 3200);

        assert_eq!(cues[2].text(), "Subtitle line three");
        assert_eq!(cues[2].start_ms(), 3500);
        assert_eq!(cues[2].end_ms(), 5000);

        // Verify NO synthetic word timings were generated
        let conn = Connection::open(&db_path).unwrap();
        let word_count: i64 = conn
            .query_row("SELECT count(*) FROM transcript_words", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            word_count, 0,
            "Legacy v{prior_version} must have ZERO transcript words (no synthetic words)"
        );

        let turn_count: i64 = conn
            .query_row("SELECT count(*) FROM transcript_turns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            turn_count, 0,
            "Legacy v{prior_version} must have ZERO transcript turns"
        );

        let rev_count: i64 = conn
            .query_row("SELECT count(*) FROM transcript_revisions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            rev_count, 0,
            "Legacy v{prior_version} must have ZERO transcript revisions"
        );

        let map_count: i64 = conn
            .query_row("SELECT count(*) FROM cue_word_mappings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            map_count, 0,
            "Legacy v{prior_version} must have ZERO cue word mappings"
        );

        // Verify Database actor methods return empty
        let revs = db.transcript_list_revisions(project_id).unwrap();
        assert!(revs.is_empty());
        let mappings = db.transcript_load_cue_mappings(project_id).unwrap();
        assert!(mappings.is_empty());
    }
}

// =========================================================================================
// SECTION 5: Remediated Domain Types Integration and Snapshot Integrity
// =========================================================================================

#[test]
fn test_remediated_domain_projection_and_snapshot_commit_roundtrip() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("snap_roundtrip.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Remediated Snapshot Test").unwrap();
    let project_id = meta.id();
    let _ = db.create_project(&meta).unwrap();

    let rev_id = TranscriptRevisionId::new();
    let w0 = TimedWord::new(
        rev_id,
        1,
        "First",
        "0ms",
        "1000ms",
        0,
        1000,
        Some("Speaker A".to_string()),
        None,
    )
    .unwrap();
    let w1 = TimedWord::new(
        rev_id,
        2,
        "overlapping",
        "200ms",
        "400ms",
        200,
        400,
        Some("Speaker A".to_string()),
        None,
    )
    .unwrap();
    let w2 = TimedWord::new(
        rev_id,
        3,
        "zero",
        "600ms",
        "600ms",
        600,
        600,
        Some("Speaker B".to_string()),
        None,
    )
    .unwrap();
    let w3 = TimedWord::new(
        rev_id,
        4,
        "trail",
        "650ms",
        "900ms",
        650,
        900,
        Some("Speaker B".to_string()),
        None,
    )
    .unwrap();

    let t0 = TranscriptTurn::from_words(
        rev_id,
        1,
        Some("Speaker A".to_string()),
        &[w0.clone(), w1.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let t1 = TranscriptTurn::from_words(
        rev_id,
        2,
        Some("Speaker B".to_string()),
        &[w2.clone(), w3.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = TranscriptRevision::new(
        project_id,
        None,
        0,
        2000,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp_snap_test",
        1000,
        vec![w0.clone(), w1.clone(), w2.clone(), w3.clone()],
        vec![t0, t1],
    )
    .unwrap();

    // 1. One-word projection: zero duration clamped to 600 + 100 = 700
    let one_word_proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::OneWord {
            min_duration_ms: 100,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let one_word_track = one_word_proj
        .to_subtitle_track("One Word", TrackOrigin::Srt)
        .expect("one word track");
    assert_eq!(one_word_track.cues().len(), 4);
    assert_eq!(one_word_track.cues()[2].start_ms(), 600);
    assert_eq!(one_word_track.cues()[2].end_ms(), 700);

    // 2. Short projection: end time must be max(w.end_ms) = 1000 (Bug #5 fix)
    let short_proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 2,
            max_duration_ms: 5000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let short_track = short_proj
        .to_subtitle_track("Short", TrackOrigin::Srt)
        .expect("short track");
    assert_eq!(short_track.cues()[0].end_ms(), 1000);

    // 3. Mutate projection: split at zero-duration word (Bug #4 fix) and merge user-edited text (Bug #6 fix)
    // Short projection with max_words = 3 puts w0, w1, w2 into cue 0 [0..1000] and w3 into cue 1 [650..900]
    let mut proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 3,
            max_duration_ms: 10000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    assert_eq!(proj.cues().len(), 2);
    assert_eq!(proj.cues()[0].word_ids.len(), 3); // w0, w1, w2

    // Split cue 0 at word index 2 (isolating zero-duration w2 [600, 600])
    let cue0_id = proj.cues()[0].id;
    let (split1_id, split2_id) = proj
        .split_cue(cue0_id, 2, &rev, ScriptSpacing::SpaceSeparated)
        .expect("split cue at zero-duration boundary succeeds");

    let split2_cue = proj.cues().iter().find(|c| c.id == split2_id).unwrap();
    // Zero-duration w2 [600, 600] must be clamped to 600 + 50 = 650 by split_cue
    assert_eq!(split2_cue.start_ms, 600);
    assert_eq!(split2_cue.end_ms, 650);

    // Simulate user editing text on split1_cue via serde
    let mut val = serde_json::to_value(&proj).unwrap();
    val["cues"][0]["text"] = serde_json::Value::String("USER_CUSTOM_SPLIT".into());
    val["cues"][0]["manualState"] = serde_json::Value::String("edited_text".into());
    let mut proj: CaptionProjection = serde_json::from_value(val).unwrap();

    // Now merge split1 and split2 cues
    let merged_id = proj
        .merge_cues(split1_id, split2_id, &rev, ScriptSpacing::SpaceSeparated)
        .unwrap();
    let merged_cue = proj.cues().iter().find(|c| c.id == merged_id).unwrap();
    assert_eq!(merged_cue.text, "USER_CUSTOM_SPLIT zero");
    assert_eq!(merged_cue.manual_state, ManualEditState::EditedText);
    assert_eq!(merged_cue.start_ms, 0);
    assert_eq!(merged_cue.end_ms, 1000); // max of split1 (1000) and split2 (650)

    let final_track = proj
        .to_subtitle_track("Subtitles", TrackOrigin::Srt)
        .expect("valid track");
    assert_eq!(final_track.cues().len(), 2);

    // 4. Construct ProjectSnapshot and commit to SQLite Database
    let snapshot =
        osg_application::ProjectSnapshot::new(meta.clone(), 0, Vec::new(), vec![final_track])
            .expect("valid snapshot");

    let reason = RevisionReason::new("Commit remediated projection").unwrap();
    let commit = db
        .commit_project(&snapshot, &reason)
        .expect("commit project");
    assert_eq!(commit.state_version, 1);

    // 5. Load project from Database and verify snapshot decompression, blake3 hash, and exact fidelity
    let loaded = db
        .load_project(project_id)
        .unwrap()
        .expect("project loaded");
    assert_eq!(loaded.state_version(), 1);
    assert_eq!(loaded.tracks().len(), 1);
    let loaded_cues = loaded.tracks()[0].cues();
    assert_eq!(loaded_cues.len(), 2);
    assert_eq!(loaded_cues[0].text(), "USER_CUSTOM_SPLIT zero");
    assert_eq!(loaded_cues[0].start_ms(), 0);
    assert_eq!(loaded_cues[0].end_ms(), 1000);
    assert_eq!(loaded_cues[1].text(), "trail");
    assert_eq!(loaded_cues[1].start_ms(), 650);
    assert_eq!(loaded_cues[1].end_ms(), 900);

    // Verify raw SQLite database state
    let conn = Connection::open(&db_path).unwrap();
    let cue_count: i64 = conn
        .query_row("SELECT count(*) FROM cues", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cue_count, 2);

    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");

    let fk_count: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check()", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fk_count, 0);

    // 6. Test undo/redo
    let undone = db
        .undo_project(project_id, 1)
        .unwrap()
        .expect("undone snapshot");
    assert_eq!(undone.tracks().len(), 0);
    let redone = db
        .redo_project(project_id, 2)
        .unwrap()
        .expect("redone snapshot");
    assert_eq!(redone.tracks().len(), 1);
    assert_eq!(redone.tracks()[0].cues().len(), 2);
}

#[test]
fn test_remediated_cue_word_mappings_foreign_key_and_storage_integrity() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("cue_word_map_fk.db");
    let db = Database::open(&db_path).unwrap();

    let meta = ProjectMetadata::new("Cue Word Map FK Test").unwrap();
    let project_id = meta.id();
    let _ = db.create_project(&meta).unwrap();

    let rev_id = TranscriptRevisionId::new();
    let w0_id = WordId::new();
    let w1_id = WordId::new();
    let turn_id = TurnId::new();

    let rev_rec = TranscriptRevisionRecord {
        id: rev_id,
        project_id,
        media_id: None,
        provider: "gemini".to_string(),
        model: "gemini-3.5-transcribe".to_string(),
        source_range_start_ms: 0,
        source_range_end_ms: 2000,
        state: "completed".to_string(),
        fingerprint: "fp".to_string(),
        word_count: 0,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    };
    db.transcript_insert_revision(&rev_rec).unwrap();

    let turn_rec = TranscriptTurnRecord {
        id: turn_id,
        revision_id: rev_id,
        ordinal: 0,
        speaker_id: "Speaker".to_string(),
        start_ms: 0,
        end_ms: 2000,
        text: "hello world".to_string(),
        start_word_ordinal: 0,
        end_word_ordinal: 1,
        metadata_json: "{}".to_string(),
    };

    let word_recs = vec![
        TranscriptWordRecord {
            id: w0_id,
            revision_id: rev_id,
            turn_id: Some(turn_id),
            ordinal: 0,
            text: "hello".to_string(),
            raw_start_ns: 0,
            raw_end_ns: 1_000_000_000,
            start_ms: 0,
            end_ms: 1000,
            speaker_id: Some("Speaker".to_string()),
            confidence: Some(0.99),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
        TranscriptWordRecord {
            id: w1_id,
            revision_id: rev_id,
            turn_id: Some(turn_id),
            ordinal: 1,
            text: "world".to_string(),
            raw_start_ns: 1_000_000_000,
            raw_end_ns: 2_000_000_000,
            start_ms: 1000,
            end_ms: 2000,
            speaker_id: Some("Speaker".to_string()),
            confidence: Some(0.99),
            is_unaligned: false,
            alignment_status: "aligned".to_string(),
            provenance: "provider".to_string(),
            metadata_json: "{}".to_string(),
        },
    ];

    db.transcript_promote_window(rev_id, &[turn_rec], &word_recs)
        .unwrap();

    // Create and commit a track with 1 cue enclosing both words
    let cue_id = CueId::new();
    let cue = SubtitleCue::restore(cue_id, 1, 0, 2000, "hello world".to_string(), None).unwrap();
    let track =
        SubtitleTrack::restore(TrackId::new(), "Subtitles", TrackOrigin::Srt, vec![cue]).unwrap();
    let snap =
        osg_application::ProjectSnapshot::new(meta.clone(), 0, Vec::new(), vec![track]).unwrap();
    db.commit_project(&snap, &RevisionReason::new("commit cues").unwrap())
        .unwrap();

    // 1. Save valid mappings
    let valid_mappings = vec![
        CueWordMappingRecord {
            cue_id,
            word_id: w0_id,
            word_ordinal: 0,
            metadata_json: "{}".to_string(),
        },
        CueWordMappingRecord {
            cue_id,
            word_id: w1_id,
            word_ordinal: 1,
            metadata_json: "{}".to_string(),
        },
    ];
    db.transcript_save_cue_mappings(&valid_mappings)
        .expect("valid mappings save");

    let loaded_mappings = db.transcript_load_cue_mappings(project_id).unwrap();
    assert_eq!(loaded_mappings.len(), 2);
    assert_eq!(loaded_mappings[0].cue_id, cue_id);
    assert_eq!(loaded_mappings[0].word_id, w0_id);
    assert_eq!(loaded_mappings[1].cue_id, cue_id);
    assert_eq!(loaded_mappings[1].word_id, w1_id);

    // 2. Hostile: mapping with non-existent cue_id -> foreign key error
    let bad_cue_mapping = CueWordMappingRecord {
        cue_id: CueId::new(), // non-existent
        word_id: w0_id,
        word_ordinal: 2,
        metadata_json: "{}".to_string(),
    };
    assert!(db.transcript_save_cue_mappings(&[bad_cue_mapping]).is_err());

    // 3. Hostile: mapping with non-existent word_id -> foreign key error
    let bad_word_mapping = CueWordMappingRecord {
        cue_id,
        word_id: WordId::new(), // non-existent
        word_ordinal: 3,
        metadata_json: "{}".to_string(),
    };
    assert!(
        db.transcript_save_cue_mappings(&[bad_word_mapping])
            .is_err()
    );

    // 4. Cascade delete: deleting project removes cue_word_mappings
    drop(db);
    let conn = Connection::open(&db_path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute("DELETE FROM projects WHERE id = ?1", [project_id.as_uuid()])
        .unwrap();

    let remaining_mappings: i64 = conn
        .query_row("SELECT count(*) FROM cue_word_mappings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        remaining_mappings, 0,
        "cue_word_mappings must be purged on cascade delete"
    );
}

#[test]
fn test_transcript_revision_serde_prefix_index_reconstitution() {
    let rev_id = TranscriptRevisionId::new();
    let project_id = ProjectId::new();

    // Words with out-of-order end times
    let w0 = TimedWord::new(
        rev_id,
        1,
        "long",
        "0ms",
        "1000ms",
        0,
        1000,
        Some("A".to_string()),
        None,
    )
    .unwrap();
    let w1 = TimedWord::new(
        rev_id,
        2,
        "short",
        "200ms",
        "400ms",
        200,
        400,
        Some("A".to_string()),
        None,
    )
    .unwrap();
    let w2 = TimedWord::new(
        rev_id,
        3,
        "nested",
        "600ms",
        "800ms",
        600,
        800,
        Some("B".to_string()),
        None,
    )
    .unwrap();

    // Overlapping turns
    let t0 = TranscriptTurn::from_words(
        rev_id,
        1,
        Some("A".to_string()),
        &[w0.clone(), w1.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let t1 = TranscriptTurn::from_words(
        rev_id,
        2,
        Some("B".to_string()),
        &[w2.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();

    let rev = TranscriptRevision::new(
        project_id,
        None,
        0,
        2000,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp_serde_test",
        1000,
        vec![w0, w1, w2],
        vec![t0, t1],
    )
    .unwrap();

    // Serialize to JSON
    let json = serde_json::to_string(&rev).expect("serialize revision");
    // Verify that transient spatial index fields are NOT serialized (skip_serializing)
    assert!(
        !json.contains("wordPrefixMaxEndMs"),
        "wordPrefixMaxEndMs must not be serialized into JSON"
    );
    assert!(
        !json.contains("turnPrefixMaxEndMs"),
        "turnPrefixMaxEndMs must not be serialized into JSON"
    );

    // Deserialize from JSON: restore MUST reconstitute spatial indices
    let restored: TranscriptRevision = serde_json::from_str(&json).expect("deserialize revision");
    assert_eq!(restored, rev);

    // Verify spatial queries produce identical results on restored revision:
    assert_eq!(
        restored.active_word_at(100).map(TimedWord::text),
        Some("long")
    );
    assert_eq!(
        restored.active_word_at(300).map(TimedWord::text),
        Some("short")
    );
    assert_eq!(
        restored.active_word_at(500).map(TimedWord::text),
        Some("long")
    );
    assert_eq!(
        restored.active_word_at(700).map(TimedWord::text),
        Some("nested")
    );
    assert_eq!(
        restored.active_word_at(900).map(TimedWord::text),
        Some("long")
    );
    assert_eq!(restored.active_word_at(1000), None);

    // Intersecting words in range
    let in_range = restored.words_in_range(500, 600);
    assert_eq!(in_range.len(), 1);
    assert_eq!(in_range[0].text(), "long");

    let all_in_range = restored.words_in_range(150, 750);
    assert_eq!(all_in_range.len(), 3);
}

#[test]
fn test_legacy_project_mutation_with_remediated_domain_in_v15_runtime() {
    let db_file = NamedTempFile::new().expect("temp db file");
    let db_path = db_file.path().to_owned();
    let project_id = ProjectId::new();

    // 1. Seed legacy project at v14
    {
        let mut conn = Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        test_migrations().to_version(&mut conn, 14).unwrap();
        seed_legacy_project_in_db(
            &conn,
            project_id,
            "Legacy v14 Mutation Project",
            &[(0, 2000, "Legacy Cue 1"), (2500, 5000, "Legacy Cue 2")],
        );
    }

    // 2. Open in v15 runtime
    let db = Database::open(&db_path).expect("open in v15");
    let initial_loaded = db.load_project(project_id).unwrap().expect("loaded");
    assert_eq!(initial_loaded.tracks().len(), 1);
    let legacy_track = initial_loaded.tracks()[0].clone();
    assert_eq!(legacy_track.cues().len(), 2);

    // 3. Add a word-native transcript revision to this project
    let rev_id = TranscriptRevisionId::new();
    let w0 = TimedWord::new(rev_id, 1, "new", "1000ms", "1500ms", 1000, 1500, None, None).unwrap();
    let w1 = TimedWord::new(
        rev_id, 2, "words", "1600ms", "2200ms", 1600, 2200, None, None,
    )
    .unwrap();
    let t0 = TranscriptTurn::from_words(
        rev_id,
        1,
        None,
        &[w0.clone(), w1.clone()],
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let rev = TranscriptRevision::new(
        project_id,
        None,
        1000,
        2500,
        "gemini",
        "gemini-3.5-transcribe",
        1,
        CompletionState::Completed,
        "fp",
        1000,
        vec![w0, w1],
        vec![t0],
    )
    .unwrap();

    let proj = CaptionProjection::project(
        &rev,
        TrackId::new(),
        GroupingPolicy::Short {
            max_words: 2,
            max_duration_ms: 5000,
        },
        ScriptSpacing::SpaceSeparated,
    )
    .unwrap();
    let new_track = proj
        .to_subtitle_track("Word-Native Track", TrackOrigin::Srt)
        .unwrap();

    // 4. Update snapshot with BOTH legacy track and new remediated track
    let updated_snapshot = osg_application::ProjectSnapshot::new(
        initial_loaded.metadata().clone(),
        initial_loaded.state_version(),
        initial_loaded.media().to_vec(),
        vec![legacy_track.clone(), new_track.clone()],
    )
    .unwrap();

    let commit = db
        .commit_project(
            &updated_snapshot,
            &RevisionReason::new("add native track").unwrap(),
        )
        .unwrap();
    assert_eq!(commit.state_version, 1);

    // 5. Verify both tracks are loaded and intact
    let reloaded = db.load_project(project_id).unwrap().expect("reloaded");
    assert_eq!(reloaded.tracks().len(), 2);
    assert_eq!(reloaded.tracks()[0].label(), "Subtitles");
    assert_eq!(reloaded.tracks()[0].cues().len(), 2);
    assert_eq!(reloaded.tracks()[1].label(), "Word-Native Track");
    assert_eq!(reloaded.tracks()[1].cues().len(), 1);

    // 6. Undo back to legacy state
    let undone = db.undo_project(project_id, 1).unwrap().expect("undo");
    assert_eq!(undone.tracks().len(), 1);
    assert_eq!(undone.tracks()[0].cues().len(), 2);
    assert_eq!(undone.tracks()[0].cues()[0].text(), "Legacy Cue 1");

    // 7. Redo back to 2-track state
    let redone = db.redo_project(project_id, 2).unwrap().expect("redo");
    assert_eq!(redone.tracks().len(), 2);
}
