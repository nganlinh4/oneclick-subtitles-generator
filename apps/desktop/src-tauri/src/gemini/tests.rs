use std::{fs, sync::Arc};

use osg_application::{JobRegistry, ProjectSnapshot};
use osg_domain::{
    JobKind, JobState, JobUpdate, MediaAsset, MediaKind, ProjectMetadata, RevisionReason,
};
use osg_infrastructure::storage::Database;
use serde_json::json;
use tauri::ipc::Channel;

use super::request::{
    EmptySpeechPolicy, GeminiJobEvent, GeminiOutput, GeminiProjectAuthority, GeminiStartRequest,
    GeminiTask,
};
use super::run::{gemini_result_delivery, send_chunk_advisory};
use super::verify_project_authority;

#[test]
fn a_closed_webview_channel_does_not_abort_gemini_result_collection() {
    let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
    let mut channel_open = true;
    send_chunk_advisory(
        &channel,
        &mut channel_open,
        osg_domain::JobId::new(),
        "result text".to_owned(),
    );
    assert!(!channel_open);

    // Once transport closes, further chunks are deliberately ignored instead of re-sent or
    // converted into provider cancellation. The producer can finish and publish its outbox.
    send_chunk_advisory(
        &channel,
        &mut channel_open,
        osg_domain::JobId::new(),
        "more text".to_owned(),
    );
    assert!(!channel_open);
}

#[test]
fn tasks_map_to_their_durable_job_kinds() {
    assert_eq!(
        GeminiTask::Transcribe.job_kind(),
        osg_domain::JobKind::Transcribe
    );
    assert_eq!(
        GeminiTask::Translate.job_kind(),
        osg_domain::JobKind::Translate
    );
    assert_eq!(
        GeminiTask::AnalyzeSubtitles.job_kind(),
        osg_domain::JobKind::AnalyzeSubtitles
    );
    assert_eq!(GeminiTask::Transcribe.diagnostic_name(), "transcribe");
    assert_eq!(GeminiTask::Translate.diagnostic_name(), "translate");
    assert_eq!(
        GeminiTask::AnalyzeSubtitles.diagnostic_name(),
        "analyzeSubtitles"
    );
}

#[test]
fn streamed_chunk_uses_the_frontend_camel_case_contract() {
    let job_id = osg_domain::JobId::new();
    let value = serde_json::to_value(GeminiJobEvent::Chunk {
        job_id,
        text: "bounded".to_owned(),
    })
    .expect("event serializes");

    assert_eq!(
        value,
        json!({
            "event": "chunk",
            "jobId": job_id,
            "text": "bounded"
        })
    );
    assert!(value.get("job_id").is_none());
}

#[test]
fn start_request_rejects_blank_prompt_and_unknown_fields() {
    let credential_id = osg_infrastructure::secrets::CredentialId::new();
    let blank = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "transcribe",
        "model": "gemini-3.5-flash-lite",
        "prompt": "   ",
        "mediaAssetId": osg_domain::AssetId::new()
    }))
    .expect("shape is valid");
    assert!(blank.validate().is_err());

    let missing_media = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "transcribe",
        "model": "gemini-3.5-flash-lite",
        "prompt": "transcribe"
    }))
    .expect("optional media ID has a valid wire shape");
    assert!(missing_media.validate().is_err());

    let unsupported_thinking = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "transcribe",
        "model": "gemini-3.7-flash",
        "prompt": "transcribe",
        "mediaAssetId": osg_domain::AssetId::new(),
        "thinkingLevel": "MINIMAL"
    }))
    .expect("the provider-rejected level has a valid wire shape");
    assert!(unsupported_thinking.validate().is_err());

    let supported_thinking = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "transcribe",
        "model": "gemini-3.7-flash",
        "prompt": "transcribe",
        "mediaAssetId": osg_domain::AssetId::new(),
        "thinkingLevel": "LOW"
    }))
    .expect("the verified level has a valid wire shape");
    assert!(supported_thinking.validate().is_ok());

    assert!(
        serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "transcribe",
            "model": "gemini-3.5-flash-lite",
            "prompt": "transcribe",
            "temperature": 0.7
        }))
        .is_err()
    );

    let speech_only = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "transcribe",
        "model": "gemini-3.5-flash-lite",
        "prompt": "transcribe",
        "mediaAssetId": osg_domain::AssetId::new(),
        "emptySpeechPolicy": "provenSilence"
    }))
    .expect("the explicit speech-only policy has a valid wire shape");
    assert_eq!(
        speech_only.empty_speech_policy,
        Some(EmptySpeechPolicy::ProvenSilence)
    );
    assert!(speech_only.validate().is_ok());

    let non_transcription = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "translate",
        "model": "gemini-3.5-flash-lite",
        "prompt": "translate",
        "emptySpeechPolicy": "provenSilence"
    }))
    .expect("the policy is rejected semantically rather than by shape");
    assert!(non_transcription.validate().is_err());

    let custom_text = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "translate",
        "model": "gemini-custom-contract-test",
        "prompt": "translate"
    }))
    .expect("a bounded custom model ID has a valid wire shape");
    assert!(custom_text.model.is_custom());
    assert!(custom_text.validate().is_ok());

    let custom_media = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "transcribe",
        "model": "gemini-custom-contract-test",
        "prompt": "transcribe",
        "mediaAssetId": osg_domain::AssetId::new()
    }))
    .expect("custom media is rejected semantically");
    assert!(custom_media.validate().is_err());

    assert!(
        serde_json::from_value::<GeminiStartRequest>(json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "models/gemini-3.8-flash",
            "prompt": "translate"
        }))
        .is_err()
    );
}

#[test]
fn project_ownership_is_an_inseparable_exact_revision_pair() {
    let credential_id = osg_infrastructure::secrets::CredentialId::new();
    let project_id = osg_domain::ProjectId::new();
    let owned = serde_json::from_value::<GeminiStartRequest>(json!({
        "credentialId": credential_id,
        "task": "translate",
        "model": "gemini-3.5-flash-lite",
        "prompt": "translate",
        "projectId": project_id,
        "expectedProjectStateVersion": 7
    }))
    .expect("owned request shape");
    assert!(owned.validate().is_ok());
    assert_eq!(
        owned.project_authority(),
        Some(GeminiProjectAuthority {
            project_id,
            expected_state_version: 7,
        })
    );

    for invalid in [
        json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "gemini-3.5-flash-lite",
            "prompt": "translate",
            "projectId": project_id
        }),
        json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "gemini-3.5-flash-lite",
            "prompt": "translate",
            "expectedProjectStateVersion": 7
        }),
        json!({
            "credentialId": credential_id,
            "task": "translate",
            "model": "gemini-3.5-flash-lite",
            "prompt": "translate",
            "projectId": project_id,
            "expectedProjectStateVersion": u64::MAX
        }),
    ] {
        let request = serde_json::from_value::<GeminiStartRequest>(invalid)
            .expect("invalid authority still has a valid wire shape");
        assert!(request.validate().is_err());
    }
}

#[test]
fn project_authority_rejects_stale_and_cross_project_media() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("db.sqlite3")).expect("database");
    let media_path = directory.path().join("owned.mp4");
    fs::write(&media_path, vec![0x45; 32 * 1024]).expect("media fixture");
    let asset =
        MediaAsset::new("owned.mp4", "mp4", 32 * 1024, MediaKind::Video).expect("media asset");
    database
        .remember_media(&asset, &media_path)
        .expect("remember media");

    let owner = ProjectMetadata::new("owner").expect("owner metadata");
    let base = database.create_project(&owner).expect("create owner");
    let attached = ProjectSnapshot::new(
        owner.clone(),
        base.state_version(),
        vec![asset.clone()],
        Vec::new(),
    )
    .expect("project snapshot");
    let commit = database
        .commit_project(
            &attached,
            &RevisionReason::new("attach media").expect("revision reason"),
        )
        .expect("attach media");
    let authority = GeminiProjectAuthority {
        project_id: owner.id(),
        expected_state_version: commit.state_version,
    };
    verify_project_authority(&database, Some(authority), Some(asset.id()))
        .expect("current owner authorizes media");

    let stale = verify_project_authority(
        &database,
        Some(GeminiProjectAuthority {
            expected_state_version: commit.state_version - 1,
            ..authority
        }),
        Some(asset.id()),
    )
    .expect_err("stale revision");
    assert_eq!(stale.code(), "staleProjectVersion");

    let other = ProjectMetadata::new("other").expect("other metadata");
    let other_snapshot = database.create_project(&other).expect("create other");
    let cross_project = verify_project_authority(
        &database,
        Some(GeminiProjectAuthority {
            project_id: other.id(),
            expected_state_version: other_snapshot.state_version(),
        }),
        Some(asset.id()),
    )
    .expect_err("cross-project media");
    assert_eq!(cross_project.code(), "mediaUnavailable");
}

#[test]
fn gemini_delivery_persists_its_project_owner() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("db.sqlite3")).expect("database");
    let registry = JobRegistry::restore(Arc::new(database.clone())).expect("registry");
    let queued = registry.register(JobKind::Translate).expect("job");
    let job_id = queued.snapshot().id();
    registry.apply(job_id, JobUpdate::Start).expect("start");
    let project = ProjectMetadata::new("delivery owner").expect("project metadata");
    let project_snapshot = database.create_project(&project).expect("create project");
    let project_id = project.id();
    let draft = gemini_result_delivery(
        job_id,
        GeminiTask::Translate,
        Some(GeminiProjectAuthority {
            project_id,
            expected_state_version: project_snapshot.state_version(),
        }),
        None,
        Some(&"a".repeat(64)),
        &GeminiOutput {
            text: "translated".to_owned(),
            usage: None,
            chunk_count: 1,
        },
    )
    .expect("delivery");
    registry
        .apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
            store.complete_project_job_with_result(
                sequence,
                snapshot,
                &draft,
                project_id,
                project_snapshot.state_version(),
                None,
            )
        })
        .expect("persist result");

    let delivery = database
        .claim_job_result(job_id)
        .expect("claim")
        .expect("delivery");
    assert_eq!(delivery.project_id, Some(project_id));
    assert_eq!(delivery.payload["schemaVersion"], 2);
    assert_eq!(delivery.payload["task"], "translate");
    assert_eq!(
        delivery.payload["expectedProjectStateVersion"],
        project_snapshot.state_version()
    );
    assert_eq!(delivery.payload["recoveryKey"], "a".repeat(64));
}

#[test]
fn stale_project_rolls_back_terminal_success_and_outbox_together() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("db.sqlite3")).expect("database");
    let registry = JobRegistry::restore(Arc::new(database.clone())).expect("registry");
    let queued = registry.register(JobKind::Translate).expect("job");
    let job_id = queued.snapshot().id();
    registry.apply(job_id, JobUpdate::Start).expect("start");
    let project = ProjectMetadata::new("stale owner").expect("project metadata");
    let original = database.create_project(&project).expect("create project");
    let authority = GeminiProjectAuthority {
        project_id: project.id(),
        expected_state_version: original.state_version(),
    };
    let changed = ProjectSnapshot::new(project, original.state_version(), Vec::new(), Vec::new())
        .expect("changed snapshot");
    database
        .commit_project(
            &changed,
            &RevisionReason::new("concurrent change").expect("reason"),
        )
        .expect("change project");
    let draft = gemini_result_delivery(
        job_id,
        GeminiTask::Translate,
        Some(authority),
        None,
        None,
        &GeminiOutput {
            text: "must not publish".to_owned(),
            usage: None,
            chunk_count: 1,
        },
    )
    .expect("delivery");

    let result =
        registry.apply_with_store(job_id, JobUpdate::Succeed, |store, sequence, snapshot| {
            store.complete_project_job_with_result(
                sequence,
                snapshot,
                &draft,
                authority.project_id,
                authority.expected_state_version,
                None,
            )
        });
    assert!(result.is_err());
    assert_eq!(
        registry
            .get(job_id)
            .expect("job remains")
            .snapshot()
            .state(),
        JobState::Running
    );
    assert!(database.claim_job_result(job_id).expect("claim").is_none());
}
