use serde::{Deserialize, Serialize};
use thiserror::Error;

pub(crate) const MIN_WINDOW_DURATION_MS: i64 = 30_000;
pub(crate) const MAX_WINDOW_DURATION_MS: i64 = 600_000;
pub(crate) const DEFAULT_WINDOW_DURATION_MS: i64 = 600_000;

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
/// - Windows are bounded between 30,000ms and 600,000ms.
/// - Default target window duration is 600,000ms.
/// - If the total duration is less than or equal to the target, a single window is returned.
/// - The selected maximum is strict.
/// - Multi-window ranges are balanced to within one millisecond; there is no undersized tail.
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

    let window_count = total_duration / target_w + i64::from(total_duration % target_w != 0);
    let window_count_usize = usize::try_from(window_count)
        .expect("a positive millisecond range has a representable window count");
    let base_duration = total_duration / window_count;
    let remainder = total_duration % window_count;
    let mut windows = Vec::with_capacity(window_count_usize);
    let mut current_start = range_start_ms;
    for index in 0..window_count {
        let duration = base_duration + i64::from(index < remainder);
        let end_ms = if index + 1 == window_count {
            range_end_ms
        } else {
            current_start + duration
        };
        windows.push(WindowRange {
            index: usize::try_from(index).expect("bounded window index fits usize"),
            start_ms: current_start,
            end_ms,
        });
        current_start = end_ms;
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
    fn test_non_multiple_ranges_are_balanced_without_a_short_tail() {
        let windows = plan_windows(0, 63_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 31_500));
        assert_eq!(windows[1], WindowRange::new(1, 31_500, 63_000));

        let windows2 = plan_windows(0, 123_000, Some(60_000)).unwrap();
        assert_eq!(windows2.len(), 3);
        assert_eq!(windows2[0], WindowRange::new(0, 0, 41_000));
        assert_eq!(windows2[1], WindowRange::new(1, 41_000, 82_000));
        assert_eq!(windows2[2], WindowRange::new(2, 82_000, 123_000));
    }

    #[test]
    fn test_balancing_distributes_rounding_without_gaps() {
        let windows = plan_windows(0, 66_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 33_000));
        assert_eq!(windows[1], WindowRange::new(1, 33_000, 66_000));

        let odd = plan_windows(10, 63_011, Some(60_000)).unwrap();
        assert_eq!(odd[0], WindowRange::new(0, 10, 31_511));
        assert_eq!(odd[1], WindowRange::new(1, 31_511, 63_011));
    }

    #[test]
    fn test_preferred_window_clamping() {
        // Preferred 20s clamped to 30s
        let windows = plan_windows(0, 60_000, Some(20_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 30_000));
        assert_eq!(windows[1], WindowRange::new(1, 30_000, 60_000));

        // Requests up to ten minutes retain the selected limit.
        let windows = plan_windows(0, 1_200_000, Some(600_000)).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], WindowRange::new(0, 0, 600_000));
        assert_eq!(windows[1], WindowRange::new(1, 600_000, 1_200_000));
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
