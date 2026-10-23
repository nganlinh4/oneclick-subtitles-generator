//! Request validation, metadata redaction, export names and the per-project limit.

use super::*;

#[test]
fn request_accepts_only_the_stable_model_and_requires_a_project() {
    let credential_id = osg_infrastructure::secrets::CredentialId::new();
    let reference_asset_id = osg_domain::AssetId::new();
    let project_id = ProjectId::new();
    assert!(
        serde_json::from_value::<GeminiImageStartRequest>(json!({
            "credentialId": credential_id,
            "model": "gemini-3.1-flash-image",
            "prompt": "generate",
            "referenceAssetId": reference_asset_id,
            "projectId": project_id,
        }))
        .is_ok()
    );
    assert!(
        serde_json::from_value::<GeminiImageStartRequest>(json!({
            "credentialId": credential_id,
            "model": "gemini-3.1-flash-image",
            "prompt": "generate",
            "referenceAssetId": reference_asset_id,
        }))
        .is_err()
    );
}

#[test]
fn prepared_metadata_contains_no_image_bytes_paths_or_private_prompt() {
    let mut running = JobSnapshot::new(JobKind::GenerateImage);
    running.start().expect("start");
    assert_eq!(running.state(), JobState::Running);
    let project_id = ProjectId::new();
    let playback_id = Uuid::new_v4();
    let value = serde_json::to_value(GeminiImageEvent::Prepared {
        job: running,
        image: PlayableGeneratedImage {
            artifact: GeneratedImageDescriptor {
                artifact_id: ArtifactId::new(),
                project_id,
                mime_type: "image/png",
                size_bytes: 1024,
                created_at_ms: 1,
            },
            playback: RegisteredMedia {
                id: playback_id,
                playback_url: format!(
                    "http://127.0.0.1:43210/asset/{}?token={}",
                    playback_id,
                    "a".repeat(64)
                ),
                mime_type: "image/png".to_owned(),
                byte_length: 1024,
            },
        },
    })
    .expect("serialize");
    let serialized = value.to_string();
    for forbidden in [
        "base64",
        "bytes\":\"",
        "data:image",
        "private prompt",
        "path",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
    assert_eq!(value["image"]["artifact"]["projectId"], json!(project_id));
}

#[test]
fn malformed_metadata_and_export_names_fail_closed() {
    assert!(validate_generated_image("image/png", b"not png").is_err());
    assert!(validate_generated_image("image/gif", &png(b"wrong mime")).is_err());
    assert!(is_safe_export_name("background-1.png", "png"));
    assert!(!is_safe_export_name("../background.png", "png"));
    assert!(!is_safe_export_name("background.jpg", "png"));
    assert!(!is_safe_export_name("background..png", "png"));
}

#[test]
fn project_image_limit_is_enforced_without_publishing_an_invisible_artifact() {
    let (_directory, _database_path, database, project_id, job_id) = fixture();
    succeed_job(&database, job_id);
    for index in 0..MAX_PROJECT_IMAGES {
        let prepared = publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &png(index.to_string().as_bytes()),
            write_staged_image,
        )
        .expect("within project limit");
        commit_prepared(&database, &prepared.0);
    }
    assert_eq!(
        list_generated_images(&database, project_id)
            .expect("bounded list")
            .len(),
        MAX_PROJECT_IMAGES
    );
    assert_eq!(
        publish_generated_image(
            &database,
            project_id,
            job_id,
            "image/png",
            &png(b"one too many"),
            write_staged_image,
        )
        .expect_err("project limit must fail")
        .code(),
        "invalidInput"
    );
    assert_eq!(
        list_generated_images(&database, project_id)
            .expect("unchanged list")
            .len(),
        MAX_PROJECT_IMAGES
    );
}
