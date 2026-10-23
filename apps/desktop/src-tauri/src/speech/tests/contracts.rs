//! Request redaction and frontend-facing limits.

use super::*;

#[test]
fn request_debug_redacts_text_and_reference_capability() {
    let request = SpeechStartRequest {
        project_id: ProjectId::new(),
        expected_project_state_version: 0,
        segments: vec![SpeechSegmentRequest {
            id: "one".to_owned(),
            text: "private narration words".to_owned(),
        }],
        profile: SpeechProfileRequest::EdgeTts {
            voice: "en-US-AriaNeural".to_owned(),
            rate_percent: 0,
            volume_percent: 0,
            pitch_hz: 0,
        },
        reference_artifact_id: Some(ArtifactId::new().to_string()),
        lifecycle_epoch: 7,
    };
    let debug = format!("{request:?}");
    assert!(!debug.contains("private narration"));
    assert!(!debug.contains(request.reference_artifact_id.as_deref().unwrap()));
}

#[test]
fn alignment_request_debug_redacts_artifact_capabilities() {
    let artifact_id = ArtifactId::new().to_string();
    let project_id = ProjectId::new();
    let request = SpeechAlignmentStartRequest {
        project_id,
        expected_project_state_version: 7,
        clips: vec![SpeechAlignmentClipRequest {
            id: "segment-1".to_owned(),
            artifact_id: artifact_id.clone(),
            start_micros: 0,
            cue_end_micros: 1_000_000,
        }],
    };
    let clip_debug = format!("{:?}", request.clips[0]);
    assert!(!clip_debug.contains(&artifact_id));
    assert!(!format!("{request:?}").contains(&artifact_id));
    assert!(!format!("{request:?}").contains(&project_id.to_string()));
}

#[test]
fn export_request_debug_redacts_artifact_capabilities_and_file_names() {
    let artifact_id = ArtifactId::new().to_string();
    let request = SpeechArtifactExportRequest {
        entries: vec![SpeechArtifactExportEntry {
            artifact_id: artifact_id.clone(),
            file_name: "private_narration.wav".to_owned(),
        }],
        archive_name: None,
    };
    let debug = format!("{request:?}");
    assert!(!debug.contains(&artifact_id));
    assert!(!debug.contains("private_narration"));
    assert!(debug.contains("entry_count: 1"));
}

#[test]
fn events_and_artifact_descriptors_are_path_and_secret_free() {
    let event = SpeechJobEvent::Progress {
        job_id: JobId::new(),
        segment_id: Some("segment-1".to_owned()),
        index: 1,
        total: 2,
        phase: SpeechPhaseResponse::Synthesizing,
        fraction_millionths: 500_000,
    };
    let encoded = serde_json::to_string(&event).unwrap();
    assert!(!encoded.to_ascii_lowercase().contains("path"));
    assert!(!encoded.to_ascii_lowercase().contains("secret"));
    assert!(!encoded.contains("C:\\"));
}

#[test]
fn gemini_models_are_closed_to_the_synced_audio_catalog() {
    let valid = SpeechProfileRequest::GeminiTts {
        credential_ids: vec![CredentialId::new()],
        model: "gemini-3.1-flash-tts-preview".to_owned(),
        voice: "Aoede".to_owned(),
        language: "en-US".to_owned(),
        max_concurrency: 5,
    };
    assert_eq!(valid.max_concurrency(), 5);
    assert!(valid.into_native().is_ok());

    let invalid = SpeechProfileRequest::GeminiTts {
        credential_ids: vec![CredentialId::new()],
        model: "text-only-model".to_owned(),
        voice: "Aoede".to_owned(),
        language: "en-US".to_owned(),
        max_concurrency: 5,
    };
    assert!(invalid.into_native().is_err());
}

#[test]
fn reference_ranges_are_backend_bounded() {
    assert_eq!(SpeechReferenceBackend::F5Tts.maximum_duration_ms(), 12_000);
    assert_eq!(
        SpeechReferenceBackend::Chatterbox.maximum_duration_ms(),
        60_000
    );
}

#[test]
fn backend_text_limits_match_the_frontend_contract() {
    assert_eq!(
        SpeechBackendRequest::Chatterbox.maximum_text_characters(),
        300
    );
    for backend in [
        SpeechBackendRequest::F5Tts,
        SpeechBackendRequest::EdgeTts,
        SpeechBackendRequest::Gtts,
        SpeechBackendRequest::GeminiTts,
    ] {
        assert_eq!(backend.maximum_text_characters(), 8_000);
    }
}

#[test]
fn backend_wide_failures_stop_a_batch_without_suppressing_segment_failures() {
    for code in [
        SpeechFailureCode::InvalidRequest,
        SpeechFailureCode::RuntimeUnavailable,
        SpeechFailureCode::ModelUnavailable,
        SpeechFailureCode::ProviderUnavailable,
        SpeechFailureCode::ProviderRateLimited,
        SpeechFailureCode::AuthenticationFailed,
        SpeechFailureCode::ReferenceRejected,
        SpeechFailureCode::TimedOut,
        SpeechFailureCode::WorkerFailed,
        SpeechFailureCode::ArtifactStorage,
    ] {
        assert!(batch_terminal_failure(code));
    }
    for code in [
        SpeechFailureCode::Cancelled,
        SpeechFailureCode::SynthesisFailed,
        SpeechFailureCode::EncodingFailed,
    ] {
        assert!(!batch_terminal_failure(code));
    }
}

#[test]
fn worker_path_debug_is_redacted() {
    let paths = WorkerPaths {
        python: PathBuf::from("C:/private/python.exe"),
        bootstrap: PathBuf::from("C:/private/osg_speech_worker.py"),
        model: Some(PathBuf::from("C:/private/models")),
        model_store: Some(PathBuf::from("C:/private/variants")),
    };
    let debug = format!("{paths:?}");
    assert!(!debug.contains("private"));
    assert!(debug.contains("<redacted>"));
}
