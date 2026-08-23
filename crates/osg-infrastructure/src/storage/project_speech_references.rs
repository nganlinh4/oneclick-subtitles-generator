use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use uuid::{Uuid, Variant, Version};

use osg_domain::{JobId, ProjectId};

use super::{ArtifactId, DatabaseError};

pub const MAX_REFERENCE_TRANSCRIPT_BYTES: usize = 64 * 1024;
pub const MAX_REFERENCE_LANGUAGE_BYTES: usize = 128;
const REFERENCE_KIND_PREFIX: &str = "speechReference.";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSpeechReference {
    pub project_id: ProjectId,
    pub artifact_id: ArtifactId,
    pub reference_version: u64,
    pub committed_project_state_version: u64,
    pub transcript: String,
    pub language: String,
    pub delivery_job_id: Option<JobId>,
    pub delivery_id: Option<Uuid>,
}

#[derive(Clone, Debug)]
pub struct ProjectSpeechReferenceWrite {
    pub project_id: ProjectId,
    pub expected_project_state_version: u64,
    pub expected_reference_version: u64,
    pub artifact_id: ArtifactId,
    pub transcript: String,
    pub language: String,
    pub delivery_job_id: Option<JobId>,
    pub delivery_id: Option<Uuid>,
}

pub(super) fn get(
    connection: &Connection,
    project_id: ProjectId,
) -> Result<Option<ProjectSpeechReference>, DatabaseError> {
    let raw = connection
        .query_row(
            "SELECT artifact_id, reference_version, committed_project_state_version,
                    transcript, language, delivery_job_id, delivery_id
             FROM project_speech_references WHERE project_id = ?1",
            [project_id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, Uuid>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<Uuid>>(5)?,
                    row.get::<_, Option<Uuid>>(6)?,
                ))
            },
        )
        .optional()?;
    raw.map(|raw| decode(project_id, raw)).transpose()
}

type RawReference = (Uuid, i64, i64, String, String, Option<Uuid>, Option<Uuid>);

fn decode(
    project_id: ProjectId,
    (artifact_id, reference_version, project_version, transcript, language, job_id, delivery_id): RawReference,
) -> Result<ProjectSpeechReference, DatabaseError> {
    validate_text(&transcript, &language)?;
    let reference_version = u64::try_from(reference_version)
        .ok()
        .filter(|version| *version > 0)
        .ok_or(DatabaseError::InvalidProjectSpeechReference)?;
    let committed_project_state_version =
        u64::try_from(project_version).map_err(|_| DatabaseError::InvalidProjectSpeechReference)?;
    if job_id.is_some() != delivery_id.is_some() {
        return Err(DatabaseError::InvalidProjectSpeechReference);
    }
    let delivery_job_id = job_id
        .map(JobId::from_uuid)
        .transpose()
        .map_err(|_| DatabaseError::InvalidProjectSpeechReference)?;
    let delivery_id = delivery_id.map(require_v7).transpose()?;
    Ok(ProjectSpeechReference {
        project_id,
        artifact_id: ArtifactId::from_uuid(artifact_id)
            .map_err(|_| DatabaseError::InvalidProjectSpeechReference)?,
        reference_version,
        committed_project_state_version,
        transcript,
        language,
        delivery_job_id,
        delivery_id,
    })
}

pub(super) fn put(
    connection: &mut Connection,
    write: &ProjectSpeechReferenceWrite,
) -> Result<ProjectSpeechReference, DatabaseError> {
    validate_write(write)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_project_version(
        &transaction,
        write.project_id,
        write.expected_project_state_version,
    )?;
    require_owned_reference_artifact(&transaction, write.project_id, write.artifact_id)?;
    if let (Some(job_id), Some(delivery_id)) = (write.delivery_job_id, write.delivery_id) {
        require_pending_transcription_delivery(
            &transaction,
            write.project_id,
            job_id,
            delivery_id,
            &write.transcript,
        )?;
    }
    let actual_reference_version: Option<i64> = transaction
        .query_row(
            "SELECT reference_version FROM project_speech_references WHERE project_id = ?1",
            [write.project_id.as_uuid()],
            |row| row.get(0),
        )
        .optional()?;
    let actual_reference_version = actual_reference_version
        .map(|value| u64::try_from(value).map_err(|_| DatabaseError::InvalidProjectSpeechReference))
        .transpose()?
        .unwrap_or(0);
    if actual_reference_version != write.expected_reference_version {
        return Err(DatabaseError::StaleProjectSpeechReference {
            project_id: write.project_id,
            expected: write.expected_reference_version,
            actual: actual_reference_version,
        });
    }
    let next_version = actual_reference_version
        .checked_add(1)
        .ok_or(DatabaseError::InvalidProjectSpeechReference)?;
    let changed = transaction.execute(
        "INSERT INTO project_speech_references(
           project_id, artifact_id, reference_version, committed_project_state_version,
           transcript, language, delivery_job_id, delivery_id, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(project_id) DO UPDATE SET
           artifact_id = excluded.artifact_id,
           reference_version = excluded.reference_version,
           committed_project_state_version = excluded.committed_project_state_version,
           transcript = excluded.transcript,
           language = excluded.language,
           delivery_job_id = excluded.delivery_job_id,
           delivery_id = excluded.delivery_id,
           updated_at_ms = excluded.updated_at_ms
         WHERE project_speech_references.reference_version = ?10",
        params![
            write.project_id.as_uuid(),
            write.artifact_id.as_uuid(),
            i64::try_from(next_version)
                .map_err(|_| DatabaseError::InvalidProjectSpeechReference)?,
            i64::try_from(write.expected_project_state_version)
                .map_err(|_| DatabaseError::InvalidProjectSpeechReference)?,
            write.transcript,
            write.language,
            write.delivery_job_id.map(JobId::into_uuid),
            write.delivery_id,
            now_ms(),
            i64::try_from(write.expected_reference_version)
                .map_err(|_| DatabaseError::InvalidProjectSpeechReference)?,
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::StaleProjectSpeechReference {
            project_id: write.project_id,
            expected: write.expected_reference_version,
            actual: actual_reference_version,
        });
    }
    let stored =
        get(&transaction, write.project_id)?.ok_or(DatabaseError::InvalidProjectSpeechReference)?;
    if stored.reference_version != next_version
        || stored.artifact_id != write.artifact_id
        || stored.transcript != write.transcript
        || stored.language != write.language
        || stored.delivery_job_id != write.delivery_job_id
        || stored.delivery_id != write.delivery_id
    {
        return Err(DatabaseError::InvalidProjectSpeechReference);
    }
    transaction.commit()?;
    Ok(stored)
}

pub(super) fn delete(
    connection: &mut Connection,
    project_id: ProjectId,
    expected_project_state_version: u64,
    expected_reference_version: u64,
) -> Result<bool, DatabaseError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_project_version(&transaction, project_id, expected_project_state_version)?;
    let actual = get(&transaction, project_id)?;
    let actual_version = actual.as_ref().map_or(0, |record| record.reference_version);
    if actual_version != expected_reference_version {
        return Err(DatabaseError::StaleProjectSpeechReference {
            project_id,
            expected: expected_reference_version,
            actual: actual_version,
        });
    }
    let changed = transaction.execute(
        "DELETE FROM project_speech_references WHERE project_id = ?1 AND reference_version = ?2",
        params![
            project_id.as_uuid(),
            i64::try_from(expected_reference_version)
                .map_err(|_| DatabaseError::InvalidProjectSpeechReference)?,
        ],
    )?;
    if changed != usize::from(actual.is_some()) {
        return Err(DatabaseError::InvalidProjectSpeechReference);
    }
    transaction.commit()?;
    Ok(changed == 1)
}

fn validate_write(write: &ProjectSpeechReferenceWrite) -> Result<(), DatabaseError> {
    validate_text(&write.transcript, &write.language)?;
    if write.delivery_job_id.is_some() != write.delivery_id.is_some() {
        return Err(DatabaseError::InvalidProjectSpeechReference);
    }
    if let Some(delivery_id) = write.delivery_id {
        require_v7(delivery_id)?;
    }
    Ok(())
}

fn validate_text(transcript: &str, language: &str) -> Result<(), DatabaseError> {
    let invalid_controls = |value: &str| {
        value.chars().any(|character| {
            character.is_control() && character != '\n' && character != '\r' && character != '\t'
        })
    };
    if transcript.len() > MAX_REFERENCE_TRANSCRIPT_BYTES
        || language.is_empty()
        || language.len() > MAX_REFERENCE_LANGUAGE_BYTES
        || invalid_controls(transcript)
        || invalid_controls(language)
    {
        return Err(DatabaseError::InvalidProjectSpeechReference);
    }
    Ok(())
}

fn require_project_version(
    connection: &Connection,
    project_id: ProjectId,
    expected: u64,
) -> Result<(), DatabaseError> {
    let actual: Option<i64> = connection
        .query_row(
            "SELECT state_version FROM projects WHERE id = ?1",
            [project_id.as_uuid()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(actual) = actual else {
        return Err(DatabaseError::ProjectNotFound(project_id));
    };
    let actual = u64::try_from(actual).map_err(|_| DatabaseError::InvalidProjectSpeechReference)?;
    if actual != expected {
        return Err(DatabaseError::StaleProjectVersion {
            project_id,
            expected,
            actual,
        });
    }
    Ok(())
}

fn require_owned_reference_artifact(
    connection: &Connection,
    project_id: ProjectId,
    artifact_id: ArtifactId,
) -> Result<(), DatabaseError> {
    let expected_kind = format!("{REFERENCE_KIND_PREFIX}{project_id}");
    let valid: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM artifacts
           WHERE id = ?1 AND project_id = ?2 AND kind = ?3 AND state = 'ready'
         )",
        params![artifact_id.as_uuid(), project_id.as_uuid(), expected_kind],
        |row| row.get(0),
    )?;
    valid
        .then_some(())
        .ok_or(DatabaseError::InvalidProjectSpeechReference)
}

fn require_pending_transcription_delivery(
    connection: &Connection,
    project_id: ProjectId,
    job_id: JobId,
    delivery_id: Uuid,
    transcript: &str,
) -> Result<(), DatabaseError> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT delivery.payload_json
             FROM job_result_deliveries AS delivery
             JOIN jobs AS job ON job.id = delivery.job_id
             WHERE delivery.job_id = ?1
               AND delivery.delivery_id = ?2
               AND delivery.kind = 'geminiText'
               AND delivery.project_id = ?3
               AND delivery.acknowledged_at_ms IS NULL
               AND job.kind = 'transcribe'
               AND job.state = 'succeeded'",
            params![job_id.as_uuid(), delivery_id, project_id.as_uuid()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(payload) = payload else {
        return Err(DatabaseError::InvalidProjectSpeechReference);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&payload).map_err(|_| DatabaseError::InvalidProjectSpeechReference)?;
    let exact = payload.as_object().is_some_and(|object| {
        object.len() == 3
            && object
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                == Some(1)
            && object.get("usage").is_some()
            && object
                .get("text")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|text| text.trim() == transcript)
    });
    exact
        .then_some(())
        .ok_or(DatabaseError::InvalidProjectSpeechReference)
}

fn require_v7(value: Uuid) -> Result<Uuid, DatabaseError> {
    if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122 {
        Ok(value)
    } else {
        Err(DatabaseError::InvalidProjectSpeechReference)
    }
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
mod tests {
    use std::fs;
    use std::sync::Arc;

    use osg_application::JobRegistry;
    use osg_domain::{JobKind, JobUpdate, ProjectMetadata};
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::storage::{
        ArtifactDraft, ArtifactKind, ArtifactRegistration, ContentHash, Database,
        JobResultDeliveryDraft, JobResultKind,
    };

    fn database() -> (TempDir, Database) {
        let directory = TempDir::new().expect("temporary database root");
        let database =
            Database::open(directory.path().join("db/osg.sqlite3")).expect("open database");
        (directory, database)
    }

    fn project(database: &Database, name: &str) -> ProjectId {
        let metadata = ProjectMetadata::with_id(ProjectId::new(), name).expect("project metadata");
        database
            .create_project(&metadata)
            .expect("create project")
            .metadata()
            .id()
    }

    fn reference_artifact(database: &Database, project_id: ProjectId, byte: u8) -> ArtifactId {
        let bytes = [byte; 32];
        let draft = ArtifactDraft::new(
            ArtifactKind::new(format!("speechReference.{project_id}")).expect("reference kind"),
            ContentHash::digest(&bytes),
            u64::try_from(bytes.len()).expect("size"),
            json!({"format":"wav"}),
        )
        .expect("artifact draft")
        .with_project(project_id);
        let staging = match database
            .register_artifact(&draft)
            .expect("register artifact")
        {
            ArtifactRegistration::Staging(staging) => staging,
            other => panic!("unexpected registration: {other:?}"),
        };
        fs::write(staging.path(), bytes).expect("write staging bytes");
        let id = staging.record().id();
        database.mark_artifact_ready(id).expect("publish artifact");
        id
    }

    fn write(
        project_id: ProjectId,
        artifact_id: ArtifactId,
        expected_reference_version: u64,
    ) -> ProjectSpeechReferenceWrite {
        ProjectSpeechReferenceWrite {
            project_id,
            expected_project_state_version: 0,
            expected_reference_version,
            artifact_id,
            transcript: "Exact words".to_owned(),
            language: "English".to_owned(),
            delivery_job_id: None,
            delivery_id: None,
        }
    }

    #[test]
    fn project_reference_is_independent_cas_and_survives_reopen() {
        let (directory, database) = database();
        let path = directory.path().join("db/osg.sqlite3");
        let project_id = project(&database, "Reference owner");
        let artifact_id = reference_artifact(&database, project_id, 0x41);
        let first = database
            .put_project_speech_reference(&write(project_id, artifact_id, 0))
            .expect("commit first reference");
        assert_eq!(first.reference_version, 1);
        assert!(matches!(
            database.put_project_speech_reference(&write(project_id, artifact_id, 0)),
            Err(DatabaseError::StaleProjectSpeechReference { actual: 1, .. })
        ));
        drop(database);

        let reopened = Database::open(path).expect("reopen database");
        assert_eq!(
            reopened
                .get_project_speech_reference(project_id)
                .expect("read reference")
                .expect("stored reference"),
            first
        );
        assert!(
            reopened
                .delete_project_speech_reference(project_id, 0, 1)
                .expect("clear reference")
        );
        assert!(
            reopened
                .get_project_speech_reference(project_id)
                .expect("read cleared reference")
                .is_none()
        );
    }

    #[test]
    fn wrong_project_artifacts_and_stale_project_revisions_are_refused() {
        let (_directory, database) = database();
        let owner = project(&database, "Owner");
        let other = project(&database, "Other");
        let artifact = reference_artifact(&database, owner, 0x42);
        assert!(matches!(
            database.put_project_speech_reference(&write(other, artifact, 0)),
            Err(DatabaseError::InvalidProjectSpeechReference)
        ));
        let mut stale = write(owner, artifact, 0);
        stale.expected_project_state_version = 1;
        assert!(matches!(
            database.put_project_speech_reference(&stale),
            Err(DatabaseError::StaleProjectVersion { actual: 0, .. })
        ));
    }

    #[test]
    fn pending_provider_delivery_must_exactly_match_project_and_transcript() {
        let (_directory, database) = database();
        let project_id = project(&database, "Provider owner");
        let artifact_id = reference_artifact(&database, project_id, 0x43);
        let registry = JobRegistry::restore(Arc::new(database.clone())).expect("job registry");
        let queued = registry
            .register(JobKind::Transcribe)
            .expect("queue transcription");
        let job_id = queued.snapshot().id();
        registry
            .apply(job_id, JobUpdate::Start)
            .expect("start transcription");
        let delivery = JobResultDeliveryDraft::new(
            job_id,
            JobResultKind::GeminiText,
            Some(project_id),
            None,
            &json!({"schemaVersion":1,"text":"  Exact words  ","usage":null}),
        )
        .expect("delivery draft");
        registry
            .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
                store.complete_project_job_with_result(
                    sequence, snapshot, &delivery, project_id, 0, None,
                )
            })
            .expect("durable provider result");
        let mut exact = write(project_id, artifact_id, 0);
        exact.delivery_job_id = Some(job_id);
        exact.delivery_id = Some(delivery.delivery_id());
        let stored = database
            .put_project_speech_reference(&exact)
            .expect("bind exact delivery");
        assert_eq!(stored.delivery_id, Some(delivery.delivery_id()));

        let replacement = reference_artifact(&database, project_id, 0x44);
        let mut forged = write(project_id, replacement, stored.reference_version);
        forged.transcript = "Different words".to_owned();
        forged.delivery_job_id = Some(job_id);
        forged.delivery_id = Some(delivery.delivery_id());
        assert!(matches!(
            database.put_project_speech_reference(&forged),
            Err(DatabaseError::InvalidProjectSpeechReference)
        ));
    }
}
