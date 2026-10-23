use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

pub(crate) use osg_delivery_core::identity::{PLATFORM_KEYS, current_platform};
use serde::{Deserialize, Serialize};

use crate::{NativeToolError, Result};

mod parse;
mod rules;

use parse::parse_catalog;
pub(crate) use rules::{valid_ytdlp_version, validate_dynamic_ytdlp_delivery};

const EMBEDDED_CATALOG: &str = include_str!("../delivery/native-tools.delivery.json");
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_INSTALLED_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum NativeToolId {
    #[serde(rename = "media-tools")]
    MediaTools,
    #[serde(rename = "yt-dlp")]
    YtDlp,
    #[serde(rename = "deno")]
    Deno,
}

impl NativeToolId {
    pub const ALL: [Self; 3] = [Self::MediaTools, Self::YtDlp, Self::Deno];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MediaTools => "media-tools",
            Self::YtDlp => "yt-dlp",
            Self::Deno => "deno",
        }
    }
}

impl fmt::Display for NativeToolId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for NativeToolId {
    type Error = NativeToolError;

    fn try_from(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|tool| tool.as_str() == value)
            .ok_or(NativeToolError::InvalidRequest)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutableRole {
    Ffmpeg,
    Ffprobe,
    YtDlp,
    Deno,
}

impl ExecutableRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
            Self::YtDlp => "yt-dlp",
            Self::Deno => "deno",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolInfo {
    pub id: NativeToolId,
    pub label: &'static str,
    pub license: &'static str,
}

const PUBLIC_CATALOG: [NativeToolInfo; 3] = [
    NativeToolInfo {
        id: NativeToolId::MediaTools,
        label: "FFmpeg and FFprobe",
        license: "GPL-3.0-or-later",
    },
    NativeToolInfo {
        id: NativeToolId::YtDlp,
        label: "yt-dlp",
        license: "GPL-3.0-or-later",
    },
    NativeToolInfo {
        id: NativeToolId::Deno,
        label: "Deno",
        license: "MIT",
    },
];

#[must_use]
pub const fn catalog() -> &'static [NativeToolInfo] {
    &PUBLIC_CATALOG
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArtifactFormat {
    Raw,
    Zip,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeliveryFile {
    pub source_path: String,
    pub install_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub role: Option<ExecutableRole>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoticeFile {
    pub install_path: String,
    pub source_url: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolDelivery {
    pub tool: NativeToolId,
    pub platform: String,
    pub version: String,
    pub source_revision: String,
    pub asset: String,
    pub source_url: String,
    pub format: ArtifactFormat,
    pub selective_extraction: bool,
    pub size_bytes: u64,
    pub sha256: String,
    pub files: Vec<DeliveryFile>,
    pub notices: Vec<NoticeFile>,
    pub installed_bytes: u64,
}

#[derive(Debug)]
pub(crate) struct DeliveryCatalog {
    platform: String,
    releases: HashMap<NativeToolId, Vec<ToolDelivery>>,
}

impl DeliveryCatalog {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<DeliveryCatalog>> =
            LazyLock::new(|| parse_catalog(EMBEDDED_CATALOG, current_platform()));
        CATALOG.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn platform(&self) -> &str {
        &self.platform
    }

    pub(crate) fn releases(&self, tool: NativeToolId) -> &[ToolDelivery] {
        self.releases.get(&tool).map_or(&[], Vec::as_slice)
    }

    pub(crate) fn current(&self, tool: NativeToolId) -> Option<&ToolDelivery> {
        self.releases(tool).first()
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
    fn checked_in_catalog_exposes_only_reviewed_platform_deliveries() {
        let catalog = DeliveryCatalog::builtin().unwrap();
        assert_eq!(catalog.platform(), current_platform());
        assert_eq!(
            catalog.releases(NativeToolId::MediaTools).len(),
            usize::from(current_platform() == "windows-x86_64")
        );
        assert_eq!(catalog.releases(NativeToolId::YtDlp).len(), 1);
        assert_eq!(catalog.releases(NativeToolId::Deno).len(), 1);
    }

    #[test]
    fn mutable_urls_and_omitted_platforms_are_rejected() {
        let mut document: serde_json::Value = serde_json::from_str(EMBEDDED_CATALOG).unwrap();
        document["tools"][1]["platforms"]["windows-x86_64"]["releases"][0]["artifact"]["sourceUrl"] =
            serde_json::Value::String(
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe".to_string(),
            );
        assert!(matches!(
            parse_for_test(&document.to_string(), "windows-x86_64"),
            Err(NativeToolError::InvalidCatalog)
        ));

        let mut document: serde_json::Value = serde_json::from_str(EMBEDDED_CATALOG).unwrap();
        document["tools"][2]["platforms"]
            .as_object_mut()
            .unwrap()
            .remove("macos-x86_64");
        assert!(matches!(
            parse_for_test(&document.to_string(), "windows-x86_64"),
            Err(NativeToolError::InvalidCatalog)
        ));
    }

    #[test]
    fn public_catalog_contract_is_path_and_url_free() {
        let encoded = serde_json::to_string(catalog()).unwrap();
        assert!(!encoded.contains("http"));
        assert!(!encoded.contains("bin/"));
        assert!(!encoded.contains("sha256"));
    }
}
