use crate::binary::{BinaryKind, ResolvedBinary};
use crate::progress::{FfmpegProgressParser, ProgressSink};
use crate::{MediaError, Result};
use command_group::{CommandGroup, GroupChild};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 64 * 1024;
const PROGRESS_LINE_LIMIT: usize = 4 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

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

    let mut command = Command::new(binary.path());
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = spawn_group(&mut command, tool)?;
    let mut child = KillOnDrop::new(child);
    let stdout = child
        .inner()
        .stdout
        .take()
        .ok_or_else(|| process_io(tool, "stdout pipe unavailable"))?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .ok_or_else(|| process_io(tool, "stderr pipe unavailable"))?;

    let stdout_thread = std::thread::spawn(move || capture_head(stdout, stdout_limit));
    let progress = control.progress.clone();
    let stderr_thread =
        std::thread::spawn(move || capture_stderr(stderr, progress.as_ref(), expected_duration_us));

    let started = Instant::now();
    let status = loop {
        // A process that has already completed wins a race with a late cancel.
        if let Some(status) = child.try_wait().map_err(|error| MediaError::ProcessIo {
            tool,
            source: error,
        })? {
            break status;
        }
        if control.cancellation.is_cancelled() {
            child.terminate_and_wait(tool)?;
            join_capture(stdout_thread, tool)?;
            join_stderr(stderr_thread, tool)?;
            return Err(MediaError::Cancelled(tool));
        }
        if started.elapsed() >= control.timeout {
            child.terminate_and_wait(tool)?;
            join_capture(stdout_thread, tool)?;
            join_stderr(stderr_thread, tool)?;
            return Err(MediaError::TimedOut {
                tool,
                timeout: control.timeout,
            });
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    child.mark_reaped();
    let capture = join_capture(stdout_thread, tool)?;
    let stderr_tail = join_stderr(stderr_thread, tool)?;
    Ok(ProcessOutput {
        status,
        stdout: capture.bytes,
        stdout_truncated: capture.truncated,
        stderr_tail,
        elapsed: started.elapsed(),
    })
}

fn spawn_group(command: &mut Command, tool: BinaryKind) -> Result<GroupChild> {
    #[cfg(windows)]
    let result = command
        .group()
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    #[cfg(not(windows))]
    let result = command.group_spawn();
    result.map_err(|source| MediaError::Spawn { tool, source })
}

#[derive(Debug)]
struct KillOnDrop {
    child: GroupChild,
    reaped: bool,
}

impl KillOnDrop {
    fn new(child: GroupChild) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    fn inner(&mut self) -> &mut std::process::Child {
        self.child.inner()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    fn terminate_and_wait(&mut self, tool: BinaryKind) -> Result<()> {
        if self
            .child
            .try_wait()
            .map_err(|source| MediaError::ProcessIo { tool, source })?
            .is_none()
        {
            let _ = self.child.kill();
        }
        self.child
            .wait()
            .map_err(|source| MediaError::ProcessIo { tool, source })?;
        self.reaped = true;
        Ok(())
    }

    fn mark_reaped(&mut self) {
        self.reaped = true;
    }
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if !self.reaped && self.child.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Debug)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

fn capture_head(mut reader: impl Read, limit: usize) -> std::io::Result<Capture> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = read.min(remaining);
        bytes.extend_from_slice(&buffer[..retained]);
        truncated |= retained < read;
    }
    Ok(Capture { bytes, truncated })
}

fn capture_stderr(
    mut reader: impl Read,
    progress: Option<&ProgressSink>,
    expected_duration_us: Option<u64>,
) -> std::io::Result<Vec<u8>> {
    let mut tail = VecDeque::with_capacity(STDERR_TAIL_LIMIT);
    let mut line = Vec::with_capacity(256);
    let mut parser = FfmpegProgressParser::new(expected_duration_us);
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            if tail.len() == STDERR_TAIL_LIMIT {
                tail.pop_front();
            }
            tail.push_back(*byte);
            if *byte == b'\n' {
                emit_progress_line(&mut parser, progress, &line);
                line.clear();
            } else if line.len() < PROGRESS_LINE_LIMIT {
                line.push(*byte);
            }
        }
    }
    if !line.is_empty() {
        emit_progress_line(&mut parser, progress, &line);
    }
    Ok(tail.into_iter().collect())
}

fn emit_progress_line(parser: &mut FfmpegProgressParser, sink: Option<&ProgressSink>, line: &[u8]) {
    let Some(sink) = sink else {
        return;
    };
    let line = String::from_utf8_lossy(line);
    if let Some(progress) = parser.push_line(line.trim_end_matches('\r')) {
        sink.emit(progress);
    }
}

fn join_capture(thread: JoinHandle<std::io::Result<Capture>>, tool: BinaryKind) -> Result<Capture> {
    thread
        .join()
        .map_err(|_| process_io(tool, "stdout reader stopped unexpectedly"))?
        .map_err(|source| MediaError::ProcessIo { tool, source })
}

fn join_stderr(thread: JoinHandle<std::io::Result<Vec<u8>>>, tool: BinaryKind) -> Result<Vec<u8>> {
    thread
        .join()
        .map_err(|_| process_io(tool, "stderr reader stopped unexpectedly"))?
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
    use std::sync::OnceLock;

    static MOCK: OnceLock<PathBuf> = OnceLock::new();

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
