use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, RANGE, USER_AGENT};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::catalog::{DeliveryAsset, PackageDelivery, valid_delivery_url};
use crate::path_security::{is_link_or_reparse, require_directory};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt::hash_file;
use crate::{CancellationToken, PackageError, Result};

const MAX_RESUME_METADATA_BYTES: u64 = 8 * 1024;
const MAX_ETAG_BYTES: usize = 256;
const MAX_REDIRECTS: usize = 5;
// Large runtime assets otherwise spend most of their time opening hundreds of
// CDN range requests. Each request remains bounded and exactly range-checked;
// the read buffer and cancellation granularity stay at 256 KiB.
const DOWNLOAD_CHUNK_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT_VALUE: &str = "OneClickSubtitlesGenerator/2";

pub(crate) trait ArchiveFetcher: Send + Sync {
    fn fetch(
        &self,
        asset: &DeliveryAsset,
        url: &str,
        request: FetchRequest<'_>,
    ) -> Result<Option<String>>;
}

#[derive(Clone, Copy)]
pub(crate) struct FetchRequest<'a> {
    pub target: &'a Path,
    pub resume_from: u64,
    pub etag: Option<&'a str>,
    pub cancellation: &'a CancellationToken,
    pub progress: &'a dyn ProgressSink,
}

#[derive(Debug)]
pub(crate) struct HttpArchiveFetcher {
    client: Client,
}

impl HttpArchiveFetcher {
    pub(crate) fn new() -> Result<Self> {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS
                || !trusted_redirect(attempt.url(), attempt.previous())
            {
                return attempt.error("untrusted package redirect");
            }
            attempt.follow()
        });
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(DOWNLOAD_REQUEST_TIMEOUT)
            .https_only(true)
            .no_proxy()
            .redirect(policy)
            .build()
            .map_err(|_| PackageError::Network)?;
        Ok(Self { client })
    }
}

impl ArchiveFetcher for HttpArchiveFetcher {
    #[allow(clippy::too_many_lines)]
    fn fetch(
        &self,
        asset: &DeliveryAsset,
        declared_url: &str,
        request: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        let FetchRequest {
            target,
            resume_from,
            etag,
            cancellation,
            progress,
        } = request;
        cancellation.check()?;
        let parsed = Url::parse(declared_url).map_err(|_| PackageError::InvalidCatalog)?;
        if !trusted_initial_url(&parsed, declared_url, &asset.asset) {
            return Err(PackageError::InvalidCatalog);
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true);
        if resume_from > 0 {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut output = options
            .open(target)
            .map_err(|_| PackageError::StoreUnavailable)?;
        let mut total = resume_from;
        let mut response_etag = etag.filter(|value| valid_etag(value)).map(str::to_owned);
        let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
        while total < asset.size_bytes {
            cancellation.check()?;
            let end = total
                .saturating_add(DOWNLOAD_CHUNK_BYTES - 1)
                .min(asset.size_bytes - 1);
            let expected_chunk = end - total + 1;
            let mut request = self
                .client
                .get(parsed.clone())
                .header(USER_AGENT, USER_AGENT_VALUE)
                .header(RANGE, format!("bytes={total}-{end}"));
            if let Some(etag) = response_etag.as_deref() {
                request = request.header(IF_RANGE, etag);
            }
            let mut response = request.send().map_err(|_| PackageError::Network)?;
            let status = response.status();
            let exact_partial = status == reqwest::StatusCode::PARTIAL_CONTENT
                && valid_content_range(
                    response
                        .headers()
                        .get(CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok()),
                    total,
                    end,
                    asset.size_bytes,
                );
            let exact_whole =
                status == reqwest::StatusCode::OK && total == 0 && end + 1 == asset.size_bytes;
            if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
                return Err(PackageError::InvalidResume);
            }
            if !exact_partial && !exact_whole {
                return Err(if status.is_success() {
                    PackageError::InvalidResume
                } else {
                    PackageError::Network
                });
            }
            let content_length = response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            if content_length != Some(expected_chunk) {
                return Err(PackageError::IncompleteDownload);
            }
            let observed_etag = response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .filter(|value| valid_etag(value));
            if response_etag
                .as_deref()
                .zip(observed_etag)
                .is_some_and(|(expected, actual)| expected != actual)
            {
                return Err(PackageError::InvalidResume);
            }
            if response_etag.is_none() {
                response_etag = observed_etag.map(str::to_owned);
            }

            let chunk_start = total;
            loop {
                cancellation.check()?;
                let read = response
                    .read(&mut buffer)
                    .map_err(|_| PackageError::Network)?;
                if read == 0 {
                    break;
                }
                total = total
                    .checked_add(read as u64)
                    .filter(|value| *value <= end + 1)
                    .ok_or(PackageError::StorageLimit)?;
                output
                    .write_all(&buffer[..read])
                    .map_err(|_| PackageError::StoreUnavailable)?;
                progress.on_progress(OperationProgress::new(
                    OperationPhase::Downloading,
                    total,
                    asset.size_bytes,
                ));
            }
            if total - chunk_start != expected_chunk {
                return Err(PackageError::IncompleteDownload);
            }
        }
        if total != asset.size_bytes {
            return Err(PackageError::IncompleteDownload);
        }
        output.flush().map_err(|_| PackageError::StoreUnavailable)?;
        output
            .sync_all()
            .map_err(|_| PackageError::StoreUnavailable)?;
        Ok(response_etag)
    }
}

#[derive(Debug)]
pub(crate) struct DownloadedArchive {
    pub path: PathBuf,
    metadata_path: PathBuf,
}

impl DownloadedArchive {
    pub(crate) fn remove_after_success(&self) -> Result<()> {
        remove_regular_if_exists(&self.path)?;
        remove_regular_if_exists(&self.metadata_path)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResumeMetadata {
    schema_version: u32,
    component: String,
    platform: String,
    version: String,
    asset: String,
    size_bytes: u64,
    sha256: String,
    etag: Option<String>,
}

impl ResumeMetadata {
    fn new(delivery: &PackageDelivery, asset: &DeliveryAsset, etag: Option<String>) -> Self {
        Self {
            schema_version: 1,
            component: delivery.component.clone(),
            platform: delivery.platform.clone(),
            version: delivery.version.clone(),
            asset: asset.asset.clone(),
            size_bytes: asset.size_bytes,
            sha256: asset.sha256.clone(),
            etag,
        }
    }

    fn matches(&self, delivery: &PackageDelivery, asset: &DeliveryAsset) -> bool {
        self.schema_version == 1
            && self.component == delivery.component
            && self.platform == delivery.platform
            && self.version == delivery.version
            && self.asset == asset.asset
            && self.size_bytes == asset.size_bytes
            && self.sha256 == asset.sha256
            && self.etag.as_deref().is_none_or(valid_etag)
    }
}

pub(crate) fn obtain(
    fetcher: &dyn ArchiveFetcher,
    download_root: &Path,
    delivery: &PackageDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<DownloadedArchive> {
    let asset = DeliveryAsset {
        asset: delivery.asset.clone(),
        urls: vec![delivery.download_url().to_string()],
        size_bytes: delivery.size_bytes,
        sha256: delivery.sha256.clone(),
    };
    obtain_asset(
        fetcher,
        download_root,
        delivery,
        &asset,
        cancellation,
        progress,
    )
}

pub(crate) fn obtain_asset(
    fetcher: &dyn ArchiveFetcher,
    download_root: &Path,
    delivery: &PackageDelivery,
    asset: &DeliveryAsset,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<DownloadedArchive> {
    require_directory(download_root)?;
    let cache_key = cache_key(&asset.sha256, &asset.asset);
    let archive_path = download_root.join(format!("{cache_key}.partial"));
    let metadata_path = download_root.join(format!("{cache_key}.resume.json"));
    let mut metadata =
        read_resume_metadata(&metadata_path).filter(|metadata| metadata.matches(delivery, asset));
    let mut resume_from = inspect_partial(&archive_path)?;
    if metadata.is_none() || resume_from > asset.size_bytes {
        remove_regular_if_exists(&archive_path)?;
        remove_regular_if_exists(&metadata_path)?;
        resume_from = 0;
        metadata = None;
    }

    if resume_from == asset.size_bytes && resume_from > 0 {
        verify_asset(&archive_path, asset, cancellation, progress)?;
        return Ok(DownloadedArchive {
            path: archive_path,
            metadata_path,
        });
    }

    write_resume_metadata(
        &metadata_path,
        &ResumeMetadata::new(
            delivery,
            asset,
            metadata.as_ref().and_then(|value| value.etag.clone()),
        ),
    )?;
    let mut last_network_error = None;
    let mut etag = None;
    for (index, url) in asset.urls.iter().enumerate() {
        if index > 0 {
            remove_regular_if_exists(&archive_path)?;
            remove_regular_if_exists(&metadata_path)?;
            resume_from = 0;
            metadata = None;
        }
        let fetch_result = fetcher.fetch(
            asset,
            url,
            FetchRequest {
                target: &archive_path,
                resume_from,
                etag: metadata.as_ref().and_then(|value| value.etag.as_deref()),
                cancellation,
                progress,
            },
        );
        let result = match fetch_result {
            Err(PackageError::InvalidResume) if resume_from > 0 => {
                remove_regular_if_exists(&archive_path)?;
                fetcher.fetch(
                    asset,
                    url,
                    FetchRequest {
                        target: &archive_path,
                        resume_from: 0,
                        etag: None,
                        cancellation,
                        progress,
                    },
                )
            }
            other => other,
        };
        match result {
            Ok(value) => {
                etag = value;
                last_network_error = None;
                break;
            }
            Err(PackageError::Network | PackageError::IncompleteDownload) => {
                last_network_error = Some(PackageError::Network);
            }
            Err(error) => return Err(error),
        }
    }
    if let Some(error) = last_network_error {
        return Err(error);
    }
    write_resume_metadata(&metadata_path, &ResumeMetadata::new(delivery, asset, etag))?;
    verify_asset(&archive_path, asset, cancellation, progress)?;
    Ok(DownloadedArchive {
        path: archive_path,
        metadata_path,
    })
}

pub(crate) fn cache_key(sha256: &str, asset: &str) -> String {
    format!("{}-{asset}", &sha256[..16])
}

fn verify_asset(
    archive_path: &Path,
    asset: &DeliveryAsset,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let size = inspect_partial(archive_path).map_err(|_| PackageError::ArchiveIntegrity)?;
    if size != asset.size_bytes {
        return Err(PackageError::IncompleteDownload);
    }
    progress.on_progress(OperationProgress::new(
        OperationPhase::Verifying,
        0,
        asset.size_bytes,
    ));
    let digest = hash_file(archive_path, cancellation).map_err(|error| match error {
        PackageError::Cancelled => PackageError::Cancelled,
        _ => PackageError::ArchiveIntegrity,
    })?;
    if digest != asset.sha256 {
        remove_regular_if_exists(archive_path)?;
        return Err(PackageError::ArchiveIntegrity);
    }
    progress.on_progress(OperationProgress::new(
        OperationPhase::Verifying,
        asset.size_bytes,
        asset.size_bytes,
    ));
    Ok(())
}

fn inspect_partial(path: &Path) -> Result<u64> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_link_or_reparse(&metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Ok(_) | Err(_) => Err(PackageError::StoreUnavailable),
    }
}

fn read_resume_metadata(path: &Path) -> Option<ResumeMetadata> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || metadata.len() == 0
        || metadata.len() > MAX_RESUME_METADATA_BYTES
    {
        return None;
    }
    let encoded = fs::read(path).ok()?;
    serde_json::from_slice(&encoded).ok()
}

fn write_resume_metadata(path: &Path, metadata: &ResumeMetadata) -> Result<()> {
    if let Ok(existing) = fs::symlink_metadata(path)
        && (!existing.is_file() || is_link_or_reparse(&existing))
    {
        return Err(PackageError::StoreUnavailable);
    }
    let encoded = serde_json::to_vec(metadata).map_err(|_| PackageError::StoreUnavailable)?;
    if encoded.len() as u64 > MAX_RESUME_METADATA_BYTES {
        return Err(PackageError::StoreUnavailable);
    }
    let mut output = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|_| PackageError::StoreUnavailable)?;
    output
        .write_all(&encoded)
        .map_err(|_| PackageError::StoreUnavailable)?;
    output
        .sync_all()
        .map_err(|_| PackageError::StoreUnavailable)
}

fn remove_regular_if_exists(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_link_or_reparse(&metadata) => {
            fs::remove_file(path).map_err(|_| PackageError::StoreUnavailable)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) | Err(_) => Err(PackageError::StoreUnavailable),
    }
}

fn trusted_initial_url(url: &Url, declared: &str, asset: &str) -> bool {
    url.as_str() == declared
        && (valid_delivery_url(declared, asset)
            || (url.host_str() == Some("github.com")
                && matches!(
                    url.path().strip_prefix("/nganlinh4/oneclick-subtitles-generator/releases/download/"),
                    Some(path) if path.starts_with("asr-engine-packs-v1/") || path.starts_with("speech-packs-v1/")
                )))
}

fn trusted_redirect(url: &Url, previous: &[Url]) -> bool {
    let Some(first) = previous.first() else {
        return false;
    };
    let initial_ok = first.scheme() == "https"
        && matches!(
            first.host_str(),
            Some(
                "github.com"
                    | "huggingface.co"
                    | "files.pythonhosted.org"
                    | "download.pytorch.org"
                    | "fonts.gstatic.com"
                    | "openfontlicense.org"
            )
        );
    let host_ok = url.host_str().is_some_and(|host| {
        matches!(
            host,
            "github.com"
                | "release-assets.githubusercontent.com"
                | "huggingface.co"
                | "cdn-lfs.hf.co"
                | "cas-bridge.xethub.hf.co"
                | "cas-server.xethub.hf.co"
                | "files.pythonhosted.org"
                | "download.pytorch.org"
                | "fonts.gstatic.com"
                | "openfontlicense.org"
        ) || host.ends_with(".cdn.hf.co")
    });
    initial_ok
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
        && host_ok
}

fn valid_content_range(
    value: Option<&str>,
    expected_start: u64,
    expected_end: u64,
    expected_total: u64,
) -> bool {
    let Some(value) = value.and_then(|value| value.strip_prefix("bytes ")) else {
        return false;
    };
    let Some((range, total)) = value.split_once('/') else {
        return false;
    };
    let Some((start, end)) = range.split_once('-') else {
        return false;
    };
    let (Ok(start), Ok(end), Ok(total)) = (
        start.parse::<u64>(),
        end.parse::<u64>(),
        total.parse::<u64>(),
    ) else {
        return false;
    };
    start == expected_start && total == expected_total && end == expected_end && start <= end
}

fn valid_etag(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ETAG_BYTES
        && value
            .bytes()
            .all(|byte| byte >= b' ' && byte != 0x7f && byte != b'\r' && byte != b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_download_cleanup_removes_payload_and_resume_metadata() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("asset.partial");
        let metadata_path = root.path().join("asset.resume.json");
        fs::write(&path, b"payload").unwrap();
        fs::write(&metadata_path, b"metadata").unwrap();
        let downloaded = DownloadedArchive {
            path: path.clone(),
            metadata_path: metadata_path.clone(),
        };
        downloaded.remove_after_success().unwrap();
        assert!(!path.exists());
        assert!(!metadata_path.exists());
        downloaded.remove_after_success().unwrap();
    }

    #[test]
    fn content_range_requires_the_exact_remaining_archive() {
        assert!(valid_content_range(Some("bytes 10-19/100"), 10, 19, 100));
        assert!(!valid_content_range(Some("bytes 9-19/100"), 10, 19, 100));
        assert!(!valid_content_range(Some("bytes 10-20/100"), 10, 19, 100));
        assert!(!valid_content_range(Some("bytes */100"), 10, 19, 100));
    }

    #[test]
    fn redirect_policy_rejects_http_credentials_and_foreign_hosts() {
        let initial = Url::parse(
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/asr-engine-packs-v1/pack.zip",
        )
        .unwrap();
        let release =
            Url::parse("https://release-assets.githubusercontent.com/asset?token=x").unwrap();
        assert!(trusted_redirect(&release, std::slice::from_ref(&initial)));
        assert!(!trusted_redirect(
            &Url::parse("https://example.com/asset").unwrap(),
            std::slice::from_ref(&initial)
        ));
        assert!(!trusted_redirect(
            &Url::parse("http://release-assets.githubusercontent.com/asset").unwrap(),
            &[initial]
        ));

        let hugging_face = Url::parse(
            "https://huggingface.co/Qwen/Qwen3-ASR-0.6B/resolve/revision/model.safetensors",
        )
        .unwrap();
        assert!(trusted_redirect(
            &Url::parse("https://us.aws.cdn.hf.co/xet-bridge-us/model?token=x").unwrap(),
            std::slice::from_ref(&hugging_face)
        ));
        assert!(!trusted_redirect(
            &Url::parse("https://cdn.hf.co.example.com/model").unwrap(),
            &[hugging_face]
        ));
    }
}
