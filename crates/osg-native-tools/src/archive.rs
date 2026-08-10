use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write as _};
use std::path::Path;

use sha2::{Digest as _, Sha256};

use crate::catalog::{ArtifactFormat, DeliveryFile, MAX_FILES, ToolDelivery};
use crate::path_security::{prepare_target, require_regular_file, validate_relative_path};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::{CancellationToken, NativeToolError, Result};

pub(crate) fn install_artifact(
    artifact_path: &Path,
    staging_root: &Path,
    delivery: &ToolDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    match delivery.format {
        ArtifactFormat::Raw => install_raw(
            artifact_path,
            staging_root,
            &delivery.files[0],
            cancellation,
            progress,
        ),
        ArtifactFormat::Zip => extract_zip(
            artifact_path,
            staging_root,
            delivery,
            cancellation,
            progress,
        ),
    }
}

fn install_raw(
    artifact_path: &Path,
    staging_root: &Path,
    expected: &DeliveryFile,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let mut input = fs::File::open(artifact_path).map_err(|_| NativeToolError::Integrity)?;
    let target = prepare_target(staging_root, &expected.install_path)?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target)
        .map_err(|_| NativeToolError::UnsafeArchive)?;
    copy_and_verify(
        &mut input,
        &mut output,
        expected,
        cancellation,
        progress,
        0,
        expected.size_bytes,
    )?;
    output
        .sync_all()
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    set_permissions(&target, true)
}

fn extract_zip(
    artifact_path: &Path,
    staging_root: &Path,
    delivery: &ToolDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let archive_file = fs::File::open(artifact_path).map_err(|_| NativeToolError::UnsafeArchive)?;
    let mut archive =
        zip::ZipArchive::new(archive_file).map_err(|_| NativeToolError::UnsafeArchive)?;
    if archive.len() != delivery.files.len() || archive.len() > MAX_FILES {
        return Err(NativeToolError::UnsafeArchive);
    }
    let expected_by_source = delivery
        .files
        .iter()
        .map(|file| (file.source_path.as_str(), file))
        .collect::<HashMap<_, _>>();
    let total = delivery.files.iter().map(|file| file.size_bytes).sum();
    let mut expanded = 0_u64;
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        cancellation.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| NativeToolError::UnsafeArchive)?;
        let name = entry.name().to_string();
        validate_relative_path(&name).map_err(|_| NativeToolError::UnsafeArchive)?;
        let enclosed = entry
            .enclosed_name()
            .ok_or(NativeToolError::UnsafeArchive)?;
        if entry.is_dir()
            || !safe_unix_mode(entry.unix_mode())
            || enclosed.to_string_lossy().replace('\\', "/") != name
            || !seen.insert(name.clone())
        {
            return Err(NativeToolError::UnsafeArchive);
        }
        let expected = expected_by_source
            .get(name.as_str())
            .copied()
            .ok_or(NativeToolError::UnsafeArchive)?;
        if entry.size() != expected.size_bytes {
            return Err(NativeToolError::UnsafeArchive);
        }
        let target = prepare_target(staging_root, &expected.install_path)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|_| NativeToolError::UnsafeArchive)?;
        copy_and_verify(
            &mut entry,
            &mut output,
            expected,
            cancellation,
            progress,
            expanded,
            total,
        )?;
        expanded = expanded
            .checked_add(expected.size_bytes)
            .ok_or(NativeToolError::StorageLimit)?;
        output
            .sync_all()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        set_permissions(&target, true)?;
    }
    if seen.len() != delivery.files.len() || expanded != total {
        return Err(NativeToolError::UnsafeArchive);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn copy_and_verify(
    input: &mut impl Read,
    output: &mut fs::File,
    expected: &DeliveryFile,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
    base_bytes: u64,
    total_bytes: u64,
) -> Result<()> {
    let mut hasher = Sha256::new();
    let mut written = 0_u64;
    let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
    loop {
        cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| NativeToolError::UnsafeArchive)?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .filter(|bytes| *bytes <= expected.size_bytes)
            .ok_or(NativeToolError::StorageLimit)?;
        output
            .write_all(&buffer[..read])
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        hasher.update(&buffer[..read]);
        progress.on_progress(OperationProgress::new(
            OperationPhase::Extracting,
            base_bytes.saturating_add(written),
            total_bytes,
        ));
    }
    if written != expected.size_bytes || format!("{:x}", hasher.finalize()) != expected.sha256 {
        return Err(NativeToolError::Integrity);
    }
    Ok(())
}

fn safe_unix_mode(mode: Option<u32>) -> bool {
    mode.is_none_or(|mode| {
        let file_type = mode & 0o170_000;
        file_type == 0 || file_type == 0o100_000
    })
}

pub(crate) fn set_permissions(path: &Path, executable: bool) -> Result<()> {
    require_regular_file(path).map_err(|_| NativeToolError::StoreUnavailable)?;
    set_platform_permissions(path, executable)
}

#[cfg(unix)]
fn set_platform_permissions(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| NativeToolError::StoreUnavailable)
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn set_platform_permissions(_: &Path, _: bool) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write as _};

    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::catalog::{ExecutableRole, ToolDelivery};

    fn fixture_delivery() -> ToolDelivery {
        ToolDelivery {
            tool: crate::NativeToolId::Deno,
            platform: "windows-x86_64".to_string(),
            version: "1.0.0".to_string(),
            source_revision: "0".repeat(40),
            asset: "fixture.zip".to_string(),
            source_url: "https://github.com/denoland/deno/releases/download/v1.0.0/fixture.zip"
                .to_string(),
            format: ArtifactFormat::Zip,
            size_bytes: 1,
            sha256: "0".repeat(64),
            files: vec![DeliveryFile {
                source_path: "deno.exe".to_string(),
                install_path: "bin/deno.exe".to_string(),
                size_bytes: 1,
                sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
                    .to_string(),
                role: ExecutableRole::Deno,
            }],
            notices: vec![],
            installed_bytes: 1,
        }
    }

    #[test]
    fn traversal_and_extra_entries_are_rejected() {
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
            install_artifact(
                &archive_path,
                &staging,
                &fixture_delivery(),
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(NativeToolError::UnsafeArchive)
        );
        assert!(!temp.path().join("escape").exists());
    }

    #[test]
    fn link_and_device_modes_are_rejected() {
        assert!(safe_unix_mode(Some(0o100_755)));
        assert!(!safe_unix_mode(Some(0o120_777)));
        assert!(!safe_unix_mode(Some(0o060_644)));
    }
}
