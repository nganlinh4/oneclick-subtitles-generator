use std::collections::HashSet;
use std::fs;
use std::io::Read as _;
use std::path::Path;

use serde::Deserialize;

use crate::catalog::{
    DeliveryFile, DeliverySourceKind, FileRole, MAX_FILES, PackageDelivery, is_below_directory,
    role_matches_path, validate_sha256,
};
use crate::path_security::{require_regular_file, validate_directory_path, validate_manifest_path};
use crate::{PackageError, Result};

const MAX_DELIVERY_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct ManifestFile {
    pub file: DeliveryFile,
    pub source_index: usize,
    pub archive_path: Option<String>,
}

#[derive(Debug)]
pub(crate) struct ValidatedManifest {
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawManifest {
    schema_version: u32,
    component: String,
    platform: String,
    version: String,
    python_relative_path: String,
    model_relative_path: Option<String>,
    aligner_relative_path: Option<String>,
    unpacked_size_bytes: u64,
    files: Vec<RawManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawManifestFile {
    path: String,
    size_bytes: u64,
    sha256: String,
    executable: bool,
    role: FileRole,
    source_index: usize,
    archive_path: Option<String>,
}

pub(crate) fn read(path: &Path, delivery: &PackageDelivery) -> Result<ValidatedManifest> {
    let metadata = require_regular_file(path).map_err(|_| PackageError::InvalidCatalog)?;
    if metadata.len() == 0 || metadata.len() > MAX_DELIVERY_MANIFEST_BYTES {
        return Err(PackageError::InvalidCatalog);
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| PackageError::InvalidCatalog)?;
    let mut encoded = Vec::with_capacity(capacity);
    fs::File::open(path)
        .map_err(|_| PackageError::InvalidCatalog)?
        .take(MAX_DELIVERY_MANIFEST_BYTES + 1)
        .read_to_end(&mut encoded)
        .map_err(|_| PackageError::InvalidCatalog)?;
    if encoded.len() as u64 != metadata.len() {
        return Err(PackageError::InvalidCatalog);
    }
    let raw: RawManifest =
        serde_json::from_slice(&encoded).map_err(|_| PackageError::InvalidCatalog)?;
    validate(raw, delivery)
}

#[allow(clippy::too_many_lines)]
fn validate(raw: RawManifest, delivery: &PackageDelivery) -> Result<ValidatedManifest> {
    if raw.schema_version != 1
        || raw.component != delivery.component
        || raw.platform != delivery.platform
        || raw.version != delivery.version
        || raw.python_relative_path != delivery.python_relative_path
        || raw.model_relative_path != delivery.model_relative_path
        || raw.aligner_relative_path != delivery.aligner_relative_path
        || raw.unpacked_size_bytes != delivery.unpacked_size_bytes
        || raw.files.is_empty()
        || raw.files.len() > MAX_FILES
    {
        return Err(PackageError::InvalidCatalog);
    }
    validate_manifest_path(&raw.python_relative_path)?;
    if let Some(model) = &raw.model_relative_path {
        validate_directory_path(model)?;
    }
    if let Some(aligner) = &raw.aligner_relative_path {
        validate_directory_path(aligner)?;
    }

    let mut paths = HashSet::with_capacity(raw.files.len());
    let mut total = 0_u64;
    let mut python_matches = false;
    let mut model_matches = raw.model_relative_path.is_none();
    let mut aligner_matches = raw.aligner_relative_path.is_none();
    let mut has_license = false;
    let mut files = Vec::with_capacity(raw.files.len());
    for raw_file in raw.files {
        validate_manifest_path(&raw_file.path)?;
        validate_sha256(&raw_file.sha256)?;
        if !paths.insert(raw_file.path.clone()) || !role_matches_path(raw_file.role, &raw_file.path)
        {
            return Err(PackageError::InvalidCatalog);
        }
        let source = delivery
            .sources
            .get(raw_file.source_index)
            .ok_or(PackageError::InvalidCatalog)?;
        match (source.kind, &raw_file.archive_path) {
            (DeliverySourceKind::Zip, Some(path)) => validate_manifest_path(path)?,
            (DeliverySourceKind::Raw, None) => {}
            _ => return Err(PackageError::InvalidCatalog),
        }
        total = total
            .checked_add(raw_file.size_bytes)
            .filter(|value| *value <= delivery.unpacked_size_bytes)
            .ok_or(PackageError::InvalidCatalog)?;
        python_matches |= raw_file.path == raw.python_relative_path
            && raw_file.role == FileRole::Runtime
            && raw_file.executable == delivery.primary_executable;
        model_matches |= raw.model_relative_path.as_ref().is_some_and(|directory| {
            raw_file.role == FileRole::Model && is_below_directory(&raw_file.path, directory)
        });
        aligner_matches |= raw.aligner_relative_path.as_ref().is_some_and(|directory| {
            raw_file.role == FileRole::Aligner && is_below_directory(&raw_file.path, directory)
        });
        has_license |= raw_file.role == FileRole::License && !raw_file.executable;
        files.push(ManifestFile {
            file: DeliveryFile {
                path: raw_file.path,
                size_bytes: raw_file.size_bytes,
                sha256: raw_file.sha256,
                executable: raw_file.executable,
                role: raw_file.role,
            },
            source_index: raw_file.source_index,
            archive_path: raw_file.archive_path,
        });
    }
    if total != delivery.unpacked_size_bytes
        || !python_matches
        || !model_matches
        || !aligner_matches
        || !has_license
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(ValidatedManifest { files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{DeliveryCatalog, EngineId};
    use crate::render_catalog::{RenderDeliveryCatalog, RenderPackageId};
    use crate::speech_catalog::{SpeechDeliveryCatalog, SpeechPackageId};

    #[test]
    #[ignore = "release-authoring gate; set OSG_MANAGED_MANIFEST_DIR"]
    fn generated_windows_manifests_match_the_embedded_catalog() {
        let root = std::env::var_os("OSG_MANAGED_MANIFEST_DIR")
            .map(std::path::PathBuf::from)
            .expect("OSG_MANAGED_MANIFEST_DIR is required");
        let engines = DeliveryCatalog::builtin().unwrap();
        for component in EngineId::ALL {
            validate_release_file(&root, engines.current(&component).unwrap());
        }
        let speech = SpeechDeliveryCatalog::builtin().unwrap();
        for component in SpeechPackageId::ALL {
            validate_release_file(&root, speech.current(&component).unwrap());
        }
        let render = RenderDeliveryCatalog::builtin().unwrap();
        if let Some(delivery) = render.current(&RenderPackageId::RemotionRuntime) {
            validate_release_file(&root, delivery);
        }
    }

    #[test]
    #[ignore = "release-authoring gate; set OSG_REMOTION_MANIFEST"]
    fn generated_remotion_manifest_matches_the_embedded_catalog() {
        let path = std::env::var_os("OSG_REMOTION_MANIFEST")
            .map(std::path::PathBuf::from)
            .expect("OSG_REMOTION_MANIFEST is required");
        let render = RenderDeliveryCatalog::builtin().unwrap();
        let delivery = render
            .current(&RenderPackageId::RemotionRuntime)
            .expect("current render delivery");
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            delivery.manifest.as_ref().unwrap().size_bytes
        );
        let parsed = read(&path, delivery).expect("valid render delivery manifest");
        assert!(!parsed.files.is_empty());
    }

    fn validate_release_file(root: &Path, delivery: &PackageDelivery) {
        let expected = delivery.manifest.as_ref().unwrap();
        let path = root.join(&expected.asset);
        assert_eq!(fs::metadata(&path).unwrap().len(), expected.size_bytes);
        assert_eq!(
            crate::receipt::hash_file(&path, &crate::CancellationToken::default()).unwrap(),
            expected.sha256
        );
        let manifest = read(&path, delivery)
            .unwrap_or_else(|error| panic!("{} manifest failed: {error:?}", delivery.component));
        assert!(!manifest.files.is_empty());
    }
}
