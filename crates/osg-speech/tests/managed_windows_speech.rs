#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, OperationProgress, RemovalOutcome,
    SpeechPackageId, SpeechPackageManager, SpeechRuntimeCoordinator,
};
use osg_speech::{
    AudioAsset, ChatterboxSettings, EdgeSettings, F5Settings, GeminiSettings, GttsDomain,
    GttsSettings, LanguageTag, LazySpeechWorker, ModelId, RunControl, SecretValue, SegmentId,
    SpeechBackend, SpeechOutput, SpeechPhase, SpeechProgress, SpeechText, SynthesisRequest,
    SynthesisSettings, VoiceId, WorkerProgram,
};

#[derive(Debug, Default)]
struct IdleCoordinator;

impl SpeechRuntimeCoordinator for IdleCoordinator {
    fn quiesce(&self, _: SpeechPackageId) -> osg_engine_packages::Result<()> {
        Ok(())
    }
}

fn selected_backend() -> (SpeechPackageId, SpeechBackend) {
    match std::env::var("OSG_REAL_SPEECH_BACKEND")
        .unwrap_or_else(|_| "edge-tts".to_owned())
        .as_str()
    {
        "f5-tts" => (SpeechPackageId::F5Tts, SpeechBackend::F5Tts),
        "chatterbox" => (SpeechPackageId::Chatterbox, SpeechBackend::Chatterbox),
        "edge-tts" => (SpeechPackageId::EdgeTts, SpeechBackend::EdgeTts),
        "gtts" => (SpeechPackageId::Gtts, SpeechBackend::Gtts),
        "gemini-tts" => (SpeechPackageId::GeminiTts, SpeechBackend::GeminiLive),
        _ => panic!("OSG_REAL_SPEECH_BACKEND must select a reviewed speech package"),
    }
}

fn package_root() -> (Option<tempfile::TempDir>, PathBuf) {
    if let Some(configured) = std::env::var_os("OSG_REAL_SPEECH_STORE") {
        let root = PathBuf::from(configured);
        std::fs::create_dir_all(&root).expect("persistent speech store");
        return (
            None,
            std::fs::canonicalize(root).expect("canonical speech store"),
        );
    }
    let temporary = tempfile::tempdir().expect("temporary speech store");
    let root = temporary.path().to_owned();
    (Some(temporary), root)
}

fn worker() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("worker/osg_speech_worker.py")
}

fn reference_audio() -> AudioAsset {
    let path = std::env::var_os("OSG_REAL_SPEECH_REFERENCE")
        .map(PathBuf::from)
        .expect("OSG_REAL_SPEECH_REFERENCE must point to bounded reference WAV audio");
    AudioAsset::from_native_file(&path).expect("validated speech reference")
}

fn synthesis_request(package: SpeechPackageId) -> SynthesisRequest {
    let settings = match package {
        SpeechPackageId::F5Tts => SynthesisSettings::F5Tts(
            F5Settings::new(SpeechText::new("This is a reference voice sample.").unwrap())
                .with_nfe_steps(8)
                .unwrap(),
        ),
        SpeechPackageId::Chatterbox => SynthesisSettings::Chatterbox(
            ChatterboxSettings::new(LanguageTag::new("en").unwrap(), 500, 500).unwrap(),
        ),
        SpeechPackageId::EdgeTts => SynthesisSettings::EdgeTts(
            EdgeSettings::new(VoiceId::new("en-US-AriaNeural").unwrap(), 0, 0, 0).unwrap(),
        ),
        SpeechPackageId::Gtts => SynthesisSettings::Gtts(GttsSettings::new(
            LanguageTag::new("en").unwrap(),
            GttsDomain::Com,
            false,
        )),
        SpeechPackageId::GeminiTts => SynthesisSettings::GeminiLive(GeminiSettings::new(
            ModelId::new("gemini-3.1-flash-live-preview").unwrap(),
            VoiceId::new("Aoede").unwrap(),
            LanguageTag::new("en-US").unwrap(),
        )),
    };
    let reference = package.requires_model().then(reference_audio);
    SynthesisRequest::new(
        SegmentId::new("managed-speech-smoke").unwrap(),
        SpeechText::new("The managed speech runtime is working correctly.").unwrap(),
        settings,
        reference,
    )
    .unwrap()
}

#[test]
#[ignore = "downloads one selected managed speech package and synthesizes real audio"]
fn published_selected_backend_synthesizes_and_removes() {
    let (_temporary, root) = package_root();
    let (package, backend) = selected_backend();
    let manager = SpeechPackageManager::new(&root, Arc::new(IdleCoordinator))
        .expect("speech package manager");
    let package_progress = |_progress: OperationProgress| {};
    manager
        .install(
            package,
            &PackageCancellationToken::default(),
            &package_progress,
        )
        .expect("managed speech install");
    let installed = manager
        .resolve_for_launch(package, &PackageCancellationToken::default())
        .expect("managed speech runtime lease");
    let program =
        WorkerProgram::managed_bootstrap(installed.python(), &worker(), installed.model())
            .expect("managed speech worker");
    let mut speech_worker = LazySpeechWorker::new(program, backend);
    if package == SpeechPackageId::GeminiTts {
        let secret = std::env::var("GEMINI_API_KEY")
            .expect("GEMINI_API_KEY is required for the real Gemini speech smoke");
        speech_worker = speech_worker.with_provider_secret(SecretValue::new(secret).unwrap());
    }
    let output_root = tempfile::tempdir().expect("speech output directory");
    let request = synthesis_request(package);
    let output = SpeechOutput::from_native_directory(
        output_root.path(),
        "managed-speech-smoke",
        request.output_format(),
    )
    .unwrap();
    let phases = Arc::new(Mutex::new(Vec::<SpeechPhase>::new()));
    let captured = Arc::clone(&phases);
    let control = RunControl::new(Duration::from_mins(30))
        .unwrap()
        .with_progress(move |progress: &SpeechProgress| {
            captured.lock().unwrap().push(progress.phase());
        });
    let artifact = speech_worker
        .synthesize(&request, &output, &control)
        .expect("real managed speech synthesis");
    assert!(artifact.native_path().is_file());
    assert!(artifact.summary().bytes() > 44);
    assert!(artifact.summary().duration().get() > 0);
    let phases = phases.lock().unwrap();
    assert!(phases.contains(&SpeechPhase::Synthesizing));
    assert!(phases.contains(&SpeechPhase::Publishing));
    drop(phases);
    speech_worker.shutdown();
    drop(speech_worker);
    drop(installed);
    assert_eq!(
        manager
            .remove(
                package,
                &PackageCancellationToken::default(),
                &package_progress,
            )
            .expect("managed speech removal"),
        RemovalOutcome::Removed
    );
}
