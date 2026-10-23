//! Transactional writes for transcript revisions, word windows, and cue-word mappings.

use osg_domain::{AssetId, TranscriptRevisionId, TurnId};
use rusqlite::{Connection, Transaction, params};

use super::{
    CueWordMappingRecord, TranscriptRevisionRecord, TranscriptTurnRecord, TranscriptWordRecord,
};
use crate::storage::error::DatabaseError;

/// Atomically inserts a new transcript revision into `SQLite`.
pub fn insert_transcript_revision(
    transaction: &Transaction<'_>,
    revision: &TranscriptRevisionRecord,
) -> Result<(), DatabaseError> {
    transaction.execute(
        "INSERT INTO transcript_revisions(
           id, project_id, media_id, provider, model,
           source_range_start_ms, source_range_end_ms, state,
           fingerprint, word_count, metadata_json, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            revision.id.as_uuid(),
            revision.project_id.as_uuid(),
            revision.media_id.as_ref().map(AssetId::as_uuid),
            revision.provider,
            revision.model,
            revision.source_range_start_ms,
            revision.source_range_end_ms,
            revision.state,
            revision.fingerprint,
            i64::from(revision.word_count),
            revision.metadata_json,
            revision.created_at_ms,
            revision.updated_at_ms,
        ],
    )?;
    Ok(())
}

/// Atomically batches turns and words for an extraction window.
pub fn promote_window_results(
    transaction: &Transaction<'_>,
    revision_id: TranscriptRevisionId,
    turns: &[TranscriptTurnRecord],
    words: &[TranscriptWordRecord],
) -> Result<(), DatabaseError> {
    let mut turn_stmt = transaction.prepare(
        "INSERT INTO transcript_turns(
           id, revision_id, ordinal, speaker_id, start_ms, end_ms, text,
           start_word_ordinal, end_word_ordinal, metadata_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for turn in turns {
        turn_stmt.execute(params![
            turn.id.as_uuid(),
            revision_id.as_uuid(),
            i64::from(turn.ordinal),
            turn.speaker_id,
            turn.start_ms,
            turn.end_ms,
            turn.text,
            i64::from(turn.start_word_ordinal),
            i64::from(turn.end_word_ordinal),
            turn.metadata_json,
        ])?;
    }
    drop(turn_stmt);

    let mut word_stmt = transaction.prepare(
        "INSERT INTO transcript_words(
           id, revision_id, turn_id, ordinal, text,
           raw_start_ns, raw_end_ns, start_ms, end_ms,
           speaker_id, confidence, is_unaligned, alignment_status, provenance, metadata_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )?;
    for word in words {
        word_stmt.execute(params![
            word.id.as_uuid(),
            revision_id.as_uuid(),
            word.turn_id.as_ref().map(TurnId::as_uuid),
            i64::from(word.ordinal),
            word.text,
            i64::try_from(word.raw_start_ns).unwrap_or(i64::MAX),
            i64::try_from(word.raw_end_ns).unwrap_or(i64::MAX),
            word.start_ms,
            word.end_ms,
            word.speaker_id,
            word.confidence,
            i64::from(word.is_unaligned),
            word.alignment_status,
            word.provenance,
            word.metadata_json,
        ])?;
    }
    drop(word_stmt);

    transaction.execute(
        "UPDATE transcript_revisions
         SET word_count = word_count + ?1, updated_at_ms = ?2
         WHERE id = ?3",
        params![
            i64::try_from(words.len())
                .map_err(|_| DatabaseError::Integrity("word count overflow".into()))?,
            crate::storage::actor::now_ms(),
            revision_id.as_uuid(),
        ],
    )?;

    Ok(())
}

/// Updates the state of a transcript revision record.
///
/// Valid states are: `"in_progress"`, `"completed"`, `"partial"`, `"failed"`.
pub fn update_transcript_revision_state(
    connection: &Connection,
    revision_id: TranscriptRevisionId,
    state: &str,
) -> Result<(), DatabaseError> {
    let valid_states = ["in_progress", "completed", "partial", "failed"];
    if !valid_states.contains(&state) {
        return Err(DatabaseError::Integrity(format!(
            "invalid transcript revision state: '{state}', expected one of: {valid_states:?}"
        )));
    }

    let rows_affected = connection.execute(
        "UPDATE transcript_revisions
         SET state = ?1, updated_at_ms = ?2
         WHERE id = ?3",
        params![
            state,
            crate::storage::actor::now_ms(),
            revision_id.as_uuid(),
        ],
    )?;

    if rows_affected == 0 {
        return Err(DatabaseError::TranscriptRevisionNotFound(revision_id));
    }

    Ok(())
}

/// Alias for `update_transcript_revision_state` matching the requested API naming convention.
pub fn transcript_update_revision_state(
    connection: &Connection,
    revision_id: TranscriptRevisionId,
    state: &str,
) -> Result<(), DatabaseError> {
    update_transcript_revision_state(connection, revision_id, state)
}

/// Atomically persists cue word mappings.
pub fn save_cue_word_mappings(
    transaction: &Transaction<'_>,
    mappings: &[CueWordMappingRecord],
) -> Result<(), DatabaseError> {
    let mut stmt = transaction.prepare(
        "INSERT INTO cue_word_mappings(cue_id, word_id, word_ordinal, metadata_json)
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    for mapping in mappings {
        stmt.execute(params![
            mapping.cue_id.as_uuid(),
            mapping.word_id.as_uuid(),
            i64::from(mapping.word_ordinal),
            mapping.metadata_json,
        ])?;
    }
    Ok(())
}
