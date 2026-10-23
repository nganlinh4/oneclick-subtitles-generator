//! Frame-sequence transport: indexing, tokens, eviction, expiry, and path privacy.

use std::fs;
use std::time::Duration;

use tempfile::TempDir;
use uuid::Uuid;

use super::{
    MAX_FRAME_BYTES, MAX_FRAME_SEQUENCES, MAX_SEQUENCE_FRAMES, MediaServer, MediaServerError,
    RegisteredFrameSequence,
};
use crate::tests::{request, response_body};

fn server() -> MediaServer {
    MediaServer::start(["https://tauri.localhost".to_owned()]).expect("start media server")
}

fn frame_bytes(index: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(format!("frame-{index}").as_bytes());
    bytes
}

fn sequence_of(server: &MediaServer, frames: usize) -> RegisteredFrameSequence {
    server
        .register_frame_sequence("image/png", (0..frames).map(frame_bytes).collect())
        .expect("register frame sequence")
}

/// Splits a frame URL into the request target and its credential query.
fn target_parts(url: &str) -> (String, String) {
    let start = url.find("/frame/").expect("frame path");
    let target = &url[start..];
    let (path, query) = target.split_once('?').expect("frame credentials");
    (path.to_owned(), query.to_owned())
}

fn fetch(server: &MediaServer, method: &str, target: &str) -> Vec<u8> {
    request(
        server.port(),
        &format!(
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    )
}

fn status_line(response: &[u8]) -> String {
    String::from_utf8_lossy(response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn frame_sequence_serves_indexed_images_over_the_element_transport() {
    let server = server();
    let sequence = sequence_of(&server, 3);
    assert_eq!(sequence.frame_count, 3);
    assert_eq!(sequence.mime_type, "image/png");
    assert_eq!(sequence.id.get_version_num(), 4);
    assert!(sequence.frame_url(3).is_none());

    for index in 0..3 {
        let url = sequence.frame_url(index).expect("frame url");
        let (path, query) = target_parts(&url);
        assert!(path.ends_with(&format!("/{index}")));
        let response = fetch(&server, "GET", &format!("{path}?{query}"));
        let text = String::from_utf8_lossy(&response);
        assert!(
            text.starts_with("HTTP/1.1 200"),
            "{}",
            status_line(&response)
        );
        assert!(text.contains("Content-Type: image/png"));
        assert!(text.contains("X-Content-Type-Options: nosniff"));
        assert!(text.contains("Cache-Control: private, no-store"));
        assert!(text.contains("Access-Control-Allow-Origin: https://tauri.localhost"));
        assert_eq!(response_body(&response), frame_bytes(index).as_slice());
    }
}

#[test]
fn head_frame_requests_return_headers_without_a_body() {
    let server = server();
    let sequence = sequence_of(&server, 2);
    let url = sequence.frame_url(1).expect("frame url");
    let (path, query) = target_parts(&url);
    let response = fetch(&server, "HEAD", &format!("{path}?{query}"));
    let text = String::from_utf8_lossy(&response);
    assert!(
        text.starts_with("HTTP/1.1 200"),
        "{}",
        status_line(&response)
    );
    assert!(text.contains(&format!("Content-Length: {}", frame_bytes(1).len())));
    assert!(response_body(&response).is_empty());
}

#[test]
fn frame_requests_reject_wrong_missing_and_ambiguous_registration_tokens() {
    let server = server();
    let sequence = sequence_of(&server, 1);
    let url = sequence.frame_url(0).expect("frame url");
    let (path, query) = target_parts(&url);
    let (server_token, registration_token) = query
        .split_once("&frame_token=")
        .expect("registration token");
    let forged = "0".repeat(registration_token.len());

    for credentials in [
        format!("{server_token}&frame_token={forged}"),
        server_token.to_owned(),
        format!("{server_token}&frame_token={registration_token}&frame_token={forged}"),
    ] {
        let response = fetch(&server, "GET", &format!("{path}?{credentials}"));
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"),
            "{}",
            status_line(&response)
        );
    }
}

#[test]
fn frame_requests_reject_unknown_capabilities() {
    let server = server();
    let sequence = sequence_of(&server, 1);
    let url = sequence.frame_url(0).expect("frame url");
    let (_, query) = target_parts(&url);
    for path in [
        format!("/frame/{}/0", Uuid::new_v4()),
        "/frame/not-a-capability/0".to_owned(),
        "/frame/0".to_owned(),
    ] {
        let response = fetch(&server, "GET", &format!("{path}?{query}"));
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/1.1 404"),
            "{path}: {}",
            status_line(&response)
        );
    }
}

#[test]
fn frame_requests_reject_out_of_range_and_non_canonical_indices() {
    let server = server();
    let sequence = sequence_of(&server, 2);
    let url = sequence.frame_url(0).expect("frame url");
    let (_, query) = target_parts(&url);
    for index in ["2", "9999", "00", "01", "-1", "1x", "0000000000"] {
        let response = fetch(
            &server,
            "GET",
            &format!("/frame/{}/{index}?{query}", sequence.id),
        );
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/1.1 404"),
            "index {index}: {}",
            status_line(&response)
        );
    }
}

#[test]
fn frame_sequences_expire_and_stop_resolving() {
    let server = server();
    let sequence = server
        .register_frame_sequence_with_lifetime(
            "image/png",
            vec![frame_bytes(0)],
            Duration::from_millis(1),
        )
        .expect("short-lived frame sequence");
    let url = sequence.frame_url(0).expect("frame url");
    let (path, query) = target_parts(&url);
    std::thread::sleep(Duration::from_millis(10));
    let response = fetch(&server, "GET", &format!("{path}?{query}"));
    assert!(
        String::from_utf8_lossy(&response).starts_with("HTTP/1.1 404"),
        "{}",
        status_line(&response)
    );
}

#[test]
fn frame_registry_evicts_least_recently_used_sequences_under_its_bound() {
    let server = server();
    let sequences: Vec<RegisteredFrameSequence> = (0..MAX_FRAME_SEQUENCES)
        .map(|_| sequence_of(&server, 1))
        .collect();
    let retained = sequences.last().expect("retained sequence").clone();
    let evicted = sequences.first().expect("evicted sequence").clone();

    let overflow = sequence_of(&server, 1);
    for (sequence, expected) in [
        (&evicted, "HTTP/1.1 404"),
        (&retained, "HTTP/1.1 200"),
        (&overflow, "HTTP/1.1 200"),
    ] {
        let url = sequence.frame_url(0).expect("frame url");
        let (path, query) = target_parts(&url);
        let response = fetch(&server, "GET", &format!("{path}?{query}"));
        assert!(
            String::from_utf8_lossy(&response).starts_with(expected),
            "{}",
            status_line(&response)
        );
    }
}

#[test]
fn frame_sequences_are_revocable_only_with_their_registration_token() {
    let server = server();
    let sequence = sequence_of(&server, 1);
    let url = sequence.frame_url(0).expect("frame url");
    let (path, query) = target_parts(&url);
    assert!(
        server
            .unregister_frame_sequence(sequence.id, &"0".repeat(64))
            .is_err()
    );
    let response = fetch(&server, "GET", &format!("{path}?{query}"));
    assert!(
        String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"),
        "{}",
        status_line(&response)
    );

    assert!(
        server
            .unregister_frame_sequence(sequence.id, sequence.registration_token())
            .expect("revoke frame sequence")
    );
    assert!(
        !server
            .unregister_frame_sequence(sequence.id, sequence.registration_token())
            .expect("revoking twice is idempotent")
    );
    let response = fetch(&server, "GET", &format!("{path}?{query}"));
    assert!(
        String::from_utf8_lossy(&response).starts_with("HTTP/1.1 404"),
        "{}",
        status_line(&response)
    );
}

#[test]
fn frame_registration_rejects_unbounded_and_mistyped_payloads() {
    let server = server();
    assert!(matches!(
        server.register_frame_sequence("image/png", Vec::new()),
        Err(MediaServerError::InvalidPath)
    ));
    assert!(matches!(
        server.register_frame_sequence(
            "image/png",
            (0..=MAX_SEQUENCE_FRAMES).map(frame_bytes).collect()
        ),
        Err(MediaServerError::InvalidPath)
    ));
    let mut oversized = vec![0_u8; MAX_FRAME_BYTES + 1];
    oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    assert!(matches!(
        server.register_frame_sequence("image/png", vec![oversized]),
        Err(MediaServerError::InvalidPath)
    ));
    for (mime_type, bytes) in [
        ("image/jpeg", frame_bytes(0)),
        ("image/svg+xml", b"<svg></svg>".to_vec()),
        ("image/png\r\nX-Injected: yes", frame_bytes(0)),
        ("image/png", Vec::new()),
    ] {
        assert!(matches!(
            server.register_frame_sequence(mime_type, vec![bytes]),
            Err(MediaServerError::InvalidPath)
        ));
    }
}

#[test]
fn frame_responses_and_errors_never_expose_a_filesystem_path_or_token() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("native-frame-source.png");
    fs::write(&path, frame_bytes(0)).expect("frame fixture");
    let rendered = fs::read(&path).expect("frame bytes");
    let needle = path.to_string_lossy().into_owned();

    let server = server();
    let sequence = server
        .register_frame_sequence("image/png", vec![rendered])
        .expect("register frame sequence");
    let url = sequence.frame_url(0).expect("frame url");
    let (frame_path, query) = target_parts(&url);
    let (server_token, _) = query
        .split_once("&frame_token=")
        .expect("registration token");

    assert!(!url.contains("native-frame-source"));
    let debug = format!("{sequence:?}");
    assert!(!debug.contains("native-frame-source"));
    assert!(!debug.contains(sequence.registration_token()));
    assert!(!debug.contains(&needle));

    let responses = [
        fetch(&server, "GET", &format!("{frame_path}?{query}")),
        fetch(&server, "GET", &format!("{frame_path}?{server_token}")),
        fetch(
            &server,
            "GET",
            &format!("/frame/{}/0?{query}", Uuid::new_v4()),
        ),
        fetch(&server, "GET", &format!("/frame/{}/7?{query}", sequence.id)),
    ];
    for response in &responses {
        let text = String::from_utf8_lossy(response);
        assert!(!text.contains(&needle));
        assert!(!text.contains("native-frame-source"));
        let headers = text.split("\r\n\r\n").next().unwrap_or_default();
        assert!(!headers.contains('\\'));
        assert!(!headers.contains(&needle));
    }

    let errors = [
        server
            .register_frame_sequence("image/png", Vec::new())
            .unwrap_err(),
        server
            .register_frame_sequence("text/html", vec![frame_bytes(0)])
            .unwrap_err(),
        server
            .unregister_frame_sequence(sequence.id, "0".repeat(64).as_str())
            .unwrap_err(),
    ];
    for error in &errors {
        let message = error.to_string();
        assert!(!message.contains(&needle));
        assert!(!message.contains("native-frame-source"));
        assert!(!message.contains('\\'));
        assert!(!message.contains('/'));
    }
}
