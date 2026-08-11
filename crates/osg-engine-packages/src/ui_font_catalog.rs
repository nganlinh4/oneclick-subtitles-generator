use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::catalog::{
    DeliveryAsset, DeliverySource, DeliverySourceKind, MAX_ARCHIVE_BYTES, PLATFORM_KEYS,
    PackageCatalog, PackageDelivery, current_platform, valid_asset_name, valid_delivery_url,
    validate_identifier, validate_sha256,
};
use crate::path_security::validate_manifest_path;
use crate::{PackageError, Result};

const EMBEDDED_CATALOG: &str = include_str!("../delivery/ui-fonts.delivery.json");
const FAMILY: &str = "Google Sans Flex";
const VERSION: &str = "v22-ui4";
const CSS_API_URL: &str = "https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght,GRAD,ROND@6..144,1..1000,0..100,0..100&display=swap";
const CSS_SHA256: &str = "143a2f669a966fdfdcda6f972b49e504c5cf733924f459a86f500f16dff09707";
const PRIMARY_RELATIVE_PATH: &str = "runtime/google-sans-flex.css";
#[cfg(test)]
const POOL_BASE: &str = "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/";

pub const UI_FONT_SUBSETS: [&str; 3] = ["vietnamese", "latin-ext", "latin"];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum UiFontPackageId {
    #[serde(rename = "google-sans-flex")]
    GoogleSansFlex,
}

impl UiFontPackageId {
    pub const ALL: [Self; 1] = [Self::GoogleSansFlex];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        "google-sans-flex"
    }
}

impl fmt::Display for UiFontPackageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiFontPackageInfo {
    pub id: UiFontPackageId,
    pub label: &'static str,
    pub license: &'static str,
}

const PUBLIC_CATALOG: [UiFontPackageInfo; 1] = [UiFontPackageInfo {
    id: UiFontPackageId::GoogleSansFlex,
    label: FAMILY,
    license: "OFL-1.1",
}];

#[must_use]
pub const fn ui_font_catalog() -> &'static [UiFontPackageInfo] {
    &PUBLIC_CATALOG
}

pub(crate) type UiFontDeliveryCatalog = PackageCatalog<UiFontPackageId>;

impl PackageCatalog<UiFontPackageId> {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<UiFontDeliveryCatalog>> =
            LazyLock::new(|| parse_catalog(EMBEDDED_CATALOG, current_platform()));
        CATALOG.as_ref().map_err(Clone::clone)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    schema_version: u32,
    family: String,
    license: String,
    css_api_url: String,
    css_sha256: String,
    platforms: HashMap<String, RawPlatform>,
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
    primary_relative_path: String,
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

struct ExpectedSource {
    asset: &'static str,
    urls: &'static [&'static str],
    size_bytes: u64,
    sha256: &'static str,
}

const EXPECTED_SOURCES: &[ExpectedSource] = &[
    ExpectedSource {
        asset: "google-sans-flex-v22-ui4-vietnamese-7343aefa9061998b.woff2",
        urls: &[
            "https://fonts.gstatic.com/s/googlesansflex/v22/t5tFIQcYNIWbFgDgAAzZ34auoVyXkJCOjsOqNGFbN5hF8Ju1x4d-JwN2l9sIKwkaN7T3Qec.woff2",
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/google-sans-flex-v22-ui4-vietnamese-7343aefa9061998b.woff2",
        ],
        size_bytes: 57_620,
        sha256: "7343aefa9061998bdfea8c1e2aa6943a029218dd78a23e5fde441e832fe66629",
    },
    ExpectedSource {
        asset: "google-sans-flex-v22-ui4-latin-ext-0f63b3ae4c60341f.woff2",
        urls: &[
            "https://fonts.gstatic.com/s/googlesansflex/v22/t5tFIQcYNIWbFgDgAAzZ34auoVyXkJCOjsOqNGFbN5hF8Ju1x4d-JwN2l9sIKwkaNrT3Qec.woff2",
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/google-sans-flex-v22-ui4-latin-ext-0f63b3ae4c60341f.woff2",
        ],
        size_bytes: 131_208,
        sha256: "0f63b3ae4c60341fc1348749796505e9ab621a3ab690b80f9cdf66dafc1eca19",
    },
    ExpectedSource {
        asset: "google-sans-flex-v22-ui4-latin-3215351d7b558739.woff2",
        urls: &[
            "https://fonts.gstatic.com/s/googlesansflex/v22/t5tFIQcYNIWbFgDgAAzZ34auoVyXkJCOjsOqNGFbN5hF8Ju1x4d-JwN2l9sIKwkaOLT3.woff2",
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/google-sans-flex-v22-ui4-latin-3215351d7b558739.woff2",
        ],
        size_bytes: 270_324,
        sha256: "3215351d7b5587396710ab80bd31994ebbf3a9ee6f8e67b3c29a30d909cec55f",
    },
    ExpectedSource {
        asset: "google-sans-flex-v22-ui4-b7bcc5489391e48d.css",
        urls: &[
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/google-sans-flex-v22-ui4-b7bcc5489391e48d.css",
        ],
        size_bytes: 1_239,
        sha256: "b7bcc5489391e48d44f4238b5e2eae87ddeb8269073853c904d947a173e33b40",
    },
    ExpectedSource {
        asset: "sil-open-font-license-1.1-1d361a8f8e8ce6e6.txt",
        urls: &[
            "https://openfontlicense.org/documents/OFL.txt",
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/sil-open-font-license-1.1-1d361a8f8e8ce6e6.txt",
        ],
        size_bytes: 4_599,
        sha256: "1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e",
    },
    ExpectedSource {
        asset: "google-sans-flex-NOTICE-019201394f5f7edd.txt",
        urls: &[
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/google-sans-flex-NOTICE-019201394f5f7edd.txt",
        ],
        size_bytes: 586,
        sha256: "019201394f5f7edd355567b138dddb4fd21d414696ff0582058ec11d2d5963c4",
    },
];

const MANIFEST_ASSET: ExpectedSource = ExpectedSource {
    asset: "google-sans-flex-v22-ui4-9d59f14b9ce636f1.delivery.json",
    urls: &[
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/google-sans-flex-v22-ui4-9d59f14b9ce636f1.delivery.json",
    ],
    size_bytes: 1_905,
    sha256: "9d59f14b9ce636f160dc7398046985fca567cd8add6b9f84f79cd2b5a9bb3dcd",
};

fn parse_catalog(raw: &str, selected_platform: &str) -> Result<UiFontDeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if raw.schema_version != 1
        || raw.family != FAMILY
        || raw.license != "OFL-1.1"
        || raw.css_api_url != CSS_API_URL
        || raw.css_sha256 != CSS_SHA256
        || raw.platforms.len() != PLATFORM_KEYS.len()
        || PLATFORM_KEYS
            .iter()
            .any(|platform| !raw.platforms.contains_key(*platform))
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
        if releases.len() != 1 {
            return Err(PackageError::InvalidCatalog);
        }
        let delivery = validate_release(&releases[0])?;
        if *platform == selected_platform {
            selected.push(delivery);
        }
    }
    Ok(PackageCatalog {
        platform: selected_platform.to_owned(),
        releases: HashMap::from([(UiFontPackageId::GoogleSansFlex, selected)]),
    })
}

fn validate_release(release: &RawRelease) -> Result<PackageDelivery> {
    validate_identifier(&release.version)?;
    validate_manifest_path(&release.primary_relative_path)?;
    validate_sha256(&release.sha256)?;
    if release.version != VERSION
        || release.asset != MANIFEST_ASSET.asset
        || !release.source_url.is_empty()
        || release.sha256 != MANIFEST_ASSET.sha256
        || release.primary_relative_path != PRIMARY_RELATIVE_PATH
        || release.unpacked_size_bytes != 465_576
        || release.sources.len() != EXPECTED_SOURCES.len()
    {
        return Err(PackageError::InvalidCatalog);
    }
    let sources = release
        .sources
        .iter()
        .zip(EXPECTED_SOURCES)
        .map(|(source, expected)| {
            if source.kind != DeliverySourceKind::Raw {
                return Err(PackageError::InvalidCatalog);
            }
            Ok(DeliverySource {
                asset: validate_asset(&source.asset, expected)?,
                kind: source.kind,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = validate_asset(&release.manifest, &MANIFEST_ASSET)?;
    let total = sources
        .iter()
        .try_fold(manifest.size_bytes, |total, source| {
            total.checked_add(source.asset.size_bytes)
        });
    if total != Some(release.size_bytes) || release.size_bytes != 467_481 {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(PackageDelivery {
        component: UiFontPackageId::GoogleSansFlex.as_str().to_owned(),
        platform: "all".to_owned(),
        version: release.version.clone(),
        asset: release.asset.clone(),
        source_url: release.source_url.clone(),
        size_bytes: release.size_bytes,
        sha256: release.sha256.clone(),
        unpacked_size_bytes: release.unpacked_size_bytes,
        python_relative_path: release.primary_relative_path.clone(),
        primary_executable: false,
        model_relative_path: None,
        aligner_relative_path: None,
        files: Vec::new(),
        sources,
        manifest: Some(manifest),
    })
}

fn validate_asset(asset: &RawAsset, expected: &ExpectedSource) -> Result<DeliveryAsset> {
    if asset.asset != expected.asset
        || asset.urls.iter().map(String::as_str).collect::<Vec<_>>() != expected.urls
        || asset.size_bytes != expected.size_bytes
        || asset.sha256 != expected.sha256
        || !valid_asset_name(&asset.asset)
        || asset.size_bytes == 0
        || asset.size_bytes > MAX_ARCHIVE_BYTES
    {
        return Err(PackageError::InvalidCatalog);
    }
    validate_sha256(&asset.sha256)?;
    let mut seen = HashSet::new();
    if asset
        .urls
        .iter()
        .any(|url| !seen.insert(url) || !valid_delivery_url(url, &asset.asset))
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
    use std::sync::Arc;

    use super::*;
    use crate::{CancellationToken, PackageState, RemovalOutcome, UiFontPackageManager};

    #[test]
    fn checked_in_ui_font_catalog_is_platform_neutral_and_official_first() {
        for platform in PLATFORM_KEYS {
            let catalog = parse_catalog(EMBEDDED_CATALOG, platform).unwrap();
            let release = catalog.current(&UiFontPackageId::GoogleSansFlex).unwrap();
            assert_eq!(release.platform, "all");
            assert_eq!(release.sources.len(), EXPECTED_SOURCES.len());
            assert!(release.sources[0].asset.urls[0].starts_with("https://fonts.gstatic.com/"));
            assert!(release.sources[0].asset.urls[1].starts_with(POOL_BASE));
        }
    }

    #[test]
    #[ignore = "downloads the reviewed Google Fonts sources"]
    fn live_ui_font_installs_resolves_and_removes() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = UiFontPackageManager::new(temporary.path(), Arc::new(|| Ok(()))).unwrap();
        let cancellation = CancellationToken::default();
        assert_eq!(
            manager.install(&cancellation, &|_| {}).unwrap().state,
            PackageState::Installed
        );
        let runtime = manager.resolve(&cancellation).unwrap();
        assert_eq!(
            std::fs::metadata(runtime.stylesheet()).unwrap().len(),
            1_239
        );
        assert_eq!(
            std::fs::metadata(runtime.font_file("latin").unwrap())
                .unwrap()
                .len(),
            270_324
        );
        drop(runtime);
        assert_eq!(
            manager.remove(&cancellation, &|_| {}).unwrap(),
            RemovalOutcome::Removed
        );
    }
}
