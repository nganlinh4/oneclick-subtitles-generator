//! Speech artifact export.

use super::*;

#[test]
fn speech_export_resolves_opaque_artifacts_and_writes_a_bounded_archive() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
    let first_path = directory.path().join("first.wav");
    let second_path = directory.path().join("second.wav");
    fs::write(&first_path, b"first narration bytes").unwrap();
    fs::write(&second_path, b"second narration bytes").unwrap();
    let first = publish_durable_artifact(
        &runtime,
        &database,
        None,
        "narrationOutput",
        &first_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(1_000_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "test",
        },
    )
    .unwrap();
    let second = publish_durable_artifact(
        &runtime,
        &database,
        None,
        "narrationOutput",
        &second_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(1_000_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "test",
        },
    )
    .unwrap();
    let first_id = first.descriptor.artifact_id;
    let second_id = second.descriptor.artifact_id;
    let plan = prepare_speech_export(
        &database,
        SpeechArtifactExportRequest {
            entries: vec![
                SpeechArtifactExportEntry {
                    artifact_id: first_id.clone(),
                    file_name: "narration_1.wav".to_owned(),
                },
                SpeechArtifactExportEntry {
                    artifact_id: second_id.clone(),
                    file_name: "narration_2.wav".to_owned(),
                },
            ],
            archive_name: Some("narration_audio.zip".to_owned()),
        },
    )
    .unwrap();
    let destination = directory.path().join("export.zip");
    export_speech_plan(&runtime.0.staging_authority, &plan, &destination).unwrap();

    let mut archive = zip::ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    assert_eq!(archive.len(), 2);
    let mut first_bytes = Vec::new();
    archive
        .by_name("narration_1.wav")
        .unwrap()
        .read_to_end(&mut first_bytes)
        .unwrap();
    assert_eq!(first_bytes, b"first narration bytes");
    let mut second_bytes = Vec::new();
    archive
        .by_name("narration_2.wav")
        .unwrap()
        .read_to_end(&mut second_bytes)
        .unwrap();
    assert_eq!(second_bytes, b"second narration bytes");

    assert!(
        prepare_speech_export(
            &database,
            SpeechArtifactExportRequest {
                entries: vec![
                    SpeechArtifactExportEntry {
                        artifact_id: first_id,
                        file_name: "duplicate.wav".to_owned(),
                    },
                    SpeechArtifactExportEntry {
                        artifact_id: second_id,
                        file_name: "duplicate.wav".to_owned(),
                    },
                ],
                archive_name: Some("narration_audio.zip".to_owned()),
            },
        )
        .is_err()
    );
}

#[test]
fn speech_export_writes_a_verified_single_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = standalone_runtime(&directory);
    let database = Database::open(directory.path().join("osg.sqlite3")).unwrap();
    let source_path = directory.path().join("source.wav");
    fs::write(&source_path, b"single narration bytes").unwrap();
    let artifact = publish_durable_artifact(
        &runtime,
        &database,
        None,
        "narrationOutput",
        &source_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::Wav,
            duration_micros: Some(1_000_000),
            sample_rate_hz: Some(24_000),
            channels: Some(1),
            source: "test",
        },
    )
    .unwrap();
    let plan = prepare_speech_export(
        &database,
        SpeechArtifactExportRequest {
            entries: vec![SpeechArtifactExportEntry {
                artifact_id: artifact.descriptor.artifact_id,
                file_name: "narration.wav".to_owned(),
            }],
            archive_name: None,
        },
    )
    .unwrap();
    let destination = directory.path().join("narration.wav");

    export_speech_plan(&runtime.0.staging_authority, &plan, &destination).unwrap();

    assert_eq!(fs::read(destination).unwrap(), b"single narration bytes");
}

#[test]
fn speech_export_rejects_paths_duplicates_and_changed_source_bytes() {
    assert!(!is_safe_export_file_name("../private.wav", "wav"));
    assert!(!is_safe_export_file_name("C_private.wav.exe", "wav"));
    assert!(is_safe_export_file_name("aligned_narration.m4a", "m4a"));

    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.wav");
    fs::write(&source, b"changed").unwrap();
    let plan = SpeechExportPlan {
        sources: vec![SpeechExportSource {
            path: source,
            content_hash: ContentHash::digest(b"expected"),
            expected_bytes: 7,
            file_name: "narration_1.wav".to_owned(),
        }],
        archive_name: None,
    };
    let destination = directory.path().join("changed.wav");
    let authority_directory = tempfile::tempdir().unwrap();
    let authority = RuntimeStagingAuthority::prepare(authority_directory.path()).unwrap();
    assert!(export_speech_plan(&authority, &plan, &destination).is_err());
    assert!(!destination.exists());
}
