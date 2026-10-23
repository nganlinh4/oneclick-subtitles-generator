use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// The error [`CancellationToken::check`] returns once the token is signalled.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the operation was cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// A cloneable, lock-free stop signal shared by every holder.
///
/// A linked token also observes other tokens, so one operation can honor both its job
/// cancellation and the lifecycle owner of the runtime it runs on.
#[derive(Clone, Debug)]
pub struct CancellationToken {
    signal: Arc<AtomicBool>,
    observed: Arc<[Arc<AtomicBool>]>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self {
            signal: Arc::new(AtomicBool::new(false)),
            observed: Arc::from([]),
        }
    }
}

impl CancellationToken {
    /// A token that has not been signalled.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Signals every holder of this token, and every token linked to it, to stop.
    pub fn cancel(&self) {
        self.signal.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.signal.load(Ordering::Acquire)
            || self
                .observed
                .iter()
                .any(|signal| signal.load(Ordering::Acquire))
    }

    /// `Err(Cancelled)` once this token, or any token it observes, is signalled.
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.is_cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }

    /// Creates a locally cancellable token that also observes every supplied token.
    #[must_use]
    pub fn linked(tokens: &[Self]) -> Self {
        let observed = tokens
            .iter()
            .flat_map(|token| std::iter::once(&token.signal).chain(token.observed.iter()))
            .cloned()
            .collect();
        Self {
            signal: Arc::new(AtomicBool::new(false)),
            observed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CancellationToken;

    #[test]
    fn a_signal_raised_on_another_thread_is_seen_by_every_clone() {
        let token = CancellationToken::new();
        let remote = token.clone();
        std::thread::spawn(move || remote.cancel()).join().unwrap();
        assert!(token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn check_fails_only_after_a_signal() {
        let token = CancellationToken::new();
        assert_eq!(token.check(), Ok(()));
        token.cancel();
        assert_eq!(token.check(), Err(super::Cancelled));
    }

    #[test]
    fn separate_tokens_do_not_share_state() {
        let one = CancellationToken::new();
        let two = CancellationToken::new();
        one.cancel();
        assert!(!two.is_cancelled());
    }

    #[test]
    fn linked_tokens_observe_their_owners_transitively_but_not_the_reverse() {
        let lifecycle = CancellationToken::new();
        let job = CancellationToken::linked(std::slice::from_ref(&lifecycle));
        let step = CancellationToken::linked(std::slice::from_ref(&job));
        assert!(!step.is_cancelled());
        lifecycle.cancel();
        assert!(job.is_cancelled());
        assert!(step.is_cancelled());

        let owner = CancellationToken::new();
        let child = CancellationToken::linked(std::slice::from_ref(&owner));
        child.cancel();
        assert!(child.is_cancelled());
        assert!(!owner.is_cancelled());
    }
}
