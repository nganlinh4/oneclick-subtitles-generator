//! Project narration persistence and project-bound artifact publication.

use super::*;

fn publish_project_narration_test_artifact(
    fixture: &SpeechTestFixture,
    project_id: ProjectId,
    name: &str,
) -> String {
    let source = fixture.directory.path().join(format!("{name}.wav"));
    fs::write(&source, format!("project narration artifact {name}")).unwrap();
    publish_project_durable_artifact(
        &fixture.runtime,
        &fixture.database,
        project_id,
        None,
        "narrationOutput",
        &source,
        test_artifact_metadata("projectNarrationTest"),
    )
    .unwrap()
    .descriptor
    .artifact_id
}

fn project_narration_result(
    subtitle_id: i64,
    artifact_id: String,
) -> SpeechProjectNarrationResultRequest {
    SpeechProjectNarrationResultRequest {
        subtitle_id: SpeechNarrationCueId::Number(subtitle_id),
        text: format!("Narration {subtitle_id}"),
        artifact_id,
        method: "gtts".to_owned(),
        output_index: Some(u32::try_from(subtitle_id).unwrap()),
        original_ids: vec![SpeechNarrationCueId::Number(subtitle_id)],
        start_micros: u64::try_from(subtitle_id).unwrap() * 1_000_000,
        end_micros: u64::try_from(subtitle_id + 1).unwrap() * 1_000_000,
    }
}

#[test]
fn project_narration_survives_reopen_and_becomes_inert_after_revision() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database_path = directory.path().join("project-narration.sqlite3");
    let database = Database::open(&database_path).unwrap();
    let project_id = ProjectId::new();
    let project = database
        .create_project(
            &osg_domain::ProjectMetadata::with_id(project_id, "Narration project").unwrap(),
        )
        .unwrap();
    let source = directory.path().join("narration.wav");
    fs::write(&source, b"durable project narration").unwrap();
    let artifact_id = publish_project_durable_artifact(
        &runtime,
        &database,
        project_id,
        None,
        "narrationOutput",
        &source,
        test_artifact_metadata("projectNarrationReopenTest"),
    )
    .unwrap()
    .descriptor
    .artifact_id;
    let response = put_project_narration(
        &database,
        SpeechProjectNarrationPutRequest {
            project_id,
            expected_project_state_version: project.state_version(),
            source: SpeechNarrationSource::Original,
            results: vec![project_narration_result(1, artifact_id.clone())],
        },
    )
    .unwrap();
    assert_eq!(response.project_id, project_id);
    assert_eq!(response.project_state_version, project.state_version());
    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].artifact.artifact_id, artifact_id);
    put_project_narration(
        &database,
        SpeechProjectNarrationPutRequest {
            project_id,
            expected_project_state_version: project.state_version(),
            source: SpeechNarrationSource::Translated,
            results: vec![project_narration_result(2, artifact_id)],
        },
    )
    .unwrap();
    drop(database);

    let reopened = Database::open(&database_path).unwrap();
    let restored = get_project_narration(&reopened, project_id, SpeechNarrationSource::Original)
        .unwrap()
        .unwrap();
    assert_eq!(restored.source, SpeechNarrationSource::Original);
    assert_eq!(restored.results.len(), 1);
    let translated =
        get_project_narration(&reopened, project_id, SpeechNarrationSource::Translated)
            .unwrap()
            .unwrap();
    assert_eq!(translated.results.len(), 1);
    assert_eq!(
        translated.results[0].subtitle_id,
        SpeechNarrationCueId::Number(2)
    );
    let current = reopened.load_project(project_id).unwrap().unwrap();
    commit_empty_project_revision(&reopened, &current, "invalidate narration");
    assert!(
        get_project_narration(&reopened, project_id, SpeechNarrationSource::Original)
            .unwrap()
            .is_none()
    );
}

#[test]
fn project_narration_rejects_stale_cross_project_and_duplicate_writes_atomically() {
    let fixture = SpeechTestFixture::new();
    let project_a = ProjectId::new();
    let project_b = ProjectId::new();
    let snapshot_a = fixture
        .database
        .create_project(&osg_domain::ProjectMetadata::with_id(project_a, "Project A").unwrap())
        .unwrap();
    fixture
        .database
        .create_project(&osg_domain::ProjectMetadata::with_id(project_b, "Project B").unwrap())
        .unwrap();
    let artifact_a = publish_project_narration_test_artifact(&fixture, project_a, "project-a");
    let artifact_b = publish_project_narration_test_artifact(&fixture, project_b, "project-b");
    put_project_narration(
        &fixture.database,
        SpeechProjectNarrationPutRequest {
            project_id: project_a,
            expected_project_state_version: snapshot_a.state_version(),
            source: SpeechNarrationSource::Original,
            results: vec![project_narration_result(1, artifact_a.clone())],
        },
    )
    .unwrap();
    let before = fixture
        .database
        .get_setting(
            PROJECT_NARRATION_SCOPE,
            &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
        )
        .unwrap();

    assert!(
        put_project_narration(
            &fixture.database,
            SpeechProjectNarrationPutRequest {
                project_id: project_a,
                expected_project_state_version: snapshot_a.state_version(),
                source: SpeechNarrationSource::Translated,
                results: vec![project_narration_result(2, artifact_b)],
            },
        )
        .is_err()
    );
    assert_eq!(
        fixture
            .database
            .get_setting(
                PROJECT_NARRATION_SCOPE,
                &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
            )
            .unwrap(),
        before
    );

    assert!(
        put_project_narration(
            &fixture.database,
            SpeechProjectNarrationPutRequest {
                project_id: project_a,
                expected_project_state_version: snapshot_a.state_version(),
                source: SpeechNarrationSource::Grouped,
                results: vec![
                    project_narration_result(2, artifact_a.clone()),
                    project_narration_result(2, artifact_a),
                ],
            },
        )
        .is_err()
    );
    assert_eq!(
        fixture
            .database
            .get_setting(
                PROJECT_NARRATION_SCOPE,
                &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
            )
            .unwrap(),
        before
    );

    commit_empty_project_revision(&fixture.database, &snapshot_a, "stale write");
    assert!(
        put_project_narration(
            &fixture.database,
            SpeechProjectNarrationPutRequest {
                project_id: project_a,
                expected_project_state_version: snapshot_a.state_version(),
                source: SpeechNarrationSource::Original,
                results: Vec::new(),
            },
        )
        .is_err()
    );
    assert_eq!(
        fixture
            .database
            .get_setting(
                PROJECT_NARRATION_SCOPE,
                &project_narration_storage_key(project_a, SpeechNarrationSource::Original),
            )
            .unwrap(),
        before
    );
}

#[test]
fn project_narration_refuses_malformed_current_storage() {
    let fixture = SpeechTestFixture::new();
    let project_id = ProjectId::new();
    fixture
        .database
        .create_project(
            &osg_domain::ProjectMetadata::with_id(project_id, "Corrupt narration").unwrap(),
        )
        .unwrap();
    fixture
        .database
        .put_setting(
            PROJECT_NARRATION_SCOPE,
            &project_narration_storage_key(project_id, SpeechNarrationSource::Original),
            &serde_json::json!({
                "schemaVersion": PROJECT_NARRATION_SCHEMA_VERSION,
                "projectId": project_id,
                "projectStateVersion": 0,
                "source": "original",
                "results": [{
                    "subtitleId": 1,
                    "text": "bad timing",
                    "artifactId": "not-an-artifact",
                    "method": "gtts",
                    "outputIndex": 0,
                    "originalIds": [1],
                    "startMicros": 2,
                    "endMicros": 1
                }]
            }),
        )
        .unwrap();
    assert!(
        get_project_narration(
            &fixture.database,
            project_id,
            SpeechNarrationSource::Original,
        )
        .is_err()
    );
}

#[test]
fn completed_narration_artifact_is_bound_to_its_project() {
    let fixture = SpeechTestFixture::new();
    let backend = SpeechBackendRequest::Gtts;
    let lifecycle = fixture.enable(backend);
    let project_id = ProjectId::new();
    let metadata = osg_domain::ProjectMetadata::with_id(project_id, "Narration owner").unwrap();
    let project = fixture.database.create_project(&metadata).unwrap();
    let ownership = SpeechLifecycleOwnership::capture_project(
        &fixture.runtime,
        backend,
        lifecycle.lifecycle_epoch,
        project_id,
        project.state_version(),
    )
    .unwrap();
    let job_id = fixture.registered_running_job();
    initialize_manifest_with_hook(
        &fixture.runtime,
        &ownership,
        &fixture.database,
        job_id,
        || {},
    )
    .unwrap();
    let source = fixture.directory.path().join("project-owned.wav");
    fs::write(&source, b"project-owned narration").unwrap();

    let result = commit_completed_speech_source(
        &fixture.runtime,
        &ownership,
        &fixture.database,
        &source,
        test_artifact_metadata("projectOwnershipTest"),
        Some(project_id),
        job_id,
        "one".to_owned(),
        "narrationOutput",
        |_| {},
    )
    .unwrap();
    let StoredSpeechResult::Completed { artifact, .. } = result else {
        panic!("completed speech was not published");
    };
    let artifact_id = parse_artifact_id(&artifact.artifact_id).unwrap();
    let stored = fixture
        .database
        .resolve_artifact(artifact_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.record().project_id(), Some(project_id));
    let manifest = read_manifest(&fixture.database, job_id).unwrap();
    assert_eq!(manifest.project_id, Some(project_id));
    assert_eq!(
        manifest.expected_project_state_version,
        Some(project.state_version())
    );
}

#[test]
fn project_change_after_artifact_copy_rolls_back_publication_and_terminal_success() {
    let fixture = SpeechTestFixture::new();
    let backend = SpeechBackendRequest::Gtts;
    let lifecycle = fixture.enable(backend);
    let project_id = ProjectId::new();
    let metadata =
        osg_domain::ProjectMetadata::with_id(project_id, "Revision-bound narration").unwrap();
    let project = fixture.database.create_project(&metadata).unwrap();
    let ownership = SpeechLifecycleOwnership::capture_project(
        &fixture.runtime,
        backend,
        lifecycle.lifecycle_epoch,
        project_id,
        project.state_version(),
    )
    .unwrap();
    let job_id = fixture.registered_running_job();
    initialize_manifest_with_hook(
        &fixture.runtime,
        &ownership,
        &fixture.database,
        job_id,
        || {},
    )
    .unwrap();
    let source = fixture.directory.path().join("stale-project.wav");
    fs::write(&source, b"stale project narration").unwrap();
    let published_id = std::cell::Cell::new(None);

    let result = commit_completed_speech_source_with_hook(
        &fixture.runtime,
        &ownership,
        &fixture.database,
        &source,
        test_artifact_metadata("staleProjectTest"),
        Some(project_id),
        job_id,
        "one".to_owned(),
        "narrationOutput",
        |published| {
            assert!(published.created);
            published_id.set(Some(published.id));
            commit_empty_project_revision(&fixture.database, &project, "concurrent narration edit");
        },
        |_| panic!("a stale narration result was published"),
    );

    assert_eq!(result.unwrap_err(), SpeechFailureCode::ProjectChanged);
    assert!(
        fixture
            .database
            .resolve_artifact(published_id.get().unwrap())
            .unwrap()
            .is_none()
    );
    assert!(
        read_manifest(&fixture.database, job_id)
            .unwrap()
            .results
            .is_empty()
    );
    assert_eq!(
        ownership
            .commit_manifest_result(
                &fixture.runtime,
                &fixture.database,
                job_id,
                StoredSpeechResult::Failed {
                    segment_id: "late".to_owned(),
                    code: SpeechFailureCode::SynthesisFailed,
                    retryable: true,
                },
            )
            .unwrap_err(),
        SpeechFailureCode::ProjectChanged
    );
    assert!(
        read_manifest(&fixture.database, job_id)
            .unwrap()
            .results
            .is_empty()
    );
    assert_eq!(
        ownership
            .commit_job_success(&fixture.runtime, &fixture.jobs, job_id)
            .unwrap_err(),
        SpeechFailureCode::ProjectChanged
    );
    assert_eq!(
        fixture.jobs.get(job_id).unwrap().snapshot().state(),
        JobState::Running
    );
}
