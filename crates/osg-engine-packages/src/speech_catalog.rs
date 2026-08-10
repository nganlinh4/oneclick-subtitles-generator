use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::catalog::{
    DeliveryFile, FileRole, MAX_ARCHIVE_BYTES, MAX_FILES, MAX_TOTAL_INSTALLED_BYTES,
    MAX_UNPACKED_BYTES, PLATFORM_KEYS, PackageCatalog, PackageDelivery, current_platform,
    is_below_directory, role_matches_path, valid_asset_name, validate_identifier, validate_sha256,
};
use crate::path_security::{validate_directory_path, validate_manifest_path};
use crate::{PackageError, Result};

const MAX_RELEASES_PER_BACKEND: usize = 2;
const RELEASE_BASE: &str =
    "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/speech-packs-v1/";
const EMBEDDED_CATALOG: &str =
    include_str!("../../osg-speech/delivery/speech-packages.delivery.json");

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum SpeechPackageId {
    #[serde(rename = "f5-tts")]
    F5Tts,
    #[serde(rename = "chatterbox")]
    Chatterbox,
    #[serde(rename = "edge-tts")]
    EdgeTts,
    #[serde(rename = "gtts")]
    Gtts,
    #[serde(rename = "gemini-tts")]
    GeminiTts,
}

impl SpeechPackageId {
    pub const ALL: [Self; 5] = [
        Self::F5Tts,
        Self::Chatterbox,
        Self::EdgeTts,
        Self::Gtts,
        Self::GeminiTts,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::F5Tts => "f5-tts",
            Self::Chatterbox => "chatterbox",
            Self::EdgeTts => "edge-tts",
            Self::Gtts => "gtts",
            Self::GeminiTts => "gemini-tts",
        }
    }

    #[must_use]
    pub const fn requires_model(self) -> bool {
        matches!(self, Self::F5Tts | Self::Chatterbox)
    }
}

impl fmt::Display for SpeechPackageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for SpeechPackageId {
    type Error = PackageError;

    fn try_from(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|backend| backend.as_str() == value)
            .ok_or(PackageError::InvalidRequest)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechRuntimeKind {
    LocalModel,
    RemoteProvider,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPackageInfo {
    pub id: SpeechPackageId,
    pub label: &'static str,
    pub runtime: SpeechRuntimeKind,
    pub requires_model: bool,
}

const SPEECH_CATALOG: [SpeechPackageInfo; 5] = [
    SpeechPackageInfo {
        id: SpeechPackageId::F5Tts,
        label: "F5-TTS",
        runtime: SpeechRuntimeKind::LocalModel,
        requires_model: true,
    },
    SpeechPackageInfo {
        id: SpeechPackageId::Chatterbox,
        label: "Chatterbox",
        runtime: SpeechRuntimeKind::LocalModel,
        requires_model: true,
    },
    SpeechPackageInfo {
        id: SpeechPackageId::EdgeTts,
        label: "Edge TTS",
        runtime: SpeechRuntimeKind::RemoteProvider,
        requires_model: false,
    },
    SpeechPackageInfo {
        id: SpeechPackageId::Gtts,
        label: "gTTS",
        runtime: SpeechRuntimeKind::RemoteProvider,
        requires_model: false,
    },
    SpeechPackageInfo {
        id: SpeechPackageId::GeminiTts,
        label: "Gemini TTS",
        runtime: SpeechRuntimeKind::RemoteProvider,
        requires_model: false,
    },
];

#[must_use]
pub const fn speech_catalog() -> &'static [SpeechPackageInfo] {
    &SPEECH_CATALOG
}

pub(crate) type SpeechDeliveryCatalog = PackageCatalog<SpeechPackageId>;

impl PackageCatalog<SpeechPackageId> {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<SpeechDeliveryCatalog>> = LazyLock::new(|| {
            crate::upstream_lock::validate_builtin()?;
            parse_catalog(EMBEDDED_CATALOG, current_platform())
        });
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
    remove: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlatform {
    backends: Vec<RawBackend>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBackend {
    id: SpeechPackageId,
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
    files: Vec<RawFile>,
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

fn parse_catalog(raw: &str, selected_platform: &str) -> Result<SpeechDeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    validate_commands(&raw.commands)?;
    if raw.schema_version != 1
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
    Ok(PackageCatalog {
        platform: selected_platform.to_string(),
        releases: selected.unwrap_or_default(),
    })
}

fn validate_commands(commands: &RawCommands) -> Result<()> {
    if commands.status != "speech_packages_status"
        || commands.install != "speech_package_install"
        || commands.remove != "speech_package_remove"
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

fn validate_platform(
    platform_key: &str,
    platform: &RawPlatform,
) -> Result<HashMap<SpeechPackageId, Vec<PackageDelivery>>> {
    if platform.backends.len() != SpeechPackageId::ALL.len() {
        return Err(PackageError::InvalidCatalog);
    }
    let mut seen = HashSet::new();
    let mut releases = HashMap::new();
    let mut platform_total = 0_u64;
    for backend in &platform.backends {
        if !seen.insert(backend.id) || backend.releases.len() > MAX_RELEASES_PER_BACKEND {
            return Err(PackageError::InvalidCatalog);
        }
        let mut versions = HashSet::new();
        let mut validated = Vec::with_capacity(backend.releases.len());
        for release in &backend.releases {
            if !versions.insert(release.version.as_str()) {
                return Err(PackageError::InvalidCatalog);
            }
            let delivery = validate_release(platform_key, backend.id, release)?;
            platform_total = platform_total
                .checked_add(delivery.unpacked_size_bytes)
                .filter(|total| *total <= MAX_TOTAL_INSTALLED_BYTES)
                .ok_or(PackageError::InvalidCatalog)?;
            validated.push(delivery);
        }
        releases.insert(backend.id, validated);
    }
    if seen.len() != SpeechPackageId::ALL.len() {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(releases)
}

#[allow(clippy::too_many_lines)]
fn validate_release(
    platform: &str,
    backend: SpeechPackageId,
    release: &RawRelease,
) -> Result<PackageDelivery> {
    validate_identifier(&release.version)?;
    validate_manifest_path(&release.version)?;
    validate_sha256(&release.sha256)?;
    if release.size_bytes == 0
        || release.size_bytes > MAX_ARCHIVE_BYTES
        || release.unpacked_size_bytes == 0
        || release.unpacked_size_bytes > MAX_UNPACKED_BYTES
        || release.files.is_empty()
        || release.files.len() > MAX_FILES
    {
        return Err(PackageError::InvalidCatalog);
    }
    let expected_asset = format!(
        "{}-{platform}-{}-{}.zip",
        backend.as_str(),
        release.version,
        &release.sha256[..16]
    );
    if release.asset != expected_asset
        || !valid_asset_name(&release.asset)
        || release.source_url != format!("{RELEASE_BASE}{}", release.asset)
        || !valid_source_url(&release.source_url, &release.asset)
    {
        return Err(PackageError::InvalidCatalog);
    }
    validate_manifest_path(&release.python_relative_path)?;
    match &release.model_relative_path {
        Some(model) if backend.requires_model() => validate_directory_path(model)?,
        None if !backend.requires_model() => {}
        _ => return Err(PackageError::InvalidCatalog),
    }

    let mut paths = HashSet::new();
    let mut total = 0_u64;
    let mut has_runtime = false;
    let mut has_model = false;
    let mut has_license = false;
    let mut python_matches = false;
    let mut files = Vec::with_capacity(release.files.len());
    for file in &release.files {
        validate_manifest_path(&file.path)?;
        validate_sha256(&file.sha256)?;
        if file.size_bytes == 0
            || file.size_bytes > MAX_UNPACKED_BYTES
            || !paths.insert(&file.path)
            || !role_matches_path(file.role, &file.path)
            || file.role == FileRole::Aligner
        {
            return Err(PackageError::InvalidCatalog);
        }
        total = total
            .checked_add(file.size_bytes)
            .filter(|value| *value <= release.unpacked_size_bytes)
            .ok_or(PackageError::InvalidCatalog)?;
        has_runtime |= file.role == FileRole::Runtime;
        has_license |= file.role == FileRole::License && !file.executable;
        has_model |= file.role == FileRole::Model
            && !file.executable
            && release
                .model_relative_path
                .as_ref()
                .is_some_and(|directory| is_below_directory(&file.path, directory));
        python_matches |= file.path == release.python_relative_path
            && file.role == FileRole::Runtime
            && file.executable;
        files.push(DeliveryFile {
            path: file.path.clone(),
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
            executable: file.executable,
            role: file.role,
        });
    }
    if total != release.unpacked_size_bytes
        || !has_runtime
        || !has_license
        || !python_matches
        || backend.requires_model() != has_model
    {
        return Err(PackageError::InvalidCatalog);
    }

    Ok(PackageDelivery {
        component: backend.as_str().to_string(),
        platform: platform.to_string(),
        version: release.version.clone(),
        asset: release.asset.clone(),
        source_url: release.source_url.clone(),
        size_bytes: release.size_bytes,
        sha256: release.sha256.clone(),
        unpacked_size_bytes: release.unpacked_size_bytes,
        python_relative_path: release.python_relative_path.clone(),
        model_relative_path: release.model_relative_path.clone(),
        aligner_relative_path: None,
        files,
    })
}

fn valid_source_url(value: &str, asset: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path()
            == format!(
                "/nganlinh4/oneclick-subtitles-generator/releases/download/speech-packs-v1/{asset}"
            )
}

#[cfg(test)]
pub(crate) fn parse_for_test(raw: &str, platform: &str) -> Result<SpeechDeliveryCatalog> {
    parse_catalog(raw, platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_catalog_fails_closed_until_audited_archives_exist() {
        let catalog = SpeechDeliveryCatalog::builtin().unwrap();
        assert_eq!(catalog.platform(), current_platform());
        for backend in SpeechPackageId::ALL {
            assert!(catalog.releases(&backend).is_empty());
        }
    }

    #[test]
    fn public_catalog_has_distinct_typed_speech_packages() {
        assert_eq!(speech_catalog().len(), SpeechPackageId::ALL.len());
        assert_eq!(
            speech_catalog()
                .iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>(),
            SpeechPackageId::ALL
        );
        assert!(SpeechPackageId::F5Tts.requires_model());
        assert!(!SpeechPackageId::GeminiTts.requires_model());
    }
}
