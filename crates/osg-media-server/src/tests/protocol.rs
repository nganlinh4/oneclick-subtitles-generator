//! Request parsing, range grammar, credentials, CORS, and header-size limits.

use uuid::Uuid;

use super::{fixture, request, response_body, url_parts};
use crate::MAX_HEADER_BYTES;
use crate::range::parse_range;
use crate::request::{RequestReadError, parse_request_bytes};

#[test]
fn range_parser_handles_edges_and_rejects_non_grammar_numbers() {
    assert_eq!(parse_range(Some("bytes=2-5"), 10), Ok(Some((2, 5))));
    assert_eq!(parse_range(Some("BYTES=-3"), 10), Ok(Some((7, 9))));
    assert_eq!(parse_range(Some("bytes=-99"), 10), Ok(Some((0, 9))));
    assert_eq!(parse_range(Some("bytes=8-99"), 10), Ok(Some((8, 9))));
    assert!(parse_range(Some("bytes=10-"), 10).is_err());
    assert!(parse_range(Some("bytes=1-2,4-5"), 10).is_err());
    assert!(parse_range(Some("items=1-2"), 10).is_err());
    assert!(parse_range(Some("bytes=+1-2"), 10).is_err());
    assert!(parse_range(Some("bytes=1-+2"), 10).is_err());
    assert!(parse_range(Some("bytes=1-2-3"), 10).is_err());
    assert!(parse_range(Some("bytes=-0"), 10).is_err());
    assert!(parse_range(Some("bytes=0-0"), 0).is_err());
}

#[test]
fn request_parser_rejects_smuggling_and_ambiguous_hosts() {
    let duplicate_host = b"GET / HTTP/1.1\r\nHost: a\r\nHost: b";
    assert_eq!(
        parse_request_bytes(duplicate_host).unwrap_err(),
        RequestReadError::BadRequest
    );
    let transfer_encoding = b"GET / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked";
    assert_eq!(
        parse_request_bytes(transfer_encoding).unwrap_err(),
        RequestReadError::BadRequest
    );
    let body = b"GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 1";
    assert_eq!(
        parse_request_bytes(body).unwrap_err(),
        RequestReadError::BadRequest
    );
    let folded = b"GET / HTTP/1.1\r\nHost: a\r\n continued";
    assert_eq!(
        parse_request_bytes(folded).unwrap_err(),
        RequestReadError::BadRequest
    );
}

#[test]
fn supports_head_and_returns_well_framed_range_errors() {
    let (_directory, server, media) = fixture();
    let (path, query) = url_parts(&media.playback_url);
    let head = request(
        server.port(),
        &format!(
            "HEAD {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let head_text = String::from_utf8_lossy(&head);
    assert!(head_text.starts_with("HTTP/1.1 200"));
    assert!(head_text.contains("Content-Length: 10"));
    assert!(response_body(&head).is_empty());

    let invalid = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=99-\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let invalid_text = String::from_utf8_lossy(&invalid);
    assert!(invalid_text.starts_with("HTTP/1.1 416"));
    assert!(invalid_text.contains("Content-Range: bytes */10"));
    assert!(invalid_text.contains("Content-Length: 0"));
    assert!(response_body(&invalid).is_empty());
}

#[test]
fn rejects_missing_tokens_hosts_origins_duplicates_and_unknown_assets() {
    let (_directory, server, media) = fixture();
    let (path, query) = url_parts(&media.playback_url);
    let missing_token = request(
        server.port(),
        &format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&missing_token).starts_with("HTTP/1.1 403"));

    let invalid_host = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: close\r\n\r\n"
        ),
    );
    assert!(String::from_utf8_lossy(&invalid_host).starts_with("HTTP/1.1 403"));

    let invalid_origin = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://attacker.invalid\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&invalid_origin).starts_with("HTTP/1.1 403"));

    let duplicate_origin = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nOrigin: https://tauri.localhost\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&duplicate_origin).starts_with("HTTP/1.1 400"));

    let unknown_path = path.replace(&media.id.to_string(), &Uuid::new_v4().to_string());
    let unknown = request(
        server.port(),
        &format!(
            "GET {unknown_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&unknown).starts_with("HTTP/1.1 404"));
}

#[test]
fn handles_cors_preflight_and_method_rejection() {
    let (_directory, server, media) = fixture();
    let (path, query) = url_parts(&media.playback_url);
    let preflight = request(
        server.port(),
        &format!(
            "OPTIONS {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nAccess-Control-Request-Private-Network: true\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let preflight = String::from_utf8_lossy(&preflight);
    assert!(preflight.starts_with("HTTP/1.1 204"));
    assert!(preflight.contains("Access-Control-Allow-Origin: https://tauri.localhost"));
    assert!(preflight.contains("Access-Control-Allow-Private-Network: true"));

    let post = request(
        server.port(),
        &format!(
            "POST {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let post = String::from_utf8_lossy(&post);
    assert!(post.starts_with("HTTP/1.1 405"));
    assert!(post.contains("Allow: GET, HEAD, OPTIONS"));
}

#[test]
fn supports_header_capabilities_and_rejects_ambiguous_credentials() {
    let (_directory, server, media) = fixture();
    let (path, query) = url_parts(&media.playback_url);
    let token = query.strip_prefix("token=").expect("capability token");
    let response = request(
        server.port(),
        &format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nX-OSG-Media-Token: {token}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let response_text = String::from_utf8_lossy(&response);
    assert!(response_text.starts_with("HTTP/1.1 200"));
    assert!(response_text.contains("Access-Control-Allow-Origin: https://tauri.localhost"));
    assert!(response_text.contains("Cross-Origin-Resource-Policy: cross-origin"));

    let duplicate = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-OSG-Media-Token: {token}\r\nX-OSG-Media-Token: {token}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&duplicate).starts_with("HTTP/1.1 400"));
}

#[test]
fn oversized_headers_are_rejected_without_growing_unbounded() {
    let (_directory, server, _media) = fixture();
    let oversized = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Fill: {}\r\n\r\n",
        server.port(),
        "a".repeat(MAX_HEADER_BYTES)
    );
    let response = request(server.port(), &oversized);
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 431"));
}
