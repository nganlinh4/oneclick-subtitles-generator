//! Full and partial streaming, cursor isolation, and verified-handle snapshots.

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use tempfile::TempDir;

use super::{fixture, request, response_body, url_parts};
use crate::{MediaServer, MediaServerError};

#[test]
fn streams_full_and_partial_bodies_without_exposing_paths() {
    let (_directory, server, media) = fixture();
    let (path, query) = url_parts(&media.playback_url);
    let token = query.strip_prefix("token=").expect("capability token");
    assert_eq!(media.id.get_version_num(), 4);
    assert!(!media.playback_url.contains("sample.mp4"));
    assert!(!format!("{media:?}").contains("sample.mp4"));
    assert!(!format!("{media:?}").contains(token));
    assert!(!format!("{server:?}").contains(token));

    let full = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&full).starts_with("HTTP/1.1 200"));
    assert_eq!(response_body(&full), b"0123456789");

    let partial = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: localhost:{}\r\nRange: bytes=2-5\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let partial_text = String::from_utf8_lossy(&partial);
    assert!(partial_text.starts_with("HTTP/1.1 206"));
    assert!(partial_text.contains("Content-Range: bytes 2-5/10"));
    assert_eq!(response_body(&partial), b"2345");
}

#[test]
fn concurrent_ranges_do_not_share_file_cursor_state() {
    let (_directory, server, media) = fixture();
    let server = Arc::new(server);
    let barrier = Arc::new(Barrier::new(17));
    let (path, query) = url_parts(&media.playback_url);
    let path = path.to_owned();
    let query = query.to_owned();
    let mut threads = Vec::new();
    for index in 0_u8..16 {
        let server = Arc::clone(&server);
        let barrier = Arc::clone(&barrier);
        let path = path.clone();
        let query = query.clone();
        threads.push(thread::spawn(move || {
            barrier.wait();
            let digit = index % 10;
            let response = request(
                server.port(),
                &format!(
                    "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes={digit}-{digit}\r\nConnection: close\r\n\r\n",
                    server.port()
                ),
            );
            assert_eq!(response_body(&response), &[b'0' + digit]);
        }));
    }
    barrier.wait();
    for thread in threads {
        thread.join().expect("range request");
    }
}

#[test]
fn registered_handle_cannot_be_redirected_by_replacing_the_path() {
    let (directory, server, media) = fixture();
    let path = directory.path().join("sample.mp4");
    fs::write(&path, b"replacement with a different length").expect("replace fixture");
    let (asset_path, query) = url_parts(&media.playback_url);
    let response = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 409") || response_body(&response) == b"0123456789");
    assert!(!response.ends_with(b"replacement with a different length"));
}

#[test]
fn verified_handle_serves_original_bytes_after_path_replacement() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("selected.mp4");
    let moved_path = directory.path().join("selected-original.mp4");
    fs::write(&path, b"original!!").expect("original fixture");
    let verified = Arc::new(File::open(&path).expect("open verified handle"));
    let server = MediaServer::start(std::iter::empty()).expect("media server");
    let media = server
        .register_verified_file_with_extension(verified, "mp4", 10)
        .expect("register verified handle");
    fs::rename(&path, &moved_path).expect("move original pathname");
    fs::write(&path, b"hostile!!!").expect("replacement fixture");

    let (asset_path, query) = url_parts(&media.playback_url);
    let response = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
    assert_eq!(response_body(&response), b"original!!");
}

#[test]
fn verified_handle_rejects_same_length_in_place_mutation() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("selected.mp4");
    fs::write(&path, b"original!!").expect("original fixture");
    let verified = Arc::new(File::open(&path).expect("open verified handle"));
    let server = MediaServer::start(std::iter::empty()).expect("media server");
    let media = server
        .register_verified_file_with_extension(verified, "mp4", 10)
        .expect("register verified handle");
    thread::sleep(Duration::from_millis(20));
    fs::write(&path, b"mutated!!!").expect("mutate selected file");

    let (asset_path, query) = url_parts(&media.playback_url);
    let response = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 409"));
    assert_ne!(response_body(&response), b"mutated!!!");
}

#[test]
fn content_snapshot_serves_original_full_and_range_bytes_after_restored_mtime_mutation() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("selected.mp4");
    let original = b"0123456789abcdef";
    fs::write(&path, original).expect("original fixture");
    let modified = fs::metadata(&path)
        .expect("source metadata")
        .modified()
        .expect("source mtime");
    let verified = Arc::new(File::open(&path).expect("open verified handle"));
    let server = MediaServer::start(std::iter::empty()).expect("media server");
    let media = server
        .register_content_snapshot_with_extension(
            verified.as_ref(),
            "mp4",
            u64::try_from(original.len()).expect("fixture size"),
            *blake3::hash(original).as_bytes(),
        )
        .expect("register immutable snapshot");

    fs::write(&path, b"FEDCBA9876543210").expect("same-length in-place mutation");
    filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(modified))
        .expect("restore original mtime");
    let (asset_path, query) = url_parts(&media.playback_url);
    let full = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&full).starts_with("HTTP/1.1 200"));
    assert_eq!(response_body(&full), original);
    let range = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: localhost:{}\r\nRange: bytes=4-11\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&range).starts_with("HTTP/1.1 206"));
    assert_eq!(response_body(&range), &original[4..=11]);
}

#[test]
fn content_snapshot_rejects_wrong_hash_growth_and_shrinkage() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("selected.mp4");
    let bytes = b"snapshot identity";
    fs::write(&path, bytes).expect("fixture");
    let server = MediaServer::start(std::iter::empty()).expect("media server");
    assert!(matches!(
        server.register_content_snapshot_with_extension(
            Arc::new(File::open(&path).expect("wrong-hash handle")).as_ref(),
            "mp4",
            u64::try_from(bytes.len()).expect("fixture size"),
            [0x55; 32],
        ),
        Err(MediaServerError::InvalidPath)
    ));
    assert!(matches!(
        server.register_content_snapshot_with_extension(
            Arc::new(File::open(&path).expect("growth handle")).as_ref(),
            "mp4",
            u64::try_from(bytes.len() - 1).expect("short size"),
            *blake3::hash(&bytes[..bytes.len() - 1]).as_bytes(),
        ),
        Err(MediaServerError::InvalidPath)
    ));
    assert!(matches!(
        server.register_content_snapshot_with_extension(
            Arc::new(File::open(&path).expect("shrink handle")).as_ref(),
            "mp4",
            u64::try_from(bytes.len() + 1).expect("long size"),
            *blake3::hash(bytes).as_bytes(),
        ),
        Err(MediaServerError::InvalidPath)
    ));
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the concurrent writer verifies registration and subsequent full/range reads"
)]
fn racing_same_length_writer_can_only_cause_rejection_or_an_exact_snapshot() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("racing.mp4");
    let original = vec![0x31; 8 * 1024 * 1024];
    fs::write(&path, &original).expect("large fixture");
    let verified = Arc::new(File::open(&path).expect("verified handle"));
    let expected_hash = *blake3::hash(&original).as_bytes();
    let expected_length = u64::try_from(original.len()).expect("fixture size");
    let barrier = Arc::new(Barrier::new(2));
    let stop = Arc::new(AtomicBool::new(false));
    let write_count = Arc::new(AtomicUsize::new(0));
    let writer_path = path.clone();
    let writer_barrier = Arc::clone(&barrier);
    let writer_stop = Arc::clone(&stop);
    let writer_writes = Arc::clone(&write_count);
    let writer_thread = thread::spawn(move || {
        let mut file = OpenOptions::new()
            .write(true)
            .open(&writer_path)
            .expect("open racing writer");
        let offset = 3_u64 * 1024 * 1024;
        let hostile = vec![0x58; 256 * 1024];
        let restored = vec![0x31; hostile.len()];
        file.seek(SeekFrom::Start(offset))
            .expect("seek hostile block");
        file.write_all(&hostile).expect("write hostile block");
        file.flush().expect("flush hostile block");
        writer_writes.fetch_add(1, Ordering::SeqCst);
        writer_barrier.wait();
        while !writer_stop.load(Ordering::SeqCst) {
            file.seek(SeekFrom::Start(offset))
                .expect("seek restored block");
            file.write_all(&restored).expect("restore block");
            file.seek(SeekFrom::Start(offset))
                .expect("seek hostile block");
            file.write_all(&hostile).expect("rewrite hostile block");
            writer_writes.fetch_add(2, Ordering::SeqCst);
        }
        file.seek(SeekFrom::Start(offset))
            .expect("final restore seek");
        file.write_all(&restored).expect("final restore");
        file.flush().expect("final flush");
    });
    barrier.wait();
    let server = MediaServer::start(std::iter::empty()).expect("media server");
    let registration = server.register_content_snapshot_with_extension(
        verified.as_ref(),
        "mp4",
        expected_length,
        expected_hash,
    );
    stop.store(true, Ordering::SeqCst);
    writer_thread.join().expect("racing writer");
    assert!(write_count.load(Ordering::SeqCst) > 0);

    let Ok(media) = registration else {
        assert!(matches!(registration, Err(MediaServerError::InvalidPath)));
        return;
    };
    let (asset_path, query) = url_parts(&media.playback_url);
    let full = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert_eq!(response_body(&full), original);
    let range = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=3145728-3407871\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert_eq!(
        response_body(&range),
        &original[3 * 1024 * 1024..=3_407_871]
    );
}
