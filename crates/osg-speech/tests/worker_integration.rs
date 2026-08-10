use osg_speech::{
    AudioAsset, AudioFormat, CancellationToken, ChatterboxSettings, EdgeSettings, F5Settings,
    GeminiSettings, GttsDomain, GttsSettings, LanguageTag, LazySpeechWorker, ModelId,
    ReferencePreparationPlan, RunControl, SecretValue, SegmentId, SpeechBackend, SpeechError,
    SpeechOutput, SpeechPhase, SpeechProgress, SpeechText, SynthesisRequest, SynthesisSettings,
    VoiceConversionRequest, VoiceId, WorkerProgram, WorkerStatus,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

static MOCK: OnceLock<PathBuf> = OnceLock::new();

fn mock_program() -> WorkerProgram {
    WorkerProgram::native(MOCK.get_or_init(compile_mock)).unwrap()
}

fn compile_mock() -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mock_speech_worker.rs");
    let output = std::env::temp_dir().join(if cfg!(windows) {
        format!("osg-speech-mock-{}.exe", std::process::id())
    } else {
        format!("osg-speech-mock-{}", std::process::id())
    });
    let status = Command::new("rustc")
        .args([
            source.as_os_str(),
            "--edition=2024".as_ref(),
            "-O".as_ref(),
            "-o".as_ref(),
            output.as_os_str(),
        ])
        .status()
        .expect("rustc must be available during tests");
    assert!(status.success());
    output
}

fn edge_request(text: &str) -> SynthesisRequest {
    SynthesisRequest::new(
        SegmentId::new("segment-1").unwrap(),
        SpeechText::new(text).unwrap(),
        SynthesisSettings::EdgeTts(
            EdgeSettings::new(VoiceId::new("en-US-Mock").unwrap(), 0, 0, 0).unwrap(),
        ),
        None,
    )
    .unwrap()
}

fn output(directory: &Path, name: &str) -> SpeechOutput {
    SpeechOutput::from_native_directory(directory, name, AudioFormat::Mp3).unwrap()
}

fn formatted_output(directory: &Path, name: &str, format: AudioFormat) -> SpeechOutput {
    SpeechOutput::from_native_directory(directory, name, format).unwrap()
}

fn reference(directory: &Path, name: &str) -> AudioAsset {
    let path = directory.join(format!("{name}.wav"));
    std::fs::write(&path, b"RIFFreferenceWAVEdata").unwrap();
    AudioAsset::from_native_file(&path).unwrap()
}

fn control() -> RunControl {
    RunControl::new(Duration::from_secs(5)).unwrap()
}

#[test]
fn worker_is_lazy_reused_and_publishes_verified_audio() {
    let directory = tempfile::tempdir().unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    assert_eq!(worker.status(), WorkerStatus::Stopped);
    let first = worker
        .synthesize(
            &edge_request("hello"),
            &output(directory.path(), "one"),
            &control(),
        )
        .unwrap();
    assert_eq!(first.summary().format(), AudioFormat::Mp3);
    assert!(first.native_path().is_file());
    assert_eq!(worker.status(), WorkerStatus::Ready);
    worker
        .synthesize(
            &edge_request("second"),
            &output(directory.path(), "two"),
            &control(),
        )
        .unwrap();
    assert_eq!(worker.status(), WorkerStatus::Ready);
    worker.shutdown();
    assert_eq!(worker.status(), WorkerStatus::Stopped);
}

#[test]
fn machine_progress_is_typed_and_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    let observed = Arc::new(Mutex::new(Vec::<SpeechProgress>::new()));
    let callback = Arc::clone(&observed);
    let control = control().with_progress(move |progress: &SpeechProgress| {
        callback.lock().unwrap().push(progress.clone());
    });
    worker
        .synthesize(
            &edge_request("progress"),
            &output(directory.path(), "progress"),
            &control,
        )
        .unwrap();
    let observed = observed.lock().unwrap();
    assert!(
        observed
            .iter()
            .any(|item| item.phase() == SpeechPhase::LoadingModel)
    );
    assert!(
        observed
            .iter()
            .all(|item| item.fraction_millionths() <= 1_000_000)
    );
}

#[test]
fn output_is_no_clobber_and_errors_are_redacted() {
    let directory = tempfile::tempdir().unwrap();
    let existing = directory.path().join("existing.mp3");
    std::fs::write(&existing, b"keep me").unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    let destination = output(directory.path(), "existing");
    assert!(matches!(
        worker.synthesize(&edge_request("secret narration"), &destination, &control()),
        Err(SpeechError::OutputExists)
    ));
    assert_eq!(std::fs::read(existing).unwrap(), b"keep me");

    let error = worker
        .synthesize(
            &edge_request("MOCK_ERROR_SECRET"),
            &output(directory.path(), "redacted"),
            &control(),
        )
        .unwrap_err();
    let debug = format!("{error:?}");
    assert!(!debug.contains("private"));
    assert!(!debug.contains("leaked"));
    assert!(matches!(
        error,
        SpeechError::WorkerRejected {
            code: "worker_error",
            ..
        }
    ));
}

#[test]
fn invalid_artifact_is_removed_and_worker_is_discarded() {
    let directory = tempfile::tempdir().unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    let destination = output(directory.path(), "invalid");
    let error = worker
        .synthesize(&edge_request("MOCK_BAD_ARTIFACT"), &destination, &control())
        .unwrap_err();
    assert!(matches!(error, SpeechError::InvalidArtifact(_)));
    assert!(!directory.path().join("invalid.mp3").exists());
    assert_eq!(worker.status(), WorkerStatus::Stopped);
}

#[test]
fn malformed_frames_and_wrong_request_ids_invalidate_session() {
    for (text, expected) in [("MOCK_CORRUPT", "frame"), ("MOCK_WRONG_ID", "envelope")] {
        let directory = tempfile::tempdir().unwrap();
        let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
        let error = worker
            .synthesize(
                &edge_request(text),
                &output(directory.path(), text),
                &control(),
            )
            .unwrap_err();
        assert!(format!("{error}").contains(expected));
        assert_eq!(worker.status(), WorkerStatus::Stopped);
    }
}

#[test]
fn timeout_cancellation_and_exit_are_reported_without_hanging() {
    let directory = tempfile::tempdir().unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    let started = Instant::now();
    let error = worker
        .synthesize(
            &edge_request("MOCK_HANG"),
            &output(directory.path(), "timeout"),
            &RunControl::new(Duration::from_millis(150)).unwrap(),
        )
        .unwrap_err();
    assert!(matches!(error, SpeechError::TimedOut { .. }));
    assert!(started.elapsed() < Duration::from_secs(3));

    let token = CancellationToken::default();
    let run_control = control().with_cancellation(token.clone());
    let trigger = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        token.cancel();
    });
    assert!(matches!(
        worker.synthesize(
            &edge_request("MOCK_HANG"),
            &output(directory.path(), "cancel"),
            &run_control,
        ),
        Err(SpeechError::Cancelled)
    ));
    trigger.join().unwrap();

    assert!(matches!(
        worker.synthesize(
            &edge_request("MOCK_EXIT"),
            &output(directory.path(), "exit"),
            &control(),
        ),
        Err(SpeechError::WorkerExited { code: Some(19) } | SpeechError::WorkerIo(_))
    ));
}

#[test]
fn cancelling_a_waiting_request_does_not_interrupt_the_active_worker() {
    let directory = tempfile::tempdir().unwrap();
    let worker = Arc::new(LazySpeechWorker::new(
        mock_program(),
        SpeechBackend::EdgeTts,
    ));

    let (active_started_tx, active_started_rx) = mpsc::channel();
    let active_worker = Arc::clone(&worker);
    let active_output = output(directory.path(), "active-slow");
    let active_control = control().with_progress(move |_progress: &SpeechProgress| {
        let _ = active_started_tx.send(());
    });
    let active = std::thread::spawn(move || {
        active_worker.synthesize(&edge_request("MOCK_SLOW"), &active_output, &active_control)
    });
    active_started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the active request must acquire the worker");

    let waiting_cancellation = CancellationToken::default();
    let waiting_control = control().with_cancellation(waiting_cancellation.clone());
    let waiting_worker = Arc::clone(&worker);
    let waiting_output = output(directory.path(), "cancelled-waiter");
    let (waiting_started_tx, waiting_started_rx) = mpsc::channel();
    let waiting = std::thread::spawn(move || {
        waiting_started_tx.send(()).unwrap();
        waiting_worker.synthesize(&edge_request("waiting"), &waiting_output, &waiting_control)
    });
    waiting_started_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    waiting_cancellation.cancel();

    assert!(matches!(
        waiting.join().unwrap(),
        Err(SpeechError::Cancelled)
    ));
    assert!(active.join().unwrap().is_ok());
    assert_eq!(worker.status(), WorkerStatus::Ready);
    assert!(
        worker
            .synthesize(
                &edge_request("after-contention"),
                &output(directory.path(), "after-contention"),
                &control(),
            )
            .is_ok()
    );
}

#[test]
fn timeout_kills_descendant_process_tree() {
    let directory = tempfile::tempdir().unwrap();
    let sentinel = directory.path().join("descendant-survived.txt");
    let text = format!("MOCK_TREE|{}", sentinel.display());
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    assert!(matches!(
        worker.synthesize(
            &edge_request(&text),
            &output(directory.path(), "tree"),
            &RunControl::new(Duration::from_millis(180)).unwrap(),
        ),
        Err(SpeechError::TimedOut { .. })
    ));
    std::thread::sleep(Duration::from_millis(900));
    assert!(
        !sentinel.exists(),
        "a worker descendant escaped tree cancellation"
    );
}

#[test]
fn provider_secret_uses_fixed_environment_and_debug_is_redacted() {
    let directory = tempfile::tempdir().unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::GeminiLive)
        .with_provider_secret(SecretValue::new("super-secret").unwrap());
    let debug = format!("{worker:?}");
    assert!(!debug.contains("super-secret"));

    // Gemini settings are intentionally exercised by its central provider
    // crate; the mock environment contract is verified by launching the same
    // worker as Edge with a secret, which uses identical supervision code.
    let edge = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts)
        .with_provider_secret(SecretValue::new("super-secret").unwrap());
    edge.synthesize(
        &edge_request("MOCK_SECRET_OK"),
        &output(directory.path(), "secret"),
        &control(),
    )
    .unwrap();
}

#[test]
fn managed_worker_receives_only_the_native_model_capability_and_offline_guards() {
    let directory = tempfile::tempdir().unwrap();
    let bootstrap = directory.path().join("speech_worker.py");
    let model_root = directory.path().join("private-model-root");
    std::fs::write(&bootstrap, b"# ignored by the native fixture").unwrap();
    std::fs::create_dir(&model_root).unwrap();
    let executable = MOCK.get_or_init(compile_mock);
    let program = WorkerProgram::managed_bootstrap(executable, &bootstrap, Some(&model_root))
        .expect("native-managed worker paths must be accepted");
    let worker = LazySpeechWorker::new(program, SpeechBackend::EdgeTts);

    worker
        .synthesize(
            &edge_request("MOCK_MANAGED_ENV"),
            &output(directory.path(), "managed-environment"),
            &control(),
        )
        .unwrap();
}

#[test]
fn voice_inventory_is_validated() {
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    let inventory = worker.list_voices(&control()).unwrap();
    assert_eq!(inventory.voices().len(), 1);
    assert_eq!(inventory.voices()[0].id().as_str(), "en-US-Mock");
}

#[test]
fn large_stderr_is_fully_drained() {
    let directory = tempfile::tempdir().unwrap();
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    worker
        .synthesize(
            &edge_request("MOCK_STDERR"),
            &output(directory.path(), "stderr"),
            &control(),
        )
        .unwrap();
}

#[test]
fn every_legacy_synthesis_backend_uses_the_same_managed_contract() {
    let directory = tempfile::tempdir().unwrap();

    let f5 = LazySpeechWorker::new(mock_program(), SpeechBackend::F5Tts);
    let f5_request = SynthesisRequest::new(
        SegmentId::new("f5").unwrap(),
        SpeechText::new("F5 narration").unwrap(),
        SynthesisSettings::F5Tts(F5Settings::new(SpeechText::new("Reference words").unwrap())),
        Some(reference(directory.path(), "f5-reference")),
    )
    .unwrap();
    f5.synthesize(
        &f5_request,
        &formatted_output(directory.path(), "f5-result", AudioFormat::Wav),
        &control(),
    )
    .unwrap();

    let chatterbox = LazySpeechWorker::new(mock_program(), SpeechBackend::Chatterbox);
    let chatterbox_request = SynthesisRequest::new(
        SegmentId::new("chatterbox").unwrap(),
        SpeechText::new("Chatterbox narration").unwrap(),
        SynthesisSettings::Chatterbox(
            ChatterboxSettings::new(LanguageTag::new("en-US").unwrap(), 500, 500).unwrap(),
        ),
        Some(reference(directory.path(), "chatterbox-reference")),
    )
    .unwrap();
    chatterbox
        .synthesize(
            &chatterbox_request,
            &formatted_output(directory.path(), "chatterbox-result", AudioFormat::Wav),
            &control(),
        )
        .unwrap();

    let gtts = LazySpeechWorker::new(mock_program(), SpeechBackend::Gtts);
    let gtts_request = SynthesisRequest::new(
        SegmentId::new("gtts").unwrap(),
        SpeechText::new("gTTS narration").unwrap(),
        SynthesisSettings::Gtts(GttsSettings::new(
            LanguageTag::new("en").unwrap(),
            GttsDomain::CoUk,
            false,
        )),
        None,
    )
    .unwrap();
    gtts.synthesize(
        &gtts_request,
        &formatted_output(directory.path(), "gtts-result", AudioFormat::Mp3),
        &control(),
    )
    .unwrap();

    let gemini = LazySpeechWorker::new(mock_program(), SpeechBackend::GeminiLive)
        .with_provider_secret(SecretValue::new("super-secret").unwrap());
    let gemini_request = SynthesisRequest::new(
        SegmentId::new("gemini").unwrap(),
        SpeechText::new("MOCK_SECRET_OK").unwrap(),
        SynthesisSettings::GeminiLive(GeminiSettings::new(
            ModelId::new("models/gemini-live-audio").unwrap(),
            VoiceId::new("Aoede").unwrap(),
            LanguageTag::new("en-US").unwrap(),
        )),
        None,
    )
    .unwrap();
    gemini
        .synthesize(
            &gemini_request,
            &formatted_output(directory.path(), "gemini-result", AudioFormat::Wav),
            &control(),
        )
        .unwrap();
}

#[test]
fn chatterbox_voice_conversion_is_bounded_and_verified() {
    let directory = tempfile::tempdir().unwrap();
    let request = VoiceConversionRequest::new(
        reference(directory.path(), "conversion-input"),
        reference(directory.path(), "target-voice"),
    );
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::Chatterbox);
    let artifact = worker
        .convert_voice(
            &request,
            &formatted_output(directory.path(), "converted", AudioFormat::Wav),
            &control(),
        )
        .unwrap();
    assert_eq!(artifact.summary().duration().get(), 100_000);
}

#[test]
fn f5_reference_preparation_uses_the_managed_worker_contract() {
    let directory = tempfile::tempdir().unwrap();
    let plan = ReferencePreparationPlan::for_f5(reference(directory.path(), "raw-reference"));
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::F5Tts);
    let artifact = worker
        .prepare_reference(
            &plan,
            &formatted_output(directory.path(), "prepared-reference", AudioFormat::Wav),
            &control(),
        )
        .unwrap();

    assert_eq!(artifact.summary().format(), AudioFormat::Wav);
    assert!(artifact.native_path().is_file());
}

#[test]
fn shell_metacharacters_remain_framed_text_data() {
    let directory = tempfile::tempdir().unwrap();
    let sentinel = directory.path().join("must-not-exist");
    let hostile_text = format!("hello; --flag $(touch {})", sentinel.display());
    let worker = LazySpeechWorker::new(mock_program(), SpeechBackend::EdgeTts);
    worker
        .synthesize(
            &edge_request(&hostile_text),
            &output(directory.path(), "hostile"),
            &control(),
        )
        .unwrap();
    assert!(!sentinel.exists());
}
