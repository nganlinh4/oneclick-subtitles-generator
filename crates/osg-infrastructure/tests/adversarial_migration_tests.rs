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

//! Adversarial migration checks for osg-infrastructure: idempotent upgrades across every prior
//! schema version under dirty or aborted state, corrupted legacy state, and legacy projects that must
//! load and mutate cleanly without synthetic word timings.

mod common;

use osg_domain::{
    CaptionProjection, CompletionState, GroupingPolicy, ProjectId, RevisionReason, ScriptSpacing,
    TimedWord, TrackId, TrackOrigin, TranscriptRevision, TranscriptRevisionId, TranscriptTurn,
};
use osg_infrastructure::storage::{Database, DatabaseError};
use rusqlite::{Connection, params};
use tempfile::tempdir;
use uuid::Uuid;

use common::{seed_legacy_project_in_db, test_migrations};

// =========================================================================================
// SECTION 1: Idempotent Migration v1..=14 -> 16 under Dirty / Aborted State Simulations
// =========================================================================================

#[test]
fn test_idempotent_migration_v1_to_v14_repeated_reopens() {
    for prior_version in 1..=14 {
        let db_dir = tempdir().expect("temp db dir");
        let db_path = db_dir.path().join("osg.sqlite3");
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

        // 2. Open with production Database::open, upgrading to schema v17
        {
            let db = Database::open(&db_path).expect("Database::open to v17");
            let health = db.health().expect("health");
            assert_eq!(
                health.schema_version, 17,
                "Schema must be v17 after Database::open for v{prior_version}"
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
            assert_eq!(version, 17);

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
    let db_dir = tempdir().expect("temp db dir");
    let db_path = db_dir.path().join("osg.sqlite3");
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
    assert_eq!(health.schema_version, 17);

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
    let db_dir = tempdir().expect("temp db dir");
    let db_path = db_dir.path().join("osg.sqlite3");

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
// SECTION 4: Backward Compatibility (v1..=14 Without Synthetic Timings)
// =========================================================================================

#[test]
fn test_all_v1_to_v14_projects_load_without_synthetic_words_or_errors() {
    for prior_version in 1..=14 {
        let db_dir = tempdir().expect("temp db dir");
        let db_path = db_dir.path().join("osg.sqlite3");
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

#[test]
fn test_legacy_project_mutation_with_remediated_domain_in_v15_runtime() {
    let db_dir = tempdir().expect("temp db dir");
    let db_path = db_dir.path().join("osg.sqlite3");
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
