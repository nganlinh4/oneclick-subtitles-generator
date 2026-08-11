use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::path_security::{validate_directory_path, validate_manifest_path};
use crate::{PackageError, Result};

pub(crate) const MAX_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub(crate) const MAX_UNPACKED_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub(crate) const MAX_TOTAL_INSTALLED_BYTES: u64 = 96 * 1024 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 100_000;
const MAX_RELEASES_PER_ENGINE: usize = 2;
const RELEASE_BASE: &str = "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/asr-engine-packs-v1/";
const EMBEDDED_CATALOG: &str = include_str!("../delivery/engine-packages.delivery.json");
pub(crate) const PLATFORM_KEYS: &[&str] = &[
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum EngineId {
    #[serde(rename = "parakeet")]
    Parakeet,
    #[serde(rename = "faster-whisper-turbo")]
    FasterWhisperTurbo,
    #[serde(rename = "faster-whisper-large-v3")]
    FasterWhisperLargeV3,
    #[serde(rename = "qwen3-asr-1.7b")]
    Qwen3Asr1_7b,
    #[serde(rename = "qwen3-asr-0.6b")]
    Qwen3Asr0_6b,
}

impl EngineId {
    pub const ALL: [Self; 5] = [
        Self::Parakeet,
        Self::FasterWhisperTurbo,
        Self::FasterWhisperLargeV3,
        Self::Qwen3Asr1_7b,
        Self::Qwen3Asr0_6b,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Parakeet => "parakeet",
            Self::FasterWhisperTurbo => "faster-whisper-turbo",
            Self::FasterWhisperLargeV3 => "faster-whisper-large-v3",
            Self::Qwen3Asr1_7b => "qwen3-asr-1.7b",
            Self::Qwen3Asr0_6b => "qwen3-asr-0.6b",
        }
    }

    #[must_use]
    pub const fn requires_aligner(self) -> bool {
        matches!(self, Self::Qwen3Asr1_7b | Self::Qwen3Asr0_6b)
    }
}

impl fmt::Display for EngineId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for EngineId {
    type Error = PackageError;

    fn try_from(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|engine| engine.as_str() == value)
            .ok_or(PackageError::InvalidRequest)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineRuntimeKind {
    Onnx,
    CTranslate2,
    PyTorch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePackageInfo {
    pub id: EngineId,
    pub label: &'static str,
    pub runtime: EngineRuntimeKind,
    pub requires_aligner: bool,
}

const ENGINE_CATALOG: [EnginePackageInfo; 5] = [
    EnginePackageInfo {
        id: EngineId::Parakeet,
        label: "NVIDIA Parakeet TDT 0.6B V3",
        runtime: EngineRuntimeKind::Onnx,
        requires_aligner: false,
    },
    EnginePackageInfo {
        id: EngineId::FasterWhisperTurbo,
        label: "Faster-Whisper Turbo",
        runtime: EngineRuntimeKind::CTranslate2,
        requires_aligner: false,
    },
    EnginePackageInfo {
        id: EngineId::FasterWhisperLargeV3,
        label: "Faster-Whisper Large-v3",
        runtime: EngineRuntimeKind::CTranslate2,
        requires_aligner: false,
    },
    EnginePackageInfo {
        id: EngineId::Qwen3Asr1_7b,
        label: "Qwen3-ASR 1.7B",
        runtime: EngineRuntimeKind::PyTorch,
        requires_aligner: true,
    },
    EnginePackageInfo {
        id: EngineId::Qwen3Asr0_6b,
        label: "Qwen3-ASR 0.6B",
        runtime: EngineRuntimeKind::PyTorch,
        requires_aligner: true,
    },
];

#[must_use]
pub const fn catalog() -> &'static [EnginePackageInfo] {
    &ENGINE_CATALOG
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FileRole {
    Runtime,
    Model,
    Aligner,
    License,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeliveryFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub executable: bool,
    pub role: FileRole,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PackageDelivery {
    pub component: String,
    pub platform: String,
    pub version: String,
    pub asset: String,
    pub source_url: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub unpacked_size_bytes: u64,
    pub python_relative_path: String,
    pub primary_executable: bool,
    pub model_relative_path: Option<String>,
    pub aligner_relative_path: Option<String>,
    pub files: Vec<DeliveryFile>,
    pub sources: Vec<DeliverySource>,
    pub manifest: Option<DeliveryAsset>,
}

impl PackageDelivery {
    pub(crate) fn download_url(&self) -> &str {
        &self.source_url
    }

    pub(crate) fn integrity_sha256(&self) -> &str {
        self.manifest
            .as_ref()
            .map_or(self.sha256.as_str(), |manifest| manifest.sha256.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliverySourceKind {
    Zip,
    Raw,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DeliveryAsset {
    pub asset: String,
    pub urls: Vec<String>,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DeliverySource {
    pub asset: DeliveryAsset,
    pub kind: DeliverySourceKind,
}

#[derive(Debug)]
pub(crate) struct PackageCatalog<K> {
    pub(crate) platform: String,
    pub(crate) releases: HashMap<K, Vec<PackageDelivery>>,
}

pub(crate) type DeliveryCatalog = PackageCatalog<EngineId>;

impl PackageCatalog<EngineId> {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<DeliveryCatalog>> =
            LazyLock::new(|| parse_catalog(EMBEDDED_CATALOG, current_platform()));
        CATALOG.as_ref().map_err(Clone::clone)
    }
}

impl<K> PackageCatalog<K>
where
    K: Eq + std::hash::Hash,
{
    pub(crate) fn platform(&self) -> &str {
        &self.platform
    }

    pub(crate) fn releases(&self, component: &K) -> &[PackageDelivery] {
        self.releases.get(component).map_or(&[], Vec::as_slice)
    }

    pub(crate) fn current(&self, component: &K) -> Option<&PackageDelivery> {
        self.releases(component).first()
    }
}

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

fn parse_catalog(raw: &str, selected_platform: &str) -> Result<DeliveryCatalog> {
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
    validate_manifest_path(&release.version)?;
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
        if release.asset != expected_asset || !valid_asset_name(&release.asset) {
            return Err(PackageError::InvalidCatalog);
        }
    }
    validate_manifest_path(&release.python_relative_path)?;
    validate_directory_path(&release.model_relative_path)?;
    if let Some(aligner) = &release.aligner_relative_path {
        validate_directory_path(aligner)?;
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
        validate_manifest_path(&file.path)?;
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
    if !valid_asset_name(&asset.asset)
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

pub(crate) fn valid_delivery_url(value: &str, asset: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some("github.com") => url.path().ends_with(&format!("/{asset}"))
            && url.path().starts_with(
                "/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/",
            ),
        Some("huggingface.co") => {
            let segments = url.path().split('/').collect::<Vec<_>>();
            let revision = segments
                .iter()
                .position(|segment| *segment == "resolve")
                .and_then(|index| segments.get(index + 1));
            url.path().ends_with(&format!("/{asset}"))
                && revision.is_some_and(|revision| {
                    revision.len() == 40
                        && revision
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
        }
        Some("files.pythonhosted.org" | "download.pytorch.org") => {
            url.path().ends_with(&format!("/{asset}"))
        }
        Some("fonts.gstatic.com") => {
            url.path().starts_with("/s/googlesansflex/v22/")
                && url.path().as_bytes().ends_with(b".woff2")
        }
        Some("openfontlicense.org") => url.path() == "/documents/OFL.txt",
        _ => false,
    }
}

pub(crate) fn role_matches_path(role: FileRole, path: &str) -> bool {
    let prefix = match role {
        FileRole::Runtime => "runtime/",
        FileRole::Model => "model/",
        FileRole::Aligner => "aligner/",
        FileRole::License => "licenses/",
    };
    path.starts_with(prefix)
}

pub(crate) fn is_below_directory(path: &str, directory: &str) -> bool {
    path.strip_prefix(directory)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(crate) fn validate_identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

pub(crate) fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

pub(crate) fn valid_asset_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

pub(crate) fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "x86_64") => "macos-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        _ => "unsupported",
    }
}

#[cfg(test)]
pub(crate) fn parse_for_test(raw: &str, platform: &str) -> Result<DeliveryCatalog> {
    parse_catalog(raw, platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_catalog_publishes_windows_and_withholds_unbuilt_targets() {
        let catalog = DeliveryCatalog::builtin().unwrap();
        assert_eq!(catalog.platform(), current_platform());
        for engine in EngineId::ALL {
            if current_platform() == "windows-x86_64" {
                let release = catalog.current(&engine).unwrap();
                assert!(release.manifest.is_some());
                assert!(!release.sources.is_empty());
                assert!(release.files.is_empty());
            } else {
                assert!(catalog.releases(&engine).is_empty());
            }
        }
    }

    #[test]
    fn public_catalog_matches_the_five_asr_engines() {
        assert_eq!(catalog().len(), EngineId::ALL.len());
        assert_eq!(
            catalog().iter().map(|entry| entry.id).collect::<Vec<_>>(),
            EngineId::ALL
        );
    }
}
