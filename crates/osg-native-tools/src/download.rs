use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{CONTENT_LENGTH, USER_AGENT};
use url::Url;

use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt::hash_file;
use crate::{CancellationToken, NativeToolError, Result};

const MAX_REDIRECTS: usize = 5;
const USER_AGENT_VALUE: &str = "OneClickSubtitlesGenerator/2";

#[derive(Clone, Copy, Debug)]
pub(crate) struct RemoteFile<'a> {
    pub url: &'a str,
    pub size_bytes: u64,
    pub sha256: &'a str,
}

pub(crate) trait FileFetcher: Send + Sync {
    fn fetch(
        &self,
        remote: RemoteFile<'_>,
        target: &Path,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<()>;
}

#[derive(Debug)]
pub(crate) struct HttpFileFetcher {
    client: Client,
}

impl HttpFileFetcher {
    pub(crate) fn new() -> Result<Self> {
        let redirect = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS
                || !trusted_redirect(attempt.url(), attempt.previous())
            {
                return attempt.error("untrusted native-tool redirect");
            }
            attempt.follow()
        });
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_mins(15))
            .https_only(true)
            .no_proxy()
            .redirect(redirect)
            .build()
            .map_err(|_| NativeToolError::Network)?;
        Ok(Self { client })
    }
}

impl FileFetcher for HttpFileFetcher {
    fn fetch(
        &self,
        remote: RemoteFile<'_>,
        target: &Path,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<()> {
        cancellation.check()?;
        let url = Url::parse(remote.url).map_err(|_| NativeToolError::InvalidCatalog)?;
        if !trusted_initial_url(&url, remote.url) {
            return Err(NativeToolError::InvalidCatalog);
        }
        let mut response = self
            .client
            .get(url)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .send()
            .map_err(|_| NativeToolError::Network)?;
        if !response.status().is_success() {
            return Err(NativeToolError::Network);
        }
        let content_length = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        if content_length != Some(remote.size_bytes) {
            return Err(NativeToolError::IncompleteDownload);
        }
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        let mut written = 0_u64;
        let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
        loop {
            cancellation.check()?;
            let read = response
                .read(&mut buffer)
                .map_err(|_| NativeToolError::Network)?;
            if read == 0 {
                break;
            }
            written = written
                .checked_add(read as u64)
                .filter(|bytes| *bytes <= remote.size_bytes)
                .ok_or(NativeToolError::StorageLimit)?;
            output
                .write_all(&buffer[..read])
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            progress.on_progress(OperationProgress::new(
                OperationPhase::Downloading,
                written,
                remote.size_bytes,
            ));
        }
        output
            .sync_all()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        if written != remote.size_bytes {
            return Err(NativeToolError::IncompleteDownload);
        }
        progress.on_progress(OperationProgress::new(
            OperationPhase::Verifying,
            0,
            remote.size_bytes,
        ));
        if hash_file(target, cancellation)? != remote.sha256 {
            return Err(NativeToolError::Integrity);
        }
        progress.on_progress(OperationProgress::new(
            OperationPhase::Verifying,
            remote.size_bytes,
            remote.size_bytes,
        ));
        Ok(())
    }
}

fn trusted_initial_url(url: &Url, declared: &str) -> bool {
    url.as_str() == declared
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.query().is_none()
        && url.fragment().is_none()
        && match url.host_str() {
            Some("github.com") => valid_github_release_path(url.path()),
            Some("raw.githubusercontent.com") => valid_raw_path(url.path()),
            _ => false,
        }
}

fn trusted_redirect(url: &Url, previous: &[Url]) -> bool {
    let Some(first) = previous.first() else {
        return false;
    };
    let first_ok = match first.host_str() {
        Some("github.com") => valid_github_release_path(first.path()),
        Some("raw.githubusercontent.com") => valid_raw_path(first.path()),
        _ => false,
    };
    let target_ok = matches!(
        (first.host_str(), url.host_str()),
        (
            Some("github.com"),
            Some("github.com" | "release-assets.githubusercontent.com")
        ) | (
            Some("raw.githubusercontent.com"),
            Some("raw.githubusercontent.com")
        )
    );
    first_ok
        && target_ok
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
}

fn valid_github_release_path(path: &str) -> bool {
    let known_prefix = path.starts_with("/yt-dlp/yt-dlp/releases/download/2026.07.04/")
        || path.starts_with("/denoland/deno/releases/download/v2.9.5/");
    known_prefix && !path.to_ascii_lowercase().contains("/latest/")
}

fn valid_raw_path(path: &str) -> bool {
    let segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() < 4 || segments[2].len() != 40 {
        return false;
    }
    let repository_ok = matches!(
        (segments[0], segments[1]),
        ("yt-dlp", "yt-dlp") | ("denoland", "deno")
    );
    repository_ok
        && segments[2]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutable_foreign_and_credentialed_urls_are_rejected() {
        for invalid in [
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
            "https://example.com/yt-dlp.exe",
            "https://user:pass@github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
        ] {
            let url = Url::parse(invalid).unwrap();
            assert!(!trusted_initial_url(&url, invalid), "{invalid}");
        }
    }

    #[test]
    fn only_release_asset_redirects_are_accepted() {
        let initial =
            Url::parse("https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe")
                .unwrap();
        assert!(trusted_redirect(
            &Url::parse("https://release-assets.githubusercontent.com/object?token=x").unwrap(),
            std::slice::from_ref(&initial),
        ));
        assert!(!trusted_redirect(
            &Url::parse("https://example.com/object").unwrap(),
            &[initial],
        ));
    }
}
