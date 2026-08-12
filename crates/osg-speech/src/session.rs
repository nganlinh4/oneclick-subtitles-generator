use crate::protocol::{WorkerResponse, read_frame};
use crate::{Result, RunControl, SpeechError};
use command_group::{CommandGroup, GroupChild};
use std::collections::VecDeque;
use std::io::Read;
use std::process::{ChildStdin, Command, ExitStatus};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const STDERR_TAIL_LIMIT: usize = 64 * 1024;
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn spawn_group(command: &mut Command) -> Result<GroupChild> {
    #[cfg(windows)]
    let result = command
        .group()
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    #[cfg(not(windows))]
    let result = command.group_spawn();
    result.map_err(SpeechError::Spawn)
}

pub(crate) struct WorkerSession {
    child: GroupChild,
    _cache_directory: tempfile::TempDir,
    pub(crate) stdin: ChildStdin,
    responses: Receiver<Result<WorkerResponse>>,
    reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    _stderr_tail: Arc<Mutex<VecDeque<u8>>>,
    pub(crate) max_text_bytes: usize,
    reaped: bool,
}

impl WorkerSession {
    pub(crate) fn new(mut child: GroupChild, cache_directory: tempfile::TempDir) -> Result<Self> {
        let stdin = child
            .inner()
            .stdin
            .take()
            .ok_or_else(|| process_io("worker stdin is unavailable"))?;
        let mut stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| process_io("worker stdout is unavailable"))?;
        let mut stderr = child
            .inner()
            .stderr
            .take()
            .ok_or_else(|| process_io("worker stderr is unavailable"))?;
        // A noisy or compromised worker cannot enqueue unbounded progress
        // frames; backpressure eventually fills its stdout pipe.
        let (sender, responses) = std::sync::mpsc::sync_channel(64);
        let reader = std::thread::spawn(move || {
            loop {
                let response = read_frame::<WorkerResponse>(&mut stdout);
                let failed = response.is_err();
                if sender.send(response).is_err() || failed {
                    break;
                }
            }
        });
        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LIMIT)));
        let captured = Arc::clone(&stderr_tail);
        let stderr_reader = std::thread::spawn(move || {
            let mut buffer = [0_u8; 8 * 1024];
            while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let Ok(mut tail) = captured.lock() else {
                    break;
                };
                for byte in &buffer[..read] {
                    if tail.len() == STDERR_TAIL_LIMIT {
                        tail.pop_front();
                    }
                    tail.push_back(*byte);
                }
            }
        });
        Ok(Self {
            child,
            _cache_directory: cache_directory,
            stdin,
            responses,
            reader: Some(reader),
            stderr_reader: Some(stderr_reader),
            _stderr_tail: stderr_tail,
            max_text_bytes: 0,
            reaped: false,
        })
    }

    pub(crate) fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub(crate) fn mark_reaped(&mut self) {
        self.reaped = true;
    }

    pub(crate) fn terminate(&mut self) {
        if !self.reaped {
            if self.child.try_wait().is_ok_and(|status| status.is_none()) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
            self.reaped = true;
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub(crate) fn wait_for_response(
    session: &mut WorkerSession,
    control: &RunControl,
    deadline: Instant,
) -> Result<WorkerResponse> {
    loop {
        if control.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(SpeechError::TimedOut {
                timeout: control.timeout(),
            });
        }
        let wait = deadline.saturating_duration_since(now).min(POLL_INTERVAL);
        match session.responses.recv_timeout(wait) {
            Ok(response) => return response,
            Err(RecvTimeoutError::Timeout) => {
                if let Some(status) = session.try_wait().map_err(SpeechError::WorkerIo)? {
                    session.mark_reaped();
                    return Err(SpeechError::WorkerExited {
                        code: status.code(),
                    });
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                let status = session.try_wait().map_err(SpeechError::WorkerIo)?;
                if status.is_some() {
                    session.mark_reaped();
                }
                return Err(SpeechError::WorkerExited {
                    code: status.and_then(|status| status.code()),
                });
            }
        }
    }
}

fn process_io(message: &'static str) -> SpeechError {
    SpeechError::WorkerIo(std::io::Error::other(message))
}
