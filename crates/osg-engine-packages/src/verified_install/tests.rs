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
