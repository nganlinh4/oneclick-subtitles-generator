use osg_domain::{AssetId, CueId, ProjectId, TranscriptRevisionId, TurnId, WordId};
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::error::DatabaseError;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRevisionRecord {
    pub id: TranscriptRevisionId,
    pub project_id: ProjectId,
    pub media_id: Option<AssetId>,
    pub provider: String,
    pub model: String,
    pub source_range_start_ms: i64,
    pub source_range_end_ms: i64,
    pub state: String,
    pub fingerprint: String,
    pub word_count: u32,
    pub metadata_json: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWordRecord {
    pub id: WordId,
    pub revision_id: TranscriptRevisionId,
    pub turn_id: Option<TurnId>,
    pub ordinal: u32,
    pub text: String,
    pub raw_start_ns: u64,
    pub raw_end_ns: u64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_id: Option<String>,
    pub confidence: Option<f32>,
    pub is_unaligned: bool,
    pub alignment_status: String,
    pub provenance: String,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurnRecord {
    pub id: TurnId,
    pub revision_id: TranscriptRevisionId,
    pub ordinal: u32,
    pub speaker_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub start_word_ordinal: u32,
    pub end_word_ordinal: u32,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueWordMappingRecord {
    pub cue_id: CueId,
    pub word_id: WordId,
    pub word_ordinal: u32,
    pub metadata_json: String,
}

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

/// Retrieves a transcript revision record by its ID.
pub fn get_transcript_revision(
    connection: &Connection,
    id: TranscriptRevisionId,
) -> Result<Option<TranscriptRevisionRecord>, DatabaseError> {
    let mut stmt = connection.prepare(
        "SELECT id, project_id, media_id, provider, model,
                source_range_start_ms, source_range_end_ms, state,
                fingerprint, word_count, metadata_json, created_at_ms, updated_at_ms
         FROM transcript_revisions WHERE id = ?1",
    )?;

    let mut rows = stmt.query([id.as_uuid()])?;
    if let Some(row) = rows.next()? {
        let id = TranscriptRevisionId::from_uuid(row.get::<_, Uuid>(0)?)
            .map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let project_id = ProjectId::from_uuid(row.get::<_, Uuid>(1)?)
            .map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let media_id = row
            .get::<_, Option<Uuid>>(2)?
            .map(|u| AssetId::from_uuid(u).map_err(|e| DatabaseError::Integrity(e.to_string())))
            .transpose()?;
        let provider: String = row.get(3)?;
        let model: String = row.get(4)?;
        let source_range_start_ms: i64 = row.get(5)?;
        let source_range_end_ms: i64 = row.get(6)?;
        let state: String = row.get(7)?;
        let fingerprint: String = row.get(8)?;
        let word_count: i64 = row.get(9)?;
        let metadata_json: String = row.get(10)?;
        let created_at_ms: i64 = row.get(11)?;
        let updated_at_ms: i64 = row.get(12)?;

        let word_count = u32::try_from(word_count)
            .map_err(|_| DatabaseError::Integrity("word_count out of range".into()))?;

        Ok(Some(TranscriptRevisionRecord {
            id,
            project_id,
            media_id,
            provider,
            model,
            source_range_start_ms,
            source_range_end_ms,
            state,
            fingerprint,
            word_count,
            metadata_json,
            created_at_ms,
            updated_at_ms,
        }))
    } else {
        Ok(None)
    }
}

/// Lists all transcript revisions for a given project.
pub fn list_transcript_revisions_for_project(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<Vec<TranscriptRevisionRecord>, DatabaseError> {
    let mut stmt = connection.prepare(
        "SELECT id, project_id, media_id, provider, model,
                source_range_start_ms, source_range_end_ms, state,
                fingerprint, word_count, metadata_json, created_at_ms, updated_at_ms
         FROM transcript_revisions WHERE project_id = ?1
         ORDER BY created_at_ms ASC",
    )?;

    let rows = stmt.query_map([project_id.as_uuid()], |row| {
        let id_uuid: Uuid = row.get(0)?;
        let proj_uuid: Uuid = row.get(1)?;
        let media_uuid: Option<Uuid> = row.get(2)?;
        let provider: String = row.get(3)?;
        let model: String = row.get(4)?;
        let source_range_start_ms: i64 = row.get(5)?;
        let source_range_end_ms: i64 = row.get(6)?;
        let state: String = row.get(7)?;
        let fingerprint: String = row.get(8)?;
        let word_count: i64 = row.get(9)?;
        let metadata_json: String = row.get(10)?;
        let created_at_ms: i64 = row.get(11)?;
        let updated_at_ms: i64 = row.get(12)?;

        Ok((
            id_uuid,
            proj_uuid,
            media_uuid,
            provider,
            model,
            source_range_start_ms,
            source_range_end_ms,
            state,
            fingerprint,
            word_count,
            metadata_json,
            created_at_ms,
            updated_at_ms,
        ))
    })?;

    let mut records = Vec::new();
    for row in rows {
        let (
            id_uuid,
            proj_uuid,
            media_uuid,
            provider,
            model,
            source_range_start_ms,
            source_range_end_ms,
            state,
            fingerprint,
            word_count,
            metadata_json,
            created_at_ms,
            updated_at_ms,
        ) = row?;

        let id = TranscriptRevisionId::from_uuid(id_uuid)
            .map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let project_id =
            ProjectId::from_uuid(proj_uuid).map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let media_id = media_uuid
            .map(|u| AssetId::from_uuid(u).map_err(|e| DatabaseError::Integrity(e.to_string())))
            .transpose()?;
        let word_count = u32::try_from(word_count)
            .map_err(|_| DatabaseError::Integrity("word_count out of range".into()))?;

        records.push(TranscriptRevisionRecord {
            id,
            project_id,
            media_id,
            provider,
            model,
            source_range_start_ms,
            source_range_end_ms,
            state,
            fingerprint,
            word_count,
            metadata_json,
            created_at_ms,
            updated_at_ms,
        });
    }

    Ok(records)
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

/// Loads all cue-word mappings for a given project.
pub fn load_cue_word_mappings_for_project(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<Vec<CueWordMappingRecord>, DatabaseError> {
    let mut stmt = connection.prepare(
        "SELECT m.cue_id, m.word_id, m.word_ordinal, m.metadata_json
         FROM cue_word_mappings m
         JOIN cues c ON c.id = m.cue_id
         JOIN tracks t ON t.id = c.track_id
         WHERE t.project_id = ?1
         ORDER BY m.cue_id, m.word_ordinal ASC",
    )?;

    let rows = stmt.query_map([project_id.as_uuid()], |row| {
        let cue_uuid: Uuid = row.get(0)?;
        let word_uuid: Uuid = row.get(1)?;
        let word_ordinal: i64 = row.get(2)?;
        let metadata_json: String = row.get(3)?;
        Ok((cue_uuid, word_uuid, word_ordinal, metadata_json))
    })?;

    let mut records = Vec::new();
    for row in rows {
        let (cue_uuid, word_uuid, word_ordinal, metadata_json) = row?;
        let cue_id =
            CueId::from_uuid(cue_uuid).map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let word_id =
            WordId::from_uuid(word_uuid).map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let word_ordinal = u32::try_from(word_ordinal)
            .map_err(|_| DatabaseError::Integrity("word_ordinal out of range".into()))?;

        records.push(CueWordMappingRecord {
            cue_id,
            word_id,
            word_ordinal,
            metadata_json,
        });
    }

    Ok(records)
}

/// Queries the single active word at time `time_ms` for a transcript revision.
pub fn query_active_word(
    connection: &Connection,
    revision_id: TranscriptRevisionId,
    time_ms: i64,
) -> Result<Option<TranscriptWordRecord>, DatabaseError> {
    let mut stmt = connection.prepare(
        "SELECT id, revision_id, turn_id, ordinal, text,
                raw_start_ns, raw_end_ns, start_ms, end_ms,
                speaker_id, confidence, is_unaligned, alignment_status, provenance, metadata_json
         FROM transcript_words
         WHERE revision_id = ?1 AND start_ms <= ?2 AND end_ms >= ?2
         ORDER BY start_ms ASC
         LIMIT 1",
    )?;

    let mut rows = stmt.query(params![revision_id.as_uuid(), time_ms])?;
    if let Some(row) = rows.next()? {
        Ok(Some(extract_word_record(row)?))
    } else {
        Ok(None)
    }
}

/// Queries all words intersecting range `[start_ms, end_ms)` for a transcript revision.
pub fn query_words_in_range(
    connection: &Connection,
    revision_id: TranscriptRevisionId,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<TranscriptWordRecord>, DatabaseError> {
    let mut stmt = connection.prepare(
        "SELECT id, revision_id, turn_id, ordinal, text,
                raw_start_ns, raw_end_ns, start_ms, end_ms,
                speaker_id, confidence, is_unaligned, alignment_status, provenance, metadata_json
         FROM transcript_words
         WHERE revision_id = ?1 AND start_ms < ?3 AND end_ms > ?2
         ORDER BY ordinal ASC",
    )?;

    let mut rows = stmt.query(params![revision_id.as_uuid(), start_ms, end_ms])?;
    let mut words = Vec::new();
    while let Some(row) = rows.next()? {
        words.push(extract_word_record(row)?);
    }
    Ok(words)
}

/// Queries all speaker turns intersecting range `[start_ms, end_ms)` for a transcript revision.
pub fn query_turns_in_range(
    connection: &Connection,
    revision_id: TranscriptRevisionId,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<TranscriptTurnRecord>, DatabaseError> {
    let mut stmt = connection.prepare(
        "SELECT id, revision_id, ordinal, speaker_id, start_ms, end_ms, text,
                start_word_ordinal, end_word_ordinal, metadata_json
         FROM transcript_turns
         WHERE revision_id = ?1 AND start_ms < ?3 AND end_ms > ?2
         ORDER BY ordinal ASC",
    )?;

    let rows = stmt.query_map(params![revision_id.as_uuid(), start_ms, end_ms], |row| {
        let id_uuid: Uuid = row.get(0)?;
        let rev_uuid: Uuid = row.get(1)?;
        let ordinal: i64 = row.get(2)?;
        let speaker_id: String = row.get(3)?;
        let start_ms: i64 = row.get(4)?;
        let end_ms: i64 = row.get(5)?;
        let text: String = row.get(6)?;
        let start_word_ordinal: i64 = row.get(7)?;
        let end_word_ordinal: i64 = row.get(8)?;
        let metadata_json: String = row.get(9)?;

        Ok((
            id_uuid,
            rev_uuid,
            ordinal,
            speaker_id,
            start_ms,
            end_ms,
            text,
            start_word_ordinal,
            end_word_ordinal,
            metadata_json,
        ))
    })?;

    let mut turns = Vec::new();
    for row in rows {
        let (
            id_uuid,
            rev_uuid,
            ordinal,
            speaker_id,
            start_ms,
            end_ms,
            text,
            start_word_ordinal,
            end_word_ordinal,
            metadata_json,
        ) = row?;

        let id = TurnId::from_uuid(id_uuid).map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let revision_id = TranscriptRevisionId::from_uuid(rev_uuid)
            .map_err(|e| DatabaseError::Integrity(e.to_string()))?;
        let ordinal = u32::try_from(ordinal)
            .map_err(|_| DatabaseError::Integrity("turn ordinal out of range".into()))?;
        let start_word_ordinal = u32::try_from(start_word_ordinal)
            .map_err(|_| DatabaseError::Integrity("start_word_ordinal out of range".into()))?;
        let end_word_ordinal = u32::try_from(end_word_ordinal)
            .map_err(|_| DatabaseError::Integrity("end_word_ordinal out of range".into()))?;

        turns.push(TranscriptTurnRecord {
            id,
            revision_id,
            ordinal,
            speaker_id,
            start_ms,
            end_ms,
            text,
            start_word_ordinal,
            end_word_ordinal,
            metadata_json,
        });
    }
    Ok(turns)
}

fn extract_word_record(row: &rusqlite::Row<'_>) -> Result<TranscriptWordRecord, DatabaseError> {
    extract_word_record_from_rusqlite(row)
}

fn extract_word_record_from_rusqlite(
    row: &rusqlite::Row<'_>,
) -> Result<TranscriptWordRecord, DatabaseError> {
    let id_uuid: Uuid = row.get(0)?;
    let rev_uuid: Uuid = row.get(1)?;
    let turn_uuid: Option<Uuid> = row.get(2)?;
    let ordinal: i64 = row.get(3)?;
    let text: String = row.get(4)?;
    let raw_start_ns: i64 = row.get(5)?;
    let raw_end_ns: i64 = row.get(6)?;
    let start_ms: i64 = row.get(7)?;
    let end_ms: i64 = row.get(8)?;
    let speaker_id: Option<String> = row.get(9)?;
    let confidence: Option<f32> = row.get(10)?;
    let is_unaligned_int: i64 = row.get(11)?;
    let alignment_status: String = row.get(12)?;
    let provenance: String = row.get(13)?;
    let metadata_json: String = row.get(14)?;

    let id = WordId::from_uuid(id_uuid).map_err(|e| DatabaseError::Integrity(e.to_string()))?;
    let revision_id = TranscriptRevisionId::from_uuid(rev_uuid)
        .map_err(|e| DatabaseError::Integrity(e.to_string()))?;
    let turn_id = turn_uuid
        .map(|u| TurnId::from_uuid(u).map_err(|e| DatabaseError::Integrity(e.to_string())))
        .transpose()?;
    let ordinal = u32::try_from(ordinal)
        .map_err(|_| DatabaseError::Integrity("word ordinal out of range".into()))?;

    Ok(TranscriptWordRecord {
        id,
        revision_id,
        turn_id,
        ordinal,
        text,
        raw_start_ns: u64::try_from(raw_start_ns.max(0)).unwrap_or(0),
        raw_end_ns: u64::try_from(raw_end_ns.max(0)).unwrap_or(0),
        start_ms,
        end_ms,
        speaker_id,
        confidence,
        is_unaligned: is_unaligned_int != 0,
        alignment_status,
        provenance,
        metadata_json,
    })
}

#[cfg(test)]
#[allow(clippy::too_many_lines)]
mod tests {
    use super::*;
    use crate::storage::actor::Database;
    use crate::storage::migrations::migrations;
    use osg_domain::{
        CueId, ProjectId, ProjectMetadata, TrackId, TranscriptRevisionId, TurnId, WordId,
    };
    use rusqlite::{Connection, params};
    use tempfile::tempdir;

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
        let loaded_after_cue_delete =
            load_cue_word_mappings_for_project(&conn, project_id).unwrap();
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
        let invalid_err =
            update_transcript_revision_state(&conn, rev_id, "bogus_state").unwrap_err();
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
}
