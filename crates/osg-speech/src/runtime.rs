use crate::{Result, SegmentId, SpeechError};
use serde::Serialize;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechPhase {
    StartingWorker,
    LoadingModel,
    Synthesizing,
    Encoding,
    Publishing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpeechProgress {
    segment_id: Option<SegmentId>,
    phase: SpeechPhase,
    fraction_millionths: u32,
}

impl SpeechProgress {
    pub(crate) fn new(
        segment_id: Option<SegmentId>,
        phase: SpeechPhase,
        fraction_millionths: u32,
    ) -> Result<Self> {
        if fraction_millionths > 1_000_000 {
            return Err(SpeechError::Protocol("progress fraction is out of range"));
        }
        Ok(Self {
            segment_id,
            phase,
            fraction_millionths,
        })
    }

    #[must_use]
    pub fn segment_id(&self) -> Option<&SegmentId> {
        self.segment_id.as_ref()
    }

    #[must_use]
    pub fn phase(&self) -> SpeechPhase {
        self.phase
    }

    #[must_use]
    pub fn fraction_millionths(&self) -> u32 {
        self.fraction_millionths
    }
}

pub trait SpeechProgressSink: Send + Sync {
    fn on_progress(&self, progress: &SpeechProgress);
}

impl<F> SpeechProgressSink for F
where
    F: Fn(&SpeechProgress) + Send + Sync,
{
    fn on_progress(&self, progress: &SpeechProgress) {
        self(progress);
    }
}

#[derive(Clone)]
pub struct RunControl {
    timeout: Duration,
    cancellation: CancellationToken,
    progress: Option<Arc<dyn SpeechProgressSink>>,
}

impl RunControl {
    pub fn new(timeout: Duration) -> Result<Self> {
        if timeout.is_zero() || timeout > Duration::from_hours(168) {
            return Err(SpeechError::InvalidOption(
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
        P: SpeechProgressSink + 'static,
    {
        self.progress = Some(Arc::new(progress));
        self
    }

    #[must_use]
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub(crate) fn emit(&self, progress: &SpeechProgress) {
        if let Some(sink) = &self.progress {
            // A UI callback must not poison the worker-state mutex or strand a
            // model process. Progress is observational, so callback panics are
            // isolated from the operation itself.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                sink.on_progress(progress);
            }));
        }
    }
}

impl fmt::Debug for RunControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunControl")
            .field("timeout", &self.timeout)
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("progress", &self.progress.is_some())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_shared_and_lock_free() {
        let first = CancellationToken::default();
        let second = first.clone();
        second.cancel();
        assert!(first.is_cancelled());
    }

    #[test]
    fn timeout_is_bounded() {
        assert!(RunControl::new(Duration::ZERO).is_err());
        assert!(RunControl::new(Duration::from_secs(1)).is_ok());
        assert!(RunControl::new(Duration::from_hours(168) + Duration::from_secs(1)).is_err());
    }

    #[test]
    fn debug_reports_state_without_callback_details() {
        let control = RunControl::new(Duration::from_secs(2))
            .unwrap()
            .with_progress(|_: &SpeechProgress| {});
        let debug = format!("{control:?}");
        assert!(debug.contains("progress: true"));
    }
}
