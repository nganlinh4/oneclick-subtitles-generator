use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use crate::catalog::{
    ArtifactFormat, DeliveryFile, ExecutableRole, NoticeFile, ToolDelivery, valid_ytdlp_version,
    validate_dynamic_ytdlp_delivery,
};
use crate::path_security::{ensure_direct_child, require_regular_file};
use crate::{NativeToolError, Result};

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const COMMITS_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/commits/";
const USER_AGENT_VALUE: &str = "OneClickSubtitlesGenerator/2";
const MAX_API_BYTES: u64 = 2 * 1024 * 1024;
const MAX_NOTICE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 1024 * 1024;
const RECORD_SCHEMA_VERSION: u32 = 1;
const MAX_RECORDS: usize = 64;

pub(crate) trait YtDlpReleaseResolver: Send + Sync {
    fn latest(&self, platform: &str) -> Result<ToolDelivery>;
}

#[derive(Debug)]
pub(crate) struct GitHubYtDlpReleaseResolver {
    client: Client,
}

impl GitHubYtDlpReleaseResolver {
    pub(crate) fn new() -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_mins(2))
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| NativeToolError::Network)?;
        Ok(Self { client })
    }

    fn get_bounded(&self, url: &str, maximum: u64) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .header(ACCEPT, "application/vnd.github+json")
            .header(USER_AGENT, USER_AGENT_VALUE)
            .send()
            .map_err(|_| NativeToolError::Network)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length == 0 || length > maximum)
        {
            return Err(NativeToolError::Network);
        }
        let mut bytes = Vec::new();
        response
            .take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| NativeToolError::Network)?;
        if bytes.is_empty() || bytes.len() as u64 > maximum {
            return Err(NativeToolError::Network);
        }
        Ok(bytes)
    }

    fn resolve_release(&self, platform: &str) -> Result<ResolvedAsset> {
        let release_bytes = self.get_bounded(RELEASE_API, MAX_API_BYTES)?;
        let release: GitHubRelease =
            serde_json::from_slice(&release_bytes).map_err(|_| NativeToolError::Network)?;
        if release.draft
            || release.prerelease
            || !release.immutable
            || !valid_ytdlp_version(&release.tag_name)
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        let name = asset_name(platform)?;
        let mut matching = release.assets.iter().filter(|asset| asset.name == name);
        let asset = matching.next().ok_or(NativeToolError::InvalidCatalog)?;
        if matching.next().is_some()
            || asset.state != "uploaded"
            || asset.size == 0
            || asset.size > crate::catalog::MAX_ARTIFACT_BYTES
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        let url = format!(
            "https://github.com/yt-dlp/yt-dlp/releases/download/{}/{name}",
            release.tag_name
        );
        let sha256 = asset
            .digest
            .strip_prefix("sha256:")
            .filter(|value| valid_sha256(value))
            .ok_or(NativeToolError::InvalidCatalog)?;
        if asset.browser_download_url != url {
            return Err(NativeToolError::InvalidCatalog);
        }
        Ok(ResolvedAsset {
            version: release.tag_name,
            name,
            url,
            size_bytes: asset.size,
            sha256: sha256.to_string(),
        })
    }

    fn resolve_commit(&self, version: &str) -> Result<String> {
        let bytes = self.get_bounded(&format!("{COMMITS_API}{version}"), MAX_API_BYTES)?;
        let commit: GitHubCommit =
            serde_json::from_slice(&bytes).map_err(|_| NativeToolError::Network)?;
        if commit.sha.len() != 40
            || !commit
                .sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        Ok(commit.sha)
    }

    fn resolve_notices(&self, revision: &str) -> Result<Vec<NoticeFile>> {
        [
            ("licenses/yt-dlp-LICENSE.txt", "LICENSE"),
            (
                "licenses/yt-dlp-THIRD-PARTY.txt",
                "THIRD_PARTY_LICENSES.txt",
            ),
        ]
        .into_iter()
        .map(|(install_path, source_path)| {
            let source_url =
                format!("https://raw.githubusercontent.com/yt-dlp/yt-dlp/{revision}/{source_path}");
            let bytes = self.get_bounded(&source_url, MAX_NOTICE_BYTES)?;
            Ok(NoticeFile {
                install_path: install_path.to_string(),
                source_url,
                size_bytes: bytes.len() as u64,
                sha256: digest(&bytes),
            })
        })
        .collect()
    }
}

impl YtDlpReleaseResolver for GitHubYtDlpReleaseResolver {
    fn latest(&self, platform: &str) -> Result<ToolDelivery> {
        let asset = self.resolve_release(platform)?;
        let source_revision = self.resolve_commit(&asset.version)?;
        let notices = self.resolve_notices(&source_revision)?;
        let install_path = if platform == "windows-x86_64" {
            "bin/yt-dlp.exe"
        } else {
            "bin/yt-dlp"
        };
        let installed_bytes = notices.iter().try_fold(asset.size_bytes, |total, notice| {
            total
                .checked_add(notice.size_bytes)
                .ok_or(NativeToolError::InvalidCatalog)
        })?;
        let delivery = ToolDelivery {
            tool: crate::NativeToolId::YtDlp,
            platform: platform.to_string(),
            version: asset.version,
            source_revision,
            asset: asset.name.to_string(),
            source_url: asset.url,
            format: ArtifactFormat::Raw,
            selective_extraction: false,
            size_bytes: asset.size_bytes,
            sha256: asset.sha256.clone(),
            files: vec![DeliveryFile {
                source_path: asset.name.to_string(),
                install_path: install_path.to_string(),
                size_bytes: asset.size_bytes,
                sha256: asset.sha256,
                role: Some(ExecutableRole::YtDlp),
            }],
            notices,
            installed_bytes,
        };
        validate_dynamic_ytdlp_delivery(&delivery)?;
        Ok(delivery)
    }
}

#[derive(Debug)]
struct ResolvedAsset {
    version: String,
    name: &'static str,
    url: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    immutable: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    state: String,
    size: u64,
    digest: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DynamicRecord {
    schema_version: u32,
    github_immutable_release: bool,
    delivery: ToolDelivery,
}

pub(crate) fn load_installed(root: &Path, platform: &str) -> Result<Vec<ToolDelivery>> {
    let records = dynamic_records_root(root)?;
    let mut paths = fs::read_dir(records)
        .map_err(|_| NativeToolError::StoreUnavailable)?
        .take(MAX_RECORDS + 1)
        .map(|entry| entry.map(|value| value.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    if paths.len() > MAX_RECORDS {
        return Err(NativeToolError::StoreUnavailable);
    }
    paths.sort();
    let mut deliveries = Vec::new();
    for path in paths {
        let Some(record) = read_record(&path).ok() else {
            continue;
        };
        if record.github_immutable_release
            && record.delivery.platform == platform
            && validate_dynamic_ytdlp_delivery(&record.delivery).is_ok()
        {
            deliveries.push(record.delivery);
        }
    }
    deliveries.sort_by(|left, right| right.version.cmp(&left.version));
    deliveries.dedup_by(|left, right| left.version == right.version);
    Ok(deliveries)
}

pub(crate) fn persist(root: &Path, delivery: &ToolDelivery) -> Result<()> {
    validate_dynamic_ytdlp_delivery(delivery)?;
    let records = dynamic_records_root(root)?;
    let target = records.join(format!("{}.json", delivery.version));
    if target.exists() {
        let existing = read_record(&target)?;
        if existing.delivery == *delivery && existing.github_immutable_release {
            return Ok(());
        }
        return Err(NativeToolError::InvalidInstall);
    }
    let encoded = serde_json::to_vec(&DynamicRecord {
        schema_version: RECORD_SCHEMA_VERSION,
        github_immutable_release: true,
        delivery: delivery.clone(),
    })
    .map_err(|_| NativeToolError::InvalidCatalog)?;
    if encoded.is_empty() || encoded.len() as u64 > MAX_RECORD_BYTES {
        return Err(NativeToolError::InvalidCatalog);
    }
    let temporary = records.join(format!(".{}.{}.tmp", delivery.version, Uuid::now_v7()));
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    let result = output
        .write_all(&encoded)
        .and_then(|()| output.sync_all())
        .and_then(|()| fs::rename(&temporary, &target));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(NativeToolError::StoreUnavailable);
    }
    Ok(())
}

pub(crate) fn remove_persisted(root: &Path, delivery: &ToolDelivery) -> Result<()> {
    validate_dynamic_ytdlp_delivery(delivery)?;
    let target = dynamic_records_root(root)?.join(format!("{}.json", delivery.version));
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(_) => {}
        Err(_) => return Err(NativeToolError::StoreUnavailable),
    }
    let existing = read_record(&target)?;
    if !existing.github_immutable_release || existing.delivery != *delivery {
        return Err(NativeToolError::InvalidInstall);
    }
    fs::remove_file(target).map_err(|_| NativeToolError::StoreUnavailable)
}

fn read_record(path: &Path) -> Result<DynamicRecord> {
    let metadata = require_regular_file(path)?;
    if metadata.len() == 0 || metadata.len() > MAX_RECORD_BYTES {
        return Err(NativeToolError::InvalidCatalog);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| NativeToolError::InvalidCatalog)?,
    );
    fs::File::open(path)
        .map_err(|_| NativeToolError::StoreUnavailable)?
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(NativeToolError::InvalidCatalog);
    }
    let record: DynamicRecord =
        serde_json::from_slice(&bytes).map_err(|_| NativeToolError::InvalidCatalog)?;
    if record.schema_version != RECORD_SCHEMA_VERSION {
        return Err(NativeToolError::InvalidCatalog);
    }
    Ok(record)
}

fn dynamic_records_root(root: &Path) -> Result<PathBuf> {
    let tools = ensure_direct_child(root, "tools")?;
    let ytdlp = ensure_direct_child(&tools, "yt-dlp")?;
    ensure_direct_child(&ytdlp, "deliveries")
}

fn asset_name(platform: &str) -> Result<&'static str> {
    match platform {
        "windows-x86_64" => Ok("yt-dlp.exe"),
        "linux-x86_64" => Ok("yt-dlp_linux"),
        "macos-aarch64" | "macos-x86_64" => Ok("yt-dlp_macos"),
        _ => Err(NativeToolError::DeliveryUnavailable),
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mutable_duplicate_and_malformed_latest_releases() {
        let release = GitHubRelease {
            tag_name: "2026.08.10".to_string(),
            draft: false,
            prerelease: false,
            immutable: false,
            assets: vec![],
        };
        assert!(!release.immutable);
        assert!(valid_ytdlp_version(&release.tag_name));
        for invalid in ["latest", "2026.8.10", "2026.13.01", "2026.08.10/nightly"] {
            assert!(!valid_ytdlp_version(invalid), "{invalid}");
        }
    }

    #[test]
    #[ignore = "performs a live GitHub immutable-release and notice audit"]
    fn live_latest_release_resolves_to_a_strict_delivery() {
        let resolver = GitHubYtDlpReleaseResolver::new().unwrap();
        let delivery = resolver.latest(crate::catalog::current_platform()).unwrap();
        validate_dynamic_ytdlp_delivery(&delivery).unwrap();
        assert_eq!(delivery.tool, crate::NativeToolId::YtDlp);
    }
}
