use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::path_security::validate_relative_path;
use crate::{NativeToolError, Result};

const EMBEDDED_CATALOG: &str = include_str!("../delivery/native-tools.delivery.json");
pub(crate) const PLATFORM_KEYS: &[&str] = &[
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
];
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
        license: "GPL-2.0-or-later",
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArtifactFormat {
    Raw,
    Zip,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DeliveryFile {
    pub source_path: String,
    pub install_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub role: ExecutableRole,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NoticeFile {
    pub install_path: String,
    pub source_url: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolDelivery {
    pub tool: NativeToolId,
    pub platform: String,
    pub version: String,
    pub source_revision: String,
    pub asset: String,
    pub source_url: String,
    pub format: ArtifactFormat,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    schema_version: u32,
    reviewed_at: String,
    policy: RawPolicy,
    tools: Vec<RawTool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPolicy {
    artifact_delivery: String,
    bundled_artifacts: bool,
    self_update_allowed: bool,
    release_state: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawTool {
    id: NativeToolId,
    label: String,
    license: String,
    source_revision: Option<String>,
    notices: Vec<RawNotice>,
    platforms: HashMap<String, RawPlatformDelivery>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawNotice {
    install_path: String,
    source_url: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPlatformDelivery {
    blocker: Option<String>,
    releases: Vec<RawRelease>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRelease {
    version: String,
    distribution_mode: String,
    artifact: RawArtifact,
    files: Vec<RawFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawArtifact {
    asset: String,
    format: ArtifactFormat,
    source_url: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawFile {
    source_path: String,
    install_path: String,
    size_bytes: u64,
    sha256: String,
    role: ExecutableRole,
}

fn parse_catalog(raw: &str, selected_platform: &str) -> Result<DeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if raw.schema_version != 1
        || !valid_date(&raw.reviewed_at)
        || raw.policy.artifact_delivery != "direct-upstream-download-only"
        || raw.policy.bundled_artifacts
        || raw.policy.self_update_allowed
        || raw.policy.release_state != "partially-available"
        || raw.policy.reason.len() < 80
        || raw.tools.len() != NativeToolId::ALL.len()
    {
        return Err(NativeToolError::InvalidCatalog);
    }

    let public_by_id = PUBLIC_CATALOG
        .iter()
        .map(|entry| (entry.id, entry))
        .collect::<HashMap<_, _>>();
    let mut seen_tools = HashSet::new();
    let mut selected = HashMap::new();
    for tool in &raw.tools {
        if !seen_tools.insert(tool.id)
            || tool.platforms.len() != PLATFORM_KEYS.len()
            || PLATFORM_KEYS
                .iter()
                .any(|platform| !tool.platforms.contains_key(*platform))
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        let public = public_by_id
            .get(&tool.id)
            .ok_or(NativeToolError::InvalidCatalog)?;
        if tool.label != public.label || tool.license != public.license {
            return Err(NativeToolError::InvalidCatalog);
        }
        validate_source_and_notices(tool)?;
        for platform in PLATFORM_KEYS {
            let releases = validate_platform(tool, platform)?;
            if *platform == selected_platform {
                selected.insert(tool.id, releases);
            }
        }
    }
    if seen_tools.len() != NativeToolId::ALL.len() {
        return Err(NativeToolError::InvalidCatalog);
    }
    for tool in NativeToolId::ALL {
        selected.entry(tool).or_default();
    }
    Ok(DeliveryCatalog {
        platform: selected_platform.to_string(),
        releases: selected,
    })
}

fn validate_source_and_notices(tool: &RawTool) -> Result<()> {
    if tool.id == NativeToolId::MediaTools {
        if tool.source_revision.is_some() || !tool.notices.is_empty() {
            return Err(NativeToolError::InvalidCatalog);
        }
        return Ok(());
    }
    let revision = tool
        .source_revision
        .as_deref()
        .filter(|revision| valid_revision(revision))
        .ok_or(NativeToolError::InvalidCatalog)?;
    let expected_notice_count = if tool.id == NativeToolId::YtDlp { 2 } else { 1 };
    if tool.notices.len() != expected_notice_count {
        return Err(NativeToolError::InvalidCatalog);
    }
    let mut paths = HashSet::new();
    for notice in &tool.notices {
        validate_relative_path(&notice.install_path)?;
        if !notice.install_path.starts_with("licenses/")
            || !paths.insert(notice.install_path.as_str())
            || notice.size_bytes == 0
            || notice.size_bytes > 4 * 1024 * 1024
            || !valid_sha256(&notice.sha256)
            || !valid_notice_url(tool.id, revision, &notice.source_url)
        {
            return Err(NativeToolError::InvalidCatalog);
        }
    }
    Ok(())
}

fn validate_platform(tool: &RawTool, platform: &str) -> Result<Vec<ToolDelivery>> {
    let delivery = tool
        .platforms
        .get(platform)
        .ok_or(NativeToolError::InvalidCatalog)?;
    if tool.id == NativeToolId::MediaTools {
        if !delivery.releases.is_empty()
            || delivery
                .blocker
                .as_deref()
                .is_none_or(|blocker| blocker.len() < 80)
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        return Ok(Vec::new());
    }
    if delivery.blocker.is_some() || delivery.releases.len() != 1 {
        return Err(NativeToolError::InvalidCatalog);
    }
    let revision = tool
        .source_revision
        .as_deref()
        .ok_or(NativeToolError::InvalidCatalog)?;
    let release = &delivery.releases[0];
    validate_release(tool.id, platform, revision, &tool.notices, release).map(|value| vec![value])
}

fn validate_release(
    tool: NativeToolId,
    platform: &str,
    source_revision: &str,
    notices: &[RawNotice],
    release: &RawRelease,
) -> Result<ToolDelivery> {
    if release.distribution_mode != "direct-upstream-download-only"
        || !valid_version(&release.version)
        || release.artifact.size_bytes == 0
        || release.artifact.size_bytes > MAX_ARTIFACT_BYTES
        || !valid_sha256(&release.artifact.sha256)
        || !valid_asset_name(&release.artifact.asset)
        || release.files.is_empty()
        || release.files.len() > MAX_FILES
        || !valid_release_url(
            tool,
            &release.version,
            &release.artifact.asset,
            &release.artifact.source_url,
        )
    {
        return Err(NativeToolError::InvalidCatalog);
    }
    validate_exact_identity(tool, platform, release)?;

    let mut installed_paths = HashSet::new();
    let mut source_paths = HashSet::new();
    let mut installed_bytes = 0_u64;
    let mut files = Vec::with_capacity(release.files.len());
    for file in &release.files {
        validate_relative_path(&file.source_path)?;
        validate_relative_path(&file.install_path)?;
        if !file.install_path.starts_with("bin/")
            || file.size_bytes == 0
            || file.size_bytes > MAX_INSTALLED_BYTES
            || !valid_sha256(&file.sha256)
            || !installed_paths.insert(file.install_path.as_str())
            || !source_paths.insert(file.source_path.as_str())
            || !role_belongs_to_tool(tool, file.role)
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        installed_bytes = installed_bytes
            .checked_add(file.size_bytes)
            .filter(|bytes| *bytes <= MAX_INSTALLED_BYTES)
            .ok_or(NativeToolError::InvalidCatalog)?;
        files.push(DeliveryFile {
            source_path: file.source_path.clone(),
            install_path: file.install_path.clone(),
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
            role: file.role,
        });
    }
    if release.artifact.format == ArtifactFormat::Raw
        && (files.len() != 1
            || files[0].source_path != release.artifact.asset
            || files[0].size_bytes != release.artifact.size_bytes
            || files[0].sha256 != release.artifact.sha256)
    {
        return Err(NativeToolError::InvalidCatalog);
    }
    let notice_files = notices
        .iter()
        .map(|notice| {
            installed_bytes = installed_bytes
                .checked_add(notice.size_bytes)
                .filter(|bytes| *bytes <= MAX_INSTALLED_BYTES)
                .ok_or(NativeToolError::InvalidCatalog)?;
            Ok(NoticeFile {
                install_path: notice.install_path.clone(),
                source_url: notice.source_url.clone(),
                size_bytes: notice.size_bytes,
                sha256: notice.sha256.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ToolDelivery {
        tool,
        platform: platform.to_string(),
        version: release.version.clone(),
        source_revision: source_revision.to_string(),
        asset: release.artifact.asset.clone(),
        source_url: release.artifact.source_url.clone(),
        format: release.artifact.format,
        size_bytes: release.artifact.size_bytes,
        sha256: release.artifact.sha256.clone(),
        files,
        notices: notice_files,
        installed_bytes,
    })
}

fn validate_exact_identity(tool: NativeToolId, platform: &str, release: &RawRelease) -> Result<()> {
    let (version, asset, install_path, role) = match (tool, platform) {
        (NativeToolId::YtDlp, "windows-x86_64") => (
            "2026.07.04",
            "yt-dlp.exe",
            "bin/yt-dlp.exe",
            ExecutableRole::YtDlp,
        ),
        (NativeToolId::YtDlp, "linux-x86_64") => (
            "2026.07.04",
            "yt-dlp_linux",
            "bin/yt-dlp",
            ExecutableRole::YtDlp,
        ),
        (NativeToolId::YtDlp, "macos-aarch64" | "macos-x86_64") => (
            "2026.07.04",
            "yt-dlp_macos",
            "bin/yt-dlp",
            ExecutableRole::YtDlp,
        ),
        (NativeToolId::Deno, "windows-x86_64") => (
            "2.9.5",
            "deno-x86_64-pc-windows-msvc.zip",
            "bin/deno.exe",
            ExecutableRole::Deno,
        ),
        (NativeToolId::Deno, "linux-x86_64") => (
            "2.9.5",
            "deno-x86_64-unknown-linux-gnu.zip",
            "bin/deno",
            ExecutableRole::Deno,
        ),
        (NativeToolId::Deno, "macos-aarch64") => (
            "2.9.5",
            "deno-aarch64-apple-darwin.zip",
            "bin/deno",
            ExecutableRole::Deno,
        ),
        (NativeToolId::Deno, "macos-x86_64") => (
            "2.9.5",
            "deno-x86_64-apple-darwin.zip",
            "bin/deno",
            ExecutableRole::Deno,
        ),
        _ => return Err(NativeToolError::InvalidCatalog),
    };
    if release.version != version
        || release.artifact.asset != asset
        || release.files.len() != 1
        || release.files[0].install_path != install_path
        || release.files[0].role != role
    {
        return Err(NativeToolError::InvalidCatalog);
    }
    Ok(())
}

fn role_belongs_to_tool(tool: NativeToolId, role: ExecutableRole) -> bool {
    matches!(
        (tool, role),
        (
            NativeToolId::MediaTools,
            ExecutableRole::Ffmpeg | ExecutableRole::Ffprobe
        ) | (NativeToolId::YtDlp, ExecutableRole::YtDlp)
            | (NativeToolId::Deno, ExecutableRole::Deno)
    )
}

fn valid_release_url(tool: NativeToolId, version: &str, asset: &str, value: &str) -> bool {
    let repository = match tool {
        NativeToolId::YtDlp => "yt-dlp/yt-dlp",
        NativeToolId::Deno => "denoland/deno",
        NativeToolId::MediaTools => return false,
    };
    let tag = if tool == NativeToolId::Deno {
        format!("v{version}")
    } else {
        version.to_string()
    };
    value == format!("https://github.com/{repository}/releases/download/{tag}/{asset}")
}

fn valid_notice_url(tool: NativeToolId, revision: &str, value: &str) -> bool {
    let repository = match tool {
        NativeToolId::YtDlp => "yt-dlp/yt-dlp",
        NativeToolId::Deno => "denoland/deno",
        NativeToolId::MediaTools => return false,
    };
    let prefix = format!("https://raw.githubusercontent.com/{repository}/{revision}/");
    let Some(path) = value.strip_prefix(&prefix) else {
        return false;
    };
    validate_relative_path(path).is_ok() && strict_https(value, "raw.githubusercontent.com")
}

fn strict_https(value: &str, host: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str() == Some(host)
            && url.port_or_known_default() == Some(443)
            && url.query().is_none()
            && url.fragment().is_none()
            && !url.path_segments().is_some_and(|segments| {
                segments
                    .into_iter()
                    .any(|segment| segment.eq_ignore_ascii_case("latest"))
            })
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && !value.to_ascii_lowercase().contains("latest")
        && value.bytes().any(|byte| byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

fn valid_asset_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

fn valid_date(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

pub(crate) fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
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
    fn checked_in_catalog_has_two_tools_and_an_honest_ffmpeg_blocker() {
        let catalog = DeliveryCatalog::builtin().unwrap();
        assert_eq!(catalog.platform(), current_platform());
        assert!(catalog.releases(NativeToolId::MediaTools).is_empty());
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
