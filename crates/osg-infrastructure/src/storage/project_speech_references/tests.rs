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
    let database = Database::open(directory.path().join("db/osg.sqlite3")).expect("open database");
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
