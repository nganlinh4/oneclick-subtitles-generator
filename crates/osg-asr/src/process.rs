use crate::protocol::{ReaderMessage, WireRequest, read_event, write_request};
use crate::{AsrError, Result, WorkerProgram};
use osg_process::ManagedChild;
use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority, StagingKind};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ExitStatus};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::time::Duration;

const EVENT_QUEUE_CAPACITY: usize = 4;

pub(crate) struct WorkerSession {
    // Declared first so the process tree is gone before its cache directory is removed.
    child: ManagedChild,
    _cache_directory: WorkerCacheDirectory,
    stdin: ChildStdin,
    receiver: Receiver<ReaderMessage>,
}

#[derive(Clone)]
pub(crate) struct WorkerCacheStaging {
    authority: RuntimeStagingAuthority,
    root: PathBuf,
}

impl WorkerCacheStaging {
    pub(crate) fn new(authority: RuntimeStagingAuthority, root: impl AsRef<Path>) -> Self {
        Self {
            authority,
            root: root.as_ref().to_owned(),
        }
    }

    fn begin(&self) -> std::io::Result<WorkerCacheDirectory> {
        OwnedStagingDirectory::begin(&self.authority, &self.root, StagingKind::AsrWorkerCache)
            .map(WorkerCacheDirectory::Owned)
    }
}

enum WorkerCacheDirectory {
    Temporary(tempfile::TempDir),
    Owned(OwnedStagingDirectory),
}

impl WorkerCacheDirectory {
    fn path(&self) -> &Path {
        match self {
            Self::Temporary(directory) => directory.path(),
            Self::Owned(directory) => directory.path(),
        }
    }
}

#[derive(Debug)]
pub(crate) enum SessionPoll {
    Message(ReaderMessage),
    Empty,
    Disconnected,
}

impl WorkerSession {
    pub(crate) fn spawn(
        program: &WorkerProgram,
        staging: Option<&WorkerCacheStaging>,
    ) -> Result<Self> {
        let cache_directory = match staging {
            Some(staging) => staging.begin().map_err(AsrError::Spawn)?,
            None => tempfile::Builder::new()
                .prefix("osg-asr-worker-")
                .tempdir()
                .map(WorkerCacheDirectory::Temporary)
                .map_err(AsrError::Spawn)?,
        };
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
        let mut child = ManagedChild::spawn(&mut command).map_err(AsrError::Spawn)?;
        let stdin = child
            .take_stdin()
            .ok_or_else(|| process_io("stdin unavailable"))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| process_io("stdout unavailable"))?;

        let (sender, receiver) = sync_channel(EVENT_QUEUE_CAPACITY);
        std::thread::spawn(move || read_stdout(stdout, &sender));

        Ok(Self {
            child,
            _cache_directory: cache_directory,
            stdin,
            receiver,
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
        let _ = self.child.terminate();
    }
}

impl std::fmt::Debug for WorkerSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerSession")
            .field("process", &"<managed>")
            .finish_non_exhaustive()
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

fn process_io(message: &'static str) -> AsrError {
    AsrError::ProcessIo {
        action: "process setup",
        source: std::io::Error::other(message),
    }
}
