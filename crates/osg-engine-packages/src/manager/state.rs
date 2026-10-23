//! Shared manager state: the store handle, activity bookkeeping, and operation/lease guards.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority};

use crate::ProgressSink;
use crate::catalog::{PackageCatalog, PackageDelivery};
use crate::delivery_manifest;
use crate::download::{ArchiveFetcher, BundledArchiveFetcher, HttpArchiveFetcher};
use crate::path_security::{acquire_store_lock, initialize_store};
use crate::receipt;
use crate::verified_install;
use crate::{CancellationToken, PackageError, Result};

use super::IntegrityVerifier;
use super::key::ManagedPackageKey;
use super::recovery::recover_interrupted_mutations;
#[derive(Clone)]
pub(super) struct ManagedPackageManager<K: 'static>(pub(super) Arc<ManagerInner<K>>);

pub(super) struct ManagerInner<K: 'static> {
    pub(super) root: PathBuf,
    pub(super) _store_lock: fs::File,
    pub(super) staging_authority: RuntimeStagingAuthority,
    pub(super) catalog: &'static PackageCatalog<K>,
    pub(super) fetcher: Arc<dyn ArchiveFetcher>,
    pub(super) quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
    pub(super) clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub(super) verify_integrity: Arc<IntegrityVerifier>,
    #[cfg(test)]
    pub(super) verification_published_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    pub(super) activity: Mutex<ActivityState<K>>,
}

pub(super) struct PreparedDelivery {
    pub(super) effective: PackageDelivery,
    pub(super) manifest: delivery_manifest::ValidatedManifest,
    pub(super) manifest_download: crate::download::DownloadedArchive,
}

pub(super) struct QuarantinedPackage {
    pub(super) owner: OwnedStagingDirectory,
    pub(super) previous: PathBuf,
}

#[derive(Clone, Copy)]
pub(super) struct InstallStaging<'a, K> {
    pub(super) component: K,
    pub(super) delivery: &'a PackageDelivery,
    pub(super) effective: &'a PackageDelivery,
    pub(super) prepared: Option<&'a PreparedDelivery>,
    pub(super) staging: &'a Path,
    pub(super) target: &'a Path,
    pub(super) cancellation: &'a CancellationToken,
    pub(super) progress: &'a dyn ProgressSink,
}

#[derive(Debug)]
pub(super) struct ActivityState<K> {
    pub(super) operations: HashSet<K>,
    pub(super) leases: HashMap<K, usize>,
    pub(super) verified_versions: HashMap<K, VerifiedVersion>,
    pub(super) verifying_versions: HashMap<(K, String), Arc<VerificationFlight>>,
    /// Components whose most recent attempt to persist a fast-path verification receipt
    /// (`verified_install::write`) failed. The write is best-effort by design -- a failure never
    /// blocks install, adoption, or verification -- but that made a durably-broken write path
    /// invisible from outside this crate. Cleared the next time a write for that component
    /// succeeds. See `ManagedPackageManager::receipt_write_degraded`.
    pub(super) receipt_write_failed: HashSet<K>,
}

#[derive(Debug, Default)]
pub(super) struct VerificationFlight {
    pub(super) outcome: Mutex<Option<Result<()>>>,
    pub(super) completed: Condvar,
}

impl VerificationFlight {
    pub(super) fn wait(&self, cancellation: &CancellationToken) -> Result<()> {
        let mut outcome = self
            .outcome
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        loop {
            if let Some(outcome) = outcome.as_ref() {
                return outcome.clone();
            }
            cancellation.check()?;
            let (next, _) = self
                .completed
                .wait_timeout(outcome, Duration::from_millis(100))
                .map_err(|_| PackageError::StoreUnavailable)?;
            outcome = next;
        }
    }

    pub(super) fn complete(&self, outcome: Result<()>) {
        // Recover the guard solely to publish a terminal error and wake waiters. The poisoned
        // mutex remains poisoned, so every waiter still fails closed with StoreUnavailable.
        let mut stored = self
            .outcome
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if stored.is_none() {
            *stored = Some(outcome);
        }
        drop(stored);
        self.completed.notify_all();
    }
}

#[derive(Clone, Debug)]
pub(super) struct VerifiedVersion {
    pub(super) version: String,
    pub(super) verified_at_unix_seconds: u64,
    pub(super) deep_verify_after_unix_seconds: u64,
}

impl VerifiedVersion {
    pub(super) fn is_current(&self, delivery: &PackageDelivery, now_unix_seconds: u64) -> bool {
        self.version == delivery.version
            && self.verified_at_unix_seconds != 0
            && self.verified_at_unix_seconds <= now_unix_seconds
            && now_unix_seconds < self.deep_verify_after_unix_seconds
    }
}

impl<K> Default for ActivityState<K> {
    fn default() -> Self {
        Self {
            operations: HashSet::new(),
            leases: HashMap::new(),
            verified_versions: HashMap::new(),
            verifying_versions: HashMap::new(),
            receipt_write_failed: HashSet::new(),
        }
    }
}

pub(super) fn remove_verification_flight<K: Eq + Hash>(
    activity: &mut ActivityState<K>,
    key: &(K, String),
    flight: &Arc<VerificationFlight>,
) {
    if activity
        .verifying_versions
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, flight))
    {
        activity.verifying_versions.remove(key);
    }
}

impl<K> fmt::Debug for ManagedPackageManager<K>
where
    K: Eq + Hash,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedPackageManager")
            .field("root", &"<redacted>")
            .field("platform", &self.0.catalog.platform())
            .finish_non_exhaustive()
    }
}

impl<K> ManagedPackageManager<K>
where
    K: ManagedPackageKey,
{
    pub(super) fn new(
        root: &Path,
        catalog: &'static PackageCatalog<K>,
        quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
    ) -> Result<Self> {
        Self::with_bundled_sources(root, catalog, quiesce, None)
    }

    pub(super) fn new_with_staging_authority(
        root: &Path,
        catalog: &'static PackageCatalog<K>,
        quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        Self::with_bundled_sources_and_optional_staging_authority(
            root,
            catalog,
            quiesce,
            None,
            Some(staging_authority),
        )
    }

    /// As `new`, but preferring digest-matching bytes shipped in `bundle` over the network.
    ///
    /// Only the UI font uses this today, because it is the only package whose absence breaks a
    /// default rather than an optional feature. The catalog and its digests are identical either
    /// way; see `BundledArchiveFetcher` for why an on-demand default was the wrong shape.
    pub(super) fn with_bundled_sources(
        root: &Path,
        catalog: &'static PackageCatalog<K>,
        quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
        bundle: Option<PathBuf>,
    ) -> Result<Self> {
        Self::with_bundled_sources_and_optional_staging_authority(
            root, catalog, quiesce, bundle, None,
        )
    }

    pub(super) fn with_bundled_sources_and_staging_authority(
        root: &Path,
        catalog: &'static PackageCatalog<K>,
        quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
        bundle: Option<PathBuf>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        Self::with_bundled_sources_and_optional_staging_authority(
            root,
            catalog,
            quiesce,
            bundle,
            Some(staging_authority),
        )
    }

    pub(super) fn with_bundled_sources_and_optional_staging_authority(
        root: &Path,
        catalog: &'static PackageCatalog<K>,
        quiesce: Arc<dyn Fn(K) -> Result<()> + Send + Sync>,
        bundle: Option<PathBuf>,
        staging_authority: Option<RuntimeStagingAuthority>,
    ) -> Result<Self> {
        let root = initialize_store(root)?;
        let store_lock = acquire_store_lock(&root)?;
        let staging_authority = match staging_authority {
            Some(authority) => {
                authority
                    .reconcile_all()
                    .map_err(|_| PackageError::StoreUnavailable)?;
                authority
            }
            None => RuntimeStagingAuthority::prepare(&root.join(".runtime-staging-authority"))
                .map_err(|_| PackageError::StoreUnavailable)?,
        };
        recover_interrupted_mutations(&root, catalog)?;
        let http = Arc::new(HttpArchiveFetcher::new()?);
        let fetcher: Arc<dyn ArchiveFetcher> = match bundle {
            Some(directory) => Arc::new(BundledArchiveFetcher::new(directory, http)),
            None => http,
        };
        Ok(Self(Arc::new(ManagerInner {
            root,
            _store_lock: store_lock,
            staging_authority,
            catalog,
            fetcher,
            quiesce,
            clock: Arc::new(verified_install::current_unix_seconds),
            verify_integrity: Arc::new(receipt::validate_integrity),
            #[cfg(test)]
            verification_published_hook: Mutex::new(None),
            activity: Mutex::new(ActivityState::default()),
        })))
    }
}

pub(super) struct OperationGuard<'a, K: Eq + Hash> {
    pub(super) activity: &'a Mutex<ActivityState<K>>,
    pub(super) component: K,
}

impl<K> Drop for OperationGuard<'_, K>
where
    K: Eq + Hash,
{
    fn drop(&mut self) {
        if let Ok(mut activity) = self.activity.lock() {
            activity.operations.remove(&self.component);
        }
    }
}

pub(super) struct RuntimeLease<K: Eq + Hash + 'static> {
    pub(super) inner: Arc<ManagerInner<K>>,
    pub(super) component: K,
}

impl<K> Drop for RuntimeLease<K>
where
    K: Eq + Hash,
{
    fn drop(&mut self) {
        if let Ok(mut activity) = self.inner.activity.lock()
            && let Some(count) = activity.leases.get_mut(&self.component)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                activity.leases.remove(&self.component);
            }
        }
    }
}
