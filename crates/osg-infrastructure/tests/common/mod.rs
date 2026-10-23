//! Shared fixtures for the adversarial storage integration tests: a migration runner, a seeded
//! legacy project, and a sample transcript revision.

#![allow(dead_code)]

use osg_domain::{
    CueId, ProjectId, ProjectMetadata, SubtitleCue, SubtitleTrack, TrackId, TrackOrigin,
    TranscriptRevisionId,
};
use osg_infrastructure::storage::transcripts::TranscriptRevisionRecord;
use rusqlite::{Connection, params};
use rusqlite_migration::{M, Migrations};
use uuid::Uuid;

pub(crate) fn test_migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../../src/storage/sql/0001_initial.sql")),
        M::up(include_str!(
            "../../src/storage/sql/0002_youtube_oauth_token.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0003_job_restore_window.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0004_editor_track_history.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0005_process_media_job.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0006_media_artifact_ownership.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0007_media_artifact_repair.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0008_media_artifact_duplicate_key_repair.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0009_job_result_deliveries.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0010_project_speech_references.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0011_project_render_scenes.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0012_project_create_receipts.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0013_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0014_sparse_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0015_word_native_transcripts.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0016_late_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!(
            "../../src/storage/sql/0017_readable_default_subtitle_scale.sql"
        )),
    ])
}

pub(crate) fn seed_legacy_project_in_db(
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

pub(crate) fn create_sample_revision(
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
        state: osg_infrastructure::storage::TranscriptRevisionState::Completed,
        fingerprint: "test_fingerprint".to_string(),
        word_count: 0,
        metadata_json: "{}".to_string(),
        created_at_ms: 1000,
        updated_at_ms: 1000,
    }
}
