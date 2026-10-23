//! Single-flight integrity verification and the durable fast-path receipt.

use std::sync::Arc;

use crate::catalog::PackageDelivery;
use crate::verified_install;
use crate::{CancellationToken, PackageError, Result};

use super::key::ManagedPackageKey;
use super::state::{
    ManagedPackageManager, VerificationFlight, VerifiedVersion, remove_verification_flight,
};
impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    pub(super) fn is_verified(&self, component: K, delivery: &PackageDelivery) -> bool {
        let now_unix_seconds = self.now_unix_seconds();
        self.0.activity.lock().is_ok_and(|activity| {
            activity
                .verified_versions
                .get(&component)
                .is_some_and(|entry| entry.is_current(delivery, now_unix_seconds))
        })
    }

    pub(super) fn verify_once(
        &self,
        component: K,
        delivery: &PackageDelivery,
        cancellation: &CancellationToken,
    ) -> Result<()> {
        // Integrity verification reads the complete published tree. Hold the same runtime lease as
        // a launched worker so install/remove/adoption can enter their read-only preflight but must
        // fail before renaming or deleting that tree. The activity mutex below prevents duplicate
        // readers; the lease prevents a reader-versus-writer race.
        let _verification_lease = self.acquire_lease(component)?;
        let key = (component, delivery.version.clone());
        let flight = {
            let now_unix_seconds = self.now_unix_seconds();
            let mut activity = self
                .0
                .activity
                .lock()
                .map_err(|_| PackageError::StoreUnavailable)?;
            if activity
                .verified_versions
                .get(&component)
                .is_some_and(|entry| entry.is_current(delivery, now_unix_seconds))
            {
                return Ok(());
            }
            if activity.operations.contains(&component) {
                return Err(PackageError::RuntimeBusy);
            }
            if let Some(flight) = activity.verifying_versions.get(&key).cloned() {
                drop(activity);
                // This caller joined this exact generation while it was active. It must receive
                // that generation's terminal verdict, including failure, rather than serially
                // becoming the next owner and repeating a multi-gigabyte scan. Its own
                // cancellation remains independent while it waits.
                return flight.wait(cancellation);
            }
            let flight = Arc::new(VerificationFlight::default());
            activity
                .verifying_versions
                .insert(key.clone(), flight.clone());
            flight
        };

        let version_root = self.version_root(delivery);
        // The bounded metadata-only fast path stands in for a full content verification when a
        // durable receipt from a prior full verification still matches this exact tree. Any miss
        // — no receipt, a tampered one, or a metadata mismatch — falls back to full content
        // verification exactly as before, and a fresh receipt is written from that success so the
        // next probe in a future process can take the fast path again.
        let now_unix_seconds = self.now_unix_seconds();
        let result = if let Some(verification_lease) = verified_install::fast_verification_lease_at(
            &self.0.root,
            &version_root,
            delivery,
            now_unix_seconds,
        ) {
            Ok(verification_lease)
        } else {
            let full = (self.0.verify_integrity)(&version_root, delivery, cancellation);
            if let Err(error) = full {
                Err(error)
            } else {
                let verified_at_unix_seconds = self.now_unix_seconds();
                Ok(self.record_verified_receipt_at(component, delivery, verified_at_unix_seconds))
            }
        };
        let outcome = match self.0.activity.lock() {
            Ok(mut activity) => {
                let outcome = match result {
                    Ok(verification_lease) => {
                        activity.verified_versions.insert(
                            component,
                            VerifiedVersion {
                                version: delivery.version.clone(),
                                verified_at_unix_seconds: verification_lease
                                    .verified_at_unix_seconds,
                                deep_verify_after_unix_seconds: verification_lease
                                    .deep_verify_after_unix_seconds,
                            },
                        );
                        Ok(())
                    }
                    Err(error) => Err(error),
                };
                // Publish while this exact flight is still discoverable. Any caller that entered
                // before the completion boundary either already cloned it or will clone the
                // completed flight after this guard is released; neither can start a duplicate
                // scan. Waiters never hold the flight mutex while acquiring `activity`, so the
                // activity -> flight lock order cannot deadlock.
                flight.complete(outcome.clone());
                outcome
            }
            Err(poisoned) => {
                // A poisoned activity mutex must not strand waiters. Retain the recovered guard
                // through fail-closed publication so the poisoned generation stays discoverable
                // until its outcome exists.
                let _activity = poisoned.into_inner();
                let outcome = Err(PackageError::StoreUnavailable);
                flight.complete(outcome.clone());
                outcome
            }
        };

        #[cfg(test)]
        if let Some(hook) = self
            .0
            .verification_published_hook
            .lock()
            .ok()
            .and_then(|hook| hook.clone())
        {
            hook();
        }

        // Retirement follows publication. Callers that find the map entry before this exact Arc
        // is removed share its already-terminal outcome; only callers that acquire `activity`
        // after removal may own a retry of a failed verification.
        match self.0.activity.lock() {
            Ok(mut activity) => remove_verification_flight(&mut activity, &key, &flight),
            Err(poisoned) => {
                let mut activity = poisoned.into_inner();
                remove_verification_flight(&mut activity, &key, &flight);
            }
        }
        outcome
    }

    pub(super) fn clear_verified(&self, component: K) {
        if let Ok(mut activity) = self.0.activity.lock() {
            activity.verified_versions.remove(&component);
        }
    }

    /// Records that `delivery`'s complete content was just verified, so a later process's first
    /// status probe or launch can use the bounded fast path instead of repeating that full
    /// verification. Best-effort: the in-memory `verified_versions` cache this run already relies
    /// on is unaffected by a write failure here, which only costs a future cold probe its full
    /// verification time again. The outcome is still recorded in `ActivityState` (see
    /// `receipt_write_degraded`) so a write that never succeeds does not stay invisible.
    pub(super) fn record_verified_receipt(&self, component: K, delivery: &PackageDelivery) {
        let verification_lease =
            self.record_verified_receipt_at(component, delivery, self.now_unix_seconds());
        if let Ok(mut activity) = self.0.activity.lock() {
            activity.verified_versions.insert(
                component,
                VerifiedVersion {
                    version: delivery.version.clone(),
                    verified_at_unix_seconds: verification_lease.verified_at_unix_seconds,
                    deep_verify_after_unix_seconds: verification_lease
                        .deep_verify_after_unix_seconds,
                },
            );
        }
    }

    pub(super) fn record_verified_receipt_at(
        &self,
        component: K,
        delivery: &PackageDelivery,
        verified_at_unix_seconds: u64,
    ) -> verified_install::VerificationLease {
        let outcome = verified_install::write_at(
            &self.0.root,
            &self.version_root(delivery),
            delivery,
            verified_at_unix_seconds,
        );
        if let Ok(mut activity) = self.0.activity.lock() {
            if outcome.is_ok() {
                activity.receipt_write_failed.remove(&component);
            } else {
                activity.receipt_write_failed.insert(component);
            }
        }
        verified_install::verification_lease(verified_at_unix_seconds)
    }

    pub(super) fn now_unix_seconds(&self) -> u64 {
        (self.0.clock)()
    }

    /// `true` when the most recent attempt to persist `component`'s fast-path verification
    /// receipt failed. The write never blocks install, adoption, or verification -- a failure
    /// here only costs a future process's first status probe or launch its full content
    /// verification again -- but that made a permanently failing write invisible from outside
    /// this crate. Exposed so a caller that cares about that health (a diagnostics log, a support
    /// bundle) can surface it after calling `status()` or attempting a launch.
    #[must_use]
    pub(super) fn receipt_write_degraded(&self, component: K) -> bool {
        self.0
            .activity
            .lock()
            .is_ok_and(|activity| activity.receipt_write_failed.contains(&component))
    }
}
