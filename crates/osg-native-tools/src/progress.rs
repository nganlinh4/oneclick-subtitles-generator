use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationPhase {
    Preparing,
    Downloading,
    Verifying,
    Extracting,
    Publishing,
    Removing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub phase: OperationPhase,
    pub basis_points: u16,
    pub bytes_done: u64,
    pub total_bytes: u64,
}

impl OperationProgress {
    pub(crate) fn new(phase: OperationPhase, bytes_done: u64, total_bytes: u64) -> Self {
        let basis_points = u16::try_from(
            bytes_done
                .min(total_bytes)
                .saturating_mul(10_000)
                .checked_div(total_bytes.max(1))
                .unwrap_or(0),
        )
        .unwrap_or(10_000);
        Self {
            phase,
            basis_points,
            bytes_done,
            total_bytes,
        }
    }
}

pub trait ProgressSink: Send + Sync {
    fn on_progress(&self, progress: OperationProgress);
}

impl<F> ProgressSink for F
where
    F: Fn(OperationProgress) + Send + Sync,
{
    fn on_progress(&self, progress: OperationProgress) {
        self(progress);
    }
}
