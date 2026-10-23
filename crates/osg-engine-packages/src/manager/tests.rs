//! Shared fixtures, fetch doubles, and manager builders for the manager tests.

use std::fs;
use std::io::{Cursor, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex, mpsc};

use osg_runtime_staging::RuntimeStagingAuthority;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tempfile::TempDir;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

use super::recovery::recover_interrupted_mutations;
use super::state::{
    ActivityState, ManagedPackageManager, ManagerInner, VerificationFlight,
    remove_verification_flight,
};
use super::*;
use crate::catalog::{DeliveryCatalog, EngineId, PackageDelivery, parse_for_test};
use crate::download::{ArchiveFetcher, FetchRequest};
use crate::path_security::{acquire_store_lock, initialize_store};
use crate::speech_catalog::{
    SpeechDeliveryCatalog, SpeechPackageId, parse_for_test as parse_speech_for_test,
};
use crate::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, ProgressSink, Result,
    receipt, verified_install,
};

const PLATFORM: &str = "windows-x86_64";
const TEST_PLATFORMS: [&str; 4] = [
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
];
const PYTHON_PATH: &str = "runtime/python.exe";
const MODEL_PATH: &str = "model/config.json";
const PYTHON_BYTES: &[u8] = b"python-runtime";
const MODEL_BYTES: &[u8] = b"model";
const LICENSE_PATH: &str = "licenses/NOTICE.txt";
const LICENSE_BYTES: &[u8] = b"license";

struct Fixture {
    catalog: DeliveryCatalog,
    archive: Vec<u8>,
}

struct SpeechFixture {
    catalog: SpeechDeliveryCatalog,
    archive: Vec<u8>,
}

#[derive(Debug, Default)]
struct TestCoordinator {
    calls: AtomicUsize,
}

impl RuntimeCoordinator for TestCoordinator {
    fn quiesce(&self, _: EngineId) -> Result<()> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

impl SpeechRuntimeCoordinator for TestCoordinator {
    fn quiesce(&self, _: SpeechPackageId) -> Result<()> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Debug)]
struct MemoryFetcher {
    archive: Vec<u8>,
    interrupt_once: AtomicBool,
    transient_failures: AtomicUsize,
    offsets: Mutex<Vec<u64>>,
}

impl MemoryFetcher {
    fn new(archive: Vec<u8>, interrupt_once: bool) -> Self {
        Self {
            archive,
            interrupt_once: AtomicBool::new(interrupt_once),
            transient_failures: AtomicUsize::new(0),
            offsets: Mutex::new(Vec::new()),
        }
    }

    fn with_transient_failures(archive: Vec<u8>, failures: usize) -> Self {
        Self {
            archive,
            interrupt_once: AtomicBool::new(false),
            transient_failures: AtomicUsize::new(failures),
            offsets: Mutex::new(Vec::new()),
        }
    }

    fn offsets(&self) -> Vec<u64> {
        self.offsets.lock().unwrap().clone()
    }
}

impl ArchiveFetcher for MemoryFetcher {
    fn fetch(
        &self,
        asset: &crate::catalog::DeliveryAsset,
        _: &str,
        request: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        let FetchRequest {
            target,
            resume_from,
            cancellation,
            progress,
            ..
        } = request;
        assert_eq!(asset.size_bytes, self.archive.len() as u64);
        self.offsets.lock().unwrap().push(resume_from);
        let start = usize::try_from(resume_from).unwrap();
        let mut output = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resume_from > 0)
            .truncate(resume_from == 0)
            .open(target)
            .unwrap();
        if self.interrupt_once.swap(false, Ordering::AcqRel) {
            let remaining = self.archive.len() - start;
            let end = start + (remaining / 2).max(1);
            output.write_all(&self.archive[start..end]).unwrap();
            output.sync_all().unwrap();
            cancellation.cancel();
            return Err(PackageError::Cancelled);
        }
        if self
            .transient_failures
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            let remaining = self.archive.len() - start;
            let end = start + (remaining / 2).max(1);
            output.write_all(&self.archive[start..end]).unwrap();
            output.sync_all().unwrap();
            return Err(PackageError::Network);
        }
        output.write_all(&self.archive[start..]).unwrap();
        output.sync_all().unwrap();
        progress.on_progress(OperationProgress::new(
            OperationPhase::Downloading,
            asset.size_bytes,
            asset.size_bytes,
        ));
        Ok(Some("\"fixture-v1\"".to_string()))
    }
}

#[derive(Debug)]
struct PanicFetcher;

impl ArchiveFetcher for PanicFetcher {
    fn fetch(
        &self,
        _: &crate::catalog::DeliveryAsset,
        _: &str,
        _: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        panic!("legacy adoption must not download an archive")
    }
}

#[derive(Debug, Default)]
struct RecordedProgress(Mutex<Vec<OperationProgress>>);

impl ProgressSink for RecordedProgress {
    fn on_progress(&self, progress: OperationProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn fixture() -> Fixture {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    for (path, bytes, executable) in [
        (PYTHON_PATH, PYTHON_BYTES, true),
        (MODEL_PATH, MODEL_BYTES, false),
    ] {
        let permissions = if executable { 0o755 } else { 0o644 };
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(permissions);
        writer.start_file(path, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    let archive = writer.finish().unwrap().into_inner();
    let archive_sha = digest(&archive);
    let unpacked = (PYTHON_BYTES.len() + MODEL_BYTES.len()) as u64;
    let mut platforms = serde_json::Map::new();
    for platform in TEST_PLATFORMS {
        let release = json!({
            "version": "1.0.0",
            "asset": format!("parakeet-{platform}-1.0.0-{}.zip", &archive_sha[..16]),
            "sizeBytes": archive.len(),
            "sha256": archive_sha,
            "unpackedSizeBytes": unpacked,
            "pythonRelativePath": PYTHON_PATH,
            "modelRelativePath": "model",
            "alignerRelativePath": null,
            "files": [
                {
                    "path": PYTHON_PATH,
                    "sizeBytes": PYTHON_BYTES.len(),
                    "sha256": digest(PYTHON_BYTES),
                    "executable": true,
                    "role": "runtime"
                },
                {
                    "path": MODEL_PATH,
                    "sizeBytes": MODEL_BYTES.len(),
                    "sha256": digest(MODEL_BYTES),
                    "executable": false,
                    "role": "model"
                }
            ]
        });
        let engines = EngineId::ALL
            .into_iter()
            .map(|engine| {
                json!({
                    "id": engine,
                    "releases": if engine == EngineId::Parakeet && platform == PLATFORM {
                        vec![release.clone()]
                    } else {
                        Vec::new()
                    }
                })
            })
            .collect::<Vec<_>>();
        platforms.insert(platform.to_string(), json!({ "engines": engines }));
    }
    let raw = json!({
        "schemaVersion": 1,
        "platforms": platforms,
    })
    .to_string();
    Fixture {
        catalog: parse_for_test(&raw, PLATFORM).unwrap(),
        archive,
    }
}

fn speech_fixture() -> SpeechFixture {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    for (path, bytes, executable) in [
        (PYTHON_PATH, PYTHON_BYTES, true),
        (LICENSE_PATH, LICENSE_BYTES, false),
    ] {
        let permissions = if executable { 0o755 } else { 0o644 };
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(permissions);
        writer.start_file(path, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    let archive = writer.finish().unwrap().into_inner();
    let archive_sha = digest(&archive);
    let unpacked = (PYTHON_BYTES.len() + LICENSE_BYTES.len()) as u64;
    let mut platforms = serde_json::Map::new();
    for platform in TEST_PLATFORMS {
        let asset = format!("edge-tts-{platform}-1.0.0-{}.zip", &archive_sha[..16]);
        let release = json!({
            "version": "1.0.0",
            "asset": asset,
            "sourceUrl": format!(
                "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/speech-packs-v1/{asset}"
            ),
            "sizeBytes": archive.len(),
            "sha256": archive_sha,
            "unpackedSizeBytes": unpacked,
            "pythonRelativePath": PYTHON_PATH,
            "files": [
                {
                    "path": PYTHON_PATH,
                    "sizeBytes": PYTHON_BYTES.len(),
                    "sha256": digest(PYTHON_BYTES),
                    "executable": true,
                    "role": "runtime"
                },
                {
                    "path": LICENSE_PATH,
                    "sizeBytes": LICENSE_BYTES.len(),
                    "sha256": digest(LICENSE_BYTES),
                    "executable": false,
                    "role": "license"
                }
            ]
        });
        let backends = SpeechPackageId::ALL
            .into_iter()
            .map(|backend| {
                json!({
                    "id": backend,
                    "releases": if backend == SpeechPackageId::EdgeTts && platform == PLATFORM {
                        vec![release.clone()]
                    } else {
                        Vec::new()
                    }
                })
            })
            .collect::<Vec<_>>();
        platforms.insert(platform.to_string(), json!({ "backends": backends }));
    }
    let raw = json!({
        "schemaVersion": 1,
        "commands": {
            "status": "speech_packages_status",
            "install": "speech_package_install",
            "remove": "speech_package_remove"
        },
        "platforms": platforms,
    })
    .to_string();
    SpeechFixture {
        catalog: parse_speech_for_test(&raw, PLATFORM).unwrap(),
        archive,
    }
}

fn manager(
    temp: &TempDir,
    catalog: DeliveryCatalog,
    fetcher: Arc<dyn ArchiveFetcher>,
    coordinator: Arc<dyn RuntimeCoordinator>,
) -> EnginePackageManager {
    manager_with_clock_and_verifier(
        temp,
        catalog,
        fetcher,
        coordinator,
        Arc::new(verified_install::current_unix_seconds),
        Arc::new(receipt::validate_integrity),
    )
}

fn manager_with_clock_and_verifier(
    temp: &TempDir,
    catalog: DeliveryCatalog,
    fetcher: Arc<dyn ArchiveFetcher>,
    coordinator: Arc<dyn RuntimeCoordinator>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    verify_integrity: Arc<IntegrityVerifier>,
) -> EnginePackageManager {
    let root = initialize_store(&temp.path().join("packages")).unwrap();
    let store_lock = acquire_store_lock(&root).unwrap();
    let staging_authority =
        RuntimeStagingAuthority::prepare(&root.join(".runtime-staging-authority")).unwrap();
    let catalog = Box::leak(Box::new(catalog));
    recover_interrupted_mutations(&root, catalog).unwrap();
    let quiesce = Arc::new(move |engine| coordinator.quiesce(engine));
    EnginePackageManager(ManagedPackageManager(Arc::new(ManagerInner {
        root,
        _store_lock: store_lock,
        staging_authority,
        catalog,
        fetcher,
        quiesce,
        clock,
        verify_integrity,
        verification_published_hook: Mutex::new(None),
        activity: Mutex::new(ActivityState::default()),
    })))
}

fn fake_clock(initial_unix_seconds: u64) -> (Arc<AtomicU64>, Arc<dyn Fn() -> u64 + Send + Sync>) {
    let now = Arc::new(AtomicU64::new(initial_unix_seconds));
    let clock_now = now.clone();
    let clock = Arc::new(move || clock_now.load(Ordering::Acquire));
    (now, clock)
}

fn wait_for_flight_holders(
    manager: &EnginePackageManager,
    key: &(EngineId, String),
    minimum_holders: usize,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let joined = manager
            .0
            .0
            .activity
            .lock()
            .unwrap()
            .verifying_versions
            .get(key)
            .is_some_and(|flight| Arc::strong_count(flight) >= minimum_holders);
        if joined {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "concurrent callers never joined the active verification generation"
        );
        std::thread::yield_now();
    }
}

fn speech_manager(
    temp: &TempDir,
    catalog: SpeechDeliveryCatalog,
    fetcher: Arc<dyn ArchiveFetcher>,
    coordinator: Arc<dyn SpeechRuntimeCoordinator>,
) -> SpeechPackageManager {
    let root = initialize_store(&temp.path().join("speech-packages")).unwrap();
    let store_lock = acquire_store_lock(&root).unwrap();
    let staging_authority =
        RuntimeStagingAuthority::prepare(&root.join(".runtime-staging-authority")).unwrap();
    let catalog = Box::leak(Box::new(catalog));
    recover_interrupted_mutations(&root, catalog).unwrap();
    let quiesce = Arc::new(move |backend| coordinator.quiesce(backend));
    SpeechPackageManager(ManagedPackageManager(Arc::new(ManagerInner {
        root,
        _store_lock: store_lock,
        staging_authority,
        catalog,
        fetcher,
        quiesce,
        clock: Arc::new(verified_install::current_unix_seconds),
        verify_integrity: Arc::new(receipt::validate_integrity),
        verification_published_hook: Mutex::new(None),
        activity: Mutex::new(ActivityState::default()),
    })))
}

mod legacy;
mod lifecycle;
mod mutation_gate;
mod recovery;
mod tamper;
mod verification;
