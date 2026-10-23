use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::JobId;

/// One hundred percent expressed in hundredths of a percent.
pub const JOB_PROGRESS_COMPLETE: u16 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    ImportMedia,
    ProbeMedia,
    ProcessMedia,
    GenerateWaveform,
    DownloadMedia,
    ExportMedia,
    Transcribe,
    Translate,
    AnalyzeSubtitles,
    GenerateImage,
    SynthesizeNarration,
    AlignNarration,
    RenderVideo,
    InstallEngine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl JobState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }

    #[must_use]
    pub const fn can_resume(self) -> bool {
        matches!(self, Self::Interrupted)
    }
}

/// Progress in the inclusive range `0..=10_000`, where one unit is 0.01%.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    basis_points: u16,
}

impl JobProgress {
    pub const ZERO: Self = Self { basis_points: 0 };
    pub const COMPLETE: Self = Self {
        basis_points: JOB_PROGRESS_COMPLETE,
    };

    pub fn from_basis_points(basis_points: u16) -> Result<Self, JobProgressError> {
        if basis_points > JOB_PROGRESS_COMPLETE {
            return Err(JobProgressError::OutOfRange { basis_points });
        }
        Ok(Self { basis_points })
    }

    pub fn from_units(completed: u64, total: u64) -> Result<Self, JobProgressError> {
        if total == 0 {
            return Err(JobProgressError::ZeroTotal);
        }
        if completed > total {
            return Err(JobProgressError::CompletedExceedsTotal { completed, total });
        }

        let scaled = u128::from(completed) * u128::from(JOB_PROGRESS_COMPLETE) / u128::from(total);
        let basis_points =
            u16::try_from(scaled).expect("a bounded unit ratio always fits in a u16");
        Ok(Self { basis_points })
    }

    #[must_use]
    pub const fn basis_points(self) -> u16 {
        self.basis_points
    }

    #[must_use]
    pub fn percent(self) -> f64 {
        f64::from(self.basis_points) / 100.0
    }

    #[must_use]
    pub const fn is_complete(self) -> bool {
        self.basis_points == JOB_PROGRESS_COMPLETE
    }
}

impl Default for JobProgress {
    fn default() -> Self {
        Self::ZERO
    }
}

impl fmt::Display for JobProgress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:.2}%", self.percent())
    }
}

impl<'de> Deserialize<'de> for JobProgress {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawProgress {
            basis_points: u16,
        }

        let raw = RawProgress::deserialize(deserializer)?;
        Self::from_basis_points(raw.basis_points).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum JobProgressError {
    #[error(
        "job progress must be at most {JOB_PROGRESS_COMPLETE} basis points (received {basis_points})"
    )]
    OutOfRange { basis_points: u16 },
    #[error("job progress cannot be calculated with a total of zero units")]
    ZeroTotal,
    #[error("completed job units ({completed}) cannot exceed total units ({total})")]
    CompletedExceedsTotal { completed: u64, total: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobMutation {
    Changed,
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobUpdate {
    Start,
    ReportProgress(JobProgress),
    Succeed,
    Fail,
    RequestCancellation,
    ConfirmCancelled,
    Interrupt,
    Requeue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    id: JobId,
    kind: JobKind,
    state: JobState,
    progress: JobProgress,
    sequence: u64,
}

impl JobSnapshot {
    #[must_use]
    pub fn new(kind: JobKind) -> Self {
        Self::with_id(JobId::new(), kind)
    }

    #[must_use]
    pub const fn with_id(id: JobId, kind: JobKind) -> Self {
        Self {
            id,
            kind,
            state: JobState::Queued,
            progress: JobProgress::ZERO,
            sequence: 0,
        }
    }

    pub fn restore(
        id: JobId,
        kind: JobKind,
        state: JobState,
        progress: JobProgress,
        sequence: u64,
    ) -> Result<Self, JobError> {
        validate_snapshot(state, progress, sequence)?;
        Ok(Self {
            id,
            kind,
            state,
            progress,
            sequence,
        })
    }

    #[must_use]
    pub const fn id(&self) -> JobId {
        self.id
    }

    #[must_use]
    pub const fn kind(&self) -> JobKind {
        self.kind
    }

    #[must_use]
    pub const fn state(&self) -> JobState {
        self.state
    }

    #[must_use]
    pub const fn progress(&self) -> JobProgress {
        self.progress
    }

    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn start(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::Start)
    }

    pub fn report_progress(&mut self, progress: JobProgress) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::ReportProgress(progress))
    }

    pub fn succeed(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::Succeed)
    }

    pub fn fail(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::Fail)
    }

    pub fn request_cancellation(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::RequestCancellation)
    }

    pub fn confirm_cancelled(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::ConfirmCancelled)
    }

    pub fn interrupt(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::Interrupt)
    }

    pub fn requeue(&mut self) -> Result<JobMutation, JobError> {
        self.apply(JobUpdate::Requeue)
    }

    /// Applies an update only when the caller observed the current sequence.
    /// This is suitable for optimistic persistence and rejects stale writers.
    pub fn apply_if_sequence(
        &mut self,
        expected_sequence: u64,
        update: JobUpdate,
    ) -> Result<JobMutation, JobError> {
        if expected_sequence != self.sequence {
            return Err(JobError::StaleSequence {
                expected: expected_sequence,
                actual: self.sequence,
            });
        }
        self.apply(update)
    }

    pub fn apply(&mut self, update: JobUpdate) -> Result<JobMutation, JobError> {
        match update {
            JobUpdate::Start => self.transition(JobState::Running, None),
            JobUpdate::ReportProgress(progress) => self.set_progress(progress),
            JobUpdate::Succeed => self.transition(JobState::Succeeded, Some(JobProgress::COMPLETE)),
            JobUpdate::Fail => self.transition(JobState::Failed, None),
            JobUpdate::RequestCancellation => self.request_cancellation_inner(),
            JobUpdate::ConfirmCancelled => self.confirm_cancelled_inner(),
            JobUpdate::Interrupt => self.interrupt_inner(),
            JobUpdate::Requeue => self.requeue_inner(),
        }
    }

    fn set_progress(&mut self, progress: JobProgress) -> Result<JobMutation, JobError> {
        if self.state.is_terminal() {
            return Err(JobError::TerminalState { state: self.state });
        }
        if self.state != JobState::Running {
            return Err(JobError::InvalidTransition {
                from: self.state,
                to: self.state,
            });
        }
        if progress < self.progress {
            return Err(JobError::ProgressRegression {
                current: self.progress,
                attempted: progress,
            });
        }
        if progress == self.progress {
            return Ok(JobMutation::Unchanged);
        }

        let next_sequence = self.next_sequence()?;
        self.progress = progress;
        self.sequence = next_sequence;
        Ok(JobMutation::Changed)
    }

    fn request_cancellation_inner(&mut self) -> Result<JobMutation, JobError> {
        if matches!(self.state, JobState::Cancelling | JobState::Cancelled) {
            return Ok(JobMutation::Unchanged);
        }
        if self.state.is_terminal() {
            return Err(JobError::TerminalState { state: self.state });
        }
        if self.state == JobState::Queued {
            self.transition(JobState::Cancelled, None)
        } else {
            self.transition(JobState::Cancelling, None)
        }
    }

    fn confirm_cancelled_inner(&mut self) -> Result<JobMutation, JobError> {
        if self.state == JobState::Cancelled {
            return Ok(JobMutation::Unchanged);
        }
        if self.state.is_terminal() {
            return Err(JobError::TerminalState { state: self.state });
        }
        if self.state != JobState::Cancelling {
            return Err(JobError::InvalidTransition {
                from: self.state,
                to: JobState::Cancelled,
            });
        }
        self.transition(JobState::Cancelled, None)
    }

    fn interrupt_inner(&mut self) -> Result<JobMutation, JobError> {
        if self.state == JobState::Interrupted {
            return Ok(JobMutation::Unchanged);
        }
        self.transition(JobState::Interrupted, None)
    }

    fn requeue_inner(&mut self) -> Result<JobMutation, JobError> {
        if !self.state.can_resume() {
            return Err(JobError::InvalidTransition {
                from: self.state,
                to: JobState::Queued,
            });
        }
        let next_sequence = self.next_sequence()?;
        self.state = JobState::Queued;
        self.progress = JobProgress::ZERO;
        self.sequence = next_sequence;
        Ok(JobMutation::Changed)
    }

    fn transition(
        &mut self,
        next_state: JobState,
        next_progress: Option<JobProgress>,
    ) -> Result<JobMutation, JobError> {
        if self.state.is_terminal() {
            return Err(JobError::TerminalState { state: self.state });
        }
        if !is_legal_transition(self.state, next_state) {
            return Err(JobError::InvalidTransition {
                from: self.state,
                to: next_state,
            });
        }

        let next_sequence = self.next_sequence()?;
        self.state = next_state;
        if let Some(progress) = next_progress {
            self.progress = progress;
        }
        self.sequence = next_sequence;
        Ok(JobMutation::Changed)
    }

    fn next_sequence(&self) -> Result<u64, JobError> {
        self.sequence
            .checked_add(1)
            .ok_or(JobError::SequenceExhausted)
    }
}

impl<'de> Deserialize<'de> for JobSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawSnapshot {
            id: JobId,
            kind: JobKind,
            state: JobState,
            progress: JobProgress,
            sequence: u64,
        }

        let raw = RawSnapshot::deserialize(deserializer)?;
        Self::restore(raw.id, raw.kind, raw.state, raw.progress, raw.sequence)
            .map_err(serde::de::Error::custom)
    }
}

fn is_legal_transition(from: JobState, to: JobState) -> bool {
    matches!(
        (from, to),
        (
            JobState::Queued,
            JobState::Running | JobState::Failed | JobState::Cancelled
        ) | (
            JobState::Running,
            JobState::Cancelling | JobState::Succeeded | JobState::Failed | JobState::Interrupted
        ) | (
            JobState::Cancelling,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled | JobState::Interrupted
        )
    )
}

fn validate_snapshot(
    state: JobState,
    progress: JobProgress,
    sequence: u64,
) -> Result<(), JobError> {
    let valid = match state {
        JobState::Queued => progress == JobProgress::ZERO,
        JobState::Succeeded => sequence >= 2 && progress == JobProgress::COMPLETE,
        JobState::Running
        | JobState::Cancelling
        | JobState::Failed
        | JobState::Cancelled
        | JobState::Interrupted => sequence >= 1,
    };
    if valid {
        Ok(())
    } else {
        Err(JobError::InvalidSnapshot {
            state,
            progress,
            sequence,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum JobError {
    #[error("cannot mutate a terminal {state:?} job")]
    TerminalState { state: JobState },
    #[error("illegal job transition from {from:?} to {to:?}")]
    InvalidTransition { from: JobState, to: JobState },
    #[error("job progress cannot move backwards from {current} to {attempted}")]
    ProgressRegression {
        current: JobProgress,
        attempted: JobProgress,
    },
    #[error("stale job sequence: expected {expected}, current sequence is {actual}")]
    StaleSequence { expected: u64, actual: u64 },
    #[error("job sequence is exhausted")]
    SequenceExhausted,
    #[error(
        "invalid persisted job snapshot: state {state:?}, progress {progress}, sequence {sequence}"
    )]
    InvalidSnapshot {
        state: JobState,
        progress: JobProgress,
        sequence: u64,
    },
}

#[cfg(test)]
mod tests;
