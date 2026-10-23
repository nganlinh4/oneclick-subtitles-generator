//! Installs a verified tool artifact (a raw executable or a reviewed ZIP) into staging.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use osg_delivery_core::archive::{EntryTarget, ExtractProgress, ZipLimits, extract_zip};
use osg_delivery_core::files::{CopyProgress, ExpectedContent, copy_verified};
use osg_delivery_core::paths::PathPolicy;

pub(crate) use osg_delivery_core::files::set_permissions;

use crate::catalog::{ArtifactFormat, DeliveryFile, MAX_FILES, ToolDelivery};
use crate::path_security::prepare_target;
use crate::{CancellationToken, NativeToolError, OperationPhase, ProgressSink, Result};

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
        ArtifactFormat::Zip => extract(
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
    copy_verified(
        &mut input,
        &mut output,
        ExpectedContent {
            size_bytes: expected.size_bytes,
            sha256: &expected.sha256,
        },
        CopyProgress {
            cancellation,
            sink: progress,
            phase: OperationPhase::Extracting,
            completed_before: 0,
            total: expected.size_bytes,
        },
    )?;
    drop(output);
    Ok(set_permissions(&target, true)?)
}

fn extract(
    artifact_path: &Path,
    staging_root: &Path,
    delivery: &ToolDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    if delivery.files.len() > MAX_FILES {
        return Err(NativeToolError::UnsafeArchive);
    }
    let expected = delivery
        .files
        .iter()
        .map(|file| {
            (
                file.source_path.as_str(),
                EntryTarget {
                    install_path: &file.install_path,
                    size_bytes: file.size_bytes,
                    sha256: &file.sha256,
                    executable: file.role.is_some(),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let total = delivery.files.iter().map(|file| file.size_bytes).sum();
    extract_zip(
        artifact_path,
        staging_root,
        &expected,
        ZipLimits {
            policy: PathPolicy::TOOL,
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_declared_bytes: MAX_ARCHIVE_EXPANDED_BYTES,
            selective: delivery.selective_extraction,
        },
        ExtractProgress {
            cancellation,
            sink: progress,
            completed_before: 0,
            total,
        },
    )?;
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
    fn raw_artifacts_larger_than_declared_never_publish() {
        let temp = tempfile::tempdir().unwrap();
        let artifact = temp.path().join("deno.exe");
        let staging = temp.path().join("staging");
        fs::write(&artifact, b"xx").unwrap();
        fs::create_dir(&staging).unwrap();
        let mut delivery = fixture_delivery();
        delivery.format = ArtifactFormat::Raw;
        assert_eq!(
            install_artifact(
                &artifact,
                &staging,
                &delivery,
                &CancellationToken::default(),
                &|_| {},
            ),
            Err(NativeToolError::UnsafeArchive)
        );
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
}
