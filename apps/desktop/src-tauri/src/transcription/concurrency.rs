//! Concurrency bounds for one transcription run.
//!
//! Every planned window is admitted as its own task, but at most `provider_sessions` of them
//! hold a provider session at once, and only `extraction_slots` run ffmpeg at a time. Each
//! credential's client is further capped at `sessions_per_credential` in-flight requests.

use std::num::NonZeroUsize;

/// Gemini accepted eight simultaneous Live sockets per key and rejected the rest.
pub(crate) const MAX_SESSIONS_PER_CREDENTIAL: usize = 8;
/// Hard ceiling across all credentials; bounds sockets and buffered window audio.
pub(crate) const MAX_PROVIDER_SESSIONS: usize = 32;
const MIN_EXTRACTION_SLOTS: usize = 2;
const MAX_EXTRACTION_SLOTS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConcurrencyPlan {
    /// Simultaneous local ffmpeg window extractions.
    pub(crate) extraction_slots: usize,
    /// Simultaneous provider sessions across every credential.
    pub(crate) provider_sessions: usize,
    /// In-flight requests one credential's client may hold.
    pub(crate) sessions_per_credential: usize,
}

impl ConcurrencyPlan {
    /// The user's choice is the planned window count: all windows run at once when the
    /// credential pool and the hard caps allow it.
    #[must_use]
    pub(crate) fn new(
        total_windows: usize,
        credential_count: usize,
        available_parallelism: usize,
    ) -> Self {
        let windows = total_windows.max(1);
        let credentials = credential_count.max(1);
        let sessions_per_credential = windows
            .div_ceil(credentials)
            .min(MAX_SESSIONS_PER_CREDENTIAL);
        let provider_sessions = windows
            .min(credentials.saturating_mul(sessions_per_credential))
            .min(MAX_PROVIDER_SESSIONS);
        let extraction_slots =
            (available_parallelism / 2).clamp(MIN_EXTRACTION_SLOTS, MAX_EXTRACTION_SLOTS);
        Self {
            extraction_slots,
            provider_sessions,
            sessions_per_credential,
        }
    }

    #[must_use]
    pub(crate) fn for_host(total_windows: usize, credential_count: usize) -> Self {
        let parallelism = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);
        Self::new(total_windows, credential_count, parallelism)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_plans_run_every_window_at_once() {
        let plan = ConcurrencyPlan::new(4, 4, 16);
        assert_eq!(plan.provider_sessions, 4);
        assert_eq!(plan.sessions_per_credential, 1);
        let one_key = ConcurrencyPlan::new(5, 1, 16);
        assert_eq!(one_key.provider_sessions, 5);
        assert_eq!(one_key.sessions_per_credential, 5);
    }

    #[test]
    fn provider_sessions_are_capped_per_credential_and_in_total() {
        let one_key = ConcurrencyPlan::new(1_200, 1, 16);
        assert_eq!(one_key.sessions_per_credential, MAX_SESSIONS_PER_CREDENTIAL);
        assert_eq!(one_key.provider_sessions, MAX_SESSIONS_PER_CREDENTIAL);

        let many_keys = ConcurrencyPlan::new(1_200, 20, 16);
        assert_eq!(
            many_keys.sessions_per_credential,
            MAX_SESSIONS_PER_CREDENTIAL
        );
        assert_eq!(many_keys.provider_sessions, MAX_PROVIDER_SESSIONS);

        let spread = ConcurrencyPlan::new(10, 20, 16);
        assert_eq!(spread.sessions_per_credential, 1);
        assert_eq!(spread.provider_sessions, 10);
    }

    #[test]
    fn extraction_is_a_small_host_derived_bound() {
        assert_eq!(ConcurrencyPlan::new(100, 1, 1).extraction_slots, 2);
        assert_eq!(ConcurrencyPlan::new(100, 1, 6).extraction_slots, 3);
        assert_eq!(ConcurrencyPlan::new(100, 1, 64).extraction_slots, 4);
        let host = ConcurrencyPlan::for_host(100, 1).extraction_slots;
        assert!((2..=4).contains(&host));
    }

    #[test]
    fn degenerate_inputs_still_admit_one_session() {
        let plan = ConcurrencyPlan::new(0, 0, 0);
        assert_eq!(plan.provider_sessions, 1);
        assert_eq!(plan.sessions_per_credential, 1);
    }
}
