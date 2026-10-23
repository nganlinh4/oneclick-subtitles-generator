//! Resumable, digest-verified acquisition of one catalog asset into the store's downloads.

use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use osg_delivery_core::paths::{is_link_or_reparse, remove_regular_if_exists};
use serde::{Deserialize, Serialize};

use crate::catalog::{DeliveryAsset, PackageDelivery, is_asset_name};
use crate::path_security::require_directory;
use crate::receipt::hash_file;
use crate::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, ProgressSink, Result,
};

mod bundled;
mod http;
#[cfg(test)]
mod tests;

pub(crate) use bundled::BundledArchiveFetcher;
pub(crate) use http::HttpArchiveFetcher;

const MAX_RESUME_METADATA_BYTES: u64 = 8 * 1024;
const MAX_FETCH_ATTEMPTS_PER_URL: usize = 3;

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

/// The release a resumable download belongs to; resume state from any other owner is discarded.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DownloadOwner<'a> {
    pub component: &'a str,
    pub platform: &'a str,
    pub version: &'a str,
}

impl PackageDelivery {
    pub(crate) fn download_owner(&self) -> DownloadOwner<'_> {
        DownloadOwner {
            component: &self.component,
            platform: &self.platform,
            version: &self.version,
        }
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
        Ok(remove_regular_if_exists(&self.metadata_path)?)
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
    fn new(owner: DownloadOwner<'_>, asset: &DeliveryAsset, etag: Option<String>) -> Self {
        Self {
            schema_version: 1,
            component: owner.component.to_owned(),
            platform: owner.platform.to_owned(),
            version: owner.version.to_owned(),
            asset: asset.asset.clone(),
            size_bytes: asset.size_bytes,
            sha256: asset.sha256.clone(),
            etag,
        }
    }

    fn matches(&self, owner: DownloadOwner<'_>, asset: &DeliveryAsset) -> bool {
        self.schema_version == 1
            && self.component == owner.component
            && self.platform == owner.platform
            && self.version == owner.version
            && self.asset == asset.asset
            && self.size_bytes == asset.size_bytes
            && self.sha256 == asset.sha256
            && self.etag.as_deref().is_none_or(http::valid_etag)
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
        delivery.download_owner(),
        &asset,
        cancellation,
        progress,
    )
}

/// Downloads (or resumes) `asset` into `download_root` and verifies its size and digest.
///
/// A partial download survives cancellation and failures; the next attempt for the same owner
/// and asset continues from it with an exact byte range.
pub(crate) fn obtain_asset(
    fetcher: &dyn ArchiveFetcher,
    download_root: &Path,
    owner: DownloadOwner<'_>,
    asset: &DeliveryAsset,
    cancellation: &CancellationToken,
    progress: &dyn ProgressSink,
) -> Result<DownloadedArchive> {
    require_directory(download_root)?;
    let cache_key = cache_key(&asset.sha256, &asset.asset);
    let archive_path = download_root.join(format!("{cache_key}.partial"));
    let metadata_path = download_root.join(format!("{cache_key}.resume.json"));
    let mut metadata =
        read_resume_metadata(&metadata_path).filter(|metadata| metadata.matches(owner, asset));
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
            owner,
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
            metadata = None;
        }
        for attempt in 0..MAX_FETCH_ATTEMPTS_PER_URL {
            cancellation.check()?;
            resume_from = inspect_partial(&archive_path)?;
            let result = fetcher.fetch(
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
            match result {
                Ok(value) => {
                    etag = value;
                    last_network_error = None;
                    break;
                }
                Err(PackageError::InvalidResume) if resume_from > 0 => {
                    remove_regular_if_exists(&archive_path)?;
                    metadata = None;
                }
                Err(PackageError::Network | PackageError::IncompleteDownload) => {
                    last_network_error = Some(PackageError::Network);
                }
                Err(error) => return Err(error),
            }
            if attempt + 1 == MAX_FETCH_ATTEMPTS_PER_URL {
                break;
            }
        }
        if last_network_error.is_none() {
            break;
        }
    }
    if let Some(error) = last_network_error {
        return Err(error);
    }
    write_resume_metadata(&metadata_path, &ResumeMetadata::new(owner, asset, etag))?;
    verify_asset(&archive_path, asset, cancellation, progress)?;
    Ok(DownloadedArchive {
        path: archive_path,
        metadata_path,
    })
}

pub(crate) fn cache_key(sha256: &str, asset: &str) -> String {
    format!("{}-{asset}", &sha256[..16])
}

/// Bytes already on disk toward `asset`, or zero when nothing resumable is present.
pub(crate) fn partial_bytes(download_root: &Path, asset: &DeliveryAsset) -> u64 {
    let cache_key = cache_key(&asset.sha256, &asset.asset);
    inspect_partial(&download_root.join(format!("{cache_key}.partial")))
        .unwrap_or(0)
        .min(asset.size_bytes)
}

/// Discards any partial download and resume record for `asset`.
pub(crate) fn discard_partial(download_root: &Path, asset: &DeliveryAsset) -> Result<()> {
    let cache_key = cache_key(&asset.sha256, &asset.asset);
    remove_regular_if_exists(&download_root.join(format!("{cache_key}.partial")))?;
    Ok(remove_regular_if_exists(
        &download_root.join(format!("{cache_key}.resume.json")),
    )?)
}

/// Deletes resumable downloads whose cache key is not in `allowed`. Anything in the downloads
/// directory that is not a download or resume record fails closed and is left in place.
pub(crate) fn prune_downloads(downloads: &Path, allowed: &HashSet<String>) -> Result<()> {
    let mut obsolete = Vec::new();
    for entry in fs::read_dir(downloads).map_err(|_| PackageError::StoreUnavailable)? {
        let entry = entry.map_err(|_| PackageError::StoreUnavailable)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| PackageError::StoreUnavailable)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or(PackageError::StoreUnavailable)?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) {
            return Err(PackageError::StoreUnavailable);
        }
        let cache_key = name
            .strip_suffix(".partial")
            .or_else(|| name.strip_suffix(".resume.json"))
            .ok_or(PackageError::StoreUnavailable)?;
        let (digest, asset) = cache_key
            .split_once('-')
            .ok_or(PackageError::StoreUnavailable)?;
        if digest.len() != 16
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !is_asset_name(asset)
        {
            return Err(PackageError::StoreUnavailable);
        }
        if !allowed.contains(cache_key) {
            obsolete.push(entry.path());
        }
    }
    for path in obsolete {
        fs::remove_file(path).map_err(|_| PackageError::StoreUnavailable)?;
    }
    Ok(())
}

/// Maps one asset's download progress onto a multi-asset operation's overall byte count.
pub(crate) fn report_asset_download_progress(
    progress: &dyn ProgressSink,
    value: OperationProgress,
    completed_before: u64,
    asset_size: u64,
    total: u64,
) {
    let local_done = match value.phase {
        OperationPhase::Downloading => value.bytes_done.min(asset_size),
        OperationPhase::Verifying if value.basis_points == 10_000 => asset_size,
        _ => return,
    };
    progress.on_progress(OperationProgress::new(
        OperationPhase::Downloading,
        completed_before.saturating_add(local_done),
        total,
    ));
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
        .and_then(|()| output.sync_all())
        .map_err(|_| PackageError::StoreUnavailable)
}
