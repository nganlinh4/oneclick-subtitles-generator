use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;

use sha2::{Digest as _, Sha256};

use crate::catalog::{MAX_FILES, PackageDelivery};
use crate::delivery_manifest::ManifestFile;
use crate::path_security::{prepare_target, require_regular_file, validate_manifest_path};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::{CancellationToken, PackageError, Result};

pub(crate) fn extract(
    archive_path: &Path,
    staging_root: &Path,
    delivery: &PackageDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let archive_file = fs::File::open(archive_path).map_err(|_| PackageError::UnsafeArchive)?;
    let mut archive =
        zip::ZipArchive::new(archive_file).map_err(|_| PackageError::UnsafeArchive)?;
    if archive.len() != delivery.files.len() || archive.len() > MAX_FILES {
        return Err(PackageError::UnsafeArchive);
    }
    let expected_by_path = delivery
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<HashMap<_, _>>();

    let mut seen = HashSet::with_capacity(delivery.files.len());
    let mut expanded = 0_u64;
    let total = delivery.unpacked_size_bytes;
    for index in 0..archive.len() {
        cancellation.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| PackageError::UnsafeArchive)?;
        let name = entry.name().to_string();
        validate_manifest_path(&name).map_err(|_| PackageError::UnsafeArchive)?;
        if entry.is_dir() || !safe_unix_mode(entry.unix_mode()) {
            return Err(PackageError::UnsafeArchive);
        }
        let enclosed = entry.enclosed_name().ok_or(PackageError::UnsafeArchive)?;
        if enclosed.to_string_lossy().replace('\\', "/") != name {
            return Err(PackageError::UnsafeArchive);
        }
        let expected = expected_by_path
            .get(name.as_str())
            .copied()
            .ok_or(PackageError::UnsafeArchive)?;
        if !seen.insert(name.clone()) || entry.size() != expected.size_bytes {
            return Err(PackageError::UnsafeArchive);
        }

        let target = prepare_target(staging_root, &name)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|_| PackageError::UnsafeArchive)?;
        let mut hasher = Sha256::new();
        let mut file_written = 0_u64;
        let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
        loop {
            cancellation.check()?;
            let read = entry
                .read(&mut buffer)
                .map_err(|_| PackageError::UnsafeArchive)?;
            if read == 0 {
                break;
            }
            file_written = file_written
                .checked_add(read as u64)
                .filter(|written| *written <= expected.size_bytes)
                .ok_or(PackageError::UnsafeArchive)?;
            expanded = expanded
                .checked_add(read as u64)
                .filter(|written| *written <= delivery.unpacked_size_bytes)
                .ok_or(PackageError::StorageLimit)?;
            output
                .write_all(&buffer[..read])
                .map_err(|_| PackageError::UnsafeArchive)?;
            hasher.update(&buffer[..read]);
            progress.on_progress(OperationProgress::new(
                OperationPhase::Extracting,
                expanded,
                total,
            ));
        }
        if file_written != expected.size_bytes
            || format!("{:x}", hasher.finalize()) != expected.sha256
        {
            return Err(PackageError::ArchiveIntegrity);
        }
        output.flush().map_err(|_| PackageError::StoreUnavailable)?;
        output
            .sync_all()
            .map_err(|_| PackageError::StoreUnavailable)?;
        set_permissions(&target, expected.executable)?;
        let metadata = require_regular_file(&target)?;
        if metadata.len() != expected.size_bytes {
            return Err(PackageError::ArchiveIntegrity);
        }
    }
    if expanded != delivery.unpacked_size_bytes || seen.len() != delivery.files.len() {
        return Err(PackageError::UnsafeArchive);
    }
    Ok(())
}

pub(crate) fn extract_manifest_source(
    archive_path: &Path,
    staging_root: &Path,
    expected_files: &[&ManifestFile],
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
    progress_base: u64,
    progress_total: u64,
) -> Result<u64> {
    let archive_file = fs::File::open(archive_path).map_err(|_| PackageError::UnsafeArchive)?;
    let mut archive =
        zip::ZipArchive::new(archive_file).map_err(|_| PackageError::UnsafeArchive)?;
    if archive.len() != expected_files.len() || archive.len() > MAX_FILES {
        return Err(PackageError::UnsafeArchive);
    }
    let expected_by_archive_path = expected_files
        .iter()
        .map(|entry| {
            entry
                .archive_path
                .as_deref()
                .map(|path| (path, *entry))
                .ok_or(PackageError::InvalidCatalog)
        })
        .collect::<Result<HashMap<_, _>>>()?;
    if expected_by_archive_path.len() != expected_files.len() {
        return Err(PackageError::InvalidCatalog);
    }

    let mut seen = HashSet::with_capacity(expected_files.len());
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        cancellation.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| PackageError::UnsafeArchive)?;
        let name = entry.name().to_string();
        validate_manifest_path(&name).map_err(|_| PackageError::UnsafeArchive)?;
        if entry.is_dir() || !safe_unix_mode(entry.unix_mode()) {
            return Err(PackageError::UnsafeArchive);
        }
        let enclosed = entry.enclosed_name().ok_or(PackageError::UnsafeArchive)?;
        if enclosed.to_string_lossy().replace('\\', "/") != name {
            return Err(PackageError::UnsafeArchive);
        }
        let manifest_file = expected_by_archive_path
            .get(name.as_str())
            .copied()
            .ok_or(PackageError::UnsafeArchive)?;
        let expected = &manifest_file.file;
        if !seen.insert(name) || entry.size() != expected.size_bytes {
            return Err(PackageError::UnsafeArchive);
        }

        let target = prepare_target(staging_root, &expected.path)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|_| PackageError::UnsafeArchive)?;
        let mut hasher = Sha256::new();
        let mut file_written = 0_u64;
        let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
        loop {
            cancellation.check()?;
            let read = entry
                .read(&mut buffer)
                .map_err(|_| PackageError::UnsafeArchive)?;
            if read == 0 {
                break;
            }
            file_written = file_written
                .checked_add(read as u64)
                .filter(|written| *written <= expected.size_bytes)
                .ok_or(PackageError::UnsafeArchive)?;
            expanded = expanded
                .checked_add(read as u64)
                .filter(|written| progress_base.saturating_add(*written) <= progress_total)
                .ok_or(PackageError::StorageLimit)?;
            output
                .write_all(&buffer[..read])
                .map_err(|_| PackageError::UnsafeArchive)?;
            hasher.update(&buffer[..read]);
            progress.on_progress(OperationProgress::new(
                OperationPhase::Extracting,
                progress_base.saturating_add(expanded),
                progress_total,
            ));
        }
        if file_written != expected.size_bytes
            || format!("{:x}", hasher.finalize()) != expected.sha256
        {
            return Err(PackageError::ArchiveIntegrity);
        }
        output.flush().map_err(|_| PackageError::StoreUnavailable)?;
        output
            .sync_all()
            .map_err(|_| PackageError::StoreUnavailable)?;
        set_permissions(&target, expected.executable)?;
    }
    if seen.len() != expected_files.len() {
        return Err(PackageError::UnsafeArchive);
    }
    Ok(expanded)
}

fn safe_unix_mode(mode: Option<u32>) -> bool {
    mode.is_none_or(|mode| {
        let file_type = mode & 0o170_000;
        file_type == 0 || file_type == 0o100_000
    })
}

#[cfg(unix)]
fn set_permissions(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| PackageError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn set_permissions(_: &Path, _: bool) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write as _};

    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::catalog::{DeliveryFile, EngineId, FileRole};

    fn one_file_delivery() -> PackageDelivery {
        PackageDelivery {
            component: EngineId::Parakeet.as_str().to_string(),
            platform: "windows-x86_64".to_string(),
            version: "1.0.0".to_string(),
            asset: "fixture.zip".to_string(),
            source_url: "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/asr-engine-packs-v1/fixture.zip".to_string(),
            size_bytes: 1,
            sha256: "0".repeat(64),
            unpacked_size_bytes: 1,
            python_relative_path: "runtime/python.exe".to_string(),
            model_relative_path: Some("model".to_string()),
            aligner_relative_path: None,
            files: vec![DeliveryFile {
                path: "model/config.json".to_string(),
                size_bytes: 1,
                sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
                    .to_string(),
                executable: false,
                role: FileRole::Model,
            }],
            sources: Vec::new(),
            manifest: None,
        }
    }

    #[test]
    fn traversal_entry_is_rejected_before_any_outside_write() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("../escape", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        let encoded = writer.finish().unwrap().into_inner();
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("hostile.zip");
        let staging = temp.path().join("staging");
        fs::write(&archive_path, encoded).unwrap();
        fs::create_dir(&staging).unwrap();

        assert_eq!(
            extract(
                &archive_path,
                &staging,
                &one_file_delivery(),
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(PackageError::UnsafeArchive)
        );
        assert!(!temp.path().join("escape").exists());
    }

    #[test]
    fn unix_link_and_device_modes_are_never_regular_files() {
        assert!(safe_unix_mode(Some(0o100_644)));
        assert!(!safe_unix_mode(Some(0o120_777)));
        assert!(!safe_unix_mode(Some(0o060_644)));
    }
}
