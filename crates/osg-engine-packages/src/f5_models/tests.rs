use std::collections::VecDeque;
use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};

use sha2::{Digest as _, Sha256};

use super::*;
use crate::catalog::DeliveryAsset;
use crate::download::FetchRequest;
use crate::f5_catalog::parse_catalog;

const ID: &str = "f5tts-spanish";
const REVISION: &str = "4765c14ffd01075479c2fde8615831acc0adca9a";
const CHECKPOINT: &[u8] = b"checkpoint weights, sixty-four bytes of reviewed model content!!";
const VOCABULARY: &[u8] = b"a\nb\nc\n";

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn catalog() -> &'static F5Catalog {
    let base = format!("https://huggingface.co/owner/f5-test/resolve/{REVISION}");
    let raw = serde_json::json!({
        "schemaVersion": 1,
        "commands": {
            "status": "f5_models_status",
            "install": "f5_model_install",
            "cancel": "f5_model_cancel",
            "remove": "f5_model_remove"
        },
        "models": [{
            "id": ID,
            "name": "F5 Test",
            "author": "owner",
            "language": "es",
            "license": "CC-BY-4.0",
            "revision": REVISION,
            "architecture": "F5TTS_Base",
            "checkpoint": {
                "path": "model.safetensors",
                "asset": "weights.safetensors",
                "urls": [format!("{base}/weights.safetensors")],
                "sizeBytes": CHECKPOINT.len(),
                "sha256": sha(CHECKPOINT)
            },
            "vocabulary": {
                "path": "vocab.txt",
                "asset": "vocab.txt",
                "urls": [format!("{base}/vocab.txt")],
                "sizeBytes": VOCABULARY.len(),
                "sha256": sha(VOCABULARY)
            }
        }]
    });
    Box::leak(Box::new(parse_catalog(&raw.to_string()).unwrap()))
}

/// One scripted reply of the fake origin.
enum Step {
    /// Appends `n` correct bytes, then fails like a dropped connection.
    Interrupt(usize),
    /// Appends `n` correct bytes, then the user cancels.
    Cancel(usize),
    /// Serves the remainder with every byte flipped (same size, wrong digest).
    Corrupt,
}

#[derive(Default)]
struct FakeOrigin {
    script: Mutex<VecDeque<Step>>,
    calls: AtomicUsize,
    resume_offsets: Mutex<Vec<(String, u64)>>,
    during_fetch: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl FakeOrigin {
    fn scripted(steps: impl IntoIterator<Item = Step>) -> Arc<Self> {
        let origin = Self::default();
        origin.script.lock().unwrap().extend(steps);
        Arc::new(origin)
    }
}

impl ArchiveFetcher for FakeOrigin {
    fn fetch(
        &self,
        asset: &DeliveryAsset,
        _url: &str,
        request: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.resume_offsets
            .lock()
            .unwrap()
            .push((asset.asset.clone(), request.resume_from));
        if let Some(check) = self.during_fetch.lock().unwrap().as_ref() {
            check();
        }
        let content = if asset.asset == "vocab.txt" {
            VOCABULARY
        } else {
            CHECKPOINT
        };
        let start = usize::try_from(request.resume_from).unwrap();
        let mut output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(request.target)
            .unwrap();
        let step = self.script.lock().unwrap().pop_front();
        match step {
            Some(Step::Interrupt(count)) => {
                output.write_all(&content[start..start + count]).unwrap();
                Err(PackageError::Network)
            }
            Some(Step::Cancel(count)) => {
                output.write_all(&content[start..start + count]).unwrap();
                request.cancellation.cancel();
                Err(PackageError::Cancelled)
            }
            Some(Step::Corrupt) => {
                let flipped = content[start..]
                    .iter()
                    .map(|byte| !byte)
                    .collect::<Vec<_>>();
                output.write_all(&flipped).unwrap();
                Ok(None)
            }
            None => {
                output.write_all(&content[start..]).unwrap();
                Ok(None)
            }
        }
    }
}

fn manager(root: &Path, origin: &Arc<FakeOrigin>) -> F5ModelManager {
    F5ModelManager::with_fetcher(root, catalog(), origin.clone()).unwrap()
}

fn install(manager: &F5ModelManager) -> Result<()> {
    manager.install(ID, &CancellationToken::default(), &|_| {})
}

fn entries(directory: &Path) -> Vec<String> {
    let mut names = fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn installs_the_worker_layout_and_leaves_no_downloads_behind() {
    let temp = tempfile::tempdir().unwrap();
    let origin = FakeOrigin::scripted([]);
    let manager = manager(temp.path(), &origin);
    assert!(!manager.is_installed(ID));
    install(&manager).unwrap();

    assert!(manager.is_installed(ID));
    let model = temp.path().join(ID);
    assert_eq!(
        fs::read(model.join("model.safetensors")).unwrap(),
        CHECKPOINT
    );
    assert_eq!(fs::read(model.join("vocab.txt")).unwrap(), VOCABULARY);
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(model.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(receipt["checkpointSha256"], sha(CHECKPOINT));
    assert!(entries(&temp.path().join(".downloads")).is_empty());
    assert!(entries(&temp.path().join(".staging")).is_empty());

    // Installed is a no-op: nothing is fetched again.
    let calls = origin.calls.load(Ordering::SeqCst);
    install(&manager).unwrap();
    assert_eq!(origin.calls.load(Ordering::SeqCst), calls);
}

#[test]
fn an_interrupted_download_resumes_instead_of_restarting() {
    let temp = tempfile::tempdir().unwrap();
    let origin =
        FakeOrigin::scripted([Step::Interrupt(20), Step::Interrupt(0), Step::Interrupt(0)]);
    let manager = manager(temp.path(), &origin);
    assert_eq!(install(&manager), Err(PackageError::Network));
    assert!(!temp.path().join(ID).exists());

    install(&manager).unwrap();
    assert!(manager.is_installed(ID));
    let offsets = origin.resume_offsets.lock().unwrap().clone();
    assert_eq!(offsets[0], ("weights.safetensors".to_owned(), 0));
    assert_eq!(
        offsets[3],
        ("weights.safetensors".to_owned(), 20),
        "the second attempt continues from the bytes already on disk"
    );
    assert_eq!(
        fs::read(temp.path().join(ID).join("model.safetensors")).unwrap(),
        CHECKPOINT
    );
}

#[test]
fn a_hash_mismatch_is_rejected_and_nothing_is_published() {
    let temp = tempfile::tempdir().unwrap();
    let origin = FakeOrigin::scripted([Step::Corrupt]);
    let manager = manager(temp.path(), &origin);
    assert_eq!(install(&manager), Err(PackageError::ArchiveIntegrity));
    assert!(!temp.path().join(ID).exists());
    assert!(!manager.is_installed(ID));
    assert!(
        entries(&temp.path().join(".downloads"))
            .iter()
            .all(|name| !name.ends_with(".partial")),
        "corrupt bytes are never kept for resumption"
    );
}

#[test]
fn cancelling_mid_download_keeps_the_partial_and_publishes_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let origin = FakeOrigin::scripted([Step::Cancel(16)]);
    let manager = manager(temp.path(), &origin);
    let cancellation = CancellationToken::default();
    assert_eq!(
        manager.install(ID, &cancellation, &|_| {}),
        Err(PackageError::Cancelled)
    );
    assert!(!temp.path().join(ID).exists());
    assert!(entries(&temp.path().join(".staging")).is_empty());
    let downloads = temp.path().join(".downloads");
    let partial = entries(&downloads)
        .into_iter()
        .find(|name| name.ends_with(".partial"))
        .unwrap();
    assert_eq!(fs::metadata(downloads.join(partial)).unwrap().len(), 16);
}

fn write_stale_model(root: &Path) -> PathBuf {
    let model = root.join(ID);
    fs::create_dir_all(&model).unwrap();
    fs::write(model.join("model.safetensors"), b"stale, truncated").unwrap();
    fs::write(model.join("vocab.txt"), VOCABULARY).unwrap();
    fs::write(model.join("receipt.json"), b"{}").unwrap();
    model
}

#[test]
fn publication_swaps_whole_trees_and_never_exposes_a_half_replaced_model() {
    let temp = tempfile::tempdir().unwrap();
    let model = write_stale_model(temp.path());
    let origin = FakeOrigin::scripted([]);
    let observed = model.clone();
    *origin.during_fetch.lock().unwrap() = Some(Box::new(move || {
        assert_eq!(
            fs::read(observed.join("model.safetensors")).unwrap(),
            b"stale, truncated",
            "the previous tree is untouched while new bytes arrive"
        );
    }));
    let manager = manager(temp.path(), &origin);
    assert!(!manager.is_installed(ID));
    install(&manager).unwrap();

    assert!(manager.is_installed(ID));
    assert_eq!(
        fs::read(model.join("model.safetensors")).unwrap(),
        CHECKPOINT
    );
    assert_eq!(
        entries(&model),
        ["model.safetensors", "receipt.json", "vocab.txt"]
    );
    assert!(entries(&temp.path().join(".quarantine")).is_empty());
}

#[cfg(windows)]
#[test]
fn a_failed_swap_restores_the_previous_tree_and_keeps_the_download() {
    use std::os::windows::fs::OpenOptionsExt as _;
    const FILE_SHARE_READ: u32 = 0x1;

    let temp = tempfile::tempdir().unwrap();
    let model = write_stale_model(temp.path());
    let origin = FakeOrigin::scripted([]);
    let manager = manager(temp.path(), &origin);
    // A worker holding the old checkpoint open without delete sharing blocks the swap.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(model.join("model.safetensors"))
        .unwrap();
    assert_eq!(install(&manager), Err(PackageError::StoreUnavailable));
    assert_eq!(
        fs::read(model.join("model.safetensors")).unwrap(),
        b"stale, truncated"
    );
    assert_eq!(
        entries(&model),
        ["model.safetensors", "receipt.json", "vocab.txt"]
    );
    drop(held);

    let calls = origin.calls.load(Ordering::SeqCst);
    install(&manager).unwrap();
    assert!(manager.is_installed(ID));
    assert_eq!(
        origin.calls.load(Ordering::SeqCst),
        calls,
        "the verified download was kept and reused"
    );
}

#[test]
fn removal_retires_the_model_but_preserves_modified_trees() {
    let temp = tempfile::tempdir().unwrap();
    let origin = FakeOrigin::scripted([]);
    let manager = manager(temp.path(), &origin);
    let cancellation = CancellationToken::default();
    assert_eq!(
        manager.remove(ID, &cancellation),
        Ok(RemovalOutcome::Missing)
    );
    install(&manager).unwrap();

    let user_file = temp.path().join(ID).join("notes.txt");
    fs::write(&user_file, b"mine").unwrap();
    assert_eq!(
        manager.remove(ID, &cancellation),
        Ok(RemovalOutcome::PreservedModified)
    );
    assert_eq!(fs::read(&user_file).unwrap(), b"mine");

    fs::remove_file(user_file).unwrap();
    assert_eq!(
        manager.remove(ID, &cancellation),
        Ok(RemovalOutcome::Removed)
    );
    assert!(!temp.path().join(ID).exists());
    assert!(!manager.is_installed(ID));
    assert!(entries(&temp.path().join(".quarantine")).is_empty());
    assert_eq!(
        manager.remove("f5tts-unknown", &cancellation),
        Err(PackageError::InvalidRequest)
    );
}

#[test]
fn models_published_by_earlier_builds_stay_installed_and_old_staging_is_reclaimed() {
    let temp = tempfile::tempdir().unwrap();
    let model = temp.path().join(ID);
    fs::create_dir_all(&model).unwrap();
    fs::write(model.join("model.safetensors"), CHECKPOINT).unwrap();
    fs::write(model.join("vocab.txt"), VOCABULARY).unwrap();
    let legacy_receipt = serde_json::json!({
        "id": ID,
        "revision": REVISION,
        "checkpointSha256": sha(CHECKPOINT),
        "vocabularySha256": sha(VOCABULARY),
    });
    fs::write(
        model.join("receipt.json"),
        serde_json::to_vec_pretty(&legacy_receipt).unwrap(),
    )
    .unwrap();
    let stranded = temp.path().join(format!(".{ID}.{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&stranded).unwrap();
    fs::write(stranded.join("model.safetensors"), b"partial").unwrap();
    let foreign = temp.path().join(".unrelated");
    fs::create_dir_all(&foreign).unwrap();

    let origin = FakeOrigin::scripted([]);
    let manager = manager(temp.path(), &origin);
    assert!(manager.is_installed(ID));
    assert!(!stranded.exists());
    assert!(foreign.exists());
}

#[test]
fn a_second_operation_is_refused_while_one_is_running() {
    let temp = tempfile::tempdir().unwrap();
    let origin = FakeOrigin::scripted([]);
    let manager = manager(temp.path(), &origin);
    let held = manager.begin_operation().unwrap();
    assert_eq!(install(&manager), Err(PackageError::RuntimeBusy));
    drop(held);
    install(&manager).unwrap();
}
