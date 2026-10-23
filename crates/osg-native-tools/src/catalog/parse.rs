//! Strict parsing of the embedded delivery catalog: every tool, platform, release, file, and
//! notice must match the reviewed exact identity before it becomes a `ToolDelivery`.

use std::collections::{HashMap, HashSet};

use osg_delivery_core::identity::{is_asset_name, is_git_revision, is_sha256_hex};
use serde::Deserialize;

use super::rules::{valid_date, valid_notice_url, valid_release_url, valid_version};
use super::{
    ArtifactFormat, DeliveryCatalog, DeliveryFile, ExecutableRole, MAX_ARTIFACT_BYTES, MAX_FILES,
    MAX_INSTALLED_BYTES, NativeToolId, NoticeFile, PLATFORM_KEYS, PUBLIC_CATALOG, ToolDelivery,
};
use crate::path_security::validate_relative_path;
use crate::{NativeToolError, Result};

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
    #[serde(default)]
    selective_extraction: bool,
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
    role: Option<ExecutableRole>,
}

pub(super) fn parse_catalog(raw: &str, selected_platform: &str) -> Result<DeliveryCatalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if raw.schema_version != 1
        || !valid_date(&raw.reviewed_at)
        || raw.policy.artifact_delivery != "direct-reviewed-source-download-only"
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
    let revision = tool
        .source_revision
        .as_deref()
        .filter(|revision| is_git_revision(revision))
        .ok_or(NativeToolError::InvalidCatalog)?;
    let expected_notice_count = match tool.id {
        NativeToolId::YtDlp => 2,
        NativeToolId::Deno => 1,
        NativeToolId::MediaTools => 0,
    };
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
            || !is_sha256_hex(&notice.sha256)
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
        if platform == "windows-x86_64" {
            if delivery.blocker.is_some() || delivery.releases.len() != 1 {
                return Err(NativeToolError::InvalidCatalog);
            }
            let revision = tool
                .source_revision
                .as_deref()
                .ok_or(NativeToolError::InvalidCatalog)?;
            return validate_release(
                tool.id,
                platform,
                revision,
                &tool.notices,
                &delivery.releases[0],
            )
            .map(|value| vec![value]);
        }
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
    if release.distribution_mode != "direct-reviewed-source-download-only"
        || !valid_version(&release.version)
        || release.artifact.size_bytes == 0
        || release.artifact.size_bytes > MAX_ARTIFACT_BYTES
        || !is_sha256_hex(&release.artifact.sha256)
        || !is_asset_name(&release.artifact.asset)
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
        if !(file.install_path.starts_with("bin/") || file.install_path.starts_with("licenses/"))
            || file.size_bytes == 0
            || file.size_bytes > MAX_INSTALLED_BYTES
            || !is_sha256_hex(&file.sha256)
            || !installed_paths.insert(file.install_path.as_str())
            || !source_paths.insert(file.source_path.as_str())
            || file
                .role
                .is_some_and(|role| !role_belongs_to_tool(tool, role))
            || (file.install_path.starts_with("bin/") != file.role.is_some())
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
            || release.artifact.selective_extraction
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
        selective_extraction: release.artifact.selective_extraction,
        size_bytes: release.artifact.size_bytes,
        sha256: release.artifact.sha256.clone(),
        files,
        notices: notice_files,
        installed_bytes,
    })
}

fn validate_exact_identity(tool: NativeToolId, platform: &str, release: &RawRelease) -> Result<()> {
    if tool == NativeToolId::MediaTools && platform == "windows-x86_64" {
        let roles = release
            .files
            .iter()
            .filter_map(|file| file.role)
            .collect::<HashSet<_>>();
        if release.version != "8.1.2"
            || release.artifact.asset != "ffmpeg-8.1.2-essentials_build.zip"
            || !release.artifact.selective_extraction
            || roles != HashSet::from([ExecutableRole::Ffmpeg, ExecutableRole::Ffprobe])
            || release.files.len() != 4
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        return Ok(());
    }
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
        || release.files[0].role != Some(role)
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
