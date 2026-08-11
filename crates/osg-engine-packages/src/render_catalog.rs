use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::catalog::{
    DeliveryAsset, DeliverySource, DeliverySourceKind, MAX_ARCHIVE_BYTES,
    MAX_TOTAL_INSTALLED_BYTES, MAX_UNPACKED_BYTES, PLATFORM_KEYS, PackageCatalog, PackageDelivery,
    current_platform, valid_asset_name, valid_delivery_url, validate_identifier, validate_sha256,
};
use crate::path_security::validate_manifest_path;
use crate::{PackageError, Result};

const EMBEDDED_CATALOG: &str =
    include_str!("../../../video-renderer/delivery/remotion-runtime.delivery.json");

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum RenderPackageId {
    #[serde(rename = "remotion-runtime")]
    RemotionRuntime,
}

impl RenderPackageId {
    pub const ALL: [Self; 1] = [Self::RemotionRuntime];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        "remotion-runtime"
    }
}

impl fmt::Display for RenderPackageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for RenderPackageId {
    type Error = PackageError;

    fn try_from(value: &str) -> Result<Self> {
        (value == Self::RemotionRuntime.as_str())
            .then_some(Self::RemotionRuntime)
            .ok_or(PackageError::InvalidRequest)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPackageInfo {
    pub id: RenderPackageId,
    pub label: &'static str,
    pub license: &'static str,
}

const PUBLIC_CATALOG: [RenderPackageInfo; 1] = [RenderPackageInfo {
    id: RenderPackageId::RemotionRuntime,
    label: "Remotion video renderer",
    license: "Remotion License + bundled third-party notices",
}];

#[must_use]
pub const fn render_catalog() -> &'static [RenderPackageInfo] {
    &PUBLIC_CATALOG
}

pub(crate) type RenderDeliveryCatalog = PackageCatalog<RenderPackageId>;

impl PackageCatalog<RenderPackageId> {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<RenderDeliveryCatalog>> =
            LazyLock::new(|| parse_catalog(EMBEDDED_CATALOG, current_platform()));
        CATALOG.as_ref().map_err(Clone::clone)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    schema_version: u32,
    protocol_version: u32,
    remotion_version: String,
    worker: RawWorker,
    commands: RawCommands,
    platforms: HashMap<String, RawPlatform>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawWorker {
    source_path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCommands {
    status: String,
    install: String,
    remove: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlatform {
    releases: Vec<RawRelease>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRelease {
    version: String,
    asset: String,
    source_url: String,
    size_bytes: u64,
    sha256: String,
    unpacked_size_bytes: u64,
    python_relative_path: String,
    model_relative_path: Option<String>,
    files: Vec<serde_json::Value>,
    sources: Vec<RawSource>,
    manifest: RawAsset,
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

fn parse_catalog(raw: &str, selected_platform: &str) -> Result<RenderDeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if raw.schema_version != 2
        || raw.protocol_version != 1
        || raw.remotion_version != "4.0.507"
        || raw.worker.source_path != "video-renderer/worker/osg_render_worker.mjs"
        || raw.worker.size_bytes == 0
        || validate_sha256(&raw.worker.sha256).is_err()
        || raw.commands.status != "render_package_status"
        || raw.commands.install != "render_package_install"
        || raw.commands.remove != "render_package_remove"
        || raw.platforms.len() != PLATFORM_KEYS.len()
        || PLATFORM_KEYS
            .iter()
            .any(|key| !raw.platforms.contains_key(*key))
    {
        return Err(PackageError::InvalidCatalog);
    }

    let mut selected = Vec::new();
    for platform in PLATFORM_KEYS {
        let releases = &raw
            .platforms
            .get(*platform)
            .ok_or(PackageError::InvalidCatalog)?
            .releases;
        if releases.len() > 2 {
            return Err(PackageError::InvalidCatalog);
        }
        let mut versions = HashSet::new();
        let mut installed_total = 0_u64;
        let mut validated = Vec::with_capacity(releases.len());
        for release in releases {
            if !versions.insert(release.version.as_str()) {
                return Err(PackageError::InvalidCatalog);
            }
            let delivery = validate_release(platform, release)?;
            installed_total = installed_total
                .checked_add(delivery.unpacked_size_bytes)
                .filter(|total| *total <= MAX_TOTAL_INSTALLED_BYTES)
                .ok_or(PackageError::InvalidCatalog)?;
            validated.push(delivery);
        }
        if *platform == selected_platform {
            selected = validated;
        }
    }
    Ok(PackageCatalog {
        platform: selected_platform.to_owned(),
        releases: HashMap::from([(RenderPackageId::RemotionRuntime, selected)]),
    })
}

fn validate_release(platform: &str, release: &RawRelease) -> Result<PackageDelivery> {
    validate_identifier(&release.version)?;
    validate_manifest_path(&release.python_relative_path)?;
    validate_sha256(&release.sha256)?;
    if release.version != "4.0.507"
        || release.model_relative_path.is_some()
        || !release.files.is_empty()
        || release.sources.is_empty()
        || release.sources.len() > 8
        || release.size_bytes == 0
        || release.size_bytes > MAX_ARCHIVE_BYTES
        || release.unpacked_size_bytes == 0
        || release.unpacked_size_bytes > MAX_UNPACKED_BYTES
    {
        return Err(PackageError::InvalidCatalog);
    }
    let sources = release
        .sources
        .iter()
        .map(|source| {
            Ok(DeliverySource {
                asset: validate_asset(&source.asset)?,
                kind: source.kind,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = validate_asset(&release.manifest)?;
    let total = sources
        .iter()
        .try_fold(manifest.size_bytes, |total, source| {
            total.checked_add(source.asset.size_bytes)
        });
    if total != Some(release.size_bytes)
        || release.asset != manifest.asset
        || release.sha256 != manifest.sha256
        || !release.source_url.is_empty()
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(PackageDelivery {
        component: RenderPackageId::RemotionRuntime.as_str().to_owned(),
        platform: platform.to_owned(),
        version: release.version.clone(),
        asset: release.asset.clone(),
        source_url: release.source_url.clone(),
        size_bytes: release.size_bytes,
        sha256: release.sha256.clone(),
        unpacked_size_bytes: release.unpacked_size_bytes,
        python_relative_path: release.python_relative_path.clone(),
        primary_executable: true,
        model_relative_path: None,
        aligner_relative_path: None,
        files: Vec::new(),
        sources,
        manifest: Some(manifest),
    })
}

fn validate_asset(asset: &RawAsset) -> Result<DeliveryAsset> {
    if !valid_asset_name(&asset.asset)
        || asset.urls.is_empty()
        || asset.urls.len() > 3
        || asset.size_bytes == 0
        || asset.size_bytes > MAX_ARCHIVE_BYTES
    {
        return Err(PackageError::InvalidCatalog);
    }
    validate_sha256(&asset.sha256)?;
    let mut urls = HashSet::new();
    if asset
        .urls
        .iter()
        .any(|url| !urls.insert(url) || !valid_delivery_url(url, &asset.asset))
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(DeliveryAsset {
        asset: asset.asset.clone(),
        urls: asset.urls.clone(),
        size_bytes: asset.size_bytes,
        sha256: asset.sha256.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_catalog_publishes_only_the_windows_renderer() {
        let catalog = RenderDeliveryCatalog::builtin().unwrap();
        if current_platform() == "windows-x86_64" {
            let release = catalog.current(&RenderPackageId::RemotionRuntime).unwrap();
            assert_eq!(release.version, "4.0.507");
            assert_eq!(release.sources.len(), 1);
            assert!(release.manifest.is_some());
        } else {
            assert!(
                catalog
                    .releases(&RenderPackageId::RemotionRuntime)
                    .is_empty()
            );
        }
    }
}
