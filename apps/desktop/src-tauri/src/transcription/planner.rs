use serde::{Deserialize, Serialize};
use thiserror::Error;

pub(crate) const MIN_WINDOW_DURATION_MS: i64 = 30_000;
pub(crate) const MAX_WINDOW_DURATION_MS: i64 = 600_000;
pub(crate) const DEFAULT_WINDOW_DURATION_MS: i64 = 600_000;
const LIVE_PREFIX_CONTEXT_MS: i64 = 3_000;

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
    /// Audio supplied before this window's owned range so server VAD can observe speech that began
    /// across a boundary. Persisted words remain clipped to `start_ms..end_ms`.
    #[serde(default)]
    pub(crate) context_start_ms: i64,
}

impl WindowRange {
    #[must_use]
    pub(crate) const fn new(index: usize, start_ms: i64, end_ms: i64) -> Self {
        Self {
            index,
            start_ms,
            end_ms,
            context_start_ms: start_ms,
        }
    }

    #[must_use]
    pub(crate) const fn duration_ms(&self) -> i64 {
        self.end_ms - self.start_ms
    }

    #[must_use]
    pub(crate) const fn start_us(&self) -> u64 {
        if self.context_start_ms < 0 {
            0
        } else {
            self.context_start_ms.cast_unsigned() * 1_000
        }
    }

    #[must_use]
    pub(crate) const fn duration_us(&self) -> u64 {
        let dur = self.end_ms - self.context_start_ms;
        if dur < 0 {
            0
        } else {
            dur.cast_unsigned() * 1_000
        }
    }
}

/// Long media grows its windows instead of fanning out: a plan stays within this many windows
/// whenever the ten-minute ceiling allows it.
pub(crate) const MAX_PLANNED_WINDOWS: i64 = 120;

/// Partitions `[range_start_ms, range_end_ms]` into balanced, non-overlapping windows.
///
/// The preferred length is clamped to 30 s..=10 min (default 10 min) and grown for long media so
/// the plan stays within [`MAX_PLANNED_WINDOWS`]. Windows differ by at most one millisecond;
/// there is no undersized tail.
pub(crate) fn plan_windows(
    range_start_ms: i64,
    range_end_ms: i64,
    preferred_window_duration_ms: Option<u64>,
) -> Result<Vec<WindowRange>, PlannerError> {
    let total_duration = validated_duration(range_start_ms, range_end_ms)?;
    let target = effective_window_ms(total_duration, preferred_window_duration_ms, 0);
    Ok(partition(range_start_ms, range_end_ms, target))
}

/// Plans Live requests with bounded prefix context while retaining non-overlapping ownership.
/// Balancing against `maximum - context` keeps every physical request within the effective
/// maximum and avoids a tiny final request.
pub(crate) fn plan_live_windows(
    range_start_ms: i64,
    range_end_ms: i64,
    preferred_window_duration_ms: Option<u64>,
) -> Result<Vec<WindowRange>, PlannerError> {
    let total_duration = validated_duration(range_start_ms, range_end_ms)?;
    let maximum = effective_window_ms(
        total_duration,
        preferred_window_duration_ms,
        LIVE_PREFIX_CONTEXT_MS,
    );
    let mut windows = partition(
        range_start_ms,
        range_end_ms,
        maximum - LIVE_PREFIX_CONTEXT_MS,
    );
    for window in windows.iter_mut().skip(1) {
        window.context_start_ms = window
            .start_ms
            .saturating_sub(LIVE_PREFIX_CONTEXT_MS)
            .max(range_start_ms);
    }
    Ok(windows)
}

fn validated_duration(range_start_ms: i64, range_end_ms: i64) -> Result<i64, PlannerError> {
    if range_start_ms < 0 {
        return Err(PlannerError::NegativeStart(range_start_ms));
    }
    if range_end_ms <= range_start_ms {
        return Err(PlannerError::InvalidTimeRange {
            start_ms: range_start_ms,
            end_ms: range_end_ms,
        });
    }
    Ok(range_end_ms - range_start_ms)
}

/// The physical request length: the clamped preference, grown so the owned part of each window
/// (`length - reserved_context_ms`) keeps the plan within [`MAX_PLANNED_WINDOWS`].
fn effective_window_ms(
    total_duration: i64,
    preferred_window_duration_ms: Option<u64>,
    reserved_context_ms: i64,
) -> i64 {
    let requested = preferred_window_duration_ms
        .unwrap_or(DEFAULT_WINDOW_DURATION_MS.cast_unsigned())
        .clamp(
            MIN_WINDOW_DURATION_MS.cast_unsigned(),
            MAX_WINDOW_DURATION_MS.cast_unsigned(),
        )
        .cast_signed();
    let owned_for_cap = (total_duration + MAX_PLANNED_WINDOWS - 1) / MAX_PLANNED_WINDOWS;
    requested
        .max(owned_for_cap + reserved_context_ms)
        .min(MAX_WINDOW_DURATION_MS)
}

fn partition(range_start_ms: i64, range_end_ms: i64, target_ms: i64) -> Vec<WindowRange> {
    let total_duration = range_end_ms - range_start_ms;
    let window_count = (total_duration + target_ms - 1) / target_ms;
    let base_duration = total_duration / window_count;
    let remainder = total_duration % window_count;
    let mut windows = Vec::with_capacity(usize::try_from(window_count).unwrap_or_default());
    let mut current_start = range_start_ms;
    for index in 0..window_count {
        let end_ms = if index + 1 == window_count {
            range_end_ms
        } else {
            current_start + base_duration + i64::from(index < remainder)
        };
        windows.push(WindowRange::new(
            usize::try_from(index).expect("bounded window index fits usize"),
            current_start,
            end_ms,
        ));
        current_start = end_ms;
    }
    windows
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

    #[test]
    fn live_windows_overlap_for_context_but_own_every_millisecond_once() {
        let windows = plan_live_windows(0, 120_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (0, 40_000));
        assert_eq!(windows[0].context_start_ms, 0);
        assert_eq!((windows[1].start_ms, windows[1].end_ms), (40_000, 80_000));
        assert_eq!(windows[1].context_start_ms, 37_000);
        assert_eq!((windows[2].start_ms, windows[2].end_ms), (80_000, 120_000));
        assert_eq!(windows[2].context_start_ms, 77_000);
        assert!(
            windows
                .iter()
                .all(|window| window.duration_us() <= 60_000_000)
        );
        assert!(
            windows
                .windows(2)
                .all(|pair| pair[0].end_ms == pair[1].start_ms)
        );
    }

    #[test]
    fn long_media_grows_windows_instead_of_exceeding_the_window_cap() {
        let ten_hours = 36_000_000;
        // A 30 s preference on ten hours would be 1,200 windows; the plan grows to 300 s.
        let windows = plan_windows(0, ten_hours, Some(30_000)).unwrap();
        assert_eq!(windows.len(), 120);
        assert!(windows.iter().all(|window| window.duration_ms() == 300_000));
        assert_eq!(windows.last().unwrap().end_ms, ten_hours);

        let live = plan_live_windows(0, ten_hours, Some(30_000)).unwrap();
        assert!(live.len() <= 120);
        assert!(
            live.iter()
                .all(|window| window.duration_us() <= 303_000_000)
        );
        assert!(
            live.windows(2)
                .all(|pair| pair[0].end_ms == pair[1].start_ms)
        );

        // Beyond 120 x 10 min the ten-minute ceiling wins; the count grows but stays bounded.
        let day = 86_400_000;
        let windows = plan_windows(0, day, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 144);
        assert!(windows.iter().all(|window| window.duration_ms() <= 600_000));
    }

    #[test]
    fn short_media_keeps_the_requested_window_length() {
        let windows = plan_windows(0, 3_600_000, Some(60_000)).unwrap();
        assert_eq!(windows.len(), 60);
        let live = plan_live_windows(0, 240_000, Some(60_000)).unwrap();
        assert_eq!(live.len(), 5);
    }
}
