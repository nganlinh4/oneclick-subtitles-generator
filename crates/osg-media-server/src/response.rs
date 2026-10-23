//! Validated response heads, CORS and media headers, and short text responses.

use std::io::{self, Write};
use std::net::TcpStream;

use crate::CloneableEntry;
use crate::request::is_token_byte;

pub(crate) type ResponseHeader<'a> = (&'a str, String);

pub(crate) fn common_media_headers<'a>(
    origin: Option<&'a str>,
    entity_tag: &str,
    entry: &CloneableEntry,
) -> Vec<ResponseHeader<'a>> {
    let mut headers = cors_headers(origin);
    headers.extend([
        ("Content-Type", entry.mime_type.clone()),
        ("Accept-Ranges", "bytes".to_owned()),
        ("Cache-Control", "private, no-store".to_owned()),
        ("ETag", format!("\"{entity_tag}-{:x}\"", entry.byte_length)),
        ("X-Content-Type-Options", "nosniff".to_owned()),
        ("Cross-Origin-Resource-Policy", "cross-origin".to_owned()),
    ]);
    headers
}

pub(crate) fn cors_headers(origin: Option<&str>) -> Vec<ResponseHeader<'_>> {
    let Some(origin) = origin else {
        return Vec::new();
    };
    vec![
        ("Access-Control-Allow-Origin", origin.to_owned()),
        ("Vary", "Origin".to_owned()),
        (
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range, ETag".to_owned(),
        ),
    ]
}

pub(crate) fn respond_text(
    stream: &mut TcpStream,
    head_only: bool,
    status: u16,
    reason: &str,
    body: &str,
    headers: &[ResponseHeader<'_>],
) -> io::Result<()> {
    let mut all_headers = headers.to_vec();
    all_headers.extend([
        ("Content-Type", "text/plain; charset=utf-8".to_owned()),
        ("Cache-Control", "no-store".to_owned()),
        ("X-Content-Type-Options", "nosniff".to_owned()),
    ]);
    let mut response = response_head(
        status,
        reason,
        u64::try_from(body.len()).expect("response body length fits u64"),
        &all_headers,
    )?;
    if !head_only {
        response.push_str(body);
    }
    stream.write_all(response.as_bytes())
}

pub(crate) fn respond_empty(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[ResponseHeader<'_>],
) -> io::Result<()> {
    write_response_head(stream, status, reason, 0, headers)
}

pub(crate) fn write_response_head(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_length: u64,
    headers: &[ResponseHeader<'_>],
) -> io::Result<()> {
    let head = response_head(status, reason, content_length, headers)?;
    stream.write_all(head.as_bytes())
}

/// Renders a validated response head so the caller can emit it as one socket write.
///
/// Emitting the head fragment by fragment costs one segment per header and lets a peer keep an
/// arbitrary truncated prefix when the connection dies mid-head.
pub(crate) fn response_head(
    status: u16,
    reason: &str,
    content_length: u64,
    headers: &[ResponseHeader<'_>],
) -> io::Result<String> {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    for (name, value) in headers {
        if !name.bytes().all(is_token_byte) || !valid_response_header_value(value) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid response header",
            ));
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("Content-Length: ");
    head.push_str(&content_length.to_string());
    head.push_str("\r\nConnection: close\r\n\r\n");
    Ok(head)
}

pub(crate) fn valid_response_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
}
