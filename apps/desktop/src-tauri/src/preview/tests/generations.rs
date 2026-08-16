//! Generations and staleness: which frame is still the one being asked for.
//!
//! Split from [`super`] at a real seam rather than for size. Everything here is about *ordering* —
//! an edit that lands while the GPU is busy, a claim that is overtaken between taking its generation
//! and retiring what that generation superseded — and none of it looks at a pixel.

use std::cell::RefCell;

use osg_domain::ProjectId;

use super::super::fixtures::{adapter, load, media_server};
use super::super::host::PreviewGround;
use super::super::refusal::PreviewRefusal;
use super::super::request::PreviewLayer;
use super::{binding, composition, host};

#[test]
fn a_frame_rendered_for_a_retired_binding_is_refused_and_released() {
    let _adapter = adapter();
    let host = host();
    let server = media_server();
    let composition = composition();
    let frame = host
        .compose(&composition, 0, PreviewGround::Transparent)
        .expect("frame zero composes");

    let current = binding();
    let ticket = host
        .claim(current.clone())
        .expect("a generation is claimed");
    // The editor moves on while the GPU is busy: a different scene revision is a different binding.
    let mut edited = current;
    edited.scene_revision = "revision-two".to_owned();
    let newer = host.claim(edited).expect("the newer binding claims");
    let shown = host
        .publish(&server, &newer, &frame, 0, PreviewLayer::default())
        .expect("the frame for the newer binding publishes");
    assert_eq!(host.frames().stats().0, 1);

    assert_eq!(
        host.publish(&server, &ticket, &frame, 0, PreviewLayer::default())
            .err(),
        Some(PreviewRefusal::StaleGeneration)
    );
    // Published, then released once, and never retained — and, just as important, the frame the
    // editor *is* showing was not evicted to make room for one nobody asked for.
    assert_eq!(host.frames().release_count(), 1);
    assert_eq!(host.frames().stats().0, 1);
    assert!(String::from_utf8_lossy(&load(&shown.frame_url)).starts_with("HTTP/1.1 200"));
}

/// The interleaving two renders in flight make reachable: a claim preempted between taking its
/// generation and retiring what that generation superseded.
///
/// Thread A claims, is preempted, and thread B claims, advances, composes and publishes a frame the
/// editor is now showing. A then resumes and runs its retire — with the *old* generation. It must
/// not be able to release B's live frame.
///
/// Driven through the injected preemption point rather than by two threads and a sleep: B's whole
/// claim, compose and publish run inside A's window, so the ordering under test is the ordering that
/// runs, on every machine, every time.
#[test]
fn a_claim_that_was_overtaken_cannot_retire_the_frame_that_overtook_it() {
    let _adapter = adapter();
    let host = host();
    let server = media_server();
    let composition = composition();
    let frame = host
        .compose(&composition, 0, PreviewGround::Transparent)
        .expect("frame zero composes");

    let first = binding();
    let mut second = first.clone();
    second.scene_revision = "revision-two".to_owned();
    let overtaking = RefCell::new(None);

    let overtaken = host
        .claim_interrupted(first, &|| {
            let newer = host
                .claim(second.clone())
                .expect("the overtaking binding claims");
            *overtaking.borrow_mut() = Some(
                host.publish(&server, &newer, &frame, 0, PreviewLayer::default())
                    .expect("the overtaking frame publishes"),
            );
        })
        .expect("the overtaken binding claims");

    let shown = overtaking.into_inner().expect("a published frame");
    assert!(
        !host.is_current(&overtaken),
        "the first claim really was overtaken, or this proves nothing",
    );
    assert_eq!(
        host.frames().stats().0,
        1,
        "the overtaken claim's retire released the frame that overtook it",
    );
    assert_eq!(host.frames().release_count(), 0);
    assert!(String::from_utf8_lossy(&load(&shown.frame_url)).starts_with("HTTP/1.1 200"));

    // And the retire still retires: the next claim to move the binding releases that same frame.
    let mut third = second;
    third.scene_revision = "revision-three".to_owned();
    host.claim(third).expect("the third binding claims");
    assert_eq!(host.frames().stats(), (0, 0));
    assert_eq!(host.frames().release_count(), 1);
    assert!(String::from_utf8_lossy(&load(&shown.frame_url)).starts_with("HTTP/1.1 404"));
}

#[test]
fn the_generation_advances_only_when_the_binding_moves() {
    let host = host();
    let scene = binding();
    let ticket = host.claim(scene.clone()).expect("a generation is claimed");
    let generation = host.generation();
    assert!(host.is_current(&ticket));

    // The same binding again is the same generation: a scrub must not retire its own cache.
    let again = host.claim(scene.clone()).expect("the same binding claims");
    assert_eq!(host.generation(), generation);
    assert!(host.is_current(&again) && host.is_current(&ticket));

    // An edit moves the revision, so the frames rendered before it stop being current.
    let mut edited = scene.clone();
    edited.scene_revision = "revision-two".to_owned();
    let after_edit = host.claim(edited).expect("the edited binding claims");
    assert_eq!(host.generation(), generation + 1);
    assert!(!host.is_current(&ticket));

    // A project switch does the same, and so does a device loss.
    let mut switched = scene;
    switched.project_id = ProjectId::new();
    host.claim(switched).expect("the switched project claims");
    assert!(!host.is_current(&after_edit));
    let latest = host.claim(binding()).expect("a fresh binding claims");
    host.invalidate();
    assert!(!host.is_current(&latest));
}
