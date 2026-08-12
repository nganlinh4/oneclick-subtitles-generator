#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_asr::{
    AsrEngineId, AsrProgress, AsrService, ModelAssets, NormalizedAudio, ProgressPhase, RunControl,
    TranscriptionOptions, TranscriptionRequest, WorkerProgram,
};
use osg_engine_packages::{
    CancellationToken, EngineId, EnginePackageManager, OperationProgress, RemovalOutcome,
    RuntimeCoordinator,
};

#[derive(Debug, Default)]
struct IdleCoordinator;

impl RuntimeCoordinator for IdleCoordinator {
    fn quiesce(&self, _: EngineId) -> osg_engine_packages::Result<()> {
        Ok(())
    }
}

fn selected_engine() -> (EngineId, AsrEngineId) {
    match std::env::var("OSG_REAL_ASR_ENGINE")
        .unwrap_or_else(|_| "parakeet".to_owned())
        .as_str()
    {
        "parakeet" => (EngineId::Parakeet, AsrEngineId::Parakeet),
        "faster-whisper-turbo" => (
            EngineId::FasterWhisperTurbo,
            AsrEngineId::FasterWhisperTurbo,
        ),
        "faster-whisper-large-v3" => (
            EngineId::FasterWhisperLargeV3,
            AsrEngineId::FasterWhisperLargeV3,
        ),
        "qwen3-asr-1.7b" => (EngineId::Qwen3Asr1_7b, AsrEngineId::Qwen3Asr1_7b),
        "qwen3-asr-0.6b" => (EngineId::Qwen3Asr0_6b, AsrEngineId::Qwen3Asr0_6b),
        _ => panic!("OSG_REAL_ASR_ENGINE must select a reviewed catalog engine"),
    }
}

fn package_root() -> (Option<tempfile::TempDir>, PathBuf) {
    if let Some(configured) = std::env::var_os("OSG_REAL_ASR_STORE") {
        let root = PathBuf::from(configured);
        std::fs::create_dir_all(&root).expect("persistent ASR store");
        return (
            None,
            std::fs::canonicalize(root).expect("canonical ASR store"),
        );
    }
    let temporary = tempfile::tempdir().expect("temporary ASR store");
    let root = temporary.path().to_owned();
    (Some(temporary), root)
}

fn audio_fixture() -> NormalizedAudio {
    let path = std::env::var_os("OSG_REAL_ASR_AUDIO")
        .map(PathBuf::from)
        .expect("OSG_REAL_ASR_AUDIO must point to a bounded 16 kHz mono PCM16 WAV");
    NormalizedAudio::open(path).expect("validated ASR audio fixture")
}

fn worker() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("worker/osg_asr_worker.py")
}

#[test]
#[ignore = "downloads one selected managed engine and runs its real offline worker"]
fn published_selected_engine_transcribes_and_removes() {
    let (_temporary, root) = package_root();
    let (package_engine, asr_engine) = selected_engine();
    let manager = EnginePackageManager::new(&root, Arc::new(IdleCoordinator))
        .expect("engine package manager");
    let package_progress = |_progress: OperationProgress| {};
    manager
        .install(
            package_engine,
            &CancellationToken::default(),
            &package_progress,
        )
        .expect("managed ASR install");
    let installed = manager
        .resolve_for_launch(package_engine, &CancellationToken::default())
        .expect("managed ASR runtime lease");
    let program = WorkerProgram::python(installed.python(), worker()).expect("managed ASR worker");
    let assets = ModelAssets::new(asr_engine, installed.model(), installed.aligner())
        .expect("managed ASR assets");
    let service = AsrService::new(program, assets);
    let request = TranscriptionRequest::new(audio_fixture(), TranscriptionOptions::default());
    let phases = Arc::new(Mutex::new(Vec::<ProgressPhase>::new()));
    let phase_capture = Arc::clone(&phases);
    let control = RunControl::new(Duration::from_mins(30))
        .expect("ASR control")
        .with_progress(move |progress: &AsrProgress| {
            phase_capture
                .lock()
                .expect("phase lock")
                .push(progress.phase);
        });
    let transcription = service
        .transcribe(&request, &control)
        .expect("real managed transcription");
    assert_eq!(transcription.engine, asr_engine);
    assert_eq!(transcription.duration_ms, request.audio().duration_ms());
    assert!(!transcription.text.trim().is_empty());
    assert!(!transcription.segments.is_empty());
    assert!(transcription.segments.iter().all(|segment| {
        !segment.text.trim().is_empty()
            && segment.start_ms < segment.end_ms
            && segment.end_ms <= transcription.duration_ms
    }));
    assert_eq!(
        *phases.lock().expect("phase results"),
        [
            ProgressPhase::ModelLoading,
            ProgressPhase::Transcribing,
            ProgressPhase::Finalizing,
        ]
    );
    service.shutdown().expect("worker shutdown");
    drop(service);
    drop(installed);
    assert_eq!(
        manager
            .remove(
                package_engine,
                &CancellationToken::default(),
                &package_progress
            )
            .expect("managed ASR removal"),
        RemovalOutcome::Removed
    );
}
