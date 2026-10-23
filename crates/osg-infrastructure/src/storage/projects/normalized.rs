//! Normalized project-state tables: loading and writing the materialized snapshot with
//! identifier and asset validation.

use osg_application::ProjectSnapshot;
use osg_domain::{
    AssetId, CueId, MediaAsset, MediaKind, ProjectId, ProjectMetadata, SubtitleCue, SubtitleTrack,
    TrackId, TrackOrigin,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use super::revisions::to_sql_version;
use crate::storage::actor::now_ms;
use crate::storage::error::DatabaseError;
use crate::storage::media;

#[allow(clippy::too_many_lines)]
pub(super) fn load_normalized(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<ProjectSnapshot, DatabaseError> {
    let (title, state_version) = connection.query_row(
        "SELECT title, state_version FROM projects WHERE id = ?1",
        [project_id.as_uuid()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if state_version < 0 {
        return Err(DatabaseError::CorruptRevisionNavigation(project_id));
    }
    let metadata = ProjectMetadata::with_id(project_id, title).map_err(invalid_snapshot)?;

    let mut media_statement = connection.prepare(
        "SELECT a.id, a.display_name, a.extension, a.size_bytes, a.kind
         FROM project_media p
         JOIN media_assets a ON a.id = p.media_id
         WHERE p.project_id = ?1
         ORDER BY CASE p.role WHEN 'primary' THEN 0 ELSE 1 END, p.ordinal, a.id",
    )?;
    let media_rows = media_statement.query_map([project_id.as_uuid()], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut media = Vec::new();
    for row in media_rows {
        let (id, display_name, extension, size_bytes, kind) = row?;
        let id = AssetId::from_uuid(id).map_err(invalid_snapshot)?;
        let size_bytes = u64::try_from(size_bytes).map_err(|_| {
            DatabaseError::InvalidProjectSnapshot("media size is outside the durable range".into())
        })?;
        let kind = parse_media_kind(&kind)?;
        media.push(
            MediaAsset::with_id(id, display_name, extension, size_bytes, kind)
                .map_err(invalid_snapshot)?,
        );
    }
    drop(media_statement);

    let mut track_statement = connection.prepare(
        "SELECT id, label, origin FROM tracks
         WHERE project_id = ?1 ORDER BY ordinal, id",
    )?;
    let track_rows = track_statement.query_map([project_id.as_uuid()], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut raw_tracks = Vec::new();
    for row in track_rows {
        raw_tracks.push(row?);
    }
    drop(track_statement);

    let mut tracks = Vec::with_capacity(raw_tracks.len());
    for (track_uuid, label, origin) in raw_tracks {
        let track_id = TrackId::from_uuid(track_uuid).map_err(invalid_snapshot)?;
        let mut cue_statement = connection.prepare(
            "SELECT id, ordinal, start_ms, end_ms, text, source_cue_id, metadata_json
             FROM cues WHERE track_id = ?1 ORDER BY ordinal",
        )?;
        let cue_rows = cue_statement.query_map([track_id.as_uuid()], |row| {
            Ok((
                row.get::<_, Uuid>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<Uuid>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut cues = Vec::new();
        for row in cue_rows {
            let (cue_uuid, ordinal, start_ms, end_ms, text, source_uuid, metadata_json) = row?;
            let metadata: serde_json::Value =
                serde_json::from_str(&metadata_json).map_err(invalid_snapshot)?;
            let speaker = serde_json::from_value(
                metadata
                    .get("speaker")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(invalid_snapshot)?;
            let cue_id = CueId::from_uuid(cue_uuid).map_err(invalid_snapshot)?;
            let ordinal = u32::try_from(ordinal).map_err(|_| {
                DatabaseError::InvalidProjectSnapshot(
                    "cue ordinal is outside the domain range".into(),
                )
            })?;
            let source_id = source_uuid
                .map(CueId::from_uuid)
                .transpose()
                .map_err(invalid_snapshot)?;
            cues.push(
                SubtitleCue::restore(cue_id, ordinal, start_ms, end_ms, text, source_id)
                    .map_err(invalid_snapshot)?
                    .with_speaker(speaker),
            );
        }
        tracks.push(
            SubtitleTrack::restore(track_id, label, parse_track_origin(&origin)?, cues)
                .map_err(invalid_snapshot)?,
        );
    }

    ProjectSnapshot::new(
        metadata,
        u64::try_from(state_version)
            .map_err(|_| DatabaseError::CorruptRevisionNavigation(project_id))?,
        media,
        tracks,
    )
    .map_err(invalid_snapshot)
}

fn ensure_identifiers_are_local(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
) -> Result<(), DatabaseError> {
    let project_id = snapshot.metadata().id();
    {
        let mut statement = transaction.prepare(
            "SELECT EXISTS(
               SELECT 1 FROM project_media WHERE media_id = ?1 AND project_id <> ?2
             )",
        )?;
        for asset in snapshot.media() {
            if statement.query_row(params![asset.id().as_uuid(), project_id.as_uuid()], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(DatabaseError::CrossProjectIdentifier {
                    project_id,
                    entity: "media asset",
                });
            }
        }
    }
    {
        let mut statement = transaction
            .prepare("SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1 AND project_id <> ?2)")?;
        for track in snapshot.tracks() {
            if statement.query_row(params![track.id().as_uuid(), project_id.as_uuid()], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(DatabaseError::CrossProjectIdentifier {
                    project_id,
                    entity: "subtitle track",
                });
            }
        }
    }
    {
        let mut statement = transaction.prepare(
            "SELECT EXISTS(
               SELECT 1 FROM cues c JOIN tracks t ON t.id = c.track_id
               WHERE c.id = ?1 AND t.project_id <> ?2
             )",
        )?;
        for cue in snapshot.tracks().iter().flat_map(SubtitleTrack::cues) {
            if statement.query_row(params![cue.id().as_uuid(), project_id.as_uuid()], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(DatabaseError::CrossProjectIdentifier {
                    project_id,
                    entity: "subtitle cue",
                });
            }
        }
    }
    Ok(())
}

pub(super) fn write_normalized(
    transaction: &Transaction<'_>,
    snapshot: &ProjectSnapshot,
) -> Result<(), DatabaseError> {
    ensure_identifiers_are_local(transaction, snapshot)?;
    let project_id = snapshot.metadata().id();
    let timestamp = now_ms();

    for asset in snapshot.media() {
        validate_existing_asset(transaction, asset)?;
    }
    media::promote_project_candidates(transaction, snapshot)?;

    transaction.execute(
        "DELETE FROM project_media WHERE project_id = ?1",
        [project_id.as_uuid()],
    )?;
    for (index, asset) in snapshot.media().iter().enumerate() {
        let (role, ordinal) = if index == 0 {
            ("primary", 0_i64)
        } else {
            (
                "source",
                i64::try_from(index - 1).map_err(|_| {
                    DatabaseError::InvalidProjectSnapshot(
                        "media ordinal exceeds the SQLite range".to_owned(),
                    )
                })?,
            )
        };
        transaction.execute(
            "INSERT INTO project_media(project_id, media_id, role, ordinal)
             VALUES (?1, ?2, ?3, ?4)",
            params![project_id.as_uuid(), asset.id().as_uuid(), role, ordinal],
        )?;
    }

    transaction.execute(
        "DELETE FROM tracks WHERE project_id = ?1",
        [project_id.as_uuid()],
    )?;
    let state_version = to_sql_version(project_id, snapshot.state_version())?;
    for (track_index, track) in snapshot.tracks().iter().enumerate() {
        let ordinal = i64::try_from(track_index).map_err(|_| {
            DatabaseError::InvalidProjectSnapshot(
                "track ordinal exceeds the SQLite range".to_owned(),
            )
        })?;
        transaction.execute(
            "INSERT INTO tracks(
               id, project_id, ordinal, role, language, label, origin, state_version,
               created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, 'user', NULL, ?4, ?5, ?6, ?7, ?7)",
            params![
                track.id().as_uuid(),
                project_id.as_uuid(),
                ordinal,
                track.label(),
                track_origin_name(track.origin()),
                state_version,
                timestamp,
            ],
        )?;
        for cue in track.cues() {
            transaction.execute(
                "INSERT INTO cues(
                   track_id, id, ordinal, start_ms, end_ms, text, source_cue_id, metadata_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    track.id().as_uuid(),
                    cue.id().as_uuid(),
                    i64::from(cue.ordinal()),
                    cue.start_ms(),
                    cue.end_ms(),
                    cue.text(),
                    cue.source_id().map(CueId::into_uuid),
                    serde_json::json!({"speaker": cue.speaker()}).to_string(),
                ],
            )?;
        }
    }
    Ok(())
}

fn validate_existing_asset(
    connection: &Connection,
    asset: &MediaAsset,
) -> Result<(), DatabaseError> {
    let existing = connection
        .query_row(
            "SELECT kind, display_name, extension, size_bytes
             FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((kind, display_name, extension, size_bytes)) = existing else {
        return Err(DatabaseError::InvalidProjectSnapshot(
            "a project media asset must be staged before it can be attached".to_owned(),
        ));
    };
    let expected_size = i64::try_from(asset.size_bytes()).map_err(|_| {
        DatabaseError::InvalidProjectSnapshot("media size exceeds the SQLite range".to_owned())
    })?;
    if kind != media_kind_name(asset.kind())
        || display_name != asset.display_name()
        || extension != asset.extension()
        || size_bytes != expected_size
    {
        return Err(DatabaseError::InvalidProjectSnapshot(
            "an existing media identifier has different immutable metadata".to_owned(),
        ));
    }
    Ok(())
}

fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

fn parse_media_kind(value: &str) -> Result<MediaKind, DatabaseError> {
    match value {
        "audio" => Ok(MediaKind::Audio),
        "video" => Ok(MediaKind::Video),
        _ => Err(DatabaseError::InvalidProjectSnapshot(
            "stored media kind is invalid".to_owned(),
        )),
    }
}

fn track_origin_name(origin: TrackOrigin) -> &'static str {
    match origin {
        TrackOrigin::LegacyJson => "legacyJson",
        TrackOrigin::Srt => "srt",
    }
}

fn parse_track_origin(value: &str) -> Result<TrackOrigin, DatabaseError> {
    match value {
        "legacyJson" => Ok(TrackOrigin::LegacyJson),
        "srt" => Ok(TrackOrigin::Srt),
        _ => Err(DatabaseError::InvalidProjectSnapshot(
            "stored subtitle-track origin is invalid".to_owned(),
        )),
    }
}

pub(super) fn invalid_snapshot(error: impl std::fmt::Display) -> DatabaseError {
    DatabaseError::InvalidProjectSnapshot(error.to_string())
}
