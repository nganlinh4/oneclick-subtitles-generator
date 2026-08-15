//! A shared stop signal for a decode in progress.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// A cloneable, thread-safe stop signal.
///
/// A long export decodes thousands of source frames and a scrub can start a walk hundreds of frames
/// long, so a decode has to be abandonable from another thread. The token is checked on entry to
/// every request and again on every step of the forward walk, which is what makes cancellation take
/// effect within one frame rather than at the end of the run.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A token that has not been signalled.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Signals every holder of this token to stop.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether the token has been signalled.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
