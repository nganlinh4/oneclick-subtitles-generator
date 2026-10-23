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

//! Adversarial round trips between the word-native domain projection and storage: snapshot commits,
//! cue-word mapping integrity, and revision serde reconstitution.

mod common;

use osg_domain::{
    CaptionProjection, CompletionState, CueId, GroupingPolicy, ManualEditState, ProjectId,
    ProjectMetadata, RevisionReason, ScriptSpacing, SubtitleCue, SubtitleTrack, TimedWord, TrackId,
    TrackOrigin, TranscriptRevision, TranscriptRevisionId, TranscriptTurn, TurnId, WordId,
};
use osg_infrastructure::storage::Database;
use osg_infrastructure::storage::transcripts::{
    CueWordMappingRecord, TranscriptRevisionRecord, TranscriptTurnRecord, TranscriptWordRecord,
};
use rusqlite::Connection;
use tempfile::tempdir;

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
        state: osg_infrastructure::storage::TranscriptRevisionState::Completed,
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
