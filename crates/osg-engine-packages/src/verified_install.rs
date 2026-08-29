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
    resolve_owned, validate_manifest_path,
};
use crate::receipt;
use crate::{PackageError, Result};

const VERIFIED_DIR: &str = ".verified";
// A 100k-entry catalog at the portable path-length bound needs more than the old size-only
// receipt's 64 MiB once timestamps are included. Keep the parser bounded while leaving room for
// the catalog's declared maximum; the reviewed Windows runtime is currently about 41k files.
const MAX_RECEIPT_BYTES: u64 = 128 * 1024 * 1024;
const SCHEMA_VERSION: u32 = 2;
const MAX_FAST_VERIFY_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

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
pub(crate) fn write(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
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
    let verified_at_unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
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
        deep_verify_after_unix_seconds: verified_at_unix_seconds
            .saturating_add(MAX_FAST_VERIFY_AGE_SECONDS),
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
pub(crate) fn try_fast_verify(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
) -> bool {
    try_fast_verify_at(
        store_root,
        version_root,
        delivery,
        unix_seconds(SystemTime::now()),
    )
}

fn try_fast_verify_at(
    store_root: &Path,
    version_root: &Path,
    delivery: &PackageDelivery,
    now_unix_seconds: u64,
) -> bool {
    let Some(document) = read_matching(store_root, delivery, now_unix_seconds) else {
        return false;
    };
    let Ok(actual) = observe_tree(version_root) else {
        return false;
    };
    actual == document.files && manifest_sidecar_matches(version_root, delivery)
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
        if validate_manifest_path(&file.path).is_err() || !paths.insert(file.path.as_str()) {
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
mod tests {
    use super::*;
    use crate::catalog::{DeliveryAsset, DeliveryFile, FileRole};

    fn digest(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    /// Builds a store root and a published version tree for it, with a real in-tree structural
    /// receipt (`receipt::write`) so `verified_install::write` has an authoritative file list to
    /// read, exactly as it finds one after a real `validate_integrity` success.
    fn install_fixture(
        files: &[(&str, &[u8])],
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        PackageDelivery,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let store_root = temp.path().join("store");
        fs::create_dir_all(&store_root).unwrap();
        let version_root = store_root.join("parakeet").join("versions").join("1.0.0");
        fs::create_dir_all(&version_root).unwrap();
        let mut delivery_files = Vec::with_capacity(files.len());
        for (path, bytes) in files {
            let full = version_root.join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(&full, bytes).unwrap();
            delivery_files.push(DeliveryFile {
                path: (*path).to_owned(),
                size_bytes: bytes.len() as u64,
                sha256: digest(bytes),
                executable: false,
                role: FileRole::Runtime,
            });
        }
        let delivery = PackageDelivery {
            component: "parakeet".to_owned(),
            platform: "windows-x86_64".to_owned(),
            version: "1.0.0".to_owned(),
            asset: "parakeet.zip".to_owned(),
            source_url: "https://example.invalid/parakeet.zip".to_owned(),
            size_bytes: 1,
            sha256: "0".repeat(64),
            unpacked_size_bytes: delivery_files.iter().map(|file| file.size_bytes).sum(),
            python_relative_path: files[0].0.to_owned(),
            primary_executable: true,
            model_relative_path: None,
            aligner_relative_path: None,
            files: delivery_files,
            sources: Vec::new(),
            manifest: None,
        };
        receipt::write(&version_root, &delivery).unwrap();
        (temp, store_root, version_root, delivery)
    }

    const FILES: &[(&str, &[u8])] = &[
        ("runtime/python.exe", b"python-runtime-bytes"),
        ("model/config.json", b"{\"weights\":true}"),
    ];

    fn fast_receipt_path(store_root: &Path, delivery: &PackageDelivery) -> std::path::PathBuf {
        store_root
            .join(VERIFIED_DIR)
            .join(&delivery.component)
            .join(receipt_file_name(&delivery.version))
    }

    fn rewrite_fast_receipt(
        store_root: &Path,
        delivery: &PackageDelivery,
        mutate: impl FnOnce(&mut FastReceipt),
    ) {
        let path = fast_receipt_path(store_root, delivery);
        let mut document: FastReceipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        mutate(&mut document);
        document.receipt_sha256 = self_hash(&document).unwrap();
        fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    }

    fn enable_manifest(version_root: &Path, delivery: &mut PackageDelivery, manifest_bytes: &[u8]) {
        fs::write(
            version_root.join(receipt::DELIVERY_MANIFEST_NAME),
            manifest_bytes,
        )
        .unwrap();
        delivery.manifest = Some(DeliveryAsset {
            asset: "delivery-manifest.json".to_owned(),
            urls: vec!["https://example.invalid/delivery-manifest.json".to_owned()],
            size_bytes: manifest_bytes.len() as u64,
            sha256: digest(manifest_bytes),
        });
        fs::remove_file(version_root.join(receipt::RECEIPT_NAME)).unwrap();
        receipt::write(version_root, delivery).unwrap();
    }

    #[test]
    fn receipt_round_trip_lets_fast_verify_succeed() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        assert!(try_fast_verify(&store_root, &version_root, &delivery));
    }

    #[test]
    fn changed_same_version_catalog_delivery_rejects_the_old_receipt() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();

        let mut changed = delivery.clone();
        changed.source_url = "https://mirror.invalid/repacked-parakeet.zip".to_owned();
        assert_eq!(changed.version, delivery.version);
        assert!(!try_fast_verify(&store_root, &version_root, &changed));
    }

    #[test]
    fn a_size_changing_tamper_is_caught_by_the_fast_path() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        fs::write(
            version_root.join("model/config.json"),
            b"{\"weights\": true, \"extra\": 1}",
        )
        .unwrap();
        assert!(!try_fast_verify(&store_root, &version_root, &delivery));
    }

    #[test]
    fn a_same_size_writable_file_replacement_is_caught_after_restart() {
        let (temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        let path = version_root.join("model/config.json");
        let original = fs::read(&path).unwrap();
        let mut tampered = original.clone();
        tampered[1] = tampered[1].wrapping_add(1);
        assert_eq!(
            tampered.len(),
            original.len(),
            "the tamper must not change size"
        );
        // Move the old file outside the publication and create a distinct same-size file at the
        // declared path. Keeping the displaced file alive prevents inode/file-index reuse and
        // models the replacement a same-user Windows process can perform.
        fs::rename(&path, temp.path().join("displaced-config.json")).unwrap();
        fs::write(&path, &tampered).unwrap();

        let restarted_store = crate::path_security::initialize_store(&store_root).unwrap();

        assert!(
            !try_fast_verify(&restarted_store, &version_root, &delivery),
            "replacement identity/timestamps must survive and fail across process initialization"
        );
        let cancellation = crate::CancellationToken::default();
        assert!(
            receipt::validate_integrity(&version_root, &delivery, &cancellation).is_err(),
            "full content verification must still catch what the fast path cannot"
        );
    }

    #[test]
    fn manifest_delivery_binds_effective_files_to_the_current_catalog_and_pinned_sidecar() {
        let (_temp, store_root, version_root, mut effective) = install_fixture(FILES);
        let manifest = br#"{\"schemaVersion\":1,\"files\":[]}"#;
        enable_manifest(&version_root, &mut effective, manifest);
        write(&store_root, &version_root, &effective).unwrap();

        // A new process has the catalog view, not the install-time manifest-expanded file vector.
        let mut current_catalog = effective.clone();
        current_catalog.files.clear();
        assert_eq!(
            delivery_fingerprint(&effective),
            delivery_fingerprint(&current_catalog)
        );
        assert!(try_fast_verify(
            &store_root,
            &version_root,
            &current_catalog
        ));

        let sidecar = version_root.join(receipt::DELIVERY_MANIFEST_NAME);
        let mut drifted = manifest.to_vec();
        drifted[1] = if drifted[1] == b'X' { b'Y' } else { b'X' };
        assert_eq!(drifted.len(), manifest.len());
        fs::write(&sidecar, drifted).unwrap();

        // Give the hostile receipt its best case: refresh the sidecar's cheap metadata and
        // recompute the unkeyed outer checksum. The catalog-pinned sidecar digest must still be
        // independently authoritative.
        let current_files = observe_tree(&version_root).unwrap();
        let current_sidecar = current_files
            .into_iter()
            .find(|file| file.path == receipt::DELIVERY_MANIFEST_NAME)
            .unwrap();
        rewrite_fast_receipt(&store_root, &effective, |document| {
            *document
                .files
                .iter_mut()
                .find(|file| file.path == receipt::DELIVERY_MANIFEST_NAME)
                .unwrap() = current_sidecar;
        });
        assert!(!try_fast_verify(
            &store_root,
            &version_root,
            &current_catalog
        ));
    }

    #[test]
    fn scheduled_deep_verify_refreshes_the_receipt_and_repair_restores_fast_path() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        let now = unix_seconds(SystemTime::now());
        rewrite_fast_receipt(&store_root, &delivery, |document| {
            document.verified_at_unix_seconds = now
                .saturating_sub(MAX_FAST_VERIFY_AGE_SECONDS)
                .saturating_sub(1);
            document.deep_verify_after_unix_seconds = document
                .verified_at_unix_seconds
                .saturating_add(MAX_FAST_VERIFY_AGE_SECONDS);
        });
        assert!(!try_fast_verify_at(
            &store_root,
            &version_root,
            &delivery,
            now
        ));

        let cancellation = crate::CancellationToken::default();
        receipt::validate_integrity(&version_root, &delivery, &cancellation).unwrap();
        write(&store_root, &version_root, &delivery).unwrap();
        assert!(try_fast_verify(&store_root, &version_root, &delivery));

        let model = version_root.join("model/config.json");
        fs::write(&model, b"{\"weights\":xxxx}").unwrap();
        assert!(receipt::validate_integrity(&version_root, &delivery, &cancellation).is_err());
        fs::write(&model, b"{\"weights\":true}").unwrap();
        receipt::validate_integrity(&version_root, &delivery, &cancellation).unwrap();
        write(&store_root, &version_root, &delivery).unwrap();
        assert!(try_fast_verify(&store_root, &version_root, &delivery));
    }

    #[test]
    fn a_missing_receipt_falls_back_to_full_verify() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        // No `write` call: no fast-path receipt has ever been produced for this install.
        assert!(!try_fast_verify(&store_root, &version_root, &delivery));
        let cancellation = crate::CancellationToken::default();
        assert!(receipt::validate_integrity(&version_root, &delivery, &cancellation).is_ok());
    }

    #[test]
    fn a_corrupted_receipt_falls_back_to_full_verify() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        let receipt_path = store_root
            .join(VERIFIED_DIR)
            .join(&delivery.component)
            .join(receipt_file_name(&delivery.version));
        fs::write(&receipt_path, b"{ not json").unwrap();
        assert!(!try_fast_verify(&store_root, &version_root, &delivery));

        // A structurally valid but internally inconsistent receipt (whole-receipt checksum no
        // longer matches its content) must also be rejected, not merely a parse failure.
        write(&store_root, &version_root, &delivery).unwrap();
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        document["totalBytes"] = serde_json::json!(999_999);
        fs::write(&receipt_path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(!try_fast_verify(&store_root, &version_root, &delivery));

        let cancellation = crate::CancellationToken::default();
        assert!(receipt::validate_integrity(&version_root, &delivery, &cancellation).is_ok());
    }

    #[test]
    fn an_untracked_extra_file_is_caught_by_the_fast_path() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        fs::write(version_root.join("runtime/unexpected.dll"), b"payload").unwrap();
        assert!(!try_fast_verify(&store_root, &version_root, &delivery));
    }

    /// Reproduces the exact E2E run-root layout -- a store root reached only through an NTFS
    /// junction, exactly like `<run_root>/data/engine-packages` junctioned to the shared asset
    /// cache (see `e2e/support/environment.js`'s `attachPersistentCache`) -- and proves the
    /// receipt lands at, and is re-read from, the REAL physical location rather than somewhere
    /// the junction hides. This was the leading hypothesis for why the shared E2E engine store
    /// never accumulated a `.verified` directory; it does not hold; see `receipt_write_degraded`
    /// in `manager.rs` for the fix that actually addresses the observed symptom.
    #[cfg(windows)]
    #[test]
    fn a_receipt_written_through_a_run_root_junction_persists_at_the_real_physical_path_and_survives_a_second_store_initialization()
     {
        let temp = tempfile::tempdir().unwrap();
        // The REAL, persistent location -- stands in for the shared E2E asset cache.
        let real_cache = temp.path().join("real-shared-cache");
        fs::create_dir_all(&real_cache).unwrap();
        // A disposable "run root" whose `data` child junctions to the real cache, exactly as
        // `attachPersistentCache` in e2e/support/environment.js does at `<run_root>/data/<name>`.
        let run_root = temp.path().join("run-root-1");
        fs::create_dir_all(run_root.join("data")).unwrap();
        let junction = run_root.join("data").join("engine-packages");
        create_junction(&junction, &real_cache);

        let store_root_via_junction = junction.join("v1");
        let canonical = crate::path_security::initialize_store(&store_root_via_junction)
            .expect("initialize_store must succeed through the junction");

        let version_root = canonical.join("parakeet").join("versions").join("1.0.0");
        fs::create_dir_all(&version_root).unwrap();
        let bytes = b"python-runtime-bytes";
        fs::write(version_root.join("python.exe"), bytes).unwrap();
        let delivery = PackageDelivery {
            component: "parakeet".to_owned(),
            platform: "windows-x86_64".to_owned(),
            version: "1.0.0".to_owned(),
            asset: "parakeet.zip".to_owned(),
            source_url: "https://example.invalid/parakeet.zip".to_owned(),
            size_bytes: 1,
            sha256: "0".repeat(64),
            unpacked_size_bytes: bytes.len() as u64,
            python_relative_path: "python.exe".to_owned(),
            primary_executable: true,
            model_relative_path: None,
            aligner_relative_path: None,
            files: vec![DeliveryFile {
                path: "python.exe".to_owned(),
                size_bytes: bytes.len() as u64,
                sha256: digest(bytes),
                executable: false,
                role: FileRole::Runtime,
            }],
            sources: Vec::new(),
            manifest: None,
        };
        receipt::write(&version_root, &delivery).unwrap();

        write(&canonical, &version_root, &delivery)
            .expect("write() must succeed through the junction-resolved canonical root");

        // Inspect the REAL physical location directly, bypassing the junction entirely -- exactly
        // what a manual inspection of the shared `%LOCALAPPDATA%\...\engine-packages` cache does.
        let physical_receipt = real_cache
            .join("v1")
            .join(VERIFIED_DIR)
            .join("parakeet")
            .join("1.0.0.json");
        assert!(
            physical_receipt.exists(),
            "the receipt must land in the real shared cache, not somewhere the junction hides"
        );

        // A fresh `initialize_store` over the SAME physical root -- exactly what every later
        // process does at startup -- must not disturb the receipt: `.verified` is recognized
        // store metadata (`path_security::initialize_store`), not unrecognized component state.
        let reinitialized = crate::path_security::initialize_store(&real_cache.join("v1"))
            .expect("re-initializing the same physical store must succeed");
        assert!(
            try_fast_verify(&reinitialized, &version_root, &delivery),
            "the receipt must survive the store's own recognized-state checks"
        );

        // A second, independent run root with its OWN fresh junction to the SAME real cache --
        // exactly like the next E2E run getting a brand new disposable run root.
        let run_root_2 = temp.path().join("run-root-2");
        fs::create_dir_all(run_root_2.join("data")).unwrap();
        let junction_2 = run_root_2.join("data").join("engine-packages");
        create_junction(&junction_2, &real_cache);
        let store_root_via_junction_2 = junction_2.join("v1");
        let canonical_2 = crate::path_security::initialize_store(&store_root_via_junction_2)
            .expect("initialize_store must succeed through the second junction");
        let version_root_2 = canonical_2.join("parakeet").join("versions").join("1.0.0");
        assert!(
            try_fast_verify(&canonical_2, &version_root_2, &delivery),
            "a second process reaching the same real store through a fresh junction must reuse the receipt"
        );
    }

    #[cfg(windows)]
    fn create_junction(link: &std::path::Path, target: &std::path::Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .expect("mklink must run");
        assert!(status.success(), "mklink /J failed to create the junction");
    }
}
