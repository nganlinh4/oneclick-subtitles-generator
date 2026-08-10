use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, RANGE, USER_AGENT};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::catalog::PackageDelivery;
use crate::path_security::{is_link_or_reparse, require_directory};
use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt::hash_file;
use crate::{CancellationToken, PackageError, Result};

const MAX_RESUME_METADATA_BYTES: u64 = 8 * 1024;
const MAX_ETAG_BYTES: usize = 256;
const MAX_REDIRECTS: usize = 5;
const DOWNLOAD_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT_VALUE: &str = "OneClickSubtitlesGenerator/2";

pub(crate) trait ArchiveFetcher: Send + Sync {
    fn fetch(
        &self,
        delivery: &PackageDelivery,
        target: &Path,
        resume_from: u64,
        etag: Option<&str>,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<Option<String>>;
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
        delivery: &PackageDelivery,
        target: &Path,
        resume_from: u64,
        etag: Option<&str>,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<Option<String>> {
        cancellation.check()?;
        let parsed =
            Url::parse(delivery.download_url()).map_err(|_| PackageError::InvalidCatalog)?;
        if !trusted_initial_url(&parsed, delivery.download_url(), &delivery.asset) {
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
        while total < delivery.size_bytes {
            cancellation.check()?;
            let end = total
                .saturating_add(DOWNLOAD_CHUNK_BYTES - 1)
                .min(delivery.size_bytes - 1);
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
                    delivery.size_bytes,
                );
            let exact_whole =
                status == reqwest::StatusCode::OK && total == 0 && end + 1 == delivery.size_bytes;
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
                    delivery.size_bytes,
                ));
            }
            if total - chunk_start != expected_chunk {
                return Err(PackageError::IncompleteDownload);
            }
        }
        if total != delivery.size_bytes {
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
    pub(crate) fn remove_after_success(self) -> Result<()> {
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
    fn new(delivery: &PackageDelivery, etag: Option<String>) -> Self {
        Self {
            schema_version: 1,
            component: delivery.component.clone(),
            platform: delivery.platform.clone(),
            version: delivery.version.clone(),
            asset: delivery.asset.clone(),
            size_bytes: delivery.size_bytes,
            sha256: delivery.sha256.clone(),
            etag,
        }
    }

    fn matches(&self, delivery: &PackageDelivery) -> bool {
        self.schema_version == 1
            && self.component == delivery.component
            && self.platform == delivery.platform
            && self.version == delivery.version
            && self.asset == delivery.asset
            && self.size_bytes == delivery.size_bytes
            && self.sha256 == delivery.sha256
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
    require_directory(download_root)?;
    let archive_path = download_root.join(format!("{}.partial", delivery.asset));
    let metadata_path = download_root.join(format!("{}.resume.json", delivery.asset));
    let mut metadata =
        read_resume_metadata(&metadata_path).filter(|metadata| metadata.matches(delivery));
    let mut resume_from = inspect_partial(&archive_path)?;
    if metadata.is_none() || resume_from > delivery.size_bytes {
        remove_regular_if_exists(&archive_path)?;
        remove_regular_if_exists(&metadata_path)?;
        resume_from = 0;
        metadata = None;
    }

    if resume_from == delivery.size_bytes && resume_from > 0 {
        verify_archive(&archive_path, delivery, cancellation, progress)?;
        return Ok(DownloadedArchive {
            path: archive_path,
            metadata_path,
        });
    }

    write_resume_metadata(
        &metadata_path,
        &ResumeMetadata::new(
            delivery,
            metadata.as_ref().and_then(|value| value.etag.clone()),
        ),
    )?;
    let fetch_result = fetcher.fetch(
        delivery,
        &archive_path,
        resume_from,
        metadata.as_ref().and_then(|value| value.etag.as_deref()),
        cancellation,
        progress,
    );
    let etag = match fetch_result {
        Err(PackageError::InvalidResume) if resume_from > 0 => {
            remove_regular_if_exists(&archive_path)?;
            fetcher.fetch(delivery, &archive_path, 0, None, cancellation, progress)?
        }
        other => other?,
    };
    write_resume_metadata(&metadata_path, &ResumeMetadata::new(delivery, etag))?;
    verify_archive(&archive_path, delivery, cancellation, progress)?;
    Ok(DownloadedArchive {
        path: archive_path,
        metadata_path,
    })
}

fn verify_archive(
    archive_path: &Path,
    delivery: &PackageDelivery,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let size = inspect_partial(archive_path).map_err(|_| PackageError::ArchiveIntegrity)?;
    if size != delivery.size_bytes {
        return Err(PackageError::IncompleteDownload);
    }
    progress.on_progress(OperationProgress::new(
        OperationPhase::Verifying,
        0,
        delivery.size_bytes,
    ));
    let digest = hash_file(archive_path, cancellation).map_err(|error| match error {
        PackageError::Cancelled => PackageError::Cancelled,
        _ => PackageError::ArchiveIntegrity,
    })?;
    if digest != delivery.sha256 {
        remove_regular_if_exists(archive_path)?;
        return Err(PackageError::ArchiveIntegrity);
    }
    progress.on_progress(OperationProgress::new(
        OperationPhase::Verifying,
        delivery.size_bytes,
        delivery.size_bytes,
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
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().ends_with(&format!("/{asset}"))
        && url.as_str() == declared
        && matches!(
            url.path().strip_prefix("/nganlinh4/oneclick-subtitles-generator/releases/download/"),
            Some(path) if path.starts_with("asr-engine-packs-v1/") || path.starts_with("speech-packs-v1/")
        )
}

fn trusted_redirect(url: &Url, previous: &[Url]) -> bool {
    let Some(first) = previous.first() else {
        return false;
    };
    let initial_path = first.path();
    let initial_ok = first.scheme() == "https"
        && first.host_str() == Some("github.com")
        && matches!(
            initial_path.strip_prefix(
                "/nganlinh4/oneclick-subtitles-generator/releases/download/"
            ),
            Some(path) if path.starts_with("asr-engine-packs-v1/") || path.starts_with("speech-packs-v1/")
        );
    let host_ok = matches!(
        url.host_str(),
        Some("github.com" | "release-assets.githubusercontent.com")
    );
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
    }
}
