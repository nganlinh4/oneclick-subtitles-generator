//! Untrusted delivery-catalog JSON: raw shapes and the validators that admit a release.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::{
    DeliveryAsset, DeliveryCatalog, DeliveryFile, DeliverySource, DeliverySourceKind, EngineId,
    FileRole, MAX_ARCHIVE_BYTES, MAX_FILES, MAX_RELEASES_PER_ENGINE, MAX_TOTAL_INSTALLED_BYTES,
    MAX_UNPACKED_BYTES, PLATFORM_KEYS, PackageDelivery, RELEASE_BASE, is_asset_name,
    is_below_directory, role_matches_path, valid_delivery_url, validate_identifier,
    validate_sha256,
};
use crate::path_security::validate_relative_path;
use crate::{PackageError, Result};
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    schema_version: u32,
    platforms: HashMap<String, RawPlatform>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawAsset {
    asset: String,
    urls: Vec<String>,
    size_bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSource {
    #[serde(flatten)]
    asset: RawAsset,
    kind: DeliverySourceKind,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlatform {
    engines: Vec<RawEngine>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEngine {
    id: EngineId,
    releases: Vec<RawRelease>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRelease {
    version: String,
    asset: String,
    size_bytes: u64,
    sha256: String,
    unpacked_size_bytes: u64,
    python_relative_path: String,
    model_relative_path: String,
    aligner_relative_path: Option<String>,
    files: Vec<RawFile>,
    #[serde(default)]
    sources: Vec<RawSource>,
    manifest: Option<RawAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawFile {
    path: String,
    size_bytes: u64,
    sha256: String,
    executable: bool,
    role: FileRole,
}

pub(super) fn parse_catalog(raw: &str, selected_platform: &str) -> Result<DeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if !matches!(raw.schema_version, 1 | 2)
        || raw.platforms.len() != PLATFORM_KEYS.len()
        || PLATFORM_KEYS
            .iter()
            .any(|key| !raw.platforms.contains_key(*key))
    {
        return Err(PackageError::InvalidCatalog);
    }

    let mut selected = None;
    for platform_key in PLATFORM_KEYS {
        let platform = raw
            .platforms
            .get(*platform_key)
            .ok_or(PackageError::InvalidCatalog)?;
        let validated = validate_platform(platform_key, platform)?;
        if *platform_key == selected_platform {
            selected = Some(validated);
        }
    }

    Ok(DeliveryCatalog {
        platform: selected_platform.to_string(),
        releases: selected.unwrap_or_default(),
    })
}

fn validate_platform(
    platform_key: &str,
    platform: &RawPlatform,
) -> Result<HashMap<EngineId, Vec<PackageDelivery>>> {
    if platform.engines.len() != EngineId::ALL.len() {
        return Err(PackageError::InvalidCatalog);
    }
    let mut seen = HashSet::new();
    let mut releases = HashMap::new();
    let mut platform_total = 0_u64;
    for engine in &platform.engines {
        if !seen.insert(engine.id) || engine.releases.len() > MAX_RELEASES_PER_ENGINE {
            return Err(PackageError::InvalidCatalog);
        }
        let mut versions = HashSet::new();
        let mut validated = Vec::with_capacity(engine.releases.len());
        for release in &engine.releases {
            if !versions.insert(release.version.as_str()) {
                return Err(PackageError::InvalidCatalog);
            }
            let delivery = validate_release(platform_key, engine.id, release)?;
            platform_total = platform_total
                .checked_add(delivery.unpacked_size_bytes)
                .filter(|total| *total <= MAX_TOTAL_INSTALLED_BYTES)
                .ok_or(PackageError::InvalidCatalog)?;
            validated.push(delivery);
        }
        releases.insert(engine.id, validated);
    }
    if seen.len() != EngineId::ALL.len() {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(releases)
}

fn validate_release(
    platform: &str,
    engine: EngineId,
    release: &RawRelease,
) -> Result<PackageDelivery> {
    validate_identifier(&release.version)?;
    validate_relative_path(&release.version)?;
    validate_sha256(&release.sha256)?;
    let remote_manifest = release.manifest.is_some();
    if release.size_bytes == 0
        || release.size_bytes > MAX_ARCHIVE_BYTES
        || release.unpacked_size_bytes == 0
        || release.unpacked_size_bytes > MAX_UNPACKED_BYTES
        || release.files.len() > MAX_FILES
        || (release.files.is_empty() != remote_manifest)
        || (remote_manifest && release.sources.is_empty())
    {
        return Err(PackageError::InvalidCatalog);
    }
    if !remote_manifest {
        let expected_asset = format!(
            "{}-{platform}-{}-{}.zip",
            engine.as_str(),
            release.version,
            &release.sha256[..16]
        );
        if release.asset != expected_asset || !is_asset_name(&release.asset) {
            return Err(PackageError::InvalidCatalog);
        }
    }
    validate_relative_path(&release.python_relative_path)?;
    validate_relative_path(&release.model_relative_path)?;
    if let Some(aligner) = &release.aligner_relative_path {
        validate_relative_path(aligner)?;
    }
    if engine.requires_aligner() != release.aligner_relative_path.is_some() {
        return Err(PackageError::InvalidCatalog);
    }

    let validated_files = validate_release_files(release)?;
    if !remote_manifest
        && (validated_files.total != release.unpacked_size_bytes
            || !validated_files.has(RELEASE_HAS_RUNTIME)
            || !validated_files.has(RELEASE_HAS_MODEL)
            || !validated_files.has(RELEASE_PYTHON_MATCHES)
            || engine.requires_aligner() != validated_files.has(RELEASE_HAS_ALIGNER))
    {
        return Err(PackageError::InvalidCatalog);
    }

    let sources = release
        .sources
        .iter()
        .map(validate_source)
        .collect::<Result<Vec<_>>>()?;
    let manifest = release.manifest.as_ref().map(validate_asset).transpose()?;
    if remote_manifest {
        let download_total = sources.iter().try_fold(
            manifest.as_ref().map_or(0, |value| value.size_bytes),
            |total, source| total.checked_add(source.asset.size_bytes),
        );
        if download_total != Some(release.size_bytes) {
            return Err(PackageError::InvalidCatalog);
        }
    }

    Ok(PackageDelivery {
        component: engine.as_str().to_string(),
        platform: platform.to_string(),
        version: release.version.clone(),
        asset: release.asset.clone(),
        source_url: format!("{RELEASE_BASE}{}", release.asset),
        size_bytes: release.size_bytes,
        sha256: release.sha256.clone(),
        unpacked_size_bytes: release.unpacked_size_bytes,
        python_relative_path: release.python_relative_path.clone(),
        primary_executable: true,
        model_relative_path: Some(release.model_relative_path.clone()),
        aligner_relative_path: release.aligner_relative_path.clone(),
        files: validated_files.files,
        sources,
        manifest,
    })
}

struct ValidatedReleaseFiles {
    files: Vec<DeliveryFile>,
    total: u64,
    flags: u8,
}

const RELEASE_HAS_RUNTIME: u8 = 1;
const RELEASE_HAS_MODEL: u8 = 1 << 1;
const RELEASE_HAS_ALIGNER: u8 = 1 << 2;
const RELEASE_PYTHON_MATCHES: u8 = 1 << 3;

impl ValidatedReleaseFiles {
    const fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

fn validate_release_files(release: &RawRelease) -> Result<ValidatedReleaseFiles> {
    let mut paths = HashSet::new();
    let mut validated = ValidatedReleaseFiles {
        files: Vec::with_capacity(release.files.len()),
        total: 0,
        flags: 0,
    };
    for file in &release.files {
        validate_relative_path(&file.path)?;
        validate_sha256(&file.sha256)?;
        if file.size_bytes == 0 || file.size_bytes > MAX_UNPACKED_BYTES || !paths.insert(&file.path)
        {
            return Err(PackageError::InvalidCatalog);
        }
        if !role_matches_path(file.role, &file.path) {
            return Err(PackageError::InvalidCatalog);
        }
        validated.total = validated
            .total
            .checked_add(file.size_bytes)
            .filter(|value| *value <= release.unpacked_size_bytes)
            .ok_or(PackageError::InvalidCatalog)?;
        if file.role == FileRole::Runtime {
            validated.flags |= RELEASE_HAS_RUNTIME;
        }
        if file.role == FileRole::Model
            && is_below_directory(&file.path, &release.model_relative_path)
        {
            validated.flags |= RELEASE_HAS_MODEL;
        }
        if file.role == FileRole::Aligner
            && release
                .aligner_relative_path
                .as_ref()
                .is_some_and(|directory| is_below_directory(&file.path, directory))
        {
            validated.flags |= RELEASE_HAS_ALIGNER;
        }
        if file.path == release.python_relative_path
            && file.role == FileRole::Runtime
            && file.executable
        {
            validated.flags |= RELEASE_PYTHON_MATCHES;
        }
        validated.files.push(DeliveryFile {
            path: file.path.clone(),
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
            executable: file.executable,
            role: file.role,
        });
    }
    Ok(validated)
}

fn validate_source(source: &RawSource) -> Result<DeliverySource> {
    Ok(DeliverySource {
        asset: validate_asset(&source.asset)?,
        kind: source.kind,
    })
}

fn validate_asset(asset: &RawAsset) -> Result<DeliveryAsset> {
    if !is_asset_name(&asset.asset)
        || asset.urls.is_empty()
        || asset.urls.len() > 3
        || asset.size_bytes == 0
        || asset.size_bytes > MAX_ARCHIVE_BYTES
    {
        return Err(PackageError::InvalidCatalog);
    }
    validate_sha256(&asset.sha256)?;
    let mut seen = HashSet::new();
    for url in &asset.urls {
        if !seen.insert(url) || !valid_delivery_url(url, &asset.asset) {
            return Err(PackageError::InvalidCatalog);
        }
    }
    Ok(DeliveryAsset {
        asset: asset.asset.clone(),
        urls: asset.urls.clone(),
        size_bytes: asset.size_bytes,
        sha256: asset.sha256.clone(),
    })
}
