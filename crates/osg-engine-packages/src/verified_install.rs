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
//! Trust in a receipt rests on two independent checks, both metadata-only:
//! - a whole-receipt SHA-256 (`receipt_sha256`) that detects any edit to the receipt file itself
//!   (bit rot, a partial write, manual tampering that does not also recompute the checksum);
//! - a walk of the receipt's own file list confirming every entry still exists at its recorded
//!   size, and that no untracked file has appeared in the tree.
//!
//! **Bounded trade-off.** The fast path never re-reads file content, so a same-size content edit
//! made after a receipt was written is invisible to it. `manager::verify_once` treats any
//! fast-path miss — including one only a later deep verify happens to notice — as a reason to
//! fall back to full content verification and rewrite the receipt from that result. The gap
//! between those two events is bounded primarily by the store's own no-clobber, read-only
//! publication (`path_security::initialize_store`, `ManagedPackageManager::publish_staged`):
//! nothing in this application ever reopens a published file for writing after publication, so a
//! same-size substitution requires something outside the application's own write path.

use std::collections::HashSet;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::catalog::{MAX_FILES, PackageDelivery};
use crate::path_security::{
    collect_regular_file_sizes, ensure_direct_child, is_link_or_reparse, resolve_owned,
    validate_manifest_path,
};
use crate::receipt;
use crate::{PackageError, Result};

const VERIFIED_DIR: &str = ".verified";
const MAX_RECEIPT_BYTES: u64 = 64 * 1024 * 1024;
const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FastFile {
    path: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FastReceipt {
    schema_version: u32,
    component: String,
    platform: String,
    version: String,
    file_count: u64,
    total_bytes: u64,
    /// A single SHA-256 over every inventoried file's already-verified content hash, in path
    /// order. Not re-derived by the fast path (that would require re-reading the in-tree
    /// structural receipt, costing the very I/O this cache exists to avoid); it is bound into
    /// `receipt_sha256` purely as an audit trail tying this receipt to the exact content it was
    /// written from.
    hash_of_hashes: String,
    verified_at_unix_seconds: u64,
    files: Vec<FastFile>,
    /// SHA-256 over this document with `receipt_sha256` itself blanked. Detects any edit to the
    /// receipt at rest; it is a plain checksum, not a keyed signature, so — like the in-tree
    /// `receipt.json` it complements — it defends against corruption, not against an attacker who
    /// already has write access to this application's own data directory.
    receipt_sha256: String,
}

impl FastReceipt {
    fn matches(&self, delivery: &PackageDelivery) -> bool {
        self.schema_version == SCHEMA_VERSION
            && self.component == delivery.component
            && self.platform == delivery.platform
            && self.version == delivery.version
            && self.files.len() as u64 == self.file_count
    }
}

/// Writes (or rewrites) the fast-path receipt for `delivery`, whose complete content was just
/// verified against the published tree at `version_root`. Best-effort by design: callers must
/// treat a write failure as "the next status probe pays full verification again," never as a
/// reason to fail an otherwise-successful install, adoption, or verification.
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
    let actual = collect_regular_file_sizes(version_root)?;
    if actual.is_empty() {
        return Err(PackageError::InvalidInstall);
    }
    let mut files = actual
        .into_iter()
        .map(|(path, size_bytes)| FastFile { path, size_bytes })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| a.path.cmp(&b.path));
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
        file_count: files.len() as u64,
        total_bytes,
        hash_of_hashes,
        verified_at_unix_seconds,
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
    let Some(document) = read_matching(store_root, delivery) else {
        return false;
    };
    let Ok(actual) = collect_regular_file_sizes(version_root) else {
        return false;
    };
    // Every receipt path is distinct (checked below) and confirmed present at the recorded size,
    // so an equal count rules out an untracked extra file without a second directory walk.
    actual.len() == document.files.len()
        && document
            .files
            .iter()
            .all(|file| actual.get(&file.path) == Some(&file.size_bytes))
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

fn read_matching(store_root: &Path, delivery: &PackageDelivery) -> Option<FastReceipt> {
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
    if document.files.len() > MAX_FILES || !document.matches(delivery) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{DeliveryFile, FileRole};

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

    #[test]
    fn receipt_round_trip_lets_fast_verify_succeed() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        assert!(try_fast_verify(&store_root, &version_root, &delivery));
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

    /// Documents the bounded trade-off: a content edit that preserves the file's size is
    /// invisible to the metadata-only fast path, and is only caught once something runs the full
    /// content hash (`receipt::validate_integrity`) again — which the fast-path miss above, or a
    /// scheduled deep verify/repair, is what triggers.
    #[test]
    fn a_same_size_content_tamper_passes_the_fast_path_but_deep_verify_still_catches_it() {
        let (_temp, store_root, version_root, delivery) = install_fixture(FILES);
        write(&store_root, &version_root, &delivery).unwrap();
        let original = fs::read(version_root.join("model/config.json")).unwrap();
        let mut tampered = original.clone();
        tampered[1] = tampered[1].wrapping_add(1);
        assert_eq!(
            tampered.len(),
            original.len(),
            "the tamper must not change size"
        );
        fs::write(version_root.join("model/config.json"), &tampered).unwrap();

        assert!(
            try_fast_verify(&store_root, &version_root, &delivery),
            "same-size content tampering is outside the fast path's bounded guarantee"
        );
        let cancellation = crate::CancellationToken::default();
        assert!(
            receipt::validate_integrity(&version_root, &delivery, &cancellation).is_err(),
            "full content verification must still catch what the fast path cannot"
        );
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
}
