//! Voice-conversion job execution and result publication.

use std::sync::Arc;

use osg_domain::JobId;
use osg_infrastructure::storage::Database;
use osg_speech::{
    AudioAsset, AudioFormat, RunControl, SpeechArtifact, SpeechOutput, SpeechProgress,
    VoiceConversionRequest,
};
use tauri::ipc::Channel;

use super::SPEECH_TIMEOUT;
use super::artifacts::{SpeechArtifactMetadata, commit_completed_speech_source};
use super::jobs::{
    SpeechFailureCode, SpeechJobEvent, StoredSpeechResult, failure_marks_backend_unhealthy,
    speech_failure,
};
use super::lifecycle::{SpeechLifecycleOwnership, worker_join_result};
use super::requests::SpeechBackendRequest;
use super::runtime::{ManagedSpeechWorker, SpeechRuntime};

async fn resolve_voice_conversion_worker(
    runtime: &SpeechRuntime,
    lifecycle_epoch: u64,
) -> Result<Arc<ManagedSpeechWorker>, SpeechFailureCode> {
    let worker_runtime = runtime.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        worker_runtime.enabled_worker_for_epoch(SpeechBackendRequest::Chatterbox, lifecycle_epoch)
    })
    .await;
    let resolved = worker_join_result(
        runtime,
        SpeechBackendRequest::Chatterbox,
        lifecycle_epoch,
        joined,
    )?;
    resolved.map_err(|error| {
        let code = speech_failure(&error).0;
        if failure_marks_backend_unhealthy(code) {
            let _ = runtime.invalidate_backend_runtime(
                SpeechBackendRequest::Chatterbox,
                Some(lifecycle_epoch),
            );
        }
        code
    })
}

async fn publish_voice_conversion_result(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    artifact: SpeechArtifact,
    job_id: JobId,
    channel: &Channel<SpeechJobEvent>,
) -> Result<StoredSpeechResult, SpeechFailureCode> {
    let publication_runtime = runtime.clone();
    let publication_ownership = ownership.clone();
    let artifact_database = database.clone();
    let completion_channel = channel.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        commit_completed_speech_source(
            &publication_runtime,
            &publication_ownership,
            &artifact_database,
            artifact.native_path(),
            SpeechArtifactMetadata::from_summary(artifact.summary()),
            None,
            job_id,
            "voice-conversion".to_owned(),
            "voiceConversion",
            |result| {
                let _ = completion_channel.send(SpeechJobEvent::SegmentCompleted {
                    job_id,
                    index: 1,
                    total: 1,
                    result: result.clone(),
                });
            },
        )
    })
    .await;
    worker_join_result(
        runtime,
        ownership.backend,
        ownership.lifecycle_epoch,
        joined,
    )?
}

pub(super) async fn run_voice_conversion(
    runtime: &SpeechRuntime,
    database: &Database,
    input: AudioAsset,
    target: AudioAsset,
    ownership: SpeechLifecycleOwnership,
    job_id: JobId,
    channel: &Channel<SpeechJobEvent>,
) -> Result<Vec<StoredSpeechResult>, SpeechFailureCode> {
    let work = runtime
        .work_directory()
        .map_err(|_| SpeechFailureCode::RuntimeUnavailable)?;
    ownership.ensure_owned(runtime, database)?;
    let worker = resolve_voice_conversion_worker(runtime, ownership.lifecycle_epoch).await?;
    let request = VoiceConversionRequest::new(input, target);
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        "voice-conversion",
        AudioFormat::Wav,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let progress_channel = channel.clone();
    let progress_runtime = runtime.clone();
    let progress_ownership = ownership.clone();
    let worker_cancellation = ownership.cancellation.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(SPEECH_TIMEOUT)?
            .with_cancellation(worker_cancellation)
            .with_progress(move |progress: &SpeechProgress| {
                if progress_ownership.ensure_current(&progress_runtime).is_ok() {
                    let _ = progress_channel.send(SpeechJobEvent::Progress {
                        job_id,
                        segment_id: None,
                        index: 1,
                        total: 1,
                        phase: progress.phase().into(),
                        fraction_millionths: progress.fraction_millionths(),
                    });
                }
            });
        worker.convert_voice(&request, &output, &control)
    })
    .await;
    let operation = worker_join_result(
        runtime,
        SpeechBackendRequest::Chatterbox,
        ownership.lifecycle_epoch,
        joined,
    )?;
    let artifact = match operation {
        Ok(artifact) => artifact,
        Err(error) => {
            let (code, _) = speech_failure(&error);
            if failure_marks_backend_unhealthy(code) {
                let _ = runtime.invalidate_backend_runtime(
                    SpeechBackendRequest::Chatterbox,
                    Some(ownership.lifecycle_epoch),
                );
            }
            return Err(code);
        }
    };
    ownership.ensure_owned(runtime, database)?;
    let result =
        publish_voice_conversion_result(runtime, &ownership, database, artifact, job_id, channel)
            .await?;
    Ok(vec![result])
}
