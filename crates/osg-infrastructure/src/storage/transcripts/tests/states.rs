//! Typed transcript revision states and their stored `SQLite` vocabulary.

use osg_domain::TranscriptRevisionId;

use super::setup_test_db;
use crate::storage::DatabaseError;
use crate::storage::transcripts::{
    TranscriptRevisionRecord, TranscriptRevisionState, get_transcript_revision,
    insert_transcript_revision, update_transcript_revision_state,
};

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
        state: TranscriptRevisionState::InProgress,
        fingerprint: "fp_test".to_string(),
        word_count: 0,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    };
    let tx = conn.transaction().unwrap();
    insert_transcript_revision(&tx, &rev).unwrap();
    tx.commit().unwrap();

    // Every typed state round-trips through the stored CHECK vocabulary.
    for state in TranscriptRevisionState::ALL {
        update_transcript_revision_state(&conn, rev_id, state).unwrap();
        let fetched = get_transcript_revision(&conn, rev_id).unwrap().unwrap();
        assert_eq!(fetched.state, state);
        assert!(fetched.updated_at_ms >= 1000);
        let stored: String = conn
            .query_row(
                "SELECT state FROM transcript_revisions WHERE id = ?1",
                [rev_id.as_uuid()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, state.as_str());
    }

    // An unknown stored string is an integrity failure, never a silent default.
    conn.execute_batch("PRAGMA ignore_check_constraints = ON;")
        .unwrap();
    conn.execute(
        "UPDATE transcript_revisions SET state = 'bogus_state' WHERE id = ?1",
        [rev_id.as_uuid()],
    )
    .unwrap();
    assert!(matches!(
        get_transcript_revision(&conn, rev_id),
        Err(DatabaseError::Integrity(_))
    ));

    // 5. Nonexistent revision fails with TranscriptRevisionNotFound
    let missing_id = TranscriptRevisionId::new();
    let not_found_err =
        update_transcript_revision_state(&conn, missing_id, TranscriptRevisionState::Completed)
            .unwrap_err();
    assert!(matches!(
        not_found_err,
        DatabaseError::TranscriptRevisionNotFound(id) if id == missing_id
    ));
}

#[test]
fn revision_state_strings_are_the_stored_vocabulary() {
    let stored = ["in_progress", "completed", "partial", "failed"];
    for (state, text) in TranscriptRevisionState::ALL.into_iter().zip(stored) {
        assert_eq!(state.as_str(), text);
        assert_eq!(TranscriptRevisionState::parse(text), Some(state));
        assert_eq!(serde_json::to_value(state).unwrap(), text);
    }
    assert_eq!(TranscriptRevisionState::parse("bogus"), None);
    assert_eq!(
        TranscriptRevisionState::interrupted(0),
        TranscriptRevisionState::Failed
    );
    assert_eq!(
        TranscriptRevisionState::interrupted(1),
        TranscriptRevisionState::Partial
    );
}
