//! Exact byte-range HTTPS transfer from reviewed package origins.

use std::fs;
use std::io::Write as _;

use osg_delivery_core::http::{self, CancellableBody, USER_AGENT as USER_AGENT_VALUE};
use osg_delivery_core::url_policy::is_immutable_https;
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, RANGE, USER_AGENT};
use url::Url;

use super::{ArchiveFetcher, FetchRequest};
use crate::catalog::{DeliveryAsset, valid_delivery_url};
use crate::{OperationPhase, OperationProgress, PackageError, Result};

const MAX_ETAG_BYTES: usize = 256;
// Large runtime assets otherwise spend most of their time opening hundreds of CDN range
// requests. Each request remains bounded and exactly range-checked; reads and cancellation
// stay at 256 KiB / 100 ms granularity.
const DOWNLOAD_CHUNK_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct HttpArchiveFetcher {
    client: Client,
}

impl HttpArchiveFetcher {
    pub(crate) fn new() -> Result<Self> {
        Ok(Self {
            client: http::client(redirect_target_allowed)?,
        })
    }
}

impl ArchiveFetcher for HttpArchiveFetcher {
    fn fetch(
        &self,
        asset: &DeliveryAsset,
        declared_url: &str,
        request: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        request.cancellation.check()?;
        let parsed = Url::parse(declared_url).map_err(|_| PackageError::InvalidCatalog)?;
        if !trusted_initial_url(&parsed, declared_url, &asset.asset) {
            return Err(PackageError::InvalidCatalog);
        }
        transfer(&self.client, &parsed, asset.size_bytes, request)
    }
}

/// Appends `[resume_from, size)` to the target in exact ranges, pinning the entity tag seen
/// first so a changed upstream object can never be spliced onto earlier bytes.
pub(super) fn transfer(
    client: &Client,
    url: &Url,
    size_bytes: u64,
    request: FetchRequest<'_>,
) -> Result<Option<String>> {
    let FetchRequest {
        target,
        resume_from,
        etag,
        cancellation,
        progress,
    } = request;
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
    while total < size_bytes {
        cancellation.check()?;
        let end = total
            .saturating_add(DOWNLOAD_CHUNK_BYTES - 1)
            .min(size_bytes - 1);
        let expected_chunk = end - total + 1;
        let response = request_range(client, url, (total, end, size_bytes), &mut response_etag)?;
        let chunk_start = total;
        let mut body = CancellableBody::spawn(response)?;
        while let Some(chunk) = body.next_chunk(cancellation)? {
            total = total
                .checked_add(chunk.len() as u64)
                .filter(|value| *value <= end + 1)
                .ok_or(PackageError::StorageLimit)?;
            output
                .write_all(&chunk)
                .map_err(|_| PackageError::StoreUnavailable)?;
            progress.on_progress(OperationProgress::new(
                OperationPhase::Downloading,
                total,
                size_bytes,
            ));
        }
        if total - chunk_start != expected_chunk {
            return Err(PackageError::IncompleteDownload);
        }
    }
    if total != size_bytes {
        return Err(PackageError::IncompleteDownload);
    }
    output
        .flush()
        .and_then(|()| output.sync_all())
        .map_err(|_| PackageError::StoreUnavailable)?;
    Ok(response_etag)
}

/// Requests `[start, end]` of a `total`-byte object and accepts only an exact answer: the
/// precise range (or the whole object for a single-chunk first request), its exact length, and
/// the entity tag already pinned for this download, if any.
fn request_range(
    client: &Client,
    url: &Url,
    (start, end, total): (u64, u64, u64),
    pinned_etag: &mut Option<String>,
) -> Result<Response> {
    let mut request = client
        .get(url.clone())
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(RANGE, format!("bytes={start}-{end}"));
    if let Some(etag) = pinned_etag.as_deref() {
        request = request.header(IF_RANGE, etag);
    }
    let response = request.send().map_err(|_| PackageError::Network)?;
    let status = response.status();
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let exact_partial = status == reqwest::StatusCode::PARTIAL_CONTENT
        && valid_content_range(header(CONTENT_RANGE), start, end, total);
    let exact_whole = status == reqwest::StatusCode::OK && start == 0 && end + 1 == total;
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
    if header(CONTENT_LENGTH).and_then(|value| value.parse::<u64>().ok()) != Some(end - start + 1) {
        return Err(PackageError::IncompleteDownload);
    }
    let observed_etag = header(ETAG).filter(|value| valid_etag(value));
    match (pinned_etag.as_deref(), observed_etag) {
        (Some(expected), Some(actual)) if expected != actual => {
            return Err(PackageError::InvalidResume);
        }
        (None, Some(actual)) => *pinned_etag = Some(actual.to_owned()),
        _ => {}
    }
    Ok(response)
}

pub(super) fn trusted_initial_url(url: &Url, declared: &str, asset: &str) -> bool {
    is_immutable_https(url, declared)
        && (valid_delivery_url(declared, asset)
            || (url.host_str() == Some("github.com")
                && matches!(
                    url.path().strip_prefix("/nganlinh4/oneclick-subtitles-generator/releases/download/"),
                    Some(path) if path.starts_with("asr-engine-packs-v1/") || path.starts_with("speech-packs-v1/")
                )))
}

/// Each reviewed origin may hop only to its own download CDN.
pub(super) fn redirect_target_allowed(first: &Url, target: &Url) -> bool {
    let Some(target) = target.host_str() else {
        return false;
    };
    match first.host_str() {
        Some("github.com") => matches!(
            target,
            "github.com" | "release-assets.githubusercontent.com"
        ),
        Some("huggingface.co") => {
            matches!(
                target,
                "huggingface.co"
                    | "cdn-lfs.hf.co"
                    | "cas-bridge.xethub.hf.co"
                    | "cas-server.xethub.hf.co"
            ) || target.ends_with(".cdn.hf.co")
        }
        Some(
            origin @ ("files.pythonhosted.org"
            | "download.pytorch.org"
            | "fonts.gstatic.com"
            | "openfontlicense.org"),
        ) => target == origin,
        _ => false,
    }
}

pub(super) fn valid_content_range(
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

pub(super) fn valid_etag(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ETAG_BYTES
        && value
            .bytes()
            .all(|byte| byte >= b' ' && byte != 0x7f && byte != b'\r' && byte != b'\n')
}
