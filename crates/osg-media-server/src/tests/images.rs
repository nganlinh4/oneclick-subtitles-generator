//! Image capabilities: signatures, ownership claims, batching, eviction, and expiry.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use uuid::Uuid;

use super::{request, response_body, url_parts};
use crate::{MAX_IMAGE_BYTES, MAX_REGISTERED_IMAGES, MediaServer, MediaServerError};

#[test]
fn durable_image_registration_is_file_backed_signature_checked_and_path_private() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("private-content-addressed-image");
    let bytes = b"\x89PNG\r\n\x1a\nopaque image payload";
    fs::write(&path, bytes).expect("durable image fixture");
    let server = MediaServer::start(["https://tauri.localhost".to_owned()]).expect("media server");
    let image = server
        .register_image_file(&path, "image/png")
        .expect("register durable image");

    assert_eq!(image.mime_type, "image/png");
    assert_eq!(image.byte_length, bytes.len() as u64);
    assert!(!image.playback_url.contains("content-addressed"));
    assert!(!format!("{image:?}").contains(path.to_string_lossy().as_ref()));
    let (asset_path, query) = url_parts(&image.playback_url);
    let response = request(
        server.port(),
        &format!(
            "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
    assert_eq!(response_body(&response), bytes);

    assert!(server.register_image_file(&path, "image/jpeg").is_err());
    let malformed = directory.path().join("malformed-image");
    fs::write(&malformed, b"not an image").expect("malformed fixture");
    assert!(server.register_image_file(&malformed, "image/png").is_err());
    assert!(
        server
            .register_image_file(&path, "image/png\r\nX-Injected: yes")
            .is_err()
    );
}

#[test]
fn registered_images_use_the_same_tokenized_range_transport() {
    let server =
        MediaServer::start(["https://tauri.localhost".to_owned()]).expect("start media server");
    let image = server
        .register_image("image/png", b"\x89PNG\r\n\x1a\nprivate-image".to_vec())
        .expect("register image");
    assert_eq!(image.mime_type, "image/png");
    let (path, query) = url_parts(&image.playback_url);
    let response = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nRange: bytes=8-14\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    let headers = String::from_utf8_lossy(&response);
    assert!(headers.starts_with("HTTP/1.1 206"));
    assert!(headers.contains("Content-Type: image/png"));
    assert!(headers.contains("X-Content-Type-Options: nosniff"));
    assert_eq!(response_body(&response), b"private");
}

#[test]
fn native_image_copy_accepts_only_live_image_ids_and_revalidates_the_signature() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let bytes = b"\x89PNG\r\n\x1a\nprivate-image".to_vec();
    let image = server
        .register_image("image/png", bytes.clone())
        .expect("register image");
    let owner = Uuid::now_v7();

    let copied = server
        .copy_registered_image_for_owner(image.id, owner, 1024)
        .expect("copy registered image")
        .expect("live image");
    assert_eq!(copied.mime_type(), "image/png");
    assert_eq!(copied.bytes(), bytes);
    copied.commit().expect("commit owner");
    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner, 4)
            .is_err()
    );
    assert!(
        server
            .copy_registered_image_for_owner(Uuid::new_v4(), owner, 1024)
            .expect("unknown image")
            .is_none()
    );

    let malformed_id = Uuid::new_v4();
    server
        .inner
        .context
        .assets
        .write()
        .expect("image registry")
        .insert(
            malformed_id,
            crate::MediaEntry {
                source: crate::MediaSource::Image {
                    bytes: std::sync::Arc::from(b"not an image".as_slice()),
                    expires_at: Instant::now() + Duration::from_mins(1),
                    last_accessed: Instant::now(),
                },
                mime_type: "image/png".to_owned(),
                byte_length: 12,
                image_owner: None,
            },
        );
    assert!(
        server
            .copy_registered_image_for_owner(malformed_id, owner, 1024)
            .is_err()
    );
}

#[test]
fn native_image_copy_supports_signature_checked_file_capabilities_without_paths() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("private-image");
    let bytes = b"\x89PNG\r\n\x1a\nfile-backed-image";
    fs::write(&path, bytes).expect("image fixture");
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let image = server
        .register_image_file(&path, "image/png")
        .expect("register image file");
    let owner = Uuid::now_v7();

    let copied = server
        .copy_registered_image_for_owner(image.id, owner, 1024)
        .expect("copy image file")
        .expect("live image file");
    assert_eq!(copied.mime_type(), "image/png");
    assert_eq!(copied.bytes(), bytes);
    copied.commit().expect("commit owner");

    let media_path = directory.path().join("not-an-image.mp4");
    fs::write(&media_path, b"video").expect("media fixture");
    let media = server.register(&media_path).expect("register media");
    assert!(
        server
            .copy_registered_image_for_owner(media.id, owner, 1024)
            .is_err()
    );
}

#[test]
fn image_owner_claims_are_atomic_reusable_and_rollback_without_unbinding_a_winner() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let bytes = b"\x89PNG\r\n\x1a\nowned-image".to_vec();
    let image = server
        .register_image("image/png", bytes.clone())
        .expect("register image");
    let owner_a = Uuid::now_v7();
    let owner_b = Uuid::now_v7();

    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner_a, 4)
            .is_err()
    );
    assert!(
        server
            .inner
            .context
            .assets
            .read()
            .expect("registry")
            .get(&image.id)
            .expect("image")
            .image_owner
            .is_none()
    );

    let first = server
        .copy_registered_image_for_owner(image.id, owner_a, 1024)
        .expect("first claim")
        .expect("live image");
    let second = server
        .copy_registered_image_for_owner(image.id, owner_a, 1024)
        .expect("same-owner claim")
        .expect("live image");
    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner_b, 1024)
            .is_err()
    );
    drop(first);
    second.commit().expect("same-owner winner commits");
    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner_b, 1024)
            .is_err()
    );
    assert!(server.unregister(image.id).is_err());
    let reuse = server
        .copy_registered_image_for_owner(image.id, owner_a, 1024)
        .expect("same-project reuse")
        .expect("live image");
    assert_eq!(reuse.bytes(), bytes);
    assert!(server.unregister_owned_image(image.id, owner_b).is_err());
    assert!(
        server
            .unregister_owned_image(image.id, owner_a)
            .expect("exact owner schedules release")
    );
    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner_a, 1024)
            .is_err()
    );
    drop(reuse);
    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner_a, 1024)
            .expect("released lookup")
            .is_none()
    );
}

#[test]
fn exact_release_racing_a_pending_first_bind_removes_the_capability_once() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let image = server
        .register_image("image/png", b"\x89PNG\r\n\x1a\npending".to_vec())
        .expect("register image");
    let owner = Uuid::now_v7();
    let wrong_owner = Uuid::now_v7();
    let pending = server
        .copy_registered_image_for_owner(image.id, owner, 1024)
        .expect("pending first bind")
        .expect("live image");

    assert!(server.unregister(image.id).is_err());
    assert!(
        server
            .unregister_owned_image(image.id, wrong_owner)
            .is_err()
    );
    assert!(
        server
            .unregister_owned_image(image.id, owner)
            .expect("exact pending release")
    );
    assert!(
        server
            .copy_registered_image_for_owner(image.id, owner, 1024)
            .is_err()
    );
    drop(pending);
    assert!(
        !server
            .unregister_owned_image(image.id, owner)
            .expect("release is idempotent after removal")
    );
}

#[test]
fn committed_image_ownership_is_removed_with_lru_eviction() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let owner = Uuid::now_v7();
    let first = server
        .register_image("image/png", b"\x89PNG\r\n\x1a\noldest".to_vec())
        .expect("first image");
    server
        .copy_registered_image_for_owner(first.id, owner, 1024)
        .expect("claim")
        .expect("first image")
        .commit()
        .expect("commit");
    for index in 0..MAX_REGISTERED_IMAGES {
        let mut bytes = b"\x89PNG\r\n\x1a\nreplacement".to_vec();
        bytes.extend_from_slice(&index.to_le_bytes());
        server
            .register_image("image/png", bytes)
            .expect("replacement image");
    }
    assert!(
        server
            .copy_registered_image_for_owner(first.id, owner, 1024)
            .expect("evicted lookup")
            .is_none()
    );
}

#[test]
fn bounded_owned_file_registration_rejects_growth_on_the_same_open_handle_without_a_slot() {
    let directory = TempDir::new().expect("temporary directory");
    let path = directory.path().join("cover.png");
    let bytes = b"\x89PNG\r\n\x1a\nbounded";
    fs::write(&path, bytes).expect("image fixture");
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let owner = Uuid::now_v7();
    let before = server.inner.context.assets.read().expect("registry").len();
    let result = server.register_file_with_observer(
        &path,
        "image/png".to_owned(),
        true,
        Some(bytes.len()),
        Some(owner),
        |canonical_path| {
            OpenOptions::new()
                .append(true)
                .open(canonical_path)
                .expect("open growing fixture")
                .write_all(b"growth")
                .expect("grow fixture");
        },
    );
    assert!(matches!(result, Err(MediaServerError::InvalidPath)));
    assert_eq!(
        server.inner.context.assets.read().expect("registry").len(),
        before
    );
    assert!(
        server
            .register_owned_image_file(&path, "image/png", owner, bytes.len())
            .is_err()
    );
    let current_length =
        usize::try_from(fs::metadata(&path).expect("metadata").len()).expect("fixture length");
    let registered = server
        .register_owned_image_file(&path, "image/png", owner, current_length)
        .expect("bounded registration after rejected growth");
    assert!(
        server
            .unregister_owned_image(registered.id, owner)
            .expect("owned cleanup")
    );
}

#[test]
fn image_registration_rejects_mime_confusion_and_oversized_payloads() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    for (mime_type, bytes) in [
        ("image/svg+xml", b"<svg></svg>".to_vec()),
        ("image/jpeg", b"\x89PNG\r\n\x1a\nnot-jpeg".to_vec()),
        (
            "image/png; charset=binary",
            b"\x89PNG\r\n\x1a\nimage".to_vec(),
        ),
        ("text/html", b"<script>alert(1)</script>".to_vec()),
    ] {
        assert!(matches!(
            server.register_image(mime_type, bytes),
            Err(MediaServerError::InvalidPath)
        ));
    }
    let mut oversized = vec![0_u8; MAX_IMAGE_BYTES + 1];
    oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    assert!(matches!(
        server.register_image("image/png", oversized),
        Err(MediaServerError::InvalidPath)
    ));
}

#[test]
fn image_batch_registration_is_atomic_and_never_evicts_its_own_results() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let retained = server
        .register_images(
            (0..MAX_REGISTERED_IMAGES)
                .map(|index| {
                    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
                    bytes.extend_from_slice(index.to_string().as_bytes());
                    ("image/png".to_owned(), bytes)
                })
                .collect(),
        )
        .expect("atomic image batch");
    assert_eq!(retained.len(), MAX_REGISTERED_IMAGES);
    let assets = server.inner.context.assets.read().expect("image registry");
    assert!(retained.iter().all(|image| assets.contains_key(&image.id)));
    drop(assets);

    let oversized_batch = (0..=MAX_REGISTERED_IMAGES)
        .map(|index| {
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            bytes.extend_from_slice(index.to_string().as_bytes());
            ("image/png".to_owned(), bytes)
        })
        .collect();
    assert!(matches!(
        server.register_images(oversized_batch),
        Err(MediaServerError::InvalidPath)
    ));
    let assets = server.inner.context.assets.read().expect("image registry");
    assert!(retained.iter().all(|image| assets.contains_key(&image.id)));
}

#[test]
fn image_registry_evicts_lru_entries_and_expires_capabilities() {
    let server = MediaServer::start(std::iter::empty()).expect("start media server");
    let first = server
        .register_image("image/png", b"\x89PNG\r\n\x1a\nfirst".to_vec())
        .expect("first image");
    for index in 1..=MAX_REGISTERED_IMAGES {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(index.to_string().as_bytes());
        server
            .register_image("image/png", bytes)
            .expect("bounded image registration");
    }
    let (first_path, first_query) = url_parts(&first.playback_url);
    let evicted = request(
        server.port(),
        &format!(
            "GET {first_path}?{first_query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&evicted).starts_with("HTTP/1.1 404"));

    let expiring = server
        .register_image_with_lifetime(
            "image/png",
            b"\x89PNG\r\n\x1a\nshort-lived".to_vec(),
            Duration::from_millis(1),
        )
        .expect("short-lived image");
    thread::sleep(Duration::from_millis(10));
    let (path, query) = url_parts(&expiring.playback_url);
    let expired = request(
        server.port(),
        &format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port()
        ),
    );
    assert!(String::from_utf8_lossy(&expired).starts_with("HTTP/1.1 404"));
}
