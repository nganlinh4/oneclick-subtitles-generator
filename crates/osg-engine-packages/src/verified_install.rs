//! A durable, tamper-evident cache of a completed full-content install verification.
//!
//! `receipt::validate_integrity` hashes every byte of a published engine tree — for a Python
//! runtime that is tens of thousands of files and, under a cold filesystem/antivirus cache, tens
//! of minutes. That cost is unavoidable once, at install time, but repeating it on every
//! process's first status probe or launch is not: nothing about an already-published tree
//! changes between sessions unless something tampers with it, and tampering is exactly what a
//! much cheaper metadata-only check can still catch with high probability.
//!
//! This module writes one small JSON receipt per installed `(component, version)` outside the
//! published tree, under the store's `.verified/<component>/` metadata directory — never inside
//! `versions/<version>/` itself, and never as a sibling of it either. Both of those are treated
//! as exact by `manager::has_unrecognized_component_state` and `receipt::validate_exact_tree`, so
//! anything this module needs to rewrite on every verification has to live somewhere neither one
//! enumerates. The store root's own metadata directories (`.downloads`, `.staging`, `.trash`,
//! `.quarantine`) already work exactly this way.
//!
//! Trust in a receipt rests on four independent checks:
//! - a whole-receipt SHA-256 (`receipt_sha256`) that detects any edit to the receipt file itself
//!   (bit rot, a partial write, manual tampering that does not also recompute the checksum);
//! - a fingerprint of the effective catalog delivery, including the catalog-pinned manifest and
//!   source identities for manifest-driven deliveries;
//! - a walk of the receipt's own file list confirming every entry still exists at its recorded
//!   size, write/change timestamps and, where stable APIs expose it, filesystem identity, with no
//!   untracked file alongside it;
//! - for manifest-driven deliveries, a SHA-256 of the small installed manifest sidecar against
//!   the digest pinned by the current catalog.
//!
//! **Windows publication assumption and bounded trade-off.** Publication is *logically*
//! immutable: OSG never reopens a published runtime file for writing. Windows does not enforce
//! that invariant with an ACL or read-only attribute, however, so another process running as the
//! same user can replace a file. An ordinary same-size overwrite/replacement changes NTFS write or
//! creation metadata and is rejected on the next process start. An actor able to forge those
//! fields and recompute this unkeyed receipt is outside the cheap-path threat
//! model. Even non-forged metadata is not trusted indefinitely: every receipt expires after a
//! bounded interval, forcing `manager::verify_once` through full catalog-pinned content hashes and
//! refreshing the receipt only after success. Thus the 41k-file tree is stat'ed at startup, but is
//! never content-hashed on every startup.

use std::collections::HashSet;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::catalog::{MAX_FILES, PackageDelivery};
use crate::path_security::{
    collect_regular_file_metadata, ensure_direct_child, is_link_or_reparse, require_regular_file,
    resolve_owned, validate_relative_path,
};
use crate::receipt;
use crate::{PackageError, Result};

const VERIFIED_DIR: &str = ".verified";
// A 100k-entry catalog at the portable path-length bound needs more than the old size-only
// receipt's 64 MiB once timestamps are included. Keep the parser bounded while leaving room for
// the catalog's declared maximum; the reviewed Windows runtime is currently about 41k files.
const MAX_RECEIPT_BYTES: u64 = 128 * 1024 * 1024;
const SCHEMA_VERSION: u32 = 2;
pub(crate) const MAX_FAST_VERIFY_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FastFile {
    path: String,
    size_bytes: u64,
    metadata: FastMetadata,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FastMetadata {
    write_marker: String,
    change_marker: String,
    device_id: Option<u64>,
    file_id: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FastReceipt {
    schema_version: u32,
    component: String,
    platform: String,
    version: String,
    delivery_fingerprint: String,
    file_count: u64,
    total_bytes: u64,
    /// A single SHA-256 over every inventoried file's already-verified content hash, in path
    /// order. Not re-derived by the fast path (that would require re-reading the in-tree
    /// structural receipt, costing the very I/O this cache exists to avoid); it is bound into
    /// `receipt_sha256` purely as an audit trail tying this receipt to the exact content it was
    /// written from.
    hash_of_hashes: String,
    verified_at_unix_seconds: u64,
    deep_verify_after_unix_seconds: u64,
    files: Vec<FastFile>,
    /// SHA-256 over this document with `receipt_sha256` itself blanked. Detects any edit to the
    /// receipt at rest; it is a plain checksum, not a keyed signature, so — like the in-tree
    /// `receipt.json` it complements — it defends against corruption, not against an attacker who
    /// already has write access to this application's own data directory.
    receipt_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VerificationLease {
    pub(crate) verified_at_unix_seconds: u64,
    pub(crate) deep_verify_after_unix_seconds: u64,
}

impl FastReceipt {
    fn matches(&self, delivery: &PackageDelivery, now_unix_seconds: u64) -> bool {
        self.schema_version == SCHEMA_VERSION
            && self.component == delivery.component
            && self.platform == delivery.platform
            && self.version == delivery.version
            && self.delivery_fingerprint == delivery_fingerprint(delivery)
            && self.files.len() as u64 == self.file_count
            && self.verified_at_unix_seconds != 0
            && self.verified_at_unix_seconds <= now_unix_seconds
            && now_unix_seconds < self.deep_verify_after_unix_seconds
            && self.deep_verify_after_unix_seconds
                == self
                    .verified_at_unix_seconds
                    .saturating_add(MAX_FAST_VERIFY_AGE_SECONDS)
            && self
                .files
                .iter()
                .try_fold(0_u64, |total, file| total.checked_add(file.size_bytes))
                == Some(self.total_bytes)
            && is_sha256(&self.delivery_fingerprint)
            && is_sha256(&self.hash_of_hashes)
    }
}

/// Writes (or rewrites) the fast-path receipt for `delivery`, whose complete content was just
/// verified against the published tree at `version_root`. Best-effort by design: callers must
/// treat a write failure as "the next status probe pays full verification again," never as a
/// reason to fail an otherwise-successful install, adoption, or verification. "Best-effort" does
/// not mean "unobserved": every call site in `manager.rs` routes through
/// `ManagedPackageManager::record_verified_receipt`, which records a failure in `ActivityState`
/// so it can be surfaced through `receipt_write_degraded` instead of vanishing into a discarded
/// `Result`.
#[cfg(test)]
pub(crate) fn write(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
) -> Result<()> {
    write_at(store_root, version_root, delivery, current_unix_seconds())
}

pub(crate) fn write_at(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
    verified_at_unix_seconds: u64,
) -> Result<()> {
    // The delivery's own declared files, used only for `hash_of_hashes`: the published tree also
    // carries the in-tree structural `receipt.json` (and, for a remote-manifest delivery,
    // `delivery-manifest.json`) which are not part of `delivery.files` but are real files that
    // the metadata walk below must still account for.
    let mut content_files = receipt::read_files(version_root)?;
    if content_files.is_empty() {
        return Err(PackageError::InvalidInstall);
    }
    content_files.sort_by(|a, b| a.path.cmp(&b.path));
    let hash_of_hashes = hash_of_hashes(content_files.iter().map(|file| file.sha256.as_str()));

    // The complete actual tree, taken fresh right after `validate_integrity` confirmed it is
    // exactly `delivery.files` plus its sidecars — this is what a later metadata walk must be
    // compared against, so it is built the same way here rather than reconstructed by name.
    let actual = observe_tree(version_root)?;
    if actual.is_empty() {
        return Err(PackageError::InvalidInstall);
    }
    let files = actual;
    let total_bytes = files
        .iter()
        .try_fold(0_u64, |total, file| total.checked_add(file.size_bytes))
        .ok_or(PackageError::InvalidInstall)?;
    let mut document = FastReceipt {
        schema_version: SCHEMA_VERSION,
        component: delivery.component.clone(),
        platform: delivery.platform.clone(),
        version: delivery.version.clone(),
        delivery_fingerprint: delivery_fingerprint(delivery),
        file_count: files.len() as u64,
        total_bytes,
        hash_of_hashes,
        verified_at_unix_seconds,
        deep_verify_after_unix_seconds: verification_lease(verified_at_unix_seconds)
            .deep_verify_after_unix_seconds,
        files,
        receipt_sha256: String::new(),
    };
    document.receipt_sha256 = self_hash(&document)?;
    let encoded = serde_json::to_vec(&document).map_err(|_| PackageError::InvalidInstall)?;
    if encoded.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(PackageError::InvalidInstall);
    }
    let verified_root = ensure_direct_child(store_root, VERIFIED_DIR)?;
    let component_dir = ensure_direct_child(&verified_root, &delivery.component)?;
    let target = resolve_owned(&component_dir, &receipt_file_name(&delivery.version))?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(target)
        .map_err(|_| PackageError::StoreUnavailable)?;
    output
        .write_all(&encoded)
        .map_err(|_| PackageError::StoreUnavailable)?;
    output
        .sync_all()
        .map_err(|_| PackageError::StoreUnavailable)
}

/// The bounded metadata-only fast path: `true` means a receipt exists for exactly this
/// `(component, platform, version)`, its own integrity checked out, and every file it lists
/// exists at the recorded size with nothing untracked alongside them — the caller may treat this
/// exactly as a successful full verification. `false` means nothing usable was found (no receipt
/// for this exact version, a tampered or unreadable receipt, or any metadata mismatch): the
/// caller must fall back to `receipt::validate_integrity` and, on that success, call `write` to
/// refresh the receipt.
#[cfg(test)]
pub(crate) fn try_fast_verify(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
) -> bool {
    fast_verification_lease_at(store_root, version_root, delivery, current_unix_seconds()).is_some()
}

#[cfg(test)]
fn try_fast_verify_at(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
    now_unix_seconds: u64,
) -> bool {
    fast_verification_lease_at(store_root, version_root, delivery, now_unix_seconds).is_some()
}

pub(crate) fn fast_verification_lease_at(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
    now_unix_seconds: u64,
) -> Option<VerificationLease> {
    let document = read_matching(store_root, delivery, now_unix_seconds)?;
    let Ok(actual) = observe_tree(version_root) else {
        return None;
    };
    (actual == document.files && manifest_sidecar_matches(version_root, delivery)).then_some(
        VerificationLease {
            verified_at_unix_seconds: document.verified_at_unix_seconds,
            deep_verify_after_unix_seconds: document.deep_verify_after_unix_seconds,
        },
    )
}

pub(crate) fn verification_lease(verified_at_unix_seconds: u64) -> VerificationLease {
    VerificationLease {
        verified_at_unix_seconds,
        deep_verify_after_unix_seconds: verified_at_unix_seconds
            .saturating_add(MAX_FAST_VERIFY_AGE_SECONDS),
    }
}

pub(crate) fn current_unix_seconds() -> u64 {
    unix_seconds(SystemTime::now())
}

/// Deletes the fast-path receipt for `delivery`, if any. Best-effort cleanup so a removed
/// version's receipt does not linger; a failure here never blocks removal of the version itself,
/// which the caller has already committed to by the time this runs.
pub(crate) fn remove(store_root: &Path, delivery: &PackageDelivery) -> Result<()> {
    let component_dir = store_root.join(VERIFIED_DIR).join(&delivery.component);
    let target = component_dir.join(receipt_file_name(&delivery.version));
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() && !is_link_or_reparse(&metadata) => {
            fs::remove_file(&target).map_err(|_| PackageError::StoreUnavailable)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(_) | Err(_) => return Err(PackageError::StoreUnavailable),
    }
    if fs::read_dir(&component_dir).is_ok_and(|mut entries| entries.next().is_none()) {
        let _ = fs::remove_dir(&component_dir);
    }
    Ok(())
}

fn receipt_file_name(version: &str) -> String {
    format!("{version}.json")
}

fn read_matching(
    store_root: &Path,
    delivery: &PackageDelivery,
    now_unix_seconds: u64,
) -> Option<FastReceipt> {
    let path = store_root
        .join(VERIFIED_DIR)
        .join(&delivery.component)
        .join(receipt_file_name(&delivery.version));
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || metadata.len() == 0
        || metadata.len() > MAX_RECEIPT_BYTES
    {
        return None;
    }
    let capacity = usize::try_from(metadata.len()).ok()?;
    let mut encoded = Vec::with_capacity(capacity);
    fs::File::open(&path)
        .ok()?
        .take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut encoded)
        .ok()?;
    if encoded.len() as u64 != metadata.len() {
        return None;
    }
    let document: FastReceipt = serde_json::from_slice(&encoded).ok()?;
    if document.files.len() > MAX_FILES || !document.matches(delivery, now_unix_seconds) {
        return None;
    }
    if self_hash(&document).ok()? != document.receipt_sha256 {
        return None;
    }
    // A receipt that round-tripped through disk is not trusted-by-construction the way a value
    // built by `write` is: re-check path well-formedness and uniqueness before it gates a
    // filesystem walk.
    let mut paths = HashSet::with_capacity(document.files.len());
    for file in &document.files {
        if validate_relative_path(&file.path).is_err() || !paths.insert(file.path.as_str()) {
            return None;
        }
    }
    Some(document)
}

fn self_hash(document: &FastReceipt) -> Result<String> {
    let mut blanked = document.clone();
    blanked.receipt_sha256 = String::new();
    let encoded = serde_json::to_vec(&blanked).map_err(|_| PackageError::InvalidInstall)?;
    let mut hasher = Sha256::new();
    hasher.update(&encoded);
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_of_hashes<'a>(content_hashes_in_path_order: impl Iterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    for value in content_hashes_in_path_order {
        hasher.update(value.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

fn observe_tree(root: &Path) -> Result<Vec<FastFile>> {
    let observed = collect_regular_file_metadata(root, |_, metadata| {
        Ok((metadata.len(), metadata_fingerprint(metadata)))
    })?;
    let mut files = Vec::with_capacity(observed.len());
    for (path, (size_bytes, metadata)) in observed {
        files.push(FastFile {
            path,
            size_bytes,
            metadata,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn manifest_sidecar_matches(root: &Path, delivery: &PackageDelivery) -> bool {
    let Some(expected) = &delivery.manifest else {
        return true;
    };
    let Ok(path) = resolve_owned(root, receipt::DELIVERY_MANIFEST_NAME) else {
        return false;
    };
    let Ok(before) = require_regular_file(&path) else {
        return false;
    };
    if before.len() != expected.size_bytes {
        return false;
    }
    let before_fingerprint = metadata_fingerprint(&before);
    let Ok(actual_hash) = receipt::hash_file(&path, &crate::CancellationToken::default()) else {
        return false;
    };
    let Ok(after) = require_regular_file(&path) else {
        return false;
    };
    before.len() == after.len()
        && before_fingerprint == metadata_fingerprint(&after)
        && actual_hash == expected.sha256
}

fn delivery_fingerprint(delivery: &PackageDelivery) -> String {
    let mut hasher = Sha256::new();
    fingerprint_field(&mut hasher, b"osg-package-delivery-v1");
    fingerprint_field(&mut hasher, delivery.component.as_bytes());
    fingerprint_field(&mut hasher, delivery.platform.as_bytes());
    fingerprint_field(&mut hasher, delivery.version.as_bytes());
    fingerprint_field(&mut hasher, delivery.asset.as_bytes());
    fingerprint_field(&mut hasher, delivery.source_url.as_bytes());
    fingerprint_u64(&mut hasher, delivery.size_bytes);
    fingerprint_field(&mut hasher, delivery.sha256.as_bytes());
    fingerprint_u64(&mut hasher, delivery.unpacked_size_bytes);
    fingerprint_field(&mut hasher, delivery.python_relative_path.as_bytes());
    fingerprint_u64(&mut hasher, u64::from(delivery.primary_executable));
    fingerprint_optional(&mut hasher, delivery.model_relative_path.as_deref());
    fingerprint_optional(&mut hasher, delivery.aligner_relative_path.as_deref());

    // A manifest's catalog-pinned digest is the authoritative file-inventory identity. Prepared
    // deliveries populate `files` from that manifest at install time, while the next process sees
    // the original catalog delivery with an empty `files` vector. Excluding that derived vector is
    // what makes both views produce the same fingerprint without weakening catalog binding.
    if delivery.manifest.is_none() {
        fingerprint_u64(&mut hasher, delivery.files.len() as u64);
        for file in &delivery.files {
            fingerprint_field(&mut hasher, file.path.as_bytes());
            fingerprint_u64(&mut hasher, file.size_bytes);
            fingerprint_field(&mut hasher, file.sha256.as_bytes());
            fingerprint_u64(&mut hasher, u64::from(file.executable));
            fingerprint_u64(&mut hasher, file.role as u64);
        }
    } else {
        fingerprint_u64(&mut hasher, 0);
    }

    fingerprint_u64(&mut hasher, delivery.sources.len() as u64);
    for source in &delivery.sources {
        fingerprint_u64(&mut hasher, source.kind as u64);
        fingerprint_asset(&mut hasher, &source.asset);
    }
    match &delivery.manifest {
        Some(manifest) => {
            fingerprint_u64(&mut hasher, 1);
            fingerprint_asset(&mut hasher, manifest);
        }
        None => fingerprint_u64(&mut hasher, 0),
    }
    format!("{:x}", hasher.finalize())
}

fn fingerprint_asset(hasher: &mut Sha256, asset: &crate::catalog::DeliveryAsset) {
    fingerprint_field(hasher, asset.asset.as_bytes());
    fingerprint_u64(hasher, asset.urls.len() as u64);
    for url in &asset.urls {
        fingerprint_field(hasher, url.as_bytes());
    }
    fingerprint_u64(hasher, asset.size_bytes);
    fingerprint_field(hasher, asset.sha256.as_bytes());
}

fn fingerprint_optional(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            fingerprint_u64(hasher, 1);
            fingerprint_field(hasher, value.as_bytes());
        }
        None => fingerprint_u64(hasher, 0),
    }
}

fn fingerprint_field(hasher: &mut Sha256, value: &[u8]) {
    fingerprint_u64(hasher, value.len() as u64);
    hasher.update(value);
}

fn fingerprint_u64(hasher: &mut Sha256, value: u64) {
    hasher.update(value.to_le_bytes());
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn unix_seconds(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[cfg(windows)]
fn metadata_fingerprint(metadata: &fs::Metadata) -> FastMetadata {
    use std::os::windows::fs::MetadataExt as _;

    FastMetadata {
        write_marker: format!("windows:{}", metadata.last_write_time()),
        change_marker: format!("windows:{}", metadata.creation_time()),
        // Stable Rust does not yet expose Windows by-handle volume/file IDs. Creation plus
        // last-write markers catch normal overwrite and replacement; the bounded deep-verify
        // deadline is the backstop for metadata-preserving replacement.
        device_id: None,
        file_id: None,
    }
}

#[cfg(unix)]
fn metadata_fingerprint(metadata: &fs::Metadata) -> FastMetadata {
    use std::os::unix::fs::MetadataExt as _;

    FastMetadata {
        write_marker: format!("unix:{}:{}", metadata.mtime(), metadata.mtime_nsec()),
        change_marker: format!("unix:{}:{}", metadata.ctime(), metadata.ctime_nsec()),
        device_id: Some(metadata.dev()),
        file_id: Some(metadata.ino()),
    }
}

#[cfg(not(any(windows, unix)))]
fn metadata_fingerprint(metadata: &fs::Metadata) -> FastMetadata {
    FastMetadata {
        write_marker: format!("portable:{:?}", metadata.modified().ok()),
        change_marker: format!("portable:{:?}", metadata.created().ok()),
        device_id: None,
        file_id: None,
    }
}

#[cfg(test)]
mod tests;
