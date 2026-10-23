//! Package archives mapped onto the shared, inventory-driven ZIP extractor.

use std::collections::HashMap;
use std::path::Path;

use osg_delivery_core::archive::{EntryTarget, ExtractProgress, ZipLimits, extract_zip};
use osg_delivery_core::paths::PathPolicy;

use crate::catalog::{MAX_FILES, PackageDelivery};
use crate::delivery_manifest::ManifestFile;
use crate::{CancellationToken, PackageError, ProgressSink, Result};

/// Extracts a single-archive delivery whose inventory is exactly `delivery.files`.
pub(crate) fn extract(
    archive_path: &Path,
    staging_root: &Path,
    delivery: &PackageDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let expected = delivery
        .files
        .iter()
        .map(|file| {
            (
                file.path.as_str(),
                EntryTarget {
                    install_path: &file.path,
                    size_bytes: file.size_bytes,
                    sha256: &file.sha256,
                    executable: file.executable,
                },
            )
        })
        .collect::<HashMap<_, _>>();
    if expected.len() != delivery.files.len() {
        return Err(PackageError::InvalidCatalog);
    }
    let expanded = extract_exact(
        archive_path,
        staging_root,
        &expected,
        ExtractProgress {
            cancellation,
            sink: progress,
            completed_before: 0,
            total: delivery.unpacked_size_bytes,
        },
    )?;
    if expanded != delivery.unpacked_size_bytes {
        return Err(PackageError::UnsafeArchive);
    }
    Ok(())
}

/// Extracts one ZIP source of a manifest delivery, returning the bytes it contributed.
pub(crate) fn extract_manifest_source(
    archive_path: &Path,
    staging_root: &Path,
    expected_files: &[&ManifestFile],
    progress: ExtractProgress<'_>,
) -> Result<u64> {
    let expected = expected_files
        .iter()
        .map(|entry| {
            let archive_path = entry
                .archive_path
                .as_deref()
                .ok_or(PackageError::InvalidCatalog)?;
            Ok((
                archive_path,
                EntryTarget {
                    install_path: &entry.file.path,
                    size_bytes: entry.file.size_bytes,
                    sha256: &entry.file.sha256,
                    executable: entry.file.executable,
                },
            ))
        })
        .collect::<Result<HashMap<_, _>>>()?;
    if expected.len() != expected_files.len() {
        return Err(PackageError::InvalidCatalog);
    }
    extract_exact(archive_path, staging_root, &expected, progress)
}

fn extract_exact(
    archive_path: &Path,
    staging_root: &Path,
    expected: &HashMap<&str, EntryTarget<'_>>,
    progress: ExtractProgress<'_>,
) -> Result<u64> {
    Ok(extract_zip(
        archive_path,
        staging_root,
        expected,
        ZipLimits {
            policy: PathPolicy::PACKAGE,
            max_entries: MAX_FILES,
            max_declared_bytes: progress.total.saturating_sub(progress.completed_before),
            selective: false,
        },
        progress,
    )?)
}

#[cfg(test)]
mod tests {
    use std::fs;
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
            primary_executable: true,
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

    fn extract_encoded(entries: &[(&str, &[u8])]) -> Result<()> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        let encoded = writer.finish().unwrap().into_inner();
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("package.zip");
        let staging = temp.path().join("staging");
        fs::write(&archive_path, encoded).unwrap();
        fs::create_dir(&staging).unwrap();
        let result = extract(
            &archive_path,
            &staging,
            &one_file_delivery(),
            &CancellationToken::default(),
            &|_| {},
        );
        assert!(!temp.path().join("escape").exists());
        result
    }

    #[test]
    fn traversal_entry_is_rejected_before_any_outside_write() {
        assert_eq!(
            extract_encoded(&[("../escape", b"x")]),
            Err(PackageError::UnsafeArchive)
        );
    }

    #[test]
    fn package_archives_must_be_exactly_the_inventory() {
        assert_eq!(extract_encoded(&[("model/config.json", b"x")]), Ok(()));
        assert_eq!(
            extract_encoded(&[("model/config.json", b"y")]),
            Err(PackageError::ArchiveIntegrity)
        );
        assert_eq!(
            extract_encoded(&[("model/config.json", b"x"), ("model/extra.bin", b"z")]),
            Err(PackageError::UnsafeArchive)
        );
    }
}
