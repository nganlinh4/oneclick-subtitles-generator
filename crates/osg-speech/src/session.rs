use crate::protocol::{WorkerResponse, read_frame};
use crate::{Result, RunControl, SpeechError};
use osg_process::ManagedChild;
use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority, StagingKind};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ExitStatus};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(20);

pub(crate) struct WorkerSession {
    child: ManagedChild,
    _cache_directory: WorkerCacheDirectory,
    pub(crate) stdin: ChildStdin,
    responses: Receiver<Result<WorkerResponse>>,
    reader: Option<JoinHandle<()>>,
    pub(crate) max_text_bytes: usize,
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

    pub(crate) fn begin(&self) -> std::io::Result<WorkerCacheDirectory> {
        OwnedStagingDirectory::begin(&self.authority, &self.root, StagingKind::SpeechWorkerCache)
            .map(WorkerCacheDirectory::Owned)
    }
}

pub(crate) enum WorkerCacheDirectory {
    Temporary(tempfile::TempDir),
    Owned(OwnedStagingDirectory),
}

impl WorkerCacheDirectory {
    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::Temporary(directory) => directory.path(),
            Self::Owned(directory) => directory.path(),
        }
    }
}

impl WorkerSession {
    pub(crate) fn new(
        mut child: ManagedChild,
        cache_directory: WorkerCacheDirectory,
    ) -> Result<Self> {
        let stdin = child
            .take_stdin()
            .ok_or_else(|| process_io("worker stdin is unavailable"))?;
        let mut stdout = child
            .take_stdout()
            .ok_or_else(|| process_io("worker stdout is unavailable"))?;
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
        Ok(Self {
            child,
            _cache_directory: cache_directory,
            stdin,
            responses,
            reader: Some(reader),
            max_text_bytes: 0,
        })
    }

    /// Polls for exit; an observed exit needs no later termination.
    pub(crate) fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub(crate) fn terminate(&mut self) {
        let _ = self.child.terminate();
        if let Some(reader) = self.reader.take() {
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
            Ok(response) => {
                if control.is_cancelled() {
                    return Err(SpeechError::Cancelled);
                }
                return response;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(status) = session.try_wait().map_err(SpeechError::WorkerIo)? {
                    return Err(SpeechError::WorkerExited {
                        code: status.code(),
                    });
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                let status = session.try_wait().map_err(SpeechError::WorkerIo)?;
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
