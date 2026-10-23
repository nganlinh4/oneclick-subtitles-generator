//! Alignment validation and durable alignment results.

use super::*;

#[test]
fn alignment_validation_uses_durable_artifacts_and_bounded_native_timing() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
    let project_id = ProjectId::new();
    database
        .create_project(
            &osg_domain::ProjectMetadata::with_id(project_id, "Alignment owner").unwrap(),
        )
        .unwrap();
    let first_path = directory.path().join("first.wav");
    let second_path = directory.path().join("second.wav");
    std::fs::write(&first_path, b"RIFF-first-WAVEdata").unwrap();
    std::fs::write(&second_path, b"RIFF-second-WAVEdata").unwrap();
    let first = publish_project_durable_artifact(
        &runtime,
        &database,
        project_id,
        None,
        "narrationOutput",
        &first_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(2_000_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "test",
        },
    )
    .unwrap();
    let second = publish_project_durable_artifact(
        &runtime,
        &database,
        project_id,
        None,
        "narrationOutput",
        &second_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(800_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "test",
        },
    )
    .unwrap();
    let first_artifact_id = first.descriptor.artifact_id.clone();
    let second_artifact_id = second.descriptor.artifact_id.clone();
    std::fs::remove_file(first_path).unwrap();
    std::fs::remove_file(second_path).unwrap();

    let validated = validate_alignment_start(
        &database,
        SpeechAlignmentStartRequest {
            project_id,
            expected_project_state_version: 0,
            clips: vec![
                SpeechAlignmentClipRequest {
                    id: "first".to_owned(),
                    artifact_id: first_artifact_id,
                    start_micros: 0,
                    cue_end_micros: 1_000_000,
                },
                SpeechAlignmentClipRequest {
                    id: "second".to_owned(),
                    artifact_id: second_artifact_id,
                    start_micros: 1_000_000,
                    cue_end_micros: 2_000_000,
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(validated.project_id, project_id);
    assert_eq!(validated.stats.clip_count, 2);
    assert_eq!(validated.stats.adjusted_count, 1);
    assert_eq!(validated.clips[1].start_micros, 1_800_000);
    assert_eq!(validated.stats.rendered_duration_micros, 2_850_000);
    assert_eq!(
        format!("{:?}", validated.clips[0].input),
        "MediaInput(<redacted>)"
    );
}

#[test]
fn alignment_validation_rejects_unowned_or_cross_project_audio() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
    let project_a = ProjectId::new();
    let project_b = ProjectId::new();
    for (id, name) in [(project_a, "Project A"), (project_b, "Project B")] {
        database
            .create_project(&osg_domain::ProjectMetadata::with_id(id, name).unwrap())
            .unwrap();
    }
    let metadata = || SpeechArtifactMetadata {
        format: SpeechArtifactFormatResponse::Wav,
        duration_micros: Some(1_000_000),
        sample_rate_hz: Some(24_000),
        channels: Some(1),
        source: "alignmentOwnershipTest",
    };
    let source_a = directory.path().join("a.wav");
    let source_b = directory.path().join("b.wav");
    let source_unowned = directory.path().join("unowned.wav");
    fs::write(&source_a, b"owned by a").unwrap();
    fs::write(&source_b, b"owned by b").unwrap();
    fs::write(&source_unowned, b"unowned").unwrap();
    let artifact_a = publish_project_durable_artifact(
        &runtime,
        &database,
        project_a,
        None,
        "narrationOutput",
        &source_a,
        metadata(),
    )
    .unwrap()
    .descriptor
    .artifact_id;
    let artifact_b = publish_project_durable_artifact(
        &runtime,
        &database,
        project_b,
        None,
        "narrationOutput",
        &source_b,
        metadata(),
    )
    .unwrap()
    .descriptor
    .artifact_id;
    let unowned = publish_durable_artifact(
        &runtime,
        &database,
        None,
        "narrationOutput",
        &source_unowned,
        metadata(),
    )
    .unwrap()
    .descriptor
    .artifact_id;
    let clip = |id: &str, artifact_id: String| SpeechAlignmentClipRequest {
        id: id.to_owned(),
        artifact_id,
        start_micros: 0,
        cue_end_micros: 1_000_000,
    };

    assert!(
        validate_alignment_start(
            &database,
            SpeechAlignmentStartRequest {
                project_id: project_a,
                expected_project_state_version: 0,
                clips: vec![clip("unowned", unowned)],
            },
        )
        .is_err()
    );
    assert!(
        validate_alignment_start(
            &database,
            SpeechAlignmentStartRequest {
                project_id: project_a,
                expected_project_state_version: 0,
                clips: vec![clip("a", artifact_a), clip("b", artifact_b)],
            },
        )
        .is_err()
    );
}

#[test]
fn aligned_result_manifest_and_playback_survive_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database_directory = directory.path().join("database");
    std::fs::create_dir_all(&database_directory).unwrap();
    let database_path = database_directory.join("osg.sqlite3");
    let source = directory.path().join("aligned.m4a");
    std::fs::write(&source, b"aligned-m4a-fixture").unwrap();
    let database = Database::open(&database_path).unwrap();
    let project_id = ProjectId::new();
    database
        .create_project(&osg_domain::ProjectMetadata::with_id(project_id, "Project").unwrap())
        .unwrap();
    let authority = SpeechProjectAuthority {
        project_id,
        expected_state_version: 0,
    };
    let job_id = JobId::new();
    let published = publish_project_durable_artifact(
        &runtime,
        &database,
        project_id,
        None,
        "alignedNarration",
        &source,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::M4a,
            duration_micros: Some(3_250_000),
            sample_rate_hz: Some(48_000),
            channels: Some(2),
            source: "nativeNarrationAlignment",
        },
    )
    .unwrap();
    database
        .put_project_setting(
            ALIGNMENT_MANIFEST_SCOPE,
            &job_id.to_string(),
            &serde_json::to_value(SpeechAlignmentManifest {
                schema_version: ALIGNMENT_MANIFEST_SCHEMA_VERSION,
                project_id,
                expected_project_state_version: 0,
                result: None,
            })
            .unwrap(),
            project_id,
            0,
        )
        .unwrap();
    let expected = SpeechAlignmentResult {
        artifact: published.descriptor,
        clip_count: 3,
        adjusted_count: 1,
        requested_duration_micros: 3_000_000,
        natural_duration_micros: 3_000_000,
        rendered_duration_micros: 3_250_000,
        maximum_shift_micros: 800_000,
    };
    store_alignment_result(&database, job_id, authority, expected.clone()).unwrap();
    std::fs::remove_file(source).unwrap();
    drop(database);

    let reopened = Database::open(&database_path).unwrap();
    let restored = read_alignment_manifest(&reopened, job_id).unwrap();
    assert_eq!(restored.result, Some(expected.clone()));
    let artifact_id = parse_artifact_id(&expected.artifact.artifact_id).unwrap();
    let resolved = reopened.resolve_artifact(artifact_id).unwrap().unwrap();
    assert!(resolved.path().extension().is_none());
    let project = reopened.load_project(project_id).unwrap().unwrap();
    let changed = osg_application::ProjectSnapshot::new(
        project.metadata().clone(),
        project.state_version(),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    reopened
        .commit_project(
            &changed,
            &osg_domain::RevisionReason::new("change after alignment").unwrap(),
        )
        .unwrap();
    assert!(read_alignment_manifest(&reopened, job_id).is_err());
    let media_server = osg_media_server::MediaServer::start(std::iter::empty()).unwrap();
    let playback = register_speech_playback(
        &media_server,
        resolved.path(),
        SpeechArtifactFormatResponse::M4a,
    )
    .unwrap();
    assert_eq!(playback.mime_type, "audio/m4a");
    assert!(media_server.unregister(playback.id).unwrap());
}
