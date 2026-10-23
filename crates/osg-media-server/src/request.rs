//! Bounded HTTP/1.x request-head reading and strict framing validation.

use std::io::{self, Read};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::{HEADER_READ_DEADLINE, MAX_HEADER_BYTES, MAX_HEADER_COUNT, READ_POLL_TIMEOUT};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RequestReadError {
    BadRequest,
    Timeout,
    TooLarge,
    Stopping,
    Disconnected,
}

pub(crate) struct HttpRequest {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) headers: Vec<(String, String)>,
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("target_path", &self.path())
            .field("header_count", &self.headers.len())
            .finish_non_exhaustive()
    }
}

impl HttpRequest {
    pub(crate) fn unique_header(&self, name: &str) -> Result<Option<&str>, ()> {
        let mut values = self
            .headers
            .iter()
            .filter(|(header_name, _)| header_name == name)
            .map(|(_, value)| value.as_str());
        let value = values.next();
        if values.next().is_some() {
            return Err(());
        }
        Ok(value)
    }

    pub(crate) fn is_head(&self) -> bool {
        self.method == "HEAD"
    }

    /// Returns the request target with its query string removed.
    pub(crate) fn path(&self) -> &str {
        self.target
            .split_once('?')
            .map_or(self.target.as_str(), |(path, _)| path)
    }
}

pub(crate) fn read_request(
    stream: &mut TcpStream,
    stopping: &AtomicBool,
) -> Result<HttpRequest, RequestReadError> {
    stream
        .set_read_timeout(Some(READ_POLL_TIMEOUT))
        .map_err(|_| RequestReadError::Disconnected)?;
    let deadline = Instant::now() + HEADER_READ_DEADLINE;
    let mut raw = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];

    let header_end = loop {
        if stopping.load(Ordering::Acquire) {
            return Err(RequestReadError::Stopping);
        }
        if let Some(position) = find_header_end(&raw) {
            break position;
        }
        if raw.len() >= MAX_HEADER_BYTES {
            return Err(RequestReadError::TooLarge);
        }
        let remaining = MAX_HEADER_BYTES - raw.len();
        let read_capacity = remaining.min(buffer.len());
        match stream.read(&mut buffer[..read_capacity]) {
            Ok(0) => return Err(RequestReadError::Disconnected),
            Ok(read) => raw.extend_from_slice(&buffer[..read]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(RequestReadError::Timeout);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(RequestReadError::Disconnected),
        }
    };

    parse_request_bytes(&raw[..header_end])
}

pub(crate) fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

pub(crate) fn parse_request_bytes(bytes: &[u8]) -> Result<HttpRequest, RequestReadError> {
    let text = std::str::from_utf8(bytes).map_err(|_| RequestReadError::BadRequest)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(RequestReadError::BadRequest)?;
    let mut request_parts = request_line.split(' ');
    let method = request_parts.next().ok_or(RequestReadError::BadRequest)?;
    let target = request_parts.next().ok_or(RequestReadError::BadRequest)?;
    let version = request_parts.next().ok_or(RequestReadError::BadRequest)?;
    if request_parts.next().is_some()
        || method.is_empty()
        || !method.bytes().all(is_token_byte)
        || !target.starts_with('/')
        || target.contains('#')
        || target.bytes().any(|byte| byte.is_ascii_control())
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
    {
        return Err(RequestReadError::BadRequest);
    }

    let mut headers = Vec::new();
    for line in lines {
        if headers.len() >= MAX_HEADER_COUNT || line.starts_with([' ', '\t']) || line.is_empty() {
            return Err(RequestReadError::BadRequest);
        }
        let (name, value) = line.split_once(':').ok_or(RequestReadError::BadRequest)?;
        if name.is_empty() || !name.bytes().all(is_token_byte) {
            return Err(RequestReadError::BadRequest);
        }
        let value = value.trim_matches([' ', '\t']);
        if value
            .bytes()
            .any(|byte| byte.is_ascii_control() && byte != b'\t')
        {
            return Err(RequestReadError::BadRequest);
        }
        headers.push((name.to_ascii_lowercase(), value.to_owned()));
    }

    let request = HttpRequest {
        method: method.to_owned(),
        target: target.to_owned(),
        headers,
    };
    validate_request_framing(&request)?;
    Ok(request)
}

pub(crate) fn validate_request_framing(request: &HttpRequest) -> Result<(), RequestReadError> {
    let host = request
        .unique_header("host")
        .map_err(|()| RequestReadError::BadRequest)?;
    let transfer_encoding = request
        .unique_header("transfer-encoding")
        .map_err(|()| RequestReadError::BadRequest)?;
    if host.is_none() || transfer_encoding.is_some() {
        return Err(RequestReadError::BadRequest);
    }
    let content_length = request
        .unique_header("content-length")
        .map_err(|()| RequestReadError::BadRequest)?;
    if content_length.is_some_and(|value| parse_decimal(value) != Some(0)) {
        return Err(RequestReadError::BadRequest);
    }
    Ok(())
}

pub(crate) fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

pub(crate) fn parse_decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}
