use std::cmp;

use bytes::Bytes;
use reqwest::header::HeaderMap;
use serde::Deserialize;
use serde_json::json;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    Error, FileState, GeminiClient, Result, UploadRequest, UploadedFile,
    client::cancellable_sleep,
    error::io_error,
    retry::retry_delay,
    types::{normalize_media_mime, parse_provider_uri, validate_file_name},
};

const MAX_FILE_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_UPLOAD_GRANULARITY: usize = 16 * 1024 * 1024;

impl GeminiClient {
    /// Resumably uploads one bounded regular audio/video file. Only one chunk
    /// (at most 16 MiB) is resident at a time. Failed chunk submissions query
    /// the authoritative server offset before retrying, preventing blind byte
    /// duplication after an ambiguous transport failure.
    pub async fn upload_file(
        &self,
        request: UploadRequest,
        cancel: &CancellationToken,
    ) -> Result<UploadedFile> {
        let _permit = self.acquire(cancel).await?;
        let PreparedUpload {
            mut file,
            size,
            mime_type,
            display_name,
        } = prepare_upload(request, self.inner.options.max_upload_bytes).await?;
        let session = self
            .start_upload(size, &mime_type, &display_name, cancel)
            .await?;
        let chunk_size = select_chunk_size(
            self.inner.options.upload_chunk_bytes,
            session.chunk_granularity,
        )?;

        let mut offset = 0_u64;
        let mut retry_index = 0_u32;
        while offset < size {
            let remaining = size - offset;
            let chunk_len = usize::try_from(remaining.min(chunk_size as u64))
                .map_err(|_| Error::UploadProtocol("upload chunk length overflow".to_owned()))?;
            let chunk = read_upload_chunk(&mut file, offset, chunk_len).await?;
            let is_final = offset + u64::try_from(chunk_len).unwrap_or(u64::MAX) == size;
            let command = upload_command(is_final);

            let result = self
                .send_once(
                    "upload chunk",
                    self.inner.options.upload_request_timeout,
                    MAX_FILE_RESPONSE_BYTES,
                    cancel,
                    self.inner
                        .http
                        .post(session.url.clone())
                        .header("X-Goog-Upload-Offset", offset)
                        .header("X-Goog-Upload-Command", command)
                        .header(reqwest::header::CONTENT_LENGTH, chunk_len)
                        .body(chunk),
                )
                .await;

            match result {
                Ok(response) => {
                    if is_final {
                        let file = parse_upload_response(
                            &response.body,
                            self.inner.options.allow_loopback_http,
                        )?;
                        if file.size_bytes != size {
                            return Err(Error::UploadProtocol(
                                "provider file size does not match uploaded bytes".to_owned(),
                            ));
                        }
                        return Ok(file);
                    }
                    let reported = uploaded_offset(&response.headers)
                        .unwrap_or(offset + u64::try_from(chunk_len).unwrap_or(0));
                    validate_uploaded_offset(reported, offset, size)?;
                    if reported == offset {
                        return Err(Error::UploadProtocol(
                            "successful upload chunk made no progress".to_owned(),
                        ));
                    }
                    offset = reported;
                    retry_index = 0;
                }
                Err(error) if error.is_retryable() => {
                    let status = self.query_upload(&session.url, cancel).await?;
                    if status.finalized {
                        return Err(Error::UploadOutcomeUnknown);
                    }
                    validate_uploaded_offset(status.offset, offset, size)?;
                    if status.offset > offset {
                        offset = status.offset;
                        retry_index = 0;
                        continue;
                    }
                    if retry_index >= self.inner.options.retry.max_retries {
                        return Err(error);
                    }
                    let server_delay = match &error {
                        Error::Provider(provider) => provider.retry_after,
                        _ => None,
                    };
                    if server_delay.is_some_and(|delay| delay > self.inner.options.retry.max_delay)
                    {
                        return Err(error);
                    }
                    let delay = retry_delay(&self.inner.options.retry, retry_index, server_delay);
                    cancellable_sleep(delay, cancel).await?;
                    retry_index += 1;
                }
                Err(error) => return Err(error),
            }
        }

        Err(Error::UploadProtocol(
            "upload ended without a file resource".to_owned(),
        ))
    }

    /// Uploads a file and polls until the provider marks it `ACTIVE`.
    pub async fn upload_and_wait(
        &self,
        request: UploadRequest,
        cancel: &CancellationToken,
    ) -> Result<UploadedFile> {
        let file = self.upload_file(request, cancel).await?;
        self.wait_until_active(file, cancel).await
    }

    /// Polls a provider file using a bounded deadline and cancellation token.
    pub async fn wait_until_active(
        &self,
        mut file: UploadedFile,
        cancel: &CancellationToken,
    ) -> Result<UploadedFile> {
        let deadline = Instant::now() + self.inner.options.processing_timeout;
        loop {
            match file.state {
                FileState::Active => return Ok(file),
                FileState::Failed => {
                    return Err(Error::FileProcessingFailed {
                        message: file
                            .processing_error
                            .unwrap_or_else(|| "provider reported FAILED".to_owned()),
                    });
                }
                FileState::Processing | FileState::Unspecified => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::Timeout {
                    operation: "file processing",
                    timeout: self.inner.options.processing_timeout,
                });
            }
            cancellable_sleep(
                cmp::min(self.inner.options.poll_interval, remaining),
                cancel,
            )
            .await?;
            file = self.get_file(file.name(), cancel).await?;
        }
    }

    pub async fn get_file(&self, name: &str, cancel: &CancellationToken) -> Result<UploadedFile> {
        validate_file_name(name)?;
        let _permit = self.acquire(cancel).await?;
        let endpoint = self.endpoint(&format!("v1beta/{name}"))?;
        let response = self
            .send_with_retry(
                "get file",
                self.inner.options.request_timeout,
                MAX_FILE_RESPONSE_BYTES,
                None,
                cancel,
                || self.authenticated(self.inner.http.get(endpoint.clone())),
            )
            .await?;
        let wire: FileWire = serde_json::from_slice(&response.body)
            .map_err(|_| Error::Transport(crate::TransportKind::Decode))?;
        file_from_wire(wire, self.inner.options.allow_loopback_http)
    }

    pub async fn delete_file(&self, name: &str, cancel: &CancellationToken) -> Result<()> {
        validate_file_name(name)?;
        let _permit = self.acquire(cancel).await?;
        let endpoint = self.endpoint(&format!("v1beta/{name}"))?;
        self.send_with_retry(
            "delete file",
            self.inner.options.request_timeout,
            8 * 1024,
            None,
            cancel,
            || self.authenticated(self.inner.http.delete(endpoint.clone())),
        )
        .await?;
        Ok(())
    }

    async fn start_upload(
        &self,
        size: u64,
        mime_type: &str,
        display_name: &str,
        cancel: &CancellationToken,
    ) -> Result<UploadSession> {
        let endpoint = self.endpoint("upload/v1beta/files")?;
        let body = serde_json::to_vec(&json!({"file": {"display_name": display_name}}))
            .map_err(|_| Error::InvalidRequest("failed to encode upload metadata".to_owned()))?;
        let response = self
            .send_with_retry(
                "start upload",
                self.inner.options.upload_request_timeout,
                8 * 1024,
                None,
                cancel,
                || {
                    self.authenticated(self.inner.http.post(endpoint.clone()))
                        .header("X-Goog-Upload-Protocol", "resumable")
                        .header("X-Goog-Upload-Command", "start")
                        .header("X-Goog-Upload-Header-Content-Length", size)
                        .header("X-Goog-Upload-Header-Content-Type", mime_type)
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(body.clone())
                },
            )
            .await?;
        let raw_url = response
            .headers
            .get("x-goog-upload-url")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                Error::UploadProtocol("missing resumable upload URL header".to_owned())
            })?;
        let url = validate_upload_url(
            raw_url,
            &self.inner.options.api_base,
            self.inner.options.allow_loopback_http,
        )?;
        let chunk_granularity = response
            .headers
            .get("x-goog-upload-chunk-granularity")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok());
        Ok(UploadSession {
            url,
            chunk_granularity,
        })
    }

    async fn query_upload(
        &self,
        upload_url: &Url,
        cancel: &CancellationToken,
    ) -> Result<UploadStatus> {
        let response = self
            .send_with_retry(
                "query upload",
                self.inner.options.upload_request_timeout,
                8 * 1024,
                None,
                cancel,
                || {
                    self.inner
                        .http
                        .post(upload_url.clone())
                        .header("X-Goog-Upload-Command", "query")
                        .header(reqwest::header::CONTENT_LENGTH, 0)
                },
            )
            .await?;
        let status = response
            .headers
            .get("x-goog-upload-status")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("active");
        Ok(UploadStatus {
            offset: uploaded_offset(&response.headers).unwrap_or(0),
            finalized: !status.eq_ignore_ascii_case("active"),
        })
    }
}

struct UploadSession {
    url: Url,
    chunk_granularity: Option<usize>,
}

struct UploadStatus {
    offset: u64,
    finalized: bool,
}

struct PreparedUpload {
    file: File,
    size: u64,
    mime_type: String,
    display_name: String,
}

async fn prepare_upload(request: UploadRequest, max_upload_bytes: u64) -> Result<PreparedUpload> {
    let mime_type = normalize_media_mime(&request.mime_type)?;
    let symlink_metadata = tokio::fs::symlink_metadata(&request.path)
        .await
        .map_err(|error| io_error("inspect upload", &error))?;
    if symlink_metadata.file_type().is_symlink() {
        return Err(Error::InvalidRequest(
            "symbolic-link uploads are not accepted".to_owned(),
        ));
    }
    let file = File::open(&request.path)
        .await
        .map_err(|error| io_error("open upload", &error))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| io_error("inspect open upload", &error))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(Error::InvalidRequest(
            "upload must be a non-empty regular file".to_owned(),
        ));
    }
    if metadata.len() > max_upload_bytes {
        return Err(Error::UploadTooLarge {
            actual_bytes: metadata.len(),
            limit_bytes: max_upload_bytes,
        });
    }
    Ok(PreparedUpload {
        file,
        size: metadata.len(),
        mime_type,
        display_name: request
            .display_name
            .unwrap_or_else(|| "OSG media".to_owned()),
    })
}

async fn read_upload_chunk(file: &mut File, offset: u64, length: usize) -> Result<Bytes> {
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| io_error("seek upload", &error))?;
    let mut chunk = vec![0_u8; length];
    file.read_exact(&mut chunk)
        .await
        .map_err(|error| io_error("read upload", &error))?;
    Ok(Bytes::from(chunk))
}

const fn upload_command(is_final: bool) -> &'static str {
    if is_final {
        "upload, finalize"
    } else {
        "upload"
    }
}

#[derive(Deserialize)]
struct UploadEnvelope {
    file: FileWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWire {
    name: String,
    uri: String,
    mime_type: String,
    #[serde(default, deserialize_with = "deserialize_u64_string")]
    size_bytes: u64,
    state: Option<FileState>,
    expiration_time: Option<String>,
    error: Option<StatusWire>,
}

#[derive(Deserialize)]
struct StatusWire {
    message: Option<String>,
}

fn parse_upload_response(body: &[u8], allow_loopback_http: bool) -> Result<UploadedFile> {
    let envelope: UploadEnvelope = serde_json::from_slice(body)
        .map_err(|_| Error::UploadProtocol("invalid finalized upload response".to_owned()))?;
    file_from_wire(envelope.file, allow_loopback_http)
}

fn file_from_wire(wire: FileWire, allow_loopback_http: bool) -> Result<UploadedFile> {
    validate_file_name(&wire.name)?;
    let mime_type = normalize_media_mime(&wire.mime_type)?;
    let uri = parse_provider_uri(&wire.uri, allow_loopback_http)?;
    Ok(UploadedFile {
        name: wire.name,
        uri,
        mime_type,
        size_bytes: wire.size_bytes,
        state: wire.state.unwrap_or(FileState::Unspecified),
        expiration_time: wire.expiration_time,
        processing_error: wire.error.and_then(|error| error.message).map(|message| {
            message
                .chars()
                .filter(|character| !character.is_control())
                .take(2_048)
                .collect()
        }),
    })
}

fn deserialize_u64_string<'de, D>(deserializer: D) -> std::result::Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumberOrString {
        Number(u64),
        String(String),
    }
    match NumberOrString::deserialize(deserializer)? {
        NumberOrString::Number(value) => Ok(value),
        NumberOrString::String(value) => value.parse().map_err(serde::de::Error::custom),
    }
}

fn select_chunk_size(configured: usize, granularity: Option<usize>) -> Result<usize> {
    let Some(granularity) = granularity else {
        return Ok(configured);
    };
    if granularity == 0 || granularity > MAX_UPLOAD_GRANULARITY {
        return Err(Error::UploadProtocol(
            "invalid upload chunk granularity".to_owned(),
        ));
    }
    let selected = (configured / granularity) * granularity;
    Ok(if selected == 0 { granularity } else { selected })
}

fn uploaded_offset(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("x-goog-upload-size-received")?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

fn validate_uploaded_offset(reported: u64, previous: u64, total: u64) -> Result<()> {
    if reported < previous || reported > total {
        return Err(Error::UploadProtocol(
            "provider returned an impossible upload offset".to_owned(),
        ));
    }
    Ok(())
}

fn validate_upload_url(raw: &str, api_base: &Url, allow_loopback_http: bool) -> Result<Url> {
    let url = Url::parse(raw)
        .map_err(|_| Error::UploadProtocol("invalid resumable upload URL".to_owned()))?;
    if url.username() != "" || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::UploadProtocol(
            "unsafe resumable upload URL".to_owned(),
        ));
    }
    let same_origin = url.scheme() == api_base.scheme()
        && url.host_str() == api_base.host_str()
        && url.port_or_known_default() == api_base.port_or_known_default();
    let google_https = url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            host == "generativelanguage.googleapis.com" || host.ends_with(".googleapis.com")
        });
    if !(same_origin || google_https && !allow_loopback_http) {
        return Err(Error::UploadProtocol(
            "resumable upload URL origin is not trusted".to_owned(),
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_follow_server_granularity_without_exceeding_bound() {
        assert_eq!(
            select_chunk_size(8 * 1024 * 1024, Some(256 * 1024)).unwrap(),
            8 * 1024 * 1024
        );
        assert_eq!(
            select_chunk_size(300_000, Some(256 * 1024)).unwrap(),
            256 * 1024
        );
        assert!(select_chunk_size(1_000_000, Some(17 * 1024 * 1024)).is_err());
    }

    #[test]
    fn upload_url_rejects_cross_origin_plaintext() {
        let base = Url::parse("http://127.0.0.1:3030/").unwrap();
        assert!(validate_upload_url("http://127.0.0.1:3031/upload", &base, true).is_err());
        assert!(validate_upload_url("http://127.0.0.1:3030/upload", &base, true).is_ok());
    }
}
