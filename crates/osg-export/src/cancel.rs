//! Stopping an export in progress.
//!
//! One shared flag, cloneable and thread-safe, so a long export can be abandoned from the thread
//! that started it while the loop is inside a frame. The loop checks it **twice per frame** — once
//! before the source frame is decoded and once before the composed frame is handed to the encoder —
//! so cancellation takes effect within one frame rather than at the end of a phase.
//!
//! What a cancelled export leaves behind is nothing. The encoder removes its own partial file, and
//! it refuses to open over a file that already exists, so there is no path by which a half-written
//! container can be mistaken for a finished export.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// A shared stop signal for an export in progress.
#[derive(Debug, Clone, Default)]
pub struct ExportCancel(Arc<AtomicBool>);

impl ExportCancel {
    /// A signal that has not been raised.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Stops every holder of this signal at its next frame boundary.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether the signal has been raised.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::ExportCancel;

    #[test]
    fn a_signal_raised_on_another_thread_is_seen_here() {
        let token = ExportCancel::new();
        assert!(!token.is_cancelled());

        let remote = token.clone();
        std::thread::spawn(move || remote.cancel())
            .join()
            .expect("the signalling thread finishes");

        assert!(token.is_cancelled());
        // Raising it twice is not an error: a cancellation racing a natural end must be harmless.
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn separate_signals_do_not_share_state() {
        let one = ExportCancel::new();
        let two = ExportCancel::new();
        one.cancel();
        assert!(one.is_cancelled());
        assert!(!two.is_cancelled());
    }
}
