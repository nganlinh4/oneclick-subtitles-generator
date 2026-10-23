use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;

use osg_domain::ProjectId;

use super::DatabaseError;

pub const PROJECT_RENDER_SCENE_SCHEMA_VERSION: u16 = 1;
pub const MAX_PROJECT_RENDER_SCENE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRenderSceneRecord {
    pub project_id: ProjectId,
    pub scene_revision: u64,
    pub schema_version: u16,
    pub scene_json: String,
}

#[derive(Clone, Debug)]
pub struct ProjectRenderSceneWrite {
    pub project_id: ProjectId,
    pub expected_scene_revision: u64,
    pub schema_version: u16,
    pub scene_json: String,
}

pub(super) fn get(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<Option<ProjectRenderSceneRecord>, DatabaseError> {
    let raw = connection
        .query_row(
            "SELECT scene_revision, schema_version, scene_json
             FROM project_render_scenes WHERE project_id = ?1",
            [project_id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    raw.map(|(revision, schema, scene_json)| {
        let scene_revision = u64::try_from(revision)
            .ok()
            .filter(|revision| *revision > 0)
            .ok_or(DatabaseError::InvalidProjectRenderScene)?;
        let schema_version = u16::try_from(schema)
            .ok()
            .filter(|version| *version == PROJECT_RENDER_SCENE_SCHEMA_VERSION)
            .ok_or(DatabaseError::InvalidProjectRenderScene)?;
        validate_json(&scene_json)?;
        Ok(ProjectRenderSceneRecord {
            project_id,
            scene_revision,
            schema_version,
            scene_json,
        })
    })
    .transpose()
}

pub(super) fn put(
    connection: &mut Connection,
    write: &ProjectRenderSceneWrite,
) -> Result<ProjectRenderSceneRecord, DatabaseError> {
    if write.schema_version != PROJECT_RENDER_SCENE_SCHEMA_VERSION {
        return Err(DatabaseError::InvalidProjectRenderScene);
    }
    validate_json(&write.scene_json)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let project_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [write.project_id.as_uuid()],
        |row| row.get(0),
    )?;
    if !project_exists {
        return Err(DatabaseError::ProjectNotFound(write.project_id));
    }
    let actual = get(&transaction, write.project_id)?;
    let actual_revision = actual.as_ref().map_or(0, |scene| scene.scene_revision);
    if actual_revision != write.expected_scene_revision {
        return Err(DatabaseError::StaleProjectRenderScene {
            project_id: write.project_id,
            expected: write.expected_scene_revision,
            actual: actual_revision,
        });
    }
    let next_revision =
        actual_revision
            .checked_add(1)
            .ok_or(DatabaseError::ProjectRenderSceneVersionOverflow(
                write.project_id,
            ))?;
    let next_revision_sql = i64::try_from(next_revision)
        .map_err(|_| DatabaseError::ProjectRenderSceneVersionOverflow(write.project_id))?;
    let expected_sql = i64::try_from(write.expected_scene_revision)
        .map_err(|_| DatabaseError::ProjectRenderSceneVersionOverflow(write.project_id))?;
    let changed = transaction.execute(
        "INSERT INTO project_render_scenes(
           project_id, scene_revision, schema_version, scene_json, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_id) DO UPDATE SET
           scene_revision = excluded.scene_revision,
           schema_version = excluded.schema_version,
           scene_json = excluded.scene_json,
           updated_at_ms = excluded.updated_at_ms
         WHERE project_render_scenes.scene_revision = ?6",
        params![
            write.project_id.as_uuid(),
            next_revision_sql,
            i64::from(write.schema_version),
            write.scene_json,
            now_ms(),
            expected_sql,
        ],
    )?;
    if changed != 1 {
        let observed = get(&transaction, write.project_id)?
            .as_ref()
            .map_or(0, |scene| scene.scene_revision);
        return Err(DatabaseError::StaleProjectRenderScene {
            project_id: write.project_id,
            expected: write.expected_scene_revision,
            actual: observed,
        });
    }
    let stored =
        get(&transaction, write.project_id)?.ok_or(DatabaseError::InvalidProjectRenderScene)?;
    if stored.scene_revision != next_revision
        || stored.schema_version != write.schema_version
        || stored.scene_json != write.scene_json
    {
        return Err(DatabaseError::InvalidProjectRenderScene);
    }
    transaction.commit()?;
    Ok(stored)
}

fn validate_json(value: &str) -> Result<(), DatabaseError> {
    if value.len() < 2 || value.len() > MAX_PROJECT_RENDER_SCENE_BYTES {
        return Err(DatabaseError::InvalidProjectRenderScene);
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| DatabaseError::InvalidProjectRenderScene)?;
    if !parsed.is_object() {
        return Err(DatabaseError::InvalidProjectRenderScene);
    }
    Ok(())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(milliseconds).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests;
