use crate::progress::parse_progress;
use crate::{DownloadError, ProgressSink, Result};
use osg_process::{
    CancellationToken, Capture, CaptureMode, ManagedChild, Supervised, capture_stream, environment,
    supervise,
};
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) const INVENTORY_STDOUT_LIMIT: usize = 32 * 1024 * 1024;
pub(crate) const DOWNLOAD_STDOUT_LIMIT: usize = 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 64 * 1024;

#[derive(Clone)]
pub struct RunControl {
    timeout: Duration,
    cancellation: CancellationToken,
    progress: Option<Arc<dyn ProgressSink>>,
}

impl RunControl {
    pub fn new(timeout: Duration) -> Result<Self> {
        if timeout.is_zero() || timeout > Duration::from_hours(168) {
            return Err(DownloadError::InvalidOption(
                "timeout must be greater than zero and at most seven days",
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
    pub fn with_progress<P>(mut self, progress: P) -> Self
    where
        P: ProgressSink + 'static,
    {
        self.progress = Some(Arc::new(progress));
        self
    }

    #[must_use]
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl std::fmt::Debug for RunControl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RunControl")
            .field("timeout", &self.timeout)
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("progress", &self.progress.is_some())
            .finish()
    }
}

pub(crate) struct ProcessRequest<'a> {
    pub(crate) binary: &'a Path,
    pub(crate) arguments: Vec<OsString>,
    pub(crate) control: &'a RunControl,
    pub(crate) stdout_limit: usize,
}

pub(crate) struct ProcessOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_tail: Vec<u8>,
}

impl std::fmt::Debug for ProcessOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProcessOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stdout_truncated", &self.stdout_truncated)
            .field("stderr_tail_bytes", &self.stderr_tail.len())
            .finish()
    }
}

pub(crate) fn run(request: ProcessRequest<'_>) -> Result<ProcessOutput> {
    let control = request.control;
    if control.cancellation.is_cancelled() {
        return Err(DownloadError::Cancelled);
    }

    let mut command = tool_command(request.binary, request.arguments);
    let mut child = ManagedChild::spawn(&mut command).map_err(DownloadError::Spawn)?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| process_io("stdout pipe unavailable"))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| process_io("stderr pipe unavailable"))?;

    let stdout_progress = control.progress.clone();
    let stdout_mode = CaptureMode::Head(request.stdout_limit);
    let stdout_thread =
        std::thread::spawn(move || capture(stdout, stdout_mode, stdout_progress.as_deref()));
    let stderr_progress = control.progress.clone();
    let stderr_thread = std::thread::spawn(move || {
        capture(
            stderr,
            CaptureMode::Tail(STDERR_TAIL_LIMIT),
            stderr_progress.as_deref(),
        )
    });

    let outcome = supervise(&mut child, &control.cancellation, control.timeout)
        .map_err(DownloadError::ProcessIo)?;
    let Supervised::Exited(status) = outcome else {
        let _ = join_capture(stdout_thread);
        let _ = join_capture(stderr_thread);
        return Err(if outcome == Supervised::Cancelled {
            DownloadError::Cancelled
        } else {
            DownloadError::TimedOut {
                timeout: control.timeout,
            }
        });
    };
    let stdout = join_capture(stdout_thread)?;
    let stderr = join_capture(stderr_thread)?;
    Ok(ProcessOutput {
        status,
        stdout: stdout.bytes,
        stdout_truncated: stdout.truncated,
        stderr_tail: stderr.bytes,
    })
}

/// yt-dlp and Deno reach the network, so they also see the user's proxy configuration.
fn tool_command(binary: &Path, arguments: Vec<OsString>) -> Command {
    let mut command = Command::new(binary);
    environment::isolate(&mut command, &[environment::NETWORK]);
    command
        .args(arguments)
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn capture(
    reader: impl Read,
    mode: CaptureMode,
    progress: Option<&dyn ProgressSink>,
) -> std::io::Result<Capture> {
    let mut emit = |line: &[u8]| {
        let line = String::from_utf8_lossy(line);
        if let (Some(sink), Some(update)) = (progress, parse_progress(line.trim_end_matches('\r')))
        {
            sink.on_progress(&update);
        }
    };
    let observer = progress
        .is_some()
        .then_some(&mut emit as &mut dyn FnMut(&[u8]));
    capture_stream(reader, mode, observer)
}

fn join_capture(thread: JoinHandle<std::io::Result<Capture>>) -> Result<Capture> {
    thread
        .join()
        .map_err(|_| process_io("process reader stopped unexpectedly"))?
        .map_err(DownloadError::ProcessIo)
}

fn process_io(message: &'static str) -> DownloadError {
    DownloadError::ProcessIo(std::io::Error::other(message))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::{ResolvedYtDlp, YtDlpResolver, YtDlpSearch};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    static MOCK: OnceLock<PathBuf> = OnceLock::new();

    #[test]
    fn downloader_receives_only_allowlisted_and_fixed_environment() {
        let command = tool_command(Path::new("not-started"), Vec::new());
        let allowed = environment::allowlist(&[environment::NETWORK]).collect::<Vec<_>>();
        let fixed = ["PYTHONUTF8", "PYTHONUNBUFFERED", "NO_COLOR"];
        for (key, value) in command.get_envs() {
            let key = key.to_string_lossy();
            assert!(value.is_some(), "{key} is removed instead of never copied");
            assert!(
                allowed
                    .iter()
                    .chain(&fixed)
                    .any(|name| name.eq_ignore_ascii_case(&key)),
                "{key} would reach the downloader"
            );
        }
        for name in fixed {
            assert!(command.get_envs().any(|(key, _)| key == name));
        }
    }

    pub(crate) fn mock_binary() -> ResolvedYtDlp {
        YtDlpResolver::new(YtDlpSearch::default().configured(MOCK.get_or_init(compile_mock)))
            .resolve()
            .unwrap()
    }

    fn compile_mock() -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("mock_ytdlp.rs");
        let output = std::env::temp_dir().join(if cfg!(windows) {
            format!("osg-download-mock-{}.exe", std::process::id())
        } else {
            format!("osg-download-mock-{}", std::process::id())
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

    fn request<'a>(
        binary: &'a ResolvedYtDlp,
        arguments: Vec<OsString>,
        control: &'a RunControl,
    ) -> ProcessRequest<'a> {
        ProcessRequest {
            binary: binary.path(),
            arguments,
            control,
            stdout_limit: DOWNLOAD_STDOUT_LIMIT,
        }
    }

    #[test]
    fn stderr_is_bounded_and_retains_tail() {
        let binary = mock_binary();
        let control = RunControl::new(Duration::from_secs(5)).unwrap();
        let output = run(request(&binary, vec!["--mock-stderr".into()], &control)).unwrap();
        assert!(!output.status.success());
        assert!(output.stderr_tail.len() <= STDERR_TAIL_LIMIT);
        assert!(String::from_utf8_lossy(&output.stderr_tail).contains("TAIL-MARKER"));
    }

    #[test]
    fn stdout_is_bounded_while_the_pipe_is_fully_drained() {
        let binary = mock_binary();
        let control = RunControl::new(Duration::from_secs(5)).unwrap();
        let output = run(request(&binary, vec!["--mock-stdout".into()], &control)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), DOWNLOAD_STDOUT_LIMIT);
        assert!(output.stdout_truncated);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("TAIL-MARKER"));
    }

    #[test]
    fn timeout_terminates_managed_process_group() {
        let binary = mock_binary();
        let control = RunControl::new(Duration::from_millis(100)).unwrap();
        let started = Instant::now();
        let error = run(request(&binary, vec!["--mock-hang".into()], &control)).unwrap_err();
        assert!(matches!(error, DownloadError::TimedOut { .. }));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn timeout_terminates_descendant_processes() {
        let binary = mock_binary();
        let directory = tempfile::tempdir().unwrap();
        let sentinel = directory.path().join("survived.txt");
        let control = RunControl::new(Duration::from_millis(200)).unwrap();
        let arguments = vec![
            OsString::from("--mock-tree"),
            sentinel.as_os_str().to_owned(),
        ];
        assert!(matches!(
            run(request(&binary, arguments, &control)),
            Err(DownloadError::TimedOut { .. })
        ));
        std::thread::sleep(Duration::from_millis(900));
        assert!(!sentinel.exists(), "a descendant escaped process-tree kill");
    }

    #[test]
    fn cancellation_terminates_managed_process_group() {
        let binary = mock_binary();
        let token = CancellationToken::default();
        let control = RunControl::new(Duration::from_secs(5))
            .unwrap()
            .with_cancellation(token.clone());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            token.cancel();
        });
        assert!(matches!(
            run(request(&binary, vec!["--mock-hang".into()], &control)),
            Err(DownloadError::Cancelled)
        ));
    }

    #[test]
    fn progress_is_parsed_from_machine_lines() {
        let binary = mock_binary();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let callback = observed.clone();
        let control = RunControl::new(Duration::from_secs(5))
            .unwrap()
            .with_progress(move |progress: &crate::DownloadProgress| {
                callback.lock().unwrap().push(progress.clone());
            });
        let output = run(request(&binary, vec!["--mock-progress".into()], &control)).unwrap();
        assert!(output.status.success());
        assert_eq!(observed.lock().unwrap().last().unwrap().fraction, Some(1.0));
    }
}
