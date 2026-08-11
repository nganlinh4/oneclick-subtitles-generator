use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::catalog::{
    DeliveryFile, FileRole, MAX_ARCHIVE_BYTES, PLATFORM_KEYS, PackageCatalog, PackageDelivery,
    current_platform, valid_asset_name, valid_delivery_url, validate_identifier, validate_sha256,
};
use crate::path_security::validate_manifest_path;
use crate::{PackageError, Result};

const EMBEDDED_CATALOG: &str = include_str!("../delivery/voice-samples.delivery.json");

pub const VOICE_SAMPLE_IDS: [&str; 30] = [
    "achernar",
    "achird",
    "algenib",
    "algieba",
    "alnilam",
    "aoede",
    "autonoe",
    "callirrhoe",
    "charon",
    "despina",
    "enceladus",
    "erinome",
    "fenrir",
    "gacrux",
    "iapetus",
    "kore",
    "laomedeia",
    "leda",
    "orus",
    "puck",
    "pulcherrima",
    "rasalgethi",
    "sadachbia",
    "sadaltager",
    "schedar",
    "sulafat",
    "umbriel",
    "vindemiatrix",
    "zephyr",
    "zubenelgenubi",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum AssetPackageId {
    #[serde(rename = "gemini-voice-samples")]
    GeminiVoiceSamples,
}

impl AssetPackageId {
    pub const ALL: [Self; 1] = [Self::GeminiVoiceSamples];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        "gemini-voice-samples"
    }
}

impl fmt::Display for AssetPackageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPackageInfo {
    pub id: AssetPackageId,
    pub label: &'static str,
    pub license: &'static str,
}

const PUBLIC_CATALOG: [AssetPackageInfo; 1] = [AssetPackageInfo {
    id: AssetPackageId::GeminiVoiceSamples,
    label: "Gemini voice previews",
    license: "Sample media; provider terms apply",
}];

#[must_use]
pub const fn asset_catalog() -> &'static [AssetPackageInfo] {
    &PUBLIC_CATALOG
}

pub(crate) type AssetDeliveryCatalog = PackageCatalog<AssetPackageId>;

impl PackageCatalog<AssetPackageId> {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<AssetDeliveryCatalog>> =
            LazyLock::new(|| parse_catalog(EMBEDDED_CATALOG, current_platform()));
        CATALOG.as_ref().map_err(Clone::clone)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    schema_version: u32,
    commands: RawCommands,
    platforms: HashMap<String, RawPlatform>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCommands {
    status: String,
    install: String,
    cancel: String,
    resolve: String,
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
    size_bytes: u64,
    sha256: String,
    unpacked_size_bytes: u64,
    files: Vec<DeliveryFile>,
    source_url: String,
    sample_relative_path: String,
}

fn parse_catalog(raw: &str, selected_platform: &str) -> Result<AssetDeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if raw.schema_version != 1
        || raw.commands.status != "voice_samples_status"
        || raw.commands.install != "voice_samples_install"
        || raw.commands.cancel != "voice_samples_cancel"
        || raw.commands.resolve != "voice_sample_resolve"
        || raw.commands.remove != "voice_samples_remove"
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
        let delivery = validate_release(platform, &releases[0])?;
        if *platform == selected_platform {
            selected.push(delivery);
        }
    }
    Ok(PackageCatalog {
        platform: selected_platform.to_owned(),
        releases: HashMap::from([(AssetPackageId::GeminiVoiceSamples, selected)]),
    })
}

fn validate_release(platform: &str, release: &RawRelease) -> Result<PackageDelivery> {
    validate_identifier(&release.version)?;
    validate_sha256(&release.sha256)?;
    validate_manifest_path(&release.sample_relative_path)?;
    if !valid_asset_name(&release.asset)
        || !valid_delivery_url(&release.source_url, &release.asset)
        || release.size_bytes == 0
        || release.size_bytes > MAX_ARCHIVE_BYTES
        || release.unpacked_size_bytes == 0
        || release.unpacked_size_bytes > 64 * 1024 * 1024
        || release.files.len() != VOICE_SAMPLE_IDS.len()
    {
        return Err(PackageError::InvalidCatalog);
    }
    let expected = VOICE_SAMPLE_IDS
        .iter()
        .map(|voice| format!("samples/chirp3-hd-{voice}.wav"))
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    for file in &release.files {
        validate_manifest_path(&file.path)?;
        validate_sha256(&file.sha256)?;
        if file.executable
            || file.role != FileRole::Runtime
            || !expected.contains(&file.path)
            || !seen.insert(file.path.as_str())
            || file.size_bytes < 44
        {
            return Err(PackageError::InvalidCatalog);
        }
        total = total
            .checked_add(file.size_bytes)
            .ok_or(PackageError::InvalidCatalog)?;
    }
    if seen.len() != expected.len()
        || total != release.unpacked_size_bytes
        || release.sample_relative_path != "samples/chirp3-hd-achernar.wav"
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(PackageDelivery {
        component: AssetPackageId::GeminiVoiceSamples.as_str().to_owned(),
        platform: platform.to_owned(),
        version: release.version.clone(),
        asset: release.asset.clone(),
        source_url: release.source_url.clone(),
        size_bytes: release.size_bytes,
        sha256: release.sha256.clone(),
        unpacked_size_bytes: release.unpacked_size_bytes,
        python_relative_path: release.sample_relative_path.clone(),
        primary_executable: false,
        model_relative_path: None,
        aligner_relative_path: None,
        files: release.files.clone(),
        sources: Vec::new(),
        manifest: None,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{AssetPackageManager, CancellationToken, PackageState, RemovalOutcome};

    #[test]
    fn checked_in_voice_catalog_is_available_on_every_supported_target() {
        for platform in PLATFORM_KEYS {
            let catalog = parse_catalog(EMBEDDED_CATALOG, platform).unwrap();
            let release = catalog
                .current(&AssetPackageId::GeminiVoiceSamples)
                .unwrap();
            assert_eq!(release.files.len(), VOICE_SAMPLE_IDS.len());
            assert_eq!(release.unpacked_size_bytes, 16_384_680);
            assert!(release.source_url.contains("osg-runtime-bundles-v1"));
        }
    }

    #[test]
    #[ignore = "downloads the reviewed remote voice-sample archive"]
    fn live_voice_pack_installs_resolves_and_removes_without_restart() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = AssetPackageManager::new(temporary.path(), Arc::new(|| Ok(()))).unwrap();
        let cancellation = CancellationToken::default();
        let status = manager.install(&cancellation, &|_| {}).unwrap();
        assert_eq!(status.state, PackageState::Installed);
        let runtime = manager.resolve(&cancellation).unwrap();
        let sample = runtime.voice_sample("achernar").unwrap();
        assert_eq!(std::fs::metadata(sample).unwrap().len(), 499_244);
        drop(runtime);
        assert_eq!(
            manager.remove(&cancellation, &|_| {}).unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(manager.status().state, PackageState::Missing);
    }
}
