use serde::{Deserialize, Serialize};
use thiserror::Error;

pub(crate) const MIN_WINDOW_DURATION_MS: i64 = 30_000;
pub(crate) const MAX_WINDOW_DURATION_MS: i64 = 120_000;
pub(crate) const DEFAULT_WINDOW_DURATION_MS: i64 = 60_000;
pub(crate) const TAIL_MERGE_THRESHOLD_MS: i64 = 5_000;

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum PlannerError {
    #[error("invalid time range: start ({start_ms}ms) must be strictly less than end ({end_ms}ms)")]
    InvalidTimeRange { start_ms: i64, end_ms: i64 },
    #[error("time range start cannot be negative: {0}ms")]
    NegativeStart(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowRange {
    pub(crate) index: usize,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
}

impl WindowRange {
    #[allow(dead_code)]
    #[must_use]
    pub(crate) const fn new(index: usize, start_ms: i64, end_ms: i64) -> Self {
        Self {
            index,
            start_ms,
            end_ms,
        }
    }

    #[must_use]
    pub(crate) const fn duration_ms(&self) -> i64 {
        self.end_ms - self.start_ms
    }

    #[must_use]
    pub(crate) const fn start_us(&self) -> u64 {
        if self.start_ms < 0 {
            0
        } else {
            self.start_ms.cast_unsigned() * 1_000
        }
    }

    #[must_use]
    pub(crate) const fn duration_us(&self) -> u64 {
        let dur = self.duration_ms();
        if dur < 0 {
            0
        } else {
            dur.cast_unsigned() * 1_000
        }
    }

    #[allow(dead_code)]
    #[must_use]
    pub(crate) const fn end_us(&self) -> u64 {
        if self.end_ms < 0 {
            0
        } else {
            self.end_ms.cast_unsigned() * 1_000
        }
    }
}

/// Partitions a time range `[range_start_ms, range_end_ms]` into bounded, non-overlapping windows.
///
/// Constraints:
/// - Windows are bounded between 30,000ms and 120,000ms.
/// - Default target window duration is 60,000ms.
/// - If the total duration is less than or equal to the target, a single window is returned.
/// - Smart tail merge: if the remainder after splitting is strictly less than 5,000ms, and the
///   combined window does not exceed 120,000ms, the remainder is merged into the preceding window.
pub(crate) fn plan_windows(
    range_start_ms: i64,
    range_end_ms: i64,
    preferred_window_duration_ms: Option<u64>,
) -> Result<Vec<WindowRange>, PlannerError> {
    if range_start_ms < 0 {
        return Err(PlannerError::NegativeStart(range_start_ms));
    }
    if range_end_ms <= range_start_ms {
        return Err(PlannerError::InvalidTimeRange {
            start_ms: range_start_ms,
            end_ms: range_end_ms,
        });
    }

    let target_w = preferred_window_duration_ms
        .unwrap_or(DEFAULT_WINDOW_DURATION_MS as u64)
        .clamp(MIN_WINDOW_DURATION_MS as u64, MAX_WINDOW_DURATION_MS as u64)
        .cast_signed();
    let total_duration = range_end_ms - range_start_ms;

    if total_duration <= target_w {
        return Ok(vec![WindowRange {
            index: 0,
            start_ms: range_start_ms,
            end_ms: range_end_ms,
        }]);
    }

    let mut windows = Vec::new();
    let mut current_start = range_start_ms;
    let mut index = 0;

    while current_start < range_end_ms {
        let remaining = range_end_ms - current_start;
        if remaining <= target_w {
            windows.push(WindowRange {
                index,
                start_ms: current_start,
                end_ms: range_end_ms,
            });
            break;
        }

        // Tail merge check: if the NEXT remainder would be < 5s and can fit in 120s
        let next_remainder = remaining - target_w;
        if next_remainder < TAIL_MERGE_THRESHOLD_MS && (target_w + next_remainder) <= MAX_WINDOW_DURATION_MS {
            windows.push(WindowRange {
                index,
                start_ms: current_start,
                end_ms: range_end_ms,
            });
            break;
        }

        windows.push(WindowRange {
            index,
            start_ms: current_start,
            end_ms: current_start + target_w,
        });
        current_start += target_w;
        index += 1;
    }

    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_window_under_target() {
        let windows = plan_windows(0, 45_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0], WindowRange::new(0, 0, 45_000));
        assert_eq!(windows[0].duration_ms(), 45_000);
        assert_eq!(windows[0].duration_us(), 45_000_000);
    }

    #[test]
    fn test_exact_multiples() {
        let windows = plan_windows(10_000, 130_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 10_000, 70_000));
        assert_eq!(windows[1], WindowRange::new(1, 70_000, 130_000));
    }

    #[test]
    fn test_tail_merge_under_5s() {
        // Total duration 63s (remainder 3s < 5s): merges into single window of 63s (<= 120s)
        let windows = plan_windows(0, 63_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0], WindowRange::new(0, 0, 63_000));

        // Total duration 123s: first window 60s, remainder 63s -> next window 60s would leave 3s (< 5s),
        // so second window is 63s (<= 120s)
        let windows2 = plan_windows(0, 123_000, Some(60_000)).unwrap();
        assert_eq!(windows2.len(), 2);
        assert_eq!(windows2[0], WindowRange::new(0, 0, 60_000));
        assert_eq!(windows2[1], WindowRange::new(1, 60_000, 123_000));
    }

    #[test]
    fn test_remainder_above_or_equal_5s_not_merged() {
        // Total duration 66s (remainder 6s >= 5s): two windows [0, 60s], [60s, 66s]
        let windows = plan_windows(0, 66_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 60_000));
        assert_eq!(windows[1], WindowRange::new(1, 60_000, 66_000));
    }

    #[test]
    fn test_preferred_window_clamping() {
        // Preferred 20s clamped to 30s
        let windows = plan_windows(0, 60_000, Some(20_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 30_000));
        assert_eq!(windows[1], WindowRange::new(1, 30_000, 60_000));

        // Preferred 150s clamped to 120s
        let windows = plan_windows(0, 240_000, Some(150_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 120_000));
        assert_eq!(windows[1], WindowRange::new(1, 120_000, 240_000));
    }

    #[test]
    fn test_invalid_ranges() {
        assert!(matches!(
            plan_windows(100, 100, None),
            Err(PlannerError::InvalidTimeRange { .. })
        ));
        assert!(matches!(
            plan_windows(100, 50, None),
            Err(PlannerError::InvalidTimeRange { .. })
        ));
        assert!(matches!(
            plan_windows(-1, 50, None),
            Err(PlannerError::NegativeStart(-1))
        ));
    }
}
