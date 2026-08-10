use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write as _};
use std::path::Path;

use sha2::{Digest as _, Sha256};

use crate::catalog::{ArtifactFormat, DeliveryFile, MAX_FILES, ToolDelivery};
use crate::path_security::{prepare_target, require_regular_file, validate_relative_path};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::{CancellationToken, NativeToolError, Result};

const MAX_ARCHIVE_ENTRIES: usize = 256;
const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;

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
    if archive.len() > MAX_ARCHIVE_ENTRIES
        || (!delivery.selective_extraction && archive.len() != delivery.files.len())
        || delivery.files.len() > MAX_FILES
    {
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
    let mut seen_expected = HashSet::new();
    let mut archive_expanded = 0_u64;
    for index in 0..archive.len() {
        cancellation.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| NativeToolError::UnsafeArchive)?;
        let name = entry.name().to_string();
        let canonical_name = name.trim_end_matches('/');
        validate_relative_path(canonical_name).map_err(|_| NativeToolError::UnsafeArchive)?;
        let enclosed = entry
            .enclosed_name()
            .ok_or(NativeToolError::UnsafeArchive)?;
        archive_expanded = archive_expanded
            .checked_add(entry.size())
            .filter(|bytes| *bytes <= MAX_ARCHIVE_EXPANDED_BYTES)
            .ok_or(NativeToolError::StorageLimit)?;
        if !safe_unix_mode(entry.unix_mode(), entry.is_dir())
            || enclosed.to_string_lossy().replace('\\', "/") != canonical_name
            || !seen.insert(canonical_name.to_string())
        {
            return Err(NativeToolError::UnsafeArchive);
        }
        let Some(expected) = expected_by_source.get(canonical_name).copied() else {
            if delivery.selective_extraction {
                continue;
            }
            return Err(NativeToolError::UnsafeArchive);
        };
        if entry.is_dir() || !seen_expected.insert(canonical_name.to_string()) {
            return Err(NativeToolError::UnsafeArchive);
        }
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
        set_permissions(&target, expected.role.is_some())?;
    }
    if seen_expected.len() != delivery.files.len() || expanded != total {
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

fn safe_unix_mode(mode: Option<u32>, directory: bool) -> bool {
    mode.is_none_or(|mode| {
        let file_type = mode & 0o170_000;
        file_type == 0 || file_type == if directory { 0o040_000 } else { 0o100_000 }
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
            selective_extraction: false,
            size_bytes: 1,
            sha256: "0".repeat(64),
            files: vec![DeliveryFile {
                source_path: "deno.exe".to_string(),
                install_path: "bin/deno.exe".to_string(),
                size_bytes: 1,
                sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
                    .to_string(),
                role: Some(ExecutableRole::Deno),
            }],
            notices: vec![],
            installed_bytes: 1,
        }
    }

    #[test]
    fn traversal_and_extra_entries_are_rejected() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_directory("docs/", SimpleFileOptions::default())
            .unwrap();
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
    fn pinned_vendor_archives_extract_only_the_reviewed_inventory() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("deno.exe", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        writer
            .start_file("vendor-documentation.txt", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(b"pinned by the outer archive digest")
            .unwrap();
        let encoded = writer.finish().unwrap().into_inner();
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("vendor.zip");
        let staging = temp.path().join("staging");
        fs::write(&archive_path, encoded).unwrap();
        fs::create_dir(&staging).unwrap();
        let mut delivery = fixture_delivery();
        delivery.selective_extraction = true;
        install_artifact(
            &archive_path,
            &staging,
            &delivery,
            &CancellationToken::default(),
            &|_| {},
        )
        .unwrap();
        assert_eq!(fs::read(staging.join("bin/deno.exe")).unwrap(), b"x");
        assert!(!staging.join("vendor-documentation.txt").exists());
    }

    #[test]
    #[ignore = "requires OSG_FFMPEG_AUDIT_ZIP pointing at the reviewed vendor archive"]
    fn reviewed_windows_ffmpeg_archive_matches_the_selective_inventory() {
        let archive_path = std::env::var_os("OSG_FFMPEG_AUDIT_ZIP")
            .map(std::path::PathBuf::from)
            .expect("OSG_FFMPEG_AUDIT_ZIP is required");
        let catalog = crate::catalog::parse_for_test(
            include_str!("../delivery/native-tools.delivery.json"),
            "windows-x86_64",
        )
        .unwrap();
        let delivery = catalog.current(crate::NativeToolId::MediaTools).unwrap();
        let temp = tempfile::tempdir().unwrap();
        install_artifact(
            &archive_path,
            temp.path(),
            delivery,
            &CancellationToken::default(),
            &|_| {},
        )
        .unwrap();
        assert!(temp.path().join("bin/ffmpeg.exe").is_file());
        assert!(temp.path().join("bin/ffprobe.exe").is_file());
        assert!(temp.path().join("licenses/FFmpeg-LICENSE.txt").is_file());
        assert!(
            temp.path()
                .join("licenses/FFmpeg-BUILD-README.txt")
                .is_file()
        );
    }

    #[test]
    fn link_and_device_modes_are_rejected() {
        assert!(safe_unix_mode(Some(0o100_755), false));
        assert!(safe_unix_mode(Some(0o040_755), true));
        assert!(!safe_unix_mode(Some(0o120_777), false));
        assert!(!safe_unix_mode(Some(0o060_644), false));
    }
}
