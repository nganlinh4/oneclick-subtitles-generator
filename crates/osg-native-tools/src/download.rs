use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_LENGTH, RETRY_AFTER, USER_AGENT};
use url::Url;

use crate::progress::{OperationPhase, OperationProgress, ProgressSink};
use crate::receipt::hash_file;
use crate::{CancellationToken, NativeToolError, Result};

const MAX_REDIRECTS: usize = 5;
const USER_AGENT_VALUE: &str = "OneClickSubtitlesGenerator/2";
const HEADER_ATTEMPTS: u32 = 4;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(15);

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
            .timeout(DOWNLOAD_TIMEOUT)
            .https_only(true)
            .no_proxy()
            .redirect(redirect)
            .build()
            .map_err(|_| NativeToolError::Network)?;
        Ok(Self { client })
    }

    fn response(&self, url: &Url, cancellation: &CancellationToken) -> Result<Response> {
        let deadline = std::time::Instant::now() + DOWNLOAD_TIMEOUT;
        for attempt in 0..HEADER_ATTEMPTS {
            cancellation.check()?;
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(NativeToolError::Network);
            }
            let (error, retry, server_delay) = match self
                .client
                .get(url.clone())
                .header(USER_AGENT, USER_AGENT_VALUE)
                .timeout(remaining)
                .send()
            {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let server_delay = match response.headers().get(RETRY_AFTER) {
                        None => None,
                        Some(value) => match value
                            .to_str()
                            .ok()
                            .and_then(|value| value.parse::<u64>().ok())
                        {
                            Some(seconds) => Some(seconds),
                            // Do not retry earlier than a provider's HTTP-date or unknown cooldown.
                            None => return Err(NativeToolError::HttpStatus(status)),
                        },
                    };
                    (
                        NativeToolError::HttpStatus(status),
                        matches!(status, 408 | 429 | 500 | 502 | 503 | 504),
                        server_delay,
                    )
                }
                Err(error) => (
                    NativeToolError::Network,
                    !error.is_redirect()
                        && (error.is_connect() || error.is_timeout() || error.is_request()),
                    None,
                ),
            };
            // Retry only before opening the destination: no overwrite, partial-file reuse,
            // alternate source, or integrity bypass. Long provider cooldowns remain explicit.
            if !retry
                || attempt + 1 == HEADER_ATTEMPTS
                || server_delay.is_some_and(|secs| secs > 30)
            {
                return Err(error);
            }
            let delay = Duration::from_secs(server_delay.unwrap_or(1 << attempt));
            if delay >= deadline.saturating_duration_since(std::time::Instant::now()) {
                return Err(error);
            }
            wait_before_retry(delay, cancellation)?;
        }
        unreachable!("every final attempt returns its response or error")
    }
}

fn wait_before_retry(duration: Duration, cancellation: &CancellationToken) -> Result<()> {
    let deadline = std::time::Instant::now() + duration;
    loop {
        cancellation.check()?;
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        std::thread::sleep(remaining.min(Duration::from_millis(100)));
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
        let mut response = self.response(&url, cancellation)?;
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
            Some("www.gyan.dev") => valid_gyan_release_path(url.path()),
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
        Some("www.gyan.dev") => valid_gyan_release_path(first.path()),
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
        ) | (Some("www.gyan.dev"), Some("www.gyan.dev"))
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
    let segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    match segments.as_slice() {
        [
            "yt-dlp",
            "yt-dlp" | "yt-dlp-nightly-builds",
            "releases",
            "download",
            version,
            asset,
        ] => {
            crate::catalog::valid_ytdlp_version(version)
                && matches!(*asset, "yt-dlp.exe" | "yt-dlp_linux" | "yt-dlp_macos")
        }
        ["denoland", "deno", "releases", "download", "v2.9.5", asset] => matches!(
            *asset,
            "deno-x86_64-pc-windows-msvc.zip"
                | "deno-x86_64-unknown-linux-gnu.zip"
                | "deno-aarch64-apple-darwin.zip"
                | "deno-x86_64-apple-darwin.zip"
        ),
        _ => false,
    }
}

fn valid_gyan_release_path(path: &str) -> bool {
    path == "/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip"
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

    fn request_statuses(statuses: &[u16], retry_after: &str) -> Result<Response> {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!(
            "http://{}/archive",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let statuses = statuses.to_vec();
        let retry_after = retry_after.to_owned();
        let server = std::thread::spawn(move || {
            for status in statuses {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => {
                            panic!("expected retry did not connect within five seconds: {error}")
                        }
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = [0_u8; 2048];
                assert!(stream.read(&mut bytes).unwrap() > 0);
                if status == 0 {
                    // Real disconnected socket before headers, as with a stale pooled connection.
                    drop(stream);
                    continue;
                }
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nRetry-After: {retry_after}\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        // Exercise real HTTP transport privately; public fetch still admits only reviewed HTTPS.
        let fetcher = HttpFileFetcher {
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        };
        let result = fetcher.response(&url, &CancellationToken::default());
        server.join().unwrap();
        result
    }

    #[test]
    fn retries_transient_headers_before_accepting_a_real_response() {
        let response = request_statuses(&[503, 429, 200], "0").unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            request_statuses(&[0, 200], "0").unwrap().status().as_u16(),
            200
        );
    }

    #[test]
    fn retries_are_bounded_and_permanent_or_long_cooldowns_are_not_bypassed() {
        assert!(matches!(
            request_statuses(&[503; 4], "0"),
            Err(NativeToolError::HttpStatus(503))
        ));
        assert!(matches!(
            request_statuses(&[403], "0"),
            Err(NativeToolError::HttpStatus(403))
        ));
        assert!(matches!(
            request_statuses(&[429], "31"),
            Err(NativeToolError::HttpStatus(429))
        ));
        assert!(matches!(
            request_statuses(&[503], "Fri, 18 Sep 2026 12:00:00 GMT"),
            Err(NativeToolError::HttpStatus(503))
        ));
    }

    #[test]
    fn cancellation_interrupts_the_retry_wait() {
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert_eq!(
            wait_before_retry(Duration::from_secs(30), &cancellation),
            Err(NativeToolError::Cancelled)
        );
    }

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
    fn exact_vendor_media_archive_is_accepted_without_widening_the_host() {
        let exact = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip";
        assert!(trusted_initial_url(&Url::parse(exact).unwrap(), exact));
        for invalid in [
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
            "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-full_build.zip",
        ] {
            assert!(!trusted_initial_url(&Url::parse(invalid).unwrap(), invalid));
        }
    }

    #[test]
    fn immutable_shaped_ytdlp_versions_accept_only_platform_assets() {
        for valid in [
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.10/yt-dlp.exe",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2027.01.02/yt-dlp_linux",
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.08.10.235959/yt-dlp.exe",
        ] {
            assert!(trusted_initial_url(&Url::parse(valid).unwrap(), valid));
        }
        for invalid in [
            "https://github.com/yt-dlp/yt-dlp/releases/download/latest/yt-dlp.exe",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.10/source.zip",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.10/../yt-dlp.exe",
        ] {
            assert!(!trusted_initial_url(&Url::parse(invalid).unwrap(), invalid));
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
