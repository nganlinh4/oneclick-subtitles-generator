use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

use osg_delivery_core::identity::is_git_revision;
pub(crate) use osg_delivery_core::identity::{PLATFORM_KEYS, current_platform, is_asset_name};
use serde::{Deserialize, Serialize};

use crate::{PackageError, Result};

mod parse;

use parse::parse_catalog;

pub(crate) const MAX_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub(crate) const MAX_UNPACKED_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub(crate) const MAX_TOTAL_INSTALLED_BYTES: u64 = 96 * 1024 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 100_000;
const MAX_RELEASES_PER_ENGINE: usize = 2;
const RELEASE_BASE: &str = "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/asr-engine-packs-v1/";
const EMBEDDED_CATALOG: &str = include_str!("../delivery/engine-packages.delivery.json");

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
                && revision.is_some_and(|revision| is_git_revision(revision))
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
    if !osg_delivery_core::identity::is_sha256_hex(value) {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
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
