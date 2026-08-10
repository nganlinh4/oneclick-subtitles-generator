use osg_asr::{
    AsrError, AsrProgress, AsrService, CancellationToken, ModelAssets, NormalizedAudio,
    ProgressPhase, RunControl, TranscriptionOptions, TranscriptionRequest, WorkerProgram,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Fixture {
    _directory: tempfile::TempDir,
    service: AsrService,
    request: TranscriptionRequest,
    audio_path: PathBuf,
}

impl Fixture {
    fn new(mode: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let model = directory.path().join("private-model");
        std::fs::create_dir(&model).unwrap();
        let audio_path = directory.path().join(format!("{mode}.wav"));
        write_wav(&audio_path, 2_000);
        let program = WorkerProgram::executable(mock_worker()).unwrap();
        let assets =
            ModelAssets::new(osg_asr::AsrEngineId::FasterWhisperTurbo, &model, None).unwrap();
        let service = AsrService::new(program, assets);
        let request = TranscriptionRequest::new(
            NormalizedAudio::open(&audio_path).unwrap(),
            TranscriptionOptions::default(),
        );
        Self {
            _directory: directory,
            service,
            request,
            audio_path,
        }
    }
}

#[test]
fn transcribes_with_observed_phases_and_serializes_no_native_paths() {
    let fixture = Fixture::new("valid");
    let phases = Arc::new(Mutex::new(Vec::new()));
    let observed = phases.clone();
    let control = RunControl::new(Duration::from_secs(5))
        .unwrap()
        .with_progress(move |progress: &AsrProgress| {
            observed.lock().unwrap().push(progress.phase);
        });
    let output = fixture
        .service
        .transcribe(&fixture.request, &control)
        .unwrap();
    assert_eq!(output.text, "Hello world. Again");
    assert_eq!(output.segments.len(), 2);
    assert_eq!(
        *phases.lock().unwrap(),
        [
            ProgressPhase::ModelLoading,
            ProgressPhase::Transcribing,
            ProgressPhase::Finalizing,
        ]
    );
    let serialized = serde_json::to_string(&output).unwrap();
    assert!(!serialized.contains(&fixture.audio_path.display().to_string()));
    assert!(
        !serde_json::to_string(&AsrProgress {
            phase: ProgressPhase::Transcribing
        })
        .unwrap()
        .contains("percent")
    );
    assert!(output.to_srt().contains("00:00:00,000 --> 00:00:01,000"));
}

#[test]
fn worker_is_lazy_and_reused_without_fake_model_loading() {
    let fixture = Fixture::new("valid");
    assert!(!fixture.service.is_warm());
    let first = Arc::new(Mutex::new(Vec::new()));
    let observed = first.clone();
    fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_secs(5))
                .unwrap()
                .with_progress(move |progress: &AsrProgress| {
                    observed.lock().unwrap().push(progress.phase);
                }),
        )
        .unwrap();
    assert!(fixture.service.is_warm());

    let second = Arc::new(Mutex::new(Vec::new()));
    let observed = second.clone();
    fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_secs(5))
                .unwrap()
                .with_progress(move |progress: &AsrProgress| {
                    observed.lock().unwrap().push(progress.phase);
                }),
        )
        .unwrap();
    assert_eq!(
        *second.lock().unwrap(),
        [ProgressPhase::Transcribing, ProgressPhase::Finalizing]
    );
}

#[test]
fn timeout_and_cancellation_invalidate_the_worker() {
    let fixture = Fixture::new("hang");
    let started = Instant::now();
    let error = fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_millis(150)).unwrap(),
        )
        .unwrap_err();
    assert!(matches!(error, AsrError::TimedOut(_)));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(!fixture.service.is_warm());

    let fixture = Fixture::new("hang");
    let token = CancellationToken::default();
    let canceller = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        canceller.cancel();
    });
    let error = fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_secs(5))
                .unwrap()
                .with_cancellation(token),
        )
        .unwrap_err();
    assert!(matches!(error, AsrError::Cancelled));
    assert!(!fixture.service.is_warm());
}

#[test]
fn timeout_kills_descendant_processes() {
    let fixture = Fixture::new("tree");
    let sentinel = fixture.audio_path.with_extension("survived");
    assert!(matches!(
        fixture.service.transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_millis(200)).unwrap()
        ),
        Err(AsrError::TimedOut(_))
    ));
    std::thread::sleep(Duration::from_millis(1_100));
    assert!(!sentinel.exists(), "a descendant escaped process-tree kill");
}

#[test]
fn protocol_drift_and_invalid_model_output_are_fail_closed() {
    for (mode, expected) in [
        ("badseq", "protocol"),
        ("unframed", "limit"),
        ("oversized", "limit"),
        ("invalid", "invalid"),
    ] {
        let fixture = Fixture::new(mode);
        let error = fixture
            .service
            .transcribe(
                &fixture.request,
                &RunControl::new(Duration::from_secs(5)).unwrap(),
            )
            .unwrap_err();
        match expected {
            "protocol" => assert!(matches!(error, AsrError::Protocol(_))),
            "limit" => assert!(matches!(error, AsrError::OutputLimit)),
            "invalid" => assert!(matches!(error, AsrError::InvalidOutput)),
            _ => unreachable!(),
        }
        assert!(!fixture.service.is_warm());
    }
}

#[test]
fn unbounded_stderr_is_drained_and_worker_errors_do_not_leak_paths() {
    let fixture = Fixture::new("stderr");
    fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_secs(5)).unwrap(),
        )
        .unwrap();

    let fixture = Fixture::new("worker-error");
    let error = fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_secs(5)).unwrap(),
        )
        .unwrap_err();
    let display = error.to_string();
    assert!(!display.contains(&fixture.audio_path.display().to_string()));
    assert!(display.contains("speech inference failed"));
}

#[test]
fn queued_job_can_be_cancelled_without_waiting_for_the_active_worker() {
    let fixture = Fixture::new("hang");
    let service = fixture.service.clone();
    let request = fixture.request.clone();
    let first_token = CancellationToken::default();
    let first_control = RunControl::new(Duration::from_secs(5))
        .unwrap()
        .with_cancellation(first_token.clone());
    let active = std::thread::spawn(move || service.transcribe(&request, &first_control));
    std::thread::sleep(Duration::from_millis(100));

    let queued_token = CancellationToken::default();
    let queued_cancel = queued_token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        queued_cancel.cancel();
    });
    let started = Instant::now();
    let error = fixture
        .service
        .transcribe(
            &fixture.request,
            &RunControl::new(Duration::from_secs(5))
                .unwrap()
                .with_cancellation(queued_token),
        )
        .unwrap_err();
    assert!(matches!(error, AsrError::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(1));
    first_token.cancel();
    assert!(matches!(active.join().unwrap(), Err(AsrError::Cancelled)));
}

fn mock_worker() -> &'static Path {
    static MOCK: OnceLock<PathBuf> = OnceLock::new();
    MOCK.get_or_init(|| {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("mock_asr_worker.rs");
        let output = std::env::temp_dir().join(if cfg!(windows) {
            format!("osg-asr-mock-{}.exe", std::process::id())
        } else {
            format!("osg-asr-mock-{}", std::process::id())
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
    })
}

fn write_wav(path: &Path, milliseconds: u32) {
    let data_len = 32_000_u32 * milliseconds / 1_000;
    let mut bytes = Vec::with_capacity((44 + data_len) as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&16_000_u32.to_le_bytes());
    bytes.extend_from_slice(&32_000_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.resize((44 + data_len) as usize, 0);
    std::fs::write(path, bytes).unwrap();
}
