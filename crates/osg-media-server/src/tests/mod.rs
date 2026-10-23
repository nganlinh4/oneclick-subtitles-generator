//! Loopback media-server tests, grouped by subject; shared request helpers live here.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use tempfile::TempDir;

use crate::{MediaServer, RegisteredMedia};

mod images;
mod protocol;
mod server;
mod streaming;

fn fixture() -> (TempDir, MediaServer, RegisteredMedia) {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("sample.mp4");
    fs::write(&path, b"0123456789").expect("media fixture");
    let server =
        MediaServer::start(["https://tauri.localhost".to_owned()]).expect("start media server");
    let media = server.register(&path).expect("register media");
    (directory, server, media)
}

pub(crate) fn request(port: u16, request: &str) -> Vec<u8> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect media server");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .expect("read timeout");
    stream.write_all(request.as_bytes()).expect("send request");
    let mut response = Vec::new();
    if let Err(error) = stream.read_to_end(&mut response) {
        assert!(
            error.kind() == std::io::ErrorKind::ConnectionReset && !response.is_empty(),
            "read response: {error}"
        );
    }
    response
}

fn url_parts(url: &str) -> (&str, &str) {
    let path_start = url.find("/asset/").expect("asset path");
    let path = &url[path_start..];
    path.split_once('?').expect("token query")
}

pub(crate) fn response_body(response: &[u8]) -> &[u8] {
    let offset = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("response headers")
        + 4;
    &response[offset..]
}
