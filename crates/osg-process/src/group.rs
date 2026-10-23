use crate::CancellationToken;
use command_group::{CommandGroup, GroupChild};
use std::io;
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A child process group owned by this handle. The whole tree is killed and reaped when the
/// handle is dropped unless the child has already been observed to exit.
#[derive(Debug)]
pub struct ManagedChild {
    child: GroupChild,
    reaped: bool,
}

impl ManagedChild {
    /// Starts `command` without a console window as a new process group (a kill-on-close job
    /// object on Windows), so terminating it also terminates every descendant.
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        let child = command
            .group()
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        #[cfg(not(windows))]
        let child = command.group_spawn()?;
        Ok(Self {
            child,
            reaped: false,
        })
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.inner().stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.inner().stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.inner().stderr.take()
    }

    /// Polls for exit without blocking. An observed exit marks the child reaped.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        self.reaped |= status.is_some();
        Ok(status)
    }

    /// Kills the process tree if it is still running and waits for it.
    pub fn terminate(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        if self.child.try_wait()?.is_none() {
            // Losing a race with a natural exit is fine; `wait` reports either outcome.
            let _ = self.child.kill();
        }
        self.child.wait()?;
        self.reaped = true;
        Ok(())
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

/// How a supervised child finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Supervised {
    Exited(ExitStatus),
    /// Cancellation was requested; the tree has been terminated and reaped.
    Cancelled,
    /// The deadline passed; the tree has been terminated and reaped.
    TimedOut,
}

/// Waits for `child` while honoring `cancellation` and `timeout`. A child that has already exited
/// wins a race with a late cancellation.
pub fn supervise(
    child: &mut ManagedChild,
    cancellation: &CancellationToken,
    timeout: Duration,
) -> io::Result<Supervised> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Supervised::Exited(status));
        }
        if cancellation.is_cancelled() {
            child.terminate()?;
            return Ok(Supervised::Cancelled);
        }
        if started.elapsed() >= timeout {
            child.terminate()?;
            return Ok(Supervised::TimedOut);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
