//! Registration validation, registry capacity, shutdown, and overload backpressure.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use super::{request, response_body, url_parts};
use crate::{
    HEADER_READ_DEADLINE, MAX_REGISTERED_ASSETS, MediaServer, MediaServerError,
    REQUEST_QUEUE_CAPACITY, WORKER_COUNT,
};

#[test]
fn trusted_mime_registration_streams_extensionless_durable_media() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("o-content-addressed-artifact");
    fs::write(&path, b"0123456789").expect("durable media fixture");
    let server = MediaServer::start(["https://tauri.localhost".to_owned()]).expect("media server");
    let media = server
        .register_with_extension(&path, "mp4")
        .expect("register trusted media metadata");

    assert_eq!(media.mime_type, "video/mp4");
    assert!(!media.playback_url.contains("content-addressed"));
    let (asset_path, query) = url_parts(&media.playback_url);
    let response = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=3-6\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 206"));
    assert_eq!(response_body(&response), b"3456");
}

#[test]
fn trusted_mime_registration_rejects_non_media_and_header_injection() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("artifact");
    fs::write(&path, b"media").expect("fixture");
    let server = MediaServer::start(std::iter::empty()).expect("media server");

    for mime_type in [
        "application/octet-stream",
        "video/",
        "video/mp4\r\nX-Injected: yes",
        "video/mp4; charset=utf-8",
    ] {
        assert!(server.register_with_mime_type(&path, mime_type).is_err());
    }
    assert!(server.register_with_extension(&path, "../mp4").is_err());
    assert!(server.register_with_extension(&path, "unknownext").is_err());
}

#[test]
fn shutdown_interrupts_a_stalled_large_response() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("large.mp4");
    let file = File::create(&path).expect("large fixture");
    file.set_len(32 * 1024 * 1024).expect("size large fixture");
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let media = server.register(&path).expect("register media");
    let (path, query) = url_parts(&media.playback_url);
    let mut stream = TcpStream::connect(("127.0.0.1", server.port())).expect("connect");
    stream
        .write_all(
            format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            )
            .as_bytes(),
        )
        .expect("request large media");
    thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    drop(server);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "shutdown exceeded the bounded socket timeout"
    );
    drop(stream);
}

#[test]
fn incomplete_clients_are_bounded_and_excess_connections_get_backpressure() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let client_count = WORKER_COUNT + REQUEST_QUEUE_CAPACITY + 8;
    let mut clients = Vec::with_capacity(client_count);
    for index in 0..client_count {
        let stream = TcpStream::connect(("127.0.0.1", server.port())).expect("connect client");
        stream
            .set_nonblocking(true)
            .expect("nonblocking overload client");
        clients.push(stream);
        if index + 1 == WORKER_COUNT {
            thread::sleep(Duration::from_millis(50));
        }
    }

    let mut responses = vec![Vec::new(); client_count];
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut overloaded = false;
    while Instant::now() < deadline && !overloaded {
        for (stream, response) in clients.iter_mut().zip(&mut responses) {
            let mut buffer = [0_u8; 512];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => response.extend_from_slice(&buffer[..length]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::ConnectionReset
                        ) =>
                    {
                        break;
                    }
                    Err(error) => panic!("read overload response: {error}"),
                }
            }
            if response.starts_with(b"HTTP/1.1 503") {
                overloaded = true;
                break;
            }
        }
        if !overloaded {
            thread::sleep(Duration::from_millis(5));
        }
    }
    assert!(
        overloaded,
        "excess clients did not receive bounded backpressure"
    );
    drop(clients);
    drop(server);
}

#[test]
fn rejects_invalid_configured_origins_and_empty_files() {
    assert!(MediaServer::start(["https://valid.invalid\r\nInjected: yes".to_owned()]).is_err());
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("empty.mp4");
    fs::write(&path, []).expect("empty fixture");
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    assert!(server.register(&path).is_err());
    assert_eq!(HEADER_READ_DEADLINE, Duration::from_secs(5));
}

#[test]
fn registry_capacity_is_bounded_and_recoverable() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("sample.mp4");
    fs::write(&path, b"media").expect("media fixture");
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let mut first_id = None;
    for index in 0..MAX_REGISTERED_ASSETS {
        let media = server.register(&path).expect("register within capacity");
        if index == 0 {
            first_id = Some(media.id);
        }
    }
    assert!(matches!(
        server.register(&path),
        Err(MediaServerError::RegistryFull)
    ));
    assert!(
        server
            .unregister(first_id.expect("first media ID"))
            .expect("unregister media")
    );
    server
        .register(&path)
        .expect("capacity is released by unregister");
}
