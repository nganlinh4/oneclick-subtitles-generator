use crate::binary::{BinaryKind, ResolvedBinary};
use crate::progress::{FfmpegProgressParser, ProgressSink};
use crate::{MediaError, Result};
use osg_process::{
    CancellationToken, Capture, CaptureMode, ManagedChild, Supervised, capture_stream, environment,
    supervise,
};
use std::ffi::OsString;
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct RunControl {
    timeout: Duration,
    cancellation: CancellationToken,
    progress: Option<ProgressSink>,
}

impl RunControl {
    pub fn new(timeout: Duration) -> Result<Self> {
        if timeout.is_zero() || timeout > Duration::from_hours(168) {
            return Err(MediaError::InvalidOption(
                "timeout must be between one nanosecond and seven days",
            ));
        }
        Ok(Self {
            timeout,
            cancellation: CancellationToken::default(),
            progress: None,
        })
    }

    #[must_use]
    pub fn with_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    #[must_use]
    pub fn with_progress(mut self, progress: ProgressSink) -> Self {
        self.progress = Some(progress);
        self
    }

    #[must_use]
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

#[derive(Debug)]
pub(crate) struct ProcessRequest<'a> {
    pub(crate) binary: &'a ResolvedBinary,
    pub(crate) args: Vec<OsString>,
    pub(crate) control: &'a RunControl,
    pub(crate) expected_duration_us: Option<u64>,
    pub(crate) stdout_limit: usize,
}

impl<'a> ProcessRequest<'a> {
    pub(crate) fn new(
        binary: &'a ResolvedBinary,
        args: Vec<OsString>,
        control: &'a RunControl,
    ) -> Self {
        Self {
            binary,
            args,
            control,
            expected_duration_us: None,
            stdout_limit: DEFAULT_STDOUT_LIMIT,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_tail: Vec<u8>,
    pub(crate) elapsed: Duration,
}

pub(crate) fn run(request: ProcessRequest<'_>) -> Result<ProcessOutput> {
    let ProcessRequest {
        binary,
        args,
        control,
        expected_duration_us,
        stdout_limit,
    } = request;
    let tool = binary.kind();
    if control.cancellation.is_cancelled() {
        return Err(MediaError::Cancelled(tool));
    }

    let mut command = tool_command(binary, args);
    let mut child =
        ManagedChild::spawn(&mut command).map_err(|source| MediaError::Spawn { tool, source })?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| process_io(tool, "stdout pipe unavailable"))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| process_io(tool, "stderr pipe unavailable"))?;

    let stdout_thread =
        std::thread::spawn(move || capture_stream(stdout, CaptureMode::Head(stdout_limit), None));
    let progress = control.progress.clone();
    let stderr_thread =
        std::thread::spawn(move || capture_stderr(stderr, progress.as_ref(), expected_duration_us));

    let started = Instant::now();
    let outcome = supervise(&mut child, &control.cancellation, control.timeout)
        .map_err(|source| MediaError::ProcessIo { tool, source })?;
    let stdout = join(stdout_thread, tool, "stdout reader stopped unexpectedly")?;
    let stderr = join(stderr_thread, tool, "stderr reader stopped unexpectedly")?;
    match outcome {
        Supervised::Exited(status) => Ok(ProcessOutput {
            status,
            stdout: stdout.bytes,
            stdout_truncated: stdout.truncated,
            stderr_tail: stderr.bytes,
            elapsed: started.elapsed(),
        }),
        Supervised::Cancelled => Err(MediaError::Cancelled(tool)),
        Supervised::TimedOut => Err(MediaError::TimedOut {
            tool,
            timeout: control.timeout,
        }),
    }
}

/// `FFmpeg` and `ffprobe` need nothing beyond the essential environment.
fn tool_command(binary: &ResolvedBinary, args: Vec<OsString>) -> Command {
    let mut command = Command::new(binary.path());
    environment::isolate(&mut command, &[]);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn capture_stderr(
    reader: impl Read,
    progress: Option<&ProgressSink>,
    expected_duration_us: Option<u64>,
) -> std::io::Result<Capture> {
    let mut parser = FfmpegProgressParser::new(expected_duration_us);
    let mut emit = |line: &[u8]| {
        let line = String::from_utf8_lossy(line);
        if let (Some(sink), Some(update)) =
            (progress, parser.push_line(line.trim_end_matches('\r')))
        {
            sink.emit(update);
        }
    };
    let observer = progress
        .is_some()
        .then_some(&mut emit as &mut dyn FnMut(&[u8]));
    capture_stream(reader, CaptureMode::Tail(STDERR_TAIL_LIMIT), observer)
}

fn join(
    thread: JoinHandle<std::io::Result<Capture>>,
    tool: BinaryKind,
    message: &'static str,
) -> Result<Capture> {
    thread
        .join()
        .map_err(|_| process_io(tool, message))?
        .map_err(|source| MediaError::ProcessIo { tool, source })
}

fn process_io(tool: BinaryKind, message: &'static str) -> MediaError {
    MediaError::ProcessIo {
        tool,
        source: std::io::Error::other(message),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::binary::BinaryOrigin;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, OnceLock};

    static MOCK: OnceLock<PathBuf> = OnceLock::new();

    #[test]
    fn media_tools_receive_only_the_essential_environment() {
        let binary = mock_binary(BinaryKind::Ffprobe);
        let command = tool_command(&binary, Vec::new());
        let allowed = environment::allowlist(&[]).collect::<Vec<_>>();
        for (key, value) in command.get_envs() {
            let key = key.to_string_lossy();
            assert!(value.is_some(), "{key} is removed instead of never copied");
            assert!(
                allowed.iter().any(|name| name.eq_ignore_ascii_case(&key)),
                "{key} would reach the media tool"
            );
        }
    }

    pub(crate) fn mock_binary(kind: BinaryKind) -> ResolvedBinary {
        ResolvedBinary {
            kind,
            path: MOCK.get_or_init(compile_mock).clone(),
            origin: BinaryOrigin::Configured,
        }
    }

    fn compile_mock() -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("mock_media_tool.rs");
        let output = std::env::temp_dir().join(if cfg!(windows) {
            format!("osg-media-mock-{}.exe", std::process::id())
        } else {
            format!("osg-media-mock-{}", std::process::id())
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
            .expect("rustc must be available while cargo tests run");
        assert!(status.success(), "mock executable compilation failed");
        output
    }

    #[test]
    fn stderr_is_bounded_and_retains_the_tail() {
        let binary = mock_binary(BinaryKind::Ffmpeg);
        let control = RunControl::new(Duration::from_secs(5)).unwrap();
        let request = ProcessRequest::new(&binary, vec!["--mock-stderr".into()], &control);
        let output = run(request).unwrap();
        assert!(!output.status.success());
        assert!(output.stderr_tail.len() <= STDERR_TAIL_LIMIT);
        assert!(String::from_utf8_lossy(&output.stderr_tail).contains("TAIL-MARKER"));
    }

    #[test]
    fn timeout_terminates_the_managed_process_group() {
        let binary = mock_binary(BinaryKind::Ffmpeg);
        let control = RunControl::new(Duration::from_millis(100)).unwrap();
        let started = Instant::now();
        let error = run(ProcessRequest::new(
            &binary,
            vec!["--mock-hang".into()],
            &control,
        ))
        .unwrap_err();
        assert!(matches!(error, MediaError::TimedOut { .. }));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn cancellation_terminates_the_managed_process_group() {
        let binary = mock_binary(BinaryKind::Ffmpeg);
        let cancellation = CancellationToken::default();
        let control = RunControl::new(Duration::from_secs(10))
            .unwrap()
            .with_cancellation(cancellation.clone());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancellation.cancel();
        });
        let error = run(ProcessRequest::new(
            &binary,
            vec!["--mock-hang".into()],
            &control,
        ))
        .unwrap_err();
        assert!(matches!(error, MediaError::Cancelled(BinaryKind::Ffmpeg)));
    }

    #[test]
    fn progress_is_parsed_from_machine_protocol() {
        let binary = mock_binary(BinaryKind::Ffmpeg);
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callback_observed = observed.clone();
        let control = RunControl::new(Duration::from_secs(5))
            .unwrap()
            .with_progress(ProgressSink::new(move |progress| {
                callback_observed.lock().unwrap().push(progress);
            }));
        let mut request = ProcessRequest::new(&binary, vec!["--mock-progress".into()], &control);
        request.expected_duration_us = Some(2_000_000);
        let output = run(request).unwrap();
        assert!(output.status.success());
        let values = observed.lock().unwrap();
        assert_eq!(values.last().unwrap().fraction, Some(1.0));
    }
}
