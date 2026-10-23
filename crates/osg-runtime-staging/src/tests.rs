use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;

use crate::journal::OwnershipJournal;
use crate::{
    AUTHORITY_TEMP_PREFIX, JOURNAL_PREFIX, JOURNAL_TEMP_PREFIX, OwnedStagingDirectory,
    OwnedStagingFile, RuntimeStagingAuthority, StagingKind,
};

const CRASH_AUTHORITY_ROOT: &str = "OSG_RUNTIME_STAGING_TEST_AUTHORITY";
const CRASH_TARGET_ROOT: &str = "OSG_RUNTIME_STAGING_TEST_TARGET";
const CRASH_READY_FILE: &str = "OSG_RUNTIME_STAGING_TEST_READY";

fn fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    RuntimeStagingAuthority,
) {
    let authority_root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let authority = RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();
    (authority_root, target_root, authority)
}

#[test]
fn stale_directory_is_reclaimed_but_unjournaled_lookalike_is_not() {
    let (_authority_root, target, authority) = fixture();
    let owned =
        OwnedStagingDirectory::begin(&authority, target.path(), StagingKind::Render).unwrap();
    let owned_path = owned.path().to_owned();
    fs::write(owned.path().join("large.bin"), b"render").unwrap();
    owned.abandon_as_if_process_terminated();
    let lookalike = target.path().join(".osg-render-not-owned");
    fs::create_dir(&lookalike).unwrap();

    authority.reconcile_all().unwrap();

    assert!(!owned_path.exists());
    assert!(lookalike.is_dir());
}

#[test]
fn every_large_runtime_cache_kind_is_reclaimed_only_from_its_authenticated_journal() {
    let (_authority_root, target, authority) = fixture();
    let kinds = [
        StagingKind::SpeechWorkerCache,
        StagingKind::AsrWorkerCache,
        StagingKind::NativeToolDownload,
        StagingKind::NativeToolExtraction,
        StagingKind::NativeToolQuarantine,
        StagingKind::EnginePackageInstall,
        StagingKind::EnginePackageAdoption,
        StagingKind::EnginePackageQuarantine,
        StagingKind::MediaBlobSession,
        StagingKind::MediaPipelineJob,
    ];
    let mut owned_paths = Vec::new();
    for kind in kinds {
        let owned = OwnedStagingDirectory::begin(&authority, target.path(), kind).unwrap();
        fs::write(owned.path().join("large.bin"), vec![0_u8; 4096]).unwrap();
        owned_paths.push(owned.path().to_owned());
        owned.abandon_as_if_process_terminated();
    }
    let foreign = target.path().join("session-not-owned");
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("recording.wav"), b"customer").unwrap();

    authority.reconcile_all().unwrap();

    assert!(owned_paths.iter().all(|path| !path.exists()));
    assert_eq!(
        fs::read(foreign.join("recording.wav")).unwrap(),
        b"customer"
    );
}

#[test]
#[ignore = "subprocess helper; the parent test terminates it after its live journal is locked"]
fn hard_crash_staging_child() {
    let (Ok(authority_root), Ok(target_root), Ok(ready_file)) = (
        std::env::var(CRASH_AUTHORITY_ROOT),
        std::env::var(CRASH_TARGET_ROOT),
        std::env::var(CRASH_READY_FILE),
    ) else {
        return;
    };
    let authority = RuntimeStagingAuthority::prepare(Path::new(&authority_root)).unwrap();
    let owned = OwnedStagingDirectory::begin(
        &authority,
        Path::new(&target_root),
        StagingKind::MediaBlobSession,
    )
    .unwrap();
    fs::write(owned.path().join("recording.wav"), vec![0_u8; 1024 * 1024]).unwrap();
    fs::write(ready_file, b"ready").unwrap();
    loop {
        thread::sleep(Duration::from_mins(1));
    }
}

#[test]
fn killed_process_session_is_reclaimed_on_the_next_startup() {
    let authority_root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let handoff = tempfile::NamedTempFile::new().unwrap();
    let ready_path = handoff.path().to_owned();
    drop(handoff);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::hard_crash_staging_child",
            "--ignored",
            "--nocapture",
        ])
        .env(CRASH_AUTHORITY_ROOT, authority_root.path())
        .env(CRASH_TARGET_ROOT, target_root.path())
        .env(CRASH_READY_FILE, &ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready_path.exists() && Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "staging child exited early"
        );
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        ready_path.exists(),
        "staging child never published readiness"
    );
    let owned_paths = fs::read_dir(target_root.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(owned_paths.len(), 1);
    let owned_path = owned_paths[0].clone();
    assert!(owned_path.is_dir());
    child.kill().unwrap();
    let _ = child.wait().unwrap();

    RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();

    assert!(!owned_path.exists());
}

#[test]
fn live_journal_prevents_reclamation() {
    let (_authority_root, target, authority) = fixture();
    let owned =
        OwnedStagingDirectory::begin(&authority, target.path(), StagingKind::Download).unwrap();
    let path = owned.path().to_owned();

    let report = authority.reconcile_all().unwrap();
    assert_eq!(report.active, 1);
    assert_eq!(report.deferred, 0);
    assert_eq!(report.reclaimed, 0);
    assert!(path.is_dir());
    drop(owned);
    assert!(!path.exists());
}

#[test]
fn absent_destination_keeps_authority_until_the_same_directory_returns() {
    let (authority_root, target, authority) = fixture();
    let original_root = target.path().to_owned();
    let offline_root = authority_root.path().join("offline-destination");
    let owned =
        OwnedStagingDirectory::begin(&authority, &original_root, StagingKind::Download).unwrap();
    let entry_name = owned.path().file_name().unwrap().to_owned();
    fs::write(owned.path().join("large.bin"), b"download").unwrap();
    owned.abandon_as_if_process_terminated();
    fs::rename(&original_root, &offline_root).unwrap();

    let deferred = authority.reconcile_all().unwrap();

    assert_eq!(deferred.deferred, 1);
    assert!(offline_root.join(&entry_name).is_dir());
    fs::rename(&offline_root, &original_root).unwrap();

    let reclaimed = authority.reconcile_all().unwrap();
    assert_eq!(reclaimed.reclaimed, 1);
    assert!(!original_root.join(entry_name).exists());
}

#[test]
fn replacement_directory_at_same_spelling_cannot_receive_stale_deletion() {
    let (authority_root, target, authority) = fixture();
    let original_root = target.path().to_owned();
    let offline_root = authority_root.path().join("original-destination");
    let replacement_parking = authority_root.path().join("replacement-destination");
    let owned =
        OwnedStagingDirectory::begin(&authority, &original_root, StagingKind::Render).unwrap();
    let entry_name = owned.path().file_name().unwrap().to_owned();
    fs::write(owned.path().join("old.bin"), b"owned").unwrap();
    owned.abandon_as_if_process_terminated();
    fs::rename(&original_root, &offline_root).unwrap();
    fs::create_dir(&original_root).unwrap();
    let foreign = original_root.join(&entry_name);
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("customer.bin"), b"keep").unwrap();

    let report = authority.reconcile_all().unwrap();

    assert_eq!(report.deferred, 1);
    assert_eq!(fs::read(foreign.join("customer.bin")).unwrap(), b"keep");
    fs::rename(&original_root, &replacement_parking).unwrap();
    fs::rename(&offline_root, &original_root).unwrap();
    let report = authority.reconcile_all().unwrap();
    assert_eq!(report.reclaimed, 1);
    assert!(!original_root.join(entry_name).exists());
    fs::remove_dir_all(replacement_parking).unwrap();
}

#[test]
fn live_guard_cannot_delete_from_a_replacement_directory() {
    let (authority_root, target, authority) = fixture();
    let original_root = target.path().to_owned();
    let offline_root = authority_root.path().join("live-original-destination");
    let replacement_parking = authority_root.path().join("live-replacement-destination");
    let owned =
        OwnedStagingDirectory::begin(&authority, &original_root, StagingKind::Render).unwrap();
    let entry_name = owned.path().file_name().unwrap().to_owned();
    fs::rename(&original_root, &offline_root).unwrap();
    fs::create_dir(&original_root).unwrap();
    let foreign = original_root.join(&entry_name);
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("customer.bin"), b"keep").unwrap();

    drop(owned);

    assert_eq!(fs::read(foreign.join("customer.bin")).unwrap(), b"keep");
    fs::rename(&original_root, &replacement_parking).unwrap();
    fs::rename(&offline_root, &original_root).unwrap();
    authority.reconcile_all().unwrap();
    fs::remove_dir_all(replacement_parking).unwrap();
}

#[test]
fn forged_valid_shaped_journal_cannot_authorize_deletion() {
    let (authority_root, target, authority) = fixture();
    let nonce = "0123456789abcdef0123456789abcdef";
    let foreign = target.path().join(StagingKind::Render.entry_name(nonce));
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("customer.bin"), b"keep").unwrap();
    let mut forged = OwnershipJournal::new(
        &authority,
        StagingKind::Render,
        nonce.to_owned(),
        &fs::canonicalize(target.path()).unwrap(),
    )
    .unwrap();
    forged.authority_tag = "00".repeat(32);
    fs::write(
        authority_root
            .path()
            .join(StagingKind::Render.journal_name(nonce)),
        serde_json::to_vec(&forged).unwrap(),
    )
    .unwrap();

    assert!(authority.reconcile_all().is_err());
    assert_eq!(fs::read(foreign.join("customer.bin")).unwrap(), b"keep");
}

#[test]
fn interrupted_journal_sidecar_never_blocks_or_authorizes_cleanup() {
    let (authority_root, target, authority) = fixture();
    let sidecar = authority_root.path().join(format!(
        "{JOURNAL_TEMP_PREFIX}0123456789abcdef0123456789abcdef.tmp"
    ));
    fs::write(&sidecar, b"{partial").unwrap();
    let foreign = target.path().join(".osg-export-foreign.part");
    fs::write(&foreign, b"keep").unwrap();

    authority.reconcile_all().unwrap();

    assert!(!sidecar.exists());
    assert_eq!(fs::read(foreign).unwrap(), b"keep");
}

#[test]
fn concurrent_begin_sidecars_are_skipped_until_their_owner_unlocks() {
    let (authority_root, _target, authority) = fixture();
    let nonce = "0123456789abcdef0123456789abcdef";
    let journal_sidecar = authority_root
        .path()
        .join(format!("{JOURNAL_TEMP_PREFIX}{nonce}.tmp"));
    let mut writer = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&journal_sidecar)
        .unwrap();
    writer.lock_exclusive().unwrap();
    writer.write_all(b"in progress").unwrap();

    authority.reconcile_all().unwrap();

    assert!(journal_sidecar.is_file());
    FileExt::unlock(&writer).unwrap();
    drop(writer);
    authority.reconcile_all().unwrap();
    assert!(!journal_sidecar.exists());

    let authority_sidecar = authority_root
        .path()
        .join(format!("{AUTHORITY_TEMP_PREFIX}{nonce}.tmp"));
    let mut writer = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&authority_sidecar)
        .unwrap();
    writer.lock_exclusive().unwrap();
    writer.write_all(b"in progress").unwrap();

    RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();

    assert!(authority_sidecar.is_file());
    FileExt::unlock(&writer).unwrap();
    drop(writer);
    RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();
    assert!(!authority_sidecar.exists());
}

#[test]
fn parallel_staging_admission_and_cleanup_preserve_live_owners() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("payloads");
    fs::create_dir(&root).unwrap();
    let authority = RuntimeStagingAuthority::prepare(&temporary.path().join("authority")).unwrap();
    let barrier = std::sync::Barrier::new(12);
    std::thread::scope(|scope| {
        let barrier = &barrier;
        for _ in 0..12 {
            let root = &root;
            let authority = &authority;
            scope.spawn(move || {
                // Independent handles must coordinate through the filesystem, not merely
                // through a mutex shared by clones of one Rust value.
                let authority = RuntimeStagingAuthority::prepare(&authority.inner.root).unwrap();
                barrier.wait();
                for _ in 0..40 {
                    let directory = OwnedStagingDirectory::begin(
                        &authority,
                        root,
                        StagingKind::NativeToolDownload,
                    )
                    .expect("parallel admission must preserve active journal writers");
                    assert!(directory.path().is_dir());
                    directory.remove().expect("owned staging cleanup");
                }
            });
        }
    });
    authority.reconcile_all().unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn prefix_lookalikes_in_the_private_root_are_never_adopted() {
    let (authority_root, _target, authority) = fixture();
    let journal_lookalike = authority_root
        .path()
        .join(format!("{JOURNAL_TEMP_PREFIX}customer-note.txt"));
    let authority_lookalike = authority_root
        .path()
        .join(format!("{AUTHORITY_TEMP_PREFIX}customer-note.txt"));
    fs::write(&journal_lookalike, b"keep journal lookalike").unwrap();
    fs::write(&authority_lookalike, b"keep authority lookalike").unwrap();

    authority.reconcile_all().unwrap();
    RuntimeStagingAuthority::prepare(authority_root.path()).unwrap();

    assert_eq!(
        fs::read(journal_lookalike).unwrap(),
        b"keep journal lookalike"
    );
    assert_eq!(
        fs::read(authority_lookalike).unwrap(),
        b"keep authority lookalike"
    );
}

#[test]
fn stale_part_is_reclaimed_and_publication_retires_journal() {
    let (authority_root, target, authority) = fixture();
    let mut stale =
        OwnedStagingFile::begin(&authority, target.path(), StagingKind::MediaExport).unwrap();
    stale.file_mut().unwrap().write_all(b"partial").unwrap();
    let stale_path = stale.path().to_owned();
    stale.abandon_as_if_process_terminated();
    authority.reconcile_all().unwrap();
    assert!(!stale_path.exists());

    let destination = target.path().join("video.mp4");
    fs::write(&destination, b"old").unwrap();
    let mut staged =
        OwnedStagingFile::begin(&authority, target.path(), StagingKind::MediaExport).unwrap();
    staged.file_mut().unwrap().write_all(b"new").unwrap();
    staged.replace_atomic(&destination).unwrap();
    assert_eq!(fs::read(destination).unwrap(), b"new");
    assert_eq!(
        fs::read_dir(authority_root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(JOURNAL_PREFIX))
            .count(),
        0
    );
}

#[test]
fn foreign_object_at_exact_owned_path_is_preserved() {
    let (_authority_root, target, authority) = fixture();
    let owned =
        OwnedStagingDirectory::begin(&authority, target.path(), StagingKind::Render).unwrap();
    let path = owned.path().to_owned();
    owned.abandon_as_if_process_terminated();
    fs::remove_dir(&path).unwrap();
    fs::write(&path, b"foreign").unwrap();

    assert!(authority.reconcile_all().is_err());
    assert_eq!(fs::read(path).unwrap(), b"foreign");
}
