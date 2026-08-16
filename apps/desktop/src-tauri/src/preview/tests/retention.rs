//! Leases, retention bounds and eviction order.
//!
//! Split from the rendering tests because none of these needs a graphics adapter: what they assert
//! is about capabilities and budgets, and drawing a real frame to check an eviction order would
//! make the cheapest tests in the module the slowest.

use std::sync::atomic::Ordering;

use super::super::fixtures::{load, media_server, published_bytes};
use super::super::publish::{FrameLease, PublishedFrames};
use super::super::refusal::PreviewRefusal;
use super::super::{MAX_FRAME_BYTES, MAX_RETAINED_BYTES, MAX_RETAINED_FRAMES, PREVIEW_MIME_TYPE};
use super::binding;

#[test]
fn a_lease_releases_exactly_once_however_many_times_it_is_asked() {
    let server = media_server();
    let frames = PublishedFrames::with_limits(MAX_RETAINED_FRAMES, MAX_RETAINED_BYTES);
    let lease = FrameLease::publish(
        &server,
        PREVIEW_MIME_TYPE,
        published_bytes(),
        frames.releases(),
    )
    .expect("the frame publishes");
    let url = lease.frame_url().expect("a frame url");
    assert!(String::from_utf8_lossy(&load(&url)).starts_with("HTTP/1.1 200"));

    assert!(lease.release(), "the first release is the one that happens");
    assert!(!lease.release(), "the second release must be a no-op");
    assert!(!lease.release());
    drop(lease);
    assert_eq!(
        frames.releases().load(Ordering::Acquire),
        1,
        "the capability was released once, not zero times and not twice",
    );
    assert!(String::from_utf8_lossy(&load(&url)).starts_with("HTTP/1.1 404"));
}

#[test]
fn a_superseded_frame_releases_once_when_the_registry_evicts_it() {
    let server = media_server();
    let frames = PublishedFrames::with_limits(2, MAX_RETAINED_BYTES);
    let mut urls = Vec::new();
    for _ in 0..3 {
        let lease = FrameLease::publish(
            &server,
            PREVIEW_MIME_TYPE,
            published_bytes(),
            frames.releases(),
        )
        .expect("the frame publishes");
        urls.push(lease.frame_url().expect("a frame url"));
        frames
            .retain(binding(), 1, 64, lease, &|| true)
            .expect("the frame is retained");
    }

    assert_eq!(frames.stats(), (2, 128));
    assert_eq!(frames.release_count(), 1, "exactly the evicted frame");
    assert!(String::from_utf8_lossy(&load(&urls[0])).starts_with("HTTP/1.1 404"));
    for url in &urls[1..] {
        assert!(String::from_utf8_lossy(&load(url)).starts_with("HTTP/1.1 200"));
    }

    frames.retire_all();
    assert_eq!(frames.release_count(), 3);
    assert_eq!(frames.stats(), (0, 0));
}

// ---- Bounds and eviction order ----------------------------------------------------------------

#[test]
fn retention_is_bounded_by_count_and_by_bytes_and_evicts_oldest_first() {
    let server = media_server();

    let by_count = PublishedFrames::with_limits(3, MAX_RETAINED_BYTES);
    let mut order = Vec::new();
    for _ in 0..5 {
        let lease = FrameLease::publish(
            &server,
            PREVIEW_MIME_TYPE,
            published_bytes(),
            by_count.releases(),
        )
        .expect("the frame publishes");
        order.push(lease.sequence_id());
        by_count
            .retain(binding(), 1, 8, lease, &|| true)
            .expect("the frame is retained");
    }
    assert_eq!(by_count.stats(), (3, 24));
    assert_eq!(by_count.retained_ids(), order[2..].to_vec());

    // Three 32-byte frames do not fit a 64-byte budget, though three entries would fit ten.
    let by_bytes = PublishedFrames::with_limits(10, 64);
    let mut kept = Vec::new();
    for _ in 0..3 {
        let lease = FrameLease::publish(
            &server,
            PREVIEW_MIME_TYPE,
            published_bytes(),
            by_bytes.releases(),
        )
        .expect("the frame publishes");
        kept.push(lease.sequence_id());
        by_bytes
            .retain(binding(), 1, 32, lease, &|| true)
            .expect("the frame is retained");
    }
    assert_eq!(by_bytes.stats(), (2, 64));
    assert_eq!(by_bytes.retained_ids(), kept[1..].to_vec());

    // A frame past the whole budget is refused rather than admitted by emptying the store.
    let lease = FrameLease::publish(
        &server,
        PREVIEW_MIME_TYPE,
        published_bytes(),
        by_bytes.releases(),
    )
    .expect("the frame publishes");
    assert_eq!(
        by_bytes.retain(binding(), 1, 65, lease, &|| true).err(),
        Some(PreviewRefusal::FrameUnpublishable)
    );
    assert_eq!(by_bytes.stats(), (2, 64));
}

#[test]
fn one_frame_always_fits_the_retained_budget_and_the_transport() {
    const { assert!(MAX_FRAME_BYTES <= MAX_RETAINED_BYTES) };
    let server = media_server();
    let mut oversized = vec![0_u8; MAX_FRAME_BYTES + 1];
    oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let frames = PublishedFrames::with_limits(MAX_RETAINED_FRAMES, MAX_RETAINED_BYTES);
    assert_eq!(
        FrameLease::publish(&server, PREVIEW_MIME_TYPE, oversized, frames.releases()).err(),
        Some(PreviewRefusal::FrameUnpublishable)
    );
}
