//! One observable authority for whether the managed subtitle font can be drawn.
//!
//! WHY THIS EXISTS. Readiness used to be a single boolean, defined on the `WebView` at startup with
//! `Object.defineProperty` and therefore not writable. Preparation waits a bounded time; if the wait
//! expired the boolean was fixed at `false` for the entire session even when the background
//! installation finished a second later. Nothing could correct it, nothing reported why, and the
//! editor showed a preview that would never arrive. A capability that can change has to be a state
//! with a version, not a constant.
//!
//! WHAT IT GUARANTEES. Every observer sees a monotonically increasing epoch and a typed state. A
//! late repair advances the epoch, so a consumer can tell a fresh answer from one it already acted
//! on and can discard work owned by an older epoch. Refusals carry a bounded machine-readable reason
//! and say whether retrying could plausibly help, so the interface can offer an action instead of an
//! apology. No path publishes `Ready` before the bytes are installed and verified.
//!
//! WHAT IT DELIBERATELY DOES NOT CARRY. Paths, font bytes, package URLs and delivery-layer error
//! text never cross this boundary; the reason is a closed enum. Everything here is safe to render,
//! to log, and to capture in test evidence.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

/// Bumped only when the serialized shape changes in a way a consumer must notice.
pub(crate) const FONT_READINESS_SCHEMA: u32 = 1;

/// The family this authority speaks for: the default subtitle face.
///
/// Named here rather than passed in, so native and the frontend cannot disagree about which font a
/// readiness record describes.
pub(crate) const MANAGED_SUBTITLE_FAMILY: &str = "Google Sans";

/// The event the `WebView` listens on. Named for the capability, not for the feature that wants it.
pub(crate) const FONT_READINESS_EVENT: &str = "osg://font-readiness";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FontState {
    /// Being resolved for the first time. Show waiting, never failure.
    Resolving,
    /// A previous attempt failed and another is running. Also waiting, but says work is happening.
    Repairing,
    /// Installed, verified, and its stylesheet is available to the `WebView`.
    Ready,
    /// Cannot be drawn. Carries why, and whether retrying is worth offering.
    Refused,
}

/// Why the managed font cannot be drawn, in terms a person can act on.
///
/// Closed on purpose. A delivery error message can name a path or a URL, and this value is rendered
/// in the editor, written to diagnostics, and captured in test evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FontRefusal {
    /// Nothing to install from: neither the shipped bytes nor any reviewed source was usable.
    NoUsableSource,
    /// Bytes were obtained but did not match the digest the catalog pins.
    IntegrityFailed,
    /// The store could not be read or written; usually permissions or a full disk.
    StoreUnavailable,
    /// Installed, but not the version this build requires.
    VersionMismatch,
    /// Preparation was still running when the application decided to stop waiting.
    TimedOut,
    /// Shutdown or an explicit cancellation ended the attempt.
    Cancelled,
}

impl FontRefusal {
    /// Whether trying again could plausibly succeed without the user changing anything else.
    ///
    /// A digest mismatch is not retryable by this rule even though retrying would re-fetch: the same
    /// pinned digest against the same reviewed source fails the same way, and offering a button that
    /// cannot work is worse than stating the cause.
    const fn retryable(self) -> bool {
        matches!(
            self,
            Self::NoUsableSource | Self::TimedOut | Self::StoreUnavailable
        )
    }
}

/// A snapshot safe to serialize to the `WebView`, to a log, or into test evidence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FontReadinessRecord {
    pub schema: u32,
    /// Increases on every published change. Consumers compare it to detect a stale answer.
    pub epoch: u64,
    pub state: FontState,
    /// The family this authority speaks for, so a consumer never has to assume which font is meant.
    pub family: &'static str,
    /// Present once installed and verified.
    pub version: Option<String>,
    /// Present only when refused.
    pub reason: Option<FontRefusal>,
    /// Present only when refused. `false` means offer a cause, not a button.
    pub retryable: bool,
}

impl FontReadinessRecord {
    fn new(state: FontState, family: &'static str) -> Self {
        Self {
            schema: FONT_READINESS_SCHEMA,
            epoch: 0,
            state,
            family,
            version: None,
            reason: None,
            retryable: false,
        }
    }
}

/// The authority. One per application; every reader and writer goes through it.
#[derive(Debug)]
pub(crate) struct FontReadiness {
    family: &'static str,
    epoch: AtomicU64,
    current: Mutex<FontReadinessRecord>,
}

impl FontReadiness {
    pub(crate) fn new(family: &'static str) -> Self {
        Self {
            family,
            epoch: AtomicU64::new(0),
            current: Mutex::new(FontReadinessRecord::new(FontState::Resolving, family)),
        }
    }

    /// The current record. Cheap, and safe to call from any thread.
    pub(crate) fn snapshot(&self) -> FontReadinessRecord {
        self.locked().clone()
    }

    /// A poisoned lock must not take the application down over a capability report.
    fn locked(&self) -> MutexGuard<'_, FontReadinessRecord> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn publish(&self, mut record: FontReadinessRecord) -> FontReadinessRecord {
        record.epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let mut current = self.locked();
        *current = record;
        current.clone()
    }

    /// Another attempt is starting. `Repairing` rather than `Resolving` once something has failed.
    pub(crate) fn mark_repairing(&self) -> FontReadinessRecord {
        self.publish(FontReadinessRecord::new(FontState::Repairing, self.family))
    }

    /// The bytes are installed and verified. This is the only way to reach `Ready`.
    pub(crate) fn mark_ready(&self, version: String) -> FontReadinessRecord {
        let mut record = FontReadinessRecord::new(FontState::Ready, self.family);
        record.version = Some(version);
        self.publish(record)
    }

    pub(crate) fn mark_refused(&self, reason: FontRefusal) -> FontReadinessRecord {
        let mut record = FontReadinessRecord::new(FontState::Refused, self.family);
        record.reason = Some(reason);
        record.retryable = reason.retryable();
        self.publish(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMILY: &str = "Google Sans";

    #[test]
    fn starts_resolving_rather_than_refused() {
        // The distinction the original boolean could not make: not yet known is not the same as
        // known to be absent, and only one of the two should show the user a failure.
        let readiness = FontReadiness::new(FAMILY);
        let snapshot = readiness.snapshot();
        assert_eq!(snapshot.state, FontState::Resolving);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.family, FAMILY);
    }

    #[test]
    fn every_publication_advances_the_epoch() {
        let readiness = FontReadiness::new(FAMILY);
        let first = readiness.mark_refused(FontRefusal::TimedOut).epoch;
        let second = readiness.mark_repairing().epoch;
        let third = readiness.mark_ready("v22-ui4".to_owned()).epoch;
        assert!(
            first < second && second < third,
            "a consumer must be able to order these"
        );
        assert_eq!(readiness.snapshot().epoch, third);
    }

    #[test]
    fn a_timeout_can_still_become_ready_later() {
        // The whole point. The old boolean was fixed at false here for the rest of the session.
        let readiness = FontReadiness::new(FAMILY);
        readiness.mark_refused(FontRefusal::TimedOut);
        assert_ne!(readiness.snapshot().state, FontState::Ready);

        readiness.mark_repairing();
        let ready = readiness.mark_ready("v22-ui4".to_owned());
        assert_eq!(ready.state, FontState::Ready);
        assert_eq!(ready.version.as_deref(), Some("v22-ui4"));
        assert_eq!(ready.reason, None);
        assert!(!ready.retryable, "a ready capability has nothing to retry");
    }

    #[test]
    fn refusals_say_whether_an_action_is_worth_offering() {
        let readiness = FontReadiness::new(FAMILY);
        for reason in [
            FontRefusal::NoUsableSource,
            FontRefusal::TimedOut,
            FontRefusal::StoreUnavailable,
        ] {
            assert!(
                readiness.mark_refused(reason).retryable,
                "{reason:?} must offer a retry"
            );
        }
        for reason in [
            FontRefusal::IntegrityFailed,
            FontRefusal::VersionMismatch,
            FontRefusal::Cancelled,
        ] {
            let record = readiness.mark_refused(reason);
            assert!(
                !record.retryable,
                "{reason:?} must state a cause rather than offer a useless button"
            );
            assert_eq!(record.reason, Some(reason));
        }
    }

    #[test]
    fn the_serialized_record_carries_no_private_detail() {
        let readiness = FontReadiness::new(FAMILY);
        readiness.mark_refused(FontRefusal::IntegrityFailed);
        let encoded = serde_json::to_string(&readiness.snapshot()).expect("record serializes");
        assert!(encoded.contains("\"state\":\"refused\""));
        assert!(encoded.contains("\"reason\":\"integrity-failed\""));
        assert!(encoded.contains("\"schema\":1"));

        // This value is rendered in the editor and captured in evidence, so nothing resembling a
        // location or an artefact name may reach it.
        for forbidden in ["//", "C:", ".woff2", "http", "\\"] {
            assert!(
                !encoded.contains(forbidden),
                "{forbidden} must not appear in a rendered capability record: {encoded}"
            );
        }
    }
}
