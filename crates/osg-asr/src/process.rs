use crate::protocol::{ReaderMessage, WireRequest, read_event, write_request};
use crate::{AsrError, Result, WorkerProgram};
use command_group::{CommandGroup, GroupChild};
use std::collections::VecDeque;
use std::io::{BufReader, Read};
use std::process::{ChildStdin, ExitStatus};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const EVENT_QUEUE_CAPACITY: usize = 4;
const STDERR_TAIL_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) struct WorkerSession {
    child: GroupChild,
    _cache_directory: tempfile::TempDir,
    stdin: ChildStdin,
    receiver: Receiver<ReaderMessage>,
    _stderr_tail: Arc<Mutex<VecDeque<u8>>>,
    reaped: bool,
}

#[derive(Debug)]
pub(crate) enum SessionPoll {
    Message(ReaderMessage),
    Empty,
    Disconnected,
}

impl WorkerSession {
    pub(crate) fn spawn(program: &WorkerProgram) -> Result<Self> {
        let cache_directory = tempfile::Builder::new()
            .prefix("osg-asr-worker-")
            .tempdir()
            .map_err(AsrError::Spawn)?;
        let mut command = program.command();
        command.envs([
            (
                "TORCHINDUCTOR_CACHE_DIR",
                cache_directory.path().as_os_str(),
            ),
            ("NUMBA_CACHE_DIR", cache_directory.path().as_os_str()),
            ("USERNAME", std::ffi::OsStr::new("osg-worker")),
            ("USER", std::ffi::OsStr::new("osg-worker")),
            ("LOGNAME", std::ffi::OsStr::new("osg-worker")),
        ]);
        #[cfg(windows)]
        let child = command
            .group()
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        #[cfg(not(windows))]
        let child = command.group_spawn();
        let mut child = child.map_err(AsrError::Spawn)?;
        let stdin = child
            .inner()
            .stdin
            .take()
            .ok_or_else(|| process_io("stdin unavailable"))?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| process_io("stdout unavailable"))?;
        let stderr = child
            .inner()
            .stderr
            .take()
            .ok_or_else(|| process_io("stderr unavailable"))?;

        let (sender, receiver) = sync_channel(EVENT_QUEUE_CAPACITY);
        std::thread::spawn(move || read_stdout(stdout, &sender));
        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_BYTES)));
        let capture = stderr_tail.clone();
        std::thread::spawn(move || drain_stderr(stderr, &capture));

        Ok(Self {
            child,
            _cache_directory: cache_directory,
            stdin,
            receiver,
            _stderr_tail: stderr_tail,
            reaped: false,
        })
    }

    pub(crate) fn send(&mut self, request: &WireRequest<'_>) -> Result<()> {
        write_request(&mut self.stdin, request)
    }

    pub(crate) fn receive(&self, timeout: Duration) -> SessionPoll {
        match self.receiver.recv_timeout(timeout) {
            Ok(message) => SessionPoll::Message(message),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => SessionPoll::Empty,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => SessionPoll::Disconnected,
        }
    }

    pub(crate) fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        self.child.try_wait().map_err(|source| AsrError::ProcessIo {
            action: "process status",
            source,
        })
    }

    pub(crate) fn terminate(&mut self) {
        if self.reaped {
            return;
        }
        if self.child.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.reaped = true;
    }
}

impl std::fmt::Debug for WorkerSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerSession")
            .field("process", &"<managed>")
            .field("reaped", &self.reaped)
            .finish_non_exhaustive()
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn read_stdout(stdout: impl Read, sender: &SyncSender<ReaderMessage>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let message = match read_event(&mut reader) {
            Ok(Some(event)) => ReaderMessage::Event(event),
            Ok(None) => return,
            Err(error) => ReaderMessage::Failed(error),
        };
        match sender.try_send(message) {
            Ok(()) => {}
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => return,
        }
    }
}

fn drain_stderr(mut stderr: impl Read, tail: &Mutex<VecDeque<u8>>) {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let Ok(read) = stderr.read(&mut buffer) else {
            return;
        };
        if read == 0 {
            return;
        }
        let Ok(mut tail) = tail.lock() else {
            return;
        };
        for byte in &buffer[..read] {
            if tail.len() == STDERR_TAIL_BYTES {
                tail.pop_front();
            }
            tail.push_back(*byte);
        }
    }
}

fn process_io(message: &'static str) -> AsrError {
    AsrError::ProcessIo {
        action: "process setup",
        source: std::io::Error::other(message),
    }
}
