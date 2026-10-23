//! Transcript reads: revisions, mappings, and indexed time-range lookups.

use osg_domain::{AssetId, CueId, ProjectId, TranscriptRevisionId, TurnId, WordId};
use rusqlite::{Connection, params};
use uuid::Uuid;

use super::{
    CueWordMappingRecord, TranscriptRevisionRecord, TranscriptTurnRecord, TranscriptWordRecord,
};
use crate::storage::error::DatabaseError;

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
